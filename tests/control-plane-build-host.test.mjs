import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/runtime/dist/index.js';
import { startControlPlane } from '../apps/control-plane/dist/main.js';
import { copyReviewedBuildInputs } from '../apps/control-plane/dist/build-inputs.js';

test('paired console starts with no private build-host profile and reports build requests unavailable', async t => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-missing-build-host-'));
    const fixture = join(temp, 'source');
    let controlPlane;
    t.after(async () => {
        try { await controlPlane?.close(); }
        finally { await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    });

    await copyReviewedBuildInputs(ROOT, fixture);
    await mkdir(join(fixture, 'tools'), { recursive: true });
    await cp(join(ROOT, 'tools/runtime-recovery.mjs'), join(fixture, 'tools/runtime-recovery.mjs'));
    await cp(join(ROOT, 'tools/runtime-recovery-publish.ps1'), join(fixture, 'tools/runtime-recovery-publish.ps1'));
    await mkdir(join(fixture, 'apps/studio-web/dist'), { recursive: true });
    await cp(join(ROOT, 'apps/studio-web/dist/main.js'), join(fixture, 'apps/studio-web/dist/main.js'));
    assert.equal(await access(join(fixture, '.local')).then(() => true, () => false), false);

    const log = console.log, warn = console.warn;
    try {
        console.log = () => {};
        console.warn = () => {};
        controlPlane = await startControlPlane({ root: fixture, databasePath: join(temp, 'control-plane.sqlite'), port: 0 });
    } finally {
        console.log = log;
        console.warn = warn;
    }

    assert.equal((await fetch(new URL('/healthz', controlPlane.url))).status, 200);
    assert.equal((await fetch(new URL('/', controlPlane.url))).status, 200);
    assert.equal((await fetch(new URL('/main.js', controlPlane.url))).status, 200);
    const origin = controlPlane.url;
    const paired = await fetch(new URL('/platform-api/session', origin), {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ code: controlPlane.pairingCode })
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const overviewResponse = await fetch(new URL('/platform-api/overview', origin), { headers: { cookie } });
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.equal(overview.capabilities.find(capability => capability.id === 'build-executor')?.status, 'not-attached');
    assert.equal(overview.capabilities.find(capability => capability.id === 'application-runtime')?.status, 'attached',
        'runtime control is attached independently of the optional compiler profile');
    const runtimeList = await fetch(new URL('/platform-api/runtime-instances', origin), { headers: { cookie } });
    assert.equal(runtimeList.status, 200);
    assert.deepEqual((await runtimeList.json()).instances, []);
    const unavailableRuntime = await fetch(new URL('/platform-api/runtime-instances', origin), {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, productId: 'service-desk', version: '0.2.0', requestKey: 'no-profile-runtime-0001' })
    });
    assert.equal(unavailableRuntime.status, 503);
    assert.equal((await unavailableRuntime.json()).code, 'RUNTIME_UNAVAILABLE');
    assert.deepEqual((await fetch(new URL('/platform-api/runtime-instances', origin), { headers: { cookie } }).then(response => response.json())).instances, [],
        'an unavailable selected host does not create runtime state');
    const buildsBefore = await fetch(new URL('/platform-api/builds', origin), { headers: { cookie } }).then(response => response.json());
    const denied = await fetch(new URL('/platform-api/builds', origin), {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, productId: 'service-desk', version: '0.2.0', requestKey: 'no-profile-build-0001' })
    });
    assert.equal(denied.status, 503);
    const buildsAfter = await fetch(new URL('/platform-api/builds', origin), { headers: { cookie } }).then(response => response.json());
    assert.deepEqual(buildsAfter, buildsBefore);
});
