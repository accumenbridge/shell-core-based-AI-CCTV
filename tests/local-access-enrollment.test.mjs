import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalAccess } from '../packages/local-access/dist/index.js';
import { createRuntime, ROOT } from '../apps/runtime/dist/index.js';

const scope = () => ({ productId: 'service-desk', instanceId: `runtime-${randomUUID()}` });
const principal = (id, permission = 'desk.read') => ({
  id,
  password: `${id}-test-password-001`,
  grants: [{ tenantId: 'customer-a', permissions: [permission] }]
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qb-local-access-enrollment-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

test('constructor seeds once atomically and reopening never restores removed identities or grants', t => {
  const root = fixture(t), databasePath = join(root, 'access.sqlite'), identity = scope();
  const initial = [principal('admin', 'desk.read'), principal('viewer', 'desk.create')];
  const access = new LocalAccess(databasePath, identity, Date.now, initial);
  access.close();

  const edit = new DatabaseSync(databasePath);
  try {
    edit.prepare("DELETE FROM grants WHERE principal='admin' AND permission='desk.read'").run();
    edit.prepare("DELETE FROM principals WHERE id='viewer'").run();
  } finally { edit.close(); }

  const reopened = new LocalAccess(databasePath, identity, Date.now, initial);
  try {
    assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 1);
    assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS count FROM principals WHERE id='viewer'").get().count, 0);
    assert.deepEqual(reopened.permissions({ id: 'admin', kind: 'user' }, 'customer-a'), []);
    assert.throws(() => reopened.seed(initial), error => error?.code === 'INCOMPATIBLE');
  } finally { reopened.close(); }
});

test('createRuntime restart keeps configured identities and grants removed from the bound access owner', async t => {
  const root = fixture(t), dataDirectory = join(root, 'runtime-data'), instanceId = `desk-${randomUUID()}`;
  const config = { instanceId, dataDirectory, principals: [
    { id: 'admin', password: 'runtime-admin-test-password-001', grants: [{ tenantId: 'customer-a', permissions: ['desk.read','desk.create','desk.close'] }] },
    { id: 'viewer', password: 'runtime-viewer-test-password-001', grants: [{ tenantId: 'customer-a', permissions: ['desk.read'] }] }
  ] };
  let runtime, listener;
  async function closeCurrent() {
    if (listener) { await listener.close(); listener = undefined; }
    if (runtime) { await runtime.close(); runtime = undefined; }
  }
  t.after(async () => { await closeCurrent(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  async function start() {
    runtime = await createRuntime('service-desk', config, ROOT);
    listener = await runtime.http(0);
  }
  async function login(principal) {
    const response = await fetch(`${listener.url}/api/session`, { method: 'POST', headers: { Origin: listener.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: principal.id, password: principal.password }) });
    return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
  }

  await start();
  const firstLogin = await login(config.principals[0]);
  assert.equal(firstLogin.response.status, 200);
  assert.ok(firstLogin.cookie);
  const created = await fetch(`${listener.url}/api/requests`, { method: 'POST', headers: { Origin: listener.url, Cookie: firstLogin.cookie,
    'X-QB-Tenant': 'customer-a', 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-owner-create-0001' },
    body: JSON.stringify({ title: 'Retained canonical request', details: 'The module-owned record survives LocalAccess identity changes.' }) });
  assert.equal(created.status, 200);
  const request = await created.json();
  await closeCurrent();

  const accessPath = join(dataDirectory, 'access.sqlite');
  const owner = new LocalAccess(accessPath, { productId: 'service-desk', instanceId });
  try {
    owner.revoke('admin', 'customer-a', 'desk.create');
    owner.store.db.prepare("DELETE FROM grants WHERE principal='viewer'").run();
    owner.store.db.prepare("DELETE FROM principals WHERE id='viewer'").run();
  } finally { owner.close(); }

  await start();
  const removedViewer = await login(config.principals[1]);
  assert.equal(removedViewer.response.status, 401, 'restart does not recreate a removed configured identity');
  await removedViewer.response.text();
  const secondLogin = await login(config.principals[0]);
  assert.equal(secondLogin.response.status, 200);
  assert.ok(secondLogin.cookie);
  const commonHeaders = { Origin: listener.url, Cookie: secondLogin.cookie, 'X-QB-Tenant': 'customer-a' };
  const list = await fetch(`${listener.url}/api/requests`, { headers: commonHeaders });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).items.some(item => item.id === request.id && item.title === 'Retained canonical request'),
    'the product-owned Service Desk record remains readable after restart');
  const denied = await fetch(`${listener.url}/api/requests`, { method: 'POST', headers: { ...commonHeaders, 'Content-Type': 'application/json',
    'Idempotency-Key': 'runtime-owner-revoked-create-0001' }, body: JSON.stringify({ title: 'Denied after restart', details: 'The revoked permission must stay revoked.' }) });
  assert.equal(denied.status, 403, 'restart does not restore a revoked configured grant');
  await denied.text();
  await closeCurrent();

  const emptied = new LocalAccess(accessPath, { productId: 'service-desk', instanceId });
  try {
    emptied.store.db.prepare('DELETE FROM grants').run();
    emptied.store.db.prepare('DELETE FROM principals').run();
  } finally { emptied.close(); }
  runtime = await createRuntime('service-desk', config, ROOT);
  try {
    assert.equal(runtime.access.store.db.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 1);
    assert.equal(runtime.access.store.db.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 0,
      'a second restart does not refill a bound owner whose identities were all removed');
    assert.equal(runtime.access.store.db.prepare('SELECT COUNT(*) AS count FROM grants').get().count, 0,
      'a second restart does not restore any configured grants');
  } finally { await closeCurrent(); }
});

test('an intentional empty first seed seals the binding and cannot be filled on reopen', t => {
  const root = fixture(t), databasePath = join(root, 'access.sqlite'), identity = scope();
  const first = new LocalAccess(databasePath, identity, Date.now, []);
  assert.equal(first.store.db.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 1);
  first.close();

  const reopened = new LocalAccess(databasePath, identity, Date.now, [principal('late-admin')]);
  try {
    assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 0);
    assert.throws(() => reopened.seed([principal('late-admin')]), error => error?.code === 'INCOMPATIBLE');
  } finally { reopened.close(); }
});

test('invalid initial seed rolls back binding and principals and leaves an existing owner repair-required', t => {
  const root = fixture(t), databasePath = join(root, 'access.sqlite'), identity = scope();
  assert.throws(() => new LocalAccess(databasePath, identity, Date.now, [
    principal('valid-admin'),
    { id: 'invalid-viewer', password: 'short', grants: [{ tenantId: 'customer-a', permissions: ['desk.read'] }] }
  ]), error => error?.code === 'INVALID');

  const inspect = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 0);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 0);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM grants').get().count, 0);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  } finally { inspect.close(); }

  assert.throws(() => new LocalAccess(databasePath, identity, Date.now, [principal('valid-admin')]), error => error?.code === 'INCOMPATIBLE');
  const after = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 0);
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM principals').get().count, 0);
  } finally { after.close(); }
});

test('concurrent first constructors commit one complete principal seed set', async t => {
  const root = fixture(t), databasePath = join(root, 'access.sqlite'), gatePath = join(root, 'start.gate'), identity = scope();
  const moduleUrl = pathToFileURL(resolve('packages/local-access/dist/index.js')).href;
  const childSource = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { LocalAccess } from ${JSON.stringify(moduleUrl)};
    const [databasePath, gatePath, readyPath, identityText, seedText] = process.argv.slice(1);
    writeFileSync(readyPath, 'ready\\n', { flag: 'wx' });
    while (!existsSync(gatePath)) await new Promise(resolve => setTimeout(resolve, 2));
    const owner = new LocalAccess(databasePath, JSON.parse(identityText), Date.now, JSON.parse(seedText));
    owner.close();
  `;
  const sets = [
    [principal('owner-a'), principal('viewer-a', 'desk.create')],
    [principal('owner-b'), principal('viewer-b', 'desk.create')]
  ];
  const children = sets.map((seeds, index) => {
    const readyPath = join(root, `ready-${index}`);
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, databasePath, gatePath, readyPath, JSON.stringify(identity), JSON.stringify(seeds)], {
      cwd: resolve('.'), windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr })));
    return { child, closed, readyPath };
  });
  const readyDeadline = Date.now() + 5000;
  try {
    while (children.some(value => !existsSync(value.readyPath)) && Date.now() < readyDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(children.every(value => existsSync(value.readyPath)), 'both owner processes are waiting at the same first-seed gate');
    writeFileSync(gatePath, 'go\n', { flag: 'wx' });
  } catch (error) {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(value => value.closed));
    throw error;
  }
  let timeoutId;
  const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('seed constructors did not close within 10 seconds')), 10000); });
  let outcomes;
  try { outcomes = await Promise.race([Promise.all(children.map(value => value.closed)), timeout]); }
  catch (error) {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(value => value.closed));
    throw error;
  } finally { clearTimeout(timeoutId); }
  assert.deepEqual(outcomes.map(({ code, signal }) => ({ code, signal })), [{ code: 0, signal: null }, { code: 0, signal: null }],
    'both original constructor processes close successfully');
  const inspect = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const ids = inspect.prepare('SELECT id FROM principals ORDER BY id').all().map(row => row.id);
    const winningSet = sets.map(seedSet => seedSet.map(item => item.id).sort());
    assert.ok(winningSet.some(candidate => JSON.stringify(candidate) === JSON.stringify(ids)), 'only one constructor publishes its entire seed set');
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM instance_binding').get().count, 1);
    const expectedGrants = sets.flatMap(seedSet => seedSet).filter(item => ids.includes(item.id)).reduce((count, item) => count + item.grants.reduce((n, grant) => n + grant.permissions.length, 0), 0);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM grants').get().count, expectedGrants, 'the winning set grants are complete and the losing set is absent');
  } finally { inspect.close(); }
  assert.equal(existsSync(databasePath), true);
});
