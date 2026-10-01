import { randomUUID } from 'node:crypto';
import { SqliteOwner } from '@quadbridge/sqlite';
import { object, text, id, integer, PlatformError, type ModuleManifest, type RequestContext, type CommittedReceipt } from '@quadbridge/contracts';
import type { HostedModule } from '@quadbridge/backend-host';
export interface RequestRecord {
    id: string;
    tenant: string;
    title: string;
    details: string;
    state: 'OPEN' | 'CLOSED';
    version: number;
    source: string | null;
    created: number;
}
export interface RequestCommands {
    create(context: RequestContext, input: unknown, key: string): RequestRecord;
}
export interface ReceiptCommands {
    create(context: RequestContext, input: unknown, key: string): CommittedReceipt;
    lookup(context: RequestContext, key: string): CommittedReceipt;
}
export const CREATE_RECEIPT_CONTRACT = 'desk.requests.create.v2';
export function createServiceDesk(manifest: ModuleManifest, store: SqliteOwner): HostedModule {
    // Preserve the exact applied v1 migration and existing human/v1 operation semantics.
    store.migrate([{ version: 1, sql: `CREATE TABLE requests(id TEXT NOT NULL,tenant TEXT NOT NULL,title TEXT NOT NULL,details TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,source TEXT,created INTEGER NOT NULL,PRIMARY KEY(tenant,id));` }], manifest.schema);
    function parse(input: unknown) {
        const b = object(input, ['title', 'details', 'source']);
        const title = text(b.title, 'title', 200), details = text(b.details, 'details', 8000);
        let source: null | Record<string, unknown> = null;
        if (b.source !== undefined) {
            const s = object(b.source, ['productId', 'instanceId', 'resourceType', 'resourceId', 'version']);
            source = { productId: id(s.productId), instanceId: id(s.instanceId), resourceType: id(s.resourceType), resourceId: id(s.resourceId), version: integer(s.version, 1) };
        }
        return { title, details, source };
    }
    function insert(ctx: RequestContext, input: ReturnType<typeof parse>): RequestRecord {
        const record: RequestRecord = { id: randomUUID(), tenant: ctx.tenantId, title: input.title, details: input.details, state: 'OPEN', version: 1, source: input.source ? JSON.stringify(input.source) : null, created: Date.now() };
        store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.tenant, record.title, record.details, record.state, 1, record.source, record.created);
        return record;
    }
    const commands: RequestCommands = { create(ctx, input, key) { const parsed = parse(input); return store.command(ctx, 'desk.create', key, parsed, 'desk.create', () => insert(ctx, parsed)); } };
    const receipts: ReceiptCommands = {
        create(ctx, input, key) {
            const parsed = parse(input);
            return store.command(ctx, 'desk.create.v2', key, parsed, 'desk.create', () => {
                const record = insert(ctx, parsed);
                return { schema: 'quadbridge.command-receipt.v1', contract: CREATE_RECEIPT_CONTRACT, outcome: 'COMMITTED', commandId: id(key), actor: { ...ctx.actor }, destination: { productId: ctx.productId, instanceId: ctx.instanceId, tenantId: ctx.tenantId }, resource: { type: 'desk.request', id: record.id, version: record.version } };
            });
        },
        lookup(ctx, key) {
            ctx.assertAllowed('desk.receipts.read', 'read');
            const row = store.db.prepare("SELECT result FROM _receipts WHERE tenant=? AND actor=? AND operation='desk.create.v2' AND command_id=?").get(ctx.tenantId, `${ctx.actor.kind}:${ctx.actor.id}`, id(key)) as {
                result: string;
            } | undefined;
            if (!row)
                throw new PlatformError('NOT_FOUND', 'Original receipt not available to this principal');
            return JSON.parse(row.result) as CommittedReceipt;
        }
    };
    return { manifest, services: { 'desk.requests.create.v1': commands, [CREATE_RECEIPT_CONTRACT]: receipts }, routes: [
            { method: 'GET', path: '/api/requests', permission: 'desk.read', kind: 'read', handle(ctx) { ctx.assertAllowed('desk.read', 'read'); return { items: store.db.prepare('SELECT * FROM requests WHERE tenant=? ORDER BY created DESC,id DESC LIMIT 100').all(ctx.tenantId), limit: 100 }; } },
            { method: 'POST', path: '/api/requests', permission: 'desk.create', kind: 'write', handle(ctx, b, _q, key) { return commands.create(ctx, b, key!); } },
            { method: 'POST', path: '/api/requests/commit', permission: 'desk.create', kind: 'write', handle(ctx, b, _q, key) { return receipts.create(ctx, b, key!); } },
            { method: 'GET', path: '/api/requests/receipt', permission: 'desk.receipts.read', kind: 'read', handle(ctx, _b, q) { return receipts.lookup(ctx, id(q.get('commandId'))); } },
            { method: 'POST', path: '/api/requests/close', permission: 'desk.close', kind: 'write', handle(ctx, input, _q, key) {
                    const b = object(input, ['id', 'expectedVersion']), recordId = id(b.id), version = integer(b.expectedVersion, 1);
                    return store.command(ctx, 'desk.close', key, { id: recordId, expectedVersion: version }, 'desk.close', () => {
                        const row = store.db.prepare('SELECT * FROM requests WHERE tenant=? AND id=?').get(ctx.tenantId, recordId) as unknown as RequestRecord | undefined;
                        if (!row)
                            throw new PlatformError('NOT_FOUND', 'Request not found');
                        if (row.version !== version || row.state !== 'OPEN')
                            throw new PlatformError('CONFLICT', 'Request changed; refresh before closing');
                        store.db.prepare("UPDATE requests SET state='CLOSED',version=version+1 WHERE tenant=? AND id=? AND version=?").run(ctx.tenantId, recordId, version);
                        return { ...row, state: 'CLOSED', version: version + 1 };
                    });
                } }
        ], close: () => store.close() };
}
export function register(env: import('@quadbridge/backend-host').ModuleEnvironment) { return createServiceDesk(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id)); }
