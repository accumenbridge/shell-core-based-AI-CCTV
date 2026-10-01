import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlatformError, canonical, type CompositionPlan, type ProductDefinition } from '@quadbridge/contracts';
import { planAiPipeline, type AiPipeline } from '@quadbridge/ai-core';

export type BuildState = 'QUEUED' | 'RUNNING' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
export type BuildCleanupState = 'NOT_STARTED' | 'PENDING' | 'CLEAN' | 'UNKNOWN';
export interface FrozenBuildInput {
  product: ProductDefinition;
  plan: CompositionPlan;
  sourceFingerprint: string;
  toolchainDigest: string;
  recipeVersion: string;
}
export interface BuildClaim {
  id: string;
  productId: string;
  version: string;
  actorId: string;
  claimToken: string;
  ownerId: string;
  attempt: number;
  leaseUntil: number;
  workspaceRef: string;
  input: FrozenBuildInput;
  productDigest: string;
  planDigest: string;
  inputDigest: string;
}
export type DeploymentState = 'REQUESTED' | 'DEPLOYING' | 'HEALTHY' | 'FAILED' | 'ROLLED_BACK';
export interface EnvironmentSpec {
  id: string;
  label: string;
  kind: 'development' | 'test' | 'staging' | 'production';
  target: 'local' | 'edge' | 'cloud' | 'hybrid';
  region?: string;
}

export interface ArtifactEntryRecord {
  id: string;
  path: string;
  digest: string;
  sizeBytes: number;
}

export interface VerifiedArtifactRecord {
  digest: string;
  buildId: string;
  productId: string;
  version: string;
  inputDigest: string;
  releaseDigest: string;
  snapshotDigest: string;
  sizeBytes: number;
  fileCount: number;
  originatingActorId: string;
  registeringActorId: string;
  registeredAt: number;
  manifest: string;
  entries: string;
}

export interface ArtifactPublicationIntent {
  operationId: string;
  ownerToken: string;
  buildId: string;
  artifactDigest: string;
  snapshotId: string;
  originatingActorId: string;
  productId: string;
  version: string;
  inputDigest: string;
  releaseDigest: string;
  sizeBytes: number;
  fileCount: number;
  stagingOverheadBytes: number;
  observedRegistryBytes: number;
  observedObjectDirectories: number;
  hostIdentity: string;
  publisherDigest: string;
  registeringActorId: string;
}

export interface ArtifactCapacityObservation {
  registryBytes: number;
  objectDirectories: number;
  stagingBytes: number;
}

export interface ArtifactBuildIdentity {
  buildId: string;
  snapshotId: string;
  productId: string;
  version: string;
  inputDigest: string;
  releaseDigest: string;
  snapshotDigest: string;
  sourceFingerprint: string;
  toolchainDigest: string;
  recipeVersion: string;
  originatingActorId: string;
}

export type ManagedRuntimeState = 'PREPARING'|'STARTING'|'RUNNING'|'STOP_REQUESTED'|'STOPPED'|'PREPARATION_FAILED'|'UNKNOWN'|'REPAIR_REQUIRED';
export type ManagedRuntimeCommandKind = 'START'|'STOP'|'RESTART';
export interface ManagedRuntimeStartIntent {
  instanceId: string;
  operationId: string;
  ownerId: string;
  ownerToken: string;
  actorId: string;
  originatingActorId: string;
  requestKey: string;
  productId: string;
  version: string;
  artifactDigest: string;
  profileDigest: string;
  configDigest: string;
  adapterDigest: string;
  toolchainDigest: string;
  recipeDigest: string;
  workerRequired: boolean;
  preparationComplete?: boolean;
  executionBytes: number;
}
export interface ManagedRuntimeCommandResult {
  command: Record<string,unknown>;
  instance: Record<string,unknown>;
  operationId: string|null;
  ownerToken: string|null;
  reused: boolean;
}

export type ManagedRuntimeRecoveryKind = 'BACKUP'|'RESTORE';
export type ManagedRuntimeRecoveryState = 'PREPARING'|'RUNNING'|'SUCCEEDED'|'FAILED'|'UNKNOWN';
export interface ManagedRuntimeRecoveryIdentity {
  instanceId: string;
  attemptId: string;
  attempt: number;
  commandId: string;
  productId: string;
  version: string;
  artifactDigest: string;
  originatingActorId: string;
  profileDigest: string;
  configDigest: string;
  adapterDigest: string;
  toolchainDigest: string;
  recipeDigest: string;
}
export interface ManagedRuntimeRecoveryIntent extends ManagedRuntimeRecoveryIdentity {
  operationId: string;
  ownerId: string;
  ownerToken: string;
  actorId: string;
  requestKey: string;
  kind: ManagedRuntimeRecoveryKind;
  backupDigest?: string;
  reservedBytes: number;
}
export interface ManagedRuntimeRecoveryCapacityObservation {
  backupBytes: number;
  stagingBytes: number;
  objectCount: number;
  entryCount: number;
}
export interface ManagedRuntimeRecoveryResult {
  operation: Record<string, unknown>;
  operationId: string;
  ownerToken: string | null;
  reused: boolean;
}

export const MANAGED_RUNTIME_LIMITS = Object.freeze({
  maxInstances: 16,
  maxExecutionBytes: 128 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxLogBytes: 1024 * 1024,
  maxRecentEvents: 200,
  maxRequestKeyChars: 128,
  maxMetadataEntries: 16384,
  maxMetadataScanMs: 2000,
  maxDirectoryDepth: 32,
  maxPathChars: 240
});
export const MANAGED_RUNTIME_RECOVERY_LIMITS = Object.freeze({
  maxDatabaseBytes: 32 * 1024 * 1024,
  maxBackupBytes: 128 * 1024 * 1024,
  maxFiles: 64,
  maxManifestBytes: 1024 * 1024,
  maxStagingBytes: 192 * 1024 * 1024,
  maxObjects: 32,
  maxTotalBytes: 512 * 1024 * 1024
});
const managedRuntimeIdPattern = /^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ARTIFACT_REGISTRY_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxFiles: 4096,
  maxManifestBytes: 2 * 1024 * 1024,
  maxStagingBytes: 128 * 1024 * 1024,
  maxRegistryBytes: 512 * 1024 * 1024,
  maxObjectDirectories: 256,
  maxMetadataEntries: 16384,
  maxMetadataScanMs: 2000,
  maxDirectoryDepth: 32
});

const fail = (message: string): never => { throw new PlatformError('INVALID', message); };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = [], label = 'input'): Record<string, unknown> {
  if (!isRecord(value)) throw new PlatformError('INVALID', `Invalid ${label}`);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) throw new PlatformError('INVALID', `Invalid ${label} fields`);
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new PlatformError('INVALID', `Invalid ${label}`);
  return value.trim();
}
function validateProduct(definition: ProductDefinition): ProductDefinition {
  const d = exactObject(definition, ['id', 'version', 'platformAbi', 'title', 'description', 'layout', 'modules', 'bindings'], ['wiring'], 'product definition');
  if (typeof d.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(d.id)) fail('Invalid product id');
  if (typeof d.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(d.version)) fail('Invalid product version');
  if (d.platformAbi !== 'quadbridge.module.v1') fail('Invalid product ABI');
  boundedText(d.title, 'product title', 120);
  if (typeof d.description !== 'string' || d.description.length > 2000 || d.description.includes('\0')) fail('Invalid product description');
  if (typeof d.layout !== 'string' || !['sidebar', 'top'].includes(d.layout)) fail('Invalid product layout');
  if (d.wiring !== undefined && (typeof d.wiring !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(d.wiring))) fail('Invalid product wiring');
  if (!Array.isArray(d.modules) || d.modules.length > 256 || !Array.isArray(d.bindings) || d.bindings.length > 1024) throw new PlatformError('INVALID', 'Invalid product composition');
  for (const ref of d.modules as unknown[]) {
    const r = exactObject(ref, ['id', 'version'], [], 'module reference');
    if (typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(r.id) || typeof r.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(r.version)) fail('Invalid module reference');
  }
  for (const binding of d.bindings as unknown[]) {
    const b = exactObject(binding, ['contract', 'instanceId', 'implementation', 'scope', 'consumer', 'mode'], [], 'binding');
    for (const key of ['contract', 'instanceId', 'implementation', 'consumer'] as const) boundedText(b[key], `binding ${key}`, 128);
    if (typeof b.scope !== 'string' || !['application', 'module', 'request'].includes(b.scope) || typeof b.mode !== 'string' || !['local', 'http'].includes(b.mode)) fail('Invalid binding');
  }
  canonical(definition);
  return definition;
}
function validateEnvironment(value: EnvironmentSpec): EnvironmentSpec {
  const spec = exactObject(value, ['id', 'label', 'kind', 'target'], ['region'], 'environment') as unknown as EnvironmentSpec;
  if (typeof spec.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(spec.id)) fail('Invalid environment id');
  boundedText(spec.label, 'environment label', 120);
  if (!['development', 'test', 'staging', 'production'].includes(spec.kind)) fail('Invalid environment kind');
  if (!['local', 'edge', 'cloud', 'hybrid'].includes(spec.target)) fail('Invalid environment target');
  if (spec.region !== undefined && (typeof spec.region !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(spec.region))) fail('Invalid environment region');
  return { id: spec.id, label: spec.label.trim(), kind: spec.kind, target: spec.target, ...(spec.region === undefined ? {} : { region: spec.region }) };
}
function validateActor(actorId: string): string {
  if (typeof actorId !== 'string' || !/^(?:operator:[0-9a-f-]{36}|system:[a-z][a-z0-9-]{1,63})$/.test(actorId)) fail('Invalid audit actor');
  return actorId;
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export class ControlPlaneStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 1000 });
    try {
      const schemaVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (schemaVersion > 5) throw new Error(`Unsupported control-plane schema version ${schemaVersion}`);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      this.db.exec('BEGIN IMMEDIATE');
      try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS product_versions(id TEXT NOT NULL,version TEXT NOT NULL,definition TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version),FOREIGN KEY(id) REFERENCES products(id));
        CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,version TEXT NOT NULL,state TEXT NOT NULL,artifact_digest TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS environments(id TEXT PRIMARY KEY,label TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,region TEXT,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL,product_id TEXT NOT NULL,version TEXT NOT NULL,build_id TEXT,state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_pipelines(id TEXT NOT NULL,version TEXT NOT NULL,spec TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,subject TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL);
      `);
      const auditColumns = this.db.prepare('PRAGMA table_info(audit)').all() as { name: string }[];
      if (!auditColumns.some(column => column.name === 'actor_id')) this.db.exec('ALTER TABLE audit ADD COLUMN actor_id TEXT');
      const buildColumns = this.db.prepare('PRAGMA table_info(builds)').all() as { name: string }[];
      const buildNames = new Set(buildColumns.map(column => column.name));
      const additions: [string, string][] = [
        ['actor_id', 'TEXT'], ['request_key', 'TEXT'], ['input_digest', 'TEXT'],
        ['attempt', 'INTEGER NOT NULL DEFAULT 0'], ['owner_id', 'TEXT'], ['claim_token', 'TEXT'],
        ['lease_until', 'INTEGER'], ['phase', "TEXT NOT NULL DEFAULT 'Queued'"],
        ['failure_code', 'TEXT'], ['failure_message', 'TEXT'], ['snapshot_ref', 'TEXT'], ['snapshot_digest', 'TEXT'],
        ['release_digest', 'TEXT'], ['log', "TEXT NOT NULL DEFAULT ''"],
        ['cleanup_state', "TEXT NOT NULL DEFAULT 'NOT_STARTED'"]
      ];
      for (const [name, definition] of additions) if (!buildNames.has(name)) this.db.exec(`ALTER TABLE builds ADD COLUMN ${name} ${definition}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS build_inputs(
          build_id TEXT PRIMARY KEY REFERENCES builds(id), product_definition TEXT NOT NULL, plan TEXT NOT NULL,
          product_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
          toolchain_digest TEXT NOT NULL, recipe_version TEXT NOT NULL, input_digest TEXT NOT NULL,
          created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS build_attempts(
          id TEXT PRIMARY KEY, build_id TEXT NOT NULL REFERENCES builds(id), attempt_no INTEGER NOT NULL,
          owner_id TEXT NOT NULL, claim_token TEXT NOT NULL, lease_until INTEGER NOT NULL,
          state TEXT NOT NULL, phase TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          finished_at INTEGER, workspace_ref TEXT NOT NULL, snapshot_ref TEXT, cleanup_state TEXT NOT NULL,
          error_code TEXT, error_message TEXT, log TEXT NOT NULL DEFAULT '', UNIQUE(build_id,attempt_no)
        );
        CREATE INDEX IF NOT EXISTS build_attempts_order ON build_attempts(build_id,attempt_no);
        CREATE UNIQUE INDEX IF NOT EXISTS builds_request_identity ON builds(actor_id,request_key) WHERE actor_id IS NOT NULL AND request_key IS NOT NULL;
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS artifact_registry_state(
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT, reserved_bytes INTEGER NOT NULL DEFAULT 0,
          reserved_files INTEGER NOT NULL DEFAULT 0, reserved_objects INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_operations(
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, physical_state TEXT NOT NULL,
          build_id TEXT NOT NULL, artifact_digest TEXT NOT NULL, snapshot_id TEXT NOT NULL, snapshot_ref TEXT NOT NULL,
          product_id TEXT NOT NULL, version TEXT NOT NULL, input_digest TEXT NOT NULL, release_digest TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, original_build_actor_id TEXT NOT NULL,
          initiating_actor_id TEXT NOT NULL, registering_actor_id TEXT NOT NULL, owner_token TEXT NOT NULL,
          staging_ref TEXT, host_identity TEXT NOT NULL, publisher_digest TEXT NOT NULL,
          destination_verified INTEGER NOT NULL DEFAULT 0, staging_clean INTEGER NOT NULL DEFAULT 0,
          error_code TEXT, error_message TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS artifact_operations_state ON artifact_operations(state,created);
        CREATE TABLE IF NOT EXISTS artifacts(
          digest TEXT PRIMARY KEY, build_id TEXT NOT NULL UNIQUE REFERENCES builds(id), snapshot_id TEXT NOT NULL,
          product_id TEXT NOT NULL, version TEXT NOT NULL, input_digest TEXT NOT NULL, release_digest TEXT NOT NULL,
          snapshot_digest TEXT NOT NULL, object_ref TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
          originating_actor_id TEXT NOT NULL, registering_actor_id TEXT NOT NULL,
          manifest_json TEXT NOT NULL, entries_json TEXT NOT NULL, created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_build_links(
          build_id TEXT PRIMARY KEY REFERENCES builds(id), artifact_digest TEXT NOT NULL UNIQUE REFERENCES artifacts(digest),
          linked_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_releases(
          product_id TEXT NOT NULL, version TEXT NOT NULL, artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
          build_id TEXT NOT NULL REFERENCES builds(id), input_digest TEXT NOT NULL, release_digest TEXT NOT NULL,
          originating_actor_id TEXT NOT NULL, registering_actor_id TEXT NOT NULL, promoting_actor_id TEXT NOT NULL,
          created INTEGER NOT NULL, PRIMARY KEY(product_id,version)
        );
      CREATE INDEX IF NOT EXISTS artifact_releases_digest ON artifact_releases(artifact_digest);
      CREATE TABLE IF NOT EXISTS runtime_instances(
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL, version TEXT NOT NULL, artifact_digest TEXT NOT NULL,
        profile_digest TEXT NOT NULL, config_digest TEXT NOT NULL, adapter_digest TEXT NOT NULL,
        toolchain_digest TEXT NOT NULL, recipe_digest TEXT NOT NULL, originating_actor_id TEXT NOT NULL,
        start_actor_id TEXT NOT NULL, state TEXT NOT NULL, worker_required INTEGER NOT NULL DEFAULT 0,
        preparation_complete INTEGER NOT NULL DEFAULT 1,
        current_attempt INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_instances_order ON runtime_instances(created DESC,id);
      CREATE TABLE IF NOT EXISTS runtime_commands(
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES runtime_instances(id), kind TEXT NOT NULL,
        actor_id TEXT NOT NULL, request_key TEXT NOT NULL, payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL,
        state TEXT NOT NULL, result_json TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        UNIQUE(actor_id,request_key)
      );
      CREATE INDEX IF NOT EXISTS runtime_commands_instance ON runtime_commands(instance_id,created,id);
      CREATE TABLE IF NOT EXISTS runtime_attempts(
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES runtime_instances(id), attempt_no INTEGER NOT NULL,
        command_id TEXT NOT NULL REFERENCES runtime_commands(id), owner_id TEXT NOT NULL, owner_token TEXT NOT NULL,
        state TEXT NOT NULL, physical_state TEXT NOT NULL, dispatch_begun INTEGER NOT NULL DEFAULT 0,
        enrollment_authorized INTEGER NOT NULL DEFAULT 0, launch_authorized INTEGER NOT NULL DEFAULT 0, worker_required INTEGER NOT NULL,
        api_ready INTEGER NOT NULL DEFAULT 0, worker_attached INTEGER NOT NULL DEFAULT 0,
        port INTEGER, stop_command_id TEXT, stop_actor_id TEXT,
        empty_observed INTEGER NOT NULL DEFAULT 0, helper_closed INTEGER NOT NULL DEFAULT 0,
        execution_clean INTEGER NOT NULL DEFAULT 0, public_log TEXT NOT NULL DEFAULT '',
        error_code TEXT, error_message TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, finished INTEGER,
        UNIQUE(instance_id,attempt_no)
      );
      CREATE INDEX IF NOT EXISTS runtime_attempts_order ON runtime_attempts(instance_id,attempt_no DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_owner_token ON runtime_attempts(owner_token);
      CREATE TABLE IF NOT EXISTS runtime_physical_slot(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT, operation_id TEXT,
        owner_id TEXT, owner_token TEXT, reserved_bytes INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'EMPTY', updated INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO runtime_physical_slot(singleton,state,updated) VALUES(1,'EMPTY',0);
      CREATE TABLE IF NOT EXISTS runtime_recovery_slot(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT, owner_id TEXT, owner_token TEXT,
        reserved_bytes INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'EMPTY', updated INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO runtime_recovery_slot(singleton,state,updated) VALUES(1,'EMPTY',0);
      CREATE TABLE IF NOT EXISTS runtime_recovery_operations(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, physical_state TEXT NOT NULL,
        instance_id TEXT NOT NULL REFERENCES runtime_instances(id), attempt_id TEXT NOT NULL REFERENCES runtime_attempts(id),
        attempt_no INTEGER NOT NULL, command_id TEXT NOT NULL REFERENCES runtime_commands(id),
        product_id TEXT NOT NULL, version TEXT NOT NULL, artifact_digest TEXT NOT NULL, originating_actor_id TEXT NOT NULL,
        profile_digest TEXT NOT NULL, config_digest TEXT NOT NULL, adapter_digest TEXT NOT NULL,
        toolchain_digest TEXT NOT NULL, recipe_digest TEXT NOT NULL, backup_digest TEXT,
        actor_id TEXT NOT NULL, request_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
        owner_id TEXT NOT NULL, owner_token TEXT NOT NULL, reserved_bytes INTEGER NOT NULL,
        dispatch_begun INTEGER NOT NULL DEFAULT 0, driver_empty INTEGER NOT NULL DEFAULT 0,
        driver_closed INTEGER NOT NULL DEFAULT 0, publisher_result_observed INTEGER NOT NULL DEFAULT 0,
        publisher_closed INTEGER NOT NULL DEFAULT 0, destination_published INTEGER NOT NULL DEFAULT 0,
        destination_verified INTEGER NOT NULL DEFAULT 0, empty_observed INTEGER NOT NULL DEFAULT 0,
        helper_closed INTEGER NOT NULL DEFAULT 0, staging_clean INTEGER NOT NULL DEFAULT 0,
        captured_at INTEGER, error_code TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        UNIQUE(actor_id,request_key)
      );
      CREATE INDEX IF NOT EXISTS runtime_recovery_operations_instance ON runtime_recovery_operations(instance_id,created DESC);
      CREATE TABLE IF NOT EXISTS runtime_backups(
        digest TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES runtime_instances(id),
        attempt_id TEXT NOT NULL REFERENCES runtime_attempts(id), attempt_no INTEGER NOT NULL,
        command_id TEXT NOT NULL REFERENCES runtime_commands(id), product_id TEXT NOT NULL, version TEXT NOT NULL,
        artifact_digest TEXT NOT NULL, originating_actor_id TEXT NOT NULL, profile_digest TEXT NOT NULL,
        config_digest TEXT NOT NULL, adapter_digest TEXT NOT NULL, toolchain_digest TEXT NOT NULL,
        recipe_digest TEXT NOT NULL, captured_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
        file_count INTEGER NOT NULL, manifest_json TEXT NOT NULL, entries_json TEXT NOT NULL,
        creating_actor_id TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_backups_instance ON runtime_backups(instance_id,created DESC);
      `);
      const recoveryColumns = this.db.prepare('PRAGMA table_info(runtime_recovery_operations)').all() as { name: string }[];
      if (!recoveryColumns.some(column => column.name === 'publisher_result_observed')) {
        this.db.exec('ALTER TABLE runtime_recovery_operations ADD COLUMN publisher_result_observed INTEGER NOT NULL DEFAULT 0');
        if (recoveryColumns.some(column => column.name === 'publisher_empty'))
          this.db.exec('UPDATE runtime_recovery_operations SET publisher_result_observed=publisher_empty');
      }
      const registryStateColumns = this.db.prepare('PRAGMA table_info(artifact_registry_state)').all() as { name: string }[];
      if (!registryStateColumns.some(column => column.name === 'reserved_objects')) this.db.exec('ALTER TABLE artifact_registry_state ADD COLUMN reserved_objects INTEGER NOT NULL DEFAULT 0');
      const operationColumns = this.db.prepare('PRAGMA table_info(artifact_operations)').all() as { name: string }[];
      if (!operationColumns.some(column => column.name === 'destination_verified')) this.db.exec('ALTER TABLE artifact_operations ADD COLUMN destination_verified INTEGER NOT NULL DEFAULT 0');
      if (!operationColumns.some(column => column.name === 'staging_clean')) this.db.exec('ALTER TABLE artifact_operations ADD COLUMN staging_clean INTEGER NOT NULL DEFAULT 0');
      const artifactColumns = this.db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
      if (!artifactColumns.some(column => column.name === 'snapshot_digest')) this.db.exec("ALTER TABLE artifacts ADD COLUMN snapshot_digest TEXT NOT NULL DEFAULT ''");
      const runtimeInstanceColumns = this.db.prepare('PRAGMA table_info(runtime_instances)').all() as { name: string }[];
      if (!runtimeInstanceColumns.some(column => column.name === 'preparation_complete')) this.db.exec('ALTER TABLE runtime_instances ADD COLUMN preparation_complete INTEGER NOT NULL DEFAULT 1');
      const runtimeAttemptColumns = this.db.prepare('PRAGMA table_info(runtime_attempts)').all() as { name: string }[];
      if (!runtimeAttemptColumns.some(column => column.name === 'dispatch_begun')) {
        this.db.exec('ALTER TABLE runtime_attempts ADD COLUMN dispatch_begun INTEGER NOT NULL DEFAULT 0');
        this.db.exec("UPDATE runtime_attempts SET dispatch_begun=1 WHERE state<>'PREPARING' OR physical_state<>'NOT_DISPATCHED'");
      }
      if (!runtimeAttemptColumns.some(column => column.name === 'enrollment_authorized')) this.db.exec('ALTER TABLE runtime_attempts ADD COLUMN enrollment_authorized INTEGER NOT NULL DEFAULT 0');
      if (!runtimeAttemptColumns.some(column => column.name === 'launch_authorized')) this.db.exec('ALTER TABLE runtime_attempts ADD COLUMN launch_authorized INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`INSERT OR IGNORE INTO artifact_registry_state(singleton,operation_id,reserved_bytes,reserved_files,reserved_objects,updated)
        VALUES(1,NULL,0,0,0,0)`);
      if (schemaVersion < 5) this.db.exec('PRAGMA user_version=5');
      this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Control-plane mutation and rollback failed'); }
      throw error;
    }
  }
  private authorizeMutation(check?: () => unknown) {
    if (!check) return;
    if (check.constructor.name === 'AsyncFunction' || typeof (check as any).then === 'function') throw new PlatformError('INVALID', 'Final authorization check must be synchronous');
    const value = check();
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
      throw new PlatformError('INVALID', 'Final authorization check must be synchronous');
  }
  private audit(action: string, subject: string, payload: unknown, actorId: string) {
    this.db.prepare('INSERT INTO audit(action,subject,payload,at,actor_id) VALUES(?,?,?,?,?)').run(action, subject, canonical(payload), Date.now(), validateActor(actorId));
  }
  private record<T>(actorId: string, action: string, subject: string, payload: unknown, mutation: () => T): T {
    const actor = validateActor(actorId);
    return this.transaction(() => {
      const result = mutation();
      this.audit(action, subject, payload, actor);
      return result;
    });
  }

  putProduct(input: ProductDefinition, actorId: string, authorize?: () => unknown) {
    const definition = validateProduct(input);
    const contents = canonical(definition);
    const actor = validateActor(actorId);
    return this.transaction(() => {
      this.authorizeMutation(authorize);
      const existing = this.db.prepare('SELECT definition FROM product_versions WHERE id=? AND version=?').get(definition.id, definition.version) as { definition: string } | undefined;
      if (existing) {
        if (canonical(JSON.parse(existing.definition)) !== contents) throw new PlatformError('CONFLICT', `Product version ${definition.id}@${definition.version} is immutable`);
        return definition;
      }
      const now = Date.now();
      this.db.prepare('INSERT INTO products(id,title,created,updated) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated=excluded.updated').run(definition.id, definition.title, now, now);
      this.db.prepare('INSERT INTO product_versions(id,version,definition,created) VALUES(?,?,?,?)').run(definition.id, definition.version, contents, now);
      this.audit('product.version.put', `${definition.id}@${definition.version}`, { digest: digest(definition) }, actor);
      return definition;
    });
  }
  products() {
    return this.db.prepare(`SELECT p.id,p.title,p.updated,(SELECT version FROM product_versions v WHERE v.id=p.id ORDER BY created DESC,rowid DESC LIMIT 1) AS version FROM products p ORDER BY p.id`).all();
  }
  productVersions() {
    const rows=this.db.prepare('SELECT id,version,definition FROM product_versions ORDER BY id,created,rowid').all() as {id:string;version:string;definition:string}[];
    return rows.map(row=>{
      let definition:unknown;
      try { definition=JSON.parse(row.definition) as unknown; } catch { return {id:row.id,title:'Invalid legacy product definition',version:row.version,modules:0,valid:false}; }
      if(!isRecord(definition)||definition.id!==row.id||definition.version!==row.version||typeof definition.title!=='string'||!Array.isArray(definition.modules))
        return {id:row.id,title:'Invalid legacy product definition',version:row.version,modules:0,valid:false};
      return {id:row.id,title:definition.title,version:row.version,modules:definition.modules.length,valid:true};
    });
  }
  product(id: string, version?: string): ProductDefinition | undefined {
    const row = version !== undefined
      ? this.db.prepare('SELECT id,version,definition FROM product_versions WHERE id=? AND version=?').get(id, version) as { id: string; version: string; definition: string } | undefined
      : this.db.prepare('SELECT id,version,definition FROM product_versions WHERE id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id) as { id: string; version: string; definition: string } | undefined;
    if (!row) return undefined;
    const definition = JSON.parse(row.definition) as ProductDefinition;
    if (definition.id !== row.id || definition.version !== row.version) throw new PlatformError('INVALID', 'Stored product identity does not match its version key');
    return definition;
  }
  requestBuild(productId: string, version: string, actorId: string) {
    if (typeof productId !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(productId) || typeof version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) fail('Invalid build product reference');
    const id = randomUUID(), now = Date.now();
    return this.record(actorId, 'build.request', id, { productId, version }, () => {
      const product = this.product(productId, version);
      if (!product) throw new PlatformError('NOT_FOUND', 'Product version not found');
      validateProduct(product);
      // Legacy/record-only admissions intentionally have no frozen input and are never executable.
      this.db.prepare(`INSERT INTO builds(id,product_id,version,state,artifact_digest,created,updated,actor_id,phase)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, productId, version, 'QUEUED', null, now, now, actorId, 'Admission only; no frozen input');
      return { id, productId, version, state: 'QUEUED' as BuildState };
    });
  }
  private buildRow(id: string) {
    return this.db.prepare(`SELECT id,product_id AS productId,version,state,artifact_digest AS artifactDigest,created,updated,
      actor_id AS actorId,request_key AS requestKey,input_digest AS inputDigest,attempt,phase,failure_code AS failureCode,
      failure_message AS failureMessage,snapshot_ref AS snapshotRef,snapshot_digest AS snapshotDigest,release_digest AS releaseDigest,cleanup_state AS cleanupState
      FROM builds WHERE id=?`).get(id) as Record<string, any> | undefined;
  }
  private publicBuild(id: string) {
    const row = this.buildRow(id);
    if (!row) return undefined;
    const attempt = this.db.prepare(`SELECT attempt_no AS attempt,state,phase,started_at AS startedAt,updated_at AS updatedAt,
      finished_at AS finishedAt,cleanup_state AS cleanupState,error_code AS errorCode,error_message AS errorMessage
      FROM build_attempts WHERE build_id=? ORDER BY attempt_no DESC LIMIT 1`).get(id) as Record<string, any> | undefined;
    const snapshot = typeof row.snapshotRef === 'string' ? /^snapshots\/([0-9a-f-]{36})$/i.exec(row.snapshotRef) : null;
    const { snapshotRef: _snapshotRef, requestKey: _requestKey, ...safe } = row;
    return { ...safe, snapshotId: snapshot?.[1] ?? null, attempt: Number(row.attempt), attemptDetail: attempt ?? null };
  }
  build(id: string) { return this.publicBuild(id); }
  builds() {
    return (this.db.prepare('SELECT id FROM builds ORDER BY created DESC,id').all() as { id: string }[])
      .map(row => this.publicBuild(row.id)).filter(Boolean);
  }
  buildLog(id: string, limit = 32768) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32768) fail('Invalid build log limit');
    if (!this.buildRow(id)) throw new PlatformError('NOT_FOUND', 'Build not found');
    const rows = this.db.prepare('SELECT log FROM build_attempts WHERE build_id=? ORDER BY attempt_no').all(id) as { log: string }[];
    if (rows.length) return rows.map(row => row.log).filter(Boolean).join('\n').slice(-limit);
    const legacy = this.db.prepare('SELECT log FROM builds WHERE id=?').get(id) as { log: string };
    return legacy.log.slice(-limit);
  }
  buildInput(id: string): FrozenBuildInput | undefined {
    const row = this.db.prepare(`SELECT product_definition AS productDefinition,plan,source_fingerprint AS sourceFingerprint,
      toolchain_digest AS toolchainDigest,recipe_version AS recipeVersion FROM build_inputs WHERE build_id=?`).get(id) as {
        productDefinition: string; plan: string; sourceFingerprint: string; toolchainDigest: string; recipeVersion: string
      } | undefined;
    return row ? { product: JSON.parse(row.productDefinition) as ProductDefinition, plan: JSON.parse(row.plan) as CompositionPlan,
      sourceFingerprint: row.sourceFingerprint, toolchainDigest: row.toolchainDigest, recipeVersion: row.recipeVersion } : undefined;
  }
  buildInputIdentity(id: string) {
    return this.db.prepare(`SELECT product_digest AS productDigest,plan_digest AS planDigest,source_fingerprint AS sourceFingerprint,
      toolchain_digest AS toolchainDigest,recipe_version AS recipeVersion,input_digest AS inputDigest FROM build_inputs WHERE build_id=?`).get(id) as Record<string, string> | undefined;
  }
  admitBuild(productId: string, version: string, requestKey: string, input: FrozenBuildInput, actorId: string) {
    if (typeof productId !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(productId) || typeof version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) fail('Invalid build product reference');
    if (typeof requestKey !== 'string' || requestKey.length < 8 || requestKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestKey)) fail('Invalid build request key');
    const actor = validateActor(actorId);
    if (input?.product?.id !== productId || input.product.version !== version) fail('Frozen product identity mismatch');
    if (input?.plan?.product?.id !== productId || input.plan.product.version !== version || canonical(input.plan.product) !== canonical(input.product)) fail('Frozen plan identity mismatch');
    for (const key of ['sourceFingerprint', 'toolchainDigest'] as const) if (!/^[a-f0-9]{64}$/.test(input[key])) fail(`Invalid ${key}`);
    if (typeof input.recipeVersion !== 'string' || !/^[a-zA-Z0-9._-]{1,48}$/.test(input.recipeVersion)) fail('Invalid build recipe version');
    const definition = validateProduct(input.product);
    const stored = this.product(productId, version);
    if (!stored || canonical(stored) !== canonical(definition)) throw new PlatformError('CONFLICT', 'Frozen product is not the stored immutable version');
    const productDigest = digest(definition), planDigest = digest(input.plan);
    const inputDigest = digest({ product: definition, plan: input.plan, sourceFingerprint: input.sourceFingerprint, toolchainDigest: input.toolchainDigest, recipeVersion: input.recipeVersion });
    const id = randomUUID(), now = Date.now();
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id,input_digest AS inputDigest FROM builds WHERE actor_id=? AND request_key=?').get(actor, requestKey) as { id: string; inputDigest: string | null } | undefined;
      if (prior) {
        if (prior.inputDigest !== inputDigest) throw new PlatformError('CONFLICT', 'Build request key was already used with different frozen input');
        return this.publicBuild(prior.id)!;
      }
      const exactStored = this.product(productId, version);
      if (!exactStored || canonical(exactStored) !== canonical(definition)) throw new PlatformError('CONFLICT', 'Stored product version changed during admission');
      this.db.prepare(`INSERT INTO builds(id,product_id,version,state,artifact_digest,created,updated,actor_id,request_key,input_digest,phase,cleanup_state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, productId, version, 'QUEUED', null, now, now, actor, requestKey, inputDigest, 'Queued', 'NOT_STARTED');
      this.db.prepare(`INSERT INTO build_inputs(build_id,product_definition,plan,product_digest,plan_digest,source_fingerprint,toolchain_digest,recipe_version,input_digest,created)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, canonical(definition), canonical(input.plan), productDigest, planDigest, input.sourceFingerprint, input.toolchainDigest, input.recipeVersion, inputDigest, now);
      this.audit('build.request', id, { productId, version, requestKey, productDigest, planDigest, sourceFingerprint: input.sourceFingerprint, toolchainDigest: input.toolchainDigest, recipeVersion: input.recipeVersion, inputDigest }, actor);
      return this.publicBuild(id)!;
    });
  }
  claimBuild(ownerId: string, leaseMs: number) {
    if (typeof ownerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(ownerId) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) fail('Invalid build worker claim');
    return this.transaction(() => {
      const now = Date.now();
      const expiredCancellation = this.db.prepare(`SELECT id,actor_id AS actorId,attempt,claim_token AS claimToken FROM builds
        WHERE state='CANCEL_REQUESTED' AND lease_until<=? AND cleanup_state<>'UNKNOWN'`).all(now) as { id:string; actorId:string; attempt:number; claimToken:string|null }[];
      for (const item of expiredCancellation) {
        this.db.prepare(`UPDATE builds SET owner_id=NULL,claim_token=NULL,lease_until=NULL,phase='Cancellation owner expired; process state unknown',
          cleanup_state='UNKNOWN',failure_message='The prior cancellation owner expired without proving process termination; files remain quarantined',updated=?
          WHERE id=? AND state='CANCEL_REQUESTED' AND lease_until<=? AND cleanup_state<>'UNKNOWN'`).run(now,item.id,now);
        this.db.prepare(`UPDATE build_attempts SET phase='Cancellation owner expired; process state unknown',cleanup_state='UNKNOWN',
          error_code='CANCEL_OWNER_EXPIRED',error_message='The prior cancellation owner expired without proving process termination; files remain quarantined',updated_at=?
          WHERE build_id=? AND attempt_no=? AND claim_token=? AND state='CANCEL_REQUESTED'`).run(now,item.id,item.attempt,item.claimToken);
        this.audit('build.cancel.pending',item.id,{attempt:item.attempt,cleanupState:'UNKNOWN',reason:'owner-lease-expired'},item.actorId);
      }
      const expired = this.db.prepare(`SELECT id,product_id AS productId,version,actor_id AS actorId,attempt,claim_token AS claimToken
        FROM builds WHERE state='RUNNING' AND lease_until<=? AND input_digest IS NOT NULL`).all(now) as { id: string; productId: string; version: string; actorId: string; attempt: number; claimToken: string }[];
      for (const item of expired) {
        this.db.prepare(`UPDATE build_attempts SET state='ABANDONED',phase='Lease expired; prior output quarantined',cleanup_state='UNKNOWN',
          error_code='LEASE_EXPIRED',error_message='The prior attempt lost its live lease; its files were retained for quarantine',updated_at=?,finished_at=?
          WHERE build_id=? AND attempt_no=? AND claim_token=? AND state='RUNNING'`).run(now, now, item.id, item.attempt, item.claimToken);
        const exhausted = item.attempt >= 2;
        this.db.prepare(`UPDATE builds SET state=?,owner_id=NULL,claim_token=NULL,lease_until=NULL,phase=?,failure_code=?,failure_message=?,cleanup_state='UNKNOWN',updated=?
          WHERE id=? AND state='RUNNING' AND attempt=? AND claim_token=?`).run(exhausted ? 'FAILED' : 'QUEUED', exhausted ? 'Abandoned attempts exhausted' : 'Queued after expired attempt', exhausted ? 'ABANDONED_ATTEMPTS_EXHAUSTED' : null, exhausted ? 'The bounded retry allowance was exhausted; uncertain prior output remains quarantined' : null, now, item.id, item.attempt, item.claimToken);
        this.audit(exhausted ? 'build.failed' : 'build.attempt.abandoned', item.id, { attempt: item.attempt, cleanupState: 'UNKNOWN', exhausted }, item.actorId);
      }
      const blocked = this.db.prepare(`SELECT 1 FROM builds WHERE state='RUNNING' AND lease_until>? LIMIT 1`).get(now);
      const cancellationPending = this.db.prepare(`SELECT 1 FROM builds WHERE state='CANCEL_REQUESTED' LIMIT 1`).get();
      if (blocked || cancellationPending) return undefined;
      const row = this.db.prepare(`SELECT b.id,b.product_id AS productId,b.version,b.actor_id AS actorId,b.attempt,
        i.product_definition AS productDefinition,i.plan,i.source_fingerprint AS sourceFingerprint,i.toolchain_digest AS toolchainDigest,
        i.recipe_version AS recipeVersion,i.product_digest AS productDigest,i.plan_digest AS planDigest,i.input_digest AS inputDigest
        FROM builds b JOIN build_inputs i ON i.build_id=b.id WHERE b.state='QUEUED' AND b.input_digest IS NOT NULL AND b.attempt<2
        ORDER BY b.created,b.id LIMIT 1`).get() as (Record<string, any> & { attempt: number }) | undefined;
      if (!row) return undefined;
      const attempt = Number(row.attempt) + 1, token = randomBytes(32).toString('base64url'), attemptId = randomUUID(), until = now + leaseMs;
      const workspaceRef = `work/${row.id}/attempt-${attempt}-${randomUUID()}`;
      this.db.prepare(`INSERT INTO build_attempts(id,build_id,attempt_no,owner_id,claim_token,lease_until,state,phase,started_at,updated_at,workspace_ref,cleanup_state)
        VALUES(?,?,?,?,?,?,'RUNNING','Preparing private source',?,?,?,'PENDING')`).run(attemptId,row.id,attempt,ownerId,token,until,now,now,workspaceRef);
      this.db.prepare(`UPDATE builds SET state='RUNNING',attempt=?,owner_id=?,claim_token=?,lease_until=?,phase='Preparing private source',failure_code=NULL,failure_message=NULL,cleanup_state='PENDING',updated=? WHERE id=? AND state='QUEUED'`).run(attempt,ownerId,token,until,now,row.id);
      this.audit('build.attempt.claim', row.id, { attempt, leaseUntil: until }, row.actorId);
      const input: FrozenBuildInput = { product: JSON.parse(row.productDefinition), plan: JSON.parse(row.plan), sourceFingerprint: row.sourceFingerprint, toolchainDigest: row.toolchainDigest, recipeVersion: row.recipeVersion };
      return { id: row.id, productId: row.productId, version: row.version, actorId: row.actorId, claimToken: token, ownerId, attempt, leaseUntil: until, workspaceRef, input, productDigest: row.productDigest, planDigest: row.planDigest, inputDigest: row.inputDigest } as BuildClaim;
    });
  }
  renewBuild(claim: BuildClaim, leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) fail('Invalid build lease duration');
    return this.transaction(() => {
      const now = Date.now(), until = now + leaseMs;
      const updated = this.db.prepare(`UPDATE builds SET lease_until=?,updated=? WHERE id=? AND state IN ('RUNNING','CANCEL_REQUESTED') AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).run(until,now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      if (Number(updated.changes) !== 1) return false;
      this.db.prepare(`UPDATE build_attempts SET lease_until=?,updated_at=? WHERE build_id=? AND attempt_no=? AND claim_token=? AND state IN ('RUNNING','CANCEL_REQUESTED')`).run(until,now,claim.id,claim.attempt,claim.claimToken);
      this.audit('build.lease.renew',claim.id,{attempt:claim.attempt,leaseUntil:until},claim.actorId);
      return true;
    });
  }
  buildClaimCurrent(claim: BuildClaim) {
    const row = this.db.prepare(`SELECT 1 FROM builds WHERE id=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).get(claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,Date.now());
    return Boolean(row);
  }
  updateBuildPhase(claim: BuildClaim, phase: string) {
    if (typeof phase !== 'string' || !phase.trim() || phase.length > 96) fail('Invalid build phase');
    return this.transaction(() => {
      const now = Date.now();
      const result = this.db.prepare(`UPDATE builds SET phase=?,updated=? WHERE id=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).run(phase.trim(),now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      if (Number(result.changes) !== 1) return false;
      this.db.prepare(`UPDATE build_attempts SET phase=?,updated_at=? WHERE build_id=? AND attempt_no=? AND claim_token=? AND state='RUNNING'`).run(phase.trim(),now,claim.id,claim.attempt,claim.claimToken);
      this.audit('build.progress', claim.id, { attempt: claim.attempt, phase: phase.trim() }, claim.actorId);
      return true;
    });
  }
  appendBuildAttemptLog(claim: BuildClaim, chunk: string) {
    if (typeof chunk !== 'string' || chunk.length > 8192) fail('Invalid build log chunk');
    return this.transaction(() => {
      const now = Date.now();
      const current = this.db.prepare(`SELECT a.log FROM build_attempts a JOIN builds b ON b.id=a.build_id
        WHERE a.build_id=? AND a.attempt_no=? AND a.owner_id=? AND a.claim_token=? AND b.owner_id=? AND b.claim_token=?
        AND b.actor_id=? AND b.attempt=? AND b.state IN ('RUNNING','CANCEL_REQUESTED') AND b.lease_until>?`)
        .get(claim.id,claim.attempt,claim.ownerId,claim.claimToken,claim.ownerId,claim.claimToken,claim.actorId,claim.attempt,now) as { log: string } | undefined;
      if (!current) return false;
      const log = `${current.log}${chunk}`.slice(-32768);
      this.db.prepare(`UPDATE build_attempts SET log=?,updated_at=? WHERE build_id=? AND attempt_no=? AND claim_token=?`).run(log,now,claim.id,claim.attempt,claim.claimToken);
      return true;
    });
  }
  completeBuild(claim: BuildClaim, result: { snapshotRef: string; snapshotDigest: string; releaseDigest: string; cleanupState: BuildCleanupState; log?: string }) {
    if (!/^snapshots\/[0-9a-f-]{36}$/i.test(result.snapshotRef) || !/^[a-f0-9]{64}$/.test(result.snapshotDigest) || !/^[a-f0-9]{64}$/.test(result.releaseDigest) || result.cleanupState !== 'CLEAN') fail('Invalid verified build result');
    return this.transaction(() => {
      const now = Date.now();
      const frozen = this.db.prepare(`SELECT b.product_id AS productId,b.version,b.actor_id AS actorId,b.input_digest AS buildInputDigest,
        i.product_definition AS productDefinition,i.plan,i.product_digest AS productDigest,i.plan_digest AS planDigest,
        i.source_fingerprint AS sourceFingerprint,i.toolchain_digest AS toolchainDigest,i.recipe_version AS recipeVersion,
        i.input_digest AS inputDigest FROM builds b JOIN build_inputs i ON i.build_id=b.id WHERE b.id=?`).get(claim.id) as {
          productId:string;version:string;actorId:string;buildInputDigest:string;productDefinition:string;plan:string;
          productDigest:string;planDigest:string;sourceFingerprint:string;toolchainDigest:string;recipeVersion:string;inputDigest:string
        } | undefined;
      const conflict = () => new PlatformError('CONFLICT', 'Build attempt no longer owns publication');
      if (!frozen || frozen.actorId !== claim.actorId || frozen.productId !== claim.productId || frozen.version !== claim.version ||
          frozen.buildInputDigest !== frozen.inputDigest || frozen.inputDigest !== claim.inputDigest ||
          frozen.productDigest !== claim.productDigest || frozen.planDigest !== claim.planDigest) throw conflict();
      let product: ProductDefinition, plan: CompositionPlan;
      try {
        product = JSON.parse(frozen.productDefinition) as ProductDefinition;
        plan = JSON.parse(frozen.plan) as CompositionPlan;
        if (canonical(claim.input.product) !== frozen.productDefinition || canonical(claim.input.plan) !== frozen.plan ||
            claim.input.sourceFingerprint !== frozen.sourceFingerprint || claim.input.toolchainDigest !== frozen.toolchainDigest ||
            claim.input.recipeVersion !== frozen.recipeVersion || digest(product) !== frozen.productDigest || digest(plan) !== frozen.planDigest ||
            digest({ product, plan, sourceFingerprint:frozen.sourceFingerprint, toolchainDigest:frozen.toolchainDigest, recipeVersion:frozen.recipeVersion }) !== frozen.inputDigest) throw conflict();
      } catch (error) {
        if (error instanceof PlatformError && error.code === 'CONFLICT') throw error;
        throw conflict();
      }
      const changed = this.db.prepare(`UPDATE builds SET state='SUCCEEDED',artifact_digest=?,snapshot_ref=?,snapshot_digest=?,release_digest=?,phase='Verified local snapshot',
        claim_token=NULL,owner_id=NULL,lease_until=NULL,failure_code=NULL,failure_message=NULL,cleanup_state=?,log=?,updated=?
        WHERE id=? AND product_id=? AND version=? AND input_digest=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).run(result.releaseDigest,result.snapshotRef,result.snapshotDigest,result.releaseDigest,result.cleanupState,(result.log ?? '').slice(-32768),now,claim.id,claim.productId,claim.version,frozen.inputDigest,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      if (Number(changed.changes) !== 1) throw new PlatformError('CONFLICT', 'Build attempt no longer owns publication');
      this.db.prepare(`UPDATE build_attempts SET state='SUCCEEDED',phase='Verified local snapshot',snapshot_ref=?,cleanup_state='CLEAN',log=?,updated_at=?,finished_at=? WHERE build_id=? AND attempt_no=? AND claim_token=?`).run(result.snapshotRef,(result.log ?? '').slice(-32768),now,now,claim.id,claim.attempt,claim.claimToken);
      this.audit('build.succeeded', claim.id, { attempt: claim.attempt, snapshotRef: result.snapshotRef, snapshotDigest: result.snapshotDigest, releaseDigest: result.releaseDigest, inputDigest: frozen.inputDigest }, frozen.actorId);
      return this.publicBuild(claim.id)!;
    });
  }
  recordBuildOrphan(claim: BuildClaim, snapshotRef: string, message: string) {
    if (!/^snapshots\/[0-9a-f-]{36}$/i.test(snapshotRef)) fail('Invalid orphan snapshot reference');
    const safeMessage = boundedText(message, 'orphan cleanup message', 512);
    return this.transaction(() => {
      const now = Date.now();
      const original = this.db.prepare('SELECT actor_id AS actorId FROM builds WHERE id=?').get(claim.id) as { actorId:string } | undefined;
      if (!original || original.actorId !== claim.actorId) return false;
      const changed = this.db.prepare(`UPDATE build_attempts SET snapshot_ref=?,cleanup_state='UNKNOWN',error_code='ORPHAN_SNAPSHOT',error_message=?,updated_at=?
        WHERE build_id=? AND attempt_no=? AND owner_id=? AND claim_token=?`).run(snapshotRef,safeMessage,now,claim.id,claim.attempt,claim.ownerId,claim.claimToken);
      if (Number(changed.changes) !== 1) return false;
      this.audit('build.snapshot.orphaned', claim.id, { attempt: claim.attempt, snapshotRef, cleanupState: 'UNKNOWN' }, original.actorId);
      return true;
    });
  }
  failBuild(claim: BuildClaim, failure: { code: string; message: string; cleanupState: BuildCleanupState; log?: string }) {
    const code = boundedText(failure.code, 'build failure code', 64), message = boundedText(failure.message, 'build failure message', 512);
    if (!['CLEAN','UNKNOWN'].includes(failure.cleanupState)) fail('Invalid build cleanup state');
    return this.transaction(() => {
      const now = Date.now();
      const changed = this.db.prepare(`UPDATE builds SET state='FAILED',phase='Failed',failure_code=?,failure_message=?,cleanup_state=?,log=?,claim_token=NULL,owner_id=NULL,lease_until=NULL,updated=?
        WHERE id=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).run(code,message,failure.cleanupState,(failure.log ?? '').slice(-32768),now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      if (Number(changed.changes) !== 1) return false;
      this.db.prepare(`UPDATE build_attempts SET state='FAILED',phase='Failed',error_code=?,error_message=?,cleanup_state=?,log=?,updated_at=?,finished_at=? WHERE build_id=? AND attempt_no=? AND claim_token=?`).run(code,message,failure.cleanupState,(failure.log ?? '').slice(-32768),now,now,claim.id,claim.attempt,claim.claimToken);
      this.audit('build.failed', claim.id, { attempt: claim.attempt, code, cleanupState: failure.cleanupState }, claim.actorId);
      return true;
    });
  }
  cancelBuild(id: string, actorId: string) {
    const actor = validateActor(actorId);
    return this.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare('SELECT state,owner_id AS ownerId,claim_token AS claimToken,attempt FROM builds WHERE id=?').get(id) as { state: BuildState; ownerId: string | null; claimToken: string | null; attempt: number } | undefined;
      if (!row) throw new PlatformError('NOT_FOUND', 'Build not found');
      if (row.state === 'QUEUED') {
        this.db.prepare(`UPDATE builds SET state='CANCELLED',phase='Cancelled before execution',updated=? WHERE id=? AND state='QUEUED'`).run(now,id);
        this.audit('build.cancelled', id, { state: 'QUEUED' }, actor);
      } else if (row.state === 'RUNNING') {
        this.db.prepare(`UPDATE builds SET state='CANCEL_REQUESTED',phase='Stopping owned build process',updated=? WHERE id=? AND state='RUNNING'`).run(now,id);
        this.db.prepare(`UPDATE build_attempts SET state='CANCEL_REQUESTED',phase='Stopping owned build process',updated_at=? WHERE build_id=? AND attempt_no=? AND claim_token=?`).run(now,id,row.attempt,row.claimToken);
        this.audit('build.cancel.request', id, { attempt: row.attempt }, actor);
      } else if (row.state !== 'CANCEL_REQUESTED') throw new PlatformError('CONFLICT', `Build in ${row.state} state cannot be cancelled`);
      return { build: this.publicBuild(id)!, stopRequired: row.state === 'RUNNING', claimToken: row.claimToken, attempt: row.attempt };
    });
  }
  requestBuildStop(claim: BuildClaim, reason: string) {
    const message = boundedText(reason, 'build stop reason', 512);
    return this.transaction(() => {
      const now = Date.now();
      const changed = this.db.prepare(`UPDATE builds SET state='CANCEL_REQUESTED',phase='Stopping owned build process',failure_message=?,updated=?
        WHERE id=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`)
        .run(message,now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      if (Number(changed.changes) !== 1) return false;
      this.db.prepare(`UPDATE build_attempts SET state='CANCEL_REQUESTED',phase='Stopping owned build process',error_message=?,updated_at=?
        WHERE build_id=? AND attempt_no=? AND owner_id=? AND claim_token=? AND state='RUNNING'`)
        .run(message,now,claim.id,claim.attempt,claim.ownerId,claim.claimToken);
      this.audit('build.cancel.request',claim.id,{attempt:claim.attempt,reason:message},claim.actorId);
      return true;
    });
  }
  finishBuildCancellation(claim: BuildClaim, cleanupState: 'CLEAN' | 'UNKNOWN', message?: string) {
    return this.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`SELECT 1 FROM builds WHERE id=? AND state='CANCEL_REQUESTED' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>? AND (?='UNKNOWN' OR cleanup_state<>'UNKNOWN')`).get(claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now,cleanupState);
      if (!row) return false;
      const safe = cleanupState === 'CLEAN';
      if (safe) {
        this.db.prepare(`UPDATE builds SET state='CANCELLED',phase='Cancelled; process exit observed',cleanup_state='CLEAN',failure_message=?,claim_token=NULL,owner_id=NULL,lease_until=NULL,updated=? WHERE id=? AND state='CANCEL_REQUESTED' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`)
          .run(message ?? null,now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      } else {
        this.db.prepare(`UPDATE builds SET phase='Cancellation pending; process termination unknown',cleanup_state='UNKNOWN',failure_message=?,updated=? WHERE id=? AND state='CANCEL_REQUESTED' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`)
          .run(message ?? 'Process termination was not observed; work files remain quarantined',now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      }
      this.db.prepare(`UPDATE build_attempts SET state=?,phase=?,cleanup_state=?,error_message=?,updated_at=?,finished_at=? WHERE build_id=? AND attempt_no=? AND claim_token=?`)
        .run(safe ? 'CANCELLED' : 'CANCEL_REQUESTED', safe ? 'Cancelled; process exit observed' : 'Cancellation pending; process termination unknown', cleanupState,message ?? null,now,safe ? now : null,claim.id,claim.attempt,claim.claimToken);
      this.audit(safe ? 'build.cancelled' : 'build.cancel.pending', claim.id, { attempt: claim.attempt, cleanupState }, claim.actorId);
      return true;
    });
  }
  abandonBuild(claim: BuildClaim) {
    return this.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`SELECT attempt FROM builds WHERE id=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).get(claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now) as { attempt:number } | undefined;
      if (!row) return false;
      const retry = row.attempt < 2;
      this.db.prepare(`UPDATE build_attempts SET state='ABANDONED',phase='Worker stopped after observing process exit',cleanup_state='CLEAN',updated_at=?,finished_at=? WHERE build_id=? AND attempt_no=? AND owner_id=? AND claim_token=? AND state='RUNNING'`).run(now,now,claim.id,claim.attempt,claim.ownerId,claim.claimToken);
      this.db.prepare(`UPDATE builds SET state=?,owner_id=NULL,claim_token=NULL,lease_until=NULL,phase=?,cleanup_state='CLEAN',failure_code='WORKER_SHUTDOWN',failure_message=?,updated=? WHERE id=? AND state='RUNNING' AND owner_id=? AND claim_token=? AND attempt=? AND actor_id=? AND lease_until>?`).run(retry?'QUEUED':'FAILED',retry?'Queued after worker shutdown':'Worker shutdown exhausted attempt allowance',retry?'The worker stopped after observing its owned process exit':'No retry remains after worker shutdown',now,claim.id,claim.ownerId,claim.claimToken,claim.attempt,claim.actorId,now);
      this.audit(retry?'build.attempt.abandoned':'build.failed',claim.id,{attempt:claim.attempt,cleanupState:'CLEAN',reason:'worker-shutdown'},claim.actorId);
      return true;
    });
  }
  artifactBuildIdentity(buildId: string): ArtifactBuildIdentity {
    if (typeof buildId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(buildId))
      throw new PlatformError('INVALID', 'Invalid build id');
    const row = this.db.prepare(`SELECT b.id AS buildId,b.state,b.product_id AS productId,b.version,b.actor_id AS originatingActorId,
      b.input_digest AS buildInputDigest,b.snapshot_ref AS snapshotRef,b.snapshot_digest AS snapshotDigest,
      b.release_digest AS releaseDigest,b.artifact_digest AS artifactDigest,
      i.product_definition AS productDefinition,i.plan,i.product_digest AS productDigest,i.plan_digest AS planDigest,
      i.source_fingerprint AS sourceFingerprint,i.toolchain_digest AS toolchainDigest,i.recipe_version AS recipeVersion,
      i.input_digest AS inputDigest
      FROM builds b LEFT JOIN build_inputs i ON i.build_id=b.id WHERE b.id=?`).get(buildId) as Record<string, any> | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Build not found');
    if (row.state !== 'SUCCEEDED' || !row.inputDigest || !row.snapshotDigest || !row.releaseDigest || !row.snapshotRef ||
        !row.productDefinition || !row.plan || row.buildInputDigest !== row.inputDigest || row.artifactDigest !== row.releaseDigest)
      throw new PlatformError('CONFLICT', 'Build does not have a frozen, successful verified snapshot');
    const snapshot = /^snapshots\/([0-9a-f-]{36})$/i.exec(row.snapshotRef);
    if (!snapshot || !/^[a-f0-9]{64}$/.test(row.snapshotDigest) || !/^[a-f0-9]{64}$/.test(row.releaseDigest))
      throw new PlatformError('CONFLICT', 'Build snapshot identity is incomplete');
    let product: ProductDefinition, plan: CompositionPlan;
    try {
      product = JSON.parse(row.productDefinition) as ProductDefinition;
      plan = JSON.parse(row.plan) as CompositionPlan;
      if (product.id !== row.productId || product.version !== row.version || canonical(plan.product) !== canonical(product) ||
          digest(product) !== row.productDigest || digest(plan) !== row.planDigest ||
          digest({product,plan,sourceFingerprint:row.sourceFingerprint,toolchainDigest:row.toolchainDigest,recipeVersion:row.recipeVersion}) !== row.inputDigest)
        throw new Error('frozen build identity mismatch');
    } catch { throw new PlatformError('CONFLICT', 'Build frozen input identity is invalid'); }
    return { buildId: row.buildId, snapshotId: snapshot[1]!, productId: row.productId, version: row.version,
      inputDigest: row.inputDigest, releaseDigest: row.releaseDigest, snapshotDigest: row.snapshotDigest,
      sourceFingerprint: row.sourceFingerprint, toolchainDigest: row.toolchainDigest, recipeVersion: row.recipeVersion,
      originatingActorId: validateActor(row.originatingActorId) };
  }
  artifactRecord(digestValue: string) {
    if (typeof digestValue !== 'string' || !/^[a-f0-9]{64}$/.test(digestValue)) throw new PlatformError('INVALID', 'Invalid artifact digest');
    return this.db.prepare(`SELECT digest,build_id AS buildId,snapshot_id AS snapshotId,product_id AS productId,version,
      input_digest AS inputDigest,release_digest AS releaseDigest,snapshot_digest AS snapshotDigest,object_ref AS objectRef,size_bytes AS sizeBytes,
      file_count AS fileCount,originating_actor_id AS originatingActorId,registering_actor_id AS registeringActorId,
      manifest_json AS manifestJson,entries_json AS entriesJson,created AS registeredAt FROM artifacts WHERE digest=?`).get(digestValue) as
      (Record<string, any> & VerifiedArtifactRecord & { snapshotId:string; objectRef:string }) | undefined;
  }
  artifacts() {
    return this.db.prepare(`SELECT digest,build_id AS buildId,product_id AS productId,version,input_digest AS inputDigest,
      release_digest AS releaseDigest,size_bytes AS sizeBytes,file_count AS fileCount,
      originating_actor_id AS originatingActorId,registering_actor_id AS registeringActorId,created AS registeredAt
      FROM artifacts ORDER BY created,digest`).all();
  }
  artifactReleases() {
    return this.db.prepare(`SELECT product_id AS productId,version,artifact_digest AS artifactDigest,build_id AS buildId,
      input_digest AS inputDigest,release_digest AS releaseDigest,originating_actor_id AS originatingActorId,
      registering_actor_id AS registeringActorId,promoting_actor_id AS promotingActorId,created AS promotedAt
      FROM artifact_releases ORDER BY product_id,version`).all();
  }
  artifactOperations(limit=200) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('Invalid artifact-operation history bound');
    return (this.db.prepare(`SELECT id,kind,state,physical_state AS physicalState,destination_verified AS destinationVerified,staging_clean AS stagingClean,
      build_id AS buildId,artifact_digest AS artifactDigest,
      product_id AS productId,version,size_bytes AS sizeBytes,file_count AS fileCount,
      original_build_actor_id AS originatingActorId,initiating_actor_id AS initiatingActorId,
      registering_actor_id AS registeringActorId,error_code AS errorCode,error_message AS errorMessage,
      created,updated FROM artifact_operations ORDER BY created DESC,id LIMIT ?`).all(limit) as Record<string,unknown>[])
      .map(row=>({...row,destinationVerified:row.destinationVerified===1,stagingClean:row.stagingClean===1}));
  }
  artifactOperationCount() { return (this.db.prepare('SELECT COUNT(*) AS count FROM artifact_operations').get() as {count:number}).count; }
  artifactRegistrySlot() {
    return this.db.prepare('SELECT operation_id AS operationId,reserved_bytes AS reservedBytes,reserved_files AS reservedFiles,reserved_objects AS reservedObjects FROM artifact_registry_state WHERE singleton=1').get() as
      {operationId:string|null;reservedBytes:number;reservedFiles:number;reservedObjects:number};
  }
  private artifactBuildRow(buildId:string) {
    const identity=this.artifactBuildIdentity(buildId);
    const build=this.buildRow(buildId)!;
    const input=this.db.prepare('SELECT product_definition AS productDefinition,plan FROM build_inputs WHERE build_id=?').get(buildId) as {productDefinition:string;plan:string};
    return {identity,build,input};
  }
  private assertArtifactCapacity(input: Pick<ArtifactPublicationIntent,'sizeBytes'|'fileCount'>, observation:ArtifactCapacityObservation, targetExists:boolean, reservedBytes:number, reservedObjects:number, stagingOverheadBytes=0) {
    const limits=ARTIFACT_REGISTRY_LIMITS;
    if (!Number.isSafeInteger(input.sizeBytes)||input.sizeBytes<1||input.sizeBytes>limits.maxArtifactBytes||
        !Number.isSafeInteger(input.fileCount)||input.fileCount<1||input.fileCount>limits.maxFiles||
        !Number.isSafeInteger(observation.registryBytes)||observation.registryBytes<0||
        !Number.isSafeInteger(observation.objectDirectories)||observation.objectDirectories<0||
        !Number.isSafeInteger(observation.stagingBytes)||observation.stagingBytes<0||
        !Number.isSafeInteger(stagingOverheadBytes)||stagingOverheadBytes<0)
      throw new PlatformError('INVALID','Artifact exceeds the local registry limits');
    if (observation.registryBytes+reservedBytes+(targetExists?0:input.sizeBytes+stagingOverheadBytes)>limits.maxRegistryBytes ||
        observation.stagingBytes+reservedBytes+(targetExists?0:input.sizeBytes+stagingOverheadBytes)>limits.maxStagingBytes ||
        observation.objectDirectories+reservedObjects+(targetExists?0:1)>limits.maxObjectDirectories)
      throw new PlatformError('CONFLICT','Local artifact registry capacity is exhausted');
  }
  beginArtifactPublication(intent:ArtifactPublicationIntent,authorize:()=>unknown,observeCapacity:()=>ArtifactCapacityObservation) {
    if (!/^[0-9a-f-]{36}$/i.test(intent.operationId)||!/^[A-Za-z0-9_-]{32,128}$/.test(intent.ownerToken)||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.snapshotId)||
        !/^[a-f0-9]{64}$/.test(intent.artifactDigest)||!/^[a-f0-9]{64}$/.test(intent.inputDigest)||!/^[a-f0-9]{64}$/.test(intent.releaseDigest)||
        !/^[a-z][a-z0-9-]{1,47}$/.test(intent.productId)||!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(intent.version)||
        !/^\{.{2,4096}\}$/.test(intent.hostIdentity)||!/^[a-f0-9]{64}$/.test(intent.publisherDigest))
      throw new PlatformError('INVALID','Invalid artifact publication identity');
    const actor=validateActor(intent.registeringActorId);
    const originatingActor=validateActor(intent.originatingActorId);
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const {identity}=this.artifactBuildRow(intent.buildId);
      if (identity.snapshotId!==intent.snapshotId||identity.snapshotDigest!==intent.artifactDigest||identity.productId!==intent.productId||
          identity.version!==intent.version||identity.inputDigest!==intent.inputDigest||identity.releaseDigest!==intent.releaseDigest||identity.originatingActorId!==originatingActor)
        throw new PlatformError('CONFLICT','The successful build differs from the verified artifact identity');
      const registered=this.artifactRecord(intent.artifactDigest);
      if (registered) {
        if (registered.buildId!==intent.buildId||registered.snapshotDigest!==intent.artifactDigest||registered.productId!==intent.productId||registered.version!==intent.version||registered.inputDigest!==intent.inputDigest||registered.releaseDigest!==intent.releaseDigest)
          throw new PlatformError('CONFLICT','Artifact digest is registered with different build identity');
        return {kind:'REGISTERED' as const,artifact:registered};
      }
      const link=this.db.prepare('SELECT artifact_digest AS digest FROM artifact_build_links WHERE build_id=?').get(intent.buildId) as {digest:string}|undefined;
      if(link)throw new PlatformError('CONFLICT','Build is already linked to a different registered artifact');
      const slot=this.artifactRegistrySlot();
      if(slot.operationId)throw new PlatformError('CONFLICT','Another physical registry operation is unresolved');
      const unresolved=this.db.prepare("SELECT id FROM artifact_operations WHERE state IN ('RESERVED','PUBLISHING','UNKNOWN') LIMIT 1").get();
      if(unresolved)throw new PlatformError('CONFLICT','An unresolved registry operation retains its reservation');
      if (observeCapacity.constructor.name === 'AsyncFunction' || typeof (observeCapacity as any).then === 'function') throw new PlatformError('INVALID','Capacity observation must be synchronous');
      const observation=observeCapacity();
      if (observation !== null && (typeof observation === 'object' || typeof observation === 'function') && typeof (observation as {then?:unknown}).then === 'function') throw new PlatformError('INVALID','Capacity observation must be synchronous');
      this.assertArtifactCapacity(intent,observation,false,slot.reservedBytes,slot.reservedObjects,intent.stagingOverheadBytes);
      this.authorizeMutation(authorize);
      const now=Date.now(),stagingRef=`staging/${intent.operationId}`;
      this.db.prepare(`INSERT INTO artifact_operations(id,kind,state,physical_state,build_id,artifact_digest,snapshot_id,snapshot_ref,
        product_id,version,input_digest,release_digest,size_bytes,file_count,original_build_actor_id,initiating_actor_id,
        registering_actor_id,owner_token,staging_ref,host_identity,publisher_digest,created,updated)
        VALUES(?,'REGISTER','RESERVED','NONE',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(intent.operationId,intent.buildId,intent.artifactDigest,intent.snapshotId,`snapshots/${intent.snapshotId}`,intent.productId,intent.version,
          intent.inputDigest,intent.releaseDigest,intent.sizeBytes,intent.fileCount,originatingActor,actor,actor,intent.ownerToken,
          stagingRef,intent.hostIdentity,intent.publisherDigest,now,now);
      this.db.prepare('UPDATE artifact_registry_state SET operation_id=?,reserved_bytes=?,reserved_files=?,reserved_objects=1,updated=? WHERE singleton=1 AND operation_id IS NULL')
        .run(intent.operationId,intent.sizeBytes+intent.stagingOverheadBytes,intent.fileCount,now);
      const state=this.artifactRegistrySlot();
      if(state.operationId!==intent.operationId)throw new PlatformError('CONFLICT','Could not reserve the physical artifact registry slot');
      this.audit('artifact.register.reserved',intent.operationId,{buildId:intent.buildId,artifactDigest:intent.artifactDigest,sizeBytes:intent.sizeBytes,fileCount:intent.fileCount},actor);
      return {kind:'RESERVED' as const,operationId:intent.operationId,ownerToken:intent.ownerToken,stagingRef};
    });
  }
  recordArtifactPublication(id:string,ownerToken:string,state:'PUBLISHING'|'MOVE_OBSERVED'|'PUBLISHED'|'STAGING_CLEAN'|'UNKNOWN',message?:string) {
    const safeMessage=message===undefined?null:boundedText(message,'artifact operation message',512);
    if(!/^[0-9a-f-]{36}$/i.test(id)||!/^[A-Za-z0-9_-]{32,128}$/.test(ownerToken))fail('Invalid artifact operation owner');
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT state,physical_state AS physicalState,destination_verified AS destinationVerified,staging_clean AS stagingClean FROM artifact_operations WHERE id=? AND owner_token=?').get(id,ownerToken) as {state:string;physicalState:string;destinationVerified:number;stagingClean:number}|undefined;
      if(!prior||!['RESERVED','PUBLISHING','PUBLISHED','UNKNOWN'].includes(prior.state))return false;
      if(state==='MOVE_OBSERVED'&&prior.state!=='PUBLISHING')throw new PlatformError('CONFLICT','A move proof requires a current publication attempt');
      if(state==='PUBLISHED'&&prior.physicalState!=='MOVE_OBSERVED')throw new PlatformError('CONFLICT','Destination verification requires an observed no-overwrite move');
      if(state==='STAGING_CLEAN'&&(prior.state!=='PUBLISHED'||prior.physicalState!=='MOVE_OBSERVED'||prior.destinationVerified!==1))
        throw new PlatformError('CONFLICT','Staging cleanup requires verified destination bytes');
      const now=Date.now();
      const physical=state==='PUBLISHED'||state==='STAGING_CLEAN'||state==='MOVE_OBSERVED'?'MOVE_OBSERVED':state==='UNKNOWN'?'UNKNOWN':'COPY_VERIFIED';
      const durableState=state==='MOVE_OBSERVED'?'PUBLISHING':state==='STAGING_CLEAN'?'PUBLISHED':state;
      const changed=this.db.prepare(`UPDATE artifact_operations SET state=?,physical_state=CASE WHEN physical_state='MOVE_OBSERVED' THEN physical_state ELSE ? END,
        destination_verified=CASE WHEN ? THEN 1 ELSE destination_verified END,staging_clean=CASE WHEN ? THEN 1 ELSE staging_clean END,
        error_code=?,error_message=?,updated=?
        WHERE id=? AND owner_token=? AND state IN ('RESERVED','PUBLISHING','PUBLISHED','UNKNOWN')`)
        .run(durableState,physical,state==='PUBLISHED'?1:0,state==='STAGING_CLEAN'?1:0,state==='UNKNOWN'?'PHYSICAL_STATE_UNKNOWN':null,safeMessage,now,id,ownerToken);
      if(Number(changed.changes)!==1)return false;
      if(state==='UNKNOWN'){
        const op=this.db.prepare('SELECT artifact_digest AS digest,registering_actor_id AS actorId,physical_state AS physicalState FROM artifact_operations WHERE id=?').get(id) as {digest:string;actorId:string;physicalState:string};
        this.audit('artifact.operation.unknown',id,{artifactDigest:op.digest,physicalState:op.physicalState},op.actorId);
      }
      return true;
    });
  }
  /** Release only the serialization reservation after the current owner has verified the published object. */
  settleArtifactPublication(id:string,ownerToken:string) {
    if(!/^[0-9a-f-]{36}$/i.test(id)||!/^[A-Za-z0-9_-]{32,128}$/.test(ownerToken))fail('Invalid artifact operation owner');
    return this.transaction(()=>{
      const op=this.db.prepare("SELECT artifact_digest AS digest,state,physical_state,destination_verified AS destinationVerified,staging_clean AS stagingClean,registering_actor_id AS actorId FROM artifact_operations WHERE id=? AND owner_token=?").get(id,ownerToken) as {digest:string;state:string;physical_state:string;destinationVerified:number;stagingClean:number;actorId:string}|undefined;
      if(!op||op.state!=='PUBLISHED'||op.physical_state!=='MOVE_OBSERVED'||op.destinationVerified!==1||op.stagingClean!==1)throw new PlatformError('CONFLICT','The current artifact owner has not verified publication and staging cleanup');
      const now=Date.now();
      const released=this.db.prepare('UPDATE artifact_registry_state SET operation_id=NULL,reserved_bytes=0,reserved_files=0,reserved_objects=0,updated=? WHERE singleton=1 AND operation_id=?').run(now,id);
      this.db.prepare("UPDATE artifact_operations SET state='PUBLISHED',error_code=NULL,error_message=NULL,updated=? WHERE id=? AND owner_token=? AND physical_state='MOVE_OBSERVED'").run(now,id,ownerToken);
      if(Number(released.changes)===1)this.audit('artifact.operation.settled',id,{artifactDigest:op.digest,physicalState:'MOVE_OBSERVED'},op.actorId);
      return true;
    });
  }
  abortArtifactPublication(id:string,ownerToken:string,reason:string) {
    const message=boundedText(reason,'artifact abort reason',512);
    return this.transaction(()=>{
      const operation=this.db.prepare(`SELECT registering_actor_id AS actorId,artifact_digest AS digest FROM artifact_operations
        WHERE id=? AND owner_token=? AND state IN ('RESERVED','PUBLISHING') AND physical_state IN ('NONE','COPY_VERIFIED')`).get(id,ownerToken) as {actorId:string;digest:string}|undefined;
      if(!operation)return false;
      const now=Date.now();
      this.db.prepare("UPDATE artifact_operations SET state='ABORTED',physical_state='NO_PUBLICATION',error_code='REGISTRATION_ABORTED',error_message=?,updated=? WHERE id=? AND owner_token=?").run(message,now,id,ownerToken);
      this.db.prepare('UPDATE artifact_registry_state SET operation_id=NULL,reserved_bytes=0,reserved_files=0,reserved_objects=0,updated=? WHERE singleton=1 AND operation_id=?').run(now,id);
      this.audit('artifact.register.aborted',id,{artifactDigest:operation.digest,message},operation.actorId);
      return true;
    });
  }
  completeArtifactPublication(id:string,ownerToken:string,manifestJson:string,entriesJson:string,sizeBytes:number,fileCount:number,authorize?:()=>unknown) {
    if(typeof manifestJson!=='string'||Buffer.byteLength(manifestJson)>ARTIFACT_REGISTRY_LIMITS.maxManifestBytes||
        typeof entriesJson!=='string'||Buffer.byteLength(entriesJson)>ARTIFACT_REGISTRY_LIMITS.maxManifestBytes||
        !Number.isSafeInteger(sizeBytes)||!Number.isSafeInteger(fileCount))fail('Invalid artifact publication metadata');
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const op=this.db.prepare(`SELECT * FROM artifact_operations WHERE id=? AND owner_token=? AND state='PUBLISHED' AND physical_state='MOVE_OBSERVED' AND destination_verified=1 AND staging_clean=1`).get(id,ownerToken) as Record<string,any>|undefined;
      if(!op)throw new PlatformError('CONFLICT','The original artifact publication has no observed move proof');
      const {identity}=this.artifactBuildRow(op.build_id);
      if(identity.snapshotId!==op.snapshot_id||identity.snapshotDigest!==op.artifact_digest||identity.productId!==op.product_id||identity.version!==op.version||identity.inputDigest!==op.input_digest||identity.releaseDigest!==op.release_digest||identity.originatingActorId!==op.original_build_actor_id||
          sizeBytes!==op.size_bytes||fileCount!==op.file_count)throw new PlatformError('CONFLICT','Published artifact differs from its durable operation intent');
      const existing=this.artifactRecord(op.artifact_digest);
      if(existing){
        if(existing.buildId!==op.build_id||existing.snapshotDigest!==op.artifact_digest||existing.snapshotId!==op.snapshot_id||existing.productId!==op.product_id||existing.version!==op.version||
            existing.inputDigest!==op.input_digest||existing.releaseDigest!==op.release_digest||existing.sizeBytes!==sizeBytes||existing.fileCount!==fileCount||
         identity.originatingActorId!==op.original_build_actor_id||existing.originatingActorId!==op.original_build_actor_id||existing.manifestJson!==manifestJson||existing.entriesJson!==entriesJson)
          throw new PlatformError('CONFLICT','An artifact with the same digest has different durable metadata');
        this.db.prepare("UPDATE artifact_operations SET state='REGISTERED',physical_state='MOVE_OBSERVED',updated=? WHERE id=? AND owner_token=?").run(Date.now(),id,ownerToken);
        this.db.prepare('UPDATE artifact_registry_state SET operation_id=NULL,reserved_bytes=0,reserved_files=0,reserved_objects=0,updated=? WHERE singleton=1 AND operation_id=?').run(Date.now(),id);
        return existing;
      }
      const now=Date.now();
      this.db.prepare(`INSERT INTO artifacts(digest,build_id,snapshot_id,product_id,version,input_digest,release_digest,snapshot_digest,object_ref,
        size_bytes,file_count,originating_actor_id,registering_actor_id,manifest_json,entries_json,created)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(op.artifact_digest,op.build_id,op.snapshot_id,op.product_id,op.version,op.input_digest,
          op.release_digest,op.artifact_digest,`objects/${op.artifact_digest}`,sizeBytes,fileCount,op.original_build_actor_id,op.registering_actor_id,manifestJson,entriesJson,now);
      this.db.prepare('INSERT INTO artifact_build_links(build_id,artifact_digest,linked_at) VALUES(?,?,?)').run(op.build_id,op.artifact_digest,now);
      this.db.prepare("UPDATE artifact_operations SET state='REGISTERED',physical_state='MOVE_OBSERVED',updated=? WHERE id=? AND owner_token=?").run(now,id,ownerToken);
      this.db.prepare('UPDATE artifact_registry_state SET operation_id=NULL,reserved_bytes=0,reserved_files=0,reserved_objects=0,updated=? WHERE singleton=1 AND operation_id=?').run(now,id);
      this.audit('artifact.registered',op.artifact_digest,{buildId:op.build_id,productId:op.product_id,version:op.version,inputDigest:op.input_digest,sizeBytes,fileCount},op.registering_actor_id);
      return this.artifactRecord(op.artifact_digest)!;
    });
  }
  adoptVerifiedArtifact(input:{operationId:string;buildId:string;artifactDigest:string;snapshotId:string;originatingActorId:string;productId:string;version:string;inputDigest:string;releaseDigest:string;
    sizeBytes:number;fileCount:number;observedRegistryBytes:number;observedObjectDirectories:number;manifestJson:string;entriesJson:string;registeringActorId:string},authorize:()=>unknown,
    observeCapacity:()=>ArtifactCapacityObservation) {
    const actor=validateActor(input.registeringActorId);
    const originatingActor=validateActor(input.originatingActorId);
    if(!/^[0-9a-f-]{36}$/i.test(input.operationId)||Buffer.byteLength(input.manifestJson)>ARTIFACT_REGISTRY_LIMITS.maxManifestBytes||Buffer.byteLength(input.entriesJson)>ARTIFACT_REGISTRY_LIMITS.maxManifestBytes)fail('Invalid orphan adoption metadata');
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const {identity}=this.artifactBuildRow(input.buildId);
      if(identity.snapshotId!==input.snapshotId||identity.snapshotDigest!==input.artifactDigest||identity.productId!==input.productId||identity.version!==input.version||identity.inputDigest!==input.inputDigest||identity.releaseDigest!==input.releaseDigest||identity.originatingActorId!==originatingActor)
        throw new PlatformError('CONFLICT','The verified orphan differs from the successful build identity');
      const existing=this.artifactRecord(input.artifactDigest);
      if(existing){if(existing.buildId!==input.buildId||existing.snapshotDigest!==input.artifactDigest||existing.snapshotId!==input.snapshotId||existing.productId!==input.productId||existing.version!==input.version||existing.inputDigest!==input.inputDigest||existing.releaseDigest!==input.releaseDigest||existing.originatingActorId!==identity.originatingActorId||existing.sizeBytes!==input.sizeBytes||existing.fileCount!==input.fileCount||existing.manifestJson!==input.manifestJson||existing.entriesJson!==input.entriesJson)throw new PlatformError('CONFLICT','Artifact digest is already registered with different metadata');return existing;}
      const slot=this.artifactRegistrySlot();
      if (observeCapacity.constructor.name === 'AsyncFunction' || typeof (observeCapacity as any).then === 'function') throw new PlatformError('INVALID','Capacity observation must be synchronous');
      const observation=observeCapacity();
      if (observation !== null && (typeof observation === 'object' || typeof observation === 'function') && typeof (observation as {then?:unknown}).then === 'function') throw new PlatformError('INVALID','Capacity observation must be synchronous');
      this.assertArtifactCapacity(input,observation,true,slot.reservedBytes,slot.reservedObjects);
      this.authorizeMutation(authorize);
      const now=Date.now(),token=randomBytes(24).toString('base64url');
      this.db.prepare(`INSERT INTO artifact_operations(id,kind,state,physical_state,build_id,artifact_digest,snapshot_id,snapshot_ref,
        product_id,version,input_digest,release_digest,size_bytes,file_count,original_build_actor_id,initiating_actor_id,
        registering_actor_id,owner_token,staging_ref,host_identity,publisher_digest,destination_verified,staging_clean,created,updated)
        VALUES(?,'ADOPT_ORPHAN','REGISTERED','PREEXISTING_VERIFIED',?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'{}','',1,1,?,?)`)
        .run(input.operationId,input.buildId,input.artifactDigest,input.snapshotId,`snapshots/${input.snapshotId}`,input.productId,input.version,
          input.inputDigest,input.releaseDigest,input.sizeBytes,input.fileCount,originatingActor,actor,actor,token,now,now);
      this.db.prepare(`INSERT INTO artifacts(digest,build_id,snapshot_id,product_id,version,input_digest,release_digest,snapshot_digest,object_ref,
        size_bytes,file_count,originating_actor_id,registering_actor_id,manifest_json,entries_json,created)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.artifactDigest,input.buildId,input.snapshotId,input.productId,input.version,input.inputDigest,
          input.releaseDigest,input.artifactDigest,`objects/${input.artifactDigest}`,input.sizeBytes,input.fileCount,originatingActor,actor,input.manifestJson,input.entriesJson,now);
      this.db.prepare('INSERT INTO artifact_build_links(build_id,artifact_digest,linked_at) VALUES(?,?,?)').run(input.buildId,input.artifactDigest,now);
      this.audit('artifact.orphan.adopted',input.artifactDigest,{operationId:input.operationId,buildId:input.buildId,sizeBytes:input.sizeBytes,fileCount:input.fileCount},actor);
      return this.artifactRecord(input.artifactDigest)!;
    });
  }
  promoteArtifact(input:{productId:string;version:string;artifactDigest:string;actorId:string},authorize?:()=>unknown) {
    const actor=validateActor(input.actorId);
    if(typeof input.productId!=='string'||!/^[a-z][a-z0-9-]{1,47}$/.test(input.productId)||typeof input.version!=='string'||!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(input.version)||!/^[a-f0-9]{64}$/.test(input.artifactDigest))fail('Invalid promoted release identity');
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const artifact=this.artifactRecord(input.artifactDigest);
      if(!artifact)throw new PlatformError('NOT_FOUND','Registered artifact not found');
      if(artifact.productId!==input.productId||artifact.version!==input.version)throw new PlatformError('CONFLICT','Artifact product version does not match the promoted release');
      const product=this.product(input.productId,input.version);
      if(!product)throw new PlatformError('NOT_FOUND','Product version not found');
      validateProduct(product);
      const prior=this.db.prepare('SELECT artifact_digest AS digest FROM artifact_releases WHERE product_id=? AND version=?').get(input.productId,input.version) as {digest:string}|undefined;
      if(prior){if(prior.digest!==input.artifactDigest)throw new PlatformError('CONFLICT','Product version already promotes a different immutable artifact');return this.artifactReleases().find((row:any)=>row.productId===input.productId&&row.version===input.version)!;}
      const now=Date.now();
      this.db.prepare(`INSERT INTO artifact_releases(product_id,version,artifact_digest,build_id,input_digest,release_digest,
        originating_actor_id,registering_actor_id,promoting_actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(input.productId,input.version,input.artifactDigest,artifact.buildId,artifact.inputDigest,artifact.releaseDigest,artifact.originatingActorId,artifact.registeringActorId,actor,now);
      this.audit('artifact.release.promoted',`${input.productId}@${input.version}`,{artifactDigest:input.artifactDigest,buildId:artifact.buildId,inputDigest:artifact.inputDigest},actor);
      return this.artifactReleases().find((row:any)=>row.productId===input.productId&&row.version===input.version)!;
    });
  }
  private runtimeInstanceRow(instanceId:string) {
    return this.db.prepare(`SELECT id,product_id AS productId,version,artifact_digest AS artifactDigest,profile_digest AS profileDigest,
      config_digest AS configDigest,adapter_digest AS adapterDigest,toolchain_digest AS toolchainDigest,recipe_digest AS recipeDigest,
      originating_actor_id AS originatingActorId,start_actor_id AS startActorId,state,worker_required AS workerRequired,
      preparation_complete AS preparationComplete,current_attempt AS currentAttempt,created,updated FROM runtime_instances WHERE id=?`).get(instanceId) as Record<string,any>|undefined;
  }
  private runtimeCommandRow(commandId:string) {
    return this.db.prepare(`SELECT id,instance_id AS instanceId,kind,actor_id AS actorId,state,created,updated FROM runtime_commands WHERE id=?`).get(commandId) as Record<string,any>|undefined;
  }
  private runtimeResult(commandId:string,instanceId:string,operationId:string|null,ownerToken:string|null,reused:boolean):ManagedRuntimeCommandResult {
    const command=this.runtimeCommandRow(commandId),instance=this.runtimeInstanceRow(instanceId);
    if(!command||!instance)throw new PlatformError('CONFLICT','Managed runtime command identity is incomplete');
    return {command,instance,operationId,ownerToken,reused};
  }
  private validateRuntimeStartIntent(input:ManagedRuntimeStartIntent) {
    const hash=/^[a-f0-9]{64}$/;
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const requestKey=typeof input.requestKey==='string'&&input.requestKey.length<=MANAGED_RUNTIME_LIMITS.maxRequestKeyChars&&/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestKey);
    if(typeof input.instanceId!=='string'||!managedRuntimeIdPattern.test(input.instanceId)||
        typeof input.operationId!=='string'||!uuid.test(input.operationId)||typeof input.ownerId!=='string'||!uuid.test(input.ownerId)||
        typeof input.ownerToken!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(input.ownerToken)||!requestKey||
        typeof input.productId!=='string'||!/^[a-z][a-z0-9-]{1,47}$/.test(input.productId)||
        typeof input.version!=='string'||!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(input.version)||!hash.test(input.artifactDigest)||
        !hash.test(input.profileDigest)||!hash.test(input.configDigest)||!hash.test(input.adapterDigest)||!hash.test(input.toolchainDigest)||!hash.test(input.recipeDigest)||
        typeof input.workerRequired!=='boolean'||input.preparationComplete!==undefined&&typeof input.preparationComplete!=='boolean'||!Number.isSafeInteger(input.executionBytes)||input.executionBytes<1||
        input.executionBytes>MANAGED_RUNTIME_LIMITS.maxExecutionBytes||input.executionBytes>MANAGED_RUNTIME_LIMITS.maxArtifactBytes*2)
      throw new PlatformError('INVALID','Invalid managed runtime identity or command');
    if(input.preparationComplete===false&&input.configDigest!=='0'.repeat(64))throw new PlatformError('INVALID','Unprepared runtime intent must use the fixed pending configuration marker');
    validateActor(input.actorId);validateActor(input.originatingActorId);
  }
  private existingRuntimeCommand(actorId:string,requestKey:string,kind:ManagedRuntimeCommandKind,payloadDigest:string):ManagedRuntimeCommandResult|undefined {
    const prior=this.db.prepare('SELECT id,instance_id AS instanceId,kind,payload_digest AS payloadDigest FROM runtime_commands WHERE actor_id=? AND request_key=?').get(actorId,requestKey) as
      {id:string;instanceId:string;kind:ManagedRuntimeCommandKind;payloadDigest:string}|undefined;
    if(!prior)return undefined;
    if(prior.kind!==kind||prior.payloadDigest!==payloadDigest)throw new PlatformError('CONFLICT','Runtime request key is already bound to another immutable command');
    return this.runtimeResult(prior.id,prior.instanceId,null,null,true);
  }
  managedRuntimeCommandForRequest(actorId:string,requestKey:string,kind:ManagedRuntimeCommandKind,payload:Record<string,unknown>) {
    const actor=validateActor(actorId);
    if(typeof requestKey!=='string'||requestKey.length>MANAGED_RUNTIME_LIMITS.maxRequestKeyChars||!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)||
        !['START','STOP','RESTART'].includes(kind)||!payload||typeof payload!=='object'||Array.isArray(payload))
      throw new PlatformError('INVALID','Invalid managed runtime command lookup');
    const normalized={...payload,kind};
    return this.existingRuntimeCommand(actor,requestKey,kind,digest(normalized));
  }
  managedRuntimeCommand(commandId:string) {
    if(typeof commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId))
      throw new PlatformError('INVALID','Invalid managed runtime command reference');
    return this.runtimeCommandRow(commandId);
  }
  beginManagedRuntimeStart(input:ManagedRuntimeStartIntent,authorize:()=>unknown):ManagedRuntimeCommandResult {
    this.validateRuntimeStartIntent(input);
    const actor=validateActor(input.actorId),origin=validateActor(input.originatingActorId);
    const payload={kind:'START',productId:input.productId,version:input.version};
    const payloadJson=canonical(payload),payloadDigest=digest(payload),commandId=randomUUID(),attemptId=input.operationId;
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const prior=this.existingRuntimeCommand(actor,input.requestKey,'START',payloadDigest);
      if(prior)return prior;
      if(this.db.prepare('SELECT id FROM runtime_attempts WHERE owner_token=?').get(input.ownerToken))throw new PlatformError('CONFLICT','Runtime attempt owner token cannot be reused');
      const slot=this.db.prepare('SELECT instance_id AS instanceId,operation_id AS operationId,state FROM runtime_physical_slot WHERE singleton=1').get() as {instanceId:string|null;operationId:string|null;state:string};
      if(slot.operationId||slot.instanceId||slot.state!=='EMPTY')throw new PlatformError('CONFLICT','Another managed runtime owns the non-expiring local runtime slot');
      const recoverySlot=this.db.prepare('SELECT operation_id AS operationId,state FROM runtime_recovery_slot WHERE singleton=1').get() as {operationId:string|null;state:string};
      if(recoverySlot.operationId||recoverySlot.state!=='EMPTY')throw new PlatformError('CONFLICT','A private runtime recovery operation owns the non-expiring recovery slot');
      const release=this.db.prepare(`SELECT r.artifact_digest AS artifactDigest,a.product_id AS productId,a.version,a.snapshot_digest AS snapshotDigest,
        a.originating_actor_id AS originatingActorId FROM artifact_releases r JOIN artifacts a ON a.digest=r.artifact_digest
        WHERE r.product_id=? AND r.version=?`).get(input.productId,input.version) as Record<string,string>|undefined;
      if(!release)throw new PlatformError('NOT_FOUND','No promoted local artifact exists for this product version');
      if(release.artifactDigest!==input.artifactDigest||release.snapshotDigest!==input.artifactDigest||release.productId!==input.productId||
          release.version!==input.version||release.originatingActorId!==origin)
        throw new PlatformError('CONFLICT','Promoted artifact identity changed before runtime admission');
      const count=(this.db.prepare('SELECT COUNT(*) AS count FROM runtime_instances').get() as {count:number}).count;
      if(count>=MANAGED_RUNTIME_LIMITS.maxInstances)throw new PlatformError('CONFLICT','Managed runtime instance history is at its fixed capacity');
      const now=Date.now();
      const preparationComplete=input.preparationComplete===false?0:1;
      this.db.prepare(`INSERT INTO runtime_instances(id,product_id,version,artifact_digest,profile_digest,config_digest,adapter_digest,
        toolchain_digest,recipe_digest,originating_actor_id,start_actor_id,state,worker_required,preparation_complete,current_attempt,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,? ,?,'PREPARING',?,?,1,?,?)`).run(input.instanceId,input.productId,input.version,input.artifactDigest,
          input.profileDigest,input.configDigest,input.adapterDigest,input.toolchainDigest,input.recipeDigest,origin,actor,input.workerRequired?1:0,preparationComplete,now,now);
      this.db.prepare(`INSERT INTO runtime_commands(id,instance_id,kind,actor_id,request_key,payload_digest,payload_json,state,created,updated)
        VALUES(?,?,'START',?,?,?,?, 'PREPARING',?,?)`).run(commandId,input.instanceId,actor,input.requestKey,payloadDigest,payloadJson,now,now);
      this.db.prepare(`INSERT INTO runtime_attempts(id,instance_id,attempt_no,command_id,owner_id,owner_token,state,physical_state,worker_required,created,updated)
        VALUES(?,?,1,?,?,?,'PREPARING','NOT_DISPATCHED',?,?,?)`).run(attemptId,input.instanceId,commandId,input.ownerId,input.ownerToken,input.workerRequired?1:0,now,now);
      this.db.prepare(`UPDATE runtime_physical_slot SET instance_id=?,operation_id=?,owner_id=?,owner_token=?,reserved_bytes=?,state='PREPARING',updated=? WHERE singleton=1 AND operation_id IS NULL`)
        .run(input.instanceId,attemptId,input.ownerId,input.ownerToken,input.executionBytes,now);
      const slotAfter=this.db.prepare('SELECT operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get() as {operationId:string|null};
      if(slotAfter.operationId!==attemptId)throw new PlatformError('CONFLICT','Managed runtime slot reservation did not commit');
      this.audit('runtime.start.requested',input.instanceId,{commandId,attempt:1,productId:input.productId,version:input.version,artifactDigest:input.artifactDigest},actor);
      return this.runtimeResult(commandId,input.instanceId,attemptId,input.ownerToken,false);
    });
  }
  beginManagedRuntimeRestart(input:{instanceId:string;operationId:string;ownerId:string;ownerToken:string;actorId:string;requestKey:string;
    profileDigest:string;configDigest:string;adapterDigest:string;toolchainDigest:string;recipeDigest:string;executionBytes:number},authorize:()=>unknown):ManagedRuntimeCommandResult {
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
    if(typeof input.instanceId!=='string'||!managedRuntimeIdPattern.test(input.instanceId)||!uuid.test(input.operationId)||!uuid.test(input.ownerId)||
        !/^[A-Za-z0-9_-]{32,128}$/.test(input.ownerToken)||typeof input.requestKey!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestKey)||
        !hash.test(input.profileDigest)||!hash.test(input.configDigest)||!hash.test(input.adapterDigest)||!hash.test(input.toolchainDigest)||!hash.test(input.recipeDigest)||
        !Number.isSafeInteger(input.executionBytes)||input.executionBytes<1||input.executionBytes>MANAGED_RUNTIME_LIMITS.maxExecutionBytes)
      throw new PlatformError('INVALID','Invalid managed runtime restart command');
    const actor=validateActor(input.actorId),commandId=randomUUID(),attemptId=input.operationId;
    const payload={kind:'RESTART',instanceId:input.instanceId},payloadJson=canonical(payload),payloadDigest=digest(payload);
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const prior=this.existingRuntimeCommand(actor,input.requestKey,'RESTART',payloadDigest);if(prior)return prior;
      if(this.db.prepare('SELECT id FROM runtime_attempts WHERE owner_token=?').get(input.ownerToken))throw new PlatformError('CONFLICT','Runtime attempt owner token cannot be reused');
      const instance=this.runtimeInstanceRow(input.instanceId);
      if(!instance)throw new PlatformError('NOT_FOUND','Managed runtime instance not found');
      if(instance.state!=='STOPPED')throw new PlatformError('CONFLICT','Only a positively stopped exact runtime can restart');
      if(instance.profileDigest!==input.profileDigest||instance.configDigest!==input.configDigest||instance.adapterDigest!==input.adapterDigest||
          instance.toolchainDigest!==input.toolchainDigest||instance.recipeDigest!==input.recipeDigest)
        throw new PlatformError('CONFLICT','The pinned runtime profile or toolchain changed; this exact instance cannot restart');
      const slot=this.db.prepare('SELECT instance_id AS instanceId,operation_id AS operationId,state FROM runtime_physical_slot WHERE singleton=1').get() as {instanceId:string|null;operationId:string|null;state:string};
      if(slot.operationId||slot.instanceId||slot.state!=='EMPTY')throw new PlatformError('CONFLICT','Another managed runtime owns the non-expiring local runtime slot');
      const recoverySlot=this.db.prepare('SELECT operation_id AS operationId,state FROM runtime_recovery_slot WHERE singleton=1').get() as {operationId:string|null;state:string};
      if(recoverySlot.operationId||recoverySlot.state!=='EMPTY')throw new PlatformError('CONFLICT','A private runtime recovery operation owns the non-expiring recovery slot');
      const release=this.db.prepare('SELECT artifact_digest AS artifactDigest FROM artifact_releases WHERE product_id=? AND version=?').get(instance.productId,instance.version) as {artifactDigest:string}|undefined;
      if(!release||release.artifactDigest!==instance.artifactDigest)throw new PlatformError('CONFLICT','The exact promoted artifact is no longer available');
      const attemptNo=Number(instance.currentAttempt)+1,now=Date.now();
      if(attemptNo>1000)throw new PlatformError('CONFLICT','Runtime attempt history is at its fixed limit');
      this.db.prepare('INSERT INTO runtime_commands(id,instance_id,kind,actor_id,request_key,payload_digest,payload_json,state,created,updated) VALUES(?,? ,\'RESTART\',?,?,?,?,\'PREPARING\',?,?)')
        .run(commandId,input.instanceId,actor,input.requestKey,payloadDigest,payloadJson,now,now);
      this.db.prepare(`INSERT INTO runtime_attempts(id,instance_id,attempt_no,command_id,owner_id,owner_token,state,physical_state,worker_required,created,updated)
        VALUES(?,?,?,?,?,?,'PREPARING','NOT_DISPATCHED',?,?,?)`).run(attemptId,input.instanceId,attemptNo,commandId,input.ownerId,input.ownerToken,instance.workerRequired?1:0,now,now);
      this.db.prepare("UPDATE runtime_instances SET state='PREPARING',current_attempt=?,updated=? WHERE id=? AND state='STOPPED'").run(attemptNo,now,input.instanceId);
      this.db.prepare("UPDATE runtime_physical_slot SET instance_id=?,operation_id=?,owner_id=?,owner_token=?,reserved_bytes=?,state='PREPARING',updated=? WHERE singleton=1 AND operation_id IS NULL")
        .run(input.instanceId,attemptId,input.ownerId,input.ownerToken,input.executionBytes,now);
      const slotAfter=this.db.prepare('SELECT operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get() as {operationId:string|null};
      if(slotAfter.operationId!==attemptId)throw new PlatformError('CONFLICT','Managed runtime slot reservation did not commit');
      this.audit('runtime.restart.requested',input.instanceId,{commandId,attempt:attemptNo,artifactDigest:instance.artifactDigest},actor);
      return this.runtimeResult(commandId,input.instanceId,attemptId,input.ownerToken,false);
    });
  }
  private recoveryOperationRow(operationId:string):Record<string,any>|undefined {
    return this.db.prepare(`SELECT id,kind,state,physical_state AS physicalState,instance_id AS instanceId,attempt_id AS attemptId,
      attempt_no AS attempt,command_id AS commandId,product_id AS productId,version,artifact_digest AS artifactDigest,
      originating_actor_id AS originatingActorId,profile_digest AS profileDigest,config_digest AS configDigest,
      adapter_digest AS adapterDigest,toolchain_digest AS toolchainDigest,recipe_digest AS recipeDigest,backup_digest AS backupDigest,
      actor_id AS actorId,request_key AS requestKey,payload_digest AS payloadDigest,owner_id AS ownerId,owner_token AS ownerToken,
      reserved_bytes AS reservedBytes,dispatch_begun AS dispatchBegun,driver_empty AS driverEmpty,driver_closed AS driverClosed,
      publisher_result_observed AS publisherResultObserved,publisher_closed AS publisherClosed,destination_published AS destinationPublished,
      destination_verified AS destinationVerified,empty_observed AS emptyObserved,helper_closed AS helperClosed,
      staging_clean AS stagingClean,captured_at AS capturedAt,error_code AS errorCode,created,updated
      FROM runtime_recovery_operations WHERE id=?`).get(operationId) as Record<string,any>|undefined;
  }
  private recoveryOperationResult(operationId:string,ownerToken:string|null,reused:boolean):ManagedRuntimeRecoveryResult {
    const operation=this.recoveryOperationRow(operationId);
    if(!operation)throw new PlatformError('CONFLICT','Runtime recovery operation disappeared');
    return {operation,operationId,ownerToken,reused};
  }
  private validateRuntimeRecoveryIntent(input:ManagedRuntimeRecoveryIntent):void {
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
    if(!input||!managedRuntimeIdPattern.test(input.instanceId)||!uuid.test(input.operationId)||!uuid.test(input.ownerId)||
       !/^[A-Za-z0-9_-]{32,128}$/.test(input.ownerToken)||!uuid.test(input.attemptId)||!uuid.test(input.commandId)||
       !Number.isSafeInteger(input.attempt)||input.attempt<1||input.attempt>1000||typeof input.productId!=='string'||!/^[a-z][a-z0-9-]{1,47}$/.test(input.productId)||
       typeof input.version!=='string'||!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(input.version)||
       !hash.test(input.artifactDigest)||!hash.test(input.profileDigest)||!hash.test(input.configDigest)||!hash.test(input.adapterDigest)||
       !hash.test(input.toolchainDigest)||!hash.test(input.recipeDigest)||!['BACKUP','RESTORE'].includes(input.kind)||
       typeof input.requestKey!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestKey)||
       !Number.isSafeInteger(input.reservedBytes)||input.reservedBytes<1||input.reservedBytes>MANAGED_RUNTIME_RECOVERY_LIMITS.maxStagingBytes||
       input.kind==='BACKUP'&&input.backupDigest!==undefined||input.kind==='RESTORE'&&(typeof input.backupDigest!=='string'||!hash.test(input.backupDigest)))
      throw new PlatformError('INVALID','Invalid managed runtime recovery intent');
    validateActor(input.actorId);validateActor(input.originatingActorId);
  }
  beginManagedRuntimeRecovery(input:ManagedRuntimeRecoveryIntent,observeCapacity:()=>ManagedRuntimeRecoveryCapacityObservation,authorize:()=>unknown):ManagedRuntimeRecoveryResult {
    this.validateRuntimeRecoveryIntent(input);
    if(typeof observeCapacity!=='function')throw new PlatformError('INVALID','A fresh recovery capacity observation is required');
    const actor=validateActor(input.actorId),payload={kind:input.kind,instanceId:input.instanceId,artifactDigest:input.artifactDigest,
      ...(input.backupDigest?{backupDigest:input.backupDigest}:{})},payloadDigest=digest(payload);
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const prior=this.db.prepare('SELECT id,payload_digest AS payloadDigest FROM runtime_recovery_operations WHERE actor_id=? AND request_key=?').get(actor,input.requestKey) as
        {id:string;payloadDigest:string}|undefined;
      if(prior){if(prior.payloadDigest!==payloadDigest)throw new PlatformError('CONFLICT','Recovery request key is already bound to another immutable operation');
        return this.recoveryOperationResult(prior.id,null,true);}
      if(this.db.prepare('SELECT id FROM runtime_recovery_operations WHERE owner_token=?').get(input.ownerToken))
        throw new PlatformError('CONFLICT','Recovery operation owner token cannot be reused');
      const runtimeSlot=this.db.prepare('SELECT instance_id AS instanceId,operation_id AS operationId,state FROM runtime_physical_slot WHERE singleton=1').get() as
        {instanceId:string|null;operationId:string|null;state:string};
      if(runtimeSlot.instanceId||runtimeSlot.operationId||runtimeSlot.state!=='EMPTY')throw new PlatformError('CONFLICT','A managed runtime still owns its non-expiring physical slot');
      const recoverySlot=this.db.prepare('SELECT operation_id AS operationId,state FROM runtime_recovery_slot WHERE singleton=1').get() as
        {operationId:string|null;state:string};
      if(recoverySlot.operationId||recoverySlot.state!=='EMPTY')throw new PlatformError('CONFLICT','Another recovery operation owns the non-expiring recovery slot');
      const current=this.db.prepare(`SELECT i.id AS instanceId,i.product_id AS productId,i.version,i.artifact_digest AS artifactDigest,
        i.profile_digest AS profileDigest,i.config_digest AS configDigest,i.adapter_digest AS adapterDigest,
        i.toolchain_digest AS toolchainDigest,i.recipe_digest AS recipeDigest,i.originating_actor_id AS originatingActorId,
        i.state AS instanceState,i.current_attempt AS currentAttempt,a.id AS attemptId,a.attempt_no AS attempt,
        a.command_id AS commandId,a.state AS attemptState,a.physical_state AS physicalState,a.dispatch_begun AS dispatchBegun,
        a.empty_observed AS emptyObserved,a.helper_closed AS helperClosed,a.execution_clean AS executionClean,
        a.stop_command_id AS stopCommandId,c.state AS commandState,sc.state AS stopCommandState
        FROM runtime_instances i JOIN runtime_attempts a ON a.instance_id=i.id AND a.attempt_no=i.current_attempt
        JOIN runtime_commands c ON c.id=a.command_id LEFT JOIN runtime_commands sc ON sc.id=a.stop_command_id
        WHERE i.id=?`).get(input.instanceId) as Record<string,any>|undefined;
      if(!current||current.instanceState!=='STOPPED'||current.attemptState!=='STOPPED'||current.physicalState!=='EMPTY'||
         current.currentAttempt!==input.attempt||current.attemptId!==input.attemptId||current.commandId!==input.commandId||
         current.dispatchBegun!==1||current.emptyObserved!==1||current.helperClosed!==1||current.executionClean!==1||
         current.commandState!=='SUCCEEDED'||current.stopCommandId!==null&&current.stopCommandState!=='SUCCEEDED'||
         current.productId!==input.productId||current.version!==input.version||current.artifactDigest!==input.artifactDigest||
         current.originatingActorId!==input.originatingActorId||current.profileDigest!==input.profileDigest||current.configDigest!==input.configDigest||
         current.adapterDigest!==input.adapterDigest||current.toolchainDigest!==input.toolchainDigest||current.recipeDigest!==input.recipeDigest)
        throw new PlatformError('CONFLICT','Recovery requires the exact positively stopped immutable runtime identity');
      const promoted=this.db.prepare('SELECT artifact_digest AS artifactDigest FROM artifact_releases WHERE product_id=? AND version=?').get(input.productId,input.version) as
        {artifactDigest:string}|undefined;
      if(!promoted||promoted.artifactDigest!==input.artifactDigest)throw new PlatformError('CONFLICT','The exact promoted artifact is no longer available');
      if(input.kind==='RESTORE'){
        const backup=this.db.prepare(`SELECT instance_id AS instanceId,artifact_digest AS artifactDigest,product_id AS productId,version,captured_at AS capturedAt,
          originating_actor_id AS originatingActorId,profile_digest AS profileDigest,config_digest AS configDigest,
          adapter_digest AS adapterDigest,toolchain_digest AS toolchainDigest,recipe_digest AS recipeDigest
          FROM runtime_backups WHERE digest=?`).get(input.backupDigest!) as Record<string,any>|undefined;
        if(!backup||backup.capturedAt>Date.now()||backup.instanceId!==input.instanceId||backup.artifactDigest!==input.artifactDigest||backup.productId!==input.productId||
           backup.version!==input.version||backup.originatingActorId!==input.originatingActorId||backup.profileDigest!==input.profileDigest||
           backup.configDigest!==input.configDigest||backup.adapterDigest!==input.adapterDigest||backup.toolchainDigest!==input.toolchainDigest||backup.recipeDigest!==input.recipeDigest)
          throw new PlatformError('CONFLICT','The selected private backup does not belong to this exact runtime identity');
      }
      const capacity=observeCapacity() as unknown;
      if(capacity!==null&&(typeof capacity==='object'||typeof capacity==='function')&&typeof (capacity as any).then==='function')
        throw new PlatformError('INVALID','Recovery capacity observation must be synchronous');
      const measured=capacity as ManagedRuntimeRecoveryCapacityObservation,limits=MANAGED_RUNTIME_RECOVERY_LIMITS;
      if(!measured||![measured.backupBytes,measured.stagingBytes,measured.objectCount,measured.entryCount].every(value=>Number.isSafeInteger(value)&&value>=0)||
         measured.entryCount>MANAGED_RUNTIME_LIMITS.maxMetadataEntries||measured.objectCount>limits.maxObjects||
         measured.stagingBytes+input.reservedBytes>limits.maxStagingBytes||
         measured.backupBytes+measured.stagingBytes+input.reservedBytes>limits.maxTotalBytes||
         input.kind==='BACKUP'&&measured.objectCount+1>limits.maxObjects)
        throw new PlatformError('CONFLICT','Private runtime recovery material exceeds its fixed local capacity');
      this.authorizeMutation(authorize);
      const now=Date.now();
      this.db.prepare(`INSERT INTO runtime_recovery_operations(id,kind,state,physical_state,instance_id,attempt_id,attempt_no,command_id,
        product_id,version,artifact_digest,originating_actor_id,profile_digest,config_digest,adapter_digest,toolchain_digest,recipe_digest,
        backup_digest,actor_id,request_key,payload_digest,owner_id,owner_token,reserved_bytes,created,updated)
        VALUES(?,?,'PREPARING','NOT_DISPATCHED',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?)`).run(
        input.operationId,input.kind,input.instanceId,input.attemptId,input.attempt,input.commandId,input.productId,input.version,input.artifactDigest,
        input.originatingActorId,input.profileDigest,input.configDigest,input.adapterDigest,input.toolchainDigest,input.recipeDigest,input.backupDigest??null,
        actor,input.requestKey,payloadDigest,input.ownerId,input.ownerToken,input.reservedBytes,now,now);
      this.db.prepare(`UPDATE runtime_recovery_slot SET operation_id=?,owner_id=?,owner_token=?,reserved_bytes=?,state='PREPARING',updated=?
        WHERE singleton=1 AND operation_id IS NULL`).run(input.operationId,input.ownerId,input.ownerToken,input.reservedBytes,now);
      const reserved=this.db.prepare('SELECT operation_id AS operationId FROM runtime_recovery_slot WHERE singleton=1').get() as {operationId:string|null};
      if(reserved.operationId!==input.operationId)throw new PlatformError('CONFLICT','Private recovery slot reservation did not commit');
      this.audit(input.kind==='BACKUP'?'runtime.backup.requested':'runtime.restore.requested',input.instanceId,
        {operationId:input.operationId,attempt:input.attempt,artifactDigest:input.artifactDigest,...(input.backupDigest?{backupDigest:input.backupDigest}:{})},actor);
      return this.recoveryOperationResult(input.operationId,input.ownerToken,false);
    });
  }
  private currentRecoveryOwner(operationId:string,ownerToken:string):Record<string,any>|undefined {
    const row=this.recoveryOperationRow(operationId);if(!row)return undefined;
    const slot=this.db.prepare('SELECT operation_id AS operationId,owner_token AS ownerToken,state FROM runtime_recovery_slot WHERE singleton=1').get() as
      {operationId:string|null;ownerToken:string|null;state:string};
    if(row.ownerToken!==ownerToken||slot.operationId!==operationId||slot.ownerToken!==ownerToken||slot.state==='EMPTY')return undefined;
    return row;
  }
  markManagedRuntimeRecoveryDispatch(operationId:string,ownerToken:string,authorize:()=>unknown):Record<string,unknown> {
    return this.transaction(()=>{
      this.authorizeMutation(authorize);const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.state!=='PREPARING'||row.physicalState!=='NOT_DISPATCHED'||row.dispatchBegun!==0)
        throw new PlatformError('CONFLICT','The original recovery operation no longer owns dispatch');
      const now=Date.now();
      this.db.prepare(`UPDATE runtime_recovery_operations SET state='RUNNING',physical_state='DRIVER_RUNNING',dispatch_begun=1,updated=? WHERE id=? AND owner_token=? AND dispatch_begun=0`)
        .run(now,operationId,ownerToken);
      this.db.prepare(`UPDATE runtime_recovery_slot SET state='DRIVER_RUNNING',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?`)
        .run(now,operationId,ownerToken);
      this.audit('runtime.recovery.dispatched',operationId,{kind:row.kind,instanceId:row.instanceId,attempt:row.attempt},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  recordManagedRuntimeRecoveryDriverClosed(operationId:string,ownerToken:string,empty:boolean,closed:boolean):Record<string,unknown> {
    return this.transaction(()=>{
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.dispatchBegun!==1||row.physicalState!=='DRIVER_RUNNING')throw new PlatformError('CONFLICT','The original recovery driver no longer owns its operation');
      const known=empty===true&&closed===true,now=Date.now(),state=known?'STAGED':'UNKNOWN';
      this.db.prepare('UPDATE runtime_recovery_operations SET physical_state=?,driver_empty=?,driver_closed=?,updated=? WHERE id=? AND owner_token=?')
        .run(state,empty?1:0,closed?1:0,now,operationId,ownerToken);
      this.db.prepare('UPDATE runtime_recovery_slot SET state=?,updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?')
        .run(state,now,operationId,ownerToken);
      if(!known)this.db.prepare("UPDATE runtime_recovery_operations SET state='UNKNOWN',error_code='RECOVERY_DRIVER_UNVERIFIED' WHERE id=? AND owner_token=?").run(operationId,ownerToken);
      this.audit(known?'runtime.recovery.driver.closed':'runtime.recovery.unknown',operationId,{emptyObserved:empty,helperClosed:closed},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  markManagedRuntimeRecoveryPublishing(operationId:string,ownerToken:string,authorize:()=>unknown):Record<string,unknown> {
    return this.transaction(()=>{
      this.authorizeMutation(authorize);const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.state!=='RUNNING'||row.physicalState!=='STAGED'||row.driverEmpty!==1||row.driverClosed!==1||row.destinationPublished!==0)
        throw new PlatformError('CONFLICT','The original recovery operation is not ready for no-overwrite publication');
      if(row.kind==='RESTORE'){
        const backup=this.db.prepare('SELECT captured_at AS capturedAt FROM runtime_backups WHERE digest=?').get(row.backupDigest) as {capturedAt:number}|undefined;
        if(!backup||Date.now()<backup.capturedAt)throw new PlatformError('CONFLICT','The local clock is earlier than the selected backup capture time');
      }
      const now=Date.now();
      this.db.prepare("UPDATE runtime_recovery_operations SET physical_state='PUBLISHING',updated=? WHERE id=? AND owner_token=? AND physical_state='STAGED'").run(now,operationId,ownerToken);
      this.db.prepare("UPDATE runtime_recovery_slot SET state='PUBLISHING',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,operationId,ownerToken);
      this.audit('runtime.recovery.publication.requested',operationId,{kind:row.kind,instanceId:row.instanceId},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  recordManagedRuntimeRecoveryPublisherClosed(operationId:string,ownerToken:string,moved:boolean,resultObserved:boolean,closed:boolean):Record<string,unknown> {
    return this.transaction(()=>{
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.physicalState!=='PUBLISHING'||row.driverEmpty!==1||row.driverClosed!==1)
        throw new PlatformError('CONFLICT','The original recovery publisher no longer owns its operation');
      const known=moved===true&&resultObserved===true&&closed===true,noPublication=moved===false&&resultObserved===true&&closed===true,now=Date.now();
      this.db.prepare(`UPDATE runtime_recovery_operations SET physical_state=?,publisher_result_observed=?,publisher_closed=?,
        destination_published=CASE WHEN ?=1 THEN 1 ELSE destination_published END,updated=? WHERE id=? AND owner_token=?`)
        .run(known?'PUBLISHED':noPublication?'NO_PUBLICATION':'UNKNOWN',resultObserved?1:0,closed?1:0,moved?1:0,now,operationId,ownerToken);
      this.db.prepare('UPDATE runtime_recovery_slot SET state=?,updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?')
        .run(known?'PUBLISHED':noPublication?'PUBLISHER_NO_MOVE':'UNKNOWN',now,operationId,ownerToken);
      if(!known&&!noPublication)this.db.prepare("UPDATE runtime_recovery_operations SET state='UNKNOWN',error_code='RECOVERY_PUBLICATION_UNVERIFIED' WHERE id=? AND owner_token=?").run(operationId,ownerToken);
      this.audit(known?'runtime.recovery.destination.published':noPublication?'runtime.recovery.destination.not-published':'runtime.recovery.unknown',operationId,
        {destinationPublished:moved,publisherResultObserved:resultObserved,publisherClosed:closed},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  recordManagedRuntimeRecoveryVerified(operationId:string,ownerToken:string,backupDigest:string|undefined,capturedAt:number|undefined):Record<string,unknown> {
    if(backupDigest!==undefined&&!/^[a-f0-9]{64}$/.test(backupDigest)||capturedAt!==undefined&&(!Number.isSafeInteger(capturedAt)||capturedAt<0))
      throw new PlatformError('INVALID','Invalid verified recovery result identity');
    return this.transaction(()=>{
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.physicalState!=='PUBLISHED'||row.destinationPublished!==1||row.publisherResultObserved!==1||row.publisherClosed!==1||
         row.driverEmpty!==1||row.driverClosed!==1||row.state!=='RUNNING')throw new PlatformError('CONFLICT','Published recovery material lacks exact native owner proof');
      if(row.kind==='BACKUP'&&(!backupDigest||capturedAt===undefined)||row.kind==='RESTORE'&&(backupDigest!==undefined||capturedAt!==undefined))
        throw new PlatformError('INVALID','Recovery verification fields do not match the operation kind');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_recovery_operations SET destination_verified=1,backup_digest=COALESCE(?,backup_digest),captured_at=COALESCE(?,captured_at),physical_state='VERIFIED',updated=? WHERE id=? AND owner_token=?")
        .run(backupDigest??null,capturedAt??null,now,operationId,ownerToken);
      this.db.prepare("UPDATE runtime_recovery_slot SET state='VERIFIED',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,operationId,ownerToken);
      this.audit('runtime.recovery.destination.verified',operationId,{kind:row.kind,backupDigest:backupDigest??row.backupDigest??null},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  completeManagedRuntimeRecovery(operationId:string,ownerToken:string,backup: {
    digest:string;capturedAt:number;sizeBytes:number;fileCount:number;manifest:string;entries:string
  }|undefined,authorize:()=>unknown):Record<string,unknown> {
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.state!=='RUNNING'||row.physicalState!=='VERIFIED'||row.dispatchBegun!==1||row.destinationPublished!==1||
         row.destinationVerified!==1||row.driverEmpty!==1||row.driverClosed!==1||row.publisherResultObserved!==1||row.publisherClosed!==1)
        throw new PlatformError('CONFLICT','Recovery completion lacks verified native publication facts');
      if(row.kind==='BACKUP'){
        if(!backup||backup.digest!==row.backupDigest&&row.backupDigest!==null||backup.capturedAt!==row.capturedAt||
           !/^[a-f0-9]{64}$/.test(backup.digest)||!Number.isSafeInteger(backup.sizeBytes)||backup.sizeBytes<1||backup.sizeBytes>MANAGED_RUNTIME_RECOVERY_LIMITS.maxBackupBytes||
           !Number.isSafeInteger(backup.fileCount)||backup.fileCount<1||backup.fileCount>MANAGED_RUNTIME_RECOVERY_LIMITS.maxFiles||
           Buffer.byteLength(backup.manifest)>MANAGED_RUNTIME_RECOVERY_LIMITS.maxManifestBytes)
          throw new PlatformError('INVALID','Verified backup metadata is outside its fixed bound');
        this.db.prepare(`INSERT INTO runtime_backups(digest,instance_id,attempt_id,attempt_no,command_id,product_id,version,artifact_digest,
          originating_actor_id,profile_digest,config_digest,adapter_digest,toolchain_digest,recipe_digest,captured_at,size_bytes,file_count,
          manifest_json,entries_json,creating_actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(backup.digest,row.instanceId,row.attemptId,row.attempt,row.commandId,row.productId,row.version,row.artifactDigest,row.originatingActorId,
            row.profileDigest,row.configDigest,row.adapterDigest,row.toolchainDigest,row.recipeDigest,backup.capturedAt,backup.sizeBytes,backup.fileCount,
            backup.manifest,backup.entries,row.actorId,Date.now());
      }else if(backup!==undefined)throw new PlatformError('INVALID','Restore completion cannot create backup metadata');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_recovery_operations SET state='SUCCEEDED',physical_state='CLEAN',empty_observed=1,helper_closed=1,staging_clean=1,updated=? WHERE id=? AND owner_token=?")
        .run(now,operationId,ownerToken);
      this.db.prepare("UPDATE runtime_recovery_slot SET operation_id=NULL,owner_id=NULL,owner_token=NULL,reserved_bytes=0,state='EMPTY',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?")
        .run(now,operationId,ownerToken);
      this.audit(row.kind==='BACKUP'?'runtime.backup.created':'runtime.restore.completed',row.instanceId,
        {operationId,attempt:row.attempt,artifactDigest:row.artifactDigest,...(backup?{backupDigest:backup.digest,capturedAt:backup.capturedAt,sizeBytes:backup.sizeBytes,fileCount:backup.fileCount}:{backupDigest:row.backupDigest})},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  failManagedRuntimeRecoveryCleanly(operationId:string,ownerToken:string,errorCode:string):Record<string,unknown> {
    if(typeof errorCode!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode))throw new PlatformError('INVALID','Invalid recovery failure code');
    return this.transaction(()=>{
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.state!=='RUNNING'||row.destinationPublished!==0||row.driverEmpty!==1||row.driverClosed!==1||
         !['STAGED','NO_PUBLICATION'].includes(row.physicalState)||row.physicalState==='NO_PUBLICATION'&&(row.publisherResultObserved!==1||row.publisherClosed!==1))
        throw new PlatformError('CONFLICT','Recovery cleanup lacks positive no-publication ownership proof');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_recovery_operations SET state='FAILED',physical_state='CLEAN',staging_clean=1,error_code=?,empty_observed=1,helper_closed=1,updated=? WHERE id=? AND owner_token=?")
        .run(errorCode,now,operationId,ownerToken);
      this.db.prepare("UPDATE runtime_recovery_slot SET operation_id=NULL,owner_id=NULL,owner_token=NULL,reserved_bytes=0,state='EMPTY',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?")
        .run(now,operationId,ownerToken);
      this.audit('runtime.recovery.failed',operationId,{kind:row.kind,errorCode},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  settleManagedRuntimeRecoveryPreparation(operationId:string,ownerToken:string,proof:{stagingClean:boolean;errorCode:string}):Record<string,unknown> {
    if(!proof||typeof proof!=='object'||proof.stagingClean!==true||typeof proof.errorCode!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(proof.errorCode))
      throw new PlatformError('INVALID','Invalid pre-dispatch recovery cleanup proof');
    return this.transaction(()=>{
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row||row.dispatchBegun!==0||row.physicalState!=='NOT_DISPATCHED'||row.driverEmpty!==0||row.driverClosed!==0||
         row.publisherResultObserved!==0||row.publisherClosed!==0||row.destinationPublished!==0)
        throw new PlatformError('CONFLICT','The original recovery operation cannot prove clean pre-dispatch settlement');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_recovery_operations SET state='FAILED',physical_state='NOT_DISPATCHED_CLEAN',staging_clean=1,error_code=?,updated=? WHERE id=? AND owner_token=? AND dispatch_begun=0")
        .run(proof.errorCode,now,operationId,ownerToken);
      this.db.prepare("UPDATE runtime_recovery_slot SET operation_id=NULL,owner_id=NULL,owner_token=NULL,reserved_bytes=0,state='EMPTY',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?")
        .run(now,operationId,ownerToken);
      this.audit('runtime.recovery.preparation.failed',operationId,{kind:row.kind,errorCode:proof.errorCode,stagingClean:true},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  markManagedRuntimeRecoveryUnknown(operationId:string,ownerToken:string,errorCode:string):Record<string,unknown> {
    if(typeof errorCode!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode))throw new PlatformError('INVALID','Invalid recovery failure code');
    return this.transaction(()=>{
      const row=this.currentRecoveryOwner(operationId,ownerToken);
      if(!row)throw new PlatformError('CONFLICT','Recovery uncertainty cannot alter a successor owner');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_recovery_operations SET state='UNKNOWN',physical_state='UNKNOWN',error_code=?,updated=? WHERE id=? AND owner_token=?")
        .run(errorCode,now,operationId,ownerToken);
      this.db.prepare("UPDATE runtime_recovery_slot SET state='UNKNOWN',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?")
        .run(now,operationId,ownerToken);
      this.audit('runtime.recovery.unknown',operationId,{kind:row.kind,errorCode,destinationPublished:row.destinationPublished===1},row.actorId);
      return this.recoveryOperationRow(operationId)!;
    });
  }
  runtimeRecoveryOperationForRequest(actorId:string,requestKey:string,kind:ManagedRuntimeRecoveryKind,payload:Record<string,unknown>) {
    const actor=validateActor(actorId);
    if(typeof requestKey!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)||!['BACKUP','RESTORE'].includes(kind)||!payload||typeof payload!=='object'||Array.isArray(payload))
      throw new PlatformError('INVALID','Invalid runtime recovery operation lookup');
    const prior=this.db.prepare('SELECT id,payload_digest AS payloadDigest FROM runtime_recovery_operations WHERE actor_id=? AND request_key=?').get(actor,requestKey) as
      {id:string;payloadDigest:string}|undefined;
    if(!prior)return undefined;
    const expected=digest({...payload,kind});if(prior.payloadDigest!==expected)throw new PlatformError('CONFLICT','Recovery request key is already bound to another immutable operation');
    return this.recoveryOperationRow(prior.id);
  }
  runtimeRecoveryOperation(operationId:string) {
    if(typeof operationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))
      throw new PlatformError('INVALID','Invalid runtime recovery operation reference');
    const row=this.recoveryOperationRow(operationId);if(!row)return undefined;
    const {ownerToken:_ownerToken,requestKey:_requestKey,payloadDigest:_payloadDigest,ownerId:_ownerId,...safe}=row;
    return {...safe,dispatchBegun:safe.dispatchBegun===1,driverEmpty:safe.driverEmpty===1,driverClosed:safe.driverClosed===1,
      publisherResultObserved:safe.publisherResultObserved===1,publisherClosed:safe.publisherClosed===1,destinationPublished:safe.destinationPublished===1,
      destinationVerified:safe.destinationVerified===1,emptyObserved:safe.emptyObserved===1,helperClosed:safe.helperClosed===1,stagingClean:safe.stagingClean===1};
  }
  runtimeRecoveryOperations(instanceId:string) {
    if(typeof instanceId!=='string'||!managedRuntimeIdPattern.test(instanceId))throw new PlatformError('INVALID','Invalid runtime recovery owner');
    const rows=this.db.prepare('SELECT id FROM runtime_recovery_operations WHERE instance_id=? ORDER BY created DESC,id DESC LIMIT 100').all(instanceId) as {id:string}[];
    return rows.flatMap(row=>{const operation=this.runtimeRecoveryOperation(row.id);return operation?[operation]:[];});
  }
  runtimeRecoveryBackups(instanceId:string) {
    if(typeof instanceId!=='string'||!managedRuntimeIdPattern.test(instanceId))throw new PlatformError('INVALID','Invalid runtime backup owner');
    return this.db.prepare(`SELECT digest,instance_id AS instanceId,attempt_id AS attemptId,attempt_no AS attempt,product_id AS productId,
      version,artifact_digest AS artifactDigest,profile_digest AS profileDigest,config_digest AS configDigest,
      adapter_digest AS adapterDigest,toolchain_digest AS toolchainDigest,recipe_digest AS recipeDigest,captured_at AS capturedAt,
      size_bytes AS sizeBytes,file_count AS fileCount,creating_actor_id AS creatingActorId,created
      FROM runtime_backups WHERE instance_id=? ORDER BY created DESC,digest LIMIT 32`).all(instanceId) as Record<string,unknown>[];
  }
  runtimeRecoveryBackup(digestValue:string) {
    if(typeof digestValue!=='string'||!/^[a-f0-9]{64}$/.test(digestValue))throw new PlatformError('INVALID','Invalid runtime backup digest');
    return this.db.prepare(`SELECT digest,instance_id AS instanceId,attempt_id AS attemptId,attempt_no AS attempt,command_id AS commandId,
      product_id AS productId,version,artifact_digest AS artifactDigest,originating_actor_id AS originatingActorId,
      profile_digest AS profileDigest,config_digest AS configDigest,adapter_digest AS adapterDigest,
      toolchain_digest AS toolchainDigest,recipe_digest AS recipeDigest,captured_at AS capturedAt,size_bytes AS sizeBytes,
      file_count AS fileCount,manifest_json AS manifest,entries_json AS entries,creating_actor_id AS creatingActorId,created
      FROM runtime_backups WHERE digest=?`).get(digestValue) as Record<string,unknown>|undefined;
  }
  runtimeRecoverySlot() {
    const row=this.db.prepare('SELECT state,reserved_bytes AS reservedBytes,updated FROM runtime_recovery_slot WHERE singleton=1').get() as
      {state:string;reservedBytes:number;updated:number};
    return {...row,occupied:row.state!=='EMPTY'};
  }
  private runtimeOwnerRow(instanceId:string,operationId:string,ownerToken:string) {
    return this.db.prepare(`SELECT i.id,i.state,i.current_attempt AS currentAttempt,c.actor_id AS commandActorId,c.state AS commandState,i.worker_required AS workerRequired,
      i.preparation_complete AS preparationComplete,
      a.id AS attemptId,a.command_id AS commandId,a.state AS attemptState,a.physical_state AS physicalState,a.dispatch_begun AS dispatchBegun,
      a.enrollment_authorized AS enrollmentAuthorized,a.launch_authorized AS launchAuthorized,a.owner_id AS ownerId,
      a.api_ready AS apiReady,a.worker_attached AS workerAttached,a.empty_observed AS emptyObserved,a.helper_closed AS helperClosed,
      a.execution_clean AS executionClean,a.stop_command_id AS stopCommandId,a.stop_actor_id AS stopActorId,
      s.operation_id AS operationId,s.owner_token AS slotOwnerToken
      FROM runtime_instances i JOIN runtime_attempts a ON a.instance_id=i.id AND a.attempt_no=i.current_attempt
      JOIN runtime_commands c ON c.id=a.command_id
      JOIN runtime_physical_slot s ON s.singleton=1 AND s.instance_id=i.id AND s.operation_id=a.id AND s.owner_token=a.owner_token
      WHERE i.id=? AND a.id=? AND a.owner_token=? AND i.current_attempt=a.attempt_no`).get(instanceId,operationId,ownerToken) as Record<string,any>|undefined;
  }
  completeManagedRuntimePreparation(instanceId:string,operationId:string,ownerToken:string,configDigest:string,authorize:()=>unknown) {
    if(typeof configDigest!=='string'||!/^[a-f0-9]{64}$/.test(configDigest)||configDigest==='0'.repeat(64))throw new PlatformError('INVALID','Invalid completed runtime configuration identity');
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.state!=='PREPARING'||row.attemptState!=='PREPARING'||row.physicalState!=='NOT_DISPATCHED'||row.preparationComplete!==0)
        throw new PlatformError('CONFLICT','The original runtime preparation no longer owns its pending configuration');
      const current=this.db.prepare(`SELECT config_digest AS configDigest FROM runtime_instances WHERE id=? AND current_attempt=?`).get(instanceId,row.currentAttempt) as {configDigest:string}|undefined;
      if(!current||current.configDigest!=='0'.repeat(64))throw new PlatformError('CONFLICT','Runtime configuration identity was already completed or changed');
      const now=Date.now();
      this.db.prepare('UPDATE runtime_instances SET config_digest=?,preparation_complete=1,updated=? WHERE id=? AND current_attempt=? AND preparation_complete=0 AND state=\'PREPARING\'')
        .run(configDigest,now,instanceId,row.currentAttempt);
      this.audit('runtime.preparation.completed',instanceId,{attempt:row.currentAttempt,configDigest},row.commandActorId);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  markManagedRuntimeStarting(instanceId:string,operationId:string,ownerToken:string,authorize:()=>unknown) {
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==ownerToken||row.state!=='PREPARING'||row.attemptState!=='PREPARING'||row.preparationComplete!==1||
          row.dispatchBegun!==0||row.physicalState!=='NOT_DISPATCHED')throw new PlatformError('CONFLICT','The original runtime preparation no longer owns dispatch');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_instances SET state='STARTING',updated=? WHERE id=? AND current_attempt=? AND state='PREPARING'").run(now,instanceId,row.currentAttempt);
      this.db.prepare("UPDATE runtime_attempts SET state='STARTING',physical_state='DISPATCHED',dispatch_begun=1,updated=? WHERE id=? AND owner_token=? AND state='PREPARING' AND physical_state='NOT_DISPATCHED' AND dispatch_begun=0").run(now,row.attemptId,ownerToken);
      this.db.prepare("UPDATE runtime_commands SET state='STARTING',updated=? WHERE id=? AND state='PREPARING'").run(now,row.commandId);
      this.db.prepare("UPDATE runtime_physical_slot SET state='STARTING',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,row.attemptId,ownerToken);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  authorizeManagedRuntimeStage(instanceId:string,operationId:string,ownerToken:string,stage:'ENROLLMENT'|'LAUNCH',authorize:()=>unknown) {
    if(stage!=='ENROLLMENT'&&stage!=='LAUNCH')throw new PlatformError('INVALID','Invalid managed runtime authorization stage');
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.state!=='STARTING'||row.attemptState!=='STARTING'||row.commandState!=='STARTING'||row.dispatchBegun!==1||row.physicalState==='NOT_DISPATCHED')
        throw new PlatformError('CONFLICT','The original dispatched runtime attempt no longer owns this authorization stage');
      if(stage==='ENROLLMENT'){
        if(row.enrollmentAuthorized!==0)throw new PlatformError('CONFLICT','Runtime enrollment authorization is already consumed');
        this.db.prepare('UPDATE runtime_attempts SET enrollment_authorized=1,updated=? WHERE id=? AND owner_token=? AND dispatch_begun=1 AND enrollment_authorized=0')
          .run(Date.now(),operationId,ownerToken);
      }else{
        if(row.enrollmentAuthorized!==1||row.launchAuthorized!==0)throw new PlatformError('CONFLICT','Runtime launch is not ready for its one-use authorization');
        this.db.prepare('UPDATE runtime_attempts SET launch_authorized=1,updated=? WHERE id=? AND owner_token=? AND dispatch_begun=1 AND enrollment_authorized=1 AND launch_authorized=0')
          .run(Date.now(),operationId,ownerToken);
      }
      const action=stage==='ENROLLMENT'?'runtime.enrollment.authorized':'runtime.launch.authorized';
      this.audit(action,instanceId,{attempt:row.currentAttempt},row.commandActorId);
      return {stage,attempt:row.currentAttempt};
    });
  }
  recordManagedRuntimeReadiness(instanceId:string,operationId:string,ownerToken:string,facts:{apiReady:boolean;workerAttached:boolean;port:number}) {
    if(typeof facts.apiReady!=='boolean'||typeof facts.workerAttached!=='boolean'||!Number.isInteger(facts.port)||facts.port<1||facts.port>65535)throw new PlatformError('INVALID','Invalid runtime readiness facts');
    return this.transaction(()=>{
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==ownerToken||row.state!=='STARTING'||row.attemptState!=='STARTING'||row.enrollmentAuthorized!==1||row.launchAuthorized!==1)
        throw new PlatformError('CONFLICT','The runtime attempt no longer owns readiness facts or launch authorization');
      if(facts.workerAttached&&row.workerRequired!==1)throw new PlatformError('INVALID','An unselected worker cannot be attached to this runtime');
      const physical=!facts.apiReady?'ROLE_FACTS_PARTIAL':row.workerRequired===0?'API_READY_WORKER_NOT_REQUIRED':facts.workerAttached?'API_READY_WORKER_ATTACHED':'ROLE_FACTS_PARTIAL',now=Date.now();
      this.db.prepare('UPDATE runtime_attempts SET api_ready=?,worker_attached=?,port=?,physical_state=?,updated=? WHERE id=? AND owner_token=? AND state=\'STARTING\'')
        .run(facts.apiReady?1:0,facts.workerAttached?1:0,facts.port,physical,now,row.attemptId,ownerToken);
      this.audit('runtime.readiness.observed',instanceId,{attempt:row.currentAttempt,apiReady:facts.apiReady,workerAttached:facts.workerAttached,port:facts.port},row.commandActorId);
      return {apiReady:facts.apiReady,workerAttached:facts.workerAttached,workerRequired:row.workerRequired===1,physicalState:physical};
    });
  }
  publishManagedRuntimeRunning(instanceId:string,operationId:string,ownerToken:string,authorize:()=>unknown) {
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==ownerToken||row.state!=='STARTING'||row.attemptState!=='STARTING'||
          row.enrollmentAuthorized!==1||row.launchAuthorized!==1||row.apiReady!==1||(row.workerRequired===1&&row.workerAttached!==1))throw new PlatformError('CONFLICT','Runtime readiness or authorization is incomplete or no longer owned');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_instances SET state='RUNNING',updated=? WHERE id=? AND current_attempt=? AND state='STARTING'").run(now,instanceId,row.currentAttempt);
      this.db.prepare("UPDATE runtime_attempts SET state='RUNNING',physical_state=?,updated=? WHERE id=? AND owner_token=? AND state='STARTING'")
        .run(row.workerRequired===1?'API_READY_WORKER_ATTACHED':'API_READY_WORKER_NOT_REQUIRED',now,row.attemptId,ownerToken);
      this.db.prepare("UPDATE runtime_commands SET state='SUCCEEDED',result_json=?,updated=? WHERE id=? AND state IN ('PREPARING','STARTING')")
        .run(canonical({instanceId,state:'RUNNING'}),now,row.commandId);
      this.db.prepare("UPDATE runtime_physical_slot SET state='RUNNING',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,row.attemptId,ownerToken);
      this.audit('runtime.started',instanceId,{attempt:row.currentAttempt,apiReady:true,workerAttached:row.workerAttached===1},row.commandActorId);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  recordManagedRuntimeUnknown(instanceId:string,operationId:string,ownerToken:string,code:string,message:string,physicalState='UNKNOWN') {
    if(typeof code!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)||typeof message!=='string'||message.length>512||
        !['UNKNOWN','ROLE_EXITED','READY_TIMEOUT','CLEANUP_UNKNOWN','AUTH_EXPIRED_AFTER_DISPATCH'].includes(physicalState))throw new PlatformError('INVALID','Invalid runtime uncertainty record');
    const safe='Runtime state is uncertain; native process-tree proof is required';
    return this.transaction(()=>{
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==ownerToken)throw new PlatformError('CONFLICT','Only the original runtime owner can record uncertainty');
      const now=Date.now();
      this.db.prepare("UPDATE runtime_instances SET state='UNKNOWN',updated=? WHERE id=? AND current_attempt=? AND state IN ('PREPARING','STARTING','RUNNING','STOP_REQUESTED','UNKNOWN')").run(now,instanceId,row.currentAttempt);
      this.db.prepare("UPDATE runtime_attempts SET state='UNKNOWN',physical_state=?,error_code=?,error_message=?,updated=? WHERE id=? AND owner_token=?").run(physicalState,code,safe,now,row.attemptId,ownerToken);
      this.db.prepare("UPDATE runtime_commands SET state='UNKNOWN',updated=? WHERE id IN (?,?) AND state NOT IN ('SUCCEEDED','FAILED')").run(now,row.commandId,row.stopCommandId??'');
      this.db.prepare("UPDATE runtime_physical_slot SET state='UNKNOWN',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,row.attemptId,ownerToken);
      this.audit('runtime.unknown',instanceId,{attempt:row.currentAttempt,code,physicalState},row.commandActorId);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  settleManagedRuntimePreparation(instanceId:string,operationId:string,ownerToken:string,proof:{executionClean:boolean;repairRequired:boolean;errorCode:string}) {
    if(!proof||typeof proof.executionClean!=='boolean'||typeof proof.repairRequired!=='boolean'||typeof proof.errorCode!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(proof.errorCode))
      throw new PlatformError('INVALID','Invalid runtime preparation settlement');
    return this.transaction(()=>{
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      const initial=!!row&&row.state==='PREPARING'&&row.attemptState==='PREPARING'&&row.physicalState==='NOT_DISPATCHED';
      const reconciling=!!row&&row.state==='UNKNOWN'&&row.attemptState==='UNKNOWN'&&row.physicalState==='NOT_DISPATCHED_CLEANUP_UNKNOWN';
      if(!row||(!initial&&!reconciling)||row.dispatchBegun!==0||row.commandState==='SUCCEEDED')
        throw new PlatformError('CONFLICT','Only the original undispatched preparation owner can settle this runtime');
      const now=Date.now(),knownClean=proof.executionClean;
      const state=knownClean?(proof.repairRequired?'REPAIR_REQUIRED':'PREPARATION_FAILED'):'UNKNOWN';
      const physicalState=knownClean?'NOT_DISPATCHED':'NOT_DISPATCHED_CLEANUP_UNKNOWN';
      const safe='Runtime preparation did not dispatch; private cleanup or enrollment may require repair';
      this.db.prepare('UPDATE runtime_attempts SET state=?,physical_state=?,execution_clean=MAX(execution_clean,?),error_code=?,error_message=?,updated=?,finished=? WHERE id=? AND owner_token=? AND state=? AND physical_state=?')
        .run(state,physicalState,knownClean?1:0,proof.errorCode,safe,now,knownClean?now:null,row.attemptId,ownerToken,row.attemptState,row.physicalState);
      this.db.prepare('UPDATE runtime_instances SET state=?,updated=? WHERE id=? AND current_attempt=? AND state=?').run(state,now,instanceId,row.currentAttempt,row.state);
      this.db.prepare("UPDATE runtime_commands SET state=?,result_json=?,updated=? WHERE id=? AND state IN ('PREPARING','UNKNOWN')")
        .run(knownClean?'FAILED':'UNKNOWN',canonical({instanceId,state,errorCode:proof.errorCode}),now,row.commandId);
      if(knownClean)this.db.prepare("UPDATE runtime_physical_slot SET instance_id=NULL,operation_id=NULL,owner_id=NULL,owner_token=NULL,reserved_bytes=0,state='EMPTY',updated=? WHERE singleton=1 AND instance_id=? AND operation_id=? AND owner_token=? AND state IN ('PREPARING','UNKNOWN')")
        .run(now,instanceId,operationId,ownerToken);
      else this.db.prepare("UPDATE runtime_physical_slot SET state='UNKNOWN',updated=? WHERE singleton=1 AND instance_id=? AND operation_id=? AND owner_token=?")
        .run(now,instanceId,operationId,ownerToken);
      this.audit('runtime.preparation.failed',instanceId,{attempt:row.currentAttempt,errorCode:proof.errorCode,executionClean:knownClean,repairRequired:proof.repairRequired},row.commandActorId);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  settleManagedRuntimeOwnerExit(instanceId:string,operationId:string,ownerToken:string,proof:{reason:'START_FAILED'|'REQUIRED_ROLE_EXIT'|'OPERATOR_SHUTDOWN';emptyObserved:boolean;helperClosed:boolean;executionClean:boolean;errorCode:string}) {
    if(!proof||!['START_FAILED','REQUIRED_ROLE_EXIT','OPERATOR_SHUTDOWN'].includes(proof.reason)||typeof proof.emptyObserved!=='boolean'||
        typeof proof.helperClosed!=='boolean'||typeof proof.executionClean!=='boolean'||typeof proof.errorCode!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(proof.errorCode))
      throw new PlatformError('INVALID','Invalid runtime owner exit proof');
    const complete=proof.emptyObserved&&proof.helperClosed&&proof.executionClean;
    return this.transaction(()=>{
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.dispatchBegun!==1||row.operationId!==operationId||row.slotOwnerToken!==ownerToken||row.state==='PREPARATION_FAILED'||row.state==='REPAIR_REQUIRED'||row.state==='STOPPED')
        throw new PlatformError('CONFLICT','Only the original dispatched runtime owner can record process exit');
      const now=Date.now(),startAlreadySucceeded=row.commandState==='SUCCEEDED';
      const state=complete?(startAlreadySucceeded?'STOPPED':'REPAIR_REQUIRED'):'UNKNOWN';
      const physicalState=complete?'EMPTY':'UNKNOWN';
      const actor=row.stopActorId??row.commandActorId;
      this.db.prepare('UPDATE runtime_attempts SET state=?,physical_state=?,empty_observed=MAX(empty_observed,?),helper_closed=MAX(helper_closed,?),execution_clean=MAX(execution_clean,?),error_code=?,error_message=?,updated=?,finished=? WHERE id=? AND owner_token=?')
        .run(state,physicalState,proof.emptyObserved?1:0,proof.helperClosed?1:0,proof.executionClean?1:0,complete?proof.errorCode:'RUNTIME_EXIT_UNVERIFIED',
          complete?'The managed runtime owner exited and its process tree was observed empty':'Runtime state is uncertain; native process-tree proof is required',now,complete?now:null,row.attemptId,ownerToken);
      this.db.prepare('UPDATE runtime_instances SET state=?,updated=? WHERE id=? AND current_attempt=?').run(state,now,instanceId,row.currentAttempt);
      if(!startAlreadySucceeded||!complete)this.db.prepare("UPDATE runtime_commands SET state=?,result_json=?,updated=? WHERE id=? AND state NOT IN ('SUCCEEDED','FAILED')")
        .run(complete?'FAILED':'UNKNOWN',canonical({instanceId,state,errorCode:proof.errorCode}),now,row.commandId);
      if(row.stopCommandId)this.db.prepare('UPDATE runtime_commands SET state=?,result_json=?,updated=? WHERE id=? AND state NOT IN (\'SUCCEEDED\',\'FAILED\')')
        .run(complete?'SUCCEEDED':'UNKNOWN',canonical({instanceId,state}),now,row.stopCommandId);
      if(complete)this.db.prepare("UPDATE runtime_physical_slot SET instance_id=NULL,operation_id=NULL,owner_id=NULL,owner_token=NULL,reserved_bytes=0,state='EMPTY',updated=? WHERE singleton=1 AND instance_id=? AND operation_id=? AND owner_token=?")
        .run(now,instanceId,operationId,ownerToken);
      else this.db.prepare("UPDATE runtime_physical_slot SET state='UNKNOWN',updated=? WHERE singleton=1 AND instance_id=? AND operation_id=? AND owner_token=?")
        .run(now,instanceId,operationId,ownerToken);
      const action=!startAlreadySucceeded?'runtime.start.failed':proof.reason==='REQUIRED_ROLE_EXIT'?'runtime.owner.required-role-exit':proof.reason==='OPERATOR_SHUTDOWN'?'runtime.owner.operator-shutdown':'runtime.stop.completed';
      this.audit(action,instanceId,{attempt:row.currentAttempt,reason:proof.reason,emptyObserved:proof.emptyObserved,helperClosed:proof.helperClosed,executionClean:proof.executionClean,errorCode:proof.errorCode},actor);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  requestManagedRuntimeStop(input:{instanceId:string;operationId:string;commandId:string;actorId:string;requestKey:string;ownerToken:string},authorize:()=>unknown):ManagedRuntimeCommandResult {
    if(typeof input.instanceId!=='string'||!managedRuntimeIdPattern.test(input.instanceId)||!/^[0-9a-f-]{36}$/i.test(input.operationId)||!/^[0-9a-f-]{36}$/i.test(input.commandId)||
        !/^[A-Za-z0-9_-]{32,128}$/.test(input.ownerToken)||typeof input.requestKey!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestKey))throw new PlatformError('INVALID','Invalid managed runtime stop request');
    const actor=validateActor(input.actorId),payload={kind:'STOP',instanceId:input.instanceId},payloadJson=canonical(payload),payloadDigest=digest(payload);
    return this.transaction(()=>{
      this.authorizeMutation(authorize);
      const prior=this.existingRuntimeCommand(actor,input.requestKey,'STOP',payloadDigest);if(prior)return prior;
      const row=this.runtimeOwnerRow(input.instanceId,input.operationId,input.ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==input.ownerToken||row.state!=='RUNNING'||row.attemptState!=='RUNNING')throw new PlatformError('CONFLICT','This process does not own a running runtime that can be stopped');
      const now=Date.now();
      this.db.prepare(`INSERT INTO runtime_commands(id,instance_id,kind,actor_id,request_key,payload_digest,payload_json,state,created,updated)
        VALUES(?,?,'STOP',?,?,?,?, 'STOP_REQUESTED',?,?)`).run(input.commandId,input.instanceId,actor,input.requestKey,payloadDigest,payloadJson,now,now);
      this.db.prepare("UPDATE runtime_instances SET state='STOP_REQUESTED',updated=? WHERE id=? AND current_attempt=? AND state='RUNNING'").run(now,input.instanceId,row.currentAttempt);
      this.db.prepare("UPDATE runtime_attempts SET state='STOP_REQUESTED',stop_command_id=?,stop_actor_id=?,updated=? WHERE id=? AND owner_token=? AND state='RUNNING'").run(input.commandId,actor,now,row.attemptId,input.ownerToken);
      this.db.prepare("UPDATE runtime_physical_slot SET state='STOP_REQUESTED',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,row.attemptId,input.ownerToken);
      this.audit('runtime.stop.requested',input.instanceId,{commandId:input.commandId,attempt:row.currentAttempt},actor);
      return this.runtimeResult(input.commandId,input.instanceId,row.attemptId,input.ownerToken,false);
    });
  }
  completeManagedRuntimeStop(instanceId:string,operationId:string,ownerToken:string,proof:{emptyObserved:boolean;helperClosed:boolean;executionClean:boolean;errorCode?:string;errorMessage?:string}) {
    if(!proof||typeof proof!=='object'||typeof proof.emptyObserved!=='boolean'||typeof proof.helperClosed!=='boolean'||typeof proof.executionClean!=='boolean'||
        proof.errorCode!==undefined&&(typeof proof.errorCode!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(proof.errorCode)))throw new PlatformError('INVALID','Invalid runtime stop proof');
    const complete=proof.emptyObserved&&proof.helperClosed&&proof.executionClean;
    const code=proof.errorCode??(complete?'':'CLEANUP_UNKNOWN');
    return this.transaction(()=>{
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==ownerToken||row.state!=='STOP_REQUESTED'&&row.state!=='UNKNOWN'||
          !row.stopCommandId||!row.stopActorId)throw new PlatformError('CONFLICT','Only the original authorized stop owner can settle this runtime');
      const now=Date.now(),newState=complete?'STOPPED':'UNKNOWN';
      this.db.prepare('UPDATE runtime_attempts SET state=?,physical_state=?,empty_observed=MAX(empty_observed,?),helper_closed=MAX(helper_closed,?),execution_clean=MAX(execution_clean,?),error_code=?,error_message=?,updated=?,finished=? WHERE id=? AND owner_token=?')
        .run(newState,proof.emptyObserved&&proof.helperClosed?'EMPTY':'UNKNOWN',proof.emptyObserved?1:0,proof.helperClosed?1:0,proof.executionClean?1:0,complete?null:code||'STOP_UNKNOWN',complete?null:'Runtime stop or owned cleanup proof is incomplete',now,complete?now:null,row.attemptId,ownerToken);
      this.db.prepare('UPDATE runtime_instances SET state=?,updated=? WHERE id=? AND current_attempt=?').run(newState,now,instanceId,row.currentAttempt);
      this.db.prepare('UPDATE runtime_commands SET state=?,result_json=?,updated=? WHERE id=?').run(complete?'SUCCEEDED':'UNKNOWN',canonical({instanceId,state:newState}),now,row.stopCommandId);
      this.db.prepare('UPDATE runtime_physical_slot SET state=?,updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?').run(newState,now,row.attemptId,ownerToken);
      if(complete)this.db.prepare("UPDATE runtime_physical_slot SET instance_id=NULL,operation_id=NULL,owner_id=NULL,owner_token=NULL,reserved_bytes=0,state='EMPTY',updated=? WHERE singleton=1 AND operation_id=? AND owner_token=?").run(now,row.attemptId,ownerToken);
      this.audit(complete?'runtime.stopped':'runtime.stop.unknown',instanceId,{attempt:row.currentAttempt,emptyObserved:proof.emptyObserved,helperClosed:proof.helperClosed,executionClean:proof.executionClean},row.stopActorId);
      return this.runtimeInstanceRow(instanceId);
    });
  }
  recordManagedRuntimeEvent(instanceId:string,operationId:string,ownerToken:string,event:{type:'ROLE_READY'|'API_READY'|'WORKER_ATTACHED'|'STOP_REQUESTED'|'TREE_EMPTY'|'CLEANUP_COMPLETE'|'ROLE_EXITED';role?:'web-backend'|'worker';code?:string}) {
    const allowedRoles=new Set(['web-backend','worker']);
    if(!['ROLE_READY','API_READY','WORKER_ATTACHED','STOP_REQUESTED','TREE_EMPTY','CLEANUP_COMPLETE','ROLE_EXITED'].includes(event.type)||
        event.role!==undefined&&!allowedRoles.has(event.role)||event.code!==undefined&&!/^[A-Z0-9_]{1,48}$/.test(event.code))throw new PlatformError('INVALID','Invalid structured runtime event');
    return this.transaction(()=>{
      const row=this.runtimeOwnerRow(instanceId,operationId,ownerToken);
      if(!row||row.operationId!==row.attemptId||row.slotOwnerToken!==ownerToken)throw new PlatformError('CONFLICT','Runtime event has no current physical owner');
      const prior=this.db.prepare('SELECT public_log AS publicLog FROM runtime_attempts WHERE id=?').get(row.attemptId) as {publicLog:string};
      const line=canonical({at:Date.now(),type:event.type,...(event.role?{role:event.role}:{}),...(event.code?{code:event.code}:{})});
      let lines=`${prior.publicLog}${prior.publicLog?'\n':''}${line}`.split('\n');
      let value=lines.join('\n');while((lines.length>MANAGED_RUNTIME_LIMITS.maxRecentEvents||Buffer.byteLength(value)>MANAGED_RUNTIME_LIMITS.maxLogBytes)&&lines.length>1){lines.shift();value=lines.join('\n');}
      if(Buffer.byteLength(value)>MANAGED_RUNTIME_LIMITS.maxLogBytes)throw new PlatformError('INVALID','Runtime event exceeds its fixed log bound');
      this.db.prepare('UPDATE runtime_attempts SET public_log=?,updated=? WHERE id=? AND owner_token=?').run(value,Date.now(),row.attemptId,ownerToken);
      return true;
    });
  }
  managedRuntime(instanceId:string) {
    if(typeof instanceId!=='string'||!managedRuntimeIdPattern.test(instanceId))throw new PlatformError('INVALID','Invalid managed runtime reference');
    const instance=this.runtimeInstanceRow(instanceId);if(!instance)return undefined;
    const attempts=this.db.prepare(`SELECT id,attempt_no AS attempt,state,physical_state AS physicalState,dispatch_begun AS dispatchBegun,
      enrollment_authorized AS enrollmentAuthorized,launch_authorized AS launchAuthorized,worker_required AS workerRequired,
      api_ready AS apiReady,worker_attached AS workerAttached,port,empty_observed AS emptyObserved,helper_closed AS helperClosed,
      execution_clean AS executionClean,error_code AS errorCode,error_message AS errorMessage,created,updated,finished
      FROM runtime_attempts WHERE instance_id=? ORDER BY attempt_no DESC LIMIT 16`).all(instanceId) as Record<string,any>[];
    return {...instance,workerRequired:instance.workerRequired===1,preparationComplete:instance.preparationComplete===1,attempts:attempts.map(row=>({...row,dispatchBegun:row.dispatchBegun===1,
      enrollmentAuthorized:row.enrollmentAuthorized===1,launchAuthorized:row.launchAuthorized===1,workerRequired:row.workerRequired===1,
      apiReady:row.apiReady===1,workerAttached:row.workerAttached===1,emptyObserved:row.emptyObserved===1,helperClosed:row.helperClosed===1,executionClean:row.executionClean===1}))};
  }
  managedRuntimeAttempt(instanceId:string,operationId:string) {
    if(typeof instanceId!=='string'||!managedRuntimeIdPattern.test(instanceId)||typeof operationId!=='string'||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))
      throw new PlatformError('INVALID','Invalid managed runtime attempt reference');
    const row=this.db.prepare(`SELECT a.id AS id,a.instance_id AS instanceId,a.command_id AS commandId,a.attempt_no AS attempt,
      a.state AS state,a.physical_state AS physicalState,a.dispatch_begun AS dispatchBegun,a.empty_observed AS emptyObserved,
      a.helper_closed AS helperClosed,a.execution_clean AS executionClean,c.state AS commandState,
      a.stop_command_id AS stopCommandId,sc.state AS stopCommandState
      FROM runtime_attempts a JOIN runtime_instances i ON i.id=a.instance_id JOIN runtime_commands c ON c.id=a.command_id
      LEFT JOIN runtime_commands sc ON sc.id=a.stop_command_id
      WHERE a.id=? AND a.instance_id=?`).get(operationId,instanceId) as Record<string,any>|undefined;
    if(!row)return undefined;
    return {...row,dispatchBegun:row.dispatchBegun===1,emptyObserved:row.emptyObserved===1,
      helperClosed:row.helperClosed===1,executionClean:row.executionClean===1};
  }
  managedRuntimeInstances(limit=MANAGED_RUNTIME_LIMITS.maxRecentEvents) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>MANAGED_RUNTIME_LIMITS.maxRecentEvents)throw new PlatformError('INVALID','Invalid runtime history bound');
    return (this.db.prepare('SELECT id,product_id AS productId,version,artifact_digest AS artifactDigest,profile_digest AS profileDigest,state,worker_required AS workerRequired,current_attempt AS currentAttempt,created,updated FROM runtime_instances ORDER BY created DESC,id LIMIT ?').all(limit) as Record<string,any>[])
      .map(row=>({...row,workerRequired:row.workerRequired===1}));
  }
  managedRuntimeEvents(instanceId:string) {
    const value=this.db.prepare('SELECT public_log AS publicLog FROM runtime_attempts WHERE instance_id=? ORDER BY attempt_no DESC LIMIT 1').get(instanceId) as {publicLog:string}|undefined;
    return value?.publicLog??'';
  }
  managedRuntimeSlot() {
    const row=this.db.prepare('SELECT instance_id AS instanceId,state,reserved_bytes AS reservedBytes,updated FROM runtime_physical_slot WHERE singleton=1').get() as
      {instanceId:string|null;state:string;reservedBytes:number;updated:number};
    return {...row,occupied:row.instanceId!==null};
  }
  putEnvironment(input: EnvironmentSpec, actorId: string) {
    const spec = validateEnvironment(input);
    const actor = validateActor(actorId);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT label,kind,target,region FROM environments WHERE id=?').get(spec.id) as { label: string; kind: string; target: string; region: string | null } | undefined;
      if (existing && existing.label === spec.label && existing.kind === spec.kind && existing.target === spec.target && existing.region === (spec.region ?? null)) return spec;
      this.db.prepare('INSERT INTO environments VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,kind=excluded.kind,target=excluded.target,region=excluded.region,created=excluded.created').run(spec.id, spec.label, spec.kind, spec.target, spec.region ?? null, Date.now());
      this.audit('environment.put', spec.id, spec, actor);
      return spec;
    });
  }
  environments() { return this.db.prepare('SELECT id,label,kind,target,region,created FROM environments ORDER BY kind,id').all(); }
  requestDeployment(environmentId: string, productId: string, version: string, buildId: string, actorId: string) {
    if (typeof environmentId !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(environmentId)) fail('Invalid environment reference');
    if (typeof productId !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(productId) || typeof version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) fail('Invalid deployment product reference');
    if (typeof buildId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(buildId)) throw new PlatformError('INVALID', 'Invalid build id');
    const id = randomUUID(), now = Date.now();
    const payload = { environmentId, productId, version, buildId };
    return this.record(actorId, 'deployment.request', id, payload, () => {
      const environment = this.db.prepare('SELECT id,label,kind,target,region FROM environments WHERE id=?').get(environmentId) as EnvironmentSpec | undefined;
      if (!environment) throw new PlatformError('NOT_FOUND', 'Environment not found');
      validateEnvironment({ ...environment, region: environment.region ?? undefined });
      const product = this.product(productId, version);
      if (!product) throw new PlatformError('NOT_FOUND', 'Product version not found');
      validateProduct(product);
      const build = this.db.prepare('SELECT product_id AS productId,version,state,artifact_digest AS artifactDigest FROM builds WHERE id=?').get(buildId) as { productId: string; version: string; state: string; artifactDigest: string | null } | undefined;
      if (!build) throw new PlatformError('NOT_FOUND', 'Build not found');
      if (build.productId !== productId || build.version !== version) throw new PlatformError('CONFLICT', 'Build does not match the requested product version');
      if (build.state !== 'SUCCEEDED' || typeof build.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(build.artifactDigest)) throw new PlatformError('CONFLICT', 'Build is not successful with a valid artifact digest');
      this.db.prepare('INSERT INTO deployments VALUES(?,?,?,?,?,?,?,?)').run(id, environmentId, productId, version, buildId, 'REQUESTED', now, now);
      return { id, environmentId, productId, version, buildId, state: 'REQUESTED' as DeploymentState };
    });
  }
  deployments() { return this.db.prepare('SELECT id,environment_id AS environmentId,product_id AS productId,version,build_id AS buildId,state,created,updated FROM deployments ORDER BY created DESC,id').all(); }
  putAiPipeline(pipeline: AiPipeline, actorId: string) {
    const plan = planAiPipeline(pipeline);
    const spec = canonical(pipeline);
    const actor = validateActor(actorId);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT spec FROM ai_pipelines WHERE id=? AND version=?').get(pipeline.id, pipeline.version) as { spec: string } | undefined;
      if (existing) {
        if (canonical(JSON.parse(existing.spec)) !== spec) throw new PlatformError('CONFLICT', `AI pipeline version ${pipeline.id}@${pipeline.version} is immutable`);
        return plan;
      }
      this.db.prepare('INSERT INTO ai_pipelines VALUES(?,?,?,?,?)').run(pipeline.id, pipeline.version, spec, plan.digest, Date.now());
      this.audit('ai.pipeline.put', `${pipeline.id}@${pipeline.version}`, { digest: plan.digest }, actor);
      return plan;
    });
  }
  aiPipelines() {
    return (this.db.prepare('SELECT id,version,spec,digest,created FROM ai_pipelines ORDER BY id,created DESC').all() as unknown as { id: string; version: string; spec: string; digest: string; created: number }[])
      .map(row => ({ ...row, spec: JSON.parse(row.spec) as AiPipeline }));
  }
  auditLog(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('Invalid audit limit');
    return this.db.prepare('SELECT id,action,subject,payload,at,actor_id AS actorId FROM audit ORDER BY id DESC LIMIT ?').all(limit);
  }
  close() { this.db.close(); }
}
