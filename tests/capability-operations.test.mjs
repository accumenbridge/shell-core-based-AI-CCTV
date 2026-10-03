import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationHost } from '@quadbridge/backend-host';
import { PlatformError } from '@quadbridge/contracts';
import { validateOperationDescriptor, validateOperationValue } from '@quadbridge/contracts/operations';
import { resolve } from '@quadbridge/composition';
import { fixture, admin, viewer } from './helpers.mjs';

const operationId = 'knowledge.documents.';

test('Knowledge create operation and HTTP route share one SQLite command, then indexed search/get stay tenant-scoped', async t => {
  const f = await fixture(t, 'combined');
  const host = f.runtime.host;
  const catalogue = host.operationCatalogue(admin, 'tenant-a');
  assert.deepEqual(catalogue.map(item => item.id).sort(), [
    `${operationId}create`, `${operationId}get`, `${operationId}search`
  ]);
  assert.equal(catalogue.some(item => 'handle' in item || 'store' in item), false);
  const viewerCatalogue = host.operationCatalogue(viewer, 'tenant-a');
  assert.equal(viewerCatalogue.some(item => item.id === `${operationId}create`), false);

  const input = { title: 'Pump isolation', body: 'The pump isolation checklist uses a guarded orange disconnect before inspection.' };
  const commandId = 'capability-create-0001';
  const created = await host.invokeOperation(`${operationId}create`, 1, admin, 'tenant-a', input, commandId);
  const replay = await f.call('POST', '/api/documents', input, commandId);
  assert.deepEqual(replay, created, 'the existing HTTP route replays the exact owner command receipt');
  const module = f.runtime.modules.find(item => item.manifest.id === 'knowledge');
  assert.equal(module.queue.store.db.prepare('SELECT count(*) AS n FROM documents WHERE tenant=?').get('tenant-a').n, 1);
  assert.equal(module.queue.store.db.prepare('SELECT count(*) AS n FROM _jobs WHERE tenant=? AND kind=?').get('tenant-a', 'knowledge.index.v1').n, 1);

  assert.equal(await f.tick(), true, 'the selected real module worker claims and commits the indexing job');
  const search = await host.invokeOperation(`${operationId}search`, 1, admin, 'tenant-a', { query: 'pump isolation' });
  assert.equal(search.coverage, 'INDEXED_DOCUMENTS_ONLY');
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].id, created.id);
  assert.ok(search.items[0].excerpt.length <= 512);
  const document = await host.invokeOperation(`${operationId}get`, 1, admin, 'tenant-a', { documentId: created.id });
  assert.equal(document.state, 'READY');
  assert.equal(document.excerpt, input.body);
  assert.match(document.bodyDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(document, 'jobId'), false);

  const otherTenant = await host.invokeOperation(`${operationId}search`, 1, admin, 'tenant-b', { query: 'pump isolation' });
  assert.equal(otherTenant.items.length, 0);
  await assert.rejects(host.invokeOperation(`${operationId}get`, 1, admin, 'tenant-b', { documentId: created.id }), error => error.code === 'NOT_FOUND');
  await assert.rejects(host.invokeOperation(`${operationId}create`, 1, viewer, 'tenant-a', { title: 'Denied', body: 'Viewer write.' }, 'capability-viewer-write'), error => error.code === 'DENIED');
  await assert.rejects(host.invokeOperation(`${operationId}create`, 1, admin, 'tenant-a', { title: 'Missing key', body: 'No command id.' }), error => error.code === 'INVALID');
  await assert.rejects(host.invokeOperation(`${operationId}create`, 1, admin, 'tenant-a', { title: 'Extra', body: 'No extra authority.', tenantId: 'tenant-b' }, 'capability-extra-field'), error => error.code === 'INVALID');

  f.runtime.access.setMode(admin, 'tenant-a', 'knowledge', 'read-only');
  await assert.rejects(host.invokeOperation(`${operationId}create`, 1, admin, 'tenant-a', { title: 'Read only', body: 'Disabled write.' }, 'capability-read-only'), error => error.code === 'DISABLED');
});

test('ApplicationHost reconciles the original session and cancellation around an awaited operation', async t => {
  const inputSchema = { type: 'object', properties: { value: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['value'], additionalProperties: false };
  const descriptor = { id: 'probe.echo.read', version: 1, title: 'Echo', description: 'Return a bounded value.', permission: 'probe.read', kind: 'read', inputSchema, outputSchema: inputSchema };
  const manifest = { id: 'probe', version: '1.0.0', abi: 'quadbridge.module.v1', dependencies: [], provides: [], requires: [], permissions: ['probe.read'], routes: [], workspaces: [], schema: { current: 0, readMin: 0, readMax: 0 }, background: false, operations: [descriptor] };
  const plan = resolve({ id: 'probe-app', version: '1.0.0', platformAbi: manifest.abi, title: 'Probe', description: '', layout: 'top', modules: [{ id: 'probe', version: manifest.version }], bindings: [] }, [manifest]);
  const pending = [];
  const module = { manifest, services: {}, routes: [], operations: [{ descriptor, handle(_ctx, input) { return new Promise((resolve, reject) => pending.push({ input, resolve, reject })); } }], close() {} };
  let permitted = true, sessionLive = true;
  const access = { assertModule(_actor, _tenant, _module, permission, kind) { assert.equal(permission, 'probe.read'); assert.equal(kind, 'read'); if (!permitted) throw new PlatformError('DENIED', 'not granted'); }, permissions: () => permitted ? ['probe.read'] : [], tenants: () => ['tenant-a'], mode: () => 'enabled' };
  assert.throws(() => new ApplicationHost(plan, 'probe-missing', [{ ...module, operations: [] }], access), /handler count/);
  assert.throws(() => new ApplicationHost(plan, 'probe-different', [{ ...module, operations: [{ ...module.operations[0], descriptor: { ...descriptor, title: 'Changed' } }] }], access), /differs from its declaration/);
  const host = new ApplicationHost(plan, 'probe-one', [module], access);
  t.after(() => host.stop());
  await host.start();
  const actor = { id: 'user-a', kind: 'user' };
  const originalAuth = () => { if (!sessionLive) throw new PlatformError('UNAUTHENTICATED', 'session expired'); };
  assert.equal(host.operationCatalogue(actor, 'tenant-a', originalAuth).length, 1);
  assert.deepEqual(validateOperationValue({ value: 'safe' }, descriptor.outputSchema, 'output'), { value: 'safe' });
  assert.throws(() => validateOperationDescriptor({ ...descriptor, inputSchema: { ...inputSchema, unsupported: true } }, 'probe', manifest.permissions), /Unsupported|schema/i);
  await assert.rejects(host.invokeOperation(descriptor.id, 1, actor, 'tenant-a', { value: 'extra', tenantId: 'forged' }, undefined, undefined, 'bad-input', originalAuth), error => error.code === 'INVALID');
  assert.equal(pending.length, 0, 'invalid input never reaches the trusted handler');

  const lateSession = host.invokeOperation(descriptor.id, 1, actor, 'tenant-a', { value: 'session' }, undefined, undefined, 'session-late', originalAuth);
  while (pending.length < 1) await new Promise(resolve => setImmediate(resolve));
  sessionLive = false;
  pending[0].resolve({ value: 'late' });
  await assert.rejects(lateSession, error => error.code === 'UNAUTHENTICATED');

  sessionLive = true;
  const rejectedSession = host.invokeOperation(descriptor.id, 1, actor, 'tenant-a', { value: 'rejected' }, undefined, undefined, 'session-rejected', originalAuth);
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  sessionLive = false;
  pending[1].reject(new Error('handler rejection is suppressed by the expired original session'));
  await assert.rejects(rejectedSession, error => error.code === 'UNAUTHENTICATED');

  sessionLive = true;
  const abort = new AbortController();
  const lateAbort = host.invokeOperation(descriptor.id, 1, actor, 'tenant-a', { value: 'cancel' }, undefined, abort.signal, 'cancel-late', originalAuth);
  while (pending.length < 3) await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  pending[2].resolve({ value: 'late' });
  await assert.rejects(lateAbort, error => error.code === 'UNAVAILABLE');

  const invalidOutput = host.invokeOperation(descriptor.id, 1, actor, 'tenant-a', { value: 'output' }, undefined, undefined, 'bad-output', originalAuth);
  while (pending.length < 4) await new Promise(resolve => setImmediate(resolve));
  pending[3].resolve({ value: 42 });
  await assert.rejects(invalidOutput, error => error.code === 'INVALID');

  permitted = false;
  assert.equal(host.operationCatalogue(actor, 'tenant-a', originalAuth).length, 0);
});

test('operation strings count Unicode code points, reject NUL, and use the bounded anchored pattern grammar', () => {
  const stringSchema = { type: 'string', minLength: 2, maxLength: 2 };
  assert.deepEqual(validateOperationValue('😀a', stringSchema, 'input'), '😀a');
  assert.throws(() => validateOperationValue('😀', stringSchema, 'input'), error => error.code === 'INVALID');
  assert.throws(() => validateOperationValue('a\0', stringSchema, 'input'), error => error.code === 'INVALID');

  const patterned = { type: 'string', minLength: 2, maxLength: 2, pattern: '^[A-F0-9]{2}$' };
  assert.deepEqual(validateOperationValue('AF', patterned, 'input'), 'AF');
  assert.throws(() => validateOperationValue('AG', patterned, 'input'), error => error.code === 'INVALID');
  const escapedLiteral = { type: 'string', minLength: 3, maxLength: 3, pattern: '^a\\.b$' };
  assert.deepEqual(validateOperationValue('a.b', escapedLiteral, 'input'), 'a.b');
  assert.throws(() => validateOperationValue('axb', escapedLiteral, 'input'), error => error.code === 'INVALID');
  assert.throws(() => validateOperationDescriptor({
    id: 'probe.pattern.read', version: 1, title: 'Pattern', description: 'Bounded pattern test.', permission: 'probe.read', kind: 'read',
    inputSchema: { type: 'string', pattern: '^a+a+a+a+$' }, outputSchema: { type: 'string' }
  }), error => error.code === 'INVALID');
  assert.throws(() => validateOperationDescriptor({
    id: 'probe.enum.read', version: 1, title: 'Enum', description: 'NUL-free values.', permission: 'probe.read', kind: 'read',
    inputSchema: { type: 'string', enum: ['a\0'] }, outputSchema: { type: 'string' }
  }), error => error.code === 'INVALID');

  const bounded = { type: 'string', minLength: 1001, maxLength: 1001, pattern: '^a{1000}b$' };
  assert.deepEqual(validateOperationValue(`${'a'.repeat(1000)}b`, bounded, 'input'), `${'a'.repeat(1000)}b`);
  assert.throws(() => validateOperationValue(`${'a'.repeat(1000)}c`, bounded, 'input'), error => error.code === 'INVALID');
});
