import { randomUUID, createHash } from 'node:crypto';
import { SqliteOwner, JobQueue } from '@quadbridge/sqlite';
import { PlatformError, canonical, id, integer, object, type RequestContext, type ModuleManifest, type JobHandler } from '@quadbridge/contracts';
import type { HostedModule, ModuleEnvironment } from '@quadbridge/backend-host';
import { catalog, catalogSync, view, recordingBytes } from './catalog.js';
import { createTemporalRunner } from './runner.js';
import { MediaGateway } from './media.js';
import { RUNNER_SHA256 } from './runner-hash.js';
import { geometry, validateTemporalResult } from './validation.js';
import { createFeatureBridge, processing, runtimeProfile, cosine } from './features.js';
import { ANALYTICS_SQL, adoptAlerts, createAnalytics } from './analytics.js';
import { JOB_KIND, REQUEST_SCHEMA, type Recording, type Source, type TemporalRequest, type TemporalResult, type TemporalRunner, type Processing, type Appearance } from './protocol.js';

export interface Authority { assert(scope: TemporalRequest['scope'], kind: 'read' | 'write'): void; context?(scope: TemporalRequest['scope'], requestId: string, signal: AbortSignal): RequestContext }
interface SourceRow { id: string; tenant: string; version: number; recording_json: string; geometry_json: string }
interface RunRow { id: string; tenant: string; source_id: string; source_version: number; command_id: string; job_id: string; request_json: string; created: number; result_json: string | null }

export function createIntelligence(manifest: ModuleManifest, store: SqliteOwner, authority: Authority, runner = createTemporalRunner(), features = createFeatureBridge()) {
  store.migrate([{ version: 1, sql: `
    CREATE TABLE intelligence_sources(id TEXT NOT NULL,tenant TEXT NOT NULL,version INTEGER NOT NULL,recording_json TEXT NOT NULL,geometry_json TEXT NOT NULL,PRIMARY KEY(tenant,id));
    CREATE TABLE intelligence_runs(id TEXT NOT NULL,tenant TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,command_id TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,request_json TEXT NOT NULL,created INTEGER NOT NULL,result_json TEXT,PRIMARY KEY(tenant,id));
    CREATE TABLE intelligence_appearances(tenant TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,first_ms REAL NOT NULL,last_ms REAL NOT NULL,description TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(tenant,run_id,id));
    CREATE TABLE intelligence_events(tenant TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,position_ms REAL NOT NULL,category TEXT NOT NULL,type TEXT NOT NULL,zone_id TEXT,record_json TEXT NOT NULL,PRIMARY KEY(tenant,run_id,id));
    CREATE INDEX intelligence_events_time ON intelligence_events(tenant,run_id,position_ms,id);
    CREATE TABLE intelligence_visits(tenant TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(tenant,run_id,id));
  ` }, { version: 2, sql: ANALYTICS_SQL }], manifest.schema);
  const queue = new JobQueue(store), media = new MediaGateway();
  const scopeOf = (ctx: RequestContext): TemporalRequest['scope'] => ({ productId: ctx.productId, instanceId: ctx.instanceId, tenantId: ctx.tenantId, actorId: ctx.actor.id, actorKind: ctx.actor.kind });
  const sourceRow = (tenant: string, sourceId: string): SourceRow => {
    const row = store.db.prepare('SELECT * FROM intelligence_sources WHERE tenant=? AND id=?').get(tenant, id(sourceId)) as unknown as SourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Recording source not found'); return row;
  };
  const sourceView = (row: SourceRow): Source => ({ ...view(JSON.parse(row.recording_json)), sourceId: row.id, version: row.version, geometry: JSON.parse(row.geometry_json) });
  const runRow = (ctx: RequestContext, runId: string): RunRow => {
    ctx.assertAllowed('veyviz.intelligence.read', 'read');
    const row = store.db.prepare('SELECT * FROM intelligence_runs WHERE tenant=? AND id=?').get(ctx.tenantId, id(runId)) as unknown as RunRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Analysis run not found'); return row;
  };
  const currentRecording = async (tenant: string, row: SourceRow): Promise<Recording> => {
    const captured = JSON.parse(row.recording_json) as Recording;
    const current = (await catalog()).find(r => r.tenantId === tenant && r.id === captured.id);
    if (!current || canonical(current) !== canonical(captured)) throw new PlatformError('CONFLICT', 'Recording admission changed; register a new source');
    return current;
  };
  const accepted = (ctx: RequestContext, query: URLSearchParams) => {
    const row = runRow(ctx, id(query.get('runId')));
    if (!row.result_json) throw new PlatformError('CONFLICT', 'Analysis has no accepted temporal result'); return row;
  };
  const analytics = createAnalytics(store, runRow);
  const enqueue = (ctx: RequestContext, source: SourceRow, commandId: string, startMs: number, endMs: number, sampleIntervalMs: number, selected?: Processing) => {
    const recording = JSON.parse(source.recording_json) as Recording, runId = randomUUID();
    const request: TemporalRequest = { schema: REQUEST_SCHEMA, jobId: '', runId, commandId, scope: scopeOf(ctx), sourceId: source.id, sourceVersion: source.version, recordingId: recording.id, sourceSha256: recording.sha256, pipelineSha256: RUNNER_SHA256, startMs, endMs, sampleIntervalMs, geometry: JSON.parse(source.geometry_json), ...(selected ? { processing: selected } : {}) };
    const job = queue.enqueue(ctx, JOB_KIND, commandId, { request }, 'veyviz.intelligence.write', 25 * 60 * 1000); request.jobId = job.id;
    store.db.prepare('INSERT INTO intelligence_runs VALUES(?,?,?,?,?,?,?,?,?)').run(runId, ctx.tenantId, source.id, source.version, commandId, job.id, canonical(request), Date.now(), null);
    return { runId, jobId: job.id, state: 'QUEUED' };
  };
  const windowInput = (body: Record<string, unknown>) => {
    const startMs = integer(body.startMs ?? 0, 0, 86400000), endMs = integer(body.endMs, 1, 86400000), sampleIntervalMs = integer(body.sampleIntervalMs, 250, 2000);
    if (endMs <= startMs || endMs - startMs > 120000 || Math.ceil((endMs - startMs) / sampleIntervalMs) > 240) throw new PlatformError('INVALID', 'Select at most 120 seconds and 240 sampled frames');
    const selected = body.processing === undefined ? undefined : processing(body.processing);
    return { startMs, endMs, sampleIntervalMs, ...(selected ? { selected } : {}) };
  };
  const cloneSource = (tenant: string, recording: Recording, template: SourceRow) => {
    const sourceId = randomUUID(); store.db.prepare('INSERT INTO intelligence_sources VALUES(?,?,?,?,?)').run(sourceId, tenant, 1, canonical(recording), template.geometry_json);
    store.db.prepare('INSERT INTO intelligence_families VALUES(?,?,?)').run(tenant, sourceId, template.id); return sourceRow(tenant, sourceId);
  };
  const handlers: JobHandler[] = [{ kind: JOB_KIND, async prepare(raw, jobctx) {
    const payload = object(raw, ['request']) as unknown as { request: TemporalRequest };
    if (payload.request.jobId !== '') throw new PlatformError('INCOMPATIBLE', 'Queued request must use the assigned job identity');
    const request = { ...payload.request, jobId: jobctx.jobId };
    const row = store.db.prepare('SELECT * FROM intelligence_runs WHERE tenant=? AND id=? AND job_id=?').get(jobctx.tenantId, id(request.runId), jobctx.jobId) as unknown as RunRow | undefined;
    if (!row || request.scope.tenantId !== jobctx.tenantId || request.jobId !== jobctx.jobId || canonical(request) !== row.request_json) throw new PlatformError('INCOMPATIBLE', 'Queued temporal intent changed');
    authority.assert(request.scope, 'write'); await jobctx.assertCurrent();
    const source = sourceRow(row.tenant, row.source_id);
    if (source.version !== row.source_version) throw new PlatformError('CONFLICT', 'Source geometry changed');
    const recording = await currentRecording(row.tenant, source);
    const result = validateTemporalResult(await runner.run(request, recording, { signal: jobctx.signal, assertCurrent: async () => { authority.assert(request.scope, 'write'); await jobctx.assertCurrent(); } }), request);
    await jobctx.assertCurrent(); authority.assert(request.scope, 'write'); await currentRecording(row.tenant, source);
    const encoded = canonical(result);
    return { commit() {
      authority.assert(request.scope, 'write');
      if (request.processing && runtimeProfile().sha256 !== request.processing.runtimeSha256) throw new PlatformError('CONFLICT', 'Intelligence runtime changed before acceptance');
      const admission = catalogSync().find(r => r.tenantId === row.tenant && r.id === recording.id);
      if (!admission || canonical(admission) !== canonical(recording)) throw new PlatformError('CONFLICT', 'Recording admission changed before acceptance');
      if (sourceRow(row.tenant, row.source_id).version !== row.source_version) throw new PlatformError('CONFLICT', 'Source changed before temporal acceptance');
      const stored = store.db.prepare('SELECT result_json FROM intelligence_runs WHERE tenant=? AND id=?').get(row.tenant, row.id) as { result_json: string | null };
      if (stored.result_json && stored.result_json !== encoded) throw new PlatformError('CONFLICT', 'Conflicting temporal result');
      if (!stored.result_json) {
        store.db.prepare('UPDATE intelligence_runs SET result_json=? WHERE tenant=? AND id=?').run(encoded, row.tenant, row.id);
        for (const a of result.appearances) store.db.prepare('INSERT INTO intelligence_appearances VALUES(?,?,?,?,?,?,?)').run(row.tenant, row.id, a.id, a.firstMs, a.lastMs, a.description, canonical(a));
        for (const e of result.events) store.db.prepare('INSERT INTO intelligence_events VALUES(?,?,?,?,?,?,?,?)').run(row.tenant, row.id, e.id, e.positionMs, e.category, e.type, e.zoneId, canonical(e));
        for (const v of result.visits) store.db.prepare('INSERT INTO intelligence_visits VALUES(?,?,?,?)').run(row.tenant, row.id, v.id, canonical(v));
        adoptAlerts(store, row.tenant, row.source_id, row.id, result);
      }
      return { runId: row.id, appearances: result.appearances.length, events: result.events.length, coverage: result.coverage.policy, uniquePeople: null };
    } };
  } }];
  const read = 'veyviz.intelligence.read', write = 'veyviz.intelligence.write';
  const routes: HostedModule['routes'] = [
    { method: 'GET', path: '/api/intelligence/catalog', permission: read, kind: 'read', async handle(ctx) { ctx.assertAllowed(read, 'read'); return { items: (await catalog()).filter(r => r.tenantId === ctx.tenantId).map(view) }; } },
    { method: 'GET', path: '/api/intelligence/sources', permission: read, kind: 'read', handle(ctx, _input, query) {
      ctx.assertAllowed(read, 'read'); const cursor = query.has('cursor') ? id(query.get('cursor')) : '';
      const rows = store.db.prepare('SELECT * FROM intelligence_sources WHERE tenant=? AND id>? ORDER BY id LIMIT 101').all(ctx.tenantId, cursor) as unknown as SourceRow[];
      return { items: rows.slice(0, 100).map(sourceView), nextCursor: rows.length > 100 ? rows[99]!.id : null };
    } },
    { method: 'POST', path: '/api/intelligence/sources', permission: write, kind: 'write', async handle(ctx, input, _query, key) {
      ctx.assertAllowed(write, 'write'); const body = object(input, ['recordingId']), recordingId = id(body.recordingId);
      const recording = (await catalog()).find(r => r.tenantId === ctx.tenantId && r.id === recordingId);
      if (!recording) throw new PlatformError('NOT_FOUND', 'Recording is not admitted for this tenant');
      await recordingBytes(recording); ctx.assertAllowed(write, 'write');
      return store.command(ctx, 'veyviz.intelligence.source', key, { recordingId }, write, () => {
        if (!catalogSync().some(r => canonical(r) === canonical(recording))) throw new PlatformError('CONFLICT', 'Recording admission changed before registration');
        const sourceId = randomUUID(); store.db.prepare('INSERT INTO intelligence_sources VALUES(?,?,?,?,?)').run(sourceId, ctx.tenantId, 1, canonical(recording), canonical({ version: 1, zones: [] })); return sourceView(sourceRow(ctx.tenantId, sourceId));
      });
    } },
    { method: 'POST', path: '/api/intelligence/geometry', permission: write, kind: 'write', handle(ctx, input, _query, key) {
      ctx.assertAllowed(write, 'write'); const body = object(input, ['sourceId', 'geometry']), sourceId = id(body.sourceId), requested = geometry(body.geometry);
      return store.command(ctx, 'veyviz.intelligence.geometry', key, { sourceId, geometry: requested }, write, () => {
        const source = sourceRow(ctx.tenantId, sourceId), current = geometry(JSON.parse(source.geometry_json));
        if (requested.version !== current.version + 1) throw new PlatformError('CONFLICT', 'Reload the current geometry before saving');
        store.db.prepare('UPDATE intelligence_sources SET version=version+1,geometry_json=? WHERE tenant=? AND id=?').run(canonical(requested), ctx.tenantId, sourceId); return sourceView(sourceRow(ctx.tenantId, sourceId));
      });
    } },
    { method: 'POST', path: '/api/intelligence/runs', permission: write, kind: 'write', async handle(ctx, input, _query, key) {
      ctx.assertAllowed(write, 'write'); const body = object(input, ['sourceId', 'startMs', 'endMs', 'sampleIntervalMs', 'processing']);
      const sourceId = id(body.sourceId), { startMs, endMs, sampleIntervalMs, selected } = windowInput(body);
      const source = sourceRow(ctx.tenantId, sourceId); await currentRecording(ctx.tenantId, source); ctx.assertAllowed(write, 'write');
      return store.command(ctx, 'veyviz.intelligence.run', key, { sourceId, startMs, endMs, sampleIntervalMs, ...(selected ? { processing: selected } : {}) }, write, () => {
        if (sourceRow(ctx.tenantId, sourceId).version !== source.version) throw new PlatformError('CONFLICT', 'Source changed before submission');
        return enqueue(ctx, source, id(key), startMs, endMs, sampleIntervalMs, selected);
      });
    } },
    { method: 'GET', path: '/api/intelligence/runs', permission: read, kind: 'read', handle(ctx, _input, query) {
      ctx.assertAllowed(read, 'read'); let before = Number.MAX_SAFE_INTEGER, afterId = '';
      if (query.has('cursor')) { try { const cursor = object(JSON.parse(Buffer.from(query.get('cursor')!, 'base64url').toString()), ['created', 'id']); before = integer(cursor.created, 0, Number.MAX_SAFE_INTEGER); afterId = id(cursor.id); } catch { throw new PlatformError('INVALID', 'Invalid runs cursor'); } }
      const rows = store.db.prepare('SELECT * FROM intelligence_runs WHERE tenant=? AND (created<? OR (created=? AND id>?)) ORDER BY created DESC,id LIMIT 101').all(ctx.tenantId, before, before, afterId) as unknown as RunRow[];
      return { items: rows.slice(0, 100).map(row => ({ runId: row.id, sourceId: row.source_id, sourceVersion: row.source_version, created: row.created, state: queue.get(row.job_id)?.state, accepted: row.result_json !== null })), nextCursor: rows.length > 100 ? Buffer.from(JSON.stringify({ created: rows[99]!.created, id: rows[99]!.id })).toString('base64url') : null };
    } },
    { method: 'GET', path: '/api/intelligence/run', permission: read, kind: 'read', handle(ctx, _input, query) {
      const row = runRow(ctx, id(query.get('runId'))), result = row.result_json ? JSON.parse(row.result_json) as TemporalResult : null;
      const job = queue.get(row.job_id);
      return { runId: row.id, sourceId: row.source_id, sourceChanged: sourceRow(ctx.tenantId, row.source_id).version !== row.source_version, state: job?.state, error: job?.state === 'FAILED' ? 'Analysis failed; inspect the local source/model profile or submit a fresh run.' : null, request: JSON.parse(row.request_json), result };
    } },
    { method: 'POST', path: '/api/intelligence/cancel', permission: write, kind: 'write', handle(ctx, input, _query, key) { const body = object(input, ['runId']), row = runRow(ctx, id(body.runId)); return store.command(ctx, 'veyviz.intelligence.cancel', key, { runId: row.id }, write, () => ({ runId: row.id, state: queue.cancel(ctx, row.job_id) })); } },
    { method: 'GET', path: '/api/intelligence/events', permission: read, kind: 'read', handle(ctx, _input, query) {
      const row = accepted(ctx, query), fromMs = integer(Number(query.get('fromMs') ?? 0), 0, 86400000), toMs = integer(Number(query.get('toMs') ?? 86400000), 1, 86400000), limit = integer(Number(query.get('limit') ?? 100), 1, 100);
      const category = query.get('category') ?? '', type = query.get('type') ?? '', zoneId = query.get('zoneId') ?? '';
      if (!['', 'person', 'vehicle', 'animal'].includes(category) || !['', 'presence', 'zone_entered', 'zone_exited'].includes(type) || toMs <= fromMs) throw new PlatformError('INVALID', 'Unsupported event filter');
      let cursorMs = -1, cursorId = '';
      if (query.has('cursor')) { let cursor; try { cursor = object(JSON.parse(Buffer.from(query.get('cursor')!, 'base64url').toString()), ['runId', 'fromMs', 'toMs', 'category', 'type', 'zoneId', 'positionMs', 'id']); } catch { throw new PlatformError('INVALID', 'Invalid event cursor'); }
        if (cursor.runId !== row.id || cursor.fromMs !== fromMs || cursor.toMs !== toMs || cursor.category !== category || cursor.type !== type || cursor.zoneId !== zoneId || typeof cursor.positionMs !== 'number' || !Number.isFinite(cursor.positionMs)) throw new PlatformError('INVALID', 'Cursor belongs to another event query'); cursorMs = cursor.positionMs; cursorId = id(cursor.id); }
      const rows = store.db.prepare('SELECT * FROM intelligence_events WHERE tenant=? AND run_id=? AND position_ms>=? AND position_ms<? AND (?=\'\' OR category=?) AND (?=\'\' OR type=?) AND (?=\'\' OR zone_id=?) AND (position_ms>? OR (position_ms=? AND id>?)) ORDER BY position_ms,id LIMIT ?').all(ctx.tenantId, row.id, fromMs, toMs, category, category, type, type, zoneId, zoneId, cursorMs, cursorMs, cursorId, limit + 1) as { record_json: string; position_ms: number; id: string }[];
      const page = rows.slice(0, limit), last = page.at(-1);
      return { runId: row.id, items: page.map(e => JSON.parse(e.record_json)), nextCursor: rows.length > limit && last ? Buffer.from(canonical({ runId: row.id, fromMs, toMs, category, type, zoneId, positionMs: last.position_ms, id: last.id })).toString('base64url') : null };
    } },
    { method: 'GET', path: '/api/intelligence/timeline', permission: read, kind: 'read', handle(ctx, _input, query) {
      const row = accepted(ctx, query), result = JSON.parse(row.result_json!) as TemporalResult;
      const bucketMs = integer(Number(query.get('bucketMs') ?? 1000), 250, 60000);
      const buckets = new Map<number, { startMs: number; presence: number; zoneEntered: number; zoneExited: number }>();
      for (const e of result.events) { const startMs = Math.floor(e.positionMs / bucketMs) * bucketMs, bucket = buckets.get(startMs) ?? { startMs, presence: 0, zoneEntered: 0, zoneExited: 0 }; bucket[e.type === 'presence' ? 'presence' : e.type === 'zone_entered' ? 'zoneEntered' : 'zoneExited']++; buckets.set(startMs, bucket); }
      return { runId: row.id, buckets: [...buckets.values()].sort((a, b) => a.startMs - b.startMs), coverage: result.coverage, appearances: result.appearances.length, zoneEntries: result.events.filter(e => e.type === 'zone_entered').length, uniquePeople: null, occupancy: 'UNKNOWN', geometryVersion: result.request.geometry.version };
    } },
    { method: 'GET', path: '/api/intelligence/visits', permission: read, kind: 'read', handle(ctx, _input, query) { const row = accepted(ctx, query); return { runId: row.id, items: (store.db.prepare('SELECT record_json FROM intelligence_visits WHERE tenant=? AND run_id=? ORDER BY id LIMIT 256').all(ctx.tenantId, row.id) as { record_json: string }[]).map(v => JSON.parse(v.record_json)) }; } },
    { method: 'GET', path: '/api/intelligence/search', permission: read, kind: 'read', handle(ctx, _input, query) {
      const row = accepted(ctx, query), q = query.get('q') ?? ''; if (q.length > 160) throw new PlatformError('INVALID', 'Search exceeds its budget');
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      return { runId: row.id, mode: 'STRUCTURED_TEXT', items: (store.db.prepare("SELECT record_json FROM intelligence_appearances WHERE tenant=? AND run_id=? AND description LIKE ? ESCAPE '\\' ORDER BY first_ms,id LIMIT 32").all(ctx.tenantId, row.id, `%${escaped}%`) as { record_json: string }[]).map(a => JSON.parse(a.record_json)) };
    } },
    { method: 'GET', path: '/api/intelligence/capabilities', permission: read, kind: 'read', handle(ctx) {
      ctx.assertAllowed(read, 'read');
      try { const runtime = runtimeProfile(); return { advanced: true, runtimeSha256: runtime.sha256, categories: ['person', 'vehicle', 'animal'], execution: ['CPU', 'CUDA'], featureModels: { visual: runtime.profile.models.vision.sha256, face: runtime.profile.models.face.sha256 }, qualification: 'LOCAL_MODEL_PROFILE;_CAMERA_ACCURACY_REQUIRES_VALIDATION' }; }
      catch { return { advanced: false, categories: ['person'], execution: ['CPU'], qualification: 'CPU_PERSON_PROFILE' }; }
    } },
    { method: 'GET', path: '/api/intelligence/summary', permission: read, kind: 'read', handle(ctx, _input, query) { return analytics.summary(ctx, (query.get('runIds') ?? query.get('runId') ?? '').split(',').map(id)); } },
    { method: 'POST', path: '/api/intelligence/entities/link', permission: write, kind: 'write', handle(ctx, input, _query, key) { return analytics.link(ctx, input, id(key)); } },
    { method: 'GET', path: '/api/intelligence/rules', permission: read, kind: 'read', handle(ctx) { return analytics.rules(ctx); } },
    { method: 'POST', path: '/api/intelligence/rules', permission: write, kind: 'write', handle(ctx, input, _query, key) { return analytics.saveRule(ctx, input, id(key), (sourceId, zoneId) => { const source = sourceRow(ctx.tenantId, sourceId); if (zoneId && !geometry(JSON.parse(source.geometry_json)).zones.some(z => z.id === zoneId)) throw new PlatformError('NOT_FOUND', 'Rule zone is not on this source'); }); } },
    { method: 'GET', path: '/api/intelligence/alerts', permission: read, kind: 'read', handle(ctx, _input, query) { return analytics.alerts(ctx, query); } },
    { method: 'POST', path: '/api/intelligence/alerts/acknowledge', permission: write, kind: 'write', handle(ctx, input, _query, key) { return analytics.acknowledge(ctx, input, id(key)); } },
    { method: 'POST', path: '/api/intelligence/retrieval', permission: read, kind: 'read', async handle(ctx, input) {
      ctx.assertAllowed(read, 'read'); const raw = object(input, ['runIds', 'mode', 'q', 'reference', 'category', 'fromMs', 'toMs', 'minimumScore']);
      if (!Array.isArray(raw.runIds) || !raw.runIds.length || raw.runIds.length > 100 || new Set(raw.runIds).size !== raw.runIds.length) throw new PlatformError('INVALID', 'Select one to 100 runs');
      const rows = raw.runIds.map(runId => runRow(ctx, id(runId)));
      if (rows.some(row => !row.result_json)) throw new PlatformError('CONFLICT', 'Retrieval requires accepted runs');
      if (rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.result_json!), 0) > 32 * 1024 * 1024) throw new PlatformError('EXHAUSTED', 'Narrow the search to at most 32 MiB of accepted evidence');
      const mode = raw.mode, category = raw.category ?? '', fromMs = integer(raw.fromMs ?? 0, 0, 86400000), toMs = integer(raw.toMs ?? 86400000, 1, 86400000), minimumScore = raw.minimumScore ?? -1;
      if (!['text', 'image', 'face', 'plate'].includes(mode as string) || !['', 'person', 'vehicle', 'animal'].includes(category as string) || toMs <= fromMs || typeof minimumScore !== 'number' || !Number.isFinite(minimumScore) || minimumScore < -1 || minimumScore > 1) throw new PlatformError('INVALID', 'Invalid retrieval filters');
      const current = () => { ctx.assertOriginalAuth?.(); ctx.assertAllowed(read, 'read'); for (const row of rows) if (runRow(ctx, row.id).result_json !== row.result_json) throw new PlatformError('CONFLICT', 'Accepted search evidence changed'); };
      const target = mode === 'plate' ? null : await features.query(mode as 'text' | 'image' | 'face', mode === 'text' ? String(raw.q ?? '') : String(raw.reference ?? ''), current, { scope: scopeOf(ctx), commandId: ctx.requestId, runIds: rows.map(row => row.id) });
      current();
      const q = String(raw.q ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (mode === 'plate' && (!q || q.length > 16)) throw new PlatformError('INVALID', 'Supply a bounded plate query');
      const matches = rows.flatMap(row => (JSON.parse(row.result_json!) as TemporalResult).appearances.map(a => ({ ...a, runId: row.id, sourceId: row.source_id }))).filter(a => (!category || a.category === category) && a.lastMs >= fromMs && a.firstMs < toMs).map(a => {
        const candidate = mode === 'face' ? a.faceVector : a.visualVector;
        const plate = mode === 'plate' ? a.plateCandidates?.filter(p => p.text.includes(q)).sort((a, b) => b.confidence - a.confidence)[0] : undefined;
        const score = mode === 'plate' ? plate?.confidence ?? null : candidate && target ? cosine(candidate, target) : null;
        const { visualVector: _visual, faceVector: _face, ...appearance } = a;
        return { ...appearance, score, ...(plate ? { plate } : {}), qualification: mode === 'face' ? 'POSSIBLE_FACE_MATCH;IDENTITY_NOT_ESTABLISHED' : mode === 'plate' ? 'OCR_CANDIDATE;REVIEW_REQUIRED' : 'VISUAL_SIMILARITY;REVIEW_REQUIRED' };
      }).filter(match => match.score !== null && match.score >= minimumScore).sort((a, b) => b.score! - a.score! || a.runId.localeCompare(b.runId) || a.id.localeCompare(b.id)).slice(0, 100);
      return { mode, runIds: rows.map(row => row.id), items: matches, vectorIndex: 'EXACT_COSINE_IN_TENANT_OWNER', physicalUniqueness: 'UNKNOWN' };
    } },
    { method: 'POST', path: '/api/intelligence/batches', permission: write, kind: 'write', async handle(ctx, input, _query, key) {
      ctx.assertAllowed(write, 'write'); const raw = object(input, ['recordingIds', 'templateSourceId', 'startMs', 'endMs', 'sampleIntervalMs', 'processing']);
      if (!Array.isArray(raw.recordingIds) || !raw.recordingIds.length || raw.recordingIds.length > 100 || new Set(raw.recordingIds).size !== raw.recordingIds.length) throw new PlatformError('INVALID', 'Select one to 100 distinct admitted segments');
      const template = sourceRow(ctx.tenantId, id(raw.templateSourceId)), window = windowInput(raw), admitted = await catalog();
      const recordings = raw.recordingIds.map(value => { const recording = admitted.find(r => r.tenantId === ctx.tenantId && r.id === id(value)); if (!recording) throw new PlatformError('NOT_FOUND', 'Batch segment not admitted'); return recording; });
      for (const recording of recordings) await recordingBytes(recording);
      ctx.assertAllowed(write, 'write');
      return store.command(ctx, 'veyviz.intelligence.batch', key, { recordingIds: raw.recordingIds, templateSourceId: template.id, window }, write, () => {
        if (sourceRow(ctx.tenantId, template.id).version !== template.version) throw new PlatformError('CONFLICT', 'Template source changed');
        const current = catalogSync(); if (recordings.some(recording => !current.some(r => canonical(r) === canonical(recording)))) throw new PlatformError('CONFLICT', 'Batch admission changed');
        const batchId = randomUUID(), items = recordings.map(recording => { const source = cloneSource(ctx.tenantId, recording, template); return { recordingId: recording.id, sourceId: source.id, ...enqueue(ctx, source, randomUUID(), window.startMs, window.endMs, window.sampleIntervalMs, window.selected) }; });
        const batch = { batchId, templateSourceId: template.id, scope: scopeOf(ctx), commandId: id(key), created: Date.now(), items };
        store.db.prepare('INSERT INTO intelligence_batches VALUES(?,?,?)').run(ctx.tenantId, batchId, canonical(batch)); return batch;
      });
    } },
    { method: 'GET', path: '/api/intelligence/batches', permission: read, kind: 'read', handle(ctx) {
      ctx.assertAllowed(read, 'read'); return { items: (store.db.prepare('SELECT record_json FROM intelligence_batches WHERE tenant=? ORDER BY rowid DESC LIMIT 100').all(ctx.tenantId) as { record_json: string }[]).map(row => { const batch = JSON.parse(row.record_json); batch.items = batch.items.map((item: { jobId: string }) => ({ ...item, state: queue.get(item.jobId)?.state })); return batch; }) };
    } },
    { method: 'POST', path: '/api/intelligence/batches/cancel', permission: write, kind: 'write', handle(ctx, input, _query, key) {
      const raw = object(input, ['batchId']), batchId = id(raw.batchId);
      return store.command(ctx, 'veyviz.intelligence.batch-cancel', key, { batchId }, write, () => { const row = store.db.prepare('SELECT record_json FROM intelligence_batches WHERE tenant=? AND id=?').get(ctx.tenantId, batchId) as { record_json: string } | undefined; if (!row) throw new PlatformError('NOT_FOUND', 'Batch not found'); const batch = JSON.parse(row.record_json); return { batchId, items: batch.items.map((item: { runId: string; jobId: string }) => ({ runId: item.runId, state: queue.cancel(ctx, item.jobId) })) }; });
    } },
    { method: 'GET', path: '/api/intelligence/watches', permission: read, kind: 'read', handle(ctx) { ctx.assertAllowed(read, 'read'); return { items: (store.db.prepare('SELECT id,active,record_json,error FROM intelligence_watches WHERE tenant=? ORDER BY id LIMIT 20').all(ctx.tenantId) as { id: string; active: number; record_json: string; error: string | null }[]).map(row => ({ ...JSON.parse(row.record_json), active: !!row.active, error: row.error, processed: (store.db.prepare('SELECT COUNT(*) AS n FROM intelligence_watch_seen WHERE tenant=? AND watch_id=?').get(ctx.tenantId, row.id) as { n: number }).n })) }; } },
    { method: 'POST', path: '/api/intelligence/watches', permission: write, kind: 'write', handle(ctx, input, _query, key) {
      const raw = object(input, ['templateSourceId', 'prefix', 'endMs', 'sampleIntervalMs', 'processing']), template = sourceRow(ctx.tenantId, id(raw.templateSourceId)), prefix = id(raw.prefix), window = windowInput(raw);
      if (!authority.context) throw new PlatformError('UNAVAILABLE', 'Durable original-actor watch context is not bound');
      return store.command(ctx, 'veyviz.intelligence.watch', key, { templateSourceId: template.id, prefix, window }, write, () => { const count = store.db.prepare('SELECT COUNT(*) AS n FROM intelligence_watches WHERE tenant=? AND active=1').get(ctx.tenantId) as { n: number }; if (count.n >= 20) throw new PlatformError('EXHAUSTED', 'Active watch limit reached'); const watch = { id: randomUUID(), scope: scopeOf(ctx), commandId: id(key), templateSourceId: template.id, templateVersion: template.version, prefix, window, created: Date.now() }; store.db.prepare('INSERT INTO intelligence_watches VALUES(?,?,?,?,?)').run(ctx.tenantId, watch.id, 1, canonical(watch), null); return { ...watch, active: true }; });
    } },
    { method: 'POST', path: '/api/intelligence/watches/stop', permission: write, kind: 'write', handle(ctx, input, _query, key) {
      const raw = object(input, ['watchId']), watchId = id(raw.watchId);
      return store.command(ctx, 'veyviz.intelligence.watch-stop', key, { watchId }, write, () => { const row = store.db.prepare('SELECT id FROM intelligence_watches WHERE tenant=? AND id=?').get(ctx.tenantId, watchId); if (!row) throw new PlatformError('NOT_FOUND', 'Watch not found'); store.db.prepare('UPDATE intelligence_watches SET active=0 WHERE tenant=? AND id=?').run(ctx.tenantId, watchId); const runs = store.db.prepare('SELECT r.job_id FROM intelligence_watch_seen w JOIN intelligence_runs r ON r.tenant=w.tenant AND r.id=w.run_id WHERE w.tenant=? AND w.watch_id=?').all(ctx.tenantId, watchId) as { job_id: string }[]; for (const run of runs) if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(queue.get(run.job_id)?.state ?? '')) queue.cancel(ctx, run.job_id); return { watchId, active: false }; });
    } },
    { method: 'POST', path: '/api/intelligence/playback', permission: read, kind: 'read', async handle(ctx, input) {
      ctx.assertAllowed(read, 'read'); const body = object(input, ['sourceId', 'runId', 'eventId', 'alertId']);
      let sourceId: string, positionMs = 0;
      if (body.alertId !== undefined) {
        if (body.runId !== undefined || body.eventId !== undefined || body.sourceId !== undefined) throw new PlatformError('INVALID', 'Use one playback evidence identity');
        const alertRow = store.db.prepare('SELECT run_id,record_json FROM intelligence_alerts WHERE tenant=? AND id=?').get(ctx.tenantId, id(body.alertId)) as { run_id: string; record_json: string } | undefined;
        if (!alertRow) throw new PlatformError('NOT_FOUND', 'Alert evidence not found');
        const run = runRow(ctx, alertRow.run_id); if (!run.result_json) throw new PlatformError('CONFLICT', 'Alert has no accepted recording');
        sourceId = run.source_id; positionMs = JSON.parse(alertRow.record_json).positionMs;
      } else if (body.runId !== undefined) {
        const run = runRow(ctx, id(body.runId)); if (!run.result_json) throw new PlatformError('CONFLICT', 'Run has no accepted evidence');
        sourceId = run.source_id;
        if (body.eventId !== undefined) { const result = JSON.parse(run.result_json) as TemporalResult, event = result.events.find(e => e.id === id(body.eventId)); if (!event) throw new PlatformError('NOT_FOUND', 'Event not found'); positionMs = event.positionMs; }
      } else { if (body.eventId !== undefined) throw new PlatformError('INVALID', 'Event playback requires a run'); sourceId = id(body.sourceId); }
      const source = sourceRow(ctx.tenantId, sourceId), recording = await currentRecording(ctx.tenantId, source);
      const grant = await media.issue(recording, () => { ctx.assertOriginalAuth?.(); ctx.assertAllowed(read, 'read'); const now = sourceRow(ctx.tenantId, sourceId); const admission = catalogSync().find(r => r.tenantId === ctx.tenantId && r.id === recording.id); if (now.recording_json !== source.recording_json || !admission || canonical(admission) !== canonical(recording)) throw new PlatformError('DENIED', 'Playback source changed'); });
      return { ...grant, positionMs, captureStartUtc: recording.captureStartUtc, clockUncertaintyMs: recording.clockUncertaintyMs };
    } }
  ];
  const watchSignal = new AbortController(); let watchWork: Promise<void> | undefined;
  let watchCursor = '';
  const pollWatches = async () => {
    let rows = store.db.prepare('SELECT tenant,id,record_json FROM intelligence_watches WHERE active=1 AND id>? ORDER BY id LIMIT 20').all(watchCursor) as { tenant: string; id: string; record_json: string }[];
    if (!rows.length && watchCursor) { watchCursor = ''; rows = store.db.prepare('SELECT tenant,id,record_json FROM intelligence_watches WHERE active=1 ORDER BY id LIMIT 20').all() as typeof rows; }
    if (rows.length) watchCursor = rows[rows.length - 1]!.id;
    if (!rows.length || watchSignal.signal.aborted) return;
    const admitted = await catalog();
    for (const row of rows) {
      if (watchSignal.signal.aborted) return;
      try {
        const watch = JSON.parse(row.record_json), ctx = authority.context!(watch.scope, randomUUID(), watchSignal.signal);
        authority.assert(watch.scope, 'write');
        const template = sourceRow(row.tenant, watch.templateSourceId);
        if (template.version !== watch.templateVersion || (watch.window.selected && runtimeProfile().sha256 !== watch.window.selected.runtimeSha256)) throw new PlatformError('CONFLICT', 'Watch template or runtime changed; create a new watch');
        const next = admitted.find(r => r.tenantId === row.tenant && r.id.startsWith(watch.prefix) && !store.db.prepare('SELECT run_id FROM intelligence_watch_seen WHERE tenant=? AND watch_id=? AND recording_id=?').get(row.tenant, row.id, r.id));
        if (!next) continue;
        await recordingBytes(next); ctx.assertAllowed(write, 'write');
        if (watchSignal.signal.aborted) return;
        store.command(ctx, 'veyviz.intelligence.watch-segment', createHash('sha256').update(row.id + '\0' + next.id).digest('hex'), { watchId: row.id, recordingId: next.id }, write, () => {
          const active = store.db.prepare('SELECT active FROM intelligence_watches WHERE tenant=? AND id=?').get(row.tenant, row.id) as { active: number };
          if (!active.active || sourceRow(row.tenant, template.id).version !== template.version || !catalogSync().some(r => canonical(r) === canonical(next))) throw new PlatformError('CONFLICT', 'Watch or segment admission changed');
          const source = cloneSource(row.tenant, next, template), run = enqueue(ctx, source, randomUUID(), watch.window.startMs, watch.window.endMs, watch.window.sampleIntervalMs, watch.window.selected);
          store.db.prepare('INSERT INTO intelligence_watch_seen VALUES(?,?,?,?)').run(row.tenant, row.id, next.id, run.runId); store.db.prepare('UPDATE intelligence_watches SET error=NULL WHERE tenant=? AND id=?').run(row.tenant, row.id); return { ...run, sourceId: source.id };
        });
      } catch (error) { if (!watchSignal.signal.aborted) store.db.prepare('UPDATE intelligence_watches SET error=? WHERE tenant=? AND id=?').run(error instanceof PlatformError ? error.message : 'Watch cannot admit a segment; inspect the local profile', row.tenant, row.id); }
    }
  };
  const watchTimer = setInterval(() => { if (!watchWork && !watchSignal.signal.aborted) { watchWork = pollWatches().catch(() => {}).finally(() => { watchWork = undefined; }); } }, 5000);
  watchTimer.unref();
  let closing: Promise<void> | undefined;
  return { manifest, queue, handlers, runner, media, services: {}, routes, close(): Promise<void> { return closing ??= (async () => {
    watchSignal.abort(); clearInterval(watchTimer); await watchWork;
    const settled = await Promise.allSettled([runner.close(), media.close(), features.close()]);
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
    try { store.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Recording intelligence cleanup is incomplete; native quarantine is retained');
  })(); } };
}
export function register(env: ModuleEnvironment) {
  const authority = env.bindings['veyviz.product-authority.v1'] as Authority | undefined;
  if (!authority) throw new PlatformError('INCOMPATIBLE', 'Recorded intelligence requires an explicitly bound Product authority port');
  return createIntelligence(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id), authority, createTemporalRunner(env.dataPath + '.native-owner.json'), createFeatureBridge(env.dataPath + '.features-owner.json'));
}
