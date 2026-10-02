import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, admin, viewer } from './helpers.mjs';
import { validateResult } from '@quadbridge/veyviz-rfdetr/bridge';
import { MODEL_SHA256, RECORDING_SHA256, PROFILE_ID, REQUEST_SCHEMA, RESULT_SCHEMA } from '@quadbridge/veyviz-rfdetr/protocol';

// A deterministic inference-port double for owner/race tests. Actual RF-DETR
// execution is a separate installed-Python and product HTTP evidence gate.
const resultFor = request => ({ schema: RESULT_SCHEMA, status: 'SUCCEEDED', request: structuredClone(request),
  sourceSha256: RECORDING_SHA256, modelSha256: MODEL_SHA256, modelId: PROFILE_ID,
  startedAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:00:01.000Z',
  decodedFrames: (request.frameCount - 1) * request.sampleStride + 1,
  samples: Array.from({ length: request.frameCount }, (_, n) => ({ frameIndex: n * request.sampleStride, positionMs: n * 1000 / 3, width: 640, height: 480, inferenceMs: 10, detections: [] })),
  coverage: 'UNCOMMISSIONED_RECORDING', occupancy: 'UNKNOWN',
  cleanup: { sourceClosed: true, inferenceClosed: true, retainedBytes: 0, outstandingLeases: 0 }, versions: { onnxruntime: '1.23.2' } });

async function product(t) {
  const prior = process.env.VEYVIZ_AI_PROFILE;
  delete process.env.VEYVIZ_AI_PROFILE;
  t.after(() => { if (prior === undefined) delete process.env.VEYVIZ_AI_PROFILE; else process.env.VEYVIZ_AI_PROFILE = prior; });
  const f = await fixture(t, 'veyviz-review');
  const provider = f.runtime.modules.find(m => m.manifest.id === 'veyviz-rfdetr').services['veyviz.recorded-analysis.run.v1'];
  provider.run = async request => resultFor(request);
  const source = await f.call('POST', '/api/sources', { name: 'Scoped recording', fixtureId: 'mivia-vid0062' }, 'source');
  const input = { sourceId: source.id, frameCount: 3, sampleStride: 10 };
  return { f, provider, source, input, analysis: f.runtime.modules.find(m => m.manifest.id === 'veyviz-analysis') };
}

test('Veyviz operation SDK runs real owned operations with declared output schemas', async t => {
  const { f } = await product(t);
  const listed = await f.runtime.host.invokeOperation('veyviz-sources.sources.list', 1, admin, 'tenant-a', {});
  assert.equal(listed.items.length, 1);
  const analyses = await f.runtime.host.invokeOperation('veyviz-analysis.analysis.list', 1, admin, 'tenant-a', {});
  assert.deepEqual(analyses.items, []);
  await assert.rejects(f.call('POST', '/api/sources', { name: 'Denied', fixtureId: 'mivia-vid0062' }, 'denied', viewer), error => error.code === 'DENIED');
});

test('analysis receipt replays unchanged client command after source rename; changed body conflicts', async t => {
  const { f, source, input } = await product(t);
  const original = await f.call('POST', '/api/analysis', input, 'original-command');
  await f.call('POST', '/api/sources/rename', { sourceId: source.id, name: 'Renamed recording' }, 'rename');
  assert.deepEqual(await f.call('POST', '/api/analysis', input, 'original-command'), original);
  await assert.rejects(f.call('POST', '/api/analysis', { ...input, frameCount: 2 }, 'original-command'), error => error.code === 'CONFLICT');
  await f.tick();
  const result = await f.call('GET', `/api/analysis/result?analysisId=${original.id}`);
  assert.equal(result.jobState, 'FAILED');
  assert.equal(result.result, null);
});

test('source version changed during inference prevents durable Product acceptance', async t => {
  const { f, provider, source, input } = await product(t);
  provider.run = async request => {
    await f.call('POST', '/api/sources/rename', { sourceId: source.id, name: 'Changed during execution' }, 'concurrent-rename');
    return resultFor(request);
  };
  const submitted = await f.call('POST', '/api/analysis', input, 'race-command');
  await f.tick();
  const result = await f.call('GET', `/api/analysis/result?analysisId=${submitted.id}`);
  assert.equal(result.jobState, 'FAILED'); assert.equal(result.result, null);
});

test('analysis authority revoked after preparation is synchronously denied at owner commit', async t => {
  const { f, analysis, input } = await product(t);
  const submitted = await f.call('POST', '/api/analysis', input, 'revoke-command');
  const job = analysis.queue.claim('explicit-test-worker', 30_000, () => true);
  assert.equal(job.id, submitted.jobId);
  const prepared = await analysis.handlers[0].prepare(JSON.parse(job.payload), {
    tenantId: job.tenant, signal: new AbortController().signal, jobId: job.id, attempt: job.attempt,
    assertCurrent() { analysis.queue.assertCurrent(job); f.runtime.access.assertModule(admin, 'tenant-a', 'veyviz-analysis', 'veyviz.analysis.write', 'write'); }
  });
  f.runtime.access.revoke('admin', 'tenant-a', 'veyviz.analysis.write');
  assert.throws(() => analysis.queue.finish(job, prepared), error => error.code === 'DENIED');
  const result = await f.call('GET', `/api/analysis/result?analysisId=${submitted.id}`);
  assert.equal(result.result, null);
});

test('cancellation during inference fences an otherwise successful result', async t => {
  const { f, provider, input } = await product(t);
  const submitted = await f.call('POST', '/api/analysis', input, 'cancel-command');
  provider.run = async request => {
    await f.call('POST', '/api/analysis/cancel', { analysisId: submitted.id }, 'cancel-current');
    return resultFor(request);
  };
  await f.tick();
  const result = await f.call('GET', `/api/analysis/result?analysisId=${submitted.id}`);
  assert.equal(result.jobState, 'CANCELLED'); assert.equal(result.result, null);
});

test('accepted result and review survive owner restart and stay tenant-scoped', async t => {
  const { f, input } = await product(t);
  const submitted = await f.call('POST', '/api/analysis', input, 'persist-command');
  await f.tick();
  const accepted = await f.call('GET', `/api/analysis/result?analysisId=${submitted.id}`);
  assert.equal(accepted.jobState, 'SUCCEEDED');
  assert.equal(accepted.result.request.commandId, 'persist-command');
  assert.equal(accepted.result.request.scope.actorId, 'admin');
  assert.equal(accepted.result.request.scope.tenantId, 'tenant-a');
  await assert.rejects(f.call('GET', `/api/analysis/result?analysisId=${submitted.id}`, undefined, undefined, admin, 'tenant-b'), error => error.code === 'NOT_FOUND');
  await f.call('POST', '/api/analysis/review', { analysisId: submitted.id, decision: 'REVIEWED' }, 'review-result');
  await f.restart();
  const reopened = await f.call('GET', `/api/analysis/result?analysisId=${submitted.id}`);
  assert.deepEqual(reopened.result, accepted.result); assert.equal(reopened.reviewState, 'REVIEWED');
});

test('strict AI proposal validator permits optional thumbnail but rejects altered identity, shape and cleanup', () => {
  const request = { schema: REQUEST_SCHEMA, jobId: 'job-1', commandId: 'command-1', scope: { productId: 'veyviz-review', instanceId: 'local', tenantId: 'alpha', actorId: 'admin', actorKind: 'user' }, sourceId: 'source-1', sourceVersion: 1, fixtureId: 'mivia-vid0062', profileId: PROFILE_ID, frameCount: 3, sampleStride: 10 };
  const ready = { sourceSha256: RECORDING_SHA256, modelSha256: MODEL_SHA256 };
  const good = resultFor(request);
  assert.equal(validateResult(good, request, ready).samples.length, 3);
  const corruptions = [
    value => { value.request.scope.actorId = 'other'; },
    value => { value.request.scope.tenantId = 'beta'; },
    value => { value.samples.pop(); },
    value => { value.samples[1].frameIndex = 0; },
    value => { value.decodedFrames = 1; },
    value => { value.cleanup.inferenceClosed = false; },
    value => { value.modelSha256 = '0'.repeat(64); },
    value => { value.samples[0].inferenceMs = Infinity; },
    value => { value.samples[0].detections = [{ confidence: .8, x1: 0, y1: 0, x2: 641, y2: 10 }]; },
    value => { value.samples[0].thumbnailJpegBase64 = 'bm90IGFuIGltYWdl'; },
    value => { value.samples[0].unexpected = true; }
  ];
  for (const corrupt of corruptions) { const value = structuredClone(good); corrupt(value); assert.throws(() => validateResult(value, request, ready)); }
});
