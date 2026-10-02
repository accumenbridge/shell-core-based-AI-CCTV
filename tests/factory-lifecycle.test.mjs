import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { copyPortableFixture } from './source-copy.mjs';
import { fixture, PASSWORD, SERVICE, admin } from './helpers.mjs';
import { ROOT } from '../apps/runtime/dist/index.js';
import { ApplicationHost } from '@quadbridge/backend-host';
import { resolve } from '@quadbridge/composition';
import { reactWorkspace } from '@quadbridge/web-shell/react-adapter';
const run = (root, ...args) => { const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000 }); assert.equal(result.status, 0, result.stdout + '\n' + result.stderr); return result.stdout; };
const seed = { id: 'admin', password: PASSWORD, grants: [{ tenantId: 'tenant-a', permissions: ['platform.shell.read', 'desk.read', 'desk.create', 'checklist.read', 'checklist.write'] }] };
test('exported neutral product starts with all domain directories physically absent', async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-export-')), out = join(temp, 'neutral');
    t.after(() => rm(temp, { recursive: true, force: true }));
    run(ROOT, 'tools/factory.mjs', 'assemble', 'neutral', out);
    assert.deepEqual(await readdir(join(out, 'modules')), []);
    run(out, 'tools/link-workspaces.mjs');
    const { createRuntime } = await import(pathToFileURL(join(out, 'apps/runtime/dist/index.js')).href);
    const app = await createRuntime('neutral', { instanceId: 'exported-neutral', dataDirectory: join(temp, 'data'), principals: [seed] });
    assert.equal(app.plan.modules.length, 0);
    assert.equal(app.host.bootstrap(admin, 'tenant-a').workspaces.length, 0);
    await app.close();
});
test('exported Service Desk has no knowledge or handoff package and persists a real record', async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-export-')), out = join(temp, 'desk');
    t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
    run(ROOT, 'tools/factory.mjs', 'assemble', 'service-desk', out);
    assert.deepEqual(await readdir(join(out, 'modules')), ['service-desk']);
    run(out, 'tools/link-workspaces.mjs');
    const { createRuntime } = await import(pathToFileURL(join(out, 'apps/runtime/dist/index.js')).href);
    const app = await createRuntime('service-desk', { instanceId: 'exported-desk', dataDirectory: join(temp, 'data'), principals: [seed] });
    const record = await app.host.execute('POST', '/api/requests', admin, 'tenant-a', { title: 'Exported application', details: 'No copied shell logic' }, new URLSearchParams(), 'record-one');
    assert.ok(record.id);
    await app.close();
});
test('factory export includes the selected Knowledge package closure and actual ai-core dependency', async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-knowledge-export-')), out = join(temp, 'knowledge');
    t.after(() => rm(temp, { recursive: true, force: true }));
    run(ROOT, 'tools/factory.mjs', 'assemble', 'knowledge', out);
    const selectedModules = await readdir(join(out, 'modules'));
    assert.deepEqual(selectedModules.sort(), ['handoff', 'knowledge']);
    const packages = await readdir(join(out, 'packages'));
    assert.ok(packages.includes('ai-core'));
    assert.ok(packages.includes('web-shell'));
    const runtime = JSON.parse(await readFile(join(out, 'apps/runtime/package.json'), 'utf8'));
    assert.equal(runtime.dependencies['@quadbridge/ai-core'], '0.3.0');
    assert.equal(runtime.dependencies['@quadbridge/knowledge'], '0.2.3');
    assert.equal(runtime.dependencies['@quadbridge/handoff'], '0.2.3');
});
test('independent Knowledge and Combined exports invoke real operations without source or compiler trees', async t => {
    for (const product of ['knowledge', 'combined']) {
        const temp = await mkdtemp(join(tmpdir(), `qb-operation-export-${product}-`)), out = join(temp, 'export');
        t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
        run(ROOT, 'tools/factory.mjs', 'assemble', product, out);
        run(out, 'tools/link-workspaces.mjs');
        const plan = JSON.parse(await readFile(join(out, '.artifacts', product, 'plan.json'), 'utf8'));
        const connections = {};
        for (const binding of plan.bindings) if (binding.contract === 'desk.requests.create.v2') connections[binding.instanceId] = {
            revision: 'operation-export-v1', mode: binding.mode, destinationProduct: binding.mode === 'local' ? product : 'service-desk',
            destinationInstance: binding.mode === 'local' ? `operation-${product}` : 'operation-desk', tenantMap: { 'tenant-a': 'tenant-a' },
            baseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE, serviceActor: 'link'
        };
        for (const module of plan.modules) await rm(join(out, 'modules', module.id, 'src'), { recursive: true, force: false });
        for (const entry of await readdir(join(out, 'packages'), { withFileTypes: true })) if (entry.isDirectory()) {
            const source = join(out, 'packages', entry.name, 'src');
            try { await rm(source, { recursive: true, force: false }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await rm(join(out, 'apps', 'runtime', 'src'), { recursive: true, force: false });
        assert.equal((await readdir(join(out, 'node_modules'))).includes('typescript'), false, 'the fixed export does not contain a compiler dependency');
        const { createRuntime } = await import(pathToFileURL(join(out, 'apps/runtime/dist/index.js')).href);
        const dataDirectory = join(temp, 'private-data');
        const app = await createRuntime(product, { instanceId: `operation-${product}`, dataDirectory, principals: [{ id: 'admin', password: PASSWORD,
            grants: [{ tenantId: 'tenant-a', permissions: ['platform.shell.read', ...plan.permissions] }] }], connections });
        try {
            const declarations = app.plan.modules.find(module => module.id === 'knowledge').operations;
            assert.deepEqual(declarations.map(item => item.id).sort(), ['knowledge.documents.create', 'knowledge.documents.get', 'knowledge.documents.search']);
            const created = await app.host.invokeOperation('knowledge.documents.create', 1, admin, 'tenant-a', { title: `${product} export`, body: 'The exported worker indexes this private record.' }, `export-${product}-create`);
            const worker = await app.worker();
            assert.equal(await worker.tick(), true);
            const found = await app.host.invokeOperation('knowledge.documents.search', 1, admin, 'tenant-a', { query: 'exported worker' });
            assert.equal(found.items[0].id, created.id);
            const record = await app.host.invokeOperation('knowledge.documents.get', 1, admin, 'tenant-a', { documentId: created.id });
            assert.equal(record.state, 'READY');
            assert.match(record.excerpt, /private record/);
        } finally { await app.close(); }
    }
});
test('factory refuses collisions and path traversal', () => {
    for (const args of [['create-product', '../escape'], ['create-module', '../escape'], ['create-product', 'neutral'], ['create-module', 'knowledge']]) {
        const result = spawnSync(process.execPath, ['tools/factory.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
    }
});
test('generated full-stack module builds and runs without editing maintained shell source', async (t) => {
    const copied = await copyPortableFixture(t, ROOT, { prefix: 'qb-generator-' });
    const { temp, root: copy } = copied;
    run(copy, 'tools/build.mjs');
    const before = await readFile(join(copy, 'packages/backend-host/src/index.ts'), 'utf8');
    run(copy, 'tools/factory.mjs', 'create-module', 'checklist');
    run(copy, 'tools/factory.mjs', 'create-product', 'facility', '--modules', 'checklist');
    run(copy, 'tools/build.mjs');
    assert.equal(await readFile(join(copy, 'packages/backend-host/src/index.ts'), 'utf8'), before);
    const { createRuntime } = await import(pathToFileURL(join(copy, 'apps/runtime/dist/index.js')).href);
    const app = await createRuntime('facility', { instanceId: 'facility-one', dataDirectory: join(temp, 'data'), principals: [seed] });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    copied.registerCleanup(close);
    const record = await app.host.execute('POST', '/api/checklist', admin, 'tenant-a', { title: 'Generated module, real persistence' }, new URLSearchParams(), 'item-one');
    assert.ok(record.id);
    assert.equal((await app.host.execute('GET', '/api/checklist', admin, 'tenant-a')).items.length, 1);
    assert.equal(app.host.bootstrap(admin, 'tenant-a').workspaces[0].moduleId, 'checklist');
    await close();
});
test('real separate worker process completes a preexisting durable job', async (t) => {
    const f = await fixture(t, 'combined');
    const doc = await f.call('POST', '/api/documents', { title: 'Process separation', body: 'Indexed by another operating-system process.' });
    const config = join(f.dir, 'worker-config.json');
    await writeFile(config, JSON.stringify(f.config), { mode: 0o600 });
    const child = spawn(process.execPath, ['apps/runtime/dist/main.js', '--product', 'combined', '--config', config, '--worker'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => output += d);
    child.stderr.on('data', d => output += d);
    const stopped = new Promise(resolve => child.once('exit', resolve));
    f.registerCleanup(async () => {
        if (child.exitCode !== null) return;
        const waitForStop = ms => new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), ms);
            stopped.then(() => { clearTimeout(timer); resolve(true); });
        });
        child.kill('SIGTERM');
        const stoppedInTime = await waitForStop(5000);
        if (!stoppedInTime) {
            child.kill();
            const forcedStop = await waitForStop(5000);
            if (!forcedStop) throw new Error('Worker child process did not stop during fixture cleanup');
        }
    });
    let ready = false;
    for (let n = 0; n < 80; n++) {
        await new Promise(r => setTimeout(r, 50));
        const d = (await f.call('GET', '/api/documents')).items[0];
        if (d.state === 'READY') {
            ready = true;
            break;
        }
        if (child.exitCode !== null)
            break;
    }
    assert.equal(ready, true, output);
    assert.equal((await f.call('GET', '/api/documents/search?q=operating')).items[0].id, doc.id);
    child.kill('SIGTERM');
    await stopped;
});
test('source-only provider omission is not mistaken for runtime completion', async (t) => { const f = await fixture(t, 'neutral'); assert.equal(f.runtime.host.health().background, 'NOT_REQUIRED'); });
test('React bridge cleanup is idempotent (port contract, not a React runtime test)', () => { const abort = new AbortController(); let mounts = 0, renders = 0, unmounts = 0; const bridge = reactWorkspace(() => { mounts++; return { render: () => renders++, unmount: () => unmounts++ }; }, () => ({ test: true })); const cleanup = bridge.mount({ root: {}, signal: abort.signal }); abort.abort(); cleanup(); assert.equal(mounts, 1); assert.equal(renders, 1); assert.equal(unmounts, 1); });
test('React bridge does not create a root after scope cancellation', () => { const abort = new AbortController(); abort.abort(); const bridge = reactWorkspace(() => assert.fail(), () => null); assert.equal(bridge.mount({ root: {}, signal: abort.signal }), undefined); });
test('generic framework packages import no reference-domain packages', async () => {
    for (const name of await readdir(join(ROOT, 'packages'))) {
        for (const file of await readdir(join(ROOT, 'packages', name, 'src'))) {
            if (!file.endsWith('.ts'))
                continue;
            const text = await readFile(join(ROOT, 'packages', name, 'src', file), 'utf8');
            assert.doesNotMatch(text, /from ['"]@quadbridge\/(knowledge|service-desk|handoff)/, `${name}/${file}`);
        }
    }
});
test('provider failure closes the started modules in reverse dependency order', async () => { const calls = []; const base = { version: '0.1.0', abi: 'quadbridge.module.v1', dependencies: [], provides: [], requires: [], permissions: [], routes: [], workspaces: [], schema: { current: 0, readMin: 0, readMax: 0 }, background: false }; const a = { ...base, id: 'a' }, b = { ...base, id: 'b', dependencies: [{ id: 'a', version: '0.1.0' }] }; const product = { id: 'test', version: '0.1.0', platformAbi: base.abi, title: 'Test', description: '', layout: 'sidebar', modules: [{ id: 'a', version: '0.1.0' }, { id: 'b', version: '0.1.0' }], bindings: [] }; const host = new ApplicationHost(resolve(product, [a, b]), 'test', [{ manifest: a, services: {}, routes: [], async start() { calls.push('start-a'); }, close() { calls.push('close-a'); } }, { manifest: b, services: {}, routes: [], async start() { calls.push('start-b'); throw Error('failed'); }, close() { calls.push('close-b'); } }], {}); await assert.rejects(host.start()); assert.deepEqual(calls, ['start-a', 'start-b', 'close-b', 'close-a']); assert.equal(host.health().api, 'STOPPED'); });
