import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rename, mkdir, readdir, writeFile, copyFile } from 'node:fs/promises';
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
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
class ControlledStartupChild extends EventEmitter {
  constructor(sendFailure) {
    super();
    this.sendFailure = sendFailure;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.closed = false;
    this.stopAttempted = deferred();
    this.controlFailureObserved = deferred();
  }
  send(message, callback) {
    if (message?.type !== 'stop') return true;
    this.stopAttempted.resolve();
    const error = Object.assign(new Error('Synthetic stop IPC failure'), { code: 'EPIPE' });
    if (this.sendFailure === 'sync') throw error;
    queueMicrotask(() => {
      callback?.(error);
      this.emit('error', error);
      this.controlFailureObserved.resolve();
    });
    return true;
  }
  close(code = 1, signal = null) {
    if (this.closed) return;
    this.emit('message', { type: 'stopped', cleanup: true });
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.closed = true;
    this.emit('close', code, signal);
  }
}
async function withForkReplacement(replacement, run) {
  const original = childProcess.fork;
  childProcess.fork = replacement;
  syncBuiltinESMExports();
  try { return await run(); }
  finally {
    childProcess.fork = original;
    syncBuiltinESMExports();
  }
}
async function assertUnknownOwner(error, expectedCleanup) {
  assert.ok(error instanceof AggregateError, 'startup failure and observed close failure remain aggregated');
  assert.equal(error.errors[0].message, 'Synthetic startup failure');
  assert.match(error.errors[1].message, /Product closure was not proven \(exit 1\)/);
  assert.match(error.owner.diagnostics, /EPIPE/);
  assert.deepEqual(await error.owner.completion, { code: 1, signal: null, cleanup: expectedCleanup, runtimeCopyCleanup: 'RETAINED_UNKNOWN' });
  const marker = JSON.parse(await readFile(error.owner.ownerPath, 'utf8'));
  assert.equal(marker.state, 'UNKNOWN', 'nonzero original close never publishes CLOSED');
  assert.equal(marker.fingerprint, error.owner.fingerprint);
  assert.equal(await readFile(error.owner.ownerPath + '.claim', 'utf8'), marker.token, 'the original token-bound claim remains retained');
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
test('IPC control errors cannot settle the original child close observation', { concurrency: false, timeout: 30_000 }, async t => {
  for (const sendFailure of ['sync', 'async']) {
    await t.test(`${sendFailure} stop-send failure waits for original close`, async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), `veyviz-ipc-${sendFailure}-`));
      const enrolled = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
      assert.equal((await enrolled.stop()).cleanup, true, 'the fixture begins with a completed generation');
      const child = new ControlledStartupChild(sendFailure);
      let forkCall, forkCount = 0;
      await withForkReplacement((file, args, options) => {
        forkCount++;
        forkCall = { file, args, options };
        queueMicrotask(() => child.emit('message', { type: 'failed', message: 'Synthetic startup failure' }));
        return child;
      }, async () => {
        let settled = false;
        const startup = startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 }).then(
          value => { settled = true; return { value }; },
          error => { settled = true; return { error }; }
        );
        try {
          await child.stopAttempted.promise;
          if (sendFailure === 'async') await child.controlFailureObserved.promise;
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(settled, false, 'a send throw or IPC error event does not settle owner completion');
          assert.equal(child.closed, false, 'no close was emitted before the pending assertion');
          child.close(1, null);
          const outcome = await startup;
          assert.ok(outcome.error);
          await assertUnknownOwner(outcome.error, true);
          assert.equal(existsSync(outcome.error.owner.runtimeRoot), true, 'uncertain original close retains the exact execution copy');
          assert.equal(forkCount, 1);
          assert.equal(forkCall.file, join(ROOT, '.local', 'platform-runtime-executions', 'veyviz-runtime.mjs'));
          assert.deepEqual(forkCall.args, [outcome.error.owner.runtimeRoot, 'veyviz-catalog', outcome.error.owner.configPath, '0']);
          assert.equal(forkCall.options.cwd, outcome.error.owner.runtimeRoot);
          assert.notEqual(outcome.error.owner.runtimeRoot, outcome.error.owner.producerRoot);
          assert.equal(forkCall.options.shell, undefined, 'the fixed launcher does not enable a shell');
          const executionEntries = join(ROOT, '.local', 'platform-runtime-executions');
          const entriesBeforeQuarantinedRelaunch = (await readdir(executionEntries)).sort();
          await assert.rejects(startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 }), /cleanup is unconfirmed/);
          assert.deepEqual((await readdir(executionEntries)).sort(), entriesBeforeQuarantinedRelaunch, 'quarantined relaunch creates no second execution copy');
          assert.equal(forkCount, 1, 'quarantined restart is refused before another child is created');
        } finally {
          if (!child.closed) child.close(1, null);
          await startup;
        }
      });
    });
  }
});
test('fixed catalog occupied-port startup failure observes original close and preserves quarantine', { timeout: 30_000 }, async () => {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const dataRoot = await mkdtemp(join(tmpdir(), 'veyviz-port-conflict-'));
  let app, startupError;
  try {
    try { app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: address.port }); }
    catch (error) { startupError = error; }
    assert.ok(startupError instanceof AggregateError, 'occupied port remains a failed startup with the original owner attached');
    assert.match(startupError.errors[0].message, /Product startup failed/i);
    assert.match(startupError.owner.diagnostics, /EADDRINUSE|address already in use/i);
    const originalClose = await startupError.owner.completion;
    assert.equal(originalClose.code, 1, 'the fixed runtime exits unsuccessfully after the actual bind failure');
    assert.equal(originalClose.signal, null);
    assert.equal(typeof originalClose.cleanup, 'boolean', 'retain the runtime-reported cleanup fact without treating it as sufficient');
    const marker = JSON.parse(await readFile(startupError.owner.ownerPath, 'utf8'));
    assert.equal(marker.state, 'UNKNOWN', 'nonzero close stays quarantined even when cleanup was reported');
    assert.equal(marker.fingerprint, startupError.owner.fingerprint);
    assert.equal(await readFile(startupError.owner.ownerPath + '.claim', 'utf8'), marker.token);
    await assert.rejects(startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 }), /cleanup is unconfirmed/);
  } finally {
    if (app) await app.stop();
    await new Promise(resolve => listener.close(resolve));
  }
});
test('Veyviz catalog runs independently, scopes records, and retains them through observed graceful restart', { timeout: 120_000 }, async t => {
  const catalogPlan = JSON.parse(await readFile(join(ROOT, '.artifacts/veyviz-catalog/plan.json'), 'utf8'));
  assert.deepEqual(catalogPlan.modules.map(module => module.id), ['veyviz-sources']);
  const dataRoot = await mkdtemp(join(tmpdir(), 'veyviz-local-lifecycle-'));
  let app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  t.after(async () => { if (app) await app.stop(); });
  const firstFingerprint = app.fingerprint;
  let cookie = await login(app);
  const created = await api(app, cookie, '/api/sources', { method: 'POST', body: { name: 'Retained recording', fixtureId: 'mivia-vid0062' } });
  assert.equal(created.status, 200);
  const listed = await api(app, cookie, '/api/sources');
  assert.equal(listed.body.items.length, 1);
  const queried = await api(app, cookie, '/api/sources/query?search=Retained&limit=20');
  assert.equal(queried.status, 200);
  assert.deepEqual(queried.body.items.map(item => item.id), [created.body.id]);
  assert.equal(queried.body.page.coverage, 'filtered-owner-query');
  assert.equal((await api(app, cookie, '/api/sources', { tenant: 'beta' })).body.items.length, 0);
  assert.equal((await api(app, cookie, '/api/analysis')).status, 404);
  assert.equal((await api(app, cookie, '/api/analysis/query')).status, 404);
  assert.equal((await api(app, cookie, '/api/analysis/sources/query')).status, 404);
  assert.equal((await api(app, cookie, '/api/analysis/readiness')).status, 404);
  const viewer = await login(app, 'viewer');
  assert.equal((await api(app, viewer, '/api/sources', { tenant: 'beta' })).status, 403);
  assert.equal((await api(app, viewer, '/api/sources', { method: 'POST', body: { name: 'Denied', fixtureId: 'mivia-vid0062' } })).status, 403);
  assert.equal((await app.stop()).cleanup, true);
  app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  assert.equal(app.fingerprint, firstFingerprint);
  cookie = await login(app);
  const after = await api(app, cookie, '/api/sources');
  assert.deepEqual(after.body.items, listed.body.items);
  assert.deepEqual((await api(app, cookie, '/api/sources/query?search=Retained&limit=20')).body.items, queried.body.items);
  const config = JSON.parse(await readFile(app.configPath, 'utf8'));
  assert.deepEqual(config.principals, [], 'existing access owner must not be reseeded');
  const access = new DatabaseSync(join(app.dataDirectory, 'access.sqlite'));
  try {
    const prior = access.prepare("SELECT count(*) AS count FROM grants WHERE principal='viewer'").get();
    assert.ok(Number(prior.count) > 0, 'the test fixture begins with an explicitly seeded viewer grant');
    access.prepare("DELETE FROM grants WHERE principal='viewer'").run();
    assert.equal(Number(access.prepare("SELECT count(*) AS count FROM grants WHERE principal='viewer'").get().count), 0);
  } finally { access.close(); }
  assert.equal((await app.stop()).cleanup, true);
  app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  assert.equal(app.fingerprint, firstFingerprint, 'unchanged fixed snapshot retains its existing data generation');
  cookie = await login(app);
  assert.deepEqual((await api(app, cookie, '/api/sources')).body.items, listed.body.items, 'the backend source row survives the unchanged-snapshot restart');
  const viewerAfterGrantRemoval = await login(app, 'viewer');
  assert.equal((await api(app, viewerAfterGrantRemoval, '/api/sources')).status, 403, 'a removed grant stays removed after restart');
  assert.deepEqual(JSON.parse(await readFile(app.configPath, 'utf8')).principals, [], 'restart does not reseed removed principals or grants');
  const lostAccessPath = join(app.dataDirectory, 'access.sqlite');
  assert.equal((await app.stop()).cleanup, true);
  app = null;
  // Simulate loss without destroying the original access owner or business data.
  await rename(lostAccessPath, lostAccessPath + '.retained-for-repair');
  await assert.rejects(startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 }), /refusing to reseed/);
});
