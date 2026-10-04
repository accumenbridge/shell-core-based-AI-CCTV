import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  captureAuthoredBuildInputs,
  captureBuildOutputs,
  captureBuildToolchain
} from './veyviz-inventory.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const QUALIFICATION_ROOT = '.local/veyviz-build-qualification';
const SCHEMA = 'veyviz.build-qualification.v1';
const ATTEMPT_SCHEMA = 'veyviz.build-attempt.v1';
const MAX_PRIVATE_PATH = 235;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function physicalDirectory(path, { create = false, root } = {}) {
  const full = resolve(path);
  if (full.length >= MAX_PRIVATE_PATH) throw Error('Build qualification private path exceeds its short-path bound.');
  if (root) {
    const base = resolve(root), rel = relative(base, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== full)
      throw Error('Build qualification path escaped the product root.');
  }
  try {
    const info = lstatSync(full);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase())
      throw Error('Build qualification state contains a link or non-directory component.');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    const parent = resolve(full, '..');
    if (parent !== full) physicalDirectory(parent, { create: true, root });
    mkdirSync(full, { mode: 0o700 });
    physicalDirectory(full, { root });
  }
  return full;
}

function qualificationPaths(root) {
  const local = physicalDirectory(join(root, '.local'), { create: true, root });
  const base = physicalDirectory(join(local, 'veyviz-build-qualification'), { create: true, root: local });
  const attempts = physicalDirectory(join(base, 'attempts'), { create: true, root: base });
  const history = physicalDirectory(join(base, 'history'), { create: true, root: base });
  return { base, attempts, history, current: join(base, 'current.json') };
}

function retireCurrent(paths, attemptId) {
  try { lstatSync(paths.current); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const archived = join(paths.history, `current-${Date.now()}-${attemptId}.json`);
  if (archived.length >= MAX_PRIVATE_PATH) throw Error('Build qualification history path exceeds its short-path bound.');
  renameSync(paths.current, archived);
  return relative(ROOT, archived).split(sep).join('/');
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw Error('Unable to persist all builder output bytes.');
    offset += written;
  }
}

function createOutputCapture(path) {
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  let receivedBytes = 0, storedBytes = 0, captureError = null, finished = null;
  const append = chunk => {
    receivedBytes += chunk.length;
    const capacity = Math.max(0, MAX_OUTPUT_BYTES - storedBytes);
    const length = Math.min(capacity, chunk.length);
    if (length > 0 && !captureError) {
      try {
        writeAll(fd, chunk.subarray(0, length));
        storedBytes += length;
      } catch (error) { captureError = { name: error.name, code: error.code ?? null, message: error.message }; }
    }
  };
  const finish = () => {
    if (finished) return finished;
    try { fsyncSync(fd); } catch (error) { captureError ??= { name: error.name, code: error.code ?? null, message: error.message }; }
    try { closeSync(fd); } catch (error) { captureError ??= { name: error.name, code: error.code ?? null, message: error.message }; }
    const bytes = readFileSync(path);
    finished = {
      bytes: bytes.length,
      sha256: hash(bytes),
      receivedBytes,
      truncatedBytes: receivedBytes - bytes.length,
      captureError
    };
    return finished;
  };
  return { append, finish, get receivedBytes() { return receivedBytes; }, get captureError() { return captureError; } };
}

function recipeFiles(authoredInputs) {
  const required = ['tools/veyviz-build.mjs', 'tools/veyviz-inventory.mjs', 'tools/build.mjs'];
  const entries = new Map(authoredInputs.files.map(entry => [entry.path, entry]));
  return required.map(path => {
    const entry = entries.get(path);
    if (!entry) throw Error(`Fixed build recipe file is missing from authored inputs: ${path}`);
    return { path, bytes: entry.bytes, sha256: entry.sha256 };
  });
}

function closeIdentity(close, spawnError) {
  return {
    closeObserved: close !== null,
    code: close?.code ?? null,
    signal: close?.signal ?? null,
    spawnError
  };
}

function attemptRecord(attempt) {
  return Buffer.from(`${JSON.stringify(attempt, null, 2)}\n`);
}

function writeAttempt(directory, attempt, { replace = false } = {}) {
  const path = join(directory, 'attempt.json');
  const bytes = attemptRecord(attempt);
  if (bytes.length > MAX_RECEIPT_BYTES) throw Error('Build qualification attempt record exceeds its byte bound.');
  const temporary = replace ? `${path}.${randomUUID()}.tmp` : path;
  const fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (replace) {
    try { renameSync(temporary, path); }
    catch (error) { try { rmSync(temporary, { force: true }); } catch {} throw error; }
  }
  return {
    path: `${QUALIFICATION_ROOT}/attempts/${attempt.id}/attempt.json`,
    bytes: bytes.length,
    sha256: hash(bytes)
  };
}

function publishCurrent(path, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  if (bytes.length > MAX_RECEIPT_BYTES) throw Error('Build qualification receipt exceeds its serialized bound.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { lstatSync(path); throw Error('A current Veyviz build receipt appeared during publication.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(temporary, path);
  }
  catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

async function main() {
  if (process.argv.length !== 2) throw Error('The fixed Veyviz build wrapper accepts no arguments.');
  const rootInfo = lstatSync(ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(ROOT).toLowerCase() !== ROOT.toLowerCase())
    throw Error('Veyviz build root must be a physical directory.');
  const paths = qualificationPaths(ROOT);
  const id = randomUUID();
  const retiredReceipt = retireCurrent(paths, id);
  const attemptDirectory = physicalDirectory(join(paths.attempts, id), { create: true, root: paths.attempts });
  const stdoutPath = join(attemptDirectory, 'stdout.bin');
  const stderrPath = join(attemptDirectory, 'stderr.bin');
  const stdout = createOutputCapture(stdoutPath);
  const stderr = createOutputCapture(stderrPath);
  const startedAt = now();
  const builderPath = join(ROOT, 'tools', 'build.mjs');
  const command = { exe: resolve(process.execPath), argv: [builderPath], cwd: ROOT, shell: false, windowsHide: true };
  let close = null, spawnError = null, stage = 'pre-capture', qualificationError = null;
  let beforeAuthored = null, beforeToolchain = null, afterAuthored = null, afterToolchain = null, outputs = null;
  let captureError = null, attemptToPersist = null, published = false;
  try {
    beforeAuthored = await captureAuthoredBuildInputs(ROOT);
    recipeFiles(beforeAuthored);
    beforeToolchain = await captureBuildToolchain(ROOT);
    stage = 'builder';
    let child;
    try {
      child = spawn(process.execPath, [builderPath], {
        cwd: ROOT, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      spawnError = { name: error.name, code: error.code ?? null, message: error.message };
    }
    if (child) {
      child.stdout.on('data', chunk => stdout.append(chunk));
      child.stderr.on('data', chunk => stderr.append(chunk));
      child.stdout.on('error', error => { captureError ??= { stream: 'stdout', name: error.name, code: error.code ?? null, message: error.message }; });
      child.stderr.on('error', error => { captureError ??= { stream: 'stderr', name: error.name, code: error.code ?? null, message: error.message }; });
      child.on('error', error => { spawnError = { name: error.name, code: error.code ?? null, message: error.message }; });
      close = await new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
    }
    stage = 'builder-close';
    const capturedStdout = stdout.finish();
    const capturedStderr = stderr.finish();
    if (!close || spawnError || close.code !== 0 || close.signal !== null)
      throw Error(`The fixed core builder did not close with code 0 and null signal (code ${close?.code ?? 'unobserved'}, signal ${close?.signal ?? 'null'}).`);
    if (capturedStdout.truncatedBytes || capturedStderr.truncatedBytes || capturedStdout.captureError || capturedStderr.captureError || captureError)
      throw Error('The fixed core builder output could not be retained completely within its evidence bounds.');
    stage = 'post-capture';
    afterAuthored = await captureAuthoredBuildInputs(ROOT);
    afterToolchain = await captureBuildToolchain(ROOT);
    if (canonical(beforeAuthored) !== canonical(afterAuthored)) throw Error('Authored source changed during the fixed core build.');
    if (canonical(beforeToolchain) !== canonical(afterToolchain)) throw Error('Installed build toolchain changed during the fixed core build.');
    outputs = await captureBuildOutputs(ROOT);

    const original = closeIdentity(close, spawnError);
    const attempt = {
      schema: ATTEMPT_SCHEMA,
      id,
      startedAt,
      finishedAt: now(),
      stage: 'verified',
      command,
      original,
      stdout: { path: `${QUALIFICATION_ROOT}/attempts/${id}/stdout.bin`, ...capturedStdout },
      stderr: { path: `${QUALIFICATION_ROOT}/attempts/${id}/stderr.bin`, ...capturedStderr },
      captureError,
      qualificationError: null,
      retiredReceipt
    };
    attemptToPersist = attempt;
    const attemptRecordRef = writeAttempt(attemptDirectory, attempt);
    const stable = {
      schema: SCHEMA,
      authoredInputs: afterAuthored,
      recipeFiles: recipeFiles(afterAuthored),
      toolchain: afterToolchain,
      outputs,
      buildOutcome: { exitCode: 0, signal: null, spawnError: null }
    };
    const receipt = { schema: SCHEMA, stable, stableDigest: hash(canonical(stable)), attempt, attemptRecord: attemptRecordRef };
    stage = 'publish';
    publishCurrent(paths.current, receipt);
    published = true;
    console.log(JSON.stringify({ status: 'QUALIFIED', digest: receipt.stableDigest, attemptId: id, outputProducts: outputs.products.map(product => product.product) }));
    return;
  } catch (error) {
    if (published) {
      console.error(`Veyviz build qualification ${id} was published; output reporting failed: ${error.message}`);
      return;
    }
    qualificationError = { name: error.name, code: error.code ?? null, message: error.message };
    let capturedStdout, capturedStderr;
    try { capturedStdout = stdout.finish(); } catch (finishError) { captureError ??= { stream: 'stdout', name: finishError.name, code: finishError.code ?? null, message: finishError.message }; }
    try { capturedStderr = stderr.finish(); } catch (finishError) { captureError ??= { stream: 'stderr', name: finishError.name, code: finishError.code ?? null, message: finishError.message }; }
    const original = closeIdentity(close, spawnError);
    const attempt = attemptToPersist ?? {
      schema: ATTEMPT_SCHEMA,
      id,
      startedAt,
      finishedAt: now(),
      stage,
      command,
      original,
      stdout: { path: `${QUALIFICATION_ROOT}/attempts/${id}/stdout.bin`, ...(capturedStdout ?? await outputReference(ROOT, stdoutPath, id, 'stdout', stdout)) },
      stderr: { path: `${QUALIFICATION_ROOT}/attempts/${id}/stderr.bin`, ...(capturedStderr ?? await outputReference(ROOT, stderrPath, id, 'stderr', stderr)) },
      captureError,
      qualificationError,
      retiredReceipt
    };
    attempt.finishedAt = now();
    attempt.stage = stage;
    attempt.captureError = captureError;
    attempt.qualificationError = qualificationError;
    try { writeAttempt(attemptDirectory, attempt, { replace: Boolean(attemptToPersist) }); }
    catch (evidenceError) { console.error(`Failed to preserve Veyviz build attempt evidence: ${evidenceError.message}`); }
    console.error(`Veyviz build qualification failed at ${stage}; attempt ${id}; this attempt did not publish a current receipt. ${error.message}`);
    process.exitCode = 1;
  }
}

async function outputReference(root, path, id, stream, capture) {
  try {
    const bytes = readFileSync(path);
    const rel = relative(root, path).split(sep).join('/');
    return {
      path: rel,
      bytes: bytes.length,
      sha256: hash(bytes),
      receivedBytes: capture.receivedBytes,
      truncatedBytes: capture.receivedBytes - bytes.length,
      captureError: capture.captureError
    };
  } catch (error) {
    return {
      path: `${QUALIFICATION_ROOT}/attempts/${id}/${stream}.bin`,
      bytes: 0,
      sha256: hash(Buffer.alloc(0)),
      receivedBytes: capture.receivedBytes,
      truncatedBytes: capture.receivedBytes,
      captureError: { name: error.name, code: error.code ?? null, message: error.message }
    };
  }
}

main().catch(error => {
  console.error(`Veyviz build qualification could not start: ${error.message}`);
  process.exitCode = 1;
});
