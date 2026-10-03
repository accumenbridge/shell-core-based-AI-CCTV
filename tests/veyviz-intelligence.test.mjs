import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, admin, viewer, login, api } from './helpers.mjs';
import { MODEL_SHA256 } from '@quadbridge/veyviz-rfdetr/protocol';
import { byteRange, MediaGateway } from '@quadbridge/veyviz-intelligence/media';
import { geometry, validateTemporalResult } from '@quadbridge/veyviz-intelligence/validation';
import { RUNNER_SHA256 } from '@quadbridge/veyviz-intelligence/runner-hash';
import { createFacade } from '../tools/veyviz-intelligence.mjs';
import { admitRecording } from '../tools/veyviz-recording-admit.mjs';
import { createIntelligence } from '@quadbridge/veyviz-intelligence';
import { SqliteOwner } from '@quadbridge/sqlite';

const resultFor = request => {
  const zone = request.geometry.zones[0]?.id;
  return { schema: 'veyviz.temporal-recording.result.v1', status: 'SUCCEEDED', request: structuredClone(request), sourceSha256: request.sourceSha256, modelSha256: MODEL_SHA256, pipelineSha256: request.pipelineSha256, originPtsMs: 9000, decodedFrames: 25,
    coverage: { policy: 'SAMPLED_UNCOMMISSIONED', observedMs: [0, 1000, 2000], endReason: 'WINDOW_END' },
    appearances: [{ id: 'track-1', category: 'person', firstMs: 0, lastMs: 2000, observations: 3, confidence: .9, description: 'Person appearance; upper-body colour estimate: blue; identity unknown' }],
    events: [{ id: 'event-1', appearanceId: 'track-1', category: 'person', type: 'presence', positionMs: 0, zoneId: null }, ...(zone ? [{ id: 'event-2', appearanceId: 'track-1', category: 'person', type: 'zone_entered', positionMs: 1000, zoneId: zone }, { id: 'event-3', appearanceId: 'track-1', category: 'person', type: 'zone_exited', positionMs: 2000, zoneId: zone }] : [])],
    visits: zone ? [{ id: 'visit-1', appearanceId: 'track-1', zoneId: zone, enteredMs: 1000, lastMs: 1000, exitedMs: 2000, state: 'CLOSED' }] : [], cleanup: { sourceClosed: true, inferenceClosed: true, retainedBytes: 0, outstandingLeases: 0 } };
};
async function setup(t) {
  const original = process.env.VEYVIZ_RECORDINGS_CATALOG, priorMedia = process.env.VEYVIZ_MEDIA_PORT;
  delete process.env.VEYVIZ_MEDIA_PORT;
  t.after(() => { if (original === undefined) delete process.env.VEYVIZ_RECORDINGS_CATALOG; else process.env.VEYVIZ_RECORDINGS_CATALOG = original; if (priorMedia === undefined) delete process.env.VEYVIZ_MEDIA_PORT; else process.env.VEYVIZ_MEDIA_PORT = priorMedia; });
  const f = await fixture(t, 'veyviz-review'), bytes = Buffer.from('0123456789abcdefghijklmnopqrstuv');
  const recording = { id: 'recording-1', tenantId: 'tenant-a', name: 'Admitted native recording', path: join(f.dir, 'recording.mp4'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, captureStartUtc: '2026-10-02T06:20:00Z', clockUncertaintyMs: 1000 };
  await writeFile(recording.path, bytes);
  const catalogPath = join(f.dir, 'catalog.json'); process.env.VEYVIZ_RECORDINGS_CATALOG = catalogPath;
  const writeCatalog = recordings => writeFile(catalogPath, JSON.stringify({ schema: 'veyviz.recording-catalog.v1', recordings })); await writeCatalog([recording]);
  const module = f.runtime.modules.find(m => m.manifest.id === 'veyviz-intelligence'); module.runner.run = async request => resultFor(request);
  const source = await f.call('POST', '/api/intelligence/sources', { recordingId: recording.id }, 'register');
  return { f, module, source, recording, bytes, writeCatalog };
}
const inputFor = source => ({ sourceId: source.sourceId, startMs: 0, endMs: 3000, sampleIntervalMs: 1000 });

test('alert adoption, acknowledgement and anonymous review remain scoped and durable', async t => {
  const { f, source } = await setup(t);
  await f.call('POST', '/api/intelligence/geometry', { sourceId: source.sourceId, geometry: { version: 2, zones: [{ id: 'entry', points: [[.1,.1],[.9,.1],[.9,.9],[.1,.9]] }] } }, 'draw');
  await f.call('POST','/api/intelligence/rules',{sourceId:source.sourceId,name:'Entry review',category:'person',type:'zone_entered',zoneId:'entry',dwellMs:0,enabled:true},'rule');
  const run = await f.call('POST','/api/intelligence/runs',inputFor(source),'with-alert'); await f.tick();
  const alert = (await f.call('GET','/api/intelligence/alerts')).items[0]; assert.equal(alert.runId,run.runId); assert.equal(alert.qualification,'AI_REVIEW_REQUIRED');
  await assert.rejects(f.call('POST','/api/intelligence/alerts/acknowledge',{alertId:alert.id},'foreign',admin,'tenant-b'),e=>e.code==='NOT_FOUND');
  await f.call('POST','/api/intelligence/alerts/acknowledge',{alertId:alert.id},'ack');
  const link = {runId:run.runId,appearanceId:'track-1',entityId:'person-review-1',label:'Anonymous blue clothing'};
  await f.call('POST','/api/intelligence/entities/link',link,'link');
  const summary = await f.call('GET',`/api/intelligence/summary?runId=${run.runId}`);
  assert.equal(summary.categories.person.reviewedEntities,1); assert.equal(summary.categories.person.uniquePhysicalEntities,null);
  assert.equal(summary.activity[0].visits[0].state,'CLOSED');
  await assert.rejects(f.call('POST','/api/intelligence/entities/link',{...link,label:'Different'},'conflict'),e=>e.code==='CONFLICT');
  await f.restart(); assert.equal((await f.call('GET','/api/intelligence/alerts')).items[0].acknowledgedBy,'admin');
  assert.equal((await f.call('GET',`/api/intelligence/summary?runId=${run.runId}`)).categories.person.reviewedEntities,1);
});

test('segment batch inherits drawn geometry and rules, is idempotent and cancellable', async t => {
  const { f, source, recording, writeCatalog } = await setup(t);
  const second = {...recording,id:'recording-2'}; await writeCatalog([recording,second]);
  await f.call('POST','/api/intelligence/geometry',{sourceId:source.sourceId,geometry:{version:2,zones:[{id:'entry',points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]]}]}},'draw');
  await f.call('POST','/api/intelligence/rules',{sourceId:source.sourceId,name:'Family entry',category:'person',type:'zone_entered',zoneId:'entry',dwellMs:0,enabled:true},'family-rule');
  const body={recordingIds:[recording.id,second.id],templateSourceId:source.sourceId,endMs:3000,sampleIntervalMs:1000};
  const batch=await f.call('POST','/api/intelligence/batches',body,'batch');
  assert.deepEqual(await f.call('POST','/api/intelligence/batches',body,'batch'),batch); assert.equal(batch.items.length,2);
  const queued=await f.call('GET',`/api/intelligence/run?runId=${batch.items[0].runId}`); assert.equal(queued.request.scope.actorId,'admin'); assert.equal(queued.request.geometry.zones[0].id,'entry');
  await f.tick(); assert.equal((await f.call('GET','/api/intelligence/alerts')).items[0].name,'Family entry');
  const cancelled=await f.call('POST','/api/intelligence/batches/cancel',{batchId:batch.batchId},'stop-batch');
  assert.ok(cancelled.items.some(i=>i.state==='CANCELLED'));
  await assert.rejects(f.call('POST','/api/intelligence/batches',body,'foreign-batch',admin,'tenant-b'),e=>e.code==='NOT_FOUND');
});

test('watch survives restart, retains original identity and stops segment submission', async t => {
  const { f, source, recording, writeCatalog } = await setup(t);
  const watch=await f.call('POST','/api/intelligence/watches',{templateSourceId:source.sourceId,prefix:'live-',endMs:3000,sampleIntervalMs:1000},'watch');
  await f.restart(); await writeCatalog([recording,{...recording,id:'live-1'}]);
  const deadline=Date.now()+12000; let state;
  do { await new Promise(resolve=>setTimeout(resolve,250)); state=(await f.call('GET','/api/intelligence/watches')).items[0]; } while(!state.processed&&Date.now()<deadline);
  assert.equal(state.processed,1);
  const runs=(await f.call('GET','/api/intelligence/runs')).items; assert.equal(runs.length,1);
  const queued=await f.call('GET',`/api/intelligence/run?runId=${runs[0].runId}`); assert.equal(queued.request.scope.actorId,'admin');
  await f.call('POST','/api/intelligence/watches/stop',{watchId:watch.id},'stop-watch');
  assert.equal((await f.call('GET',`/api/intelligence/run?runId=${runs[0].runId}`)).state,'CANCELLED');
  await writeCatalog([recording,{...recording,id:'live-1'},{...recording,id:'live-2'}]);
  await new Promise(resolve=>setTimeout(resolve,5200)); assert.equal((await f.call('GET','/api/intelligence/watches')).items[0].processed,1);
});

test('plate search returns accepted candidates with correct run scope and no vectors', async t => {
  const { f, module, source } = await setup(t);
  module.runner.run = async request => { const value=resultFor(request); value.appearances[0].category='vehicle'; value.appearances[0].plateCandidates=[{text:'KA01AB1234',confidence:.91}]; value.events[0].category='vehicle'; return value; };
  // A captured advanced policy is needed before machine feature proposals can be accepted.
  const prior=process.env.VEYVIZ_INTELLIGENCE_PROFILE, profile=join(f.dir,'runtime.json');
  await writeFile(profile,JSON.stringify({schema:'veyviz.intelligence-runtime.v1',pythonExecutable:'test',workerPath:'test'})); process.env.VEYVIZ_INTELLIGENCE_PROFILE=profile;
  t.after(()=>{if(prior===undefined)delete process.env.VEYVIZ_INTELLIGENCE_PROFILE;else process.env.VEYVIZ_INTELLIGENCE_PROFILE=prior;});
  const processing={categories:['vehicle'],execution:'CPU',motion:{enabled:false,threshold:.002,heartbeatMs:2000},visual:false,face:false,plate:true};
  module.runner.run = async request => { const value=resultFor(request); value.appearances[0].category='vehicle'; value.appearances[0].plateCandidates=[{text:'KA01AB1234',confidence:.91}]; value.events[0].category='vehicle'; value.processingEvidence={runtimeSha256:request.processing.runtimeSha256,execution:'CPU',consideredMs:[0,1000,2000],motionSkippedMs:[],featureModels:{}}; return value; };
  const run=await f.call('POST','/api/intelligence/runs',{...inputFor(source),processing},'vehicle'); await f.tick();
  const response=await f.call('POST','/api/intelligence/retrieval',{runIds:[run.runId],mode:'plate',q:'KA01',category:'vehicle'},'query');
  assert.equal(response.items.length,1); assert.equal(response.items[0].runId,run.runId); assert.equal(response.items[0].plate.text,'KA01AB1234'); assert.equal('visualVector' in response.items[0],false);
  await assert.rejects(f.call('POST','/api/intelligence/retrieval',{runIds:[run.runId],mode:'plate',q:'KA01'},'foreign-query',admin,'tenant-b'),e=>e.code==='NOT_FOUND');
});

test('paginated recording runs preserve older evidence without mixing tenants', async t => {
  const { f, source } = await setup(t);
  for(let i=0;i<103;i++) await f.call('POST','/api/intelligence/runs',inputFor(source),`page-${i}`);
  const first=await f.call('GET','/api/intelligence/runs'); assert.equal(first.items.length,100); assert.ok(first.nextCursor);
  const second=await f.call('GET',`/api/intelligence/runs?cursor=${first.nextCursor}`); assert.equal(second.items.length,3); assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(r=>r.runId)).size,103);
  assert.equal((await f.call('GET',`/api/intelligence/runs?cursor=${first.nextCursor}`,undefined,undefined,admin,'tenant-b')).items.length,0);
  await assert.rejects(f.call('GET','/api/intelligence/runs?cursor=invalid'),e=>e.code==='INVALID');
});

test('dwell alert playback uses the accepted dwell position and denies other tenants', async t => {
  const { f, module, source } = await setup(t);
  await f.call('POST','/api/intelligence/geometry',{sourceId:source.sourceId,geometry:{version:2,zones:[{id:'entry',points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]]}]}},'draw');
  await f.call('POST','/api/intelligence/rules',{sourceId:source.sourceId,name:'Dwell',category:'person',type:'dwell',zoneId:'entry',dwellMs:1000,enabled:true},'dwell-rule');
  module.runner.run=async request=>{const value=resultFor(request);value.visits[0].enteredMs=0;value.visits[0].lastMs=1000;return value;};
  await f.call('POST','/api/intelligence/runs',inputFor(source),'dwell-run'); await f.tick();
  const alert=(await f.call('GET','/api/intelligence/alerts')).items[0]; assert.equal(alert.positionMs,1000);
  const playback=await f.call('POST','/api/intelligence/playback',{alertId:alert.id},'dwell-playback'); assert.equal(playback.positionMs,1000);
  await assert.rejects(f.call('POST','/api/intelligence/playback',{alertId:alert.id},'foreign',admin,'tenant-b'),e=>e.code==='NOT_FOUND');
});

test('versioned rule disable fences future alerts and rejects stale or foreign edits', async t => {
  const { f, source } = await setup(t);
  const fields={sourceId:source.sourceId,name:'Presence review',category:'person',type:'presence',zoneId:'',dwellMs:0,enabled:true};
  const rule=await f.call('POST','/api/intelligence/rules',fields,'save-rule');
  const disabled=await f.call('POST','/api/intelligence/rules',{...fields,ruleId:rule.id,version:rule.version,enabled:false},'disable-rule');
  assert.equal(disabled.version,2); assert.equal(disabled.enabled,false);
  await assert.rejects(f.call('POST','/api/intelligence/rules',{...fields,ruleId:rule.id,version:rule.version},'stale-rule'),e=>e.code==='CONFLICT');
  await assert.rejects(f.call('POST','/api/intelligence/rules',{...fields,ruleId:rule.id,version:disabled.version},'foreign-rule',admin,'tenant-b'),e=>e.code==='NOT_FOUND');
  await f.call('POST','/api/intelligence/runs',inputFor(source),'disabled-rule-run'); await f.tick(); assert.equal((await f.call('GET','/api/intelligence/alerts')).items.length,0);
  await f.restart(); assert.equal((await f.call('GET','/api/intelligence/rules')).items[0].enabled,false);
});

test('temporal admission is scoped, digest pinned, path-free and idempotent', async t => {
  const { f, source, recording, bytes } = await setup(t);
  assert.equal(source.sha256, recording.sha256); assert.equal('path' in source, false); assert.equal('tenantId' in source, false);
  assert.deepEqual(await f.call('POST', '/api/intelligence/sources', { recordingId: recording.id }, 'register'), source);
  assert.deepEqual((await f.call('GET', '/api/intelligence/catalog', undefined, undefined, admin, 'tenant-b')).items, []);
  await assert.rejects(f.call('POST', '/api/intelligence/sources', { recordingId: recording.id }, 'other-tenant', admin, 'tenant-b'), e => e.code === 'NOT_FOUND');
  await assert.rejects(f.call('POST', '/api/intelligence/sources', { recordingId: recording.id, path: recording.path }, 'path'), e => e.code === 'INVALID');
  await assert.rejects(f.call('POST', '/api/intelligence/sources', { recordingId: recording.id }, 'viewer', viewer), e => e.code === 'DENIED');
  await writeFile(recording.path, Buffer.alloc(bytes.length));
  await assert.rejects(f.call('POST', '/api/intelligence/playback', { sourceId: source.sourceId }), e => e.code === 'INCOMPATIBLE');
});

test('accepted temporal events, visits, filtered pagination and descriptions survive restart', async t => {
  const { f, source } = await setup(t);
  await f.call('POST', '/api/intelligence/geometry', { sourceId: source.sourceId, geometry: { version: 2, zones: [{ id: 'entry', points: [[.1, .1], [.9, .1], [.9, .9], [.1, .9]] }] } }, 'geometry');
  const run = await f.call('POST', '/api/intelligence/runs', inputFor(source), 'run'); await f.tick();
  const accepted = await f.call('GET', `/api/intelligence/run?runId=${run.runId}`); assert.equal(accepted.state, 'SUCCEEDED');
  const timeline = await f.call('GET', `/api/intelligence/timeline?runId=${run.runId}`); assert.equal(timeline.appearances, 1); assert.equal(timeline.zoneEntries, 1); assert.equal(timeline.uniquePeople, null); assert.equal(timeline.occupancy, 'UNKNOWN');
  const first = await f.call('GET', `/api/intelligence/events?runId=${run.runId}&limit=1`); assert.equal(first.items[0].id, 'event-1'); assert.ok(first.nextCursor);
  const second = await f.call('GET', `/api/intelligence/events?runId=${run.runId}&limit=1&cursor=${first.nextCursor}`); assert.equal(second.items[0].id, 'event-2');
  await assert.rejects(f.call('GET', `/api/intelligence/events?runId=${run.runId}&type=presence&cursor=${first.nextCursor}`), e => e.code === 'INVALID');
  assert.equal((await f.call('GET', `/api/intelligence/search?runId=${run.runId}&q=blue`)).items.length, 1);
  assert.equal((await f.call('GET', `/api/intelligence/search?runId=${run.runId}&q=%25`)).items.length, 0);
  assert.equal((await f.call('GET', `/api/intelligence/visits?runId=${run.runId}`)).items[0].state, 'CLOSED');
  const playback = await f.call('POST', '/api/intelligence/playback', { runId: run.runId, eventId: 'event-2' }); assert.equal(playback.positionMs, 1000);
  await assert.rejects(f.call('GET', `/api/intelligence/run?runId=${run.runId}`, undefined, undefined, admin, 'tenant-b'), e => e.code === 'NOT_FOUND');
  await f.restart(); assert.deepEqual((await f.call('GET', `/api/intelligence/run?runId=${run.runId}`)).result, accepted.result);
});

test('geometry changes, cancellation and original grant revocation fence temporal acceptance', async t => {
  const { f, module, source } = await setup(t);
  module.runner.run = async request => { await f.call('POST', '/api/intelligence/geometry', { sourceId: source.sourceId, geometry: { version: 2, zones: [] } }, 'geometry-race'); return resultFor(request); };
  const stale = await f.call('POST', '/api/intelligence/runs', inputFor(source), 'stale'); await f.tick(); assert.equal((await f.call('GET', `/api/intelligence/run?runId=${stale.runId}`)).result, null);
  module.runner.run = async request => { await f.call('POST', '/api/intelligence/cancel', { runId: request.runId }, 'cancel'); return resultFor(request); };
  const cancelled = await f.call('POST', '/api/intelligence/runs', inputFor(source), 'cancelled'); await f.tick(); assert.equal((await f.call('GET', `/api/intelligence/run?runId=${cancelled.runId}`)).state, 'CANCELLED');
  module.runner.run = async request => resultFor(request);
  const revoked = await f.call('POST', '/api/intelligence/runs', inputFor(source), 'revoked');
  const job = module.queue.claim('manual', 30000, () => true);
  const prepared = await module.handlers[0].prepare(JSON.parse(job.payload), { tenantId: job.tenant, signal: new AbortController().signal, jobId: job.id, attempt: job.attempt, assertCurrent() { module.queue.assertCurrent(job); } });
  f.runtime.access.revoke('admin', 'tenant-a', 'veyviz.intelligence.write');
  assert.throws(() => module.queue.finish(job, prepared), e => e.code === 'DENIED');
  assert.equal((await f.call('GET', `/api/intelligence/run?runId=${revoked.runId}`)).result, null);
});

test('catalog withdrawal fences final acceptance and revokes issued playback', async t => {
  const { f, module, source, writeCatalog } = await setup(t);
  const playback = await f.call('POST', '/api/intelligence/playback', { sourceId: source.sourceId });
  const run = await f.call('POST', '/api/intelligence/runs', inputFor(source), 'withdrawn');
  const job = module.queue.claim('manual', 30000, () => true);
  const prepared = await module.handlers[0].prepare(JSON.parse(job.payload), { tenantId: job.tenant, signal: new AbortController().signal, jobId: job.id, attempt: job.attempt, assertCurrent() { module.queue.assertCurrent(job); } });
  await writeCatalog([]);
  assert.throws(() => module.queue.finish(job, prepared), e => e.code === 'CONFLICT');
  assert.equal((await f.call('GET', `/api/intelligence/run?runId=${run.runId}`)).result, null);
  assert.equal((await fetch(`http://127.0.0.1:${module.media.port}${playback.path}`)).status, 403);
});

test('media Range/HEAD, expiry, concurrency limit and close are enforced', async t => {
  const { recording, bytes } = await setup(t), gateway = new MediaGateway(); t.after(() => gateway.close());
  const grant = await gateway.issue(recording, () => {}, 50), base = `http://127.0.0.1:${gateway.port}`;
  const response = await fetch(base + grant.path, { headers: { Range: 'bytes=3-8' } }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 3-8/${bytes.length}`); assert.equal(await response.text(), bytes.subarray(3, 9).toString());
  const head = await fetch(base + grant.path, { method: 'HEAD', headers: { Range: 'bytes=-5' } }); assert.equal(head.status, 206); assert.equal(await head.text(), '');
  const invalid = await fetch(base + grant.path, { headers: { Range: 'bytes=100-200' } }); assert.equal(invalid.status, 416);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal((await fetch(base + grant.path)).status, 404);
  const issued = await Promise.allSettled(Array.from({ length: 10 }, () => gateway.issue(recording, () => {})));
  assert.equal(issued.filter(r => r.status === 'fulfilled').length, 8);
  await gateway.close(); await assert.rejects(gateway.issue(recording, () => {}), e => e.code === 'UNAVAILABLE');
});

test('owned same-origin facade preserves media delivery and denies foreign-origin mutation', async t => {
  const { f, module, source, bytes } = await setup(t), product = await f.server();
  await f.call('POST', '/api/intelligence/playback', { sourceId: source.sourceId });
  const facade = await createFacade({ productUrl: product.url, mediaPort: module.media.port }); f.registerCleanup(() => facade.close());
  const cookie = await login(facade.url);
  const issued = await api(facade.url, cookie, '/api/intelligence/playback', 'POST', { sourceId: source.sourceId }); assert.equal(issued.status, 200);
  const page = await fetch(facade.url); assert.ok(page.headers.get('content-security-policy').includes("default-src 'self'"));
  const media = await fetch(facade.url + issued.body.path, { headers: { Range: 'bytes=0-9' } }); assert.equal(media.status, 206); assert.equal(await media.text(), bytes.subarray(0, 10).toString());
  const denied = await fetch(facade.url + '/api/intelligence/sources', { method: 'POST', headers: { Origin: 'http://evil.invalid', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(denied.status, 403);
  f.runtime.access.revoke('admin', 'tenant-a', 'veyviz.intelligence.read'); assert.equal((await fetch(facade.url + issued.body.path)).status, 403);
});

test('temporal validator rejects fabricated timestamps, relationships, cleanup and polygons', () => {
  const request = { schema: 'veyviz.temporal-recording.request.v1', jobId: 'job', runId: 'run', commandId: 'command', scope: { productId: 'product', instanceId: 'local', tenantId: 'tenant-a', actorId: 'admin', actorKind: 'user' }, sourceId: 'source', sourceVersion: 1, recordingId: 'recording', sourceSha256: 'a'.repeat(64), pipelineSha256: RUNNER_SHA256, startMs: 0, endMs: 3000, sampleIntervalMs: 1000, geometry: { version: 1, zones: [] } };
  const good = resultFor(request); validateTemporalResult(good, request);
  for (const mutate of [v => v.appearances[0].firstMs = 1, v => v.events[0].appearanceId = 'other', v => v.events[0].positionMs = 1000, v => v.cleanup.sourceClosed = false, v => v.appearances[0].thumbnailJpegBase64 = 'bm90IGpwZWc=', v => v.request.scope.tenantId = 'other']) { const bad = structuredClone(good); mutate(bad); assert.throws(() => validateTemporalResult(bad, request)); }
  assert.throws(() => geometry({ version: 1, zones: [{ id: 'bad', points: [[0, 0], [1, 1], [0, .8], [1, 0]] }] }));
  assert.deepEqual(byteRange('bytes=4-', 10), [4, 9]); assert.deepEqual(byteRange('bytes=-20', 10), [0, 9]); assert.equal(byteRange('bytes=0-1,4-5', 10), null);
});

test('recording admission lock prevents concurrent catalog overwrite', async t => {
  const { f, recording } = await setup(t), directory = join(f.dir, 'admission');
  const outcomes = await Promise.allSettled(['first', 'second'].map(id => admitRecording({ file: recording.path, tenantId: 'tenant-a', id, name: id, directory })));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const stored = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')); assert.equal(stored.recordings.length, 1);
});

test('unconfirmed native closure still closes media and database and retains failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'veyviz-close-test-')); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const manifest = JSON.parse(await readFile(new URL('../modules/veyviz-intelligence/module.json', import.meta.url), 'utf8'));
  const store = new SqliteOwner(join(directory, 'owner.sqlite'), manifest.id);
  const runner = { async run() { throw Error('unused'); }, async close() { throw Error('native cleanup unknown'); } };
  const module = createIntelligence(manifest, store, { assert() {} }, runner);
  const bytes = Buffer.from('media-test'), recording = { id: 'recording', tenantId: 'tenant-a', name: 'test', path: join(directory, 'test.mp4'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, captureStartUtc: null, clockUncertaintyMs: null };
  await writeFile(recording.path, bytes); const grant = await module.media.issue(recording, () => {}); const port = module.media.port;
  await assert.rejects(module.close(), AggregateError);
  assert.throws(() => store.db.prepare('SELECT 1'));
  await assert.rejects(fetch(`http://127.0.0.1:${port}${grant.path}`));
  await assert.rejects(module.close(), AggregateError);
});
