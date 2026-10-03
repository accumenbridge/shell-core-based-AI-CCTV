import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, admin, viewer } from './helpers.mjs';
import { validateResult } from '@quadbridge/veyviz-rfdetr/bridge';
import { MODEL_SHA256, RECORDING_SHA256, PROFILE_ID, REQUEST_SCHEMA, RESULT_SCHEMA } from '@quadbridge/veyviz-rfdetr/protocol';
import { createAnalysisQueryState } from '../modules/veyviz-analysis/dist/ui.js';

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

test('source owner query traverses registrations beyond the v1 cap and binds every cursor to query scope', async t => {
  const { f, source } = await product(t);
  const expected = new Set([source.id]);
  const originalNow = Date.now;
  const tiedCreated = originalNow();
  Date.now = () => tiedCreated;
  t.after(() => { Date.now = originalNow; });
  for (let index = 0; index < 210; index++) {
    const saved = await f.call('POST', '/api/sources', {
      name: index === 0 ? 'page-fixture-000-%_literal' : `page-fixture-${String(index).padStart(3, '0')}`,
      fixtureId: 'mivia-vid0062'
    }, `source-page-${index}`);
    expected.add(saved.id);
  }
  const unicodeSource = await f.call('POST', '/api/sources', { name: 'Étage', fixtureId: 'mivia-vid0062' }, 'source-unicode');
  expected.add(unicodeSource.id);

  const seen = [];
  let cursor;
  let requests = 0;
  do {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await f.call('GET', `/api/sources/query?limit=20${suffix}`);
    assert.equal(page.page.limit, 20);
    assert.equal(page.page.coverage, 'filtered-owner-query');
    assert.ok(page.items.length <= 20);
    seen.push(...page.items.map(item => item.id));
    cursor = page.page.nextCursor;
    assert.ok(++requests <= 12, 'the bounded fixture should traverse in at most twelve requests');
  } while (cursor);
  assert.equal(seen.length, 212);
  assert.equal(new Set(seen).size, seen.length, 'keyset pages must not repeat rows');
  assert.deepEqual(new Set(seen), expected, 'keyset pages must include old rows beyond the legacy list cap');

  const legacy = await f.call('GET', '/api/sources');
  assert.equal(legacy.items.length, 100);
  assert.deepEqual(Object.keys(legacy).sort(), ['items']);
  assert.deepEqual(Object.keys(legacy.items[0]).sort(), ['created', 'fixtureId', 'id', 'name', 'version']);
  const legacyOperation = await f.runtime.host.invokeOperation('veyviz-sources.sources.list', 1, admin, 'tenant-a', {});
  assert.equal(legacyOperation.items.length, 100);
  assert.deepEqual(Object.keys(legacyOperation).sort(), ['items']);
  assert.deepEqual(Object.keys(legacyOperation.items[0]).sort(), ['created', 'fixtureId', 'id', 'name', 'version']);
  const beyondLegacySourceId = seen[100];
  assert.ok(!legacy.items.some(item => item.id === beyondLegacySourceId));
  assert.deepEqual((await f.call('GET', `/api/sources/query?search=${encodeURIComponent(beyondLegacySourceId)}&limit=20`)).items.map(item => item.id), [beyondLegacySourceId]);
  const delegatedOlder = await f.call('GET', `/api/analysis/sources/query?search=${encodeURIComponent(beyondLegacySourceId)}&limit=20`);
  assert.deepEqual(delegatedOlder.items.map(item => item.id), [beyondLegacySourceId], 'analysis source picker delegates old-source search to the source owner');
  const delegatedOperation = await f.runtime.host.invokeOperation('veyviz-analysis.sources.query', 1, admin, 'tenant-a', { search: beyondLegacySourceId, limit: 20 });
  assert.deepEqual(delegatedOperation.items.map(item => item.id), [beyondLegacySourceId]);
  await assert.rejects(f.runtime.host.invokeOperation('veyviz-analysis.sources.query', 1, admin, 'tenant-a', { search: beyondLegacySourceId, sort: 'name' }), error => error.code === 'INVALID');
  const olderAnalysis = await f.call('POST', '/api/analysis', { sourceId: delegatedOlder.items[0].id, frameCount: 1, sampleStride: 1 }, 'older-source-submit');
  assert.equal((await f.call('GET', `/api/analysis/query?sourceId=${encodeURIComponent(beyondLegacySourceId)}&limit=20`)).items[0].id, olderAnalysis.id);

  const matchedById = await f.call('GET', `/api/sources/query?search=${encodeURIComponent(source.id)}&limit=20`);
  assert.deepEqual(matchedById.items.map(item => item.id), [source.id]);
  const matchedByName = await f.call('GET', '/api/sources/query?search=page-fixture-209&limit=20');
  assert.deepEqual(matchedByName.items.map(item => item.name), ['page-fixture-209']);
  assert.deepEqual((await f.call('GET', `/api/sources/query?search=${encodeURIComponent('Étage')}&limit=20`)).items.map(item => item.id), [unicodeSource.id], 'source search matches an exact non-ASCII name');
  assert.deepEqual((await f.call('GET', `/api/sources/query?search=${encodeURIComponent('ÉTAGE')}&limit=20`)).items.map(item => item.id), [unicodeSource.id], 'source search folds non-ASCII case with JavaScript semantics');
  const delegatedUnicode = await f.call('GET', `/api/analysis/sources/query?search=${encodeURIComponent('ÉTAGE')}&limit=20`);
  assert.deepEqual(delegatedUnicode.items.map(item => item.id), [unicodeSource.id], 'delegated recording picker uses the same non-ASCII case fold');
  assert.deepEqual((await f.call('GET', `/api/sources/query?search=${encodeURIComponent('%_')}&limit=20`)).items.map(item => item.name), ['page-fixture-000-%_literal'], 'search treats wildcard-looking characters as literal text');
  await f.call('POST', '/api/sources/rename', { sourceId: source.id, name: 'Renamed scoped recording' }, 'page-test-rename');
  const renamed = await f.call('GET', '/api/sources/query?renamedOnly=true&limit=20');
  assert.deepEqual(renamed.items.map(item => item.id), [source.id]);

  const first = await f.call('GET', '/api/sources/query?search=page-fixture-&limit=20');
  assert.ok(first.page.nextCursor);
  const pageOperation = await f.runtime.host.invokeOperation('veyviz-sources.sources.query', 1, admin, 'tenant-a', { search: 'page-fixture-', limit: 20 });
  assert.deepEqual(pageOperation.items.map(item => item.id), first.items.map(item => item.id));
  assert.deepEqual(Object.keys(pageOperation).sort(), ['items', 'page']);
  assert.deepEqual(Object.keys(pageOperation.page).sort(), ['coverage', 'limit', 'nextCursor']);
  assert.deepEqual(Object.keys(pageOperation.items[0]).sort(), ['created', 'fixtureId', 'id', 'name', 'version']);
  await assert.rejects(f.runtime.host.invokeOperation('veyviz-sources.sources.query', 1, admin, 'tenant-a', { search: 'page-fixture-', sort: 'name' }), error => error.code === 'INVALID');
  await assert.rejects(f.runtime.host.invokeOperation('veyviz-sources.sources.query', 1, admin, 'tenant-a', { limit: 0 }), error => error.code === 'INVALID');
  for (const [query, code] of [
    [`/api/sources/query?search=other&limit=20&cursor=${encodeURIComponent(first.page.nextCursor)}`, 'INVALID'],
    [`/api/sources/query?search=page-fixture-&renamedOnly=true&limit=20&cursor=${encodeURIComponent(first.page.nextCursor)}`, 'INVALID'],
    [`/api/sources/query?search=page-fixture-&limit=21&cursor=${encodeURIComponent(first.page.nextCursor)}`, 'INVALID']
  ]) await assert.rejects(f.call('GET', query), error => error.code === code);
  await assert.rejects(f.call('GET', `/api/sources/query?search=page-fixture-&limit=20&cursor=${encodeURIComponent(first.page.nextCursor)}`, undefined, undefined, admin, 'tenant-b'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', '/api/sources/query?limit=101'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', '/api/sources/query?cursor=not-a-valid-token'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', '/api/sources/query?limit=20&limit=20'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', `/api/sources/query?search=${'x'.repeat(201)}`), error => error.code === 'INVALID');

  const viewerFirst = await f.call('GET', '/api/sources/query?search=page-fixture-&limit=20', undefined, undefined, viewer);
  assert.ok(viewerFirst.page.nextCursor);
  f.runtime.access.revoke('viewer', 'tenant-a', 'veyviz.sources.read');
  await assert.rejects(f.call('GET', `/api/sources/query?search=page-fixture-&limit=20&cursor=${encodeURIComponent(viewerFirst.page.nextCursor)}`, undefined, undefined, viewer), error => error.code === 'DENIED');
  await assert.rejects(f.call('GET', '/api/analysis/sources/query?search=page-fixture-&limit=20', undefined, undefined, viewer), error => error.code === 'DENIED');
});

test('analysis owner query pages all matching history, filters owner rows and leaves the v1 list cap intact', async t => {
  const { f, source } = await product(t);
  const originalNow = Date.now;
  const startedAt = originalNow();
  let creationOffset = 0;
  Date.now = () => startedAt + creationOffset;
  t.after(() => { Date.now = originalNow; });
  const submitted = [];
  for (let index = 0; index < 32; index++) {
    creationOffset = Math.floor(index / 2);
    submitted.push(await f.call('POST', '/api/analysis', { sourceId: source.id, frameCount: 1, sampleStride: 1 }, `analysis-page-${index}`));
  }
  assert.equal(await f.tick(), true);

  const allIds = new Set(submitted.map(item => item.id));
  const seen = [];
  let cursor;
  let requests = 0;
  do {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await f.call('GET', `/api/analysis/query?limit=20${suffix}`);
    assert.equal(page.page.limit, 20);
    assert.equal(page.page.coverage, 'filtered-owner-query');
    assert.ok(page.items.length <= 20);
    seen.push(...page.items.map(item => item.id));
    cursor = page.page.nextCursor;
    assert.ok(++requests <= 3, 'the bounded fixture should traverse in at most three requests');
  } while (cursor);
  assert.equal(seen.length, 32);
  assert.equal(new Set(seen).size, seen.length, 'analysis keyset pages must not repeat rows');
  assert.deepEqual(new Set(seen), allIds, 'analysis query must include rows beyond the legacy 25-item list');

  const legacy = await f.call('GET', '/api/analysis');
  assert.deepEqual(Object.keys(legacy).sort(), ['items', 'limit']);
  assert.equal(legacy.limit, 25);
  assert.equal(legacy.items.length, 25);
  assert.ok(Object.hasOwn(legacy.items[0], 'sourceChanged'));
  assert.deepEqual(Object.keys(legacy.items[0]).sort(), ['coverage', 'created', 'detectionCount', 'id', 'jobId', 'jobState', 'occupancy', 'reviewState', 'sampleCount', 'sourceChanged', 'sourceId', 'sourceVersion']);
  const legacyOperation = await f.runtime.host.invokeOperation('veyviz-analysis.analysis.list', 1, admin, 'tenant-a', {});
  assert.equal(legacyOperation.items.length, 25);
  assert.deepEqual(Object.keys(legacyOperation).sort(), ['items']);
  assert.deepEqual(Object.keys(legacyOperation.items[0]).sort(), ['coverage', 'created', 'detectionCount', 'id', 'jobId', 'jobState', 'occupancy', 'reviewState', 'sampleCount', 'sourceId', 'sourceVersion']);
  assert.ok(!legacy.items.some(item => item.id === seen[25]));
  assert.deepEqual((await f.call('GET', `/api/analysis/query?q=${encodeURIComponent(seen[25])}&limit=20`)).items.map(item => item.id), [seen[25]]);

  const allMatchingSource = await f.call('GET', `/api/analysis/query?sourceId=${encodeURIComponent(source.id)}&createdAfter=0&createdBefore=${Date.now()}&limit=100`);
  assert.equal(allMatchingSource.items.length, 32);
  assert.ok(allMatchingSource.items.every(item => item.sourceId === source.id && item.created >= startedAt));
  const sourceSearch = await f.call('GET', `/api/analysis/query?q=${encodeURIComponent(source.id)}&limit=100`);
  assert.equal(sourceSearch.items.length, 32, 'literal search includes captured source IDs');
  const tieTimestamp = startedAt + 8;
  assert.equal((await f.call('GET', `/api/analysis/query?createdAfter=${tieTimestamp}&createdBefore=${tieTimestamp}&limit=20`)).items.length, 2, 'date bounds are inclusive and tied timestamps remain queryable');
  const exactAnalysis = await f.call('GET', `/api/analysis/query?q=${encodeURIComponent(submitted[0].id)}&limit=20`);
  assert.deepEqual(exactAnalysis.items.map(item => item.id), [submitted[0].id]);
  const exactJob = await f.call('GET', `/api/analysis/query?q=${encodeURIComponent(submitted[1].jobId)}&limit=20`);
  assert.deepEqual(exactJob.items.map(item => item.jobId), [submitted[1].jobId]);
  assert.equal((await f.call('GET', '/api/analysis/query?jobState=QUEUED&limit=100')).items.length, 31);
  assert.equal((await f.call('GET', '/api/analysis/query?jobState=SUCCEEDED&limit=100')).items.length, 1);

  const succeeded = (await f.call('GET', '/api/analysis/query?jobState=SUCCEEDED&limit=20')).items[0];
  await f.call('POST', '/api/analysis/review', { analysisId: succeeded.id, decision: 'REVIEWED' }, 'page-test-review');
  assert.equal((await f.call('GET', '/api/analysis/query?reviewState=REVIEWED&limit=100')).items.length, 1);
  assert.equal((await f.call('GET', '/api/analysis/query?reviewState=OPEN&limit=100')).items.length, 31);
  assert.equal((await f.runtime.host.invokeOperation('veyviz-analysis.analysis.query', 1, admin, 'tenant-a', { q: submitted[0].id, limit: 20 })).items[0].id, submitted[0].id);

  const activeQuery = createAnalysisQueryState('7d', startedAt);
  const queryFilters = { reviewState: 'OPEN' };
  const firstActivePage = await f.call('GET', activeQuery.url(queryFilters));
  assert.ok(firstActivePage.page.nextCursor, 'the active date query spans multiple owner pages');
  const capturedBound = new URL(activeQuery.url(queryFilters), 'http://fixture').searchParams.get('createdAfter');
  creationOffset += 5_000;
  const insertedAfterFirstPage = await f.call('POST', '/api/analysis', { sourceId: source.id, frameCount: 1, sampleStride: 1 }, 'analysis-after-first-query-page');
  const nextPageUrl = activeQuery.url(queryFilters, firstActivePage.page.nextCursor);
  assert.equal(new URL(nextPageUrl, 'http://fixture').searchParams.get('createdAfter'), capturedBound, 'paging keeps the date bound captured by the active query');
  const secondActivePage = await f.call('GET', nextPageUrl);
  assert.ok(!secondActivePage.items.some(item => item.id === insertedAfterFirstPage.id), 'a newer row does not shift the active cursor page');
  creationOffset += 5_000;
  const refreshedActivePage = await f.call('GET', activeQuery.url(queryFilters, firstActivePage.page.nextCursor));
  assert.deepEqual(refreshedActivePage.items.map(item => item.id), secondActivePage.items.map(item => item.id), 'a later refresh preserves the active query cursor and page membership');
  assert.equal(new URL(activeQuery.url(queryFilters, firstActivePage.page.nextCursor), 'http://fixture').searchParams.get('createdAfter'), capturedBound);
  activeQuery.reset('7d');
  const resetUrl = activeQuery.url(queryFilters);
  assert.equal(new URL(resetUrl, 'http://fixture').searchParams.has('cursor'), false, 'an explicit query reset starts at page one');
  assert.ok(Number(new URL(resetUrl, 'http://fixture').searchParams.get('createdAfter')) > Number(capturedBound), 'an explicit reset renews the rolling date bound');
  assert.equal((await f.call('GET', resetUrl)).items[0].id, insertedAfterFirstPage.id, 'the reset query includes rows added since the prior active query');

  const first = await f.call('GET', '/api/analysis/query?reviewState=OPEN&limit=20');
  assert.ok(first.page.nextCursor);
  assert.deepEqual(Object.keys(first).sort(), ['items', 'page']);
  assert.deepEqual(Object.keys(first.page).sort(), ['coverage', 'limit', 'nextCursor']);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['coverage', 'created', 'detectionCount', 'id', 'jobId', 'jobState', 'occupancy', 'reviewState', 'sampleCount', 'sourceId', 'sourceVersion']);
  await assert.rejects(f.runtime.host.invokeOperation('veyviz-analysis.analysis.query', 1, admin, 'tenant-a', { jobState: 'finished' }), error => error.code === 'INVALID');
  await assert.rejects(f.runtime.host.invokeOperation('veyviz-analysis.analysis.query', 1, admin, 'tenant-a', { q: submitted[0].id, order: 'name' }), error => error.code === 'INVALID');
  for (const path of [
    `/api/analysis/query?reviewState=REVIEWED&limit=20&cursor=${encodeURIComponent(first.page.nextCursor)}`,
    `/api/analysis/query?reviewState=OPEN&limit=21&cursor=${encodeURIComponent(first.page.nextCursor)}`
  ]) await assert.rejects(f.call('GET', path), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', `/api/analysis/query?reviewState=OPEN&limit=20&cursor=${encodeURIComponent(first.page.nextCursor)}`, undefined, undefined, admin, 'tenant-b'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', '/api/analysis/query?limit=0'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', '/api/analysis/query?cursor=not-a-valid-token'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', '/api/analysis/query?createdAfter=20&createdBefore=10'), error => error.code === 'INVALID');
  await assert.rejects(f.call('GET', `/api/analysis/query?q=${'x'.repeat(201)}`), error => error.code === 'INVALID');

  const viewerFirst = await f.call('GET', '/api/analysis/query?reviewState=OPEN&limit=20', undefined, undefined, viewer);
  assert.ok(viewerFirst.page.nextCursor);
  f.runtime.access.revoke('viewer', 'tenant-a', 'veyviz.analysis.read');
  await assert.rejects(f.call('GET', `/api/analysis/query?reviewState=OPEN&limit=20&cursor=${encodeURIComponent(viewerFirst.page.nextCursor)}`, undefined, undefined, viewer), error => error.code === 'DENIED');
  await assert.rejects(f.call('GET', '/api/analysis/sources/query?limit=20', undefined, undefined, viewer), error => error.code === 'DENIED');
});
