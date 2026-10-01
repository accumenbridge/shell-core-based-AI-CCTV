import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_HOST_BYTES = 512 * 1024 * 1024;
const MAX_TEST_LOG_BYTES = 32 * 1024 * 1024;
const HOST_REPORT = 'ci-host-preflight.json';
const TEST_REPORT = 'ci-test-summary.json';

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function privateLocalDirectory() {
  const path = join(ROOT, '.local');
  if (!existsSync(path)) mkdirSync(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())
    throw new Error('unsafe local report directory');
  return path;
}

function createPrivateJson(name, value) {
  const directory = privateLocalDirectory();
  const destination = join(directory, name);
  const temporary = join(directory, `.ci-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
  finally { closeSync(descriptor); }
  try { linkSync(temporary, destination); }
  finally { unlinkSync(temporary); }
}

function minimalEnvironment() {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

function nodeIdentity() {
  const executable = realpathSync(process.execPath);
  const info = lstatSync(executable);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HOST_BYTES) throw new Error('invalid Node executable');
  const expectedVersion = `v${readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()}`;
  if (process.version !== expectedVersion) throw new Error('Node version does not match the repository pin');
  return { version: process.version, sha256: digest(readFileSync(executable)) };
}

function selectPowerShell() {
  const located = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true, maxBuffer: 4096 });
  if (located.error || located.status !== 0) throw new Error('PowerShell 7 was not found');
  const candidate = located.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!candidate || !isAbsolute(candidate)) throw new Error('PowerShell selection was ambiguous');
  const executable = realpathSync(candidate);
  const info = lstatSync(executable);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HOST_BYTES) throw new Error('PowerShell executable is not a bounded physical file');
  return { path: executable, sha256: digest(readFileSync(executable)) };
}

function observePowerShell(host) {
  const preflight = join(ROOT, 'tools', 'build-host-preflight.ps1');
  const script = lstatSync(preflight);
  if (!script.isFile() || script.isSymbolicLink() || realpathSync(preflight).toLowerCase() !== resolve(preflight).toLowerCase())
    throw new Error('unsafe ordinary preflight script');
  const result = spawnSync(host.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', preflight], {
    cwd: ROOT, env: minimalEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true
  });
  if (result.error || result.status !== 0) throw new Error('ordinary preflight did not complete');
  const records = result.stdout.split(/\r?\n/).filter(line => line.startsWith('QB_BUILD_HOST:'));
  if (records.length !== 1) throw new Error('ordinary preflight response was missing or ambiguous');
  const observed = JSON.parse(records[0].slice('QB_BUILD_HOST:'.length));
  const policy = {
    effective: observed.effectivePolicy,
    machine: observed.machinePolicy,
    user: observed.userPolicy,
    process: observed.processPolicy,
    currentUser: observed.currentUserPolicy,
    localMachine: observed.localMachinePolicy
  };
  if (!/^7\.\d+\.\d+$/.test(observed.version ?? '') || policy.effective !== 'RemoteSigned' ||
      policy.machine !== 'Undefined' || policy.user !== 'Undefined' || policy.process !== 'Undefined' ||
      policy.currentUser !== 'Undefined' || policy.localMachine !== 'RemoteSigned')
    return { version: typeof observed.version === 'string' ? observed.version : null, policy, supported: false };
  return { version: observed.version, policy, supported: true };
}

function prepareHost() {
  let host;
  let observed;
  let node;
  try {
    if (process.platform !== 'win32') throw new Error('native host preparation is Windows-only');
    node = nodeIdentity();
    host = selectPowerShell();
    observed = observePowerShell(host);
    if (!observed.supported) throw new Error('ordinary host policy is unsupported');
    const profile = {
      schema: 'quadbridge.local-build-host.v1',
      kind: 'powershell7-file-host',
      path: host.path,
      sha256: host.sha256,
      version: observed.version,
      policy: 'RemoteSigned'
    };
    createPrivateJson('platform-build-host.json', profile);
    const report = {
      schema: 'quadbridge.ci-host-preflight.v1',
      status: 'READY',
      node,
      powershell: { sha256: host.sha256, version: observed.version, policy: 'RemoteSigned' },
      policyScopes: observed.policy
    };
    createPrivateJson(HOST_REPORT, report);
    console.log(JSON.stringify(report));
    return 0;
  } catch {
    const report = {
      schema: 'quadbridge.ci-host-preflight.v1',
      status: 'BLOCKED_HOST_PROFILE',
      code: 'BLOCKED_HOST_PROFILE',
      node: node ?? { version: process.version },
      powershell: host ? { sha256: host.sha256, version: observed?.version ?? null } : null,
      policyScopes: observed?.policy ?? null
    };
    try { createPrivateJson(HOST_REPORT, report); } catch { /* the fixed stdout record still names the gate */ }
    console.log(JSON.stringify(report));
    return 1;
  }
}

function parseTap(text) {
  const counts = {};
  for (const match of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm))
    counts[match[1]] = Number(match[2]);
  if (!Number.isSafeInteger(counts.tests) || !Number.isSafeInteger(counts.pass) || !Number.isSafeInteger(counts.fail))
    return undefined;
  for (const key of ['cancelled', 'skipped', 'todo']) if (!Number.isSafeInteger(counts[key])) counts[key] = 0;
  const skippedTests = [];
  const failedTests = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*ok\s+\d+\s+-\s+(.+?)\s+#\s*SKIP(?:\s+.*)?$/.exec(line);
    if (match && skippedTests.length < 100) skippedTests.push(match[1].slice(0, 180));
    const failure = /^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/.exec(line);
    if (failure && failedTests.length < 40) failedTests.push(failure[1].slice(0, 180));
  }
  return { counts, skippedTests, failedTests };
}

function writeSelectedTap(temp, tap) {
  const destination = join(temp, 'kernel-test.tap');
  const temporary = join(temp, `.kernel-test-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx');
  try { writeFileSync(descriptor, tap, 'utf8'); }
  finally { closeSync(descriptor); }
  try { linkSync(temporary, destination); }
  finally { unlinkSync(temporary); }
  return digest(Buffer.from(tap, 'utf8'));
}

function summarizeTests(logPath, mode, exitText) {
  let report;
  let tapSha256;
  const commit = /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null;
  try {
    if (!['portable', 'windows-native'].includes(mode) || !/^\d+$/.test(exitText)) throw new Error('invalid summary mode');
    if (process.version !== `v${readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()}` ||
        (mode === 'portable' && process.platform !== 'linux') ||
        (mode === 'windows-native' && process.platform !== 'win32')) throw new Error('runner does not match its declared profile');
    const temp = realpathSync(process.env.RUNNER_TEMP || tmpdir());
    const actual = realpathSync(logPath);
    const relativePath = relative(temp, actual);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('test output is outside the runner temp directory');
    const info = lstatSync(actual);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TEST_LOG_BYTES) throw new Error('test output is not bounded');
    const bytes = readFileSync(actual);
    const log = bytes.toString('utf8');
    const tapStart = log.indexOf('TAP version 13');
    if (tapStart < 0) throw new Error('TAP output is unavailable');
    const tap = log.slice(tapStart);
    tapSha256 = writeSelectedTap(temp, tap);
    const parsed = parseTap(tap);
    if (!parsed) throw new Error('TAP summary is unavailable');
    const exitCode = Number(exitText);
    const passed = exitCode === 0 && parsed.counts.fail === 0 && parsed.counts.cancelled === 0;
    if (mode === 'windows-native') {
      const hostPath = join(privateLocalDirectory(), HOST_REPORT);
      const hostReport = JSON.parse(readFileSync(hostPath, 'utf8'));
      if (hostReport.status !== 'READY') throw new Error('the ordinary host preflight is not recorded as ready');
    }
    report = {
      schema: 'quadbridge.ci-test-summary.v1',
      mode,
      status: passed ? 'PASSED' : 'FAILED',
      commit,
      tapSha256,
      runner: { platform: process.platform, arch: arch(), nodeVersion: process.version },
      exitCode,
      counts: parsed.counts,
      skippedTests: parsed.skippedTests,
      failedTests: parsed.failedTests,
      windowsNativeCi: mode === 'portable' ? 'NOT_QUALIFIED' : 'PROFILE_CHECKED_SUITE_RUN'
    };
  } catch {
    report = {
      schema: 'quadbridge.ci-test-summary.v1',
      mode: mode === 'windows-native' ? 'windows-native' : 'portable',
      status: 'SUMMARY_UNAVAILABLE',
      commit,
      ...(tapSha256 ? { tapSha256 } : {}),
      runner: { platform: process.platform, arch: arch(), nodeVersion: process.version },
      windowsNativeCi: mode === 'portable' ? 'NOT_QUALIFIED' : 'PROFILE_CHECKED_SUITE_RUN'
    };
  }
  try { createPrivateJson(TEST_REPORT, report); }
  catch { console.log(JSON.stringify({ schema: report.schema, status: 'SUMMARY_WRITE_FAILED' })); return 1; }
  console.log(JSON.stringify(report));
  return report.status === 'PASSED' ? 0 : 1;
}

const [command, ...args] = process.argv.slice(2);
let exitCode;
if (command === 'prepare' && args.length === 0) exitCode = prepareHost();
else if (command === 'summarize' && args.length === 3) exitCode = summarizeTests(args[0], args[1], args[2]);
else {
  console.log(JSON.stringify({ schema: 'quadbridge.ci-build-host.v1', status: 'INVALID_INVOCATION' }));
  exitCode = 2;
}
process.exitCode = exitCode;
