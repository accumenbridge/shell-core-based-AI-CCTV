import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PlatformError } from '../packages/contracts/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { resolve as resolveProduct } from '../packages/composition/dist/index.js';
import { ROOT } from '../apps/runtime/dist/index.js';
import { LocalBuildWorker } from '../apps/control-plane/dist/build-worker.js';
import { copyPrivateToolchain, copyReviewedBuildInputs, reviewedBuildFiles, reviewedBuildFingerprint } from '../apps/control-plane/dist/build-inputs.js';
import { importSourceSnapshot, loadSourceSnapshot } from '../apps/control-plane/dist/source-import.js';
import { copyPortableFixture } from './source-copy.mjs';
import { PASSWORD } from './helpers.mjs';
import { harness, flush } from './support/shell-harness.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const retainedWorkerBuilds = [];

const run = (root, ...args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  const privateRoot = dirname(root);
  const output = `${result.stdout}\n${result.stderr}`.replaceAll(privateRoot, '<private-fixture>');
  assert.equal(result.status, 0, `${args.join(' ')} exited ${result.status ?? result.error?.code ?? 'without an exit code'}\n${output}`);
  return result.stdout;
};

async function httpRequest(server, path, { method = 'GET', cookie, tenant = 'tenant-a', key, body } = {}) {
  const headers = { Origin: server.url, 'X-QB-Tenant': tenant };
  if (cookie) headers.Cookie = cookie;
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(server.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function login(server, username) {
  const response = await fetch(server.url + '/api/session', {
    method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function buildThroughReviewedWorker(sourceRoot) {
  const root = await mkdtemp(join(tmpdir(), 'qe-'));
  let store, worker, failure, result, admittedBuildId;
  try {
    await copyReviewedBuildInputs(sourceRoot, root);
    await copyPrivateToolchain(ROOT, root);
    if (process.platform === 'win32') {
      await mkdir(join(root, '.local'), { recursive: true });
      await copyFile(join(ROOT, '.local', 'platform-build-host.json'), join(root, '.local', 'platform-build-host.json'));
    }
    assert.equal(reviewedBuildFingerprint(root), reviewedBuildFingerprint(sourceRoot), 'the reviewed worker source copy preserves every admitted byte');

    const snapshot = loadSourceSnapshot(root);
    store = new ControlPlaneStore(join(root, '.local', 'control-plane.sqlite'));
    importSourceSnapshot(store, snapshot);
    worker = await LocalBuildWorker.create({ root, store, snapshot, pollMs: 50, leaseMs: 30000, timeoutMs: 180000 });
    await worker.start();
    const product = store.product('generated-entity-suite', '1.0.0');
    assert.ok(product);
    const plan = resolveProduct(product, snapshot.modules);
    assert.deepEqual(plan.modules.map(module => module.id), ['asset-register', 'room-inspection']);
    const admitted = await worker.admit(product, plan, 'entity-builder-reviewed-worker-build-01', 'system:entity-builder-test');
    admittedBuildId = admitted.id;
    const deadline = Date.now() + 240000;
    let built;
    while (Date.now() < deadline) {
      built = store.build(admitted.id);
      if (built && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(built.state)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(built?.state, 'SUCCEEDED', `the normal LocalBuildWorker did not publish a successful generated-source build (${built?.state ?? 'missing'})`);
    const inspected = await worker.inspect(admitted.id);
    assert.equal(inspected.build.productId, product.id);
    assert.equal(inspected.build.version, product.version);
    const manifestPath = join(root, '.local', 'platform-builds', 'snapshots', inspected.snapshot.id, 'QUADBRIDGE-SNAPSHOT.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.sourceFingerprint, snapshot.sourceFingerprint);
    for (const moduleId of ['asset-register', 'room-inspection']) {
      for (const metadata of ['entity-spec.json', 'generation.json', 'README.md']) {
        const relative = `modules/${moduleId}/${metadata}`;
        assert.ok(manifest.files[relative], `the normal worker snapshot retains reviewed generated input ${relative}`);
      }
      assert.ok(manifest.files[`modules/${moduleId}/dist/index.js`], `the worker compiled ${moduleId} from its reviewed copy`);
    }
    result = { buildId: admitted.id, snapshotId: inspected.snapshot.id, sourceFingerprint: snapshot.sourceFingerprint };
  } catch (error) {
    failure = error;
  }

  let cleanupFailure;
  if (worker) {
    try { await worker.close(); worker = undefined; }
    catch (error) { cleanupFailure = error; }
  }
  let cleanupProved = admittedBuildId === undefined;
  if (!cleanupFailure && admittedBuildId && store) {
    const closed = store.build(admittedBuildId);
    const attempt = closed?.attemptDetail;
    cleanupProved = Boolean(closed && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(closed.state) && closed.cleanupState === 'CLEAN' &&
      attempt && attempt.attempt === closed.attempt && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(attempt.state) &&
      attempt.cleanupState === 'CLEAN' && Number.isSafeInteger(attempt.finishedAt));
    if (!cleanupProved) cleanupFailure = new Error('The exact build attempt did not settle with durable CLEAN cleanup facts');
  }
  if (!cleanupFailure && store) {
    try { store.close(); store = undefined; }
    catch (error) { cleanupFailure = error; }
  }
  if (!cleanupFailure) {
    try { await rm(root, { recursive: true, force: false, maxRetries: 4, retryDelay: 100 }); }
    catch (error) { cleanupFailure = error; }
  }
  if (cleanupFailure) {
    if (worker || store) retainedWorkerBuilds.push({ root, worker, store });
    if (failure) throw new AggregateError([failure, cleanupFailure], `The short reviewed-worker fixture was retained at ${root}`);
    throw new Error(`The short reviewed-worker fixture was retained at ${root}; owned cleanup was not proved`, { cause: cleanupFailure });
  }
  if (failure) throw failure;
  return result;
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('generated modules build as separate products and keep owner, receipt, UI selection, and field semantics', async t => {
  const copied = await copyPortableFixture(t, ROOT, { prefix: 'qb-entity-builder-' });
  const { root, temp } = copied;
  let active;
  copied.registerCleanup(async () => {
    if (!active) return;
    const current = active; active = undefined;
    const failures = [];
    if (current.server) try { await current.server.close(); } catch (error) { failures.push(error); }
    if (current.app) try { await current.app.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Generated runtime owner did not close cleanly');
  });

  // create-product reads the compiled source catalogue, so first compile the fresh copy.
  run(root, 'tools/build.mjs');
  for (const moduleId of ['asset-register', 'room-inspection'])
    run(root, 'tools/factory.mjs', 'generate-entity', `examples/entities/${moduleId}.json`);
  run(root, 'tools/factory.mjs', 'create-product', 'maintenance-assets', '--modules', 'asset-register', '--version', '1.0.0');
  run(root, 'tools/factory.mjs', 'create-product', 'site-inspections', '--modules', 'room-inspection', '--version', '2.1.0');
  run(root, 'tools/factory.mjs', 'create-product', 'generated-entity-suite', '--modules', 'asset-register,room-inspection', '--version', '1.0.0');
  run(root, 'tools/build.mjs');

  const reviewed = reviewedBuildFiles(root).map(file => file.relativePath);
  for (const path of [
    'tools/entity-builder.mjs', 'tools/factory.mjs', 'tools/product-source.mjs',
    'templates/entity-backend.ts.txt', 'templates/entity-ui.ts.txt', 'templates/entity.css.txt',
    'modules/asset-register/entity-spec.json', 'modules/asset-register/generation.json', 'modules/asset-register/README.md',
    'modules/room-inspection/entity-spec.json', 'modules/room-inspection/generation.json', 'modules/room-inspection/README.md'
  ]) assert.ok(reviewed.includes(path), `reviewed build identity includes ${path}`);
  const fingerprint = reviewedBuildFingerprint(root);
  for (const relative of ['modules/asset-register/entity-spec.json', 'modules/room-inspection/generation.json']) {
    const path = join(root, ...relative.split('/'));
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
    assert.notEqual(reviewedBuildFingerprint(root), fingerprint, `${relative} bytes participate in the source identity`);
    await writeFile(path, original);
    assert.equal(reviewedBuildFingerprint(root), fingerprint, `${relative} exact restoration returns the captured source identity`);
  }
  const adjacentMetadata = join(root, 'modules', 'asset-register', 'unreviewed-metadata.json');
  await writeFile(adjacentMetadata, '{}', { flag: 'wx' });
  assert.throws(() => reviewedBuildFiles(root), /Unreviewed build input path/);
  await rm(adjacentMetadata, { force: false });
  assert.equal(reviewedBuildFingerprint(root), fingerprint);

  await mkdir(join(temp, 'exports'));
  const exportRoots = new Map();
  const cssRoutes = new Map();
  for (const [productId, moduleId, otherModule, version] of [
    ['maintenance-assets', 'asset-register', 'room-inspection', '1.0.0'],
    ['site-inspections', 'room-inspection', 'asset-register', '2.1.0']
  ]) {
    const plan = JSON.parse(await readFile(join(root, '.artifacts', productId, 'plan.json'), 'utf8'));
    const web = JSON.parse(await readFile(join(root, '.artifacts', productId, 'web.json'), 'utf8'));
    assert.equal(plan.product.version, version);
    assert.deepEqual(plan.modules.map(item => item.id), [moduleId]);
    assert.ok(Object.values(web.files).some(file => file.includes(`modules/${moduleId}/dist/ui`)));
    assert.ok(Object.values(web.files).every(file => !file.includes(`modules/${otherModule}/`)), 'the other generated owner and its UI assets stay outside this product');
    const manifest = JSON.parse(await readFile(join(root, 'modules', moduleId, 'module.json'), 'utf8'));
    assert.deepEqual(manifest.operations.map(item => item.id), [
      `${moduleId}.${moduleId === 'asset-register' ? 'asset' : 'inspection'}.list`,
      `${moduleId}.${moduleId === 'asset-register' ? 'asset' : 'inspection'}.get`,
      `${moduleId}.${moduleId === 'asset-register' ? 'asset' : 'inspection'}.create`,
      `${moduleId}.${moduleId === 'asset-register' ? 'asset' : 'inspection'}.edit`
    ]);
    const out = join(temp, 'exports', productId);
    run(root, 'tools/factory.mjs', 'assemble', productId, out);
    run(out, 'tools/link-workspaces.mjs');
    assert.deepEqual(await readdir(join(out, 'modules')), [moduleId], 'the immutable export contains only its selected generated owner');
    assert.equal((await readdir(join(out, 'node_modules'))).includes('typescript'), false, 'the exported runtime does not need the compiler');
    const cssEntry = Object.entries(web.files).find(([, file]) => file.endsWith(`modules/${moduleId}/dist/ui/entity.css`));
    assert.ok(cssEntry, 'the selected generated owner CSS is in the fixed browser asset closure');
    const sourceCss = await readFile(join(root, 'modules', moduleId, 'src', 'ui', 'entity.css'));
    const exportedCss = await readFile(join(out, ...cssEntry[1].split('/')));
    assert.deepEqual(exportedCss, sourceCss, 'the immutable export retains the exact selected generated CSS bytes');
    const release = JSON.parse(await readFile(join(root, '.artifacts', productId, 'release.json'), 'utf8'));
    assert.equal(release.web[cssEntry[1]], sha256(sourceCss), 'the release inventory binds the selected generated asset bytes');
    cssRoutes.set(productId, { url: cssEntry[0], bytes: sourceCss });
    for (const module of await readdir(join(out, 'modules')))
      await rm(join(out, 'modules', module, 'src'), { recursive: true, force: false });
    for (const packageName of await readdir(join(out, 'packages'))) await rm(join(out, 'packages', packageName, 'src'), { recursive: true, force: false });
    await rm(join(out, 'apps/runtime/src'), { recursive: true, force: false });
    exportRoots.set(productId, out);
  }

  const actors = { admin: { id: 'admin', kind: 'user' }, viewer: { id: 'viewer', kind: 'user' } };
  for (const [productId, moduleId, entityId, displayField, createFields, editFields, label] of [
    ['maintenance-assets', 'asset-register', 'asset', 'assetCode',
      { assetCode: '  ASSET-100  ' }, { assetCode: 'ASSET-100 updated', serviceInterval: 24, active: false, condition: 'repair' }, 'ASSET-100'],
    ['site-inspections', 'room-inspection', 'inspection', 'room',
      { room: 'North hall', score: 4 }, { room: 'North hall revised', score: 5, passed: true, category: 'follow-up' }, 'North hall']
  ]) {
    const permissions = [`${moduleId}.read`, `${moduleId}.write`];
    const config = {
      instanceId: `${productId}-entity-test`, dataDirectory: join(temp, 'data', productId),
      principals: [
        { id: 'admin', password: PASSWORD, grants: ['tenant-a', 'tenant-b'].map(tenantId => ({ tenantId, permissions: ['platform.shell.read', 'platform.modules.manage', ...permissions] })) },
        { id: 'viewer', password: PASSWORD, grants: [{ tenantId: 'tenant-a', permissions: ['platform.shell.read', `${moduleId}.read`] }] }
      ]
    };
    const exportRoot = exportRoots.get(productId);
    const { createRuntime } = await import(pathToFileURL(join(exportRoot, 'apps/runtime/dist/index.js')).href);
    active = { app: await createRuntime(productId, config) };
    active.server = await active.app.http(0);
    const css = cssRoutes.get(productId);
    const servedCss = await fetch(active.server.url + css.url);
    assert.equal(servedCss.status, 200, 'the source-free exported runtime serves its selected generated CSS asset');
    assert.deepEqual(Buffer.from(await servedCss.arrayBuffer()), css.bytes, 'the runtime serves the exact release-bound CSS bytes');
    const adminCookie = await login(active.server, 'admin');
    const viewerCookie = await login(active.server, 'viewer');
    const path = `/api/${moduleId}`;
    const invalidFields = moduleId === 'asset-register' ? { assetCode: 'BAD-100', serviceInterval: 121 } : { room: 'Bad room', score: 6 };
    const invalid = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: `entity-${moduleId}-invalid`, body: { fields: invalidFields } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID');
    assert.deepEqual((await httpRequest(active.server, path, { cookie: adminCookie })).body.items, [], 'rejected source fields create no partial row');
    const createKey = `entity-${moduleId}-create-1`;
    const created = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: createKey, body: { fields: createFields } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok(created.body.id);
    assert.equal(created.body.fields[displayField], label);
    if (moduleId === 'asset-register') {
      assert.equal(created.body.fields.serviceInterval, 12);
      assert.equal(created.body.fields.active, true);
      assert.equal(created.body.fields.condition, 'in-service');
    } else {
      assert.equal(created.body.fields.passed, false);
      assert.equal(created.body.fields.category, 'routine');
      assert.equal(Object.hasOwn(created.body.fields, 'notes'), false);
    }
    const operationReplay = await active.app.host.invokeOperation(`${moduleId}.${entityId}.create`, 1, actors.admin, 'tenant-a', { fields: createFields }, createKey);
    assert.deepEqual(operationReplay, created.body, 'HTTP and operation handlers share the same owner command receipt');
    assert.deepEqual(await active.app.host.invokeOperation(`${moduleId}.${entityId}.list`, 1, actors.admin, 'tenant-a', {}), { items: [{ id: created.body.id, version: 1, label }], limit: 100 });
    assert.deepEqual(await active.app.host.invokeOperation(`${moduleId}.${entityId}.get`, 1, actors.admin, 'tenant-a', { id: created.body.id }), created.body);
    const list = await httpRequest(active.server, path, { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    const detail = await httpRequest(active.server, `${path}/record?id=${encodeURIComponent(created.body.id)}`, { cookie: adminCookie });
    assert.deepEqual(detail.body, created.body);
    const otherTenant = await httpRequest(active.server, path, { cookie: adminCookie, tenant: 'tenant-b' });
    assert.deepEqual(otherTenant.body.items, []);
    const viewerWrite = await httpRequest(active.server, path, { method: 'POST', cookie: viewerCookie, key: `viewer-${moduleId}`, body: { fields: createFields } });
    assert.equal(viewerWrite.status, 403);

    const editKey = `entity-${moduleId}-edit-1`;
    const editBody = { id: created.body.id, expectedVersion: 1, fields: editFields };
    const edited = await httpRequest(active.server, `${path}/edit`, { method: 'POST', cookie: adminCookie, key: editKey, body: editBody });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.version, 2);
    const editReplay = await active.app.host.invokeOperation(`${moduleId}.${entityId}.edit`, 1, actors.admin, 'tenant-a', editBody, editKey);
    assert.deepEqual(editReplay, edited.body);
    const stale = await httpRequest(active.server, `${path}/edit`, {
      method: 'POST', cookie: adminCookie, key: `entity-${moduleId}-stale-edit`,
      body: { ...editBody, fields: { ...editFields, [displayField]: 'Must not overwrite' } }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'CONFLICT');
    const afterConflict = await httpRequest(active.server, `${path}/record?id=${encodeURIComponent(created.body.id)}`, { cookie: adminCookie });
    assert.deepEqual(afterConflict.body, edited.body);

    const mode = await httpRequest(active.server, '/api/modules/mode', { method: 'POST', cookie: adminCookie, body: { moduleId, mode: 'read-only' } });
    assert.equal(mode.status, 200);
    const readOnlyWrite = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: `mode-${moduleId}`, body: { fields: createFields } });
    assert.equal(readOnlyWrite.status, 409);
    assert.equal(readOnlyWrite.body.error.code, 'DISABLED');
    await httpRequest(active.server, '/api/modules/mode', { method: 'POST', cookie: adminCookie, body: { moduleId, mode: 'enabled' } });
    active.app.access.revoke('admin', 'tenant-a', `${moduleId}.write`);
    await active.server.close(); active.server = undefined;
    await active.app.close(); active.app = undefined;

    // Same identity and configuration reopen existing access data; the revoked grant is not reseeded.
    active.app = await createRuntime(productId, config);
    active.server = await active.app.http(0);
    const retained = await httpRequest(active.server, `${path}/record?id=${encodeURIComponent(created.body.id)}`, { cookie: adminCookie });
    assert.equal(retained.status, 200);
    assert.deepEqual(retained.body, edited.body);
    const stillRevoked = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: `after-reopen-${moduleId}`, body: { fields: createFields } });
    assert.equal(stillRevoked.status, 403);
    await active.server.close(); active.server = undefined;
    await active.app.close(); active = undefined;
  }

  const workspaceModuleUrl = pathToFileURL(join(exportRoots.get('site-inspections'), 'modules/room-inspection/dist/ui.js')).href;
  const { workspace } = await import(workspaceModuleUrl);
  const pendingCreate = deferred();
  let savedPayload;
  let existing = { id: 'existing-room', version: 1, fields: { room: 'Existing room', score: 3, passed: false, category: 'routine' } };
  await harness(async env => {
    const api = {
      async get(path) {
        if (path === '/api/room-inspection') return { items: [{ id: existing.id, version: existing.version, label: existing.fields.room }], limit: 100 };
        return { ...existing };
      },
      async post(path, body, commandId) {
        if (path === '/api/room-inspection') { savedPayload = { body, commandId }; return pendingCreate.promise; }
        throw new PlatformError('CONFLICT', 'Record changed; reload before editing');
      }
    };
    const abort = new AbortController();
    const dispose = workspace.mount({ root: env.root, signal: abort.signal, permissions: ['room-inspection.read', 'room-inspection.write'], api });
    await flush();
    const controls = env.all().filter(node => node.name);
    const passed = controls.find(node => node.name === 'passed');
    assert.equal(passed.checked, false);
    assert.equal(passed.required, false, 'false is a valid required boolean value');
    const roomInput = controls.find(node => node.name === 'room'); roomInput.value = 'New room';
    const scoreInput = controls.find(node => node.name === 'score'); scoreInput.value = '4';
    const createForm = env.all().find(node => node.tag === 'form');
    createForm.emit('submit');
    await flush();
    assert.ok(savedPayload);
    assert.deepEqual(savedPayload.body, { fields: { room: 'New room', score: 4, passed: false, category: 'routine' } });
    assert.ok(savedPayload.commandId);

    const existingRow = env.all().find(node => node.tag === 'button' && node.textContent.includes('Existing room'));
    existingRow.emit('click');
    await flush();
    assert.ok(env.all().some(node => node.textContent === 'Inspection · v1'));
    pendingCreate.resolve({ id: 'new-room', version: 1, fields: savedPayload.body.fields });
    for (let i = 0; i < 10 && !env.all().some(node => node.textContent.includes('Saved')); i++) await flush();
    const detail = env.all().find(node => node.className === 'entity-detail');
    assert.ok(detail.textContent.includes('Room: Existing room'));
    assert.ok(!detail.textContent.includes('Room: New room'), 'late create completion cannot take over a newer record selection');

    const editButton = env.all().find(node => node.tag === 'button' && node.textContent === 'Edit record');
    editButton.emit('click');
    await flush();
    const editForm = env.all().find(node => node.tag === 'form' && node.className === 'entity-edit');
    editForm.emit('submit');
    await flush(); await flush();
    assert.ok(env.all().some(node => node.textContent.includes('This version is no longer current')));
    const reload = env.all().find(node => node.tag === 'button' && node.textContent === 'Reload selected record');
    assert.ok(reload, 'a known version conflict offers an explicit reload');
    existing = { ...existing, version: 2, fields: { ...existing.fields, score: 4 } };
    reload.emit('click');
    await flush();
    assert.ok(env.all().some(node => node.textContent === 'Inspection · v2'));
    dispose(); abort.abort();
  });

  const reviewedWorkerBuild = await buildThroughReviewedWorker(root);
  assert.ok(reviewedWorkerBuild.buildId);
  assert.ok(reviewedWorkerBuild.snapshotId);
});
