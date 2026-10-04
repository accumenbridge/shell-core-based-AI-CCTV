import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { SqliteOwner } from '@quadbridge/sqlite';
import { PlatformError, object, text, id, integer, type ModuleManifest, type RequestContext } from '@quadbridge/contracts';
import type { OperationDescriptor, OperationRegistration } from '@quadbridge/contracts/operations';
import type { HostedModule, ModuleEnvironment } from '@quadbridge/backend-host';
import type { SourceQueryReader, SourceReader } from './bridge.js';
import { FIXTURE_ID, sourceView, type SourceQueryRequest, type SourceQueryResponse, type VideoSource } from './protocol.js';

const sourceProjection = { type: 'object', properties: {
  id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 160 }, fixtureId: { type: 'string', enum: [FIXTURE_ID] },
  version: { type: 'integer', minimum: 1 }, created: { type: 'integer', minimum: 0 }
}, required: ['id', 'name', 'fixtureId', 'version', 'created'], additionalProperties: false };
const sourcePage = { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, nextCursor: { type: 'string', minLength: 1, maxLength: 512 }, coverage: { type: 'string', enum: ['filtered-owner-query'] } }, required: ['limit', 'coverage'], additionalProperties: false };

const descriptors: OperationDescriptor[] = [
  { id: 'veyviz-sources.sources.list', version: 1, title: 'List video sources', description: 'List authorized source registrations for the current tenant.', permission: 'veyviz.sources.read', kind: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { items: { type: 'array', maxItems: 100, items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 160 }, fixtureId: { type: 'string', enum: [FIXTURE_ID] },
      version: { type: 'integer', minimum: 1 }, created: { type: 'integer', minimum: 0 }
    }, required: ['id', 'name', 'fixtureId', 'version', 'created'], additionalProperties: false } } }, required: ['items'], additionalProperties: false } },
  { id: 'veyviz-sources.sources.register', version: 1, title: 'Register a recorded fixture', description: 'Register the single reviewed local recording fixture by opaque identifier.', permission: 'veyviz.sources.write', kind: 'write',
    inputSchema: { type: 'object', properties: { fixtureId: { type: 'string', enum: [FIXTURE_ID] }, name: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['fixtureId', 'name'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 160 }, fixtureId: { type: 'string', enum: [FIXTURE_ID] }, version: { type: 'integer', minimum: 1 }, created: { type: 'integer', minimum: 0 } }, required: ['id', 'name', 'fixtureId', 'version', 'created'], additionalProperties: false } },
  { id: 'veyviz-sources.sources.query', version: 1, title: 'Search registered recordings', description: 'Search a bounded page of owner-authorized registrations by literal source name or ID.', permission: 'veyviz.sources.read', kind: 'read',
    inputSchema: { type: 'object', properties: { search: { type: 'string', maxLength: 200 }, renamedOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', minLength: 1, maxLength: 512 } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { items: { type: 'array', maxItems: 100, items: sourceProjection }, page: sourcePage }, required: ['items', 'page'], additionalProperties: false } }
];

interface SourceCursor { v: 1; b: string; created: number; id: string }
interface NormalizedSourceQuery { q?: string; renamedOnly: boolean; limit: number; cursor?: string }

function queryText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) throw new PlatformError('INVALID', `Invalid ${label}`);
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeSourceQuery(value: unknown, publicInput = false): NormalizedSourceQuery {
  const keys = publicInput ? ['search', 'renamedOnly', 'limit', 'cursor'] : ['q', 'renamedOnly', 'limit', 'cursor'];
  const body = object(value, keys);
  const q = queryText(body[publicInput ? 'search' : 'q'], 'search');
  if (body.renamedOnly !== undefined && typeof body.renamedOnly !== 'boolean') throw new PlatformError('INVALID', 'Invalid renamedOnly filter');
  const limit = body.limit === undefined ? 20 : integer(body.limit, 1, 100);
  let cursor: string | undefined;
  if (body.cursor !== undefined) {
    if (typeof body.cursor !== 'string' || body.cursor.length < 1 || body.cursor.length > 512) throw new PlatformError('INVALID', 'Invalid page cursor');
    cursor = body.cursor;
  }
  return { q, renamedOnly: body.renamedOnly === true, limit, cursor };
}

function routeQuery(query: URLSearchParams): Record<string, unknown> {
  const allowed = new Set(['search', 'renamedOnly', 'limit', 'cursor']);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) throw new PlatformError('INVALID', 'Invalid source query parameter');
  const result: Record<string, unknown> = {};
  const search = query.get('search'), renamedOnly = query.get('renamedOnly'), limit = query.get('limit'), cursor = query.get('cursor');
  if (search !== null) result.search = search;
  if (renamedOnly !== null) {
    if (renamedOnly !== 'true' && renamedOnly !== 'false') throw new PlatformError('INVALID', 'Invalid renamedOnly filter');
    result.renamedOnly = renamedOnly === 'true';
  }
  if (limit !== null) {
    if (!/^[0-9]+$/.test(limit)) throw new PlatformError('INVALID', 'Invalid page limit');
    result.limit = Number(limit);
  }
  if (cursor !== null) result.cursor = cursor;
  return result;
}

function cursorBinding(ctx: RequestContext, query: NormalizedSourceQuery): string {
  const binding = JSON.stringify(['veyviz-sources', ctx.tenantId, ctx.productId, ctx.instanceId, query.q ?? '', query.renamedOnly, query.limit]);
  return createHash('sha256').update(binding).digest('hex');
}

function decodeCursor(token: string | undefined, ctx: RequestContext, query: NormalizedSourceQuery): SourceCursor | undefined {
  if (token === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('format');
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== token) throw new Error('encoding');
    const value = JSON.parse(decoded) as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'b,created,id,v' || value.v !== 1 || value.b !== cursorBinding(ctx, query) ||
        !Number.isSafeInteger(value.created) || (value.created as number) < 0 || typeof value.id !== 'string' || id(value.id) !== value.id)
      throw new Error('binding');
    return value as unknown as SourceCursor;
  } catch { throw new PlatformError('INVALID', 'Page cursor is invalid or does not match this source query'); }
}

function encodeCursor(ctx: RequestContext, query: NormalizedSourceQuery, row: VideoSource): string {
  return Buffer.from(JSON.stringify({ v: 1, b: cursorBinding(ctx, query), created: row.created, id: row.id }), 'utf8').toString('base64url');
}

function sourceRow(store: SqliteOwner, ctx: RequestContext, sourceId: string): VideoSource {
  ctx.assertAllowed('veyviz.sources.read', 'read');
  const row = store.db.prepare('SELECT id,tenant,name,fixture_id AS fixtureId,version,created FROM video_sources WHERE tenant=? AND id=?').get(ctx.tenantId, id(sourceId)) as unknown as VideoSource | undefined;
  if (!row) throw new PlatformError('NOT_FOUND', 'Video source not found');
  return row;
}

export function createSources(manifest: ModuleManifest, store: SqliteOwner): HostedModule & { reader: SourceReader } {
  store.migrate([{ version: 1, sql: `CREATE TABLE video_sources(id TEXT NOT NULL,tenant TEXT NOT NULL,name TEXT NOT NULL,fixture_id TEXT NOT NULL CHECK(fixture_id='mivia-vid0062'),version INTEGER NOT NULL CHECK(version>0),created INTEGER NOT NULL,PRIMARY KEY(tenant,id)); CREATE INDEX video_sources_tenant_created ON video_sources(tenant,created DESC);` }], manifest.schema);
  store.db.function('veyviz_sources_casefold', { deterministic: true }, value => typeof value === 'string' ? value.toLowerCase() : '');

  const reader: SourceReader = {
    list(ctx) {
      ctx.assertAllowed('veyviz.sources.read', 'read');
      const rows = store.db.prepare('SELECT id,tenant,name,fixture_id AS fixtureId,version,created FROM video_sources WHERE tenant=? ORDER BY created DESC,id LIMIT 100').all(ctx.tenantId) as unknown as VideoSource[];
      return rows.map(sourceView);
    },
    get(ctx, sourceId) { return sourceView(sourceRow(store, ctx, sourceId)); }
  };
  const queryReader: SourceQueryReader = {
    query(ctx, request) {
      ctx.assertAllowed('veyviz.sources.read', 'read');
      const query = normalizeSourceQuery(request);
      const after = decodeCursor(query.cursor, ctx, query);
      const conditions = ['tenant=?'];
      const parameters: Array<string | number> = [ctx.tenantId];
      if (query.renamedOnly) conditions.push('version>1');
      if (query.q) { conditions.push('(instr(veyviz_sources_casefold(name),?)>0 OR instr(veyviz_sources_casefold(id),?)>0)'); parameters.push(query.q, query.q); }
      if (after) { conditions.push('(created<? OR (created=? AND id>?))'); parameters.push(after.created, after.created, after.id); }
      parameters.push(query.limit + 1);
      const rows = store.db.prepare(`SELECT id,tenant,name,fixture_id AS fixtureId,version,created FROM video_sources WHERE ${conditions.join(' AND ')} ORDER BY created DESC,id ASC LIMIT ?`).all(...parameters) as unknown as VideoSource[];
      const hasNext = rows.length > query.limit;
      const pageRows = rows.slice(0, query.limit);
      const last = pageRows.at(-1);
      return { items: pageRows.map(sourceView), page: { limit: query.limit, ...(hasNext && last ? { nextCursor: encodeCursor(ctx, query, last) } : {}), coverage: 'filtered-owner-query' } };
    }
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
    { descriptor: descriptors[1]!, handle(ctx, input, key) { return register(ctx, input, key); } },
    { descriptor: descriptors[2]!, handle(ctx, input) { return queryReader.query(ctx, normalizeSourceQuery(input, true)); } }
  ];
  return { manifest, reader, services: { 'veyviz.sources.read.v1': reader, 'veyviz.sources.query.v1': queryReader, 'veyviz.product-authority.v1': {} }, operations, routes: [
    { method: 'GET', path: '/api/sources', permission: 'veyviz.sources.read', kind: 'read', handle(ctx) { return { items: reader.list(ctx) }; } },
    { method: 'GET', path: '/api/sources/query', permission: 'veyviz.sources.read', kind: 'read', handle(ctx, _input, query) { return queryReader.query(ctx, normalizeSourceQuery(routeQuery(query), true)); } },
    { method: 'POST', path: '/api/sources', permission: 'veyviz.sources.write', kind: 'write', handle(ctx, input, _query, key) { return register(ctx, input, key); } },
    { method: 'POST', path: '/api/sources/rename', permission: 'veyviz.sources.write', kind: 'write', handle(ctx, input, _query, key) { return rename(ctx, input, key); } }
  ], close: () => store.close() };
}

export function register(env: ModuleEnvironment) { return createSources(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id)); }
