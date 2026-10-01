import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fixture, login, api } from './helpers.mjs';
import { frontendClosure } from '../tools/frontend-closure.mjs';
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
    const release = JSON.parse(await readFile(new URL('../.artifacts/service-desk/release.json', import.meta.url)));
    assert.equal(release.web['modules/service-desk/dist/ui/overview.js'], createHash('sha256').update(await readFile(new URL('../modules/service-desk/dist/ui/overview.js', import.meta.url))).digest('hex'));
});
async function sourceTree(t, code) {
    const root = await mkdtemp(join(tmpdir(), 'qb-web-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (p, s) => { await mkdir(join(root, p, '..'), { recursive: true }); await writeFile(join(root, p), s); };
    await put('packages/web-shell/dist/index.js', "import './dom.js';");
    await put('packages/web-shell/dist/dom.js', 'export const el=1;');
    await put('packages/web-shell/dist/react-adapter.js', 'export const a=1;');
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
test('R05: missing dependency fails the build rather than making a broken release', async (t) => { const x = await sourceTree(t, "import './missing.js';"); await assert.rejects(frontendClosure(x.root, x.plan)); });
test('R05: server-only package import fails before being publicly packaged', async (t) => { const x = await sourceTree(t, "import {DatabaseSync} from 'node:sqlite';"); await assert.rejects(frontendClosure(x.root, x.plan), /Unsupported browser import/); });
test('R05: nonliteral runtime import is not converted into an arbitrary URL', async (t) => { const x = await sourceTree(t, 'const path=location.hash; import(path);'); await assert.rejects(frontendClosure(x.root, x.plan), /build-time literal/); });
test('R05: a relative import cannot escape the selected module', async (t) => { const x = await sourceTree(t, "import '../../other/dist/ui.js';"); await assert.rejects(frontendClosure(x.root, x.plan), /leaves its owner/); });
test('R05: unsupported stylesheet-as-JavaScript import fails rather than shipping invalid native ESM', async (t) => { const x = await sourceTree(t, "import './style.css';"); await x.put('modules/example/dist/style.css', 'body{}'); await assert.rejects(frontendClosure(x.root, x.plan), /declare styles\/assets separately/); });
