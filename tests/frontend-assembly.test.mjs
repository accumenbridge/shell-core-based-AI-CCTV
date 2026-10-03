import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../apps/runtime/dist/index.js';
import { assertExpectedFactoryInventory, expectedFactoryInventory } from '../packages/composition/dist/integrity.js';
import { fixture, login, api } from './helpers.mjs';
import { frontendClosure } from '../tools/frontend-closure.mjs';
import { copyPortableFixture } from './source-copy.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
async function assertMissing(path) {
    await assert.rejects(lstat(path), error => error.code === 'ENOENT');
}
test('R05/R06: actual product serves a nested lazy chunk, CSS and both declared workspaces', async (t) => {
    const f = await fixture(t), s = await f.server();
    const ui = await fetch(s.url + '/assets/modules/service-desk/ui.js');
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /ui\/overview.js/);
    const chunk = await fetch(s.url + '/assets/modules/service-desk/ui/overview.js');
    assert.equal(chunk.status, 200);
    assert.match(await chunk.text(), /renderOverview/);
    const css = await fetch(s.url + '/assets/modules/service-desk/ui/overview.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(await (await fetch(s.url)).text(), /ui\/overview.css/);
    assert.equal((await fetch(s.url + '/assets/modules/service-desk/index.js')).status, 404);
    assert.equal((await fetch(s.url + '/assets/modules/knowledge/ui.js')).status, 404);
    const boot = await api(s.url, await login(s.url), '/api/bootstrap');
    assert.deepEqual(boot.body.workspaces.map(w => w.export), ['workspace', 'overviewWorkspace']);
    assert.deepEqual(boot.body.uiContributions.map(item => item.id), ['service-desk.recentRequests']);
    assert.equal(boot.body.uiContributions[0].moduleId, 'service-desk');
    const release = JSON.parse(await readFile(new URL('../.artifacts/service-desk/release.json', import.meta.url)));
    assert.equal(release.web['modules/service-desk/dist/ui/overview.js'], createHash('sha256').update(await readFile(new URL('../modules/service-desk/dist/ui/overview.js', import.meta.url))).digest('hex'));
});
test('reviewed product mapping is literal in the full build and absent from the Desk-only closure', async () => {
    const fullStartup = await readFile(new URL('../.artifacts/combined/composition.js', import.meta.url), 'utf8');
    const deskStartup = await readFile(new URL('../.artifacts/service-desk/composition.js', import.meta.url), 'utf8');
    const fullWeb = JSON.parse(await readFile(new URL('../.artifacts/combined/web.json', import.meta.url), 'utf8'));
    const deskWeb = JSON.parse(await readFile(new URL('../.artifacts/service-desk/web.json', import.meta.url), 'utf8'));
    assert.match(fullStartup, /"workspaceId":"desk\.requests","slot":"workspace\.aside","contributionId":"knowledge\.referenceSearch"/);
    assert.match(fullStartup, /"workspaceId":"knowledge\.library","slot":"workspace\.footer","contributionId":"service-desk\.recentRequests"/);
    assert.match(deskStartup, /uiBindings:\[\]/);
    assert.ok(fullWeb.files['/assets/modules/knowledge/ui.js']);
    assert.equal(deskWeb.files['/assets/modules/knowledge/ui.js'], undefined);
});
async function sourceTree(t, code) {
    const root = await mkdtemp(join(tmpdir(), 'qb-web-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (p, s) => { await mkdir(join(root, p, '..'), { recursive: true }); await writeFile(join(root, p), s); };
    await put('packages/web-shell/dist/index.js', "import './dom.js';");
    await put('packages/web-shell/dist/dom.js', "export { el } from '@quadbridge/ui';");
    await put('packages/web-shell/dist/react-adapter.js', 'export const a=1;');
    await put('packages/ui/dist/index.js', "export { el } from './components.js';");
    await put('packages/ui/dist/components.js', 'export const el=1;');
    await put('packages/ui/dist/tokens.css', '[data-qb-ui-boundary]{color-scheme:light}');
    await put('packages/ui/dist/ui.css', '[data-qb-ui-boundary]{}');
    await put('modules/example/dist/ui.js', code);
    return { root, put, plan: { modules: [{ id: 'example', workspaces: [{}], dependencies: [], browserAssets: [] }] } };
}
test('R05: closure includes static imports, literal lazy chunks and declared asset references', async (t) => {
    const x = await sourceTree(t, "import './nested/helpers.js'; export const load=()=>import('./nested/lazy.js'); const image=new URL('./images/a.svg',import.meta.url);");
    await x.put('modules/example/dist/nested/helpers.js', 'export const a=1;');
    await x.put('modules/example/dist/nested/lazy.js', 'export const b=1;');
    await x.put('modules/example/dist/images/a.svg', '<svg/>');
    const c = await frontendClosure(x.root, x.plan);
    for (const f of ['nested/helpers.js', 'nested/lazy.js', 'images/a.svg'])
        assert.ok(c.files['/assets/modules/example/' + f]);
});
test('UI03: shared UI JS and CSS are explicit in desktop closure ahead of shell and owner styles', async t => {
    const x = await sourceTree(t, 'export const load=()=>import(\'./nested/lazy.js\');');
    await x.put('modules/example/dist/nested/lazy.js', 'export const lazy=1;');
    const c = await frontendClosure(x.root, x.plan);
    assert.equal(c.imports['@quadbridge/ui'], '/assets/packages/ui/index.js');
    assert.equal(c.imports['@quadbridge/ui/components'], '/assets/packages/ui/components.js');
    assert.deepEqual(c.styles, ['/assets/packages/ui/tokens.css', '/assets/packages/ui/ui.css', '/assets/shell.css']);
    assert.equal(c.files['/assets/packages/ui/tokens.css'], 'packages/ui/dist/tokens.css');
    assert.equal(c.files['/assets/packages/ui/ui.css'], 'packages/ui/dist/ui.css');
    assert.ok(c.files['/assets/packages/ui/index.js']);
    assert.ok(c.files['/assets/packages/ui/components.js']);
});
test('R05: missing dependency fails the build rather than making a broken release', async (t) => { const x = await sourceTree(t, "import './missing.js';"); await assert.rejects(frontendClosure(x.root, x.plan)); });
test('R05: server-only package import fails before being publicly packaged', async (t) => { const x = await sourceTree(t, "import {DatabaseSync} from 'node:sqlite';"); await assert.rejects(frontendClosure(x.root, x.plan), /Unsupported browser import/); });
test('R05: nonliteral runtime import is not converted into an arbitrary URL', async (t) => { const x = await sourceTree(t, 'const path=location.hash; import(path);'); await assert.rejects(frontendClosure(x.root, x.plan), /build-time literal/); });
test('R05: a relative import cannot escape the selected module', async (t) => { const x = await sourceTree(t, "import '../../other/dist/ui.js';"); await assert.rejects(frontendClosure(x.root, x.plan), /leaves its owner/); });
test('R05: unsupported stylesheet-as-JavaScript import fails rather than shipping invalid native ESM', async (t) => { const x = await sourceTree(t, "import './style.css';"); await x.put('modules/example/dist/style.css', 'body{}'); await assert.rejects(frontendClosure(x.root, x.plan), /declare styles\/assets separately/); });

test('mobile preview assets survive an ordinary fixed product export and are served by that snapshot', async t => {
    const area = await mkdtemp(join(tmpdir(), 'qb-mobile-export-'));
    let runtime, server;
    t.after(async () => {
        if (server) await server.close();
        if (runtime) await runtime.close();
        await rm(area, { recursive: true, force: true });
    });
    const out = join(area, 'product');
    const assembled = spawnSync(process.execPath, [join(ROOT, 'tools/factory.mjs'), 'assemble', 'service-desk', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(assembled.status, 0, assembled.stderr || assembled.stdout);
    const linked = spawnSync(process.execPath, [join(out, 'tools/link-workspaces.mjs')], { cwd: out, encoding: 'utf8' });
    assert.equal(linked.status, 0, linked.stderr || linked.stdout);
    const web = JSON.parse(await readFile(join(out, '.artifacts/service-desk/web.json'), 'utf8'));
    const release = JSON.parse(await readFile(join(out, '.artifacts/service-desk/release.json'), 'utf8'));
    assert.ok(web.mobile?.entry);
    assert.deepEqual(web.mobile.sourceStyles, [
        '/assets/packages/ui/tokens.css', '/assets/packages/ui/ui.css', '/assets/shell.css',
        '/assets/mobile.css', '/assets/modules/service-desk/ui/overview.css'
    ]);
    for (const url of [web.mobile.entry, ...web.mobile.styles]) {
        const path = web.files[url];
        assert.ok(path);
        assert.equal(release.web[path], createHash('sha256').update(await readFile(join(out, path))).digest('hex'));
    }
    runtime = await createRuntime('service-desk', { instanceId: 'mobile-export', dataDirectory: join(area, 'data'), principals: [] }, out);
    server = await runtime.http(0, { mobilePreview: true });
    const htmlResponse = await fetch(server.url);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, new RegExp(web.mobile.entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const entry = await fetch(new URL(web.mobile.entry, server.url));
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get('content-type'), /javascript/);
    assert.match(await entry.text(), /startMobileShell/);
    for (const style of web.mobile.styles) {
        const response = await fetch(new URL(style, server.url));
        assert.equal(response.status, 200, style);
        assert.match(response.headers.get('content-type'), /text\/css/);
        await response.arrayBuffer();
    }
});

test('mobile rebuild replaces only generated trees and exports the exact compact snapshot inventory', async t => {
    const copied = await copyPortableFixture(t, ROOT, { prefix: 'qb-mobile-rebuild-' });
    const productArtifacts = join(copied.root, '.artifacts', 'service-desk');
    const oldPreview = join(productArtifacts, 'mobile-preview', 'assets', 'app-legacy.js');
    const oldCompact = join(productArtifacts, 'm', 'assets', 'chunk-legacy.js');
    await mkdir(join(productArtifacts, 'mobile-preview', 'assets'), { recursive: true });
    await mkdir(join(productArtifacts, 'm', 'assets'), { recursive: true });
    await writeFile(oldPreview, 'obsolete pre-compaction preview');
    await writeFile(oldCompact, 'obsolete previous compact chunk');
    const siblingMarker = join(productArtifacts, 'preserved-by-mobile-rebuild.txt');
    await writeFile(siblingMarker, 'outside the two generated mobile trees');

    const build = spawnSync(process.execPath, [join(copied.root, 'tools/build.mjs')], {
        cwd: copied.root, encoding: 'utf8', timeout: 180000
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    await assertMissing(join(productArtifacts, 'mobile-preview'));
    await assertMissing(oldPreview);
    await assertMissing(oldCompact);
    assert.equal(await readFile(siblingMarker, 'utf8'), 'outside the two generated mobile trees');

    const plan = JSON.parse(await readFile(join(productArtifacts, 'plan.json'), 'utf8'));
    const web = JSON.parse(await readFile(join(productArtifacts, 'web.json'), 'utf8'));
    assert.ok(await lstat(join(productArtifacts, 'm')));
    assert.ok(Object.values(web.mobile.files).some(path => path.startsWith('.artifacts/service-desk/m/')));
    const output = join(copied.temp, 'service-desk-export');
    const assembled = spawnSync(process.execPath, [join(copied.root, 'tools/factory.mjs'), 'assemble', 'service-desk', output], {
        cwd: copied.root, encoding: 'utf8', timeout: 120000
    });
    assert.equal(assembled.status, 0, `${assembled.stdout}\n${assembled.stderr}`);
    const inventory = expectedFactoryInventory(copied.root, plan);
    assertExpectedFactoryInventory(output, inventory);
    assert.ok(Object.keys(inventory).some(path => path.startsWith('.artifacts/service-desk/m/')));
    assert.ok(!Object.keys(inventory).some(path => path.startsWith('.artifacts/service-desk/mobile-preview/')));
    assert.equal(await readFile(join(output, '.artifacts/service-desk/preserved-by-mobile-rebuild.txt'), 'utf8'), 'outside the two generated mobile trees');

    const q3Root = 'C:\\Users\\Lenovo\\AppData\\Local\\Temp\\q3-f0QSl8\\checkout';
    const snapshotRoot = win32.join(q3Root, '.local', 'platform-runtime-executions',
        'runtime-11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222', 'snapshot');
    for (const path of Object.keys(inventory))
        assert.ok(win32.join(snapshotRoot, ...path.split('/')).length < 240, `snapshot path exceeds runtime bound: ${path}`);
});
