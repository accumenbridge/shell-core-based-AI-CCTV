import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '@quadbridge/contracts';
import { PlatformError } from '@quadbridge/contracts';
import { COMMAND_OUTCOME_SCHEMA, markTrustedCommandError } from '@quadbridge/contracts/ui-state';
import { createCommandState, requestJson } from '@quadbridge/client-core';

const context = (actor = { id: 'operator', kind: 'user' }) => ({
  scope: { productId: 'assets', instanceId: 'instance-a', tenantId: 'tenant-a' },
  ...(actor === null ? {} : { actor }),
  signal: new AbortController().signal,
  isCurrent: () => true
});

function terminalRejection(intent, overrides = {}, fields = []) {
  const error = new PlatformError('INVALID', 'The submitted field needs attention');
  const command = {
    id: intent.id, operation: intent.operation, productId: intent.scope.productId,
    instanceId: intent.scope.instanceId, tenantId: intent.scope.tenantId,
    actor: intent.actor ?? { id: 'operator', kind: 'user' },
    submittedPayloadDigest: intent.submittedPayloadDigest, ...overrides
  };
  assert.equal(markTrustedCommandError(error, {
    schema: COMMAND_OUTCOME_SCHEMA, state: 'REJECTED_NO_BUSINESS_EFFECTS', scope: 'ORIGINAL_COMMAND', terminal: true, command
  }, fields), true);
  return error;
}

test('missing optional actor still permits first write, exact retry and positive confirmation', async () => {
  const state = createCommandState(context(null));
  const payload = { fields: { assetCode: 'A-17' } };
  const intent = await state.capture('asset:create', 'asset-register.asset.create', payload);
  let calls = 0;
  await assert.rejects(state.send(intent, async (id, body) => {
    calls++;
    assert.equal(id, intent.id);
    assert.deepEqual(body, payload);
    throw new Error('response lost');
  }), /response lost/);
  assert.equal(state.state(intent), 'UNKNOWN');
  assert.equal(await state.capture('asset:create', 'asset-register.asset.create', payload), intent);
  await assert.rejects(state.capture('asset:create', 'asset-register.asset.create', { fields: { assetCode: 'changed' } }), e => e.code === 'CONFLICT');
  await assert.rejects(state.retry(intent, async () => { calls++; throw terminalRejection(intent); }), /submitted field/);
  assert.equal(state.state(intent), 'UNKNOWN', 'a receipt with no matching original actor cannot certify a rejected attempt');
  await state.retry(intent, async () => { calls++; return { id: 'record-a', version: 1 }; });
  assert.equal(state.state(intent), 'COMMITTED');
  const next = await state.capture('asset:create', 'asset-register.asset.create', { fields: { assetCode: 'A-18' } });
  assert.notEqual(next.id, intent.id);
  assert.equal(calls, 3);
  state.dispose();
});

test('only matching terminal scope, actor, key, digest and submitted field paths unlock correction', async () => {
  const state = createCommandState(context());
  const originalPayload = { fields: { assetCode: '' } };
  const original = await state.capture('asset:create', 'asset-register.asset.create', originalPayload);
  const malformedFieldPath = terminalRejection(original, {}, [{ path: 'fields.otherField', code: 'INVALID', message: 'Not submitted' }]);
  await assert.rejects(state.send(original, async () => { throw malformedFieldPath; }), /submitted field/);
  assert.equal(state.state(original), 'UNKNOWN');

  const wrongDigest = terminalRejection(original, { submittedPayloadDigest: '0'.repeat(64) }, [{ path: 'fields.assetCode', code: 'INVALID', message: 'Required' }]);
  await assert.rejects(state.retry(original, async () => { throw wrongDigest; }), error => error === wrongDigest);
  assert.equal(state.state(original), 'UNKNOWN');

  const rejection = terminalRejection(original, {}, [{ path: 'fields.assetCode', code: 'INVALID', message: 'Required' }]);
  await assert.rejects(state.retry(original, async () => { throw rejection; }), /submitted field/);
  assert.equal(state.state(original), 'REJECTED_NO_BUSINESS_EFFECTS');
  const correction = await state.capture('asset:create', 'asset-register.asset.create', { fields: { assetCode: 'A-19' } });
  assert.notEqual(correction.id, original.id);
  assert.equal(correction.actor.id, 'operator');
  state.dispose();
});

test('malformed provided field-error sidecar cannot brand an otherwise matching outcome', async () => {
  const state = createCommandState(context());
  const intent = await state.capture('asset:create', 'asset-register.asset.create', { fields: { assetCode: '' } });
  const responseBody = {
    error: {
      code: 'INVALID', message: 'Owner rejected the submitted field',
      commandOutcome: {
        schema: COMMAND_OUTCOME_SCHEMA, state: 'REJECTED_NO_BUSINESS_EFFECTS', scope: 'ORIGINAL_COMMAND', terminal: true,
        command: {
          id: intent.id, operation: intent.operation, productId: intent.scope.productId, instanceId: intent.scope.instanceId,
          tenantId: intent.scope.tenantId, actor: intent.actor, submittedPayloadDigest: intent.submittedPayloadDigest
        }
      },
      fieldErrors: [{ path: 'fields.AssetCode', code: 'INVALID', message: 'Not a permitted field path' }]
    }
  };
  await assert.rejects(state.send(intent, async (_id, payload) => requestJson('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }, undefined, undefined, { fetcher: async () => new Response(JSON.stringify(responseBody), { status: 400, headers: { 'Content-Type': 'application/json' } }) })), error => error.code === 'INVALID');
  assert.equal(state.state(intent), 'UNKNOWN', 'invalid provided sidecar leaves the dispatched original locked');
  state.dispose();
});

test('concurrent captures reserve the slot before deferred digest and stale hashing cannot replace the next identity', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const realCrypto = globalThis.crypto;
  let releaseOld;
  const oldDigest = new Promise(resolve => { releaseOld = resolve; });
  const subtle = {
    digest(algorithm, bytes) {
      const serialized = new TextDecoder().decode(bytes);
      if (serialized.includes('older payload')) return oldDigest;
      return realCrypto.subtle.digest(algorithm, bytes);
    }
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, randomUUID: realCrypto.randomUUID.bind(realCrypto) } });
  try {
    const state = createCommandState(context());
    const older = state.capture('asset:create', 'asset-register.asset.create', { title: 'older payload' });
    await assert.rejects(state.capture('asset:create', 'asset-register.asset.create', { title: 'later payload' }), e => e.code === 'CONFLICT');
    releaseOld(await realCrypto.subtle.digest('SHA-256', new TextEncoder().encode('older payload')));
    const first = await older;
    await state.send(first, async () => ({ id: 'record-a', version: 1 }));
    const next = await state.capture('asset:create', 'asset-register.asset.create', { title: 'later payload' });
    assert.notEqual(next.id, first.id);
    assert.equal(state.state(first), undefined, 'the prior scope-slot record is replaced only after its confirmed command');
    state.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('captured canonical JSON preserves an own __proto__ key and dispatches the bytes covered by its digest', async () => {
  const state = createCommandState(context());
  const payload = JSON.parse('{"fields":{"__proto__":"literal-json-value","assetCode":"A-22"}}');
  const intent = await state.capture('asset:create', 'asset-register.asset.create', payload);
  assert.equal(Object.getPrototypeOf(intent.payload.fields), Object.prototype);
  assert.equal(Object.hasOwn(intent.payload.fields, '__proto__'), true);
  assert.equal(intent.payload.fields.__proto__, 'literal-json-value');
  const canonicalDigest = createHash('sha256').update(canonical(payload)).digest('hex');
  assert.equal(intent.submittedPayloadDigest, canonicalDigest);
  await state.send(intent, async (_id, dispatched) => {
    assert.equal(Object.hasOwn(dispatched.fields, '__proto__'), true);
    assert.equal(canonical(dispatched), canonical(payload));
    assert.equal(createHash('sha256').update(canonical(dispatched)).digest('hex'), intent.submittedPayloadDigest);
    return { accepted: true };
  });
  state.dispose();
});

test('scope invalidation clears captured payload and fences a late digest continuation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const realCrypto = globalThis.crypto;
  let release;
  const digest = new Promise(resolve => { release = resolve; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle: { digest: () => digest }, randomUUID: realCrypto.randomUUID.bind(realCrypto)
  } });
  try {
    const controller = new AbortController();
    const state = createCommandState({ ...context(), signal: controller.signal });
    const pending = state.capture('asset:create', 'asset-register.asset.create', { fields: { assetCode: 'hidden' } });
    controller.abort();
    release(await realCrypto.subtle.digest('SHA-256', new TextEncoder().encode('{}')));
    await assert.rejects(pending, error => error.name === 'AbortError');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});
