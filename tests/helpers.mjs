import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, ROOT } from '../apps/runtime/dist/index.js';
export const admin = { id: 'admin', kind: 'user' }, viewer = { id: 'viewer', kind: 'user' };
export const PASSWORD = 'local-fixture-password-only';
export const SERVICE = 'test-only-service-token-not-used-by-demo';
export async function fixture(t, product = 'service-desk', options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'qb-test-'));
    let runtime;
    const servers = [];
    const ownedCleanups = [];
    let cleanupFinished = false;
    let cleanupFailure;
    const cleanup = async () => {
        if (cleanupFinished) {
            if (cleanupFailure) throw cleanupFailure;
            return;
        }
        cleanupFinished = true;
        const failures = [];
        for (const close of ownedCleanups.reverse()) {
            try { await close(); } catch (error) { failures.push(error); }
        }
        for (const s of servers) {
            try { await s.close(); } catch (error) { failures.push(error); }
        }
        if (runtime) {
            try { await runtime.close(); } catch (error) { failures.push(error); }
        }
        try { await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
        catch (error) { failures.push(error); }
        if (failures.length) {
            cleanupFailure = new AggregateError(failures, `Failed to clean test fixture ${dir}`);
            throw cleanupFailure;
        }
    };
    t.after(cleanup);
    try {
        const plan = JSON.parse(await readFile(join(ROOT, '.artifacts', product, 'plan.json'), 'utf8'));
        const tenants = options.tenants ?? ['tenant-a', 'tenant-b'];
        const all = ['platform.shell.read', 'platform.modules.manage', ...plan.permissions];
        const read = ['platform.shell.read', ...new Set(plan.modules.flatMap(m => m.routes.filter(r => r.kind === 'read').map(r => r.permission)))];
        const principals = [{ id: 'admin', password: PASSWORD, grants: tenants.map(tenantId => ({ tenantId, permissions: all })) }, { id: 'viewer', password: PASSWORD, grants: [{ tenantId: tenants[0], permissions: read }] }, { id: 'link', serviceToken: SERVICE, grants: tenants.map(tenantId => ({ tenantId, permissions: ['desk.create', 'desk.receipts.read'] })) }];
        const connections = {};
        for (const b of plan.bindings)
            if (b.contract === 'desk.requests.create.v2')
                connections[b.instanceId] = { revision: 'test-v1', mode: b.mode, destinationProduct: options.destinationProduct ?? (b.mode === 'local' ? product : 'service-desk'), destinationInstance: options.destinationInstance ?? (b.mode === 'local' ? `${product}-test` : 'service-desk-test'), tenantMap: options.tenantMap ?? Object.fromEntries(tenants.map(x => [x, x])), baseUrl: options.baseUrl ?? 'http://127.0.0.1:1', serviceToken: SERVICE, serviceActor: 'link' };
        const config = { instanceId: `${product}-test`, dataDirectory: dir, principals, connections };
        runtime = await createRuntime(product, config);
        const f = { dir, config, get runtime() { return runtime; }, registerCleanup(close) { ownedCleanups.push(close); }, async restart() { await runtime.close(); runtime = await createRuntime(product, config); }, async server() { const s = await runtime.http(0); servers.push(s); return s; }, async call(method, path, input, key = 'command-1', who = admin, tenant = tenants[0]) { const [pathname, query] = path.split('?'); return runtime.host.execute(method, pathname, who, tenant, input, new URLSearchParams(query), method === 'POST' ? key : undefined); }, async tick() { const worker = await runtime.worker(); return worker.tick(); } };
        return f;
    } catch (error) {
        try { await cleanup(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup both failed'); }
        throw error;
    }
}
export async function login(url, user = 'admin') {
    const response = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ username: user, password: PASSWORD }) });
    if (response.status !== 200)
        throw new Error(`login: ${response.status}`);
    return response.headers.get('set-cookie').split(';')[0];
}
export async function api(url, cookie, path, method = 'GET', body, tenant = 'tenant-a', key = 'http-1') {
    const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie, 'X-QB-Tenant': tenant, 'Idempotency-Key': key }, body: method === 'POST' ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json(), headers: r.headers };
}
