import { PlatformError, canonical, type JobState, type ModuleManifest } from '@quadbridge/contracts';
import { SqliteOwner, JobQueue } from '@quadbridge/sqlite';
import type { HostedModule, ModuleEnvironment } from '@quadbridge/backend-host';
import type { JobHandler, RequestContext } from '@quadbridge/contracts';
import type { OperationDescriptor, OperationRegistration } from '@quadbridge/contracts/operations';
import { randomUUID } from 'node:crypto';
import { object, id, integer } from '@quadbridge/contracts';
import { JOB_KIND, PROFILE_ID, REQUEST_SCHEMA, RESULT_SCHEMA, type AnalysisPorts, type AnalysisRequest, type AnalysisResult, type AnalysisScope, type SourceIdentity } from './protocol.js';
import type { SourceView } from '@quadbridge/veyviz-sources/protocol';

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
interface AnalysisRow {
  id: string; tenant: string; product_id: string; instance_id: string; actor_id: string; actor_kind: 'user' | 'service';
  command_id: string; source_id: string; source_version: number; fixture_id: 'mivia-vid0062'; profile_id: typeof PROFILE_ID;
  frame_count: number; sample_stride: number; job_id: string; created: number; review_state: 'OPEN' | 'REVIEWED' | 'DISMISSED';
  review_actor: string | null; reviewed_at: number | null; result_json: string | null;
}
interface QueueItem { id: string; jobId: string; sourceId: string; sourceVersion: number; jobState: JobState; reviewState: AnalysisRow['review_state']; created: number; sampleCount: number; detectionCount: number; coverage: 'UNCOMMISSIONED_RECORDING' | 'UNKNOWN'; occupancy: 'UNKNOWN' }
interface QueuePayload {
  analysisId: string; commandId: string; scope: AnalysisScope; requestId: string; sourceId: string; sourceVersion: number;
  fixtureId: 'mivia-vid0062'; profileId: typeof PROFILE_ID; frameCount: number; sampleStride: number;
}

export const operationDescriptors: OperationDescriptor[] = [
  { id: 'veyviz-analysis.analysis.list', version: 1, title: 'List analyses', description: 'List analysis jobs and accepted-result summaries for the current tenant.', permission: 'veyviz.analysis.read', kind: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { items: { type: 'array', maxItems: 25, items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 }, jobId: { type: 'string', minLength: 1, maxLength: 128 }, sourceId: { type: 'string', minLength: 1, maxLength: 128 }, sourceVersion: { type: 'integer', minimum: 1 },
      jobState: { type: 'string', enum: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'CANCELLED', 'SUCCEEDED', 'FAILED'] }, reviewState: { type: 'string', enum: ['OPEN', 'REVIEWED', 'DISMISSED'] },
      created: { type: 'integer', minimum: 0 }, sampleCount: { type: 'integer', minimum: 0, maximum: 6 }, detectionCount: { type: 'integer', minimum: 0, maximum: 600 },
      coverage: { type: 'string', enum: ['UNCOMMISSIONED_RECORDING', 'UNKNOWN'] }, occupancy: { type: 'string', enum: ['UNKNOWN'] }
    }, required: ['id', 'jobId', 'sourceId', 'sourceVersion', 'jobState', 'reviewState', 'created', 'sampleCount', 'detectionCount', 'coverage', 'occupancy'], additionalProperties: false } } }, required: ['items'], additionalProperties: false } },
  { id: 'veyviz-analysis.analysis.submit', version: 1, title: 'Submit recorded analysis', description: 'Queue bounded local RF-DETR analysis for an authorized registered source.', permission: 'veyviz.analysis.write', kind: 'write',
    inputSchema: { type: 'object', properties: { sourceId: { type: 'string', minLength: 1, maxLength: 128 }, frameCount: { type: 'integer', minimum: 1, maximum: 6 }, sampleStride: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['sourceId', 'frameCount', 'sampleStride'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, jobId: { type: 'string', minLength: 1, maxLength: 128 }, state: { type: 'string', enum: ['QUEUED'] } }, required: ['id', 'jobId', 'state'], additionalProperties: false } },
  { id: 'veyviz-analysis.analysis.cancel', version: 1, title: 'Cancel analysis', description: 'Request cancellation and report the durable job state for an owned analysis.', permission: 'veyviz.analysis.write', kind: 'write',
    inputSchema: { type: 'object', properties: { analysisId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['analysisId'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, jobState: { type: 'string', enum: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'CANCELLED', 'SUCCEEDED', 'FAILED'] } }, required: ['id', 'jobState'], additionalProperties: false } },
  { id: 'veyviz-analysis.analysis.review', version: 1, title: 'Record result review', description: 'Record a human review state for an already accepted analysis result.', permission: 'veyviz.analysis.write', kind: 'write',
    inputSchema: { type: 'object', properties: { analysisId: { type: 'string', minLength: 1, maxLength: 128 }, decision: { type: 'string', enum: ['REVIEWED', 'DISMISSED'] } }, required: ['analysisId', 'decision'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, decision: { type: 'string', enum: ['REVIEWED', 'DISMISSED'] }, reviewedAt: { type: 'integer', minimum: 0 } }, required: ['id', 'decision', 'reviewedAt'], additionalProperties: false } }
];

function boundedResult(value: unknown): AnalysisResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError('INCOMPATIBLE', 'AI result is not an object');
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) throw new PlatformError('INCOMPATIBLE', 'AI result exceeds the accepted result budget');
  const result = value as AnalysisResult;
  if (result.schema !== RESULT_SCHEMA || result.status !== 'SUCCEEDED' || result.coverage !== 'UNCOMMISSIONED_RECORDING' || result.occupancy !== 'UNKNOWN' ||
      result.cleanup?.sourceClosed !== true || result.cleanup?.inferenceClosed !== true || result.cleanup.retainedBytes !== 0 || result.cleanup.outstandingLeases !== 0 ||
      !Array.isArray(result.samples) || result.samples.length < 1 || result.samples.length > 6)
    throw new PlatformError('INCOMPATIBLE', 'AI result is not eligible for Product acceptance');
  return result;
}

function rowFor(store: SqliteOwner, ctx: RequestContext, analysisId: string): AnalysisRow {
  ctx.assertAllowed('veyviz.analysis.read', 'read');
  const row = store.db.prepare('SELECT * FROM analysis_requests WHERE tenant=? AND id=?').get(ctx.tenantId, id(analysisId)) as unknown as AnalysisRow | undefined;
  if (!row) throw new PlatformError('NOT_FOUND', 'Analysis not found');
  return row;
}

function listItems(store: SqliteOwner, queue: JobQueue, ctx: RequestContext, sourceCurrent: (ctx: RequestContext, sourceId: string) => SourceView) {
  ctx.assertAllowed('veyviz.analysis.read', 'read');
  const rows = store.db.prepare('SELECT * FROM analysis_requests WHERE tenant=? ORDER BY created DESC,id LIMIT 25').all(ctx.tenantId) as unknown as AnalysisRow[];
  return rows.map(row => {
    const job = queue.get(row.job_id);
    if (!job || job.tenant !== ctx.tenantId) throw new PlatformError('INCOMPATIBLE', 'Analysis job ownership record is missing');
    const result = row.result_json ? JSON.parse(row.result_json) as AnalysisResult : undefined;
    // Current source metadata can become unavailable independently; preserve the accepted result and
    // leave stale-source review visible through its captured version rather than leaking other tenants.
    let sourceChanged = false;
    try { sourceChanged = sourceCurrent(ctx, row.source_id).version !== row.source_version; }
    catch (error) { if (error instanceof PlatformError && error.code === 'NOT_FOUND') sourceChanged = true; else throw error; }
    return { id: row.id, jobId: row.job_id, sourceId: row.source_id, sourceVersion: row.source_version, jobState: job.state, reviewState: row.review_state, created: row.created,
      sampleCount: result?.samples.length ?? 0, detectionCount: result?.samples.reduce((sum, sample) => sum + sample.detections.length, 0) ?? 0,
      coverage: result?.coverage ?? 'UNKNOWN', occupancy: 'UNKNOWN' as const, sourceChanged };
  });
}

export function createAnalysis(manifest: ModuleManifest, store: SqliteOwner, ports: AnalysisPorts): HostedModule & { queue: JobQueue; handlers: JobHandler[] } {
  store.migrate([{ version: 1, sql: `CREATE TABLE analysis_requests(id TEXT NOT NULL,tenant TEXT NOT NULL,product_id TEXT NOT NULL,instance_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','service')),command_id TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,fixture_id TEXT NOT NULL,profile_id TEXT NOT NULL,frame_count INTEGER NOT NULL,sample_stride INTEGER NOT NULL,job_id TEXT NOT NULL,created INTEGER NOT NULL,review_state TEXT NOT NULL DEFAULT 'OPEN' CHECK(review_state IN ('OPEN','REVIEWED','DISMISSED')),review_actor TEXT,reviewed_at INTEGER,result_json TEXT,PRIMARY KEY(tenant,id),UNIQUE(tenant,actor_id,actor_kind,command_id),UNIQUE(job_id)); CREATE INDEX analysis_requests_tenant_created ON analysis_requests(tenant,created DESC);` }], manifest.schema);
  const queue = new JobQueue(store);

  const submit = (ctx: RequestContext, input: unknown, commandId?: string) => {
    ctx.assertAllowed('veyviz.analysis.write', 'write');
    const body = object(input, ['sourceId', 'frameCount', 'sampleStride']);
    const command = id(commandId);
    const sourceId = id(body.sourceId), frameCount = integer(body.frameCount, 1, 6), sampleStride = integer(body.sampleStride, 1, 30);
    // Resolve through the source owner's public service before entering our transaction.
    const source = ports.sources.get(ctx, sourceId);
    // The idempotency digest is the caller's normalized payload. Source version is immutable
    // context captured only for a first execution, so replay of the original key stays a replay.
    const inputValue = { sourceId, frameCount, sampleStride };
    return store.command(ctx, 'veyviz.analysis.submit', command, inputValue, 'veyviz.analysis.write', () => {
      const analysisId = randomUUID();
      const scope: AnalysisScope = { productId: ctx.productId, instanceId: ctx.instanceId, tenantId: ctx.tenantId, actorId: ctx.actor.id, actorKind: ctx.actor.kind };
      const payload: QueuePayload = { analysisId, commandId: command, scope, requestId: ctx.requestId, sourceId, sourceVersion: source.version, fixtureId: source.fixtureId, profileId: PROFILE_ID, frameCount, sampleStride };
      const job = queue.enqueue(ctx, JOB_KIND, command, payload, 'veyviz.analysis.write');
      store.db.prepare('INSERT INTO analysis_requests(id,tenant,product_id,instance_id,actor_id,actor_kind,command_id,source_id,source_version,fixture_id,profile_id,frame_count,sample_stride,job_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(analysisId, ctx.tenantId, ctx.productId, ctx.instanceId, ctx.actor.id, ctx.actor.kind, command, source.id, source.version, source.fixtureId, PROFILE_ID, frameCount, sampleStride, job.id, Date.now());
      return { id: analysisId, jobId: job.id, state: 'QUEUED' as const };
    });
  };

  const cancel = (ctx: RequestContext, input: unknown, commandId?: string) => {
    ctx.assertAllowed('veyviz.analysis.write', 'write');
    const body = object(input, ['analysisId']), analysisId = id(body.analysisId), row = rowFor(store, ctx, analysisId);
    return store.command(ctx, 'veyviz.analysis.cancel', commandId, { analysisId }, 'veyviz.analysis.write', () => ({ id: analysisId, jobState: queue.cancel(ctx, row.job_id) }));
  };
  const review = (ctx: RequestContext, input: unknown, commandId?: string) => {
    ctx.assertAllowed('veyviz.analysis.write', 'write');
    const body = object(input, ['analysisId', 'decision']), analysisId = id(body.analysisId);
    if (body.decision !== 'REVIEWED' && body.decision !== 'DISMISSED') throw new PlatformError('INVALID', 'Unsupported review decision');
    const decision = body.decision;
    rowFor(store, ctx, analysisId);
    return store.command(ctx, 'veyviz.analysis.review', commandId, { analysisId, decision }, 'veyviz.analysis.write', () => {
      const row = rowFor(store, ctx, analysisId), job = queue.get(row.job_id);
      if (!row.result_json || job?.state !== 'SUCCEEDED') throw new PlatformError('CONFLICT', 'Only an accepted result can be reviewed');
      const reviewedAt = Date.now();
      store.db.prepare('UPDATE analysis_requests SET review_state=?,review_actor=?,reviewed_at=? WHERE tenant=? AND id=?').run(decision, `${ctx.actor.kind}:${ctx.actor.id}`, reviewedAt, ctx.tenantId, analysisId);
      return { id: analysisId, decision, reviewedAt };
    });
  };

  const handlers: JobHandler[] = [{ kind: JOB_KIND, async prepare(rawPayload, jobctx) {
    const payload = object(rawPayload, ['analysisId', 'commandId', 'scope', 'requestId', 'sourceId', 'sourceVersion', 'fixtureId', 'profileId', 'frameCount', 'sampleStride']) as unknown as QueuePayload;
    const analysisId = id(payload.analysisId), commandId = id(payload.commandId), sourceId = id(payload.sourceId);
    const scopeRaw = object(payload.scope, ['productId', 'instanceId', 'tenantId', 'actorId', 'actorKind']);
    const scope: AnalysisScope = { productId: id(scopeRaw.productId), instanceId: id(scopeRaw.instanceId), tenantId: id(scopeRaw.tenantId), actorId: id(scopeRaw.actorId), actorKind: scopeRaw.actorKind as 'user' | 'service' };
    if (!['user', 'service'].includes(scope.actorKind) || scope.tenantId !== jobctx.tenantId || payload.profileId !== PROFILE_ID || payload.fixtureId !== 'mivia-vid0062')
      throw new PlatformError('INCOMPATIBLE', 'Queued analysis identity differs from the admitted profile');
    const row = store.db.prepare('SELECT * FROM analysis_requests WHERE tenant=? AND id=? AND job_id=?').get(scope.tenantId, analysisId, jobctx.jobId) as unknown as AnalysisRow | undefined;
    if (!row || row.actor_id !== scope.actorId || row.actor_kind !== scope.actorKind || row.product_id !== scope.productId || row.instance_id !== scope.instanceId || row.command_id !== commandId || row.source_id !== sourceId || row.source_version !== payload.sourceVersion || row.frame_count !== payload.frameCount || row.sample_stride !== payload.sampleStride)
      throw new PlatformError('INCOMPATIBLE', 'Queued analysis no longer matches its Product intent');
    const identity: SourceIdentity = { scope, requestId: id(payload.requestId) };
    await jobctx.assertCurrent();
    const originalSource = ports.sources.getForActor(identity, sourceId, jobctx.signal);
    if (originalSource.version !== row.source_version || originalSource.fixtureId !== row.fixture_id)
      throw new PlatformError('CONFLICT', 'Source changed before inference began');
    const request: AnalysisRequest = { schema: REQUEST_SCHEMA, jobId: jobctx.jobId, commandId, scope: { ...scope }, sourceId,
      sourceVersion: row.source_version, fixtureId: row.fixture_id, profileId: PROFILE_ID, frameCount: row.frame_count, sampleStride: row.sample_stride };
    await jobctx.assertCurrent();
    const result = boundedResult(await ports.runner.run(request, { signal: jobctx.signal, assertCurrent: jobctx.assertCurrent }));
    if (canonical(result.request) !== canonical(request)) throw new PlatformError('INCOMPATIBLE', 'AI result identity does not match the original Product command');
    await jobctx.assertCurrent();
    const currentSource = ports.sources.getForActor(identity, sourceId, jobctx.signal);
    if (currentSource.version !== row.source_version || currentSource.fixtureId !== row.fixture_id)
      throw new PlatformError('CONFLICT', 'Source changed while inference was running');
    const encoded = canonical(result);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) throw new PlatformError('INCOMPATIBLE', 'AI result exceeds the accepted result budget');
    return { commit() {
      // This remains synchronous inside JobQueue.finish's owner transaction. The source owner is
      // called through its public port and rechecks the captured principal; no cross-owner SQL.
      const atCommit = ports.sources.getForActor(identity, sourceId, jobctx.signal);
      if (atCommit.version !== row.source_version || atCommit.fixtureId !== row.fixture_id) throw new PlatformError('CONFLICT', 'Source changed before Product acceptance');
      const stored = store.db.prepare('SELECT result_json,source_version,command_id FROM analysis_requests WHERE tenant=? AND id=? AND job_id=?').get(scope.tenantId, analysisId, jobctx.jobId) as { result_json: string | null; source_version: number; command_id: string } | undefined;
      if (!stored || stored.source_version !== row.source_version || stored.command_id !== commandId) throw new PlatformError('CONFLICT', 'Analysis acceptance target changed');
      if (stored.result_json && stored.result_json !== encoded) throw new PlatformError('CONFLICT', 'Conflicting result for the original analysis');
      store.db.prepare('UPDATE analysis_requests SET result_json=? WHERE tenant=? AND id=? AND job_id=?').run(encoded, scope.tenantId, analysisId, jobctx.jobId);
      return { analysisId, sourceId, sourceVersion: row.source_version, commandId, modelId: result.modelId, sampleCount: result.samples.length, acceptedAt: Date.now(), coverage: result.coverage, occupancy: result.occupancy };
    } };
  } }];

  const operationItems = (ctx: RequestContext) => listItems(store, queue, ctx, (current, sourceId) => ports.sources.get(current, sourceId)).map(({ sourceChanged: _private, ...item }) => item);
  const operations: OperationRegistration[] = [
    { descriptor: operationDescriptors[0]!, handle(ctx) { return { items: operationItems(ctx) }; } },
    { descriptor: operationDescriptors[1]!, handle(ctx, input, key) { return submit(ctx, input, key); } },
    { descriptor: operationDescriptors[2]!, handle(ctx, input, key) { return cancel(ctx, input, key); } },
    { descriptor: operationDescriptors[3]!, handle(ctx, input, key) { return review(ctx, input, key); } }
  ];

  return { manifest, queue, handlers, services: {}, operations, routes: [
    { method: 'GET', path: '/api/analysis/sources', permission: 'veyviz.analysis.read', kind: 'read', handle(ctx) { return { items: ports.sources.list(ctx) }; } },
    { method: 'GET', path: '/api/analysis/readiness', permission: 'veyviz.analysis.read', kind: 'read', async handle(ctx) { ctx.assertAllowed('veyviz.analysis.read', 'read'); return ports.runner.readiness(); } },
    { method: 'GET', path: '/api/analysis', permission: 'veyviz.analysis.read', kind: 'read', handle(ctx) { return { items: listItems(store, queue, ctx, (current, sourceId) => ports.sources.get(current, sourceId)), limit: 25 }; } },
    { method: 'POST', path: '/api/analysis', permission: 'veyviz.analysis.write', kind: 'write', handle(ctx, input, _query, key) { return submit(ctx, input, key); } },
    { method: 'GET', path: '/api/analysis/result', permission: 'veyviz.analysis.read', kind: 'read', handle(ctx, _input, query) {
      const analysisId = id(query.get('analysisId')), row = rowFor(store, ctx, analysisId), job = queue.get(row.job_id);
      if (!job || job.tenant !== ctx.tenantId) throw new PlatformError('NOT_FOUND', 'Analysis not found');
      return { analysisId, jobState: job.state, reviewState: row.review_state, sourceId: row.source_id, sourceVersion: row.source_version, sourceChanged: ports.sources.get(ctx, row.source_id).version !== row.source_version,
        result: row.result_json ? JSON.parse(row.result_json) as AnalysisResult : null };
    } },
    { method: 'POST', path: '/api/analysis/cancel', permission: 'veyviz.analysis.write', kind: 'write', handle(ctx, input, _query, key) { return cancel(ctx, input, key); } },
    { method: 'POST', path: '/api/analysis/review', permission: 'veyviz.analysis.write', kind: 'write', handle(ctx, input, _query, key) { return review(ctx, input, key); } }
  ], close: () => store.close() };
}

export function register(env: ModuleEnvironment) {
  const sources = env.bindings['veyviz.sources.read.v1'] as AnalysisPorts['sources'] | undefined;
  const runner = env.bindings['veyviz.recorded-analysis.run.v1'] as AnalysisPorts['runner'] | undefined;
  if (!sources || !runner) throw new PlatformError('INCOMPATIBLE', 'Analysis source and runner ports must be explicitly bound');
  const ports: AnalysisPorts = { sources, runner };
  return createAnalysis(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id), ports);
}
