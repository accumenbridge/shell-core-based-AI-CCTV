import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWindowsBuildHost } from '../apps/control-plane/dist/build-host.js';
import { LocalAccess } from '../packages/local-access/dist/index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELPER_SHA256 = '24364492a899af03afde4ef023d47e67744c2db0fa979208eaa0137214e68ea9';
const POWERSHELL_SHA256 = '362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139';
const NODE_SHA256 = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const HOST_VERSION = '7.6.5';
const NODE_VERSION = 'v24.19.0';
const HELPER_PATH = join(ROOT, 'tools', 'build-job.ps1');
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'runtime-protocol-heartbeat.mjs');
const CONSTRUCTOR_FAULT_PATH = join(ROOT, 'tests', 'fixtures', 'local-access-constructor-fault.mjs');
const PRIVATE_ENV_NAMES = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'];
const PROTOCOL_TIMEOUT_MS = 15000;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function privateRuntimeEnvironment() {
  const env = { NODE_ENV: 'development' };
  for (const name of PRIVATE_ENV_NAMES) if (process.env[name]) env[name] = process.env[name];
  return env;
}

let profilePromise;
function selectedProfile() {
  profilePromise ??= Promise.resolve().then(() => {
    const profile = assertWindowsBuildHost(ROOT, ROOT);
    assert.ok(profile, 'the selected Windows build host profile is available');
    assert.equal(profile.kind, 'powershell7-file-host');
    assert.equal(profile.sha256, POWERSHELL_SHA256);
    assert.equal(profile.version, HOST_VERSION);
    assert.equal(profile.policy, 'RemoteSigned');
    assert.equal(process.version, NODE_VERSION);
    assert.equal(digest(readFileSync(process.execPath)), NODE_SHA256);
    assert.equal(digest(readFileSync(HELPER_PATH)), HELPER_SHA256);
    return profile;
  });
  return profilePromise;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function bounded(promise, label, timeoutMs = PROTOCOL_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function safeRemoveOwnedTree(path) {
  const base = realpathSync(tmpdir());
  const actual = realpathSync(path);
  const child = relative(base, actual);
  assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'temporary tree resolves beneath the system temp directory');
  assert.ok(basename(actual).startsWith('qb-runtime-protocol-'), 'temporary tree has the test-owned prefix');
  const stat = lstatSync(actual);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary tree is a physical directory');
  await rm(actual, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
}

async function readHeartbeat(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (Number.isSafeInteger(value.pid) && Number.isSafeInteger(value.beat) && value.beat > 0) return value;
  } catch {}
  return undefined;
}

async function waitForFile(path, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(25);
  }
  assert.fail(`${label} did not appear within ${timeoutMs} ms`);
}

async function waitForHeartbeat(path, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readHeartbeat(path);
    if (value) return value;
    await delay(25);
  }
  assert.fail(`${label} did not start within ${timeoutMs} ms`);
}

async function waitForBeatAfter(path, previousBeat, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readHeartbeat(path);
    if (value && value.beat > previousBeat) return value;
    await delay(25);
  }
  assert.fail(`${label} did not advance from heartbeat ${previousBeat}`);
}

async function startRunner(t, { scriptPath = FIXTURE_PATH, argumentsForScript } = {}) {
  const profile = await selectedProfile();
  const root = await mkdtemp(join(tmpdir(), 'qb-runtime-protocol-'));
  const nonce = randomBytes(24).toString('base64url');
  const startedPath = join(root, 'started.json');
  const heartbeatPath = join(root, 'heartbeat.json');
  const logPath = join(root, 'private.log');
  const scriptArguments = argumentsForScript ? argumentsForScript({ root, startedPath, heartbeatPath }) : [startedPath, heartbeatPath];
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', HELPER_PATH,
    '-RunnerNonce', nonce,
    '-NodeExe', process.execPath,
    '-WorkingDirectory', root,
    '-ScriptPath', scriptPath,
    '-ArgumentsJson', JSON.stringify(scriptArguments),
    '-LogPath', logPath,
    '-RuntimeProtocol'
  ];
  const child = spawn(profile.path, args, {
    cwd: root,
    env: privateRuntimeEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdoutBuffer = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError;
  const lines = [];
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 4096) {
      outputError = new Error('Native helper protocol stdout exceeded 4096 bytes');
      return;
    }
    stdoutBuffer += chunk.toString('ascii');
    if (stdoutBuffer.length > 256 && !stdoutBuffer.includes('\n')) {
      outputError = new Error('Native helper protocol record exceeded its bounded line buffer');
      return;
    }
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      let line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
    }
  });
  child.stderr.on('data', chunk => { stderrBytes = Math.min(65536, stderrBytes + chunk.length); });

  let safeToRemove = false;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      try { await bounded(closed, 'owned native helper teardown', 5000); } catch {}
    }
    if (safeToRemove) await safeRemoveOwnedTree(root);
    else t.diagnostic(`Retained uncertain native protocol files at ${root}; no exact EMPTY/close proof was recorded.`);
  });

  return {
    child, closed, lines, nonce, root, startedPath, heartbeatPath, logPath,
    get outputError() { return outputError; },
    get stdoutBuffer() { return stdoutBuffer; },
    get stdoutBytes() { return stdoutBytes; },
    get stderrBytes() { return stderrBytes; },
    async waitForReady() {
      await waitForProtocolLine(this, `QB_READY:${nonce}`);
      assert.equal(outputError, undefined);
      assert.equal(stdoutBuffer, '');
      assert.equal(stderrBytes, 0, 'the fixed benign script and helper emit no stderr');
    },
    send(line) {
      assert.ok(child.stdin, 'helper stdin exists');
      child.stdin.write(line, 'ascii');
    },
    async sendFragmented(line) {
      for (const character of line) {
        child.stdin.write(character, 'ascii');
        await delay(10);
      }
    },
    async closeAndProve(expectedHeartbeat, { allowExecution = false, expectedExitCode = 124 } = {}) {
      const close = await bounded(closed, 'native helper close');
      assert.equal(outputError, undefined);
      assert.equal(stdoutBuffer, '', 'native helper closed on a record boundary');
      assert.equal(stderrBytes, 0, 'native helper completed without stderr');
      assert.equal(lines.length, 2, 'the helper emitted exactly one READY and one terminal record');
      assert.equal(lines[0], `QB_READY:${nonce}`);
      const match = new RegExp(`^QB_EXIT:${nonce}:(\\d+):EMPTY$`).exec(lines[1]);
      assert.ok(match, 'terminal record contains the exact nonce, numeric code and native EMPTY fact');
      const nativeExitCode = Number(match[1]);
      assert.equal(nativeExitCode, expectedExitCode, 'the nonce-bound EMPTY record carries the expected owned-child exit code');
      assert.equal(close.code, nativeExitCode, 'the original helper child closes with the protocol numeric code');
      assert.equal(close.signal, null, 'the original helper child reports a numeric exit, not a signal');
      if (expectedHeartbeat) {
        const before = await readHeartbeat(heartbeatPath);
        assert.ok(before, 'owned descendant heartbeat is present after helper close');
        assert.ok(before.beat >= expectedHeartbeat.beat, 'heartbeat reached the observed pre-stop value');
        await delay(250);
        const after = await readHeartbeat(heartbeatPath);
        assert.deepEqual(after, before, 'the owned descendant heartbeat ceased after native EMPTY and helper close');
      } else if (allowExecution) {
        const current = await readHeartbeat(heartbeatPath);
        if (current) {
          await delay(250);
          assert.deepEqual(await readHeartbeat(heartbeatPath), current, 'any coalesced-control descendant ceased after native EMPTY and helper close');
        }
      } else {
        await delay(100);
        assert.equal(existsSync(startedPath), false, 'gated supervisor script never executed');
        assert.equal(existsSync(heartbeatPath), false, 'owned descendant never started');
      }
      this.safeToRemove = true;
      return close;
    },
    get safeToRemove() { return safeToRemove; },
    set safeToRemove(value) { safeToRemove = value; }
  };
}

async function waitForProtocolLine(run, expected, timeoutMs = PROTOCOL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.outputError) throw run.outputError;
    if (run.lines.includes(expected)) return;
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      await run.closed;
      assert.fail(`Native helper closed before ${expected}`);
    }
    await delay(20);
  }
  assert.fail(`Native helper did not emit ${expected} within ${timeoutMs} ms`);
}

async function assertStillGated(run) {
  await delay(200);
  assert.equal(existsSync(run.startedPath), false, 'the supervisor script has not executed before RESUME');
  assert.equal(existsSync(run.heartbeatPath), false, 'the owned heartbeat descendant has not started before RESUME');
}

test('RuntimeProtocol reports assignment, accepts fragmented nonce-bound controls and proves STOP', {
  skip: process.platform !== 'win32'
}, async t => {
  const run = await startRunner(t);
  await run.waitForReady();
  await assertStillGated(run);

  await run.sendFragmented(`RESUME:${run.nonce}\n`);
  await waitForFile(run.startedPath, 'runtime script start');
  const first = await waitForHeartbeat(run.heartbeatPath, 'owned heartbeat descendant');
  const advanced = await waitForBeatAfter(run.heartbeatPath, first.beat, 'owned heartbeat descendant');
  run.send(`STOP:${run.nonce}\n`);
  await run.closeAndProve(advanced);
});

test('RuntimeProtocol wrong-nonce and malformed pre-RESUME controls fail closed without execution', {
  skip: process.platform !== 'win32'
}, async t => {
  for (const [name, control] of [
    ['wrong-nonce RESUME', nonce => `RESUME:${nonce}-wrong\n`],
    ['wrong-nonce STOP', nonce => `STOP:${nonce}-wrong\n`],
    ['malformed control', () => 'CONTINUE\n']
  ]) {
    await t.test(name, async st => {
      const run = await startRunner(st);
      await run.waitForReady();
      await assertStillGated(run);
      run.send(control(run.nonce));
      await run.closeAndProve(undefined);
    });
  }
});

test('RuntimeProtocol EOF before RESUME fails closed without executing the supervisor script', {
  skip: process.platform !== 'win32'
}, async t => {
  const run = await startRunner(t);
  await run.waitForReady();
  await assertStillGated(run);
  run.child.stdin.end();
  await run.closeAndProve(undefined);
});

test('RuntimeProtocol duplicate RESUME after the owned descendant starts terminates the whole job', {
  skip: process.platform !== 'win32'
}, async t => {
  const run = await startRunner(t);
  await run.waitForReady();
  await run.sendFragmented(`RESUME:${run.nonce}\n`);
  await waitForFile(run.startedPath, 'runtime script start');
  const first = await waitForHeartbeat(run.heartbeatPath, 'owned heartbeat descendant');
  const advanced = await waitForBeatAfter(run.heartbeatPath, first.beat, 'owned heartbeat descendant');
  run.send(`RESUME:${run.nonce}\n`);
  await run.closeAndProve(advanced);
});

test('RuntimeProtocol parses coalesced nonce-bound RESUME and STOP controls', {
  skip: process.platform !== 'win32'
}, async t => {
  const run = await startRunner(t);
  await run.waitForReady();
  await assertStillGated(run);
  run.send(`RESUME:${run.nonce}\nSTOP:${run.nonce}\n`);
  await run.closeAndProve(undefined, { allowExecution: true });
});

test('RuntimeProtocol owns canonical local-access constructor failure through nonce-bound EMPTY and helper close', {
  skip: process.platform !== 'win32'
}, async t => {
  const run = await startRunner(t, {
    scriptPath: CONSTRUCTOR_FAULT_PATH,
    argumentsForScript: ({ root }) => [join(root, 'access.sqlite')]
  });
  const databasePath = join(run.root, 'access.sqlite');
  const instanceId = `runtime-${randomUUID()}`;
  const initial = new LocalAccess(databasePath, { productId: 'service-desk', instanceId });
  initial.close();
  const setup = new DatabaseSync(databasePath);
  try {
    setup.exec("DELETE FROM instance_binding; CREATE TRIGGER fail_binding BEFORE INSERT ON instance_binding BEGIN SELECT RAISE(ABORT,'fixture binding failure'); END;");
  } finally {
    setup.close();
  }

  await run.waitForReady();
  await assertStillGated(run);
  const before = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(before.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 0,
      'native assignment alone did not construct or bind the canonical access owner');
    assert.equal(before.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 0);
  } finally {
    before.close();
  }

  run.send(`RESUME:${run.nonce}\n`);
  const close = await run.closeAndProve(undefined, { allowExecution: true, expectedExitCode: 0 });
  assert.deepEqual(close, { code: 0, signal: null }, 'the fixed child reports its natural numeric exit after the owned job empties');
  const privateLog = await readFile(run.logPath, 'utf8');
  assert.equal(privateLog.trim(), 'CONSTRUCTOR_FAILED', 'the actual canonical constructor caught the binding-trigger fault inside the owned job');

  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 0,
      'the failed canonical transaction did not publish an instance binding');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 0);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM grants').get().count, 0);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='fail_binding'").get().count, 1,
      'the rollback preserves the test-owned fault trigger for read-only verification');
  } finally {
    reopened.close();
  }
});
