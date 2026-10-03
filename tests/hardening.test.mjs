import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteOwner, JobQueue } from '@quadbridge/sqlite';
import { WorkerHost } from '@quadbridge/worker-host';
import { resolve } from '@quadbridge/composition';
import { httpCommand, validateReceipt } from '@quadbridge/connections';
import { fixture, admin, SERVICE } from './helpers.mjs';
const ctx = (tenant = 'a') => ({ productId: 'example', instanceId: 'example', tenantId: tenant, actor: { id: 'worker-user', kind: 'user' }, requestId: 'r', signal: new AbortController().signal, assertAllowed() { } });
const protocol = { contract: 'desk.requests.create.v2', resourceType: 'desk.request', receiptPath: '/api/requests/receipt' };
const binding = (url, instance = 'service-desk-test') => ({ id: 'link', revision: '2', sourceProduct: 'knowledge', destinationProduct: 'service-desk', destinationInstance: instance, serviceActor: 'link', contract: protocol.contract, mode: 'http', tenantMap: { org: 'tenant-a' }, baseUrl: url, path: '/api/requests/commit', serviceToken: SERVICE });
const send = { sourceTenant: 'org', commandId: 'original', input: { title: 'Ref', details: 'Reference' }, signal: new AbortController().signal };
test('R07: 100 paused jobs cannot hide an enabled tenant', () => {
    const s = new SqliteOwner(':memory:', 'test');
    try {
        const q = new JobQueue(s);
        for (let i = 0; i < 100; i++)
            s.transaction(() => q.enqueue(ctx('a-paused'), 'work', `a.${i}`, {}, 'write'));
        const ready = s.transaction(() => q.enqueue(ctx('b-ready'), 'work', 'ready', {}, 'write'));
        assert.equal(q.claim('w', 1000, j => j.tenant === 'b-ready').id, ready.id);
    }
    finally {
        s.close();
    }
});
test('R07: bounded per-tenant paging advances beyond 100 ineligible jobs', () => {
    const s = new SqliteOwner(':memory:', 'test');
    let now = 1000;
    try {
        const q = new JobQueue(s, () => now++);
        for (let i = 0; i < 250; i++)
            s.transaction(() => q.enqueue(ctx(), 'blocked', `a.${i}`, {}, 'write'));
        const ready = s.transaction(() => q.enqueue(ctx(), 'ready', 'ready', {}, 'write'));
        let job;
        for (let i = 0; i < 4 && !job; i++)
            job = q.claim('w', 1000, j => j.kind === 'ready');
        assert.equal(job.id, ready.id);
    }
    finally {
        s.close();
    }
});
test('R07: persisted tenant cursor progresses beyond sixteen paused partitions', () => {
    const s = new SqliteOwner(':memory:', 'test');
    try {
        const q = new JobQueue(s);
        for (let i = 0; i < 34; i++)
            s.transaction(() => q.enqueue(ctx(`a-${String(i).padStart(2, '0')}`), 'work', `a.${i}`, {}, 'write'));
        const ready = s.transaction(() => q.enqueue(ctx('z-ready'), 'work', 'ready', {}, 'write'));
        let job;
        for (let i = 0; i < 4 && !job; i++) {
            const restarted = new JobQueue(s);
            job = restarted.claim('w', 1000, j => j.tenant === 'z-ready');
        }
        assert.equal(job.id, ready.id);
    }
    finally {
        s.close();
    }
});
test('R07: one busy tenant cannot monopolize a shared queue', () => {
    const s = new SqliteOwner(':memory:', 'test');
    try {
        const q = new JobQueue(s);
        for (let i = 0; i < 5; i++)
            s.transaction(() => q.enqueue(ctx('a-busy'), 'work', `a.${i}`, {}, 'write'));
        s.transaction(() => q.enqueue(ctx('b-quiet'), 'work', 'b', {}, 'write'));
        const a = q.claim('w', 1000, () => true);
        q.finish(a, { commit: () => null });
        assert.equal(q.claim('w', 1000, () => true).tenant, 'b-quiet');
    }
    finally {
        s.close();
    }
});
test('R07: registrations receive round-robin service', async () => {
    const sa = new SqliteOwner(':memory:', 'a'), sb = new SqliteOwner(':memory:', 'b');
    try {
        const a = new JobQueue(sa), b = new JobQueue(sb), order = [];
        for (let i = 0; i < 4; i++)
            sa.transaction(() => a.enqueue(ctx(), 'work', `a.${i}`, {}, 'write'));
        sb.transaction(() => b.enqueue(ctx(), 'work', 'b', {}, 'write'));
        const reg = (id, queue) => ({ moduleId: id, queue, enabled: () => true, authorize() { }, handlers: [{ kind: 'work', async prepare() { return { commit() { order.push(id); return null; } }; } }] });
        const w = new WorkerHost([reg('a', a), reg('b', b)]);
        for (let i = 0; i < 3; i++)
            await w.tick();
        w.stop();
        assert.deepEqual(order, ['a', 'b', 'a']);
    }
    finally {
        sa.close();
        sb.close();
    }
});
test('R07: reentrant ticks do not consume simultaneous work accidentally', async () => {
    const s = new SqliteOwner(':memory:', 'test');
    try {
        const q = new JobQueue(s);
        for (let i = 0; i < 2; i++)
            s.transaction(() => q.enqueue(ctx(), 'work', `a.${i}`, {}, 'write'));
        let release;
        const waiting = new Promise(r => release = r);
        const w = new WorkerHost([{ moduleId: 'test', queue: q, enabled: () => true, authorize() { }, handlers: [{ kind: 'work', async prepare() { await waiting; return { commit: () => null }; } }] }]);
        const first = w.tick(), second = w.tick();
        const result = await Promise.race([second, new Promise(r => setTimeout(() => r('timed-out'), 100))]);
        release();
        await Promise.all([first,second]);
        assert.equal(result,false);
        assert.equal(q.pending(), 1);
    }
    finally {
        s.close();
    }
});
const m = id => ({ id, version: '1.0.0', abi: 'quadbridge.module.v1', dependencies: [], provides: [], requires: [], permissions: [], routes: [], workspaces: [], schema: { current: 0, readMin: 0, readMax: 0 }, background: false });
const product = (modules, bindings) => ({ id: 'example', version: '1', platformAbi: 'quadbridge.module.v1', title: 'Example', description: '', layout: 'top', modules: modules.map(m => ({ id: m.id, version: m.version })), bindings });
const b = (consumer, implementation, contract) => ({ consumer, implementation, contract, instanceId: contract, mode: 'local', scope: 'application' });
test('R09: eager local bindings produce provider-before-consumer construction', () => { const a = m('a-consumer'), z = m('z-provider'); a.requires = ['lookup.v1']; z.provides = ['lookup.v1']; assert.deepEqual(resolve(product([a, z], [b(a.id, z.id, 'lookup.v1')]), [a, z]).modules.map(m => m.id), [z.id, a.id]); });
test('R09: binding-only construction cycles are rejected', () => { const a = m('a'), z = m('z'); a.requires = ['z.v1']; a.provides = ['a.v1']; z.requires = ['a.v1']; z.provides = ['z.v1']; assert.throws(() => resolve(product([a, z], [b('a', 'z', 'z.v1'), b('z', 'a', 'a.v1')]), [a, z]), /cycle/); });
test('R09: remote binding does not import or order an absent provider', () => { const a = m('a'); a.requires = ['remote']; const ref = { ...b('a', 'remote-not-installed', 'remote'), mode: 'http' }; assert.equal(resolve(product([a], [ref]), [a]).modules.length, 1); });
test('R03: wrong destination configuration is rejected before any target write', async (t) => {
    const target = await fixture(t), s = await target.server();
    const c = httpCommand(binding(s.url, 'wrong-instance'), protocol);
    await assert.rejects(c.call(send));
    assert.equal((await target.call('GET', '/api/requests')).items.length, 0);
});
test('R03: target rechecks expected identity on POST after a valid preflight', async (t) => {
    const target = await fixture(t), s = await target.server();
    const c = httpCommand(binding(s.url), protocol, async (u, o) => { if (o.method === 'POST')
        return fetch(u, { ...o, headers: { ...o.headers, 'X-QB-Destination-Instance': 'wrong' } }); return fetch(u, o); });
    await assert.rejects(c.call(send));
    assert.equal((await target.call('GET', '/api/requests')).items.length, 0);
});
test('R04: HTTP 202 accepted job is not a committed resource', async (t) => {
    const target = await fixture(t), s = await target.server();
    const c = httpCommand(binding(s.url), protocol, async (u, o) => o.method === 'POST' ? new Response(JSON.stringify({ id: 'queued', state: 'QUEUED' }), { status: 202 }) : fetch(u, o));
    await assert.rejects(c.call(send), e => e.code === 'INCOMPATIBLE');
});
for (const mutate of [r => ({ ...r, commandId: 'other' }), r => ({ ...r, destination: { ...r.destination, tenantId: 'other' } }), r => ({ ...r, destination: { ...r.destination, instanceId: 'other' } }), r => ({ ...r, contract: 'another.v1' }), r => ({ ...r, outcome: 'QUEUED' }), r => ({ ...r, resource: { ...r.resource, type: 'job' } }), r => ({ ...r, resource: { ...r.resource, version: 0 } })])
    test('R04: invalid receipt correlation is refused ' + mutate.toString(), () => {
        const target = { productId: 'desk', instanceId: 'desk-1', tenantId: 'a' }, r = { schema: 'quadbridge.command-receipt.v1', contract: protocol.contract, outcome: 'COMMITTED', commandId: 'key', destination: target, actor: { id: 'link', kind: 'service' }, resource: { type: 'desk.request', id: 'record', version: 1 } };
        assert.throws(() => validateReceipt(mutate(r), protocol, target, 'key'), e => e.code === 'INCOMPATIBLE');
    });
test('R03/R04: lookup uses the original service receipt without creating another record', async (t) => {
    const target = await fixture(t), s = await target.server(), c = httpCommand(binding(s.url), protocol);
    const first = await c.call(send);
    const second = await c.lookup({ ...send, input: null });
    assert.deepEqual(first, second);
    assert.equal((await target.call('GET', '/api/requests')).items.length, 1);
    target.runtime.access.revoke('link', 'tenant-a', 'desk.create');
    assert.deepEqual(await c.lookup({ ...send, input: null }), first);
    await assert.rejects(c.call(send), e => e.code === 'DENIED');
    target.runtime.access.revoke('link', 'tenant-a', 'desk.receipts.read');
    await assert.rejects(c.lookup(send), e => e.code === 'DENIED');
});
async function preparedSource(t, onPost) {
    const target = await fixture(t), server = await target.server(), realFetch = globalThis.fetch;
    let source;
    globalThis.fetch = async (url, opts) => { const response = await realFetch(url, opts); if (opts.method === 'POST')
        return onPost({ source, target, response, url, opts }); return response; };
    try {
        source = await fixture(t, 'knowledge', { baseUrl: server.url, destinationInstance: target.runtime.host.instanceId });
    }
    finally {
        globalThis.fetch = realFetch;
    }
    const doc = await source.call('POST', '/api/documents', { title: 'Procedure', body: 'Exact immutable source' }, 'doc');
    const request = await source.call('POST', '/api/handoffs', { documentId: doc.id, reason: 'Use the original identity' }, 'handoff');
    await source.tick();
    return { source, target, request };
}
test('F04: handoff retries reconcile the original source receipt before current destination and document prerequisites', async (t) => {
    const target = await fixture(t), server = await target.server();
    const source = await fixture(t, 'knowledge', { baseUrl: server.url, destinationInstance: target.runtime.host.instanceId });
    const document = await source.call('POST', '/api/documents', { title: 'Original procedure', body: 'The original source evidence remains owner-scoped.' }, 'receipt-first-document');
    const input = { documentId: document.id, reason: 'Inspect the guarded connector' };
    const commandId = 'receipt-first-handoff';
    const original = await source.call('POST', '/api/handoffs', input, commandId);
    assert.equal(await source.tick(), true);
    await source.tick();
    assert.equal((await target.call('GET', '/api/requests')).items.length, 1);

    target.runtime.access.revoke('link', 'tenant-a', 'desk.create');
    source.runtime.access.revoke('admin', 'tenant-a', 'knowledge.read');
    const replay = await source.call('POST', '/api/handoffs', input, commandId);
    assert.deepEqual(replay, original, 'the source owner returns its exact original receipt without needing destination or document reads');
    assert.equal(source.runtime.modules.find(module => module.manifest.id === 'handoff').queue.store.db.prepare('SELECT COUNT(*) AS count FROM handoffs').get().count, 1);
    assert.equal((await target.call('GET', '/api/requests')).items.length, 1, 'receipt replay does not create a second destination row');

    await assert.rejects(source.call('POST', '/api/handoffs', { ...input, reason: 'Changed payload' }, commandId), error => error.code === 'CONFLICT');
    await assert.rejects(source.call('POST', '/api/handoffs', { ...input, reason: 'Fresh command' }, 'receipt-first-fresh-command'), error => error.code === 'DENIED',
        'a new command still requires the current source document permission');
    source.runtime.access.revoke('admin', 'tenant-a', 'handoff.create');
    await assert.rejects(source.call('POST', '/api/handoffs', input, commandId), error => error.code === 'DENIED',
        'source write permission is checked inside original-receipt lookup');
});
for (const cause of ['revoke', 'cancel', 'lease-loss'])
    test(`R02: receipt survives ${cause} after actual destination commit`, async (t) => {
        const f = await preparedSource(t, async ({ source, response }) => {
            const q = source.runtime.modules.find(m => m.manifest.id === 'handoff').queue;
            if (cause === 'revoke')
                source.runtime.access.revoke('admin', 'tenant-a', 'handoff.create');
            if (cause === 'cancel') {
                const r = q.store.db.prepare('SELECT job_id FROM handoffs').get();
                q.store.transaction(() => q.cancel(ctx('tenant-a'), r.job_id));
            }
            if (cause === 'lease-loss')
                q.store.db.prepare('UPDATE _jobs SET lease_until=? WHERE state=\'RUNNING\'').run(Date.now() - 1);
            return response;
        });
        await f.source.tick();
        let row = (await f.source.call('GET', '/api/handoffs')).items[0];
        assert.equal(row.outcome, 'DESTINATION_COMMITTED');
        assert.ok(row.target_ref.resourceId);
        assert.equal(row.state, 'QUEUED');
        assert.notEqual(row.delivery.state, 'SUCCEEDED');
        assert.equal((await f.target.call('GET', '/api/requests')).items.length, 1);
        await f.source.restart();
        row = (await f.source.call('GET', '/api/handoffs')).items[0];
        assert.equal(row.outcome, 'DESTINATION_COMMITTED');
    });
test('R02: unknown acceptance survives expiration, restart, and explicit lookup reconciliation', async (t) => {
    const f = await preparedSource(t, async ({ response }) => { await response.arrayBuffer(); throw Error('lost after actual commit'); });
    await f.source.tick();
    let row = (await f.source.call('GET', '/api/handoffs')).items[0];
    assert.equal(row.outcome, 'ACCEPTANCE_UNKNOWN');
    const q = f.source.runtime.modules.find(m => m.manifest.id === 'handoff').queue;
    const sourceReceipt = q.store.db.prepare('SELECT result FROM _receipts WHERE tenant=? AND actor=? AND operation=? AND command_id=?')
        .get('tenant-a', 'user:admin', 'handoff.create', 'handoff');
    assert.ok(sourceReceipt, 'the source submission has its own durable receipt');
    const submitted = JSON.parse(sourceReceipt.result);
    assert.equal(submitted.$quadbridge, undefined, 'external destination uncertainty is never sealed as a source no-effects rejection');
    assert.equal(submitted.commandOutcome, undefined);
    q.store.db.prepare('UPDATE _jobs SET deadline=? WHERE id=?').run(Date.now() - 1, row.job_id);
    q.claim('cleanup', 1000, () => true);
    row = (await f.source.call('GET', '/api/handoffs')).items[0];
    assert.equal(row.outcome, 'ACCEPTANCE_UNKNOWN');
    assert.equal(row.delivery.state, 'FAILED');
    assert.equal(row.delivery.stopReason, 'EXPIRED_OR_EXHAUSTED');
    await f.source.restart();
    assert.equal((await f.source.call('GET', '/api/handoffs')).items[0].outcome, 'ACCEPTANCE_UNKNOWN');
    await f.source.call('POST', '/api/handoffs/reconcile', { id: row.id }, 'lookup');
    row = (await f.source.call('GET', '/api/handoffs')).items[0];
    assert.equal(row.outcome, 'DESTINATION_COMMITTED');
    assert.equal(row.delivery.state, 'FAILED');
    assert.equal((await f.target.call('GET', '/api/requests')).items.length, 1);
});
test('R02: lost response plus cancellation remains unknown rather than not executed', async (t) => {
    const f = await preparedSource(t, async ({ source, response }) => { await response.arrayBuffer(); const q = source.runtime.modules.find(m => m.manifest.id === 'handoff').queue; const row = q.store.db.prepare('SELECT job_id FROM handoffs').get(); q.store.transaction(() => q.cancel(ctx('tenant-a'), row.job_id)); throw Error('lost response'); });
    await f.source.tick();
    const row = (await f.source.call('GET', '/api/handoffs')).items[0];
    assert.equal(row.delivery.state, 'CANCELLED');
    assert.equal(row.outcome, 'ACCEPTANCE_UNKNOWN');
    assert.equal((await f.target.call('GET', '/api/requests')).items.length, 1);
});
test('R02: incompatible 202 result remains uncertainty, not false success', async (t) => {
    const f = await preparedSource(t, async ({ response }) => { await response.arrayBuffer(); return new Response(JSON.stringify({ id: 'background-job', state: 'QUEUED' }), { status: 202 }); });
    await f.source.tick();
    const row = (await f.source.call('GET', '/api/handoffs')).items[0];
    assert.equal(row.outcome, 'ACCEPTANCE_UNKNOWN');
    assert.equal(row.target_ref, null);
    assert.equal(row.delivery.error, 'INCOMPATIBLE');
});
test('R02: a legacy v1 intent is never silently resent using the v2 protocol', async (t) => {
    const f = await fixture(t, 'combined');
    const d = await f.call('POST', '/api/documents', { title: 'Legacy', body: 'Source' }, 'doc');
    const h = await f.call('POST', '/api/handoffs', { documentId: d.id, reason: 'legacy' }, 'send');
    const m = f.runtime.modules.find(m => m.manifest.id === 'handoff');
    m.queue.store.db.prepare('UPDATE handoffs SET protocol_version=1 WHERE id=?').run(h.id);
    await f.tick();
    await f.tick();
    const row = (await f.call('GET', '/api/handoffs')).items[0];
    assert.equal(row.outcome, 'RECONCILIATION_REQUIRED');
    assert.equal(row.delivery.error, 'INCOMPATIBLE');
    assert.equal((await f.call('GET', '/api/requests')).items.length, 0);
});
test('R10: neutral worker package has no concrete persistence dependency', () => {
    const source = readFileSync(new URL('../packages/worker-host/src/index.ts', import.meta.url), 'utf8'), pkg = JSON.parse(readFileSync(new URL('../packages/worker-host/package.json', import.meta.url)));
    assert.doesNotMatch(source, /@quadbridge\/sqlite/);
    assert.equal(pkg.dependencies['@quadbridge/sqlite'], undefined);
});
test('R03: different destination service principal is refused before dispatch', async (t) => {
    const target = await fixture(t), s = await target.server(), c = httpCommand({ ...binding(s.url), serviceActor: 'another-service' }, protocol);
    await assert.rejects(c.call(send));
    assert.equal((await target.call('GET', '/api/requests')).items.length, 0);
});
test('R02/R03: credential-principal rebinding cannot resend an existing uncertain intent', async (t) => {
    const f = await preparedSource(t, async ({ response }) => { await response.arrayBuffer(); throw Error('response lost'); });
    await f.source.tick();
    const before = (await f.source.call('GET', '/api/handoffs')).items[0];
    assert.equal(before.outcome, 'ACCEPTANCE_UNKNOWN');
    for (const c of Object.values(f.source.config.connections))
        c.serviceActor = 'different-service';
    await f.source.restart();
    await assert.rejects(f.source.call('POST', '/api/handoffs/reconcile', { id: before.id }, 'lookup'), e => e.code === 'INCOMPATIBLE');
    assert.equal((await f.target.call('GET', '/api/requests')).items.length, 1);
    assert.equal((await f.source.call('GET', '/api/handoffs')).items[0].outcome, 'ACCEPTANCE_UNKNOWN');
});
test('R02: actual v1 Handoff database upgrades without replaying legacy pending work', async () => {
    const { createHandoff } = await import('../modules/handoff/dist/index.js');
    const manifest = JSON.parse(readFileSync(new URL('../modules/handoff/module.json', import.meta.url)));
    const store = new SqliteOwner(':memory:', 'handoff');
    const oldSql = `CREATE TABLE handoffs(id TEXT NOT NULL,tenant TEXT NOT NULL,document_id TEXT NOT NULL,document_version INTEGER NOT NULL,title TEXT NOT NULL,reason TEXT NOT NULL,binding_revision TEXT NOT NULL,state TEXT NOT NULL,target_ref TEXT,job_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(tenant,id));`;
    store.migrate([{ version: 1, sql: oldSql }], { current: 1, readMin: 1, readMax: 1 });
    const oldQueue = new JobQueue(store);
    let submitted;
    store.transaction(() => { submitted = oldQueue.enqueue(ctx('a'), 'handoff.deliver.v1', 'legacy', { handoffId: 'legacy', sourceProduct: 'knowledge', sourceInstance: 'old' }, 'handoff.create'); store.db.prepare('INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('legacy', 'a', 'doc', 1, 'Legacy', 'Existing intent', 'old-binding', 'QUEUED', null, submitted.id, 1); });
    let sends = 0;
    const module = createHandoff(manifest, store, { document: { read: async () => ({ id: 'doc', title: 'Doc', version: 1 }) }, destination: { bindingKey: 'new-binding', target: () => ({ productId: 'desk', instanceId: 'new', tenantId: 'a' }), call: async () => { sends++; throw Error('must not replay'); }, lookup: async () => { throw Error('no automatic lookup'); } }, bindingRevision: 'new-binding', destinationInstance: 'new' });
    try {
        const worker = new WorkerHost([{ moduleId: 'handoff', queue: module.queue, handlers: module.handlers, enabled: () => true, authorize() { } }]);
        await worker.tick();
        assert.equal(sends, 0);
        assert.equal(module.queue.get(submitted.id).error, 'INCOMPATIBLE');
        assert.equal(store.db.prepare('SELECT protocol_version FROM handoffs').get().protocol_version, 1);
    }
    finally {
        module.close();
    }
});
