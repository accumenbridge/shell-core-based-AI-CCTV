import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { PlatformError, canonical } from '../packages/contracts/dist/index.js';
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
// Reusable source-only fixture for optional values: blank boolean/enum means omission.
const OPTIONAL_FIELD_SPEC = {
  schema: 'quadbridge.entity-spec.v1',
  module: { id: 'room-inspection', version: '0.1.0', label: 'Room Inspection' },
  entity: { id: 'inspection', label: 'Inspection', displayField: 'room' },
  fields: [
    { id: 'room', label: 'Room', type: 'text', required: true, minLength: 2, maxLength: 3 },
    { id: 'tag', label: 'Tag', type: 'text', required: false, minLength: 2, maxLength: 3, default: ' 😀a ' },
    { id: 'notes', label: 'Notes', type: 'text', required: false, minLength: 1, maxLength: 1000 },
    { id: 'score', label: 'Score', type: 'integer', required: true, minimum: 0, maximum: 5 },
    { id: 'passed', label: 'Passed', type: 'boolean', required: false },
    { id: 'category', label: 'Category', type: 'enum', required: false, values: ['routine', 'follow-up'] }
  ]
};

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
    const safeFailureCodes = [built?.failureCode, built?.attemptDetail?.errorCode]
      .filter(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value));
    assert.equal(built?.state, 'SUCCEEDED', `the normal LocalBuildWorker did not publish a successful generated-source build (${built?.state ?? 'missing'}; ${safeFailureCodes.join('/') || 'no-safe-code'})`);
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
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, message) {
  for (let turn = 0; turn < 100 && !predicate(); turn++) await flush();
  assert.ok(predicate(), message);
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
  await writeFile(join(root, 'examples/entities/room-inspection.json'), `${JSON.stringify(OPTIONAL_FIELD_SPEC, null, 2)}\n`);
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
      { room: '😀a', score: 4 }, { room: 'e\u0301', score: 5, passed: false, category: 'follow-up' }, '😀a']
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
    const invalidFields = moduleId === 'asset-register' ? { assetCode: 'BAD-100', serviceInterval: 121 } : { room: 'abc', score: 6 };
    const invalid = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: `entity-${moduleId}-invalid`, body: { fields: invalidFields } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID');
    assert.equal(invalid.body.error.commandOutcome.state, 'REJECTED_NO_BUSINESS_EFFECTS');
    assert.equal(invalid.body.error.commandOutcome.scope, 'ORIGINAL_COMMAND');
    assert.equal(invalid.body.error.commandOutcome.command.id, `entity-${moduleId}-invalid`);
    assert.equal(invalid.body.error.commandOutcome.command.operation, `${moduleId}.${entityId}.create`);
    assert.equal(invalid.body.error.commandOutcome.command.productId, productId);
    assert.equal(invalid.body.error.commandOutcome.command.instanceId, active.app.host.instanceId);
    assert.equal(invalid.body.error.commandOutcome.command.tenantId, 'tenant-a');
    assert.equal(invalid.body.error.commandOutcome.command.actor.id, 'admin');
    assert.equal(invalid.body.error.commandOutcome.command.submittedPayloadDigest, sha256(canonical({ fields: invalidFields })));
      assert.ok(invalid.body.error.fieldErrors.some(error => error.path === `fields.${moduleId === 'asset-register' ? 'serviceInterval' : 'score'}`),
        `generated owner returns a safe camelCase or standard field path bound to the submitted payload: ${JSON.stringify(invalid.body)}`);
    if (moduleId === 'room-inspection') {
      for (const [key, room] of [['short', '😀'], ['long', '😀abc'], ['nul', 'ab\0c']]) {
        const rejected = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: `entity-room-${key}`, body: { fields: { room, score: 4 } } });
        assert.equal(rejected.status, 400, `${key} Unicode input is rejected before owner persistence`);
        assert.equal(rejected.body.error.code, 'INVALID');
        assert.doesNotMatch(JSON.stringify(rejected.body), /SQLITE_CONSTRAINT|CHECK constraint/u, 'raw SQLite check errors are not exposed');
      }
    }
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
      assert.equal(created.body.fields.tag, '😀a', 'text defaults are trimmed and bounded in Unicode code points');
      assert.equal(Object.hasOwn(created.body.fields, 'passed'), false);
      assert.equal(Object.hasOwn(created.body.fields, 'category'), false);
      assert.equal(Object.hasOwn(created.body.fields, 'notes'), false);
      const owner = new DatabaseSync(join(config.dataDirectory, 'modules', 'room-inspection.sqlite'));
      try {
        const insert = owner.prepare('INSERT INTO inspection_records(tenant,id,version,room,tag,score) VALUES(?,?,?,?,?,?)');
        const failsCheck = action => assert.throws(action, error => error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === 19);
        failsCheck(() => insert.run('tenant-a', 'direct-short', 1, '😀', '😀a', 4));
        failsCheck(() => insert.run('tenant-a', 'direct-long', 1, '😀abc', '😀a', 4));
        failsCheck(() => insert.run('tenant-a', 'direct-nul', 1, 'ab\0c', '😀a', 4));
      } finally { owner.close(); }
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
    let finalRecord = edited.body;
    if (moduleId === 'room-inspection') {
      assert.equal(edited.body.fields.passed, false, 'an explicit false optional boolean is retained');
      assert.equal(edited.body.fields.category, 'follow-up', 'an explicit optional enum value is retained');
      const cleared = await httpRequest(active.server, `${path}/edit`, { method: 'POST', cookie: adminCookie, key: 'entity-room-inspection-clear-optionals',
        body: { id: created.body.id, expectedVersion: 2, fields: { room: 'abc', score: 5 } } });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(cleared.body.version, 3);
      for (const optional of ['passed', 'category', 'notes']) assert.equal(Object.hasOwn(cleared.body.fields, optional), false, `${optional} stays absent when not set`);
      assert.equal(cleared.body.fields.tag, '😀a');
      finalRecord = cleared.body;
    }
    const staleBody = { ...editBody, fields: { ...editFields, [displayField]: moduleId === 'room-inspection' ? 'xyz' : 'Must not overwrite' } };
    const staleKey = `entity-${moduleId}-stale-edit`;
    const stale = await httpRequest(active.server, `${path}/edit`, { method: 'POST', cookie: adminCookie, key: staleKey, body: staleBody });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'CONFLICT');
    assert.equal(stale.body.error.commandOutcome.state, 'REJECTED_NO_BUSINESS_EFFECTS');
    assert.equal(stale.body.error.commandOutcome.command.id, staleKey);
    assert.equal(stale.body.error.commandOutcome.command.submittedPayloadDigest, sha256(canonical(staleBody)));
    const staleReplay = await httpRequest(active.server, `${path}/edit`, { method: 'POST', cookie: adminCookie, key: staleKey, body: staleBody });
    assert.deepEqual(staleReplay.body.error.commandOutcome, stale.body.error.commandOutcome, 'exact rejected edit retry replays the same terminal original outcome');
    const staleRebound = await httpRequest(active.server, `${path}/edit`, { method: 'POST', cookie: adminCookie, key: staleKey, body: { ...staleBody, expectedVersion: staleBody.expectedVersion + 1 } });
    assert.equal(staleRebound.body.error.code, 'CONFLICT');
    assert.equal(staleRebound.body.error.commandOutcome, undefined, 'a rejected command key cannot certify a changed payload');
    const afterConflict = await httpRequest(active.server, `${path}/record?id=${encodeURIComponent(created.body.id)}`, { cookie: adminCookie });
    assert.deepEqual(afterConflict.body, finalRecord);

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
    assert.deepEqual(retained.body, finalRecord);
    const stillRevoked = await httpRequest(active.server, path, { method: 'POST', cookie: adminCookie, key: `after-reopen-${moduleId}`, body: { fields: createFields } });
    assert.equal(stillRevoked.status, 403);
    await active.server.close(); active.server = undefined;
    await active.app.close(); active = undefined;
  }

  const siteExportRoot = exportRoots.get('site-inspections');
  const workspaceModuleUrl = pathToFileURL(join(siteExportRoot, 'modules/room-inspection/dist/ui.js')).href;
  const { workspace } = await import(workspaceModuleUrl);
  const { markTrustedCommandError: markExportedTrustedCommandError } = await import(pathToFileURL(join(siteExportRoot, 'packages/contracts/dist/ui-state.js')).href);
  const pendingCreate = deferred(), afterDisposeCreate = deferred();
  const createAttempts = [], editAttempts = [], postSignals = [];
  let savedPayload;
  let existing = { id: 'existing-room', version: 1, fields: { room: 'Existing room', score: 3, passed: false, category: 'routine' } };
  await harness(async env => {
    const api = {
      async get(path) {
        if (path === '/api/room-inspection') return { items: [{ id: existing.id, version: existing.version, label: existing.fields.room }], limit: 100 };
        return { ...existing };
      },
      async post(path, body, commandId, requestSignal) {
        postSignals.push(requestSignal);
        if (path === '/api/room-inspection') {
          const captured = { body: structuredClone(body), commandId };
          createAttempts.push(captured);
          if (createAttempts.length === 1) throw new Error('The first response was not received');
          if (createAttempts.length === 3) return afterDisposeCreate.promise;
          savedPayload = captured;
          return pendingCreate.promise;
        }
        editAttempts.push({ body: structuredClone(body), commandId });
        if (editAttempts.length === 1) {
          const error = new PlatformError('CONFLICT', 'Record changed; compare with the current version');
          markExportedTrustedCommandError(error, {
            schema: 'quadbridge.command-outcome.v1', state: 'REJECTED_NO_BUSINESS_EFFECTS', scope: 'ORIGINAL_COMMAND', terminal: true,
            command: { id: commandId, operation: 'room-inspection.inspection.edit', productId: 'site-inspections', instanceId: 'inspection-ui-test', tenantId: 'tenant-a', actor: { id: 'admin', kind: 'user' }, submittedPayloadDigest: sha256(canonical(body)) }
          });
          throw error;
        }
        existing = { id: body.id, version: body.expectedVersion + 1, fields: structuredClone(body.fields) };
        return existing;
      }
    };
    const abort = new AbortController();
    const dispose = workspace.mount({ root: env.root, scope: { productId: 'site-inspections', instanceId: 'inspection-ui-test', tenantId: 'tenant-a' }, actor: { id: 'admin', kind: 'user' }, signal: abort.signal, permissions: ['room-inspection.read', 'room-inspection.write'], api });
    await flush();
    const controls = env.all().filter(node => node.name);
    const passed = controls.find(node => node.name === 'passed');
    assert.equal(passed.value, '', 'an optional boolean begins in its not-set state');
    assert.equal(passed.required, false, 'false is a valid required boolean value');
    const roomInput = controls.find(node => node.name === 'room');
    assert.equal(roomInput.maxLength, undefined, 'the UI has no UTF-16 native maxlength gate');
    const scoreInput = controls.find(node => node.name === 'score'); scoreInput.value = '4';
    const createForm = env.all().find(node => node.tag === 'form');
    roomInput.value = '😀'; createForm.emit('submit'); await flush();
    assert.equal(createAttempts.length, 0, 'one code point is rejected by the UI before the API call');
    roomInput.value = '😀abc'; createForm.emit('submit'); await flush();
    assert.equal(createAttempts.length, 0, 'too many code points are rejected by the UI before the API call');
    roomInput.value = '😀a';
    createForm.emit('submit');
    await flushUntil(() => createAttempts.length === 1, 'valid create reaches the API after command capture');
    assert.equal(createAttempts.length, 1, `valid create did not reach the API: ${JSON.stringify(env.all().filter(node => node.tag === 'p').map(node => node.textContent))}`);
    assert.deepEqual(createAttempts[0].body, { fields: { room: '😀a', tag: '😀a', score: 4 } }, 'Unicode text and its normalized default share the API schema bounds');
    roomInput.value = 'Draft changed after uncertain response';
    createForm.emit('input');
    const retry = env.all().find(node => node.tag === 'button' && node.textContent === 'Retry the exact command');
    retry.emit('click');
    await flush();
    assert.equal(createAttempts.length, 2);
    assert.deepEqual(createAttempts[1], createAttempts[0], 'retry preserves the original payload and command identity after draft edits');
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
    const editRoom = env.all().filter(node => node.name === 'room').at(-1);
    editRoom.value = '😀'; editForm.emit('submit'); await flush();
    assert.equal(editAttempts.length, 0, 'edit UI applies the same minimum code-point rule');
    editRoom.value = 'e\u0301';
    for (const id of ['passed', 'category']) env.all().filter(node => node.name === id).at(-1).value = '';
    existing = { ...existing, version: 2, fields: { ...existing.fields, score: 4 } };
    editForm.emit('submit');
    await flushUntil(() => editAttempts.length === 1, 'valid edit reaches the API after command capture');
    assert.equal(editAttempts.length, 1);
    assert.deepEqual(editAttempts[0].body.fields, { room: 'e\u0301', tag: '😀a', score: 3 }, 'combining marks count as two code points and optional controls may remain unset');
    assert.ok(env.all().some(node => node.textContent.includes('Current version 2')));
    assert.equal(editRoom.value, 'e\u0301', 'terminal rejection preserves the submitted draft for comparison');
    const useCurrent = env.all().find(node => node.tag === 'button' && node.textContent === 'Use current version for this draft');
    assert.ok(useCurrent, 'a matching terminal owner rejection offers an explicit newer-version comparison');
    useCurrent.emit('click');
    editForm.emit('submit');
    await flush();
    await flush();
    assert.equal(editAttempts.length, 2);
    assert.notEqual(editAttempts[1].commandId, editAttempts[0].commandId, 'a corrected command receives a fresh key only after the original terminal rejection');
    assert.equal(editAttempts[1].body.expectedVersion, 2);
    assert.deepEqual(editAttempts[1].body.fields, editAttempts[0].body.fields, 'the draft survives the version comparison');
    assert.ok(env.all().some(node => node.textContent === 'Inspection · v3'));
    roomInput.value = 'xyz';
    createForm.emit('submit');
    await flushUntil(() => createAttempts.length === 3, 'valid pending create reaches the API after command capture');
    assert.equal(createAttempts.length, 3, 'a new command is admitted after the preceding write is confirmed');
    const retryPanel = env.all().find(node => node.className === 'entity-retry');
    dispose();
    assert.equal(postSignals.at(-1).aborted, true, 'cleanup aborts workspace-owned pending requests even if the parent signal stays active');
    assert.equal(roomInput.value, '', 'cleanup clears the held create draft even when its signal is not aborted');
    assert.ok(!env.all().some(node => node.textContent === 'Inspection · v3'), 'cleanup clears selected record presentation');
    afterDisposeCreate.reject(new Error('late post-cleanup failure'));
    await flush(); await flush();
    assert.equal(retryPanel.hidden, true, 'a late request failure cannot republish pending intent or retry state after cleanup');
    assert.doesNotMatch(env.root.textContent, /late post-cleanup failure/);
    abort.abort();
  });

  const reviewedWorkerBuild = await buildThroughReviewedWorker(root);
  assert.ok(reviewedWorkerBuild.buildId);
  assert.ok(reviewedWorkerBuild.snapshotId);
});
