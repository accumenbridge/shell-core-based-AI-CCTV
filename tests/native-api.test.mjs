import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PlatformError, canonical } from '@quadbridge/contracts';
import { markTrustedCommandError } from '@quadbridge/contracts/ui-state';
import { fixture, PASSWORD } from './helpers.mjs';

const ORIGIN = 'http://localhost';

async function request(url, path, { method = 'GET', token, tenant, commandId, origin = ORIGIN, body } = {}) {
  const headers = {};
  if (origin !== undefined) headers.Origin = origin;
  if (token) headers.Authorization = `QBUserSession ${token}`;
  if (tenant) headers['X-QB-Tenant'] = tenant;
  if (commandId) headers['Idempotency-Key'] = commandId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, body: await response.json() };
}

test('native loopback adapter uses real user sessions, selected tenant and original command identity', async t => {
  const f = await fixture(t, 'combined');
  const listener = await f.runtime.nativeHttp(0);
  const login = await request(listener.url, '/native-api/session', {
    method: 'POST', body: { username: 'admin', password: PASSWORD }
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.actor.id, 'admin');
  assert.match(login.body.token, /^[A-Za-z0-9_-]{20,256}$/);
  const token = login.body.token;

  const bootstrap = await request(listener.url, '/native-api/bootstrap', { token, tenant: 'tenant-a' });
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.scope.instanceId, 'combined-test');
  assert.equal(bootstrap.body.scope.tenantId, 'tenant-a');
  assert.deepEqual(bootstrap.body.nativeIdentity, {
    productId: 'combined', productVersion: f.runtime.plan.product.version, instanceId: 'combined-test',
    planDigest: createHash('sha256').update(canonical(f.runtime.plan)).digest('hex'),
    modules: f.runtime.plan.modules.map(({ id, version }) => ({ id, version }))
  });
  assert.ok(bootstrap.body.workspaces.some(item => item.id === 'desk.requests'));
  assert.ok(bootstrap.body.workspaces.some(item => item.id === 'knowledge.library'));

  const input = { title: 'Native request', details: 'Created through the fixed native API' };
  const first = await request(listener.url, '/native-api/api/requests/commit', {
    method: 'POST', token, tenant: 'tenant-a', commandId: 'native-create-001', body: input
  });
  const replay = await request(listener.url, '/native-api/api/requests/commit', {
    method: 'POST', token, tenant: 'tenant-a', commandId: 'native-create-001', body: input
  });
  assert.equal(first.response.status, 200);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.resource.id, first.body.resource.id);
  assert.equal(replay.body.commandId, 'native-create-001');
  const rows = await request(listener.url, '/native-api/api/requests', { token, tenant: 'tenant-a' });
  assert.equal(rows.response.status, 200);
  assert.equal(rows.body.items.length, 1);
  assert.equal(rows.body.items[0].id, first.body.resource.id);

  const desk = f.runtime.modules.find(module => module.manifest.id === 'service-desk');
  const installOutcomeRoute = (path, revokePermission = false) => f.runtime.host.routes.set(`POST ${path}`, {
    module: desk,
    route: { permission: 'desk.create', kind: 'write', handle(ctx, submitted, _query, commandId) {
      const error = new PlatformError('INVALID', 'Asset code is required');
      markTrustedCommandError(error, {
        schema: 'quadbridge.command-outcome.v1', state: 'REJECTED_NO_BUSINESS_EFFECTS', scope: 'ORIGINAL_COMMAND', terminal: true,
        command: { id: commandId, operation: 'asset-register.asset.create', productId: ctx.productId, instanceId: ctx.instanceId,
          tenantId: ctx.tenantId, actor: ctx.actor, submittedPayloadDigest: createHash('sha256').update(canonical(submitted)).digest('hex') }
      }, [{ path: 'fields.assetCode', code: 'INVALID', message: 'Required' }]);
      if (revokePermission) f.runtime.access.revoke('admin', 'tenant-a', 'desk.create');
      throw error;
    } }
  });
  const originalOutcomePath = '/api/test-owner-atomic';
  installOutcomeRoute(originalOutcomePath);
  const originalOutcome = await request(listener.url, `/native-api${originalOutcomePath}`, {
    method: 'POST', token, tenant: 'tenant-a', commandId: 'native-reject-001', body: { fields: { assetCode: '' } }
  });
  assert.equal(originalOutcome.response.status, 400);
  assert.equal(originalOutcome.body.error.commandOutcome.command.id, 'native-reject-001');
  assert.equal(originalOutcome.body.error.commandOutcome.command.actor.id, 'admin');
  assert.equal(originalOutcome.body.error.fieldErrors[0].path, 'fields.assetCode');

  const revokedOutcomePath = '/api/test-owner-atomic-revoked';
  installOutcomeRoute(revokedOutcomePath, true);
  const revokedOutcome = await request(listener.url, `/native-api${revokedOutcomePath}`, {
    method: 'POST', token, tenant: 'tenant-a', commandId: 'native-reject-revoked-001', body: { fields: { assetCode: '' } }
  });
  assert.equal(revokedOutcome.response.status, 403);
  assert.equal(revokedOutcome.body.error.commandOutcome, undefined, 'host permission recheck suppresses a late certificate');
  assert.equal(revokedOutcome.body.error.fieldErrors, undefined);

  const viewerLogin = await request(listener.url, '/native-api/session', {
    method: 'POST', body: { username: 'viewer', password: PASSWORD }
  });
  assert.equal(viewerLogin.response.status, 200);
  const deniedWrite = await request(listener.url, '/native-api/api/requests', {
    method: 'POST', token: viewerLogin.body.token, tenant: 'tenant-a', commandId: 'viewer-write-001', body: input
  });
  assert.equal(deniedWrite.response.status, 403);
  const deniedTenant = await request(listener.url, '/native-api/bootstrap', { token: viewerLogin.body.token, tenant: 'tenant-b' });
  assert.equal(deniedTenant.response.status, 403);

  const hostileOrigin = await request(listener.url, '/native-api/api/requests', {
    method: 'POST', token, tenant: 'tenant-a', commandId: 'hostile-origin-001', origin: 'https://hostile.invalid', body: input
  });
  assert.equal(hostileOrigin.response.status, 403);
  const bearer = await fetch(`${listener.url}/native-api/api/requests`, {
    headers: { Authorization: `Bearer ${token}`, 'X-QB-Tenant': 'tenant-a' }
  });
  assert.equal(bearer.status, 401);

  const logout = await request(listener.url, '/native-api/logout', { method: 'POST', token, body: {} });
  assert.equal(logout.response.status, 200);
  const stale = await request(listener.url, '/native-api/bootstrap', { token, tenant: 'tenant-a' });
  assert.equal(stale.response.status, 401);
});
