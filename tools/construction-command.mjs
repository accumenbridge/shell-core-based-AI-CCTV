import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { closeSync, constants as fsConstants, openSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_PATH = fileURLToPath(import.meta.url);
const HELPER_SOURCE = join(ROOT, 'tools', 'build-job.ps1');
const CLOSE_TIMEOUT_MS = 12_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_NATIVE_TRANSCRIPT = 4096;
const MAX_CAPTURE = 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

const PRODUCT_RECIPES = Object.freeze({
  'construction-assets': ['asset-register', '1.0.0'],
  'construction-rooms': ['room-inspection', '2.1.0'],
  'construction-suite': ['asset-register,room-inspection', '1.0.0'],
  'construction-checklist': ['checklist', '1.2.0']
});

function fixedCommand(recipe, workspace) {
  if (typeof recipe !== 'string' || recipe.length > 64) throw new Error('Construction command recipe is invalid');
  if (recipe === 'a-npm-ci' || recipe === 'b-npm-ci') return { kind: 'npm', args: ['ci'] };
  if (['a-base-build', 'a-generated-build', 'b-build'].includes(recipe)) return { kind: 'npm', args: ['run', 'build'] };
  if (recipe === 'a-reconcile-lock') return { kind: 'npm', args: ['install', '--package-lock-only', '--ignore-scripts'] };
  if (recipe === 'a-generate-asset-register') return { kind: 'npm', args: ['run', 'factory', '--', 'generate-entity', '.local/construction-specs/asset-register.json'] };
  if (recipe === 'a-generate-room-inspection') return { kind: 'npm', args: ['run', 'factory', '--', 'generate-entity', '.local/construction-specs/room-inspection.json'] };
  if (recipe === 'a-create-checklist') return { kind: 'npm', args: ['run', 'factory', '--', 'create-module', 'checklist'] };
  if (recipe.startsWith('a-create-')) {
    const product = recipe.slice('a-create-'.length), selection = PRODUCT_RECIPES[product];
    if (selection) return { kind: 'npm', args: ['run', 'factory', '--', 'create-product', product, '--modules', selection[0], '--version', selection[1]] };
  }
  if (recipe === 'b-link-idempotence-1' || recipe === 'b-link-idempotence-2')
    return { kind: 'node', args: ['tools/link-workspaces.mjs'] };
  throw new Error('Construction command recipe is not in the fixed reviewed recipe set');
}

async function assertPhysicalDirectory(path, label) {
  const absolute = resolve(path), info = await lstat(absolute), physical = await realpath(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || physical !== absolute)
    throw new Error(`The owned ${label} is not a physical directory`);
  return absolute;
}

async function assertOwnedWorkspace(path) {
  const absolute = resolve(path), physical = await realpath(absolute), tempRoot = await realpath(tmpdir());
  const rel = relative(tempRoot, physical), components = rel.split(sep);
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || components.length !== 1 ||
      !['qb-construction-source-a-', 'qb-construction-source-b-'].some(prefix => basename(physical).startsWith(prefix)) ||
      fold(resolve(tempRoot, rel)) !== fold(physical))
    throw new Error('Construction command workspace failed its fixed temporary-root ownership check');
  return assertPhysicalDirectory(absolute, 'construction workspace');
}

async function copyExclusive(source, destination) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1 || sourceInfo.size > MAX_CAPTURE)
    throw new Error('A reviewed construction command input is not a bounded physical file');
  const before = await readFile(source);
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const destinationInfo = await lstat(destination), after = await readFile(destination);
  if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || before.length !== after.length || sha256(before) !== sha256(after))
    throw new Error('A staged construction command input changed while copying');
  return sha256(after);
}

function inside(parent, target) {
  const rel = relative(parent, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); })])
    .finally(() => clearTimeout(timer));
}

async function runRecipeChild() {
  const [marker, recipe, workspaceValue] = process.argv.slice(2);
  if (marker !== '--construction-job' || process.argv.length !== 5) throw new Error('INVALID_RECIPE_INVOCATION');
  const workspace = await assertOwnedWorkspace(workspaceValue);
  const command = fixedCommand(recipe, workspace);
  const outputRoot = await assertPhysicalDirectory(process.cwd(), 'construction command operation root');
  const stdoutPath = join(outputRoot, 'stdout.log'), stderrPath = join(outputRoot, 'stderr.log');
  const stdoutFd = openSync(stdoutPath, 'wx', 0o600);
  const stderrFd = openSync(stderrPath, 'wx', 0o600);
  let totalCaptured = 0, stdoutBytes = 0, stderrBytes = 0;
  const stdoutHash = createHash('sha256'), stderrHash = createHash('sha256');
  const consume = (stream, chunk) => {
    const bytes = Buffer.from(chunk);
    const isStdout = stream === 'stdout';
    if (isStdout) { stdoutBytes += bytes.length; stdoutHash.update(bytes); }
    else { stderrBytes += bytes.length; stderrHash.update(bytes); }
    const remaining = MAX_CAPTURE - totalCaptured;
    if (remaining > 0) {
      const part = bytes.subarray(0, remaining);
      writeSync(isStdout ? stdoutFd : stderrFd, part, 0, part.length);
      totalCaptured += part.length;
    }
  };
  const closeLogs = () => { closeSync(stdoutFd); closeSync(stderrFd); };
  let executable, args;
  if (command.kind === 'npm') {
    executable = process.execPath;
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const info = await lstat(npmCli), physical = await realpath(npmCli);
    if (!info.isFile() || info.isSymbolicLink() || physical !== npmCli) throw new Error('NPM_CLI_UNAVAILABLE');
    args = [npmCli, ...command.args];
  } else { executable = process.execPath; args = command.args; }

  let child;
  try { child = spawn(executable, args, { cwd: workspace, env: { ...process.env, NODE_ENV: 'development' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { closeLogs(); throw new Error('RECIPE_SPAWN_FAILED'); }
  child.stdout.on('data', chunk => consume('stdout', chunk));
  child.stderr.on('data', chunk => consume('stderr', chunk));
  child.once('error', () => { process.stderr.write('CONSTRUCTION_RECIPE_SPAWN_ERROR\n'); });
  const [code, signal] = await new Promise(resolveClose => child.once('close', (exitCode, closeSignal) => resolveClose([exitCode, closeSignal])));
  closeLogs();
  const outcome = { exitCode: code, signal: signal ?? null, stdoutBytes, stderrBytes, capturedBytes: totalCaptured,
    truncated: stdoutBytes + stderrBytes > totalCaptured, stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex') };
  writeFileSync(join(outputRoot, 'command-result.json'), `${JSON.stringify(outcome)}\n`, { flag: 'wx', mode: 0o600 });
  process.exitCode = code === 0 && !signal ? 0 : 1;
}

function isJobInvocation() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(SOURCE_PATH) && process.argv[2] === '--construction-job';
}

if (isJobInvocation()) {
  try { await runRecipeChild(); }
  catch (error) {
    const token = error?.message === 'INVALID_RECIPE_INVOCATION' ? 'INVALID_RECIPE_INVOCATION' : 'CONSTRUCTION_JOB_FAILED';
    process.stderr.write(`${token}\n`);
    process.exitCode = 127;
  }
}

export class ConstructionCommandOwner {
  #records = new Map();
  constructor({ projectRoot = ROOT, operationRootBase, nativeJob = runWindowsNativeJob, closeTimeoutMs = CLOSE_TIMEOUT_MS,
    startupTimeoutMs = STARTUP_TIMEOUT_MS } = {}) {
    this.projectRoot = resolve(projectRoot);
    this.operationRootBase = resolve(operationRootBase ?? join(this.projectRoot, '.local', 'construction-reliability-001', 'owned-commands'));
    this.nativeJob = nativeJob;
    this.closeTimeoutMs = closeTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
  }

  async run(recipe, workspacePath, { timeoutMs, label = recipe } = {}) {
    const command = fixedCommand(recipe, workspacePath);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new Error('Construction recipe execution deadline is invalid');
    const workspace = await assertOwnedWorkspace(workspacePath);
    const localRoot = await assertPhysicalDirectory(join(this.projectRoot, '.local'), 'construction private root');
    await mkdir(this.operationRootBase, { recursive: true, mode: 0o700 });
    const base = await assertPhysicalDirectory(this.operationRootBase, 'construction command owner root');
    if (!inside(localRoot, base)) throw new Error('Construction command owner root is outside the private local root');
    const ownerId = randomUUID(), operationRoot = join(base, ownerId);
    await mkdir(operationRoot, { mode: 0o700 });
    await assertPhysicalDirectory(operationRoot, 'construction command operation root');
    const record = { ownerId, recipe, label, workspace, operationRoot, physicalState: 'RUNNING', closeObserved: false,
      emptyObserved: false, cleaned: false, stopOwned: null, unrefOwned: null, closePromise: null, closeValue: null };
    this.#records.set(ownerId, record);
    const registerOwnedClosure = (promise, classify) => {
      if (record.closePromise) throw new Error('Construction owner already registered an original closure');
      record.closePromise = Promise.resolve(promise).then(value => {
        record.closeObserved = true;
        record.closeValue = value;
        const outcome = classify(value);
        record.emptyObserved = outcome.emptyObserved === true;
        record.physicalState = record.emptyObserved ? 'CLOSED' : 'UNKNOWN';
        record.closureOutcome = outcome;
        return value;
      });
      record.closePromise.catch(() => { record.physicalState = 'UNKNOWN'; });
      return record.closePromise;
    };
    const setOwnedStop = stop => { if (typeof stop !== 'function' || record.stopOwned) throw new Error('Construction original-owner control is invalid'); record.stopOwned = stop; };
    const setOwnedUnref = unref => { if (typeof unref !== 'function' || record.unrefOwned) throw new Error('Construction original-owner event-loop release is invalid'); record.unrefOwned = unref; };
    let result;
    try {
      result = await this.nativeJob({ projectRoot: this.projectRoot, operationRoot, workspace, recipe, command,
        timeoutMs, closeTimeoutMs: this.closeTimeoutMs, startupTimeoutMs: this.startupTimeoutMs,
        registerOwnedClosure, setOwnedStop, setOwnedUnref });
    } catch {
      result = { exitCode: null, signal: null, timedOut: false, closeObserved: record.closeObserved, emptyObserved: record.emptyObserved,
        physicalState: 'UNKNOWN', spawnErrorCode: 'CONSTRUCTION_OWNER_FAILED', elapsedMs: 0 };
    }
    if (result.closeObserved) record.closeObserved = true;
    if (result.emptyObserved) { record.emptyObserved = true; record.physicalState = 'CLOSED'; }
    else if (result.physicalState === 'UNKNOWN' || !result.closeObserved) record.physicalState = 'UNKNOWN';
    if (!result.closeObserved && !record.closeObserved) record.unrefOwned?.();
    Object.assign(record, { result });
    return { ...result, ownerId, recipe, commandKind: command.kind, commandArgs: command.args, label,
      operationRoot, physicalState: record.physicalState, closeObserved: record.closeObserved, emptyObserved: record.emptyObserved };
  }

  async requestStop(ownerId) {
    const record = this.#records.get(ownerId);
    if (!record) throw new Error('Construction command is not owned by this original owner');
    if (record.closeObserved || typeof record.stopOwned !== 'function') return false;
    await record.stopOwned();
    return true;
  }

  async waitForOriginalClose(ownerId, timeoutMs = this.closeTimeoutMs) {
    const record = this.#records.get(ownerId);
    if (!record) throw new Error('Construction command is not owned by this original owner');
    if (!record.closePromise) return { closeObserved: false, physicalState: 'UNKNOWN' };
    try { await bounded(record.closePromise, timeoutMs, 'CONSTRUCTION_CLOSE_TIMEOUT'); }
    catch { return { closeObserved: record.closeObserved, physicalState: record.physicalState }; }
    return { closeObserved: record.closeObserved, physicalState: record.physicalState, closeValue: record.closeValue };
  }

  async captureLogs(ownerId, destinationDirectory, label) {
    const record = this.#records.get(ownerId);
    if (!record) throw new Error('Construction command is not owned by this original owner');
    if (!record.closeObserved) throw new Error('Construction output cannot be captured before the original process owner closes');
    const targetRoot = await assertPhysicalDirectory(destinationDirectory, 'construction evidence log root');
    const captures = {};
    for (const stream of ['stdout', 'stderr']) {
      const source = join(record.operationRoot, `${stream}.log`);
      let info;
      try { info = await lstat(source); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CAPTURE) throw new Error('Construction output log exceeds its fixed capture bound');
      const bytes = await readFile(source), after = await lstat(source);
      if (bytes.length !== info.size || after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev)
        throw new Error('Construction output log changed while it was copied');
      const name = `${String(record.result?.stepNumber ?? '').padStart(2, '0')}${record.result?.stepNumber ? '-' : ''}${label}.${stream}.log`;
      const destination = join(targetRoot, name);
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      captures[stream] = { logName: name, byteCount: bytes.length, sha256: sha256(bytes) };
    }
    const metadataPath = join(record.operationRoot, 'command-result.json');
    try {
      const info = await lstat(metadataPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4096) throw new Error('Construction command output metadata exceeds its fixed bound');
      const bytes = await readFile(metadataPath), after = await lstat(metadataPath);
      if (bytes.length !== info.size || after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev)
        throw new Error('Construction command output metadata changed while it was read');
      const metadata = JSON.parse(bytes.toString('utf8'));
      if (!metadata || !Number.isSafeInteger(metadata.stdoutBytes) || !Number.isSafeInteger(metadata.stderrBytes) ||
          !Number.isSafeInteger(metadata.capturedBytes) || typeof metadata.truncated !== 'boolean' ||
          !/^[0-9a-f]{64}$/.test(metadata.stdoutSha256) || !/^[0-9a-f]{64}$/.test(metadata.stderrSha256))
        throw new Error('Construction command output metadata is invalid');
      captures.metadata = metadata;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return captures;
  }

  async cleanup(ownerId) {
    const record = this.#records.get(ownerId);
    if (!record) throw new Error('Construction command is not owned by this original owner');
    if (record.cleaned) return true;
    if (!record.closeObserved || !record.emptyObserved || record.physicalState !== 'CLOSED')
      throw new Error('Construction command cleanup requires original close and positive owned-tree closure proof');
    const base = await assertPhysicalDirectory(this.operationRootBase, 'construction command owner root');
    const target = resolve(record.operationRoot);
    if (!inside(base, target) || await realpath(target) !== target) throw new Error('Construction command cleanup target escaped its original owner root');
    await rm(target, { recursive: true, force: false, maxRetries: 0 });
    try { await lstat(target); throw new Error('Construction command cleanup was not observed'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    record.cleaned = true;
    return true;
  }

  async cleanupWorkspace(workspacePath) {
    const workspace = await assertOwnedWorkspace(workspacePath);
    const records = [...this.#records.values()].filter(record => record.workspace === workspace);
    if (!records.length || records.some(record => !record.closeObserved || !record.emptyObserved || record.physicalState !== 'CLOSED'))
      throw new Error('Construction workspace cleanup requires every original command owner to prove close and empty');
    const tempRoot = await realpath(tmpdir()), target = resolve(workspace);
    if (!inside(tempRoot, target) || await realpath(target) !== target) throw new Error('Construction workspace cleanup target escaped its original temporary owner');
    await rm(target, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
    try { await lstat(target); throw new Error('Owned construction workspace cleanup was not observed'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return true;
  }
}

async function runWindowsNativeJob(input) {
  const startedAt = Date.now();
  if (process.platform !== 'win32')
    return { started: false, readyObserved: false, closeObserved: false, exitCode: null, signal: null, markerCode: null,
      helperClosed: false, emptyObserved: false, timedOut: false, physicalState: 'UNKNOWN', spawnErrorCode: 'NATIVE_TREE_OWNER_UNAVAILABLE',
      elapsedMs: Date.now() - startedAt, runnerLogPath: join(input.operationRoot, 'runner.log') };

  const { captureManagedRuntimeNativeHost } = await import(new URL('../apps/control-plane/dist/runtime-manager.js', import.meta.url).href);
  const host = captureManagedRuntimeNativeHost(input.projectRoot);
  const helperPath = join(input.operationRoot, 'build-job.ps1'), scriptPath = join(input.operationRoot, 'construction-command.mjs');
  const runnerLogPath = join(input.operationRoot, 'runner.log');
  const helperDigest = await copyExclusive(HELPER_SOURCE, helperPath), scriptDigest = await copyExclusive(SOURCE_PATH, scriptPath);
  if (helperDigest !== host.buildJobDigest) throw new Error('The staged fixed construction helper does not match the selected native profile');
  const args = ['--construction-job', input.recipe, input.workspace];
  const argsJson = JSON.stringify(args);
  if (Buffer.byteLength(argsJson) > 8192) throw new Error('Fixed construction command arguments exceed their bound');
  const nonce = randomBytes(24).toString('hex');
  let child;
  try {
    child = spawn(host.hostPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath, '-RunnerNonce', nonce,
      '-NodeExe', host.nodePath, '-WorkingDirectory', input.operationRoot, '-ScriptPath', scriptPath, '-ArgumentsJson', argsJson,
      '-LogPath', runnerLogPath, '-RuntimeProtocol'], { cwd: input.operationRoot, env: process.env, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { started: false, readyObserved: false, closeObserved: false, exitCode: null, signal: null, markerCode: null,
      helperClosed: false, emptyObserved: false, timedOut: false, physicalState: 'UNKNOWN', spawnErrorCode: 'NATIVE_JOB_SPAWN_FAILED',
      elapsedMs: Date.now() - startedAt, runnerLogPath };
  }
  let resolveReady;
  const ready = new Promise(resolveReadyPromise => { resolveReady = resolveReadyPromise; });
  let stdout = '', stdoutBytes = 0, stderrBytes = 0, readyObserved = false, markerCode = null, markerUnknown = false, transcriptInvalid = false;
  let spawnErrorCode = null, controlFailed = false, timedOut = false, closeValue;
  const sent = new Set();
  const closeSource = new Promise(resolveClose => child.once('close', (code, signal) => { closeValue = { code, signal: signal ?? null }; resolveClose(closeValue); }));
  const closePromise = input.registerOwnedClosure(closeSource, () => {
    const helperClosed = closeValue?.code !== null && closeValue?.code !== undefined && closeValue.signal === null && spawnErrorCode === null;
    const emptyObserved = helperClosed && !transcriptInvalid && stdout.length === 0 && !markerUnknown && markerCode !== null && markerCode === closeValue.code;
    return { helperClosed, emptyObserved, markerCode, closeCode: closeValue?.code ?? null };
  });
  child.once('error', error => { spawnErrorCode = typeof error?.code === 'string' ? error.code : 'SPAWN_ERROR'; });
  child.stdout?.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_NATIVE_TRANSCRIPT) { transcriptInvalid = true; return; }
    stdout += chunk.toString('ascii');
    for (;;) {
      const at = stdout.indexOf('\n'); if (at < 0) break;
      let line = stdout.slice(0, at); stdout = stdout.slice(at + 1); if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === `QB_READY:${nonce}`) { if (readyObserved || markerCode !== null || markerUnknown) transcriptInvalid = true; else { readyObserved = true; resolveReady(); } continue; }
      const empty = new RegExp(`^QB_EXIT:${nonce}:(\\d+):EMPTY$`).exec(line);
      if (empty) { if (!readyObserved || markerCode !== null || markerUnknown) transcriptInvalid = true; else markerCode = Number(empty[1]); continue; }
      if (line === `QB_EXIT:${nonce}:UNKNOWN`) { if (!readyObserved || markerCode !== null || markerUnknown) transcriptInvalid = true; else markerUnknown = true; continue; }
      transcriptInvalid = true;
    }
  });
  child.stderr?.on('data', chunk => { stderrBytes += chunk.length; });
  child.stdin?.on('error', () => { controlFailed = true; });
  const send = verb => {
    const line = `${verb}:${nonce}`;
    if (sent.has(line) || closeValue || !child.stdin) { controlFailed = true; return false; }
    sent.add(line);
    try { child.stdin.write(`${line}\n`, 'ascii', error => { if (error) controlFailed = true; }); return true; }
    catch { controlFailed = true; return false; }
  };
  let stopStartedAt = null;
  const requestStop = () => { if (stopStartedAt === null) stopStartedAt = Date.now(); return send('STOP'); };
  const closeUntilDeadline = async () => {
    const deadline = (stopStartedAt ?? Date.now()) + input.closeTimeoutMs;
    const remaining = Math.max(0, deadline - Date.now());
    if (closeValue) return closeValue;
    if (remaining === 0) throw Object.assign(new Error('NATIVE_JOB_CLOSE_TIMEOUT'), { code: 'NATIVE_JOB_CLOSE_TIMEOUT' });
    return bounded(closePromise, remaining, 'NATIVE_JOB_CLOSE_TIMEOUT');
  };
  input.setOwnedStop(requestStop);
  input.setOwnedUnref(() => { child.unref?.(); child.stdin?.unref?.(); child.stdout?.unref?.(); child.stderr?.unref?.(); });
  let errorCode = null;
  try {
    await bounded(Promise.race([ready, closePromise.then(() => { throw new Error('NATIVE_JOB_EXITED_BEFORE_READY'); })]),
      Math.min(input.startupTimeoutMs, STARTUP_TIMEOUT_MS), 'NATIVE_JOB_READY_TIMEOUT');
    if (transcriptInvalid || spawnErrorCode) throw new Error('NATIVE_JOB_PROTOCOL_INVALID');
    if (!send('RESUME') || controlFailed) throw new Error('NATIVE_JOB_CONTROL_FAILED');
    try { await bounded(closePromise, input.timeoutMs, 'CONSTRUCTION_EXECUTION_TIMEOUT'); }
    catch (error) {
      if (error?.code !== 'CONSTRUCTION_EXECUTION_TIMEOUT') throw error;
      timedOut = true; errorCode = 'EXECUTION_DEADLINE_EXPIRED';
      requestStop();
      await closeUntilDeadline();
    }
  } catch (error) {
    if (!errorCode) errorCode = controlFailed ? 'NATIVE_JOB_CONTROL_FAILED' : !readyObserved ? 'NATIVE_JOB_READY_UNVERIFIED' : 'NATIVE_JOB_CLOSE_UNVERIFIED';
    if (!closeValue) {
      if (stopStartedAt === null) requestStop();
      try { await closeUntilDeadline(); }
      catch { errorCode = 'NATIVE_JOB_CLOSE_UNVERIFIED'; }
    }
  }
  if (stdout.length) transcriptInvalid = true;
  const helperClosed = !!closeValue && closeValue.code !== null && closeValue.signal === null && spawnErrorCode === null;
  const emptyObserved = helperClosed && !transcriptInvalid && !markerUnknown && markerCode !== null && markerCode === closeValue.code;
  if (controlFailed && !errorCode) errorCode = 'NATIVE_JOB_CONTROL_FAILED';
  if (!emptyObserved && !errorCode) errorCode = transcriptInvalid || markerUnknown ? 'NATIVE_JOB_PROTOCOL_INVALID' : 'NATIVE_JOB_PROOF_INVALID';
  return { started: true, readyObserved, closeObserved: !!closeValue, exitCode: closeValue?.code ?? null, signal: closeValue?.signal ?? null,
    markerCode, helperClosed, emptyObserved, timedOut, physicalState: emptyObserved ? 'CLOSED' : 'UNKNOWN', errorCode,
    spawnErrorCode, controlFailed, stderrBytes, elapsedMs: Date.now() - startedAt, operationRoot: input.operationRoot,
    runnerLogPath, stdoutLogPath: join(input.operationRoot, 'stdout.log'), stderrLogPath: join(input.operationRoot, 'stderr.log') };
}

export { fixedCommand, CLOSE_TIMEOUT_MS };
