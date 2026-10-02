// Test-owned operational fixture for CORE-DELIVERY-001. This starts a fresh
// full console over copied reviewed source; it does not create product/build/
// artifact/runtime rows before the ordinary Studio journey.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync, lstatSync, opendirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDirectory, '..', '..');
const contextPath = join(sourceRoot, '.local', 'core-delivery-001-live-context.json');
const fixtureId = randomUUID();
const sourceSha = bytes => createHash('sha256').update(bytes).digest('hex');
const names = {
  ready: 'live.ready.json',
  stop: 'live.stop',
  removeRequest: 'live.remove-request.json',
  removeResult: 'live.remove-result.json',
  closed: 'live.closed.json',
  failed: 'live.failed.json',
  candidateBefore: 'candidate.before.json',
  candidateAfterBuild: 'candidate.after-build.json',
  candidateAfterClose: 'candidate.after-close.json',
  buildLog: 'private-build.log',
};
const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, join(scriptDirectory, name)]));
const controlPaths = [paths.ready, paths.stop, paths.removeRequest, paths.removeResult, paths.closed, paths.failed];
const MAX_CANDIDATE_FILES = 1000;
const MAX_CANDIDATE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_CANDIDATE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 16_384;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_SCAN_MS = 2_000;

for (const path of [...controlPaths, paths.candidateBefore, paths.candidateAfterBuild, paths.candidateAfterClose, paths.buildLog]) {
  if (existsSync(path)) throw new Error('A prior core-delivery fixture file exists; reconcile it before starting another fixture');
}
if (process.platform !== 'win32') throw new Error('The actual managed-core fixture requires the selected Windows local profile');

let privateRoot;
let server;
let controlTimer;
let closeFlight;
let polling = false;
let stage = 'read-candidate';
let coreCandidate;
let verifyBackupObject;
let readBoundedSnapshot;
let artifactRegistryLimits;
let runtimePlanIdentity;
let canonicalJson;

function safeErrorCode(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : fallback;
}

async function writePrivate(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function physicalRegularFile(path) {
  const full = resolve(path);
  const named = lstatSync(full);
  if (!named.isFile() || named.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase()) {
    throw new Error('fixture-input-not-physical');
  }
  return { full, named };
}

async function hashPhysicalFile(path) {
  const { full, named } = physicalRegularFile(path);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(full)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  const after = lstatSync(full);
  if (after.dev !== named.dev || after.ino !== named.ino || after.size !== named.size || bytes !== named.size) {
    throw new Error('fixture-input-changed-while-hashing');
  }
  return { sha256: hash.digest('hex'), sizeBytes: bytes };
}

function parseCandidateContext(raw) {
  const context = JSON.parse(raw);
  const candidate = context?.candidate;
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate.digest ?? '') || !Array.isArray(candidate.files) ||
      candidate.files.length < 1 || candidate.files.length > MAX_CANDIDATE_FILES) {
    throw new Error('fixture-candidate-context-invalid');
  }
  const seen = new Set();
  const files = candidate.files.map(file => {
    if (typeof file?.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('fixture-candidate-entry-invalid');
    const normalized = file.path.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (normalized !== file.path || normalized.startsWith('/') || isAbsolute(file.path) ||
        segments.some(segment => !segment || segment === '.' || segment === '..') || seen.has(normalized)) {
      throw new Error('fixture-candidate-path-invalid');
    }
    seen.add(normalized);
    return { path: normalized, sha256: file.sha256 };
  });
  return { digest: candidate.digest, files };
}

async function captureCandidate(candidate) {
  const records = [];
  let totalBytes = 0;
  for (const expected of candidate.files) {
    const fullPath = resolve(sourceRoot, ...expected.path.split('/'));
    const within = relative(sourceRoot, fullPath);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('fixture-candidate-path-escaped');
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CANDIDATE_FILE_BYTES) throw new Error('fixture-candidate-file-invalid');
    totalBytes += stat.size;
    if (totalBytes > MAX_CANDIDATE_TOTAL_BYTES) throw new Error('fixture-candidate-total-bound');
    const actual = await hashPhysicalFile(fullPath);
    if (actual.sha256 !== expected.sha256) throw new Error('fixture-candidate-hash-mismatch');
    records.push({ path: expected.path, sha256: actual.sha256, sizeBytes: actual.sizeBytes });
  }
  return { digest: candidate.digest, fileCount: records.length, totalBytes, files: records };
}

function readRuntimeSummary(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const runtimeSlot = db.prepare(`SELECT state,instance_id AS instanceId,operation_id AS operationId
      FROM runtime_physical_slot WHERE singleton=1`).get();
    const recoverySlot = db.prepare(`SELECT state,operation_id AS operationId
      FROM runtime_recovery_slot WHERE singleton=1`).get();
    const runtimes = db.prepare(`SELECT i.id,i.product_id AS productId,i.version,i.artifact_digest AS artifactDigest,
        i.originating_actor_id AS originatingActorId,i.profile_digest AS profileDigest,i.config_digest AS configDigest,
        i.adapter_digest AS adapterDigest,i.toolchain_digest AS toolchainDigest,i.recipe_digest AS recipeDigest,
        i.state AS instanceState,i.current_attempt AS currentAttempt,a.id AS operationId,a.state AS attemptState,
        a.physical_state AS physicalState,a.empty_observed AS emptyObserved,a.helper_closed AS helperClosed,
        a.execution_clean AS executionClean,a.api_ready AS apiReady,a.worker_required AS workerRequired,
        a.worker_attached AS workerAttached,c.kind AS commandKind,c.state AS commandState,
        c.id AS commandId,sc.kind AS stopCommandKind,sc.state AS stopCommandState
      FROM runtime_instances i JOIN runtime_attempts a ON a.instance_id=i.id AND a.attempt_no=i.current_attempt
      JOIN runtime_commands c ON c.id=a.command_id
      LEFT JOIN runtime_commands sc ON sc.id=a.stop_command_id
      ORDER BY i.created DESC,i.id LIMIT 32`).all();
    const backupRows = db.prepare(`SELECT b.digest,b.instance_id AS instanceId,b.attempt_id AS attemptId,
        b.attempt_no AS attemptNo,b.command_id AS recoveryCommandId,ba.command_id AS runtimeCommandId,
        b.product_id AS productId,b.version,b.artifact_digest AS artifactDigest,b.originating_actor_id AS originatingActorId,
        b.profile_digest AS profileDigest,b.config_digest AS configDigest,b.adapter_digest AS adapterDigest,
        b.toolchain_digest AS toolchainDigest,b.recipe_digest AS recipeDigest,b.captured_at AS capturedAt,
        b.size_bytes AS sizeBytes,b.file_count AS fileCount,b.manifest_json AS manifestJson,b.entries_json AS entriesJson,
        o.state AS operationState,o.physical_state AS physicalState,o.driver_empty AS driverEmpty,
        o.driver_closed AS driverClosed,o.publisher_result_observed AS publisherResultObserved,
        o.publisher_closed AS publisherClosed,o.destination_published AS destinationPublished,
        o.destination_verified AS destinationVerified,o.staging_clean AS stagingClean
      FROM runtime_backups b JOIN runtime_attempts ba ON ba.id=b.attempt_id
      JOIN runtime_recovery_operations o ON o.command_id=b.command_id
      WHERE o.kind='BACKUP' ORDER BY b.created DESC LIMIT 32`).all();
    const initialCounts = {
      builds: Number(db.prepare('SELECT COUNT(*) AS count FROM builds').get().count),
      registeredArtifacts: Number(db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count),
      promotedReleases: Number(db.prepare('SELECT COUNT(*) AS count FROM artifact_releases').get().count),
      runtimes: Number(db.prepare('SELECT COUNT(*) AS count FROM runtime_instances').get().count),
      backups: Number(db.prepare('SELECT COUNT(*) AS count FROM runtime_backups').get().count),
      savedDefinitions: Number(db.prepare('SELECT COUNT(*) AS count FROM product_versions').get().count),
    };
    return {
      runtimeSlot: { state: runtimeSlot.state, occupied: runtimeSlot.operationId !== null, instanceId: runtimeSlot.instanceId },
      recoverySlot: { state: recoverySlot.state, occupied: recoverySlot.operationId !== null },
      runtimes,
      backups: backupRows,
      initialCounts,
    };
  } finally {
    db.close();
  }
}

function assertOwnedPhysicalTree(root) {
  const started = performance.now();
  const rootPath = resolve(root);
  const rootInfo = lstatSync(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(rootPath).toLowerCase() !== rootPath.toLowerCase()) {
    throw new Error('recovery-data-root-not-physical');
  }
  let entries = 0;
  let totalBytes = 0;
  const pending = [{ path: rootPath, depth: 0 }];
  const check = () => {
    if (performance.now() - started > MAX_SCAN_MS || entries > MAX_TREE_ENTRIES || totalBytes > MAX_TREE_BYTES) {
      throw new Error('recovery-data-scan-bound');
    }
  };
  while (pending.length) {
    check();
    const current = pending.pop();
    if (current.depth > MAX_TREE_DEPTH) throw new Error('recovery-data-depth-bound');
    const dir = opendirSync(current.path, { bufferSize: 32 });
    try {
      for (;;) {
        check();
        const entry = dir.readSync();
        if (!entry) break;
        entries++;
        const path = join(current.path, entry.name);
        const info = lstatSync(path);
        if (info.isSymbolicLink() || realpathSync(path).toLowerCase() !== path.toLowerCase()) throw new Error('recovery-data-linked-entry');
        if (info.isDirectory()) pending.push({ path, depth: current.depth + 1 });
        else if (info.isFile()) totalBytes += info.size;
        else throw new Error('recovery-data-special-entry');
      }
    } finally {
      dir.closeSync();
    }
  }
  check();
  return { entries, totalBytes };
}

function requirePhysicalDirectory(path) {
  const full = resolve(path);
  const info = lstatSync(full);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase()) {
    throw new Error('recovery-parent-not-physical');
  }
  return full;
}

function verifyCurrentBackupObject(runtime, backup) {
  const identity = {
    instanceId: backup.instanceId,
    attemptId: backup.attemptId,
    attempt: backup.attemptNo,
    commandId: backup.runtimeCommandId,
    productId: backup.productId,
    version: backup.version,
    artifactDigest: backup.artifactDigest,
    originatingActorId: backup.originatingActorId,
    profileDigest: backup.profileDigest,
    configDigest: backup.configDigest,
    adapterDigest: backup.adapterDigest,
    toolchainDigest: backup.toolchainDigest,
    recipeDigest: backup.recipeDigest,
  };
  const expectedCurrent = {
    instanceId: runtime.id,
    attemptId: runtime.operationId,
    attempt: runtime.currentAttempt,
    commandId: runtime.commandId,
    productId: runtime.productId,
    version: runtime.version,
    artifactDigest: runtime.artifactDigest,
    originatingActorId: runtime.originatingActorId,
    profileDigest: runtime.profileDigest,
    configDigest: runtime.configDigest,
    adapterDigest: runtime.adapterDigest,
    toolchainDigest: runtime.toolchainDigest,
    recipeDigest: runtime.recipeDigest,
  };
  for (const key of Object.keys(identity)) {
    if (identity[key] !== expectedCurrent[key]) throw new Error('backup-runtime-identity-mismatch');
  }
  if (typeof backup.manifestJson !== 'string' || typeof backup.entriesJson !== 'string' ||
      !Number.isSafeInteger(backup.sizeBytes) || !Number.isSafeInteger(backup.fileCount)) {
    throw new Error('backup-durable-metadata-invalid');
  }

  const artifactObject = join(privateRoot, '.local', 'platform-artifacts', 'objects', runtime.artifactDigest);
  const snapshot = readBoundedSnapshot(artifactObject, { snapshotDigest: runtime.artifactDigest }, artifactRegistryLimits);
  const selectedPlan = runtimePlanIdentity(snapshot, runtime.productId, runtime.version);
  if (!Array.isArray(selectedPlan?.plan?.modules) || selectedPlan.plan.modules.length > 256) {
    throw new Error('backup-selected-module-plan-invalid');
  }
  const modules = selectedPlan.plan.modules.map(module => {
    const entry = snapshot.entries.find(candidate => candidate.path === `modules/${module.id}/module.json`);
    if (!entry) throw new Error('backup-selected-module-schema-missing');
    const manifest = JSON.parse(entry.bytes.toString('utf8'));
    if (manifest.id !== module.id || !manifest.schema) throw new Error('backup-selected-module-schema-invalid');
    return { id: module.id, schema: manifest.schema };
  });

  const verified = verifyBackupObject(join(privateRoot, '.local', 'platform-runtime-backups'), backup.digest, identity, modules);
  if (canonicalJson(verified.manifest.identity) !== canonicalJson(identity) ||
      verified.manifest.capturedAt !== backup.capturedAt || verified.manifestJson !== backup.manifestJson ||
      canonicalJson([...verified.files.entries()].map(([path, bytes]) => ({
        path, digest: sourceSha(bytes), sizeBytes: bytes.length,
      }))) !== backup.entriesJson || verified.sizeBytes !== backup.sizeBytes || verified.fileCount !== backup.fileCount) {
    throw new Error('backup-object-differs-from-durable-metadata');
  }
  return { verified: true, digest: backup.digest, sizeBytes: verified.sizeBytes, fileCount: verified.fileCount };
}

async function removeExactPositivelyStoppedData(request, expectedDigest) {
  if (!request || Object.keys(request).sort().join(',') !== 'backupDigest,fixtureId,instanceId' || request.fixtureId !== fixtureId ||
      typeof request.instanceId !== 'string' || !/^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.instanceId) ||
      typeof request.backupDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.backupDigest)) {
    throw new Error('recovery-remove-request-invalid');
  }
  const databasePath = join(privateRoot, '.local', 'control-plane.sqlite');
  const summary = readRuntimeSummary(databasePath);
  if (summary.runtimeSlot.state !== 'EMPTY' || summary.runtimeSlot.occupied || summary.recoverySlot.state !== 'EMPTY' || summary.recoverySlot.occupied) {
    throw new Error('recovery-slots-not-empty');
  }
  const rows = summary.runtimes.filter(row => row.id === request.instanceId);
  if (rows.length !== 1) throw new Error('recovery-instance-not-unique');
  const row = rows[0];
  if (row.instanceState !== 'STOPPED' || row.attemptState !== 'STOPPED' || row.physicalState !== 'EMPTY' ||
      row.emptyObserved !== 1 || row.helperClosed !== 1 || row.executionClean !== 1 ||
      row.commandState !== 'SUCCEEDED' || !['START', 'RESTART'].includes(row.commandKind) ||
      row.stopCommandKind !== 'STOP' || row.stopCommandState !== 'SUCCEEDED') {
    throw new Error('recovery-positive-stop-proof-missing');
  }
  const backup = summary.backups.find(item => item.instanceId === row.id && item.attemptId === row.operationId &&
    item.attemptNo === row.currentAttempt && item.artifactDigest === row.artifactDigest &&
    item.operationState === 'SUCCEEDED' && item.physicalState === 'CLEAN' && item.driverEmpty === 1 && item.driverClosed === 1 &&
    item.publisherResultObserved === 1 && item.publisherClosed === 1 && item.destinationPublished === 1 &&
    item.destinationVerified === 1 && item.stagingClean === 1);
  if (!backup || backup.digest !== expectedDigest) throw new Error('recovery-verified-backup-proof-missing');

  const projectRoot = requirePhysicalDirectory(privateRoot);
  const localRoot = requirePhysicalDirectory(join(projectRoot, '.local'));
  const runtimeRoot = requirePhysicalDirectory(join(localRoot, 'platform-runtime-data'));
  const instanceRoot = requirePhysicalDirectory(join(runtimeRoot, row.id));
  const target = join(instanceRoot, row.artifactDigest);
  const within = relative(projectRoot, target);
  if (dirname(target).toLowerCase() !== instanceRoot.toLowerCase() || !within || within === '..' || within.startsWith(`..${sep}`) ||
      isAbsolute(within) || target.length >= 240) throw new Error('recovery-target-containment-invalid');
  const tree = assertOwnedPhysicalTree(target);
  const backupVerification = verifyCurrentBackupObject(row, backup);
  await rm(target, { recursive: true, force: false, maxRetries: 0 });
  if (existsSync(target)) throw new Error('recovery-target-remains');
  return {
    instanceId: row.id,
    operationId: row.operationId,
    attempt: row.currentAttempt,
    productId: row.productId,
    version: row.version,
    artifactDigest: row.artifactDigest,
    backupDigest: backup.digest,
    backupObjectReverified: backupVerification.verified,
    removed: true,
    scannedEntries: tree.entries,
    scannedBytes: tree.totalBytes,
    stopProof: { state: row.instanceState, physicalState: row.physicalState, emptyObserved: true, helperClosed: true, executionClean: true },
  };
}

async function stopOwnedServer() {
  if (closeFlight) return closeFlight;
  if (!server) return;
  const current = server;
  const flight = (async () => {
    stage = 'close-full-console';
    await current.close();
    server = undefined;
    clearInterval(controlTimer);
    process.stdin.pause();
    let candidateUnchanged = false;
    try {
      const after = await captureCandidate(coreCandidate);
      await writePrivate(paths.candidateAfterClose, after);
      candidateUnchanged = true;
    } catch {
      candidateUnchanged = false;
    }
    const summary = readRuntimeSummary(join(privateRoot, '.local', 'control-plane.sqlite'));
    await writePrivate(paths.closed, {
      schema: 'quadbridge.core-delivery-001-closed.v1', fixtureId, closed: true,
      originalOwnerCloseObserved: true, sourceCandidateDigest: coreCandidate.digest,
      sourceCandidateUnchanged: candidateUnchanged, runtimeSummary: summary,
      allCurrentRuntimesPositivelyStopped: summary.runtimes.length > 0 && summary.runtimeSlot.state === 'EMPTY' &&
        summary.recoverySlot.state === 'EMPTY' && summary.runtimes.every(row => row.instanceState === 'STOPPED' &&
          row.attemptState === 'STOPPED' && row.physicalState === 'EMPTY' && row.emptyObserved === 1 &&
          row.helperClosed === 1 && row.executionClean === 1),
    });
    process.stdout.write('CORE_DELIVERY_SERVER_CLOSED\n');
  })();
  closeFlight = flight;
  try {
    await flight;
  } catch (error) {
    closeFlight = undefined;
    await writePrivate(paths.failed, {
      schema: 'quadbridge.core-delivery-001-failure.v1', fixtureId, stage,
      code: safeErrorCode(error, 'OWNED_CLOSE_UNVERIFIED'),
    }).catch(() => {});
    process.stdout.write('CORE_DELIVERY_CLOSE_REQUIRES_RETRY\n');
  }
}

async function pollControls() {
  if (polling || !server) return;
  polling = true;
  try {
    if (existsSync(paths.removeRequest)) {
      let request;
      try {
        const raw = await readFile(paths.removeRequest, 'utf8');
        if (Buffer.byteLength(raw) > 4096) throw new Error('control-record-too-large');
        request = JSON.parse(raw);
      } catch {
        return;
      }
      await rm(paths.removeRequest, { force: true }).catch(() => {});
      try {
        const result = await removeExactPositivelyStoppedData(request, request.backupDigest);
        await writePrivate(paths.removeResult, {
          schema: 'quadbridge.core-delivery-001-remove-result.v1', fixtureId, ok: true, ...result,
        });
      } catch (error) {
        await writePrivate(paths.removeResult, {
          schema: 'quadbridge.core-delivery-001-remove-result.v1', fixtureId, ok: false,
          code: safeErrorCode(error, 'REMOVE_CONTROL_REJECTED'),
        }).catch(() => {});
      }
    }
    if (existsSync(paths.stop)) {
      let requested = '';
      try {
        requested = (await readFile(paths.stop, 'utf8')).trim();
      } catch {
        return;
      }
      if (requested === `STOP:${fixtureId}`) {
        await rm(paths.stop, { force: true }).catch(() => {});
        await stopOwnedServer();
      }
    }
  } finally {
    polling = false;
  }
}

try {
  stage = 'validate-candidate';
  const contextBytes = await readFile(contextPath);
  if (contextBytes.length > 4 * 1024 * 1024) throw new Error('fixture-candidate-context-too-large');
  const candidate = parseCandidateContext(contextBytes.toString('utf8'));
  coreCandidate = candidate;
  const candidateBefore = await captureCandidate(candidate);
  await writePrivate(paths.candidateBefore, candidateBefore);

  stage = 'validate-local-build-host';
  const hostSource = join(sourceRoot, '.local', 'platform-build-host.json');
  const hostBytes = await readFile(hostSource);
  if (hostBytes.length > 16 * 1024) throw new Error('fixture-build-host-record-invalid');
  const host = JSON.parse(hostBytes.toString('utf8'));
  if (host.schema !== 'quadbridge.local-build-host.v1' || host.kind !== 'powershell7-file-host' ||
      typeof host.path !== 'string' || !isAbsolute(host.path) || !/^[a-f0-9]{64}$/.test(host.sha256 ?? '') ||
      !/^7\./.test(host.version ?? '') || host.policy !== 'RemoteSigned') throw new Error('fixture-build-host-profile-unsupported');
  const hostExecutable = await hashPhysicalFile(host.path);
  if (hostExecutable.sha256 !== host.sha256) throw new Error('fixture-build-host-hash-mismatch');
  const declaredNode = (await readFile(join(sourceRoot, '.nvmrc'), 'utf8')).trim();
  const nodeParts = declaredNode.split('.').map(Number);
  const runningParts = process.versions.node.split('.').map(Number);
  if (nodeParts.length !== 3 || nodeParts.some(value => !Number.isInteger(value)) || runningParts[0] < nodeParts[0] ||
      (runningParts[0] === nodeParts[0] && (runningParts[1] < nodeParts[1] || (runningParts[1] === nodeParts[1] && runningParts[2] < nodeParts[2])))) {
    throw new Error('fixture-node-runtime-below-repository-minimum');
  }

  stage = 'copy-reviewed-source-and-toolchain';
  privateRoot = await mkdtemp(join(tmpdir(), 'qb-core-'));
  if (privateRoot.length >= 120) throw new Error('fixture-private-checkout-is-not-short');
  await mkdir(join(privateRoot, '.local'), { recursive: true });
  const { copyReviewedBuildInputs, copyPrivateToolchain } = await import(pathToFileURL(join(sourceRoot, 'apps/control-plane/dist/build-inputs.js')).href);
  await copyReviewedBuildInputs(sourceRoot, privateRoot);
  await copyPrivateToolchain(sourceRoot, privateRoot);
  await copyFile(hostSource, join(privateRoot, '.local', 'platform-build-host.json'));
  for (const tool of ['registry-publish.ps1', 'runtime-supervisor.mjs', 'runtime-recovery.mjs', 'runtime-recovery-publish.ps1']) {
    await copyFile(join(sourceRoot, 'tools', tool), join(privateRoot, 'tools', tool));
  }
  const copiedHost = await readFile(join(privateRoot, '.local', 'platform-build-host.json'));
  if (!copiedHost.equals(hostBytes)) throw new Error('fixture-build-host-profile-copy-mismatch');
  const prospectiveData = join(privateRoot, '.local', 'platform-runtime-data', `runtime-${randomUUID()}`, 'a'.repeat(64));
  if (prospectiveData.length >= 240) throw new Error('fixture-derived-runtime-path-exceeds-profile');

  stage = 'private-source-build';
  const build = spawnSync(process.execPath, [join(privateRoot, 'tools', 'build.mjs')], {
    cwd: privateRoot,
    windowsHide: true,
    encoding: 'buffer',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = Buffer.isBuffer(build.stdout) ? build.stdout : Buffer.from(build.stdout ?? '');
  const stderr = Buffer.isBuffer(build.stderr) ? build.stderr : Buffer.from(build.stderr ?? '');
  await writeFile(paths.buildLog, Buffer.concat([Buffer.from('--- stdout ---\n'), stdout, Buffer.from('\n--- stderr ---\n'), stderr]), { flag: 'wx', mode: 0o600 });
  if (build.error || build.status !== 0) {
    const code = build.error?.code ?? (build.signal ? `SIGNAL_${String(build.signal).toUpperCase()}` : `EXIT_${build.status ?? 'UNKNOWN'}`);
    const failureCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'PRIVATE_BUILD_FAILED';
    throw Object.assign(new Error('private-source-build-failed'), { code: failureCode, exitCode: build.status, signal: build.signal });
  }

  stage = 'verify-private-build-and-source';
  const { privateToolchainDigest, reviewedBuildFingerprint } = await import(pathToFileURL(join(privateRoot, 'apps/control-plane/dist/build-inputs.js')).href);
  const sourceFingerprint = reviewedBuildFingerprint(privateRoot);
  const toolchainDigest = await privateToolchainDigest(privateRoot);
  const candidateAfterBuild = await captureCandidate(candidate);
  const candidateUnchangedAfterBuild = candidateAfterBuild.digest === candidateBefore.digest &&
    candidateAfterBuild.fileCount === candidateBefore.fileCount &&
    candidateAfterBuild.files.every((entry, index) => entry.path === candidateBefore.files[index].path && entry.sha256 === candidateBefore.files[index].sha256);
  if (!candidateUnchangedAfterBuild) throw new Error('fixture-source-candidate-changed-during-build');

  stage = 'load-private-verifiers';
  const [recoveryTools, snapshotAccess, controlPlanePackage, runtimeManagerPackage, contractsPackage] = await Promise.all([
    import(pathToFileURL(join(privateRoot, 'tools', 'runtime-recovery.mjs')).href),
    import(pathToFileURL(join(privateRoot, 'packages', 'composition', 'dist', 'snapshot-access.js')).href),
    import(pathToFileURL(join(privateRoot, 'packages', 'control-plane', 'dist', 'index.js')).href),
    import(pathToFileURL(join(privateRoot, 'apps', 'control-plane', 'dist', 'runtime-manager.js')).href),
    import(pathToFileURL(join(privateRoot, 'packages', 'contracts', 'dist', 'index.js')).href),
  ]);
  verifyBackupObject = recoveryTools.verifyBackupObject;
  readBoundedSnapshot = snapshotAccess.readBoundedSnapshot;
  artifactRegistryLimits = controlPlanePackage.ARTIFACT_REGISTRY_LIMITS;
  runtimePlanIdentity = runtimeManagerPackage.runtimePlanIdentity;
  canonicalJson = contractsPackage.canonical;
  if (typeof verifyBackupObject !== 'function' || typeof readBoundedSnapshot !== 'function' ||
      typeof runtimePlanIdentity !== 'function' || typeof canonicalJson !== 'function' || !artifactRegistryLimits) {
    throw new Error('private-backup-verifier-exports-invalid');
  }

  stage = 'start-fresh-full-console';
  const { loadSourceSnapshot } = await import(pathToFileURL(join(privateRoot, 'apps/control-plane/dist/source-import.js')).href);
  const { startControlPlane } = await import(pathToFileURL(join(privateRoot, 'apps/control-plane/dist/main.js')).href);
  const sourceSnapshot = loadSourceSnapshot(privateRoot);
  const priorNodeEnv = process.env.NODE_ENV;
  const priorControlDb = process.env.QB_CONTROL_PLANE_DB;
  const priorStudioPort = process.env.QB_STUDIO_PORT;
  const oldLog = console.log;
  const oldWarn = console.warn;
  let started;
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.QB_CONTROL_PLANE_DB;
    process.env.QB_STUDIO_PORT = '0';
    console.log = () => {};
    console.warn = () => {};
    started = await startControlPlane({ root: privateRoot, port: 0 });
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    if (priorControlDb === undefined) delete process.env.QB_CONTROL_PLANE_DB; else process.env.QB_CONTROL_PLANE_DB = priorControlDb;
    if (priorStudioPort === undefined) delete process.env.QB_STUDIO_PORT; else process.env.QB_STUDIO_PORT = priorStudioPort;
    console.log = oldLog;
    console.warn = oldWarn;
  }
  server = started;
  if (!server?.pairingCode || typeof server.url !== 'string' || !server.url.startsWith('http://127.0.0.1:')) {
    throw new Error('fixture-full-console-local-bootstrap-invalid');
  }
  const initial = readRuntimeSummary(join(privateRoot, '.local', 'control-plane.sqlite'));
  if (initial.initialCounts.builds !== 0 || initial.initialCounts.registeredArtifacts !== 0 ||
      initial.initialCounts.promotedReleases !== 0 || initial.initialCounts.runtimes !== 0 || initial.initialCounts.backups !== 0 ||
      initial.runtimeSlot.state !== 'EMPTY' || initial.recoverySlot.state !== 'EMPTY') {
    throw new Error('fixture-console-was-not-fresh');
  }
  await writePrivate(paths.candidateAfterBuild, candidateAfterBuild);
  const privateMainPath = join(privateRoot, 'apps', 'studio-web', 'dist', 'main.js');
  const privateMain = await hashPhysicalFile(privateMainPath);
  await writePrivate(paths.ready, {
    schema: 'quadbridge.core-delivery-001-ready.v1',
    fixtureId,
    url: server.url,
    pairingCode: server.pairingCode,
    sourceCandidateDigest: candidate.digest,
    sourceCandidateFileCount: candidate.files.length,
    sourceFingerprint,
    toolchainDigest,
    runtimeSupervisorSha256: (await hashPhysicalFile(join(privateRoot, 'tools', 'runtime-supervisor.mjs'))).sha256,
    runtimeRecoverySha256: (await hashPhysicalFile(join(privateRoot, 'tools', 'runtime-recovery.mjs'))).sha256,
    runtimeRecoveryPublisherSha256: (await hashPhysicalFile(join(privateRoot, 'tools', 'runtime-recovery-publish.ps1'))).sha256,
    studioMainSha256: privateMain.sha256,
    selectedHost: { kind: host.kind, version: host.version, sha256: host.sha256, policy: host.policy },
    nodeVersion: process.version,
    sourceCatalogueFingerprint: sourceSnapshot.sourceFingerprint,
    freshSourceOnlyConsole: true,
    initialCounts: initial.initialCounts,
    controls: {
      ready: paths.ready,
      stop: paths.stop,
      removeRequest: paths.removeRequest,
      removeResult: paths.removeResult,
      closed: paths.closed,
      buildLog: paths.buildLog,
      candidateBefore: paths.candidateBefore,
      candidateAfterBuild: paths.candidateAfterBuild,
      candidateAfterClose: paths.candidateAfterClose,
    },
    owner: { projectRoot: privateRoot, databasePath: join(privateRoot, '.local', 'control-plane.sqlite') },
  });
  stage = 'serving';
  controlTimer = setInterval(() => { void pollControls().catch(() => {}); }, 250);
  process.stdin.resume();
  process.stdin.on('data', chunk => {
    if (chunk.toString('utf8').split(/\r?\n/).includes(`STOP:${fixtureId}`)) void stopOwnedServer();
  });
  process.stdout.write('CORE_DELIVERY_SERVER_READY\n');
} catch (error) {
  clearInterval(controlTimer);
  if (server) {
    // The app's original close path owns all runtime/recovery/build callbacks.
    // If it cannot prove closure, retain the private fixture and report only a code.
    try {
      await server.close();
      server = undefined;
    } catch {
      // Keep private owner material intact when close is uncertain.
    }
  }
  await writePrivate(paths.failed, {
    schema: 'quadbridge.core-delivery-001-failure.v1',
    fixtureId,
    stage,
    code: safeErrorCode(error, 'CORE_DELIVERY_FIXTURE_FAILED'),
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : undefined,
    signal: typeof error?.signal === 'string' ? error.signal : undefined,
  }).catch(() => {});
  process.stderr.write('Core-delivery fixture setup failed; its private state was retained.\n');
  process.exitCode = 1;
}
