// Read-only, fixture-bound evidence for CORE-DELIVERY-001. This observes only
// the exact ready fixture owner and one explicitly selected runtime/tenant.
// It never initializes, migrates, seeds, updates, or deletes owner data.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readyPath = join(here, 'live.ready.json');
const schema = 'quadbridge.core-delivery-001.domain-observation.v1';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const INSTANCE_ID = new RegExp(`^runtime-${UUID}$`, 'i');
const HASH = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--instance', '--tenant'].includes(key) || values.has(key) || !argv[i + 1]) fail('USAGE');
    values.set(key, argv[++i]);
  }
  const instanceId = values.get('--instance');
  const tenant = values.get('--tenant');
  if (!INSTANCE_ID.test(instanceId ?? '') || !/^[a-z][a-z0-9-]{0,62}$/.test(tenant ?? '')) fail('USAGE');
  return { instanceId, tenant };
}

function samePath(a, b) { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function physicalDirectory(path) {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(path), path)) return 'UNKNOWN';
    return 'PRESENT';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'NOT_PRESENT' : 'UNKNOWN';
  }
}

function physicalFile(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(realpathSync(path), path)) return 'UNKNOWN';
    return 'PRESENT';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'NOT_PRESENT' : 'UNKNOWN';
  }
}

function readPrivateJson(path) {
  if (physicalFile(path) !== 'PRESENT') return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return undefined; }
}

function openReadOnly(path) {
  const state = physicalFile(path);
  if (state !== 'PRESENT') return { state, db: undefined };
  try { return { state: 'PRESENT', db: new DatabaseSync(path, { readOnly: true, timeout: 1000 }) }; }
  catch { return { state: 'UNKNOWN', db: undefined }; }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ownerDatabase(path, expectedOwner) {
  const opened = openReadOnly(path);
  if (!opened.db) return { state: opened.state, reason: opened.state === 'UNKNOWN' ? 'READ_ONLY_OPEN_FAILED' : undefined };
  try {
    if (!hasTable(opened.db, '_owner')) return { state: 'UNKNOWN', reason: 'OWNER_MARKER_NOT_PRESENT' };
    const rows = opened.db.prepare('SELECT name FROM _owner').all();
    if (rows.length !== 1 || rows[0].name !== expectedOwner) return { state: 'UNKNOWN', reason: 'OWNER_IDENTITY_MISMATCH' };
    return { state: 'PRESENT', db: opened.db };
  } catch {
    opened.db.close();
    return { state: 'UNKNOWN', reason: 'READ_ONLY_SCHEMA_UNAVAILABLE' };
  }
}

function closeOwned(result) { try { result?.db?.close(); } catch { /* best-effort close after a read */ } }

function parsedObject(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024) return undefined;
  try {
    const result = JSON.parse(value);
    return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
  } catch { return undefined; }
}

function sourceReference(value) {
  const source = parsedObject(value);
  if (!source) return null;
  const result = {};
  for (const key of ['productId', 'instanceId', 'resourceType', 'resourceId'])
    if (typeof source[key] === 'string') result[key] = source[key];
  if (Number.isSafeInteger(source.version)) result.version = source.version;
  return result;
}

function destinationReference(value) {
  const destination = parsedObject(value);
  if (!destination) return null;
  const result = {};
  for (const key of ['productId', 'instanceId', 'tenantId'])
    if (typeof destination[key] === 'string') result[key] = destination[key];
  return result;
}

function targetReference(value) {
  const target = parsedObject(value);
  if (!target) return null;
  const result = {};
  for (const key of ['productId', 'instanceId', 'tenantId', 'resourceType', 'resourceId'])
    if (typeof target[key] === 'string') result[key] = target[key];
  if (Number.isSafeInteger(target.version)) result.version = target.version;
  return result;
}

function receiptReference(value) {
  const receipt = parsedObject(value);
  if (!receipt) return null;
  const result = {};
  for (const key of ['schema', 'contract', 'outcome', 'commandId'])
    if (typeof receipt[key] === 'string') result[key] = receipt[key];
  if (receipt.actor && typeof receipt.actor === 'object') {
    const actor = {};
    if (typeof receipt.actor.kind === 'string') actor.kind = receipt.actor.kind;
    if (typeof receipt.actor.id === 'string') actor.id = receipt.actor.id;
    result.actor = actor;
  }
  result.destination = destinationReference(JSON.stringify(receipt.destination));
  if (receipt.resource && typeof receipt.resource === 'object') {
    const resource = {};
    for (const key of ['type', 'id']) if (typeof receipt.resource[key] === 'string') resource[key] = receipt.resource[key];
    if (Number.isSafeInteger(receipt.resource.version)) resource.version = receipt.resource.version;
    result.resource = resource;
  }
  return result;
}

function runtimeFromControlPlane(db, instanceId) {
  const rows = db.prepare(`SELECT i.id,i.product_id AS productId,i.version,i.artifact_digest AS artifactDigest,
      i.profile_digest AS profileDigest,i.config_digest AS configDigest,i.adapter_digest AS adapterDigest,
      i.toolchain_digest AS toolchainDigest,i.recipe_digest AS recipeDigest,i.state AS instanceState,
      i.worker_required AS workerRequired,i.preparation_complete AS preparationComplete,i.current_attempt AS currentAttempt,
      a.id AS attemptId,a.attempt_no AS attemptNo,a.command_id AS commandId,a.state AS attemptState,
      a.physical_state AS physicalState,a.empty_observed AS emptyObserved,a.helper_closed AS helperClosed,
      a.execution_clean AS executionClean,a.api_ready AS apiReady,a.worker_attached AS workerAttached,
      c.kind AS commandKind,c.state AS commandState,sc.kind AS stopCommandKind,sc.state AS stopCommandState
    FROM runtime_instances i
    LEFT JOIN runtime_attempts a ON a.instance_id=i.id AND a.attempt_no=i.current_attempt
    LEFT JOIN runtime_commands c ON c.id=a.command_id
    LEFT JOIN runtime_commands sc ON sc.id=a.stop_command_id
    WHERE i.id=?`).all(instanceId);
  if (rows.length === 0) return { state: 'NOT_PRESENT' };
  if (rows.length !== 1) return { state: 'UNKNOWN', reason: 'RUNTIME_ID_NOT_UNIQUE' };
  const row = rows[0];
  if (!HASH.test(row.artifactDigest ?? '') || typeof row.productId !== 'string' || typeof row.version !== 'string')
    return { state: 'UNKNOWN', reason: 'RUNTIME_IDENTITY_MALFORMED' };
  return {
    state: 'PRESENT',
    identity: {
      instanceId: row.id, productId: row.productId, version: row.version, artifactDigest: row.artifactDigest,
      profileDigest: row.profileDigest, configDigest: row.configDigest, adapterDigest: row.adapterDigest,
      toolchainDigest: row.toolchainDigest, recipeDigest: row.recipeDigest,
    },
    lifecycle: {
      instanceState: row.instanceState, currentAttempt: row.currentAttempt,
      attempt: row.attemptId ? {
        id: row.attemptId, number: row.attemptNo, commandId: row.commandId, commandKind: row.commandKind,
        commandState: row.commandState, state: row.attemptState, physicalState: row.physicalState,
        emptyObserved: row.emptyObserved === 1, helperClosed: row.helperClosed === 1,
        executionClean: row.executionClean === 1, apiReady: row.apiReady === 1,
        workerRequired: row.workerRequired === 1, workerAttached: row.workerAttached === 1,
        stopCommandKind: row.stopCommandKind ?? null, stopCommandState: row.stopCommandState ?? null,
      } : { state: 'NOT_PRESENT' },
      preparationComplete: row.preparationComplete === 1,
    },
  };
}

function exactArtifactRegistration(db, identity) {
  if (!hasTable(db, 'artifacts') || !hasTable(db, 'artifact_releases')) return { state: 'UNKNOWN', reason: 'ARTIFACT_SCHEMA_UNAVAILABLE' };
  const row = db.prepare(`SELECT digest,build_id AS buildId,snapshot_id AS snapshotId,product_id AS productId,
      version,snapshot_digest AS snapshotDigest FROM artifacts WHERE digest=?`).get(identity.artifactDigest);
  const release = db.prepare(`SELECT product_id AS productId,version,artifact_digest AS artifactDigest,build_id AS buildId
    FROM artifact_releases WHERE product_id=? AND version=?`).get(identity.productId, identity.version);
  if (!row) return { state: 'NOT_PRESENT', promotedRelease: { state: release ? 'UNKNOWN' : 'NOT_PRESENT' } };
  const artifactMatches = row.productId === identity.productId && row.version === identity.version &&
    row.snapshotDigest === identity.artifactDigest;
  const releaseMatches = Boolean(release && release.productId === identity.productId && release.version === identity.version &&
    release.artifactDigest === identity.artifactDigest && release.buildId === row.buildId);
  return {
    state: artifactMatches ? 'PRESENT' : 'UNKNOWN', identityMatches: artifactMatches,
    artifactDigest: row.digest, buildId: row.buildId, snapshotId: row.snapshotId,
    productId: row.productId, version: row.version, snapshotDigest: row.snapshotDigest,
    promotedRelease: { state: !release ? 'NOT_PRESENT' : releaseMatches ? 'PRESENT' : 'UNKNOWN',
      ...(release ? { productId: release.productId, version: release.version, artifactDigest: release.artifactDigest, buildId: release.buildId } : {}) },
  };
}

function findCreateCommand(db, tenant, handoffId) {
  if (!hasTable(db, '_receipts')) return { state: 'NOT_PRESENT' };
  const rows = db.prepare(`SELECT command_id AS commandId FROM _receipts
    WHERE tenant=? AND operation='handoff.create' AND json_extract(result,'$.id')=? ORDER BY created DESC LIMIT 2`).all(tenant, handoffId);
  if (rows.length === 1) return { state: 'PRESENT', commandId: rows[0].commandId };
  return { state: rows.length ? 'UNKNOWN' : 'NOT_PRESENT' };
}

function destinationReceipt(owner, tenant, commandId, handoffReceipt) {
  if (owner.state !== 'PRESENT') return { state: owner.state };
  const db = owner.db;
  if (!commandId || !hasTable(db, '_receipts')) return { state: 'NOT_PRESENT' };
  const rows = db.prepare(`SELECT result FROM _receipts
    WHERE tenant=? AND operation='desk.create.v2' AND command_id=? ORDER BY created LIMIT 2`).all(tenant, commandId);
  if (rows.length !== 1) return { state: rows.length ? 'UNKNOWN' : 'NOT_PRESENT' };
  const stored = receiptReference(rows[0].result);
  const linked = receiptReference(handoffReceipt);
  if (!stored || !linked) return { state: 'UNKNOWN' };
  if (stored.commandId !== commandId || stored.contract !== 'desk.requests.create.v2' ||
      stored.outcome !== 'COMMITTED' || stored.resource?.type !== 'desk.request' || !stored.destination?.instanceId ||
      !stored.resource?.id || !Number.isSafeInteger(stored.resource?.version)) return { state: 'UNKNOWN' };
  return { state: JSON.stringify(stored) === JSON.stringify(linked) ? 'PRESENT' : 'UNKNOWN', receipt: stored };
}

function deskObservation(opened, tenant, targetId) {
  if (opened.state !== 'PRESENT') return { database: opened.state, requests: { state: opened.state, rows: [] } };
  const db = opened.db;
  try {
    if (!hasTable(db, 'requests')) return { database: 'PRESENT', requests: { state: 'NOT_PRESENT', rows: [] } };
    if (targetId && !hasTable(db, '_owner')) return { database: 'PRESENT', requests: { state: 'UNKNOWN', rows: [] } };
    const rows = targetId
      ? db.prepare('SELECT id,tenant,title,state,version,source,created FROM requests WHERE tenant=? AND id=?').all(tenant, targetId)
      : db.prepare('SELECT id,tenant,title,state,version,source,created FROM requests WHERE tenant=? ORDER BY created,id LIMIT 100').all(tenant);
    return {
      database: 'PRESENT',
      requests: { state: rows.length ? 'PRESENT' : 'NOT_PRESENT', rows: rows.map(row => ({
        id: row.id, tenant: row.tenant, title: row.title, state: row.state, version: row.version,
        source: sourceReference(row.source), created: row.created,
      })) },
    };
  } catch {
    return { database: 'PRESENT', requests: { state: 'UNKNOWN', reason: 'READ_ONLY_QUERY_FAILED', rows: [] } };
  }
}

function observeServiceDesk(opened, tenant, targetId) {
  if (opened.state !== 'PRESENT') return { database: opened.state, reason: opened.reason, requests: { state: opened.state, rows: [] } };
  return deskObservation(opened, tenant, targetId);
}

function observeKnowledge(path, tenant) {
  const opened = ownerDatabase(path, 'knowledge');
  try {
    if (opened.state !== 'PRESENT') return { database: opened.state, reason: opened.reason, documents: { state: opened.state, rows: [] } };
    const db = opened.db;
    if (!hasTable(db, 'documents')) return { database: 'PRESENT', documents: { state: 'NOT_PRESENT', rows: [] } };
    const hasJobs = hasTable(db, '_jobs');
    const documents = db.prepare(`SELECT id,tenant,title,version,state,job_id AS jobId,created
      FROM documents WHERE tenant=? ORDER BY created,id LIMIT 100`).all(tenant);
    const rows = documents.map(document => {
      const job = hasJobs ? db.prepare(`SELECT id,kind,state,attempt FROM _jobs WHERE id=? AND tenant=?`).get(document.jobId, tenant) : undefined;
      return {
        id: document.id, tenant: document.tenant, title: document.title, version: document.version,
        state: document.state, created: document.created,
        indexJob: job ? { id: job.id, kind: job.kind, state: job.state, attempt: job.attempt } : { state: 'NOT_PRESENT' },
      };
    });
    return {
      database: 'PRESENT', documents: { state: rows.length ? 'PRESENT' : 'NOT_PRESENT', rows },
      technicalJobs: {
        state: rows.some(row => row.indexJob.id) ? 'PRESENT' : 'NOT_PRESENT',
        table: hasJobs ? 'PRESENT' : 'NOT_PRESENT', jobs: rows.map(row => row.indexJob),
      },
    };
  } catch {
    return { database: 'PRESENT', documents: { state: 'UNKNOWN', reason: 'READ_ONLY_QUERY_FAILED', rows: [] }, technicalJobs: { state: 'UNKNOWN', jobs: [] } };
  } finally { closeOwned(opened); }
}

function observeHandoffs(path, deskOwner, tenant, identity) {
  const opened = ownerDatabase(path, 'handoff');
  try {
    if (opened.state !== 'PRESENT') return { database: opened.state, reason: opened.reason, records: { state: opened.state, rows: [] } };
    const db = opened.db;
    if (!hasTable(db, 'handoffs')) return { database: 'PRESENT', records: { state: 'NOT_PRESENT', rows: [] } };
    const hasDelivery = hasTable(db, 'handoff_delivery');
    const hasJobs = hasTable(db, '_jobs');
    const handoffs = db.prepare(`SELECT id,tenant,document_id AS documentId,document_version AS documentVersion,
      title,binding_revision AS bindingRevision,state,job_id AS jobId,protocol_version AS protocolVersion,
      target_ref AS targetRef,created FROM handoffs WHERE tenant=? ORDER BY created,id LIMIT 100`).all(tenant);
    const rows = handoffs.map(row => {
      const delivery = hasDelivery ? db.prepare(`SELECT command_id AS commandId,destination,binding_key AS bindingKey,
        state,receipt FROM handoff_delivery WHERE tenant=? AND handoff_id=?`).get(tenant, row.id) : undefined;
      const job = hasJobs ? db.prepare('SELECT id,kind,state,attempt FROM _jobs WHERE id=? AND tenant=?').get(row.jobId, tenant) : undefined;
      const receipt = receiptReference(delivery?.receipt);
      const destination = destinationReference(delivery?.destination);
      const targetId = receipt?.resource?.id;
      const targetMatchesRuntime = destination?.productId === identity.productId &&
        destination?.instanceId === identity.instanceId && destination?.tenantId === tenant;
      const receiptFromDesk = targetMatchesRuntime
        ? destinationReceipt(deskOwner, tenant, delivery?.commandId, delivery?.receipt)
        : { state: delivery?.commandId ? 'UNKNOWN' : 'NOT_PRESENT' };
      const target = targetMatchesRuntime && targetId
        ? deskObservation(deskOwner, tenant, targetId).requests
        : { state: targetId ? 'UNKNOWN' : 'NOT_PRESENT', rows: [] };
      const sourceCommand = findCreateCommand(db, tenant, row.id);
      const linkedTargetReference = targetReference(row.targetRef);
      const targetRow = target.rows.length === 1 ? target.rows[0] : undefined;
      const targetSource = targetRow?.source;
      const targetSourceMatchesDocument = target.state !== 'PRESENT' ? target.state : Boolean(targetSource &&
        targetSource.productId === identity.productId && targetSource.instanceId === identity.instanceId &&
        targetSource.resourceType === 'knowledge.document' && targetSource.resourceId === row.documentId &&
        targetSource.version === row.documentVersion);
      const targetReferenceMatchesReceipt = linkedTargetReference && receipt
        ? linkedTargetReference.productId === receipt.destination?.productId &&
          linkedTargetReference.instanceId === receipt.destination?.instanceId &&
          linkedTargetReference.tenantId === receipt.destination?.tenantId &&
          linkedTargetReference.resourceType === receipt.resource?.type &&
          linkedTargetReference.resourceId === receipt.resource?.id &&
          linkedTargetReference.version === receipt.resource?.version
        : linkedTargetReference || receipt ? false : 'NOT_PRESENT';
      return {
        id: row.id, tenant: row.tenant, documentId: row.documentId, documentVersion: row.documentVersion,
        title: row.title, bindingRevision: row.bindingRevision, state: row.state,
        protocolVersion: row.protocolVersion, job: job ? { id: job.id, kind: job.kind, state: job.state, attempt: job.attempt } : { state: 'NOT_PRESENT' },
        originalCommand: sourceCommand,
        relationship: {
          sourceDocument: { id: row.documentId, version: row.documentVersion, title: row.title },
          destination: destination ?? { state: 'NOT_PRESENT' }, bindingKey: delivery?.bindingKey ?? null,
          deliveryCommandId: delivery?.commandId ?? null, deliveryState: delivery?.state ?? 'NOT_PRESENT',
          destinationMatchesRuntime: targetMatchesRuntime, linkedTargetReference,
          targetReferenceMatchesReceipt, targetSourceMatchesDocument,
        },
        destinationReceipt: receiptFromDesk,
        linkedTarget: target,
      };
    });
    return {
      database: 'PRESENT', records: { state: rows.length ? 'PRESENT' : 'NOT_PRESENT', rows },
      technicalJobs: {
        state: rows.some(row => row.job.id) ? 'PRESENT' : 'NOT_PRESENT',
        table: hasJobs ? 'PRESENT' : 'NOT_PRESENT', jobs: rows.map(row => row.job),
      },
    };
  } catch {
    return { database: 'PRESENT', records: { state: 'UNKNOWN', reason: 'READ_ONLY_QUERY_FAILED', rows: [] }, technicalJobs: { state: 'UNKNOWN', jobs: [] } };
  } finally { closeOwned(opened); }
}

function credentialsHash(path) {
  const state = physicalFile(path);
  if (state !== 'PRESENT') return { state, ...(state === 'UNKNOWN' ? { reason: 'PRIVATE_FILE_UNAVAILABLE' } : {}) };
  try {
    const bytes = readFileSync(path);
    return { state: 'PRESENT', sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return { state: 'UNKNOWN', reason: 'PRIVATE_FILE_UNAVAILABLE' }; }
}

function loadReadyFixture() {
  if (physicalDirectory(here) !== 'PRESENT' || physicalFile(readyPath) !== 'PRESENT') fail('READY_FIXTURE_NOT_PRESENT');
  const ready = readPrivateJson(readyPath);
  if (!ready || ready.schema !== 'quadbridge.core-delivery-001-ready.v1' ||
      typeof ready.fixtureId !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(ready.fixtureId) ||
      !ready.owner || typeof ready.owner.projectRoot !== 'string' || typeof ready.owner.databasePath !== 'string') fail('READY_FIXTURE_INVALID');
  const projectRoot = resolve(ready.owner.projectRoot);
  const controlPlanePath = resolve(ready.owner.databasePath);
  const tempRoot = resolve(tmpdir());
  if (!basename(projectRoot).startsWith('qb-core-') || !within(tempRoot, projectRoot) ||
      !samePath(controlPlanePath, join(projectRoot, '.local', 'control-plane.sqlite')) ||
      physicalDirectory(projectRoot) !== 'PRESENT' || physicalDirectory(join(projectRoot, '.local')) !== 'PRESENT' ||
      physicalFile(controlPlanePath) !== 'PRESENT') fail('READY_OWNER_IDENTITY_INVALID');
  return { fixtureId: ready.fixtureId, projectRoot, controlPlanePath };
}

function observe(args) {
  const fixture = loadReadyFixture();
  const control = openReadOnly(fixture.controlPlanePath);
  if (!control.db) return {
    schema, observationOnly: true, fixtureId: fixture.fixtureId, state: control.state,
    reason: control.state === 'UNKNOWN' ? 'CONTROL_PLANE_READ_ONLY_OPEN_FAILED' : 'CONTROL_PLANE_NOT_PRESENT',
  };
  try {
    const runtime = runtimeFromControlPlane(control.db, args.instanceId);
    if (runtime.state !== 'PRESENT') return {
      schema, observationOnly: true, fixtureId: fixture.fixtureId, tenant: args.tenant,
      runtime: { state: runtime.state, ...(runtime.reason ? { reason: runtime.reason } : {}) },
      serviceDesk: { database: 'UNKNOWN', reason: 'EXACT_RUNTIME_IDENTITY_UNAVAILABLE', requests: { state: 'UNKNOWN', rows: [] } },
      knowledge: { database: 'UNKNOWN', reason: 'EXACT_RUNTIME_IDENTITY_UNAVAILABLE', documents: { state: 'UNKNOWN', rows: [] } },
      handoff: { database: 'UNKNOWN', reason: 'EXACT_RUNTIME_IDENTITY_UNAVAILABLE', records: { state: 'UNKNOWN', rows: [] } },
    };
    const identity = runtime.identity;
    const release = exactArtifactRegistration(control.db, identity);
    const dataDirectory = join(fixture.projectRoot, '.local', 'platform-runtime-data', identity.instanceId, identity.artifactDigest);
    const dataRootState = physicalDirectory(dataDirectory);
    const ownerRootBound = within(fixture.projectRoot, dataDirectory) &&
      samePath(dirname(dataDirectory), join(fixture.projectRoot, '.local', 'platform-runtime-data', identity.instanceId));
    const markerPath = join(dataDirectory, 'enrollment-complete.json');
    const markerFileState = dataRootState === 'PRESENT' && ownerRootBound ? physicalFile(markerPath) : dataRootState;
    const marker = markerFileState === 'PRESENT' ? readPrivateJson(markerPath) : undefined;
    const enrollmentMatches = Boolean(marker && marker.schema === 'quadbridge.managed-runtime-enrollment.v1' &&
      marker.state === 'COMPLETE' && marker.instanceId === identity.instanceId && marker.productId === identity.productId &&
      marker.version === identity.version && marker.artifactDigest === identity.artifactDigest &&
      marker.profileDigest === identity.profileDigest && marker.configDigest === identity.configDigest &&
      marker.adapterDigest === identity.adapterDigest);
    const enrollment = dataRootState !== 'PRESENT' ? { state: dataRootState } : marker
      ? { state: enrollmentMatches ? 'PRESENT' : 'UNKNOWN', identityMatches: enrollmentMatches }
      : { state: markerFileState === 'UNKNOWN' ? 'UNKNOWN' : 'NOT_PRESENT' };
    const modulesDirectory = join(dataDirectory, 'modules');
    const modulesState = dataRootState === 'PRESENT' && ownerRootBound ? physicalDirectory(modulesDirectory) : dataRootState;
    const canReadOwners = release.state === 'PRESENT' && release.identityMatches && release.promotedRelease?.state === 'PRESENT' &&
      enrollment.identityMatches === true && modulesState === 'PRESENT';
    const blockedOwnerState = dataRootState === 'NOT_PRESENT' || modulesState === 'NOT_PRESENT' ? 'NOT_PRESENT' : 'UNKNOWN';
    const blockedOwnerReason = release.state !== 'PRESENT' || !release.identityMatches || release.promotedRelease?.state !== 'PRESENT'
      ? 'PROMOTED_ARTIFACT_IDENTITY_UNAVAILABLE'
      : enrollment.state !== 'PRESENT' ? 'ENROLLMENT_IDENTITY_UNAVAILABLE'
      : modulesState !== 'PRESENT' ? 'MODULE_OWNER_ROOT_UNAVAILABLE' : undefined;
    const databasePath = module => join(modulesDirectory, `${module}.sqlite`);
    const deskOwner = canReadOwners ? ownerDatabase(databasePath('service-desk'), 'service-desk')
      : { state: blockedOwnerState, reason: blockedOwnerReason };
    const serviceDesk = canReadOwners ? observeServiceDesk(deskOwner, args.tenant)
      : { database: blockedOwnerState, reason: blockedOwnerReason, requests: { state: blockedOwnerState, rows: [] } };
    let knowledge;
    let handoff;
    try {
      knowledge = canReadOwners ? observeKnowledge(databasePath('knowledge'), args.tenant)
        : { database: blockedOwnerState, reason: blockedOwnerReason, documents: { state: blockedOwnerState, rows: [] } };
      handoff = canReadOwners ? observeHandoffs(databasePath('handoff'), deskOwner, args.tenant, identity)
        : { database: blockedOwnerState, reason: blockedOwnerReason, records: { state: blockedOwnerState, rows: [] } };
    } finally { closeOwned(deskOwner); }
    const credentials = dataRootState === 'PRESENT' && ownerRootBound
      ? credentialsHash(join(dataDirectory, 'credentials.json')) : { state: dataRootState };
    const accessDatabase = dataRootState === 'PRESENT' && ownerRootBound
      ? physicalFile(join(dataDirectory, 'access.sqlite')) : dataRootState;
    return {
      schema, observationOnly: true, fixtureId: fixture.fixtureId, tenant: args.tenant,
      fixtureOwner: { state: 'PRESENT', exactPrivateRootBound: true, controlPlaneDatabase: 'PRESENT' },
      runtime: { state: 'PRESENT', identity, lifecycle: runtime.lifecycle, promotedArtifact: release },
      ownerData: {
        state: ownerRootBound ? dataRootState : 'UNKNOWN', exactInstanceArtifactPathBound: ownerRootBound,
        enrollment, accessDatabase, credentials,
      },
      serviceDesk, knowledge, handoff,
    };
  } finally { closeOwned(control); }
}

try {
  const result = observe(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.state === 'UNKNOWN') process.exitCode = 2;
} catch (error) {
  const code = ['USAGE', 'READY_FIXTURE_NOT_PRESENT', 'READY_FIXTURE_INVALID', 'READY_OWNER_IDENTITY_INVALID'].includes(error?.code)
    ? error.code : 'OBSERVATION_UNKNOWN';
  process.stdout.write(`${JSON.stringify({ schema, observationOnly: true, state: 'UNKNOWN', reason: code,
    usage: 'node .local/core-delivery-001/observe-domain.mjs --instance runtime-<uuid> --tenant customer-a' }, null, 2)}\n`);
  process.exitCode = 2;
}
