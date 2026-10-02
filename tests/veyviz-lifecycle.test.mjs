import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProduct, prepareProduct, ROOT } from '../tools/veyviz-start.mjs';

async function login(app, who = 'admin') {
  const credentials = JSON.parse(await readFile(app.credentialsPath, 'utf8'));
  const response = await fetch(app.url + '/api/session', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: who, password: credentials[who] }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function api(app, cookie, path, { method = 'GET', body, tenant = 'alpha', key = 'lifecycle-command' } = {}) {
  const response = await fetch(app.url + path, { method, headers: { Cookie: cookie, Origin: app.url, 'X-QB-Tenant': tenant, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
test('Veyviz refuses a modified enrollment plan before creating identities or data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'veyviz-plan-denial-'));
  const artifact = join(root, '.artifacts/veyviz-catalog');
  await mkdir(artifact, { recursive: true });
  const plan = JSON.parse(await readFile(join(ROOT, '.artifacts/veyviz-catalog/plan.json'), 'utf8'));
  plan.permissions.push('unreviewed.permission');
  await writeFile(join(artifact, 'plan.json'), JSON.stringify(plan));
  await copyFile(join(ROOT, '.artifacts/veyviz-catalog/release.json'), join(artifact, 'release.json'));
  const dataRoot = join(root, 'private-data');
  await assert.rejects(prepareProduct({ root, product: 'veyviz-catalog', dataRoot }), /digest mismatch/);
  assert.equal(existsSync(dataRoot), false);
});
test('invalid port fails before creating a pending product enrollment', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'veyviz-invalid-port-'));
  const dataRoot = join(parent, 'new-data');
  await assert.rejects(startProduct({ product: 'veyviz-catalog', dataRoot, port: -1 }), /Invalid port/);
  assert.equal(existsSync(dataRoot), false);
});
test('an unclean owned process exit remains quarantined on later launch', { timeout: 30_000 }, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'veyviz-uncertain-owner-'));
  const app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  // Catalog has no native AI children. Interrupt only the test's live owned handle.
  app.child.kill('SIGKILL');
  const closed = await app.completion;
  assert.equal(closed.cleanup, false);
  assert.equal(JSON.parse(await readFile(app.ownerPath, 'utf8')).state, 'UNKNOWN');
  await assert.rejects(startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 }), /cleanup is unconfirmed/);
});
test('Veyviz catalog runs independently, scopes records, and retains them through observed graceful restart', { timeout: 120_000 }, async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'veyviz-local-lifecycle-'));
  let app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  t.after(async () => { if (app) await app.stop(); });
  const firstFingerprint = app.fingerprint;
  let cookie = await login(app);
  const created = await api(app, cookie, '/api/sources', { method: 'POST', body: { name: 'Retained recording', fixtureId: 'mivia-vid0062' } });
  assert.equal(created.status, 200);
  const listed = await api(app, cookie, '/api/sources');
  assert.equal(listed.body.items.length, 1);
  assert.equal((await api(app, cookie, '/api/sources', { tenant: 'beta' })).body.items.length, 0);
  assert.equal((await api(app, cookie, '/api/analysis')).status, 404);
  const viewer = await login(app, 'viewer');
  assert.equal((await api(app, viewer, '/api/sources', { tenant: 'beta' })).status, 403);
  assert.equal((await api(app, viewer, '/api/sources', { method: 'POST', body: { name: 'Denied', fixtureId: 'mivia-vid0062' } })).status, 403);
  assert.equal((await app.stop()).cleanup, true);
  app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  assert.equal(app.fingerprint, firstFingerprint);
  cookie = await login(app);
  const after = await api(app, cookie, '/api/sources');
  assert.deepEqual(after.body.items, listed.body.items);
  const config = JSON.parse(await readFile(app.configPath, 'utf8'));
  assert.deepEqual(config.principals, [], 'existing access owner must not be reseeded');
  const lostAccessPath = join(app.dataDirectory, 'access.sqlite');
  assert.equal((await app.stop()).cleanup, true);
  app = null;
  // Simulate loss without destroying the original access owner or business data.
  await rename(lostAccessPath, lostAccessPath + '.retained-for-repair');
  await assert.rejects(startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 }), /refusing to reseed/);
});
