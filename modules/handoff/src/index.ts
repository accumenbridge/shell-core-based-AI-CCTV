import { randomUUID } from 'node:crypto';
import { SqliteOwner, JobQueue } from '@quadbridge/sqlite';
import { PlatformError, canonical, object, text, id, type ReceiptCommand, type CommittedReceipt, type ModuleManifest, type RequestContext, type JobHandler } from '@quadbridge/contracts';
import type { HostedModule } from '@quadbridge/backend-host';
export interface DocumentPort {
    list?(ctx: RequestContext): Promise<{id:string;title:string;version:number}[]>;
    read(ctx: RequestContext, id: string): Promise<{
        id: string;
        title: string;
        version: number;
    }>;
}
export interface HandoffModule extends HostedModule {
    queue: JobQueue;
    handlers: JobHandler[];
}
interface HandoffRow {
    id: string;
    document_id: string;
    document_version: number;
    title: string;
    reason: string;
    binding_revision: string;
    protocol_version: number;
    job_id: string;
    state: string;
    target_ref: string | null;
}
interface Delivery {
    binding_key: string;
    command_id: string;
    destination: string;
    state: 'NOT_SENT' | 'UNKNOWN' | 'COMMITTED';
    receipt: string | null;
    last_error: string | null;
}
export function createHandoff(manifest: ModuleManifest, store: SqliteOwner, ports: {
    document: DocumentPort;
    destination: ReceiptCommand;
    bindingRevision: string;
    destinationInstance: string;
    ready?: (ctx: RequestContext) => Promise<unknown>;
}): HandoffModule {
    store.migrate([
        { version: 1, sql: `CREATE TABLE handoffs(id TEXT NOT NULL,tenant TEXT NOT NULL,document_id TEXT NOT NULL,document_version INTEGER NOT NULL,title TEXT NOT NULL,reason TEXT NOT NULL,binding_revision TEXT NOT NULL,state TEXT NOT NULL,target_ref TEXT,job_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(tenant,id));` },
        { version: 2, sql: `ALTER TABLE handoffs ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE handoff_delivery(tenant TEXT NOT NULL,handoff_id TEXT NOT NULL,command_id TEXT NOT NULL,destination TEXT NOT NULL,binding_key TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,last_error TEXT,updated INTEGER NOT NULL,PRIMARY KEY(tenant,handoff_id),UNIQUE(tenant,command_id));` }
    ], manifest.schema);
    const queue = new JobQueue(store);
    const rowFor = (tenant: string, key: string) => {
        const r = store.db.prepare('SELECT * FROM handoffs WHERE tenant=? AND id=?').get(tenant, key) as unknown as HandoffRow | undefined;
        if (!r)
            throw new PlatformError('NOT_FOUND', 'Handoff not found');
        return r;
    };
    function deliveryFor(tenant: string, row: HandoffRow): Delivery {
        // Never change the wire protocol of an old possibly-dispatched operation implicitly.
        if (row.protocol_version !== 2)
            throw new PlatformError('INCOMPATIBLE', 'Legacy v1 handoff requires explicit original-provider reconciliation; no automatic v2 resend');
        if (row.binding_revision !== ports.bindingRevision)
            throw new PlatformError('INCOMPATIBLE', 'Binding changed; explicit reconciliation is required');
        const d = store.db.prepare('SELECT * FROM handoff_delivery WHERE tenant=? AND handoff_id=?').get(tenant, row.id) as unknown as Delivery | undefined;
        if (!d || d.binding_key !== ports.destination.bindingKey || d.destination !== canonical(ports.destination.target(tenant)))
            throw new PlatformError('INCOMPATIBLE', 'Destination binding differs from the original intent');
        return d;
    }
    function recordReceipt(tenant: string, row: HandoffRow, receipt: CommittedReceipt) {
        // Restricted fact-only acceptance. It can record an already-dispatched outcome after the
        // user loses write access/attempt expires; it cannot dispatch or mark business completion.
        store.transaction(() => {
            const d = deliveryFor(tenant, row);
            if (d.command_id !== receipt.commandId || d.destination !== canonical(receipt.destination) || receipt.contract !== 'desk.requests.create.v2' || receipt.outcome !== 'COMMITTED' || receipt.resource.type !== 'desk.request')
                throw new PlatformError('INCOMPATIBLE', 'Receipt does not belong to this original delivery');
            const raw = canonical(receipt);
            if (d.receipt && d.receipt !== raw)
                throw new PlatformError('CONFLICT', 'Conflicting original receipt; retained receipt is unchanged');
            store.db.prepare("UPDATE handoff_delivery SET state='COMMITTED',receipt=?,last_error=NULL,updated=? WHERE tenant=? AND handoff_id=?").run(raw, Date.now(), tenant, row.id);
            store.db.prepare('INSERT INTO _audit(tenant,actor,operation,command_id,at) VALUES(?,?,?,?,?)').run(tenant, 'system:delivery-receipt', 'handoff.receipt.record', d.command_id, Date.now());
        });
    }
    function reference(receipt: CommittedReceipt) { return { ...receipt.destination, resourceType: receipt.resource.type, resourceId: receipt.resource.id, version: receipt.resource.version }; }
    const handlers: JobHandler[] = [{ kind: 'handoff.deliver.v1', async prepare(payload, jobctx) {
                const b = object(payload, ['handoffId', 'sourceProduct', 'sourceInstance']);
                const row = rowFor(jobctx.tenantId, id(b.handoffId)), delivery = deliveryFor(jobctx.tenantId, row);
                let receipt: CommittedReceipt;
                try {
                    if (delivery.receipt)
                        receipt = JSON.parse(delivery.receipt) as CommittedReceipt;
                    else {
                        receipt = await ports.destination.call({ sourceTenant: jobctx.tenantId, commandId: delivery.command_id, signal: jobctx.signal,
                            async beforeDispatch() { await jobctx.assertCurrent(); store.transaction(() => { const attempt = queue.get(jobctx.jobId); if (!attempt || attempt.attempt !== jobctx.attempt)
                                throw new PlatformError('STALE_ATTEMPT', 'Attempt changed before dispatch'); queue.assertCurrent(attempt); const current = deliveryFor(jobctx.tenantId, row); if (current.state === 'COMMITTED')
                                throw new PlatformError('CONFLICT', 'Original delivery already committed'); store.db.prepare("UPDATE handoff_delivery SET state='UNKNOWN',updated=? WHERE tenant=? AND handoff_id=?").run(Date.now(), jobctx.tenantId, row.id); }); },
                            input: { title: row.title, details: row.reason, source: { productId: id(b.sourceProduct), instanceId: id(b.sourceInstance), resourceType: 'knowledge.document', resourceId: row.document_id, version: row.document_version } } });
                        recordReceipt(jobctx.tenantId, row, receipt);
                    }
                }
                catch (e) {
                    store.transaction(() => store.db.prepare("UPDATE handoff_delivery SET last_error=?,updated=? WHERE tenant=? AND handoff_id=? AND state!='COMMITTED'").run(e instanceof PlatformError ? e.code : 'UNAVAILABLE', Date.now(), jobctx.tenantId, row.id));
                    throw e;
                }
                const target = reference(receipt);
                return { commit() { store.db.prepare("UPDATE handoffs SET state='ACCEPTED',target_ref=? WHERE tenant=? AND id=?").run(canonical(target), jobctx.tenantId, row.id); return target; } };
            } }];
    return { manifest, services: {}, queue, handlers, routes: [
            {method:'GET',path:'/api/handoffs/options',permission:'handoff.read',kind:'read',async handle(ctx) {
                ctx.assertAllowed('handoff.read','read');
                let connection:unknown={state:'NOT_CHECKED',message:'This adapter does not expose prerequisite inspection.'};
                if(ports.ready)try{connection=await ports.ready(ctx);}catch(e){connection={state:'BLOCKED',code:e instanceof PlatformError?e.code:'UNAVAILABLE',message:e instanceof PlatformError?e.message:'Destination check failed'};}
                const documents=ports.document.list ? await ports.document.list(ctx) : [];
                ctx.assertAllowed('handoff.read','read');ctx.signal.throwIfAborted();
                return {documents,limit:100,connection};
            } },
            { method: 'GET', path: '/api/handoffs', permission: 'handoff.read', kind: 'read', handle(ctx) {
                    ctx.assertAllowed('handoff.read', 'read');
                    const rows = store.db.prepare('SELECT * FROM handoffs WHERE tenant=? ORDER BY created DESC,id LIMIT 100').all(ctx.tenantId) as unknown as HandoffRow[];
                    return { items: rows.map(r => {
                            const job = queue.get(r.job_id)!;
                            const d = store.db.prepare('SELECT * FROM handoff_delivery WHERE tenant=? AND handoff_id=?').get(ctx.tenantId, r.id) as unknown as Delivery | undefined;
                            const receipt = d?.receipt ? JSON.parse(d.receipt) as CommittedReceipt : undefined;
                            const outcome = r.protocol_version === 1 ? (r.state === 'ACCEPTED' ? 'LEGACY_DESTINATION_COMMITTED' : 'RECONCILIATION_REQUIRED') : d?.state === 'COMMITTED' ? 'DESTINATION_COMMITTED' : d?.state === 'UNKNOWN' ? 'ACCEPTANCE_UNKNOWN' : job.state;
                            return { ...r, target_ref: receipt ? reference(receipt) : r.target_ref ? JSON.parse(r.target_ref) : null, delivery: queue.publicGet(ctx, r.job_id), acceptance: { state: d?.state ?? 'LEGACY', receipt: receipt ?? null, lastError: d?.last_error ?? null }, outcome };
                        }) };
                } },
            { method: 'POST', path: '/api/handoffs', permission: 'handoff.create', kind: 'write', async handle(ctx, input, _q, key) {
                    const b = object(input, ['documentId', 'reason']), documentId = id(b.documentId), reason = text(b.reason, 'reason', 8000);
                    if(ports.ready)await ports.ready(ctx);
                    const doc = await ports.document.read(ctx, documentId), destination = ports.destination.target(ctx.tenantId);
                    return store.command(ctx, 'handoff.create', key, { documentId, reason }, 'handoff.create', () => {
                        const handoffId = randomUUID();
                        const job = queue.enqueue(ctx, 'handoff.deliver.v1', `send.${handoffId}`, { handoffId, sourceProduct: ctx.productId, sourceInstance: ctx.instanceId }, 'handoff.create');
                        store.db.prepare('INSERT INTO handoffs(id,tenant,document_id,document_version,title,reason,binding_revision,state,target_ref,job_id,created,protocol_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,2)').run(handoffId, ctx.tenantId, documentId, doc.version, doc.title, reason, ports.bindingRevision, 'QUEUED', null, job.id, Date.now());
                        store.db.prepare("INSERT INTO handoff_delivery VALUES(?,?,?,?,?,'NOT_SENT',NULL,NULL,?)").run(ctx.tenantId, handoffId, `handoff.${handoffId}`, canonical(destination), ports.destination.bindingKey, Date.now());
                        return { id: handoffId, state: 'QUEUED', jobId: job.id };
                    });
                } },
            { method: 'POST', path: '/api/handoffs/reconcile', permission: 'handoff.reconcile', kind: 'write', async handle(ctx, input, _q, key) {
                    const b = object(input, ['id']), handoffId = id(b.id);
                    ctx.assertAllowed('handoff.reconcile', 'write');
                    const row = rowFor(ctx.tenantId, handoffId), d = deliveryFor(ctx.tenantId, row);
                    if (d.state === 'NOT_SENT')
                        throw new PlatformError('CONFLICT', 'No recorded dispatch to reconcile');
                    const receipt = d.receipt ? JSON.parse(d.receipt) as CommittedReceipt : await ports.destination.lookup({ sourceTenant: ctx.tenantId, commandId: d.command_id, input: null, signal: ctx.signal });
                    recordReceipt(ctx.tenantId, row, receipt);
                    return store.command(ctx, 'handoff.reconcile', key, { id: handoffId }, 'handoff.reconcile', () => { store.db.prepare("UPDATE handoffs SET state='ACCEPTED',target_ref=? WHERE tenant=? AND id=?").run(canonical(reference(receipt)), ctx.tenantId, handoffId); return { id: handoffId, outcome: 'DESTINATION_COMMITTED', receipt }; });
                } }
        ], close: () => store.close() };
}
export function register(env: import('@quadbridge/backend-host').ModuleEnvironment) {
    const doc = env.bindings['knowledge.document.read.v1'] as DocumentPort;
    const delivery = env.bindings['desk.requests.create.v2'] as {
        command: ReceiptCommand;
        revision: string;
        destinationInstance: string;
        ready?: (ctx: RequestContext) => Promise<unknown>;
    };
    if (!doc || !delivery)
        throw new PlatformError('INCOMPATIBLE', 'Handoff ports must be explicitly bound');
    return createHandoff(env.manifest, new SqliteOwner(env.dataPath, env.manifest.id), { document: doc, destination: delivery.command, bindingRevision: delivery.revision, destinationInstance: delivery.destinationInstance, ready: delivery.ready });
}
