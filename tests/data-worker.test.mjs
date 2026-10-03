import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteOwner, JobQueue } from '@quadbridge/sqlite';
import { PlatformError } from '@quadbridge/contracts';
import { markSafeCommandFieldErrors, trustedCommandErrorDetails } from '@quadbridge/contracts/ui-state';
import { fixture, admin, viewer } from './helpers.mjs';
function ctx() { return { actor: { id: 'fixture', kind: 'user' }, tenantId: 'tenant-a', productId: 'test', instanceId: 'test', signal: new AbortController().signal, requestId: 'req', assertAllowed() { } }; }
function atomicContext() { return { ...ctx(), assertAllowed(permission, kind) { assert.equal(permission, 'test.write'); assert.equal(kind, 'write'); } }; }
test('domain creation and exact retry return one persisted record', async (t) => { const f = await fixture(t); const a = await f.call('POST', '/api/requests', { title: 'Inspect door', details: 'Latch is loose' }); const b = await f.call('POST', '/api/requests', { title: 'Inspect door', details: 'Latch is loose' }); assert.deepEqual(a, b); assert.equal((await f.call('GET', '/api/requests')).items.length, 1); });
test('same command with different input conflicts', async (t) => { const f = await fixture(t); await f.call('POST', '/api/requests', { title: 'First', details: 'Details' }); await assert.rejects(f.call('POST', '/api/requests', { title: 'Changed', details: 'Details' }), e => e.code === 'CONFLICT'); });
test('receipts survive runtime restart', async (t) => { const f = await fixture(t); const a = await f.call('POST', '/api/requests', { title: 'Persistent', details: 'Details' }); await f.restart(); assert.equal((await f.call('POST', '/api/requests', { title: 'Persistent', details: 'Details' })).id, a.id); });
test('tenants cannot read or close each other records', async (t) => { const f = await fixture(t); const a = await f.call('POST', '/api/requests', { title: 'Private A', details: 'A' }); assert.equal((await f.call('GET', '/api/requests', undefined, undefined, admin, 'tenant-b')).items.length, 0); await assert.rejects(f.call('POST', '/api/requests/close', { id: a.id, expectedVersion: 1 }, 'b-close', admin, 'tenant-b'), e => e.code === 'NOT_FOUND'); });
test('read-only principal cannot mutate', async (t) => { const f = await fixture(t); await assert.rejects(f.call('POST', '/api/requests', { title: 'No', details: 'No' }, 'x', viewer), e => e.code === 'DENIED'); });
test('optimistic concurrency rejects stale transitions', async (t) => { const f = await fixture(t); const a = await f.call('POST', '/api/requests', { title: 'Item', details: 'X' }); await f.call('POST', '/api/requests/close', { id: a.id, expectedVersion: 1 }, 'close-a'); await assert.rejects(f.call('POST', '/api/requests/close', { id: a.id, expectedVersion: 1 }, 'close-b'), e => e.code === 'CONFLICT'); });
test('module read-only preserves historical queries and denies commands', async (t) => { const f = await fixture(t); await f.call('POST', '/api/requests', { title: 'History', details: 'X' }); f.runtime.access.setMode(admin, 'tenant-a', 'service-desk', 'read-only'); assert.equal((await f.call('GET', '/api/requests')).items.length, 1); await assert.rejects(f.call('POST', '/api/requests', { title: 'No', details: 'X' }, 'two'), e => e.code === 'DISABLED'); assert.ok(!f.runtime.host.bootstrap(admin, 'tenant-a').permissions.includes('desk.create')); });
test('revocation prevents reading the cached command receipt', async (t) => { const f = await fixture(t); await f.call('POST', '/api/requests', { title: 'A', details: 'B' }); f.runtime.access.revoke('admin', 'tenant-a', 'desk.create'); await assert.rejects(f.call('POST', '/api/requests', { title: 'A', details: 'B' }), e => e.code === 'DENIED'); });
test('business write and enqueue roll back together', () => { const s = new SqliteOwner(':memory:', 'test'); const q = new JobQueue(s); s.db.exec('CREATE TABLE domain_data(id TEXT)'); assert.throws(() => s.command(ctx(), 'write', 'key', { x: 1 }, 'write', () => { s.db.prepare('INSERT INTO domain_data VALUES(?)').run('a'); q.enqueue(ctx(), 'test', 'job', { id: 'a' }, 'write'); throw Error('stop'); })); assert.equal(s.db.prepare('SELECT count(*) AS n FROM domain_data').get().n, 0); assert.equal(q.pending(), 0); s.close(); });
test('async owner transaction is rejected', () => { const s = new SqliteOwner(':memory:', 'test'); assert.throws(() => s.transaction(async () => 1), /Do not await/); s.close(); });
test('generated owner-atomic validation rejection seals one durable original key and rolls back every business row', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qb-owner-rejection-'));
  const path = join(root, 'owner.sqlite'), raw = { fields: { assetCode: '' } };
  let store = new SqliteOwner(path, 'test'), executions = 0;
  store.db.exec('CREATE TABLE generated_asset(id TEXT PRIMARY KEY, code TEXT NOT NULL)');
  const normalize = () => {
    const error = new PlatformError('INVALID', 'Asset code is required');
    markSafeCommandFieldErrors(error, [{ path: 'fields.assetCode', code: 'INVALID', message: error.message }]);
    throw error;
  };
  const execute = () => { executions++; store.db.prepare('INSERT INTO generated_asset VALUES(?,?)').run('late', 'A-1'); return { id: 'late' }; };
  let first;
  try {
    assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-invalid-001', raw, 'test.write', normalize, execute), error => {
      first = error;
      const details = trustedCommandErrorDetails(error);
      assert.equal(error.code, 'INVALID');
      assert.equal(details.commandOutcome.state, 'REJECTED_NO_BUSINESS_EFFECTS');
      assert.equal(details.commandOutcome.scope, 'ORIGINAL_COMMAND');
      assert.equal(details.commandOutcome.command.id, 'atomic-invalid-001');
      assert.equal(details.commandOutcome.command.actor.id, 'fixture');
      assert.equal(details.fieldErrors[0].path, 'fields.assetCode');
      return true;
    });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM generated_asset').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _receipts').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _audit').get().n, 1);
    store.close(); store = new SqliteOwner(path, 'test');
    assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-invalid-001', raw, 'test.write', normalize, execute), error => {
      assert.equal(error.code, first.code);
      assert.deepEqual(trustedCommandErrorDetails(error), trustedCommandErrorDetails(first));
      return true;
    }, 'a delayed exact retry reads the terminal rejection and cannot run the business callback');
    assert.equal(executions, 0);
    assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-invalid-001', { fields: { assetCode: 'changed' } }, 'test.write', normalize, execute), error => {
      assert.equal(error.code, 'CONFLICT');
      assert.equal(trustedCommandErrorDetails(error), undefined);
      return true;
    }, 'the rejected key cannot be rebound to another payload');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM generated_asset').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _receipts').get().n, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: false, maxRetries: 4, retryDelay: 100 });
  }
});
test('generated owner-atomic path replays legacy positive receipts and leaves asynchronous failure uncertified', () => {
  const store = new SqliteOwner(':memory:', 'test');
  const input = { fields: { assetCode: 'A-1' } }, expected = { id: 'already-committed' };
  store.command(atomicContext(), 'test.asset.create', 'atomic-positive-001', input, 'test.write', () => expected);
  let calls = 0;
  const replay = store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-positive-001', input, 'test.write', () => input, () => { calls++; return { id: 'wrong' }; });
  assert.deepEqual(replay, expected);
  assert.equal(calls, 0);
  assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-async-001', input, 'test.write', async () => input, () => ({ id: 'wrong' })), error => {
    assert.equal(error.code, 'UNAVAILABLE');
    assert.equal(trustedCommandErrorDetails(error), undefined);
    return true;
  });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _receipts WHERE command_id=?').get('atomic-async-001').n, 0);
  store.close();
});
test('generated owner rejection rolls back a domain write and queued job before sealing its original key', () => {
  const store = new SqliteOwner(':memory:', 'test'), queue = new JobQueue(store), input = { fields: { assetCode: 'A-1' } };
  store.db.exec('CREATE TABLE generated_asset(id TEXT PRIMARY KEY, code TEXT NOT NULL)');
  const error = new PlatformError('CONFLICT', 'Owner conflict after attempted work');
  markSafeCommandFieldErrors(error, [{ path: 'fields.assetCode', code: 'CONFLICT', message: error.message }]);
  assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-rollback-work-001', input, 'test.write', () => input, () => {
    store.db.prepare('INSERT INTO generated_asset VALUES(?,?)').run('attempted', 'A-1');
    queue.enqueue(atomicContext(), 'test.asset.created', 'attempted-job', { id: 'attempted' }, 'test.write');
    throw error;
  }), rejected => {
    const details = trustedCommandErrorDetails(rejected);
    assert.equal(rejected.code, 'CONFLICT');
    assert.equal(details.commandOutcome.command.id, 'atomic-rollback-work-001');
    assert.deepEqual(details.fieldErrors.map(field => field.path), ['fields.assetCode']);
    return true;
  });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM generated_asset').get().n, 0);
  assert.equal(queue.pending(), 0, 'the job enqueued in the failed business savepoint is also rolled back');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _receipts').get().n, 1, 'only the terminal rejection receipt commits');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _audit').get().n, 1);
  store.close();
});
test('failed rejection COMMIT rolls back the receipt and never returns a trusted outcome', () => {
  const store = new SqliteOwner(':memory:', 'test'), input = { fields: { assetCode: '' } };
  store.db.exec(`CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_terminal_rejection_commit AFTER INSERT ON _audit WHEN NEW.command_id='atomic-commit-fail-001'
    BEGIN INSERT INTO commit_child(parent) VALUES(404); END;`);
  const validation = new PlatformError('INVALID', 'Asset code is required');
  markSafeCommandFieldErrors(validation, [{ path: 'fields.assetCode', code: 'INVALID', message: validation.message }]);
  assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-commit-fail-001', input, 'test.write', () => { throw validation; }, () => ({ id: 'unused' })), error => {
    assert.equal(trustedCommandErrorDetails(error), undefined);
    return true;
  });
  assert.equal(store.db.isTransaction, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _receipts').get().n, 0, 'the uncommitted terminal marker is removed with the failed outer commit');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _audit').get().n, 0);
  store.close();
});
test('failed savepoint rollback cannot produce a terminal rejection receipt', () => {
  const store = new SqliteOwner(':memory:', 'test'), input = { fields: { assetCode: '' } };
  const originalExec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'ROLLBACK TO SAVEPOINT qb_generated_entity_command') throw new Error('injected savepoint rollback failure');
    return originalExec(sql);
  };
  const validation = new PlatformError('INVALID', 'Asset code is required');
  markSafeCommandFieldErrors(validation, [{ path: 'fields.assetCode', code: 'INVALID', message: validation.message }]);
  assert.throws(() => store.generatedEntityCommand(atomicContext(), 'test.asset.create', 'atomic-rollback-fail-001', input, 'test.write', () => { throw validation; }, () => ({ id: 'unused' })), /injected savepoint rollback failure/u);
  store.db.exec = originalExec;
  assert.equal(store.db.isTransaction, false, 'outer cleanup still closes the failed transaction');
  assert.equal(trustedCommandErrorDetails(validation), undefined, 'the uncommitted owner error itself has no client trust brand');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _receipts').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM _audit').get().n, 0);
  store.close();
});
test('migration edits and schema downgrades fail', () => { const s = new SqliteOwner(':memory:', 'test'), one = { version: 1, sql: 'CREATE TABLE a(id TEXT)' }; s.migrate([one], { current: 1, readMin: 1, readMax: 1 }); assert.throws(() => s.migrate([{ ...one, sql: 'CREATE TABLE a(id INTEGER)' }], { current: 1, readMin: 1, readMax: 1 }), /history changed/); s.migrate([one, { version: 2, sql: 'ALTER TABLE a ADD COLUMN name TEXT' }], { current: 2, readMin: 1, readMax: 2 }); assert.throws(() => s.migrate([one], { current: 1, readMin: 1, readMax: 1 }), /newer/); s.close(); });
test('two claimers cannot own the same unexpired attempt', () => { let now = 1000; const s = new SqliteOwner(':memory:', 'test'), q = new JobQueue(s, () => now); s.transaction(() => q.enqueue(ctx(), 'test', 'one', {}, 'write')); const a = q.claim('a', 1000); assert.ok(a); assert.equal(q.claim('b', 1000), undefined); s.close(); });
test('expired attempt cannot commit after another worker claims', () => { let now = 1000; const s = new SqliteOwner(':memory:', 'test'), q = new JobQueue(s, () => now); s.transaction(() => q.enqueue(ctx(), 'test', 'one', {}, 'write')); const a = q.claim('a', 1000); now = 2001; const b = q.claim('b', 1000); assert.ok(b); assert.throws(() => q.finish(a, { commit: () => ({ bad: true }) }), e => e.code === 'STALE_ATTEMPT'); q.finish(b, { commit: () => ({ ok: true }) }); assert.equal(q.get(b.id).state, 'SUCCEEDED'); s.close(); });
test('running cancellation is a request until the worker settles', () => { const s = new SqliteOwner(':memory:', 'test'), q = new JobQueue(s); s.transaction(() => q.enqueue(ctx(), 'test', 'one', {}, 'write')); const a = q.claim('a'); s.transaction(() => q.cancel(ctx(), a.id)); assert.equal(q.get(a.id).state, 'CANCEL_REQUESTED'); assert.equal(q.renew(a), false); assert.throws(() => q.finish(a, { commit: () => ({}) }), e => e.code === 'STALE_ATTEMPT'); q.fail(a, 'CANCELLED'); assert.equal(q.get(a.id).state, 'CANCELLED'); s.close(); });
test('queued cancellation never starts', () => { const s = new SqliteOwner(':memory:', 'test'), q = new JobQueue(s); let a; s.transaction(() => { a = q.enqueue(ctx(), 'test', 'one', {}, 'write'); q.cancel(ctx(), a.id); }); assert.equal(q.claim('a'), undefined); s.close(); });
test('knowledge indexing is real, durable and scoped', async (t) => { const f = await fixture(t, 'combined'); const d = await f.call('POST', '/api/documents', { title: 'Safety procedure', body: 'Check isolation before servicing the conveyor.' }); assert.equal(d.state, 'PENDING'); assert.equal((await f.call('GET', '/api/documents/search?q=conveyor')).items.length, 0); await f.restart(); await f.tick(); assert.equal((await f.call('GET', '/api/documents/search?q=conveyor')).items.length, 1); assert.equal((await f.call('GET', '/api/documents/search?q=conveyor', undefined, undefined, admin, 'tenant-b')).items.length, 0); });
test('job submitter revocation blocks execution', async (t) => { const f = await fixture(t, 'combined'); await f.call('POST', '/api/documents', { title: 'Held', body: 'Do not index after access is removed.' }); f.runtime.access.revoke('admin', 'tenant-a', 'knowledge.write'); await f.tick(); const d = (await f.call('GET', '/api/documents')).items[0]; assert.equal(d.state, 'PENDING'); assert.equal(d.indexJob.state, 'FAILED'); assert.equal(d.indexJob.error, 'DENIED'); });
test('module disable pauses queued work without deleting records', async (t) => { const f = await fixture(t, 'combined'); await f.call('POST', '/api/documents', { title: 'Paused', body: 'Pending work remains.' }); f.runtime.access.setMode(admin, 'tenant-a', 'knowledge', 'read-only'); assert.equal(await f.tick(), false); assert.equal((await f.call('GET', '/api/documents')).items[0].indexJob.state, 'QUEUED'); f.runtime.access.setMode(admin, 'tenant-a', 'knowledge', 'enabled'); await f.tick(); assert.equal((await f.call('GET', '/api/documents')).items[0].state, 'READY'); });
