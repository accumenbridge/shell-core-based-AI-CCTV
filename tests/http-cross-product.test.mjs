import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, login, api, admin, SERVICE } from './helpers.mjs';
import { httpCommand, localCommand } from '@quadbridge/connections';
test('neutral shell serves with zero business routes and no worker dependency', async (t) => { const f = await fixture(t, 'neutral'), s = await f.server(), cookie = await login(s.url); const boot = await api(s.url, cookie, '/api/bootstrap'); assert.equal(boot.body.workspaces.length, 0); assert.deepEqual(boot.body.modules, []); assert.equal((await api(s.url, cookie, '/api/requests')).status, 404); assert.equal((await fetch(s.url + '/assets/modules/knowledge/ui.js')).status, 404); assert.match(await (await fetch(s.url + '/assets/composition.js')).text(), /loaders:\{\}/); });
test('HTTP command / receipt / query use actual persistent module', async (t) => { const f = await fixture(t), s = await f.server(), c = await login(s.url); const a = await api(s.url, c, '/api/requests', 'POST', { title: 'Real HTTP', details: 'Record and receipt' }, 'tenant-a'); assert.equal(a.status, 200); const b = await api(s.url, c, '/api/requests', 'POST', { title: 'Real HTTP', details: 'Record and receipt' }, 'tenant-a'); assert.equal(a.body.id, b.body.id); assert.equal((await api(s.url, c, '/api/requests')).body.items.length, 1); });
test('HTTP input cannot supply a forged tenant', async (t) => { const f = await fixture(t), s = await f.server(), c = await login(s.url); assert.equal((await api(s.url, c, '/api/requests', 'POST', { title: 'No', details: 'No', tenantId: 'tenant-b' })).status, 400); });
test('tenant selector is not a grant', async (t) => { const f = await fixture(t), s = await f.server(), c = await login(s.url, 'viewer'); assert.equal((await api(s.url, c, '/api/requests', 'GET', undefined, 'tenant-b')).status, 403); });
test('cookie mutation requires exact origin', async (t) => { const f = await fixture(t), s = await f.server(), c = await login(s.url); const r = await fetch(s.url + '/api/requests', { method: 'POST', headers: { Cookie: c, Origin: 'https://hostile.example', 'Content-Type': 'application/json', 'X-QB-Tenant': 'tenant-a', 'Idempotency-Key': 'x' }, body: JSON.stringify({ title: 'No', details: 'No' }) }); assert.equal(r.status, 403); });
test('session logout immediately rejects old cookie', async (t) => { const f = await fixture(t), s = await f.server(), c = await login(s.url); assert.equal((await api(s.url, c, '/api/logout', 'POST', {})).status, 200); assert.equal((await api(s.url, c, '/api/requests')).status, 401); });
test('service identity cannot use human login or unrelated reads', async (t) => { const f = await fixture(t), s = await f.server(); const r = await fetch(s.url + '/api/requests', { headers: { Authorization: `Bearer ${SERVICE}`, 'X-QB-Tenant': 'tenant-a' } }); assert.equal(r.status, 403); });
test('HTTP module read-only affects the same public owner', async (t) => { const f = await fixture(t), s = await f.server(), c = await login(s.url); assert.equal((await api(s.url, c, '/api/modules/mode', 'POST', { moduleId: 'service-desk', mode: 'read-only' })).status, 200); assert.equal((await api(s.url, c, '/api/requests', 'POST', { title: 'No', details: 'No' })).status, 409); assert.equal((await api(s.url, c, '/api/requests')).status, 200); });
test('two independently running products use explicit different tenant IDs', async (t) => {
    const target = await fixture(t, 'service-desk', { tenants: ['customer-a', 'customer-b'] }), server = await target.server();
    const source = await fixture(t, 'knowledge', { tenants: ['org-a', 'org-b'], baseUrl: server.url, tenantMap: { 'org-a': 'customer-a', 'org-b': 'customer-b' } });
    const doc = await source.call('POST', '/api/documents', { title: 'Motor inspection', body: 'Check the motor vibration.' }, 'doc');
    const handoff = await source.call('POST', '/api/handoffs', { documentId: doc.id, reason: 'Please inspect the motor' }, 'send');
    assert.equal(handoff.state, 'QUEUED');
    await source.tick();
    await source.tick();
    const receipts = (await source.call('GET', '/api/handoffs')).items;
    assert.equal(receipts[0].outcome, 'DESTINATION_COMMITTED');
    const requests = (await target.call('GET', '/api/requests', undefined, undefined, admin, 'customer-a')).items;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].title, 'Motor inspection');
    assert.equal((await target.call('GET', '/api/requests', undefined, undefined, admin, 'customer-b')).items.length, 0);
});
test('composed product uses public local binding without HTTP', async (t) => { const f = await fixture(t, 'combined'); const d = await f.call('POST', '/api/documents', { title: 'Local instructions', body: 'Service instructions' }, 'doc'); await f.call('POST', '/api/handoffs', { documentId: d.id, reason: 'Open service request' }, 'handoff'); await f.tick(); await f.tick(); assert.equal((await f.call('GET', '/api/requests')).items.length, 1); assert.equal((await f.call('GET', '/api/handoffs')).items[0].outcome, 'DESTINATION_COMMITTED'); });
test('destination permission revoked after submission is not reported as assignment', async (t) => { const target = await fixture(t), server = await target.server(); const source = await fixture(t, 'knowledge', { baseUrl: server.url }); const doc = await source.call('POST', '/api/documents', { title: 'Denied', body: 'Document' }, 'doc'); await source.call('POST', '/api/handoffs', { documentId: doc.id, reason: 'Denied destination' }, 'send'); target.runtime.access.revoke('link','tenant-a','desk.create'); await source.tick(); await source.tick(); const h = (await source.call('GET', '/api/handoffs')).items[0]; assert.equal(h.delivery.error, 'DENIED'); assert.equal(h.target_ref, null); assert.equal((await target.call('GET', '/api/requests')).items.length, 0); });
test('unmapped source tenant is never guessed', async () => { const c = localCommand({ id: 'local-link', revision: '2', sourceProduct: 'example', path: '/api/requests/commit', mode: 'local', destinationProduct: 'service-desk', serviceActor: 'link', destinationInstance: 'desk-test', contract: 'desk.requests.create.v2', tenantMap: { a: 'b' } }, { contract: 'desk.requests.create.v2', resourceType: 'desk.request', receiptPath: '/api/requests/receipt' }, { identity: () => assert.fail('must not resolve unmapped tenant'), invoke: () => assert.fail('must not call'), lookup: () => assert.fail('must not lookup') }); await assert.rejects(c.call({ sourceTenant: 'constructor', input: {}, commandId: 'one', signal: new AbortController().signal }), e => e.code === 'DENIED'); });
test('remote timeout retry preserves exact destination command identity', async (t) => {
    const target = await fixture(t), s = await target.server();
    let lost = true;
    const flaky = async (url, opts) => {
        const r = await fetch(url, opts);
        if (lost && opts.method === 'POST') {
            lost = false;
            await r.arrayBuffer();
            throw Error('response lost after commit');
        }
        return r;
    };
    const c = httpCommand({ id: 'link', revision: '1', sourceProduct: 'other', destinationProduct: 'service-desk', serviceActor: 'link', destinationInstance: target.runtime.host.instanceId, contract: 'desk.requests.create.v2', mode: 'http', tenantMap: { org: 'tenant-a' }, baseUrl: s.url, path: '/api/requests/commit', serviceToken: SERVICE }, { contract: 'desk.requests.create.v2', resourceType: 'desk.request', receiptPath: '/api/requests/receipt' }, flaky);
    const call = { sourceTenant: 'org', input: { title: 'One remote effect', details: 'Simulated lost response' }, commandId: 'stable-key', signal: new AbortController().signal };
    await assert.rejects(c.call(call), e => e.code === 'UNAVAILABLE');
    const response = await c.call(call);
    assert.ok(response.resource.id);
    assert.equal((await target.call('GET', '/api/requests')).items.length, 1);
});
test('unapproved remote plain HTTP destination is refused', () => assert.throws(() => httpCommand({ mode: 'http', baseUrl: 'http://example.com', path: '/api/requests', serviceToken: 'x', tenantMap: {} }), /HTTPS/));
test('module dependency policy applies on cross-owner read', async (t) => { const f = await fixture(t, 'combined'); const doc = await f.call('POST', '/api/documents', { title: 'Protected', body: 'Content' }, 'doc'); f.runtime.access.setMode(admin, 'tenant-a', 'knowledge', 'off'); await assert.rejects(f.call('POST', '/api/handoffs', { documentId: doc.id, reason: 'No access' }, 'h'), e => e.code === 'DISABLED'); });
