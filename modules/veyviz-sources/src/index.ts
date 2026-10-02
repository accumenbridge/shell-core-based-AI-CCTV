import { randomUUID } from 'node:crypto';
import { SqliteOwner } from '@quadbridge/sqlite';
import { PlatformError, object, text, id, type ModuleManifest, type RequestContext } from '@quadbridge/contracts';
import type { OperationDescriptor, OperationRegistration } from '@quadbridge/contracts/operations';
import type { HostedModule, ModuleEnvironment } from '@quadbridge/backend-host';
import type { SourceReader } from './bridge.js';
import { FIXTURE_ID, sourceView, type VideoSource } from './protocol.js';

const descriptors: OperationDescriptor[] = [
  { id: 'veyviz-sources.sources.list', version: 1, title: 'List video sources', description: 'List authorized source registrations for the current tenant.', permission: 'veyviz.sources.read', kind: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { items: { type: 'array', maxItems: 100, items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 160 }, fixtureId: { type: 'string', enum: [FIXTURE_ID] },
      version: { type: 'integer', minimum: 1 }, created: { type: 'integer', minimum: 0 }
    }, required: ['id', 'name', 'fixtureId', 'version', 'created'], additionalProperties: false } } }, required: ['items'], additionalProperties: false } },
  { id: 'veyviz-sources.sources.register', version: 1, title: 'Register a recorded fixture', description: 'Register the single reviewed local recording fixture by opaque identifier.', permission: 'veyviz.sources.write', kind: 'write',
    inputSchema: { type: 'object', properties: { fixtureId: { type: 'string', enum: [FIXTURE_ID] }, name: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['fixtureId', 'name'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 160 }, fixtureId: { type: 'string', enum: [FIXTURE_ID] }, version: { type: 'integer', minimum: 1 }, created: { type: 'integer', minimum: 0 } }, required: ['id', 'name', 'fixtureId', 'version', 'created'], additionalProperties: false } }
];

function sourceRow(store: SqliteOwner, ctx: RequestContext, sourceId: string): VideoSource {
  ctx.assertAllowed('veyviz.sources.read', 'read');
  const row = store.db.prepare('SELECT id,tenant,name,fixture_id AS fixtureId,version,created FROM video_sources WHERE tenant=? AND id=?').get(ctx.tenantId, id(sourceId)) as unknown as VideoSource | undefined;
  if (!row) throw new PlatformError('NOT_FOUND', 'Video source not found');
  return row;
}

export function createSources(manifest: ModuleManifest, store: SqliteOwner): HostedModule & { reader: SourceReader } {
  store.migrate([{ version: 1, sql: `CREATE TABLE video_sources(id TEXT NOT NULL,tenant TEXT NOT NULL,name TEXT NOT NULL,fixture_id TEXT NOT NULL CHECK(fixture_id='mivia-vid0062'),version INTEGER NOT NULL CHECK(version>0),created INTEGER NOT NULL,PRIMARY KEY(tenant,id)); CREATE INDEX video_sources_tenant_created ON video_sources(tenant,created DESC);` }], manifest.schema);

  const reader: SourceReader = {
    list(ctx) {
      ctx.assertAllowed('veyviz.sources.read', 'read');
      const rows = store.db.prepare('SELECT id,tenant,name,fixture_id AS fixtureId,version,created FROM video_sources WHERE tenant=? ORDER BY created DESC,id LIMIT 100').all(ctx.tenantId) as unknown as VideoSource[];
      return rows.map(sourceView);
    },
    get(ctx, sourceId) { return sourceView(sourceRow(store, ctx, sourceId)); }
  };

  const register = (ctx: RequestContext, input: unknown, commandId?: string) => {
    ctx.assertAllowed('veyviz.sources.write', 'write');
    const body = object(input, ['fixtureId', 'name']);
    if (body.fixtureId !== FIXTURE_ID) throw new PlatformError('INVALID', 'Only the reviewed local fixture is supported');
    const name = text(body.name, 'source name', 160);
    return store.command(ctx, 'veyviz.sources.register', commandId, { fixtureId: FIXTURE_ID, name }, 'veyviz.sources.write', () => {
      const record = { id: randomUUID(), tenant: ctx.tenantId, name, fixtureId: FIXTURE_ID, version: 1, created: Date.now() };
      store.db.prepare('INSERT INTO video_sources(id,tenant,name,fixture_id,version,created) VALUES(?,?,?,?,?,?)').run(record.id, record.tenant, record.name, record.fixtureId, record.version, record.created);
      return sourceView(record);
    });
  };
  const rename = (ctx: RequestContext, input: unknown, commandId?: string) => {
    ctx.assertAllowed('veyviz.sources.write', 'write');
    const body = object(input, ['sourceId', 'name']), sourceId = id(body.sourceId), name = text(body.name, 'source name', 160);
    return store.command(ctx, 'veyviz.sources.rename', commandId, { sourceId, name }, 'veyviz.sources.write', () => {
      const row = sourceRow(store, ctx, sourceId);
      const version = row.version + 1;
      if (!Number.isSafeInteger(version)) throw new PlatformError('EXHAUSTED', 'Source version is exhausted');
      store.db.prepare('UPDATE video_sources SET name=?,version=? WHERE tenant=? AND id=? AND version=?').run(name, version, ctx.tenantId, sourceId, row.version);
      return sourceView({ ...row, name, version });
    });
  };
  const operations: OperationRegistration[] = [
    { descriptor: descriptors[0]!, handle(ctx) { ctx.assertAllowed('veyviz.sources.read', 'read'); return { items: reader.list(ctx) }; } },
    { descriptor: descriptors[1]!, handle(ctx, input, key) { return register(ctx, input, key); } }
  ];
  return { manifest, reader, services: { 'veyviz.sources.read.v1': reader }, operations, routes: [
    { method: 'GET', path: '/api/sources', permission: 'veyviz.sources.read', kind: 'read', handle(ctx) { return { items: reader.list(ctx) }; } },
    { method: 'POST', path: '/api/sources', permission: 'veyviz.sources.write', kind: 'write', handle(ctx, input, _query, key) { return register(ctx, input, key); } },
    { method: 'POST', path: '/api/sources/rename', permission: 'veyviz.sources.write', kind: 'write', handle(ctx, input, _query, key) { return rename(ctx, input, key); } }
  ], close: () => store.close() };
}

export function register(env: ModuleEnvironment) { return createSources(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id)); }
