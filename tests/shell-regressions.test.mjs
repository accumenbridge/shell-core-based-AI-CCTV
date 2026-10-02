/** Real shell JavaScript with controlled document/event/timer/fetch ports, not browser acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Node, json, boot, flush, harness } from './support/shell-harness.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
test('R01: pending tenant change cannot mount or write under obsolete context', () => harness(async (env, start) => {
    const pending = deferred(), mounted = [], sent = [];
    globalThis.fetch = async (path, opts = {}) => {
        const tenant = new Headers(opts.headers).get('X-QB-Tenant') ?? 'tenant-a';
        if (path === '/api/bootstrap')
            return tenant === 'tenant-b' ? pending.promise : json(boot());
        sent.push({ tenant, method: opts.method ?? 'GET' });
        return json({ tenant });
    };
    start({ loaders: { example: async () => ({ workspace: { mount: ctx => { mounted.push(ctx); } } }) } });
    await flush();
    const a = mounted[0];
    const select = env.all().find(n => n.tag === 'select');
    select.value = 'tenant-b';
    select.emit('change');
    await flush();
    env.win.emit('hashchange');
    await flush();
    assert.equal(mounted.length, 1);
    assert.equal(a.signal.aborted, true);
    await assert.rejects(a.api.post('/api/records', { title: 'do not send' }), e => e.name === 'AbortError');
    assert.equal(sent.length, 0);
    pending.resolve(json(boot('tenant-b')));
    await flush();
    const b = mounted.at(-1);
    assert.equal(b.scope.tenantId, 'tenant-b');
    const result = await b.api.post('/api/records', { title: 'B-only' }, 'stable');
    assert.equal(result.tenant, b.scope.tenantId);
    assert.deepEqual(sent, [{ tenant: 'tenant-b', method: 'POST' }]);
}));
test('R01: denied replacement retains no old workspace and no old request authority', () => harness(async (env, start) => {
    let last;
    globalThis.fetch = async (_p, o = {}) => new Headers(o.headers).get('X-QB-Tenant') === 'tenant-b' ? json({ error: { code: 'DENIED', message: 'B denied' } }, 403) : json(boot());
    start({ loaders: { example: async () => ({ workspace: { mount(ctx) { last = ctx; ctx.root.append(new Node('protected')); } } }) } });
    await flush();
    const s = env.all().find(n => n.tag === 'select');
    s.value = 'tenant-b';
    s.emit('change');
    await flush();
    env.win.emit('hashchange');
    await flush();
    assert.equal(last.signal.aborted, true);
    assert.ok(!env.all().some(n => n.tag === 'protected'));
    await assert.rejects(last.api.get('/api/records'), e => e.name === 'AbortError');
}));
test('R01: unchanged periodic bootstrap preserves accepted client scope', () => harness(async (env, start) => {
    let ctx, mounts = 0;
    globalThis.fetch = async (p, o = {}) => p === '/api/bootstrap' ? json(boot()) : json({ tenant: new Headers(o.headers).get('X-QB-Tenant') });
    start({ loaders: { example: async () => ({ workspace: { mount(c) { ctx = c; mounts++; } } }) } });
    await flush();
    await env.refresh();
    assert.equal(mounts, 1);
    assert.equal((await ctx.api.get('/api/records')).tenant, ctx.scope.tenantId);
}));
test('R01: late read denial from aborted scope cannot clear the new scope', () => harness(async (env, start) => {
    const pending = deferred(), ctxs = [];
    globalThis.fetch = async (p, o = {}) => p === '/api/bootstrap' ? json(boot(new Headers(o.headers).get('X-QB-Tenant') ?? 'tenant-a')) : pending.promise;
    start({ loaders: { example: async () => ({ workspace: { mount(ctx) { ctxs.push(ctx); ctx.root.append(new Node('visible')); } } }) } });
    await flush();
    const oldRead = ctxs[0].api.get('/api/records');
    const rejected = assert.rejects(oldRead, e => e.name === 'AbortError');
    const s = env.all().find(n => n.tag === 'select');
    s.value = 'tenant-b';
    s.emit('change');
    await flush();
    pending.resolve(json({ error: { code: 'DENIED', message: 'old denial' } }, 403));
    await rejected;
    await flush();
    assert.equal(ctxs.at(-1).scope.tenantId, 'tenant-b');
    assert.equal(ctxs.at(-1).signal.aborted, false);
    assert.ok(env.all().some(n => n.tag === 'visible'));
}));
test('R01: late lazy import cannot mount into a replacement scope', () => harness(async (env, start) => {
    const lazy = deferred(), mounted = [];
    let n = 0;
    globalThis.fetch = async (_p, o = {}) => json(boot(new Headers(o.headers).get('X-QB-Tenant') ?? 'tenant-a'));
    start({ loaders: { example: async () => ++n === 1 ? lazy.promise : { workspace: { mount(ctx) { mounted.push(ctx.scope.tenantId); } } } } });
    await flush();
    const s = env.all().find(n => n.tag === 'select');
    s.value = 'tenant-b';
    s.emit('change');
    await flush();
    lazy.resolve({ workspace: { mount(ctx) { mounted.push(ctx.scope.tenantId); } } });
    await flush();
    assert.deepEqual(mounted, ['tenant-b']);
}));
test('R08: successful unchanged bootstrap remounts after failed refresh', () => harness(async (env, start) => {
    let fail = false, mounts = 0;
    globalThis.fetch = async () => fail ? json({ error: { code: 'UNAVAILABLE', message: 'try later' } }, 503) : json(boot());
    start({ loaders: { example: async () => ({ workspace: { mount(ctx) { mounts++; ctx.root.append(new Node('protected')); } } }) } });
    await flush();
    fail = true;
    await env.refresh();
    assert.ok(!env.all().some(n => n.tag === 'protected'));
    fail = false;
    await env.refresh();
    assert.equal(mounts, 2);
    assert.ok(env.all().some(n => n.tag === 'protected'));
}));
test('R06: two named workspace exports mount exactly their declarations', () => harness(async (env, start) => {
    const b = boot();
    b.workspaces = [{ ...b.workspaces[0], export: 'listWorkspace' }, { ...b.workspaces[0], id: 'example.detail', path: '/detail', export: 'detailWorkspace' }];
    globalThis.fetch = async () => json(b);
    const mounted = [], w = name => ({ mount: () => { mounted.push(name); } });
    start({ loaders: { example: async () => ({ workspace: w('wrong-default'), listWorkspace: w('list'), detailWorkspace: w('detail') }) } });
    await flush();
    env.loc.hash = '#/detail';
    env.win.emit('hashchange');
    await flush();
    assert.deepEqual(mounted, ['list', 'detail']);
}));
for (const bad of [undefined, {}, { mount: 1 }])
    test(`R06: invalid named export ${JSON.stringify(bad)} never substitutes default`, () => harness(async (env, start) => {
        const b = boot();
        b.workspaces[0].export = 'specific';
        globalThis.fetch = async () => json(b);
        let wrong = 0;
        start({ loaders: { example: async () => ({ workspace: { mount() { wrong++; } }, specific: bad }) } });
        await flush();
        assert.equal(wrong, 0);
        assert.match(env.root.textContent, /specific is unavailable/);
    }));
test('R01: stale workspace notifications cannot overwrite current UI', () => harness(async (env, start) => {
    const contexts = [];
    globalThis.fetch = async (_p, o = {}) => json(boot(new Headers(o.headers).get('X-QB-Tenant') ?? 'tenant-a'));
    start({ loaders: { example: async () => ({ workspace: { mount(c) { contexts.push(c); } } }) } });
    await flush();
    const s = env.all().find(n => n.tag === 'select');
    s.value = 'tenant-b';
    s.emit('change');
    await flush();
    contexts[1].notice('new');
    contexts[0].notice('old secret');
    assert.match(env.root.textContent, /new/);
    assert.doesNotMatch(env.root.textContent, /old secret/);
}));

test('fixed UI contribution uses its declaring module read API and is disposed with the workspace scope', () => harness(async (env, start) => {
    const b = boot(), contexts = [], disposed = [];
    b.permissions.push('knowledge.read');
    b.modules = [{ id: 'service-desk', version: '0.2.1', mode: 'enabled' }, { id: 'knowledge', version: '0.2.3', mode: 'enabled' }];
    b.workspaces = [{ id: 'desk.requests', label: 'Service requests', path: '/requests', moduleId: 'service-desk', export: 'workspace' }];
    b.operations = [
        { method: 'GET', path: '/api/requests', moduleId: 'service-desk' },
        { method: 'GET', path: '/api/documents/search', moduleId: 'knowledge' }
    ];
    b.uiContributions = [
        { id: 'knowledge.referenceSearch', permission: 'knowledge.read', export: 'referenceSearchPanel', label: 'Reference search', moduleId: 'knowledge' },
        { id: 'knowledge.referenceSummary', permission: 'knowledge.read', export: 'referenceSummaryPanel', label: 'Reference summary', moduleId: 'knowledge' }
    ];
    const calls = [];
    globalThis.fetch = async (path, options = {}) => {
        const tenant = new Headers(options.headers).get('X-QB-Tenant') ?? 'tenant-a';
        if (path === '/api/bootstrap') return json({ ...b, scope: { ...b.scope, tenantId: tenant } });
        calls.push({ path, method: options.method ?? 'GET', tenant });
        return json({ items: [] });
    };
    start({
        uiBindings: [
            { workspaceId: 'desk.requests', slot: 'workspace.aside', contributionId: 'knowledge.referenceSearch' },
            { workspaceId: 'desk.requests', slot: 'workspace.aside', contributionId: 'knowledge.referenceSummary' }
        ],
        loaders: {
            'service-desk': async () => ({ workspace: { mount() {} } }),
            knowledge: async () => ({
                referenceSearchPanel: { mount(ctx) {
                    contexts.push(ctx);
                    ctx.root.append(new Node('reference-search-panel'));
                    void ctx.api.get('/api/documents/search?q=needle', ctx.signal);
                    return () => disposed.push(ctx.scope.tenantId);
                } },
                referenceSummaryPanel: { mount() { throw new Error('isolated sibling failure'); } }
            })
        }
    });
    await flush();
    assert.equal(contexts.length, 1);
    assert.equal('post' in contexts[0].api, false);
    assert.deepEqual(calls, [{ path: '/api/documents/search?q=needle', method: 'GET', tenant: 'tenant-a' }]);
    assert.ok(env.all().some(node => node.className.includes('workspace-contribution-slot') && !node.hidden));
    assert.ok(env.all().some(node => node.tag === 'reference-search-panel'), 'a failing sibling cannot erase a mounted contribution');
    assert.ok(env.root.textContent.includes('Reference summary is unavailable.'));

    const prior = contexts[0];
    const tenant = env.all().find(node => node.tag === 'select');
    tenant.value = 'tenant-b';
    tenant.emit('change');
    await flush();
    assert.equal(prior.signal.aborted, true);
    assert.deepEqual(disposed, ['tenant-a']);
    await assert.rejects(prior.api.get('/api/documents/search?q=late'), error => error.name === 'AbortError');
    assert.equal(contexts.length, 2);
}));
