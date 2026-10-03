import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical } from '@quadbridge/contracts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.local');
const PROFILE_PATH = join(LOCAL, 'platform-local-session.json');
const PROFILE_SCHEMA = 'quadbridge.local-session-profile.v1';
const MODEL_PROFILE = 'local-ollama-qwen3-4b';
const NATIVE_PROFILE = 'local-native-forwarded-v1';
const MODEL_NAME = 'qwen3:4b';
const MODEL_HOST = '127.0.0.1';
const MODEL_PORT = 21434;
const MODEL_STARTUP_TIMEOUT_MS = 120_000;
const MODEL_READINESS_INPUT = Object.freeze({
  question: 'Confirm the readiness fact using the supplied evidence.',
  evidence: Object.freeze([Object.freeze({ id: 'e0', text: 'Readiness sentinel: the selected local model is available.' })])
});
const SESSION_LOCK = join(LOCAL, 'platform-local-session-owner.json');
const OWNER_BASE = join(LOCAL, 'platform-local-session');
const CLIENT_BASE = join(LOCAL, 'managed-mobile');
const ANDROID_BUILD_BASE = join(LOCAL, 'managed-mobile-builds');
const JOB_BASE = join(LOCAL, 'platform-local-session-jobs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digestText = value => hash(Buffer.from(value));
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function hasCanonicalGenerationId(value, instanceId) {
  const prefix = `generation:${instanceId}:`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const generation = value.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(generation) && Number.isSafeInteger(Number(generation)) && String(Number(generation)) === generation;
}
const exactKeys = (value, keys) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'));
const localEnv = () => {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  return env;
};
function fail(message, code = 'LOCAL_SESSION_UNAVAILABLE') { const error = new Error(message); error.code = code; throw error; }
function physicalFile(path, maximum = 64 * 1024 * 1024) {
  const full = resolve(path), info = lstatSync(full);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase() || info.size > maximum)
    fail('A fixed local-session input is not a bounded physical file.', 'LOCAL_SESSION_PROFILE_INVALID');
  return full;
}
function physicalDirectory(path) {
  const full = resolve(path), info = lstatSync(full);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase())
    fail('A fixed local-session directory is not physical.', 'LOCAL_SESSION_PROFILE_INVALID');
  return full;
}
function within(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '.' || rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel).toLowerCase() !== resolve(path).toLowerCase())
    fail('A fixed local-session path escaped its repository-owned profile.', 'LOCAL_SESSION_PROFILE_INVALID');
}
function readPhysicalJson(path, maximum = 32 * 1024) {
  const full = physicalFile(path, maximum), bytes = readFileSync(full);
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('The fixed local-session profile is not valid JSON.', 'LOCAL_SESSION_PROFILE_INVALID'); }
}
export function readLocalSessionProfile(projectRoot = ROOT) {
  const root = physicalDirectory(projectRoot), local = physicalDirectory(join(root, '.local'));
  const path = join(local, 'platform-local-session.json');
  const profile = readPhysicalJson(path);
  if (!exactKeys(profile, ['schema', 'ollama', 'android']) || profile.schema !== PROFILE_SCHEMA ||
      !exactKeys(profile.ollama, ['path', 'sha256', 'version', 'model', 'modelDigest', 'endpoint', 'modelsRoot']) ||
      !exactKeys(profile.android, ['sdkRoot', 'jdkRoot', 'adbPath', 'serial', 'adbPort']))
    fail('The local tooling profile contains an unsupported field or is incomplete.', 'LOCAL_SESSION_PROFILE_INVALID');
  const ollamaPath = physicalFile(profile.ollama.path, 512 * 1024 * 1024);
  const modelsRoot = physicalDirectory(profile.ollama.modelsRoot);
  const sdkRoot = physicalDirectory(profile.android.sdkRoot), jdkRoot = physicalDirectory(profile.android.jdkRoot);
  const adbPath = physicalFile(profile.android.adbPath, 128 * 1024 * 1024);
  for (const path of [ollamaPath, modelsRoot, sdkRoot, jdkRoot, adbPath]) within(local, path);
  if (!exactKeys(profile.android, ['sdkRoot', 'jdkRoot', 'adbPath', 'serial', 'adbPort']) ||
      profile.ollama.version !== '0.35.1' || profile.ollama.model !== MODEL_NAME || profile.ollama.endpoint !== `http://${MODEL_HOST}:${MODEL_PORT}` ||
      !isHash(profile.ollama.sha256) || hash(readFileSync(ollamaPath)) !== profile.ollama.sha256 || !isHash(profile.ollama.modelDigest) ||
      profile.android.adbPort !== 15037 || profile.android.serial !== 'emulator-5580' ||
      resolve(adbPath).toLowerCase() !== resolve(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb').toLowerCase())
    fail('The installed local model or Android toolchain differs from the selected fixed profile.', 'LOCAL_SESSION_PROFILE_INVALID');
  const jdkRelease = readFileSync(physicalFile(join(jdkRoot, 'release'), 16 * 1024), 'utf8');
  const androidPlatform = physicalFile(join(sdkRoot, 'platforms', 'android-36', 'source.properties'), 16 * 1024);
  const platformText = readFileSync(androidPlatform, 'utf8');
  if (!jdkRelease.includes('JAVA_VERSION="21.0.12.1"') || !/AndroidVersion\.ApiLevel=36(?:\r?\n|$)/.test(platformText))
    fail('The selected Android SDK or JDK version is unavailable.', 'LOCAL_SESSION_PROFILE_INVALID');
  return Object.freeze({ ...profile, root, local, profilePath: path, profileDigest: hash(readFileSync(path)), ollama: Object.freeze({ ...profile.ollama, path: ollamaPath, modelsRoot }),
    android: Object.freeze({ ...profile.android, sdkRoot, jdkRoot, adbPath }) });
}

function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => Object.assign(new Error('A fixed local-session readiness deadline expired.'), { code: 'LOCAL_SESSION_TIMEOUT' });
  return new Promise((resolvePromise, reject) => {
    let intervalTimer;
    let deadlineTimer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (intervalTimer) clearTimeout(intervalTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      callback(value);
    };
    const tick = async () => {
      if (settled) return;
      if (Date.now() >= deadline) return finish(reject, timeoutError());
      try {
        const value = await predicate();
        if (settled) return;
        if (Date.now() >= deadline) return finish(reject, timeoutError());
        if (value) return finish(resolvePromise, value);
      } catch (error) {
        if (settled) return;
        if (Date.now() >= deadline) return finish(reject, timeoutError());
        if (error?.fatal || error?.code) return finish(reject, error);
      }
      const remaining = deadline - Date.now();
      if (remaining < 1) return finish(reject, timeoutError());
      intervalTimer = setTimeout(tick, Math.min(intervalMs, remaining));
    };
    deadlineTimer = setTimeout(() => finish(reject, timeoutError()), Math.max(1, timeoutMs));
    void tick();
  });
}
function bounded(promise, timeoutMs, message = 'A fixed local-session close deadline expired.') {
  let timer;
  return Promise.race([promise, new Promise((resolvePromise, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'LOCAL_SESSION_OWNER_UNKNOWN' })), timeoutMs);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}
function startupRemaining(deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1)
    fail('The selected local model did not become ready within its fixed startup bound.', 'LOCAL_MODEL_START_FAILED');
  return remaining;
}
function withinStartupDeadline(operation, deadline, message = 'The selected local model did not become ready within its fixed startup bound.') {
  const remaining = startupRemaining(deadline);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'LOCAL_MODEL_START_FAILED' })), remaining);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
async function readBoundedResponseText(response, maxBytes, deadline) {
  const reader = response.body?.getReader();
  if (!reader) fail('The fixed local model returned no readiness response body.', 'LOCAL_MODEL_IDENTITY_INVALID');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await withinStartupDeadline(() => reader.read(), deadline);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail('The fixed local model returned an invalid readiness response.', 'LOCAL_MODEL_IDENTITY_INVALID');
      total += part.value.byteLength;
      if (total > maxBytes) {
        try { void reader.cancel().catch(() => {}); } catch {}
        fail('The fixed local model returned an oversized readiness response.', 'LOCAL_MODEL_IDENTITY_INVALID');
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    try { void reader.cancel().catch(() => {}); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
  catch { fail('The fixed local model returned invalid readiness UTF-8.', 'LOCAL_MODEL_IDENTITY_INVALID'); }
}
async function fetchBoundedJson(path, maxBytes = 256 * 1024, deadline = Date.now() + 1200) {
  const url = `http://${MODEL_HOST}:${MODEL_PORT}${path}`;
  let response;
  try {
    const signal = AbortSignal.timeout(Math.min(1200, startupRemaining(deadline)));
    response = await withinStartupDeadline(() => fetch(url, { signal, redirect: 'error' }), deadline);
  }
  catch (error) { if (Date.now() >= deadline || error?.code === 'LOCAL_MODEL_START_FAILED') throw error; return undefined; }
  if (response.url !== url || !response.ok) return undefined;
  let text;
  try { text = await readBoundedResponseText(response, maxBytes, deadline); }
  catch (error) { if (Date.now() >= deadline || error?.code === 'LOCAL_MODEL_START_FAILED' || error?.code === 'LOCAL_MODEL_IDENTITY_INVALID') throw error; return undefined; }
  try { return JSON.parse(text); } catch { return undefined; }
}
async function postBoundedJson(path, value, maxBytes, deadline) {
  const url = `http://${MODEL_HOST}:${MODEL_PORT}${path}`;
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4096) fail('The fixed local model readiness request exceeded its bound.', 'LOCAL_MODEL_IDENTITY_INVALID');
  let response;
  try {
    response = await withinStartupDeadline(() => fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(startupRemaining(deadline)),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: bytes
    }), deadline);
  } catch {
    fail('The selected local model did not complete its bounded readiness load.', 'LOCAL_MODEL_START_FAILED');
  }
  if (response.url !== url || !response.ok) fail('The selected local model did not complete its bounded readiness load.', 'LOCAL_MODEL_START_FAILED');
  const text = await readBoundedResponseText(response, maxBytes, deadline);
  try { return JSON.parse(text); } catch { fail('The fixed local model returned an invalid readiness response.', 'LOCAL_MODEL_IDENTITY_INVALID'); }
}
async function verifyModel(profile, deadline, assertOwnerAlive = () => {}) {
  assertOwnerAlive();
  const version = await fetchBoundedJson('/api/version', 4096, deadline);
  assertOwnerAlive();
  const tags = await fetchBoundedJson('/api/tags', 256 * 1024, deadline);
  assertOwnerAlive();
  if (version?.version !== profile.ollama.version || !Array.isArray(tags?.models) || tags.models.length > 1024) return false;
  const model = tags.models.find(item => item?.name === MODEL_NAME || item?.model === MODEL_NAME);
  return Boolean(model && typeof model.digest === 'string' && model.digest.replace(/^sha256:/, '') === profile.ollama.modelDigest);
}
async function verifyResidentModel(profile, deadline, assertOwnerAlive) {
  assertOwnerAlive();
  const running = await fetchBoundedJson('/api/ps', 256 * 1024, deadline);
  assertOwnerAlive();
  if (!Array.isArray(running?.models) || running.models.length > 1024) return undefined;
  const model = running.models.find(item => item?.name === MODEL_NAME || item?.model === MODEL_NAME);
  if (!model || typeof model.digest !== 'string' || model.digest.replace(/^sha256:/, '') !== profile.ollama.modelDigest) return undefined;
  return profile.ollama.modelDigest;
}
async function warmCanonicalAnswerAdapter(projectRoot, deadline, assertOwnerAlive) {
  assertOwnerAlive();
  const adapterPath = physicalFile(join(projectRoot, 'packages', 'ai-core', 'dist', 'ollama.js'), 1024 * 1024);
  within(projectRoot, adapterPath);
  const adapter = await withinStartupDeadline(() => import(pathToFileURL(adapterPath).href), deadline,
    'The fixed local answer adapter did not load within the model startup bound.');
  assertOwnerAlive();
  if (adapter.OLLAMA_QWEN3_IDENTITY?.adapter !== 'ollama' || adapter.OLLAMA_QWEN3_IDENTITY?.model !== MODEL_NAME ||
      typeof adapter.createOllamaQwen3Provider !== 'function')
    fail('The fixed local answer adapter is unavailable.', 'LOCAL_SESSION_BUILD_REQUIRED');
  let result;
  try {
    const provider = adapter.createOllamaQwen3Provider();
    const signal = AbortSignal.timeout(startupRemaining(deadline));
    result = await withinStartupDeadline(() => provider(MODEL_READINESS_INPUT, { signal }), deadline,
      'The fixed local answer adapter did not pass its startup probe within the model startup bound.');
  } catch (error) {
    if (error?.code === 'LOCAL_MODEL_START_FAILED') throw error;
    fail('The fixed local answer adapter did not pass its startup probe.', 'LOCAL_MODEL_START_FAILED');
  }
  assertOwnerAlive();
  if (!result || !Array.isArray(result.segments) || result.segments.length < 1 || result.segments.length > 5 ||
      result.segments.some(segment => !segment || typeof segment.text !== 'string' || !segment.text.trim() ||
        !Array.isArray(segment.evidenceIds) || !segment.evidenceIds.includes('e0') || segment.evidenceIds.some(id => id !== 'e0')))
    fail('The fixed local answer adapter returned an invalid startup probe.', 'LOCAL_MODEL_START_FAILED');
}
function assertModelPortUnoccupied() {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: MODEL_HOST, port: MODEL_PORT });
    let settled = false;
    const done = (error) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolvePromise(); };
    socket.setTimeout(500, () => done(new Error('Could not verify that the fixed local model port is unused.')));
    socket.once('connect', () => done(Object.assign(new Error('The selected model port is already occupied; this session will not adopt its listener.'), { code: 'LOCAL_MODEL_PORT_OCCUPIED' })));
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : done(new Error('Could not verify that the fixed local model port is unused.')));
  });
}
function safeJsonWrite(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}
function validateOwnerRoot(path, localRoot = LOCAL) {
  const full = resolve(path); within(physicalDirectory(localRoot), full);
  if (full.length >= 240) fail('The selected private local-session path exceeds the supported limit.');
  return full;
}
function validateClientReference(value) {
  if (typeof value !== 'string' || !/^managed-mobile-[a-f0-9]{20}$/.test(value))
    fail('The fixed managed Android client reference is invalid.', 'LOCAL_SESSION_ARGUMENTS_INVALID');
  return value;
}
function managedClient(projectRoot, reference) {
  const root = physicalDirectory(projectRoot), local = physicalDirectory(join(root, '.local'));
  const managed = physicalDirectory(join(local, 'managed-mobile'));
  const referencePath = validateOwnerRoot(join(managed, validateClientReference(reference)), local);
  within(managed, referencePath);
  const clientFile = physicalFile(join(referencePath, 'managed-client.json'), 1024 * 1024);
  const client = readPhysicalJson(clientFile, 1024 * 1024);
  if (client.schema !== 'quadbridge.managed-mobile-client.v1' || client.clientReference !== reference ||
      !client.identity || client.identity.nativeApiProfile !== NATIVE_PROFILE ||
      typeof client.identity.productId !== 'string' || client.identity.productId !== client.identity.productId.toLowerCase() ||
      !/^[a-z][a-z0-9-]{1,47}$/.test(client.identity.productId) ||
      !/^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(client.identity.instanceId) ||
      !/^\d+\.\d+\.\d+$/.test(client.identity.productVersion) ||
      !hasCanonicalGenerationId(client.identity.generationId, client.identity.instanceId) ||
      !isHash(client.identity.artifactDigest) || !isHash(client.identity.planDigest))
    fail('The managed Android client does not have a complete fixed runtime identity.', 'LOCAL_ANDROID_CLIENT_INVALID');
  return { root, local, referencePath, client };
}
function walkPhysicalFiles(root) {
  const files = [];
  let total = 0;
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), info = lstatSync(path);
      if (entry.isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())
        fail('A managed Android directory contains a link.', 'LOCAL_ANDROID_CLIENT_INVALID');
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) {
        total += info.size;
        if (total > 128 * 1024 * 1024 || files.length >= 10000) fail('A managed Android client exceeds its fixed copy bound.', 'LOCAL_ANDROID_CLIENT_INVALID');
        files.push({ source: path, relative: relative(root, path), size: info.size });
      } else fail('A managed Android client contains a special file.', 'LOCAL_ANDROID_CLIENT_INVALID');
    }
  };
  visit(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}
function copyPhysicalTree(source, destination) {
  physicalDirectory(source);
  mkdirSync(destination);
  physicalDirectory(destination);
  for (const entry of walkPhysicalFiles(source)) {
    const target = join(destination, entry.relative);
    if (target.length >= 240) fail('A private Android build path exceeds the supported limit.', 'LOCAL_SESSION_PATH_INVALID');
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(entry.source, target);
    const sourceBytes = readFileSync(physicalFile(entry.source)), targetBytes = readFileSync(physicalFile(target));
    if (sourceBytes.length !== targetBytes.length || hash(sourceBytes) !== hash(targetBytes))
      fail('A managed Android copy changed during creation.', 'LOCAL_ANDROID_CLIENT_INVALID');
  }
}
const ANDROID_BUILD_DIAGNOSTIC_LIMIT = 2 * 1024 * 1024;
const ANDROID_COMMAND_OUTPUT_LIMIT = 128 * 1024;
function privateAndroidBuildDiagnostics(operationRoot) {
  const path = join(physicalDirectory(operationRoot), 'android-build-diagnostics.log');
  if (path.length >= 240) fail('The private Android diagnostic path exceeds the supported limit.', 'LOCAL_SESSION_PATH_INVALID');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch { return { start() {}, finish() {}, close() {} }; }
  let written = 0, closed = false;
  const append = value => {
    if (closed || written >= ANDROID_BUILD_DIAGNOSTIC_LIMIT) return;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Math.min(bytes.length, ANDROID_BUILD_DIAGNOSTIC_LIMIT - written);
    let offset = 0;
    try {
      while (offset < length) {
        const count = writeSync(fd, bytes, offset, length - offset);
        if (count <= 0) throw new Error('diagnostic write made no progress');
        offset += count;
      }
      written += offset;
    } catch { closed = true; try { closeSync(fd); } catch {} }
  };
  return {
    start(step) { append(`${JSON.stringify({ schema: 'quadbridge.private-android-command.v1', step, phase: 'start', at: new Date().toISOString() })}\n`); },
    finish(step, result) {
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
      const stdoutLength = Math.min(stdout.length, ANDROID_COMMAND_OUTPUT_LIMIT);
      const stderrLength = Math.min(stderr.length, ANDROID_COMMAND_OUTPUT_LIMIT);
      append(`${JSON.stringify({ schema: 'quadbridge.private-android-command.v1', step, phase: 'close', at: new Date().toISOString(),
        status: result.status ?? null, signal: result.signal ?? null, errorCode: result.error?.code ?? null,
        stdoutBytes: stdout.length, stdoutCapturedBytes: stdoutLength, stdoutTruncated: stdoutLength < stdout.length,
        stderrBytes: stderr.length, stderrCapturedBytes: stderrLength, stderrTruncated: stderrLength < stderr.length })}\n`);
      if (stdoutLength) { append('--- stdout ---\n'); append(stdout.subarray(0, stdoutLength)); append('\n'); }
      if (stderrLength) { append('--- stderr ---\n'); append(stderr.subarray(0, stderrLength)); append('\n'); }
    },
    close() { if (!closed) { closed = true; try { closeSync(fd); } catch {} } }
  };
}
function spawnBoundedSync(command, args, options, timeout = 600_000, diagnostic) {
  diagnostic?.log?.start(diagnostic.step);
  const result = spawnSync(command, args, { ...options, timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    maxBuffer: 512 * 1024 });
  diagnostic?.log?.finish(diagnostic.step, result);
  if (result.error || result.signal || result.status !== 0)
    fail('A fixed Android preparation or build command did not complete successfully.', 'LOCAL_ANDROID_BUILD_FAILED');
}
function runNpmScript(project, script, env, diagnostics) {
  const comspec = process.env.ComSpec || 'cmd.exe';
  if (!['android:add', 'android:sync', 'android:prepare'].includes(script)) fail('The fixed Android script is invalid.');
  spawnBoundedSync(comspec, ['/d', '/s', '/c', `npm.cmd run ${script}`], { cwd: project, env }, 600_000,
    diagnostics ? { log: diagnostics, step: `capacitor-${script.slice('android:'.length)}` } : undefined);
}
function nativeBuildEnvironment(profile) {
  const home = join(profile.local, 'platform-local-session-tools');
  const directories = {
    home,
    gradle: join(home, 'gradle'),
    android: join(home, 'android-user'),
    java: join(home, 'java-home')
  };
  for (const path of Object.values(directories)) {
    if (!existsSync(path)) mkdirSync(path);
    physicalDirectory(path);
    within(profile.local, path);
  }
  const env = { ...localEnv(), ANDROID_HOME: profile.android.sdkRoot, ANDROID_SDK_ROOT: profile.android.sdkRoot,
    ANDROID_USER_HOME: directories.android, GRADLE_USER_HOME: directories.gradle,
    JAVA_HOME: profile.android.jdkRoot, JAVA_TOOL_OPTIONS: `-Duser.home=${directories.java}` };
  delete env.ANDROID_PREFS_ROOT;
  delete env.ANDROID_SDK_HOME;
  env.PATH = `${join(profile.android.jdkRoot, 'bin')};${join(profile.android.sdkRoot, 'platform-tools')};${env.PATH ?? ''}`;
  return env;
}
function adb(profile, args, project, env) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) fail('The fixed Android device command is invalid.');
  spawnBoundedSync(profile.android.adbPath, ['-P', String(profile.android.adbPort), '-s', profile.android.serial, ...args], { cwd: project, env });
}
function verifyAndroidBuild(projectRoot, reference) {
  const root = physicalDirectory(projectRoot), local = physicalDirectory(join(root, '.local'));
  const buildBase = physicalDirectory(join(local, 'managed-mobile-builds'));
  const buildPath = validateOwnerRoot(join(buildBase, validateClientReference(reference)), local);
  within(buildBase, buildPath);
  const receiptPath = physicalFile(join(buildPath, 'managed-android-build.json'), 128 * 1024);
  const receipt = readPhysicalJson(receiptPath, 128 * 1024);
  if (receipt.schema !== 'quadbridge.managed-android-build.v1' || receipt.clientReference !== reference ||
      !isHash(receipt.clientManifestDigest) || !receipt.outputs || !isHash(receipt.outputs['android/app/build/outputs/apk/debug/app-debug.apk']) ||
      !isHash(receipt.outputs['android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk']) ||
      canonical(Object.keys(receipt.outputs).sort()) !== canonical(['android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk', 'android/app/build/outputs/apk/debug/app-debug.apk']))
    fail('The managed Android build receipt is invalid.', 'LOCAL_ANDROID_BUILD_INVALID');
  for (const [relativePath, expected] of Object.entries(receipt.outputs)) {
    if (!/^[a-f0-9]{64}$/.test(expected)) fail('The managed Android build inventory is invalid.', 'LOCAL_ANDROID_BUILD_INVALID');
    const path = physicalFile(join(buildPath, ...relativePath.split('/')), 512 * 1024 * 1024);
    within(buildPath, path);
    if (hash(readFileSync(path)) !== expected) fail('A managed Android build output changed.', 'LOCAL_ANDROID_BUILD_INVALID');
  }
  return { buildPath, receipt };
}
function androidWorker(projectRoot, profilePath, operationRoot, reference, action) {
  const root = physicalDirectory(projectRoot), profile = readLocalSessionProfile(root), op = physicalDirectory(operationRoot);
  within(physicalDirectory(join(profile.local, 'platform-local-session-jobs')), op);
  if (profile.profilePath !== resolve(profilePath) || !['build', 'install'].includes(action)) fail('The fixed Android worker request is invalid.', 'LOCAL_SESSION_ARGUMENTS_INVALID');
  const client = managedClient(root, reference);
  const assembly = awaitImportManagedAssembler(root);
  return assembly.then(async ({ verifyManagedClientDirectory }) => {
    await verifyManagedClientDirectory(client.referencePath, { clientReference: reference, identity: client.client.identity });
    const profileEnv = nativeBuildEnvironment(profile);
    if (action === 'build') {
      const buildBase = join(profile.local, 'managed-mobile-builds');
      if (!existsSync(buildBase)) mkdirSync(buildBase);
      physicalDirectory(buildBase);
      const final = join(buildBase, reference);
      if (existsSync(final)) {
        const current = verifyAndroidBuild(root, reference);
        if (current.receipt.clientManifestDigest !== hash(readFileSync(join(client.referencePath, 'managed-client.json'))) ||
            canonical(current.receipt.identity) !== canonical(client.client.identity))
          fail('An existing Android build belongs to a different packaged client.', 'LOCAL_ANDROID_BUILD_INVALID');
        return { action, reference, outputDir: current.buildPath, reused: true, appSha256: current.receipt.outputs['android/app/build/outputs/apk/debug/app-debug.apk'],
          testSha256: current.receipt.outputs['android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'] };
      }
      const staging = join(buildBase, `.stage-${randomUUID()}`);
      if (staging.length >= 240) fail('The private Android build path exceeds the supported limit.', 'LOCAL_SESSION_PATH_INVALID');
      copyPhysicalTree(client.referencePath, staging);
      const originalDigest = hash(readFileSync(join(client.referencePath, 'managed-client.json')));
      const diagnostics = privateAndroidBuildDiagnostics(op);
      try {
        const copied = await verifyManagedClientDirectory(staging, { clientReference: reference, identity: client.client.identity });
        spawnBoundedSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci'], { cwd: staging, env: profileEnv }, 600_000,
          { log: diagnostics, step: 'npm-ci' });
        runNpmScript(staging, 'android:add', profileEnv, diagnostics);
        runNpmScript(staging, 'android:sync', profileEnv, diagnostics);
        runNpmScript(staging, 'android:prepare', profileEnv, diagnostics);
        physicalFile(join(staging, 'android', 'gradlew.bat'), 1024 * 1024);
        const gradleArgs = ['--no-daemon', '--console=plain', ':app:assembleDebug', ':app:assembleDebugAndroidTest'];
        spawnBoundedSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `gradlew.bat ${gradleArgs.join(' ')}`],
          { cwd: join(staging, 'android'), env: profileEnv }, 600_000, { log: diagnostics, step: 'gradle-assemble-debug-and-test' });
        const appRelative = 'android/app/build/outputs/apk/debug/app-debug.apk';
        const testRelative = 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk';
        const appApk = physicalFile(join(staging, ...appRelative.split('/')), 512 * 1024 * 1024);
        const testApk = physicalFile(join(staging, ...testRelative.split('/')), 512 * 1024 * 1024);
        const outputs = { [appRelative]: hash(readFileSync(appApk)), [testRelative]: hash(readFileSync(testApk)) };
        const receipt = { schema: 'quadbridge.managed-android-build.v1', clientReference: reference, identity: client.client.identity,
          clientManifestDigest: originalDigest, nativeProfile: 'local-native-forwarded-v1', androidApi: 36, outputs };
        writeFileSync(join(staging, 'managed-android-build.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        if (hash(readFileSync(join(client.referencePath, 'managed-client.json'))) !== originalDigest)
          fail('The source Android client changed during its private build.', 'LOCAL_ANDROID_BUILD_INVALID');
        if (existsSync(final)) fail('The managed Android build destination became occupied.', 'LOCAL_ANDROID_BUILD_INVALID');
        renameSync(staging, final);
        return { action, reference, outputDir: final, reused: false, appSha256: outputs[appRelative], testSha256: outputs[testRelative],
          packagedManifest: hash(readFileSync(join(client.referencePath, 'managed-client.json'))), copiedManifest: hash(readFileSync(join(final, 'managed-client.json'))),
          copied: copied.clientReference === reference };
      } catch (error) {
        // The staging tree belongs only to this closed one-shot build. Keep it on
        // failure so the private build log and failed Gradle outputs remain inspectable.
        error.retainBuild = true;
        throw error;
      } finally {
        diagnostics.close();
      }
    }
    const verified = verifyAndroidBuild(root, reference);
    if (verified.receipt.clientManifestDigest !== hash(readFileSync(join(client.referencePath, 'managed-client.json'))) ||
        canonical(verified.receipt.identity) !== canonical(client.client.identity))
      fail('The selected Android APK does not match this exact managed client.', 'LOCAL_ANDROID_BUILD_INVALID');
    const appRelative = 'android/app/build/outputs/apk/debug/app-debug.apk';
    const testRelative = 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk';
    const appApk = physicalFile(join(verified.buildPath, ...appRelative.split('/')), 512 * 1024 * 1024);
    const testApk = physicalFile(join(verified.buildPath, ...testRelative.split('/')), 512 * 1024 * 1024);
    const port = createConnection({ host: '127.0.0.1', port: profile.android.adbPort });
    const listener = await new Promise((resolvePromise, reject) => {
      port.setTimeout(750, () => reject(new Error('The selected Android debug bridge is not already running.')));
      port.once('connect', () => resolvePromise(true));
      port.once('error', () => reject(new Error('The selected Android debug bridge is not already running.')));
    }).finally(() => port.destroy());
    if (!listener) fail('The selected Android debug bridge is unavailable.', 'LOCAL_ANDROID_PROFILE_UNAVAILABLE');
    adb(profile, ['get-state'], root, profileEnv);
    const version = spawnSync(profile.android.adbPath, ['-P', String(profile.android.adbPort), '-s', profile.android.serial, 'shell', 'getprop', 'ro.build.version.sdk'],
      { cwd: root, env: profileEnv, encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    if (version.error || version.signal || version.status !== 0 || version.stdout.trim() !== '36') fail('The selected Android device is not the fixed API 36 profile.', 'LOCAL_ANDROID_PROFILE_UNAVAILABLE');
    adb(profile, ['reverse', 'tcp:4350', 'tcp:4350'], root, profileEnv);
    adb(profile, ['install', '-r', appApk], root, profileEnv);
    adb(profile, ['install', '-r', testApk], root, profileEnv);
    const packageId = verified.receipt.identity.productId.replace(/-/g, '_');
    const installed = spawnSync(profile.android.adbPath, ['-P', String(profile.android.adbPort), '-s', profile.android.serial,
      'shell', 'pm', 'path', `com.quadbridge.products.${packageId}`],
      { cwd: root, env: profileEnv, encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    if (installed.error || installed.signal || installed.status !== 0 || !installed.stdout.includes('package:')) fail('Android did not confirm the selected application install.', 'LOCAL_ANDROID_INSTALL_FAILED');
    const instrumented = spawnSync(profile.android.adbPath, ['-P', String(profile.android.adbPort), '-s', profile.android.serial,
      'shell', 'pm', 'path', `com.quadbridge.products.${packageId}.test`],
      { cwd: root, env: profileEnv, encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    if (instrumented.error || instrumented.signal || instrumented.status !== 0 || !instrumented.stdout.includes('package:'))
      fail('Android did not confirm the app-specific instrumentation install.', 'LOCAL_ANDROID_INSTALL_FAILED');
    return { action, reference, identity: verified.receipt.identity, appSha256: verified.receipt.outputs[appRelative],
      testSha256: verified.receipt.outputs[testRelative], androidApi: 36, serial: profile.android.serial, installed: true };
  });
}
function awaitImportManagedAssembler(projectRoot) {
  return import(pathToFileURL(join(projectRoot, 'tools', 'mobile', 'assemble.mjs')).href);
}
async function androidWorkerMain(args) {
  if (args.length !== 6) fail('The fixed Android worker request is invalid.', 'LOCAL_SESSION_ARGUMENTS_INVALID');
  const [, projectRoot, profilePath, operationRoot, reference, action] = args;
  const result = await androidWorker(projectRoot, profilePath, operationRoot, validateClientReference(reference), action);
  console.log(JSON.stringify(result));
}

async function androidCommand(action, reference) {
  const operation = action === 'android-build' ? 'build' : action === 'android-install' ? 'install' : undefined;
  if (!operation) fail('The fixed Android operation is invalid.', 'LOCAL_SESSION_ARGUMENTS_INVALID');
  const profile = readLocalSessionProfile(ROOT), host = await captureHost();
  const manager = await import(pathToFileURL(join(ROOT, 'apps', 'control-plane', 'dist', 'runtime-manager.js')).href);
  if (typeof manager.runManagedRuntimeOwnedNativeJob !== 'function') fail('Run the maintained build before Android packaging.', 'LOCAL_SESSION_BUILD_REQUIRED');
  managedClient(ROOT, reference);
  mkdirSync(JOB_BASE, { recursive: true }); physicalDirectory(JOB_BASE);
  const operationRoot = validateOwnerRoot(join(JOB_BASE, randomUUID()));
  mkdirSync(operationRoot); physicalDirectory(operationRoot);
  const scriptPath = join(operationRoot, 'local-session.mjs'), helperPath = join(operationRoot, 'build-job.ps1'), logPath = join(operationRoot, 'android-job.log');
  copyFileSync(physicalFile(fileURLToPath(import.meta.url), 2 * 1024 * 1024), scriptPath);
  copyFileSync(physicalFile(join(ROOT, 'tools', 'build-job.ps1'), 1024 * 1024), helperPath);
  const scriptDigest = hash(readFileSync(physicalFile(scriptPath, 2 * 1024 * 1024)));
  const proof = await manager.runManagedRuntimeOwnedNativeJob({ projectRoot: ROOT, operationRoot, helperPath, scriptPath, logPath, scriptDigest,
    args: ['android-worker', ROOT, profile.profilePath, operationRoot, reference, operation], expectedHost: host, timeoutMs: 600_000, authorize: () => true });
  const clean = proof.started && proof.readyObserved && proof.closeObserved && proof.exitCode === 0 && proof.signal === null &&
    proof.markerCode === 0 && proof.helperClosed && proof.emptyObserved && !proof.errorCode;
  if (!clean) fail('The original Android build Job did not provide clean completion proof; its private files are retained.', 'LOCAL_ANDROID_JOB_UNKNOWN');
  const physical = physicalDirectory(operationRoot); within(physicalDirectory(JOB_BASE), physical);
  const log = physicalFile(logPath, 1024 * 1024);
  const output = readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).at(-1);
  let result;
  try { result = JSON.parse(output); } catch { fail('The fixed Android worker did not return its bounded result.', 'LOCAL_ANDROID_JOB_RESULT_INVALID'); }
  if (result.action !== operation || result.reference !== reference) fail('The fixed Android worker result does not match its original request.', 'LOCAL_ANDROID_JOB_RESULT_INVALID');
  rmSync(physical, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify(result));
}
async function engineOwner(projectRoot, profilePath, statusPath, nonce, expectedScriptDigest) {
  const root = physicalDirectory(projectRoot), local = physicalDirectory(join(root, '.local'));
  if (resolve(profilePath) !== join(local, 'platform-local-session.json') || !/^[a-f0-9]{48}$/.test(nonce) || !isHash(expectedScriptDigest))
    fail('The fixed model owner request is invalid.', 'LOCAL_SESSION_ARGUMENTS_INVALID');
  const profile = readLocalSessionProfile(root), ownerRoot = physicalDirectory(dirname(statusPath));
  within(physicalDirectory(join(local, 'platform-local-session')), ownerRoot);
  if (hash(readFileSync(physicalFile(fileURLToPath(import.meta.url), 2 * 1024 * 1024))) !== expectedScriptDigest)
    fail('The copied local-session worker changed before launch.', 'LOCAL_SESSION_TOOLCHAIN_CHANGED');
  if (ownerRoot.length >= 240) fail('The selected private local-session path exceeds the supported limit.');
  if (resolve(statusPath) !== join(ownerRoot, 'engine-ready.json') || existsSync(statusPath)) fail('The model owner status path is invalid.', 'LOCAL_SESSION_ARGUMENTS_INVALID');
  const env = localEnv();
  env.OLLAMA_HOST = `${MODEL_HOST}:${MODEL_PORT}`; env.OLLAMA_MODELS = profile.ollama.modelsRoot; env.OLLAMA_NO_CLOUD = '1'; env.OLLAMA_KEEP_ALIVE = '-1';
  const deadline = Date.now() + MODEL_STARTUP_TIMEOUT_MS;
  let child;
  try { child = spawn(profile.ollama.path, ['serve'], { cwd: profile.ollama.modelsRoot, env, shell: false, windowsHide: true, stdio: 'ignore' }); }
  catch { fail('The selected local model server could not be started.', 'LOCAL_MODEL_START_FAILED'); }
  let unexpected = false;
  const closed = new Promise(resolvePromise => child.once('close', (code, signal) => resolvePromise({ code, signal })));
  child.once('error', () => { unexpected = true; });
  const assertOwnerAlive = () => {
    startupRemaining(deadline);
    if (unexpected || child.exitCode !== null || child.signalCode !== null)
      fail('The owned local model process exited before readiness.', 'LOCAL_MODEL_START_FAILED');
  };
  try {
    await waitFor(async () => {
      assertOwnerAlive();
      return await verifyModel(profile, deadline, assertOwnerAlive);
    }, startupRemaining(deadline));
    assertOwnerAlive();
    const loaded = await postBoundedJson('/api/generate', { model: MODEL_NAME, prompt: '', stream: false, keep_alive: -1 }, 64 * 1024, deadline);
    assertOwnerAlive();
    if (loaded?.model !== MODEL_NAME || loaded.done !== true || loaded.done_reason !== 'load')
      fail('The selected local model did not complete its fixed startup load.', 'LOCAL_MODEL_START_FAILED');
    await warmCanonicalAnswerAdapter(root, deadline, assertOwnerAlive);
    const residentDigest = await waitFor(() => verifyResidentModel(profile, deadline, assertOwnerAlive), startupRemaining(deadline));
    assertOwnerAlive();
    safeJsonWrite(statusPath, { schema: 'quadbridge.local-model-owner-ready.v1', nonce, profileDigest: profile.profileDigest,
      version: profile.ollama.version, model: MODEL_NAME, modelDigest: profile.ollama.modelDigest,
      residentDigest, readinessProbe: 'structured-e0' });
    const outcome = await closed;
    if (outcome.code !== 0 || outcome.signal !== null) fail('The selected local model process did not close cleanly.', 'LOCAL_MODEL_CLOSE_FAILED');
  } catch (error) {
    try { child.kill(); } catch {}
    await Promise.race([closed, new Promise(resolvePromise => setTimeout(resolvePromise, 5000))]);
    throw error;
  }
}

async function captureHost() {
  if (process.platform !== 'win32') fail('The selected local process-owner profile is available on Windows only.');
  const manager = await import(pathToFileURL(join(ROOT, 'apps', 'control-plane', 'dist', 'runtime-manager.js')).href);
  if (typeof manager.captureManagedRuntimeNativeHost !== 'function') fail('Run the maintained build before starting the local session.', 'LOCAL_SESSION_BUILD_REQUIRED');
  return manager.captureManagedRuntimeNativeHost(ROOT);
}
function spawnPowerShell(host, operationRoot, scriptPath, args, logPath, runtimeProtocol, nonce = randomBytes(24).toString('hex')) {
  const helperPath = physicalFile(join(ROOT, 'tools', 'build-job.ps1'), 1024 * 1024);
  if (helperPath.length >= 240 || scriptPath.length >= 240 || logPath.length >= 240 || operationRoot.length >= 240)
    fail('The selected private process-owner files exceed the supported path bound.', 'LOCAL_SESSION_PATH_INVALID');
  const helperDigest = hash(readFileSync(helperPath));
  if (helperDigest !== host.buildJobDigest) fail('The fixed native process-owner helper changed after host selection.', 'LOCAL_SESSION_TOOLCHAIN_CHANGED');
  const child = spawn(host.hostPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath, '-RunnerNonce', nonce,
    '-NodeExe', host.nodePath, '-WorkingDirectory', operationRoot, '-ScriptPath', scriptPath, '-ArgumentsJson', JSON.stringify(args),
    '-LogPath', logPath, ...(runtimeProtocol ? ['-RuntimeProtocol'] : [])],
  { cwd: operationRoot, env: localEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, nonce };
}
function readProtocol(child, nonce) {
  let stdout = '', ready = false, exitMarker;
  let resolveClose;
  const closed = new Promise(resolvePromise => { resolveClose = resolvePromise; });
  child.once('close', (code, signal) => resolveClose({ code, signal }));
  child.stdout?.on('data', chunk => {
    stdout += chunk.toString('ascii');
    if (Buffer.byteLength(stdout) > 4096) return;
    for (;;) {
      const index = stdout.indexOf('\n'); if (index < 0) return;
      let line = stdout.slice(0, index); stdout = stdout.slice(index + 1); if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === `QB_READY:${nonce}` && !ready && !exitMarker) ready = true;
      else {
        const match = new RegExp(`^QB_EXIT:${nonce}:(\\d+):EMPTY$`).exec(line);
        if (ready && !exitMarker && match) exitMarker = Number(match[1]);
        else exitMarker = 'INVALID';
      }
    }
  });
  return { closed, ready: () => ready, exit: () => exitMarker, pendingBytes: () => stdout.length };
}
async function waitForReady(protocol, child, timeoutMs) {
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) fail('The original local process owner closed before readiness.', 'LOCAL_SESSION_OWNER_UNKNOWN');
    return protocol.ready();
  }, timeoutMs);
}
function sendControl(child, verb, nonce) {
  if (!['RESUME', 'STOP'].includes(verb) || !child.stdin || child.exitCode !== null || child.signalCode !== null) fail('The original local process owner cannot accept control.', 'LOCAL_SESSION_OWNER_UNKNOWN');
  child.stdin.write(`${verb}:${nonce}\n`);
}
function requireCleanJob(protocol, close) {
  if (!protocol.ready() || protocol.exit() !== 124 || protocol.pendingBytes() !== 0 || close.code !== 124 || close.signal !== null)
    fail('The original local model owner did not prove matching EMPTY and close facts; its private record is retained.', 'LOCAL_SESSION_OWNER_UNKNOWN');
}
async function modelOwnerStart(profile, host, ownerRoot, sessionId) {
  await assertModelPortUnoccupied();
  const scriptSource = physicalFile(fileURLToPath(import.meta.url), 2 * 1024 * 1024);
  const scriptCopy = join(ownerRoot, 'local-session.mjs');
  copyFileSync(scriptSource, scriptCopy);
  const digest = hash(readFileSync(scriptCopy)), readyPath = join(ownerRoot, 'engine-ready.json'), logPath = join(ownerRoot, 'owner.log');
  const nonce = randomBytes(24).toString('hex');
  const { child } = spawnPowerShell(host, ownerRoot, scriptCopy,
    ['engine-owner', profile.root, profile.profilePath, readyPath, nonce, digest], logPath, true, nonce);
  const protocol = readProtocol(child, nonce);
  let safeToRemove = false;
  try {
    await waitForReady(protocol, child, 30_000);
    sendControl(child, 'RESUME', nonce);
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) fail('The original model owner exited before the fixed model became ready.', 'LOCAL_MODEL_START_FAILED');
      if (!existsSync(readyPath)) return false;
      const ready = readPhysicalJson(readyPath, 4096);
      return exactKeys(ready, ['schema', 'nonce', 'profileDigest', 'version', 'model', 'modelDigest', 'residentDigest', 'readinessProbe']) &&
        ready.schema === 'quadbridge.local-model-owner-ready.v1' && ready.nonce === nonce && ready.profileDigest === profile.profileDigest &&
        ready.version === profile.ollama.version && ready.model === MODEL_NAME && ready.modelDigest === profile.ollama.modelDigest &&
        ready.residentDigest === profile.ollama.modelDigest && ready.readinessProbe === 'structured-e0' &&
        child.exitCode === null && child.signalCode === null;
    }, MODEL_STARTUP_TIMEOUT_MS);
    return { child, nonce, protocol, ownerRoot, digest, safeToRemove: false };
  } catch (error) {
    if (protocol.ready() && child.exitCode === null && child.signalCode === null) {
      try {
        sendControl(child, 'STOP', nonce);
        const close = await bounded(protocol.closed, 10_000);
        requireCleanJob(protocol, close);
        safeToRemove = true;
        error.safeToRemove = true;
      } catch {
        error.retainOwner = true;
      }
    } else if (child.exitCode !== null || child.signalCode !== null) {
      // A close without a matching original ready/EMPTY transcript cannot prove the
      // helper never started the selected model child.
      error.retainOwner = true;
    } else {
      error.retainOwner = true;
    }
    if (!safeToRemove) error.retainOwner = true;
    throw error;
  }
}

async function startSession() {
  if (existsSync(SESSION_LOCK)) fail('A previous local-session owner is still recorded. Inspect its original close record before starting another session.', 'LOCAL_SESSION_OWNER_UNKNOWN');
  const profile = readLocalSessionProfile(ROOT), host = await captureHost();
  const ollamaBytes = readFileSync(profile.ollama.path);
  if (hash(ollamaBytes) !== profile.ollama.sha256) fail('The selected local model executable changed after profile validation.', 'LOCAL_SESSION_PROFILE_INVALID');
  mkdirSync(OWNER_BASE, { recursive: true }); physicalDirectory(OWNER_BASE);
  mkdirSync(JOB_BASE, { recursive: true }); physicalDirectory(JOB_BASE);
  const sessionId = randomUUID(), ownerRoot = validateOwnerRoot(join(OWNER_BASE, sessionId));
  mkdirSync(ownerRoot); physicalDirectory(ownerRoot);
  safeJsonWrite(SESSION_LOCK, { schema: 'quadbridge.local-session-owner.v1', sessionId, profileDigest: profile.profileDigest, state: 'OWNED' });
  let model;
  let controlPlane;
  let closeFlight;
  try {
    model = await modelOwnerStart(profile, host, ownerRoot, sessionId);
    const entry = await import(pathToFileURL(join(ROOT, 'apps', 'control-plane', 'dist', 'main.js')).href);
    if (typeof entry.startControlPlane !== 'function') fail('Run the maintained build before starting the local session.', 'LOCAL_SESSION_BUILD_REQUIRED');
    controlPlane = await entry.startControlPlane({ root: ROOT, databasePath: join(LOCAL, 'control-plane.sqlite'), modelProfile: MODEL_PROFILE, nativeApiProfile: NATIVE_PROFILE });
    console.log(`Local model ${MODEL_NAME} is ready on the fixed loopback profile; paired Studio is running at ${controlPlane.url}.`);
    console.log('Pair with the displayed local code. Inspect the private credentials.json location in Runtime before signing in on web or Android.');
    console.log('Type stop or press Ctrl+C to close the paired application owners, then the exact local model Job.');
  } catch (error) {
    if (model) {
      try {
        sendControl(model.child, 'STOP', model.nonce);
        const close = await bounded(model.protocol.closed, 10_000);
        requireCleanJob(model.protocol, close);
      } catch {
        fail('The failed local-session startup retained an uncertain original model owner.', 'LOCAL_SESSION_OWNER_UNKNOWN');
      }
    } else if (error?.retainOwner && !error?.safeToRemove) {
      fail('The failed local-session startup retained an uncertain original model owner.', 'LOCAL_SESSION_OWNER_UNKNOWN');
    }
    try {
      const physical = physicalDirectory(ownerRoot);
      within(physicalDirectory(OWNER_BASE), physical);
      rmSync(physical, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
      const lock = readPhysicalJson(SESSION_LOCK, 4096);
      if (lock.schema !== 'quadbridge.local-session-owner.v1' || lock.sessionId !== sessionId || lock.profileDigest !== profile.profileDigest)
        fail('The local-session owner record changed before cleanup.', 'LOCAL_SESSION_OWNER_UNKNOWN');
      rmSync(SESSION_LOCK);
    } catch {
      fail('The failed local-session startup retained its private owner record for review.', 'LOCAL_SESSION_OWNER_UNKNOWN');
    }
    throw error;
  }
  const shutdown = () => {
    if (closeFlight) return closeFlight;
    closeFlight = (async () => {
      await controlPlane.close();
      sendControl(model.child, 'STOP', model.nonce);
      const close = await bounded(model.protocol.closed, 10_000);
      requireCleanJob(model.protocol, close);
      const lock = readPhysicalJson(SESSION_LOCK, 4096);
      if (lock.schema !== 'quadbridge.local-session-owner.v1' || lock.sessionId !== sessionId || lock.profileDigest !== profile.profileDigest)
        fail('The local-session owner record changed before cleanup.', 'LOCAL_SESSION_OWNER_UNKNOWN');
      const physical = physicalDirectory(ownerRoot); within(physicalDirectory(OWNER_BASE), physical);
      rmSync(physical, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
      rmSync(SESSION_LOCK);
      console.log('Local application owners closed; the selected model Job reported matching EMPTY and original close.');
    })();
    return closeFlight;
  };
  return new Promise((resolvePromise, reject) => {
    let stopping = false;
    let pending = '';
    const finishInput = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (process.stdin.isTTY) {
        process.stdin.off('data', onData);
        process.stdin.pause();
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void shutdown().then(value => { finishInput(); resolvePromise(value); }, error => { finishInput(); reject(error); });
    };
    const onSigint = () => stop();
    const onSigterm = () => stop();
    const onData = chunk => {
      pending += chunk;
      if (pending.length > 1024) pending = '';
      const at = pending.indexOf('\n');
      if (at < 0) return;
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (line.toLowerCase() === 'stop') stop();
      else if (line) console.log('Type stop to close the local session.');
    };
    process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8'); process.stdin.resume();
      process.stdin.on('data', onData);
    }
  });
}

async function main(argv) {
  if (argv[0] === 'engine-owner' && argv.length === 6) return engineOwner(argv[1], argv[2], argv[3], argv[4], argv[5]);
  if (argv[0] === 'android-worker') return androidWorkerMain(argv);
  if (argv.length === 1 && argv[0] === 'start') return startSession();
  if ((argv[0] === 'android-build' || argv[0] === 'android-install') && argv.length === 3 && argv[1] === '--client' && /^managed-mobile-[a-f0-9]{20}$/.test(argv[2]))
    return androidCommand(argv[0], argv[2]);
  fail('Usage: node tools/local-session.mjs start | android-build --client managed-mobile-<20 hex> | android-install --client managed-mobile-<20 hex>', 'LOCAL_SESSION_ARGUMENTS_INVALID');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`${/^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? error.code : 'LOCAL_SESSION_FAILED'}: ${error instanceof Error ? error.message : 'The local session failed.'}`); process.exitCode = 1; }
}
