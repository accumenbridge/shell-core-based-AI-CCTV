import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/runtime/dist/index.js';
import { startControlPlane } from '../apps/control-plane/dist/main.js';
import { BUILD_FINGERPRINT_FORMAT_VERSION, copyPrivateToolchain, copyReviewedBuildInputs, privateToolchainDigest, reviewedBuildFiles, reviewedBuildFingerprint } from '../apps/control-plane/dist/build-inputs.js';

async function copiedBuildSource(t) {
    const temp = await mkdtemp(join(tmpdir(), 'qb-build-inputs-'));
    t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
    const root = join(temp, 'source');
    await copyReviewedBuildInputs(ROOT, root);
    return { temp, root };
}

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
    await cp(join(ROOT, 'tools/runtime-upgrade.mjs'), join(fixture, 'tools/runtime-upgrade.mjs'));
    await cp(join(ROOT, 'tools/runtime-upgrade-publish.ps1'), join(fixture, 'tools/runtime-upgrade-publish.ps1'));
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

test('reviewed mobile build inputs are copied and contribute to the source fingerprint', async t => {
    const { root } = await copiedBuildSource(t);
    const required = [
        'packages/mobile-shell/src/mobile.css',
        'tools/mobile/assemble.mjs',
        'templates/mobile/package.json',
        'templates/mobile/package-lock.json',
        'templates/mobile/README.md'
    ];
    const admitted = new Set(reviewedBuildFiles(ROOT).map(file => file.relativePath));
    for (const path of required) {
        assert.ok(admitted.has(path), `${path} is in the reviewed source closure`);
        assert.equal(await readFile(join(root, ...path.split('/')), 'utf8'), await readFile(join(ROOT, ...path.split('/')), 'utf8'), `${path} is copied byte-for-byte`);
    }
    const before = reviewedBuildFingerprint(root);
    const css = join(root, 'packages/mobile-shell/src/mobile.css');
    await writeFile(css, `${await readFile(css, 'utf8')}\n/* fixture change */\n`);
    assert.notEqual(reviewedBuildFingerprint(root), before, 'the admitted mobile stylesheet affects the frozen source fingerprint');
});

test('unknown siblings beside the exact mobile build inputs remain rejected', async t => {
    for (const path of ['tools/mobile/unreviewed.mjs', 'templates/mobile/NOTICE.md', 'packages/mobile-shell/src/unreviewed.css']) {
        const { root } = await copiedBuildSource(t);
        const fullPath = join(root, ...path.split('/'));
        await mkdir(join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, 'unreviewed fixture input');
        assert.throws(() => reviewedBuildFiles(root), /Unreviewed|not allowed/u, path);
    }
});

test('v2 build inventories distinguish path and byte boundaries and ignore traversal order', async t => {
    assert.equal(BUILD_FINGERPRINT_FORMAT_VERSION, 2);
    const temp = await mkdtemp(join(tmpdir(), 'qb-build-inventory-v2-'));
    t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
    const makeRoot = async (name, rows) => {
        const root = join(temp, name);
        await mkdir(join(root, 'tools'), { recursive: true });
        for (const [path, bytes] of rows) await writeFile(join(root, ...path.split('/')), bytes);
        return root;
    };
    const first = await makeRoot('first', [['tools/build.mjs', Buffer.from('x')], ['tools/factory.mjs', Buffer.from('y')]]);
    const reverseCreation = await makeRoot('reverse', [['tools/factory.mjs', Buffer.from('y')], ['tools/build.mjs', Buffer.from('x')]]);
    const ambiguousSingleEntry = await makeRoot('single', [['tools/build.mjs', Buffer.from('xtools/factory.mjs\0y')]]);
    const firstDigest = reviewedBuildFingerprint(first);
    assert.equal(reviewedBuildFingerprint(reverseCreation), firstDigest, 'the inventory digest is independent of filesystem creation order');
    assert.notEqual(reviewedBuildFingerprint(ambiguousSingleEntry), firstDigest, 'path and byte-length framing separates formerly ambiguous concatenations');

});

test('reviewed source inventory rejects POSIX backslash separator aliases', {
    skip: process.platform === 'win32' ? 'Windows filesystems cannot create a filename containing a literal backslash' : false
}, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-build-source-backslash-'));
    t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
    const source = join(temp, 'apps', 'example-app', 'src');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'literal\\separator.ts'), 'export const value = 1;');
    assert.throws(() => reviewedBuildFingerprint(temp), /non-portable separator/u,
        'a POSIX filename containing backslash cannot alias a portable nested path');
});

test('private toolchain copy matches its digest and a test-owned native binary drift changes it', async t => {
    const { root } = await copiedBuildSource(t);
    await copyPrivateToolchain(ROOT, root);
    const expected = await privateToolchainDigest(ROOT);
    assert.equal(await privateToolchainDigest(root), expected);
    const nativeName = `@esbuild/${process.platform}-${process.arch}`;
    const executable = join(root, 'node_modules', nativeName, ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']));
    const original = await readFile(executable);
    await writeFile(executable, Buffer.concat([original, Buffer.from('\n// private fixture drift\n')]));
    assert.notEqual(await privateToolchainDigest(root), expected);
});

test('private toolchain inventory rejects POSIX backslash separator aliases', {
    skip: process.platform === 'win32' ? 'Windows filesystems cannot create a filename containing a literal backslash' : false
}, async t => {
    const { root } = await copiedBuildSource(t);
    await copyPrivateToolchain(ROOT, root);
    const alias = join(root, 'node_modules', 'esbuild', 'literal\\separator.js');
    await writeFile(alias, 'toolchain filename fixture');
    await assert.rejects(privateToolchainDigest(root), /non-portable separator/u,
        'private toolchain inventory rejects a physical filename that aliases a nested portable path');
});

test('private toolchain rejects native package version mismatch and binary override', async t => {
    const { root } = await copiedBuildSource(t);
    await copyPrivateToolchain(ROOT, root);
    const nativeName = `@esbuild/${process.platform}-${process.arch}`;
    const packagePath = join(root, 'node_modules', nativeName, 'package.json');
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    manifest.version = '0.0.0';
    await writeFile(packagePath, JSON.stringify(manifest));
    await assert.rejects(privateToolchainDigest(root), /native package .* pinned lockfile and current platform/u);

    const previous = process.env.ESBUILD_BINARY_PATH;
    process.env.ESBUILD_BINARY_PATH = join(root, 'unapproved-esbuild');
    try {
        await assert.rejects(privateToolchainDigest(ROOT), /ESBUILD_BINARY_PATH overrides/u);
        await assert.rejects(copyPrivateToolchain(ROOT, join(root, 'override-copy')), /ESBUILD_BINARY_PATH overrides/u);
    } finally {
        if (previous === undefined) delete process.env.ESBUILD_BINARY_PATH;
        else process.env.ESBUILD_BINARY_PATH = previous;
    }
});
