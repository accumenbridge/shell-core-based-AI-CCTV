import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startProduct, ROOT } from './veyviz-start.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = resolve(option('--root') ?? ROOT);
const profilePath = resolve(option('--profile') ?? join(ROOT, '.local/veyviz-ai/profile.json'));
const runId = randomUUID();
const dataRoot = resolve(option('--data-root') ?? join(ROOT, '.local/e2e', runId));
const reportPath = join(dataRoot, 'e2e-result.json');
const report = { schema: 'veyviz.e2e-evidence.v1', runId, startedAt: new Date().toISOString(), checks: [], status: 'RUNNING' };
let app;
const pass = (name, facts = {}) => { report.checks.push({ name, status: 'PASS', ...facts }); console.log(`PASS ${name}`); };
async function login(who = 'admin') {
  const credentials = JSON.parse(await readFile(app.credentialsPath, 'utf8'));
  const response = await fetch(app.url + '/api/session', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: who, password: credentials[who] }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function api(cookie, path, { method = 'GET', body, tenant = 'alpha', key = randomUUID() } = {}) {
  const response = await fetch(app.url + path, { method, headers: { Cookie: cookie, Origin: app.url, 'X-QB-Tenant': tenant, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  return { status: response.status, body: await response.json() };
}
async function waitFor(cookie, id, terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const list = await api(cookie, '/api/analysis');
    assert.equal(list.status, 200);
    const row = list.body.items.find(item => item.id === id);
    if (row && terminal.includes(row.jobState)) return row;
    await delay(250);
  }
  throw Error('Real analysis did not reach its required state within 180 seconds.');
}
try {
  app = await startProduct({ root, dataRoot, profilePath, port: 0 });
  report.fingerprint = app.fingerprint;
  let cookie = await login();
  pass('actual authenticated HTTP runtime');
  const sourceBody = { name: 'MIVIA local review', fixtureId: 'mivia-vid0062' };
  const source = await api(cookie, '/api/sources', { method: 'POST', body: sourceBody, key: 'e2e-source' });
  assert.equal(source.status, 200);
  assert.ok(source.body.id);
  const duplicate = await api(cookie, '/api/sources', { method: 'POST', body: sourceBody, key: 'e2e-source' });
  assert.deepEqual(duplicate.body, source.body);
  assert.equal((await api(cookie, '/api/sources', { method: 'POST', body: { ...sourceBody, name: 'Conflicting command' }, key: 'e2e-source' })).status, 409);
  pass('durable source registration and idempotency conflict');
  const viewer = await login('viewer');
  assert.equal((await api(viewer, '/api/sources', { tenant: 'beta' })).status, 403);
  const input = { sourceId: source.body.id, frameCount: 3, sampleStride: 10 };
  assert.equal((await api(viewer, '/api/analysis', { method: 'POST', body: input })).status, 403);
  assert.equal((await api(cookie, '/api/analysis', { method: 'POST', body: { ...input, tenantId: 'beta' } })).status, 400);
  assert.equal((await api(cookie, '/api/analysis', { method: 'POST', body: input, tenant: 'beta' })).status, 404);
  pass('tenant, viewer write and forged-scope denials');
  const job = await api(cookie, '/api/analysis', { method: 'POST', body: input, key: 'e2e-analysis' });
  assert.equal(job.status, 200);
  assert.deepEqual((await api(cookie, '/api/analysis', { method: 'POST', body: input, key: 'e2e-analysis' })).body, job.body);
  const completed = await waitFor(cookie, job.body.id);
  assert.equal(completed.jobState, 'SUCCEEDED');
  const accepted = await api(cookie, `/api/analysis/result?analysisId=${encodeURIComponent(job.body.id)}`);
  assert.equal(accepted.status, 200);
  const result = accepted.body.result;
  assert.equal(result.request.commandId, 'e2e-analysis');
  assert.deepEqual(result.request.scope, { productId: 'veyviz-review', instanceId: 'veyviz-review-local', tenantId: 'alpha', actorId: 'admin', actorKind: 'user' });
  assert.equal(result.request.sourceId, source.body.id);
  assert.equal(result.samples.length, 3);
  assert.equal(result.decodedFrames, 21);
  assert.deepEqual(result.samples.map(s => s.frameIndex), [0, 10, 20]);
  assert.ok(result.samples.every(s => s.inferenceMs > 0 && s.thumbnailJpegBase64));
  assert.deepEqual(result.cleanup, { sourceClosed: true, inferenceClosed: true, retainedBytes: 0, outstandingLeases: 0 });
  assert.equal(result.occupancy, 'UNKNOWN');
  assert.equal(result.coverage, 'UNCOMMISSIONED_RECORDING');
  pass('actual three-frame RF-DETR result adopted with original identity and native cleanup', {
    analysisId: job.body.id, modelSha256: result.modelSha256, sourceSha256: result.sourceSha256,
    samples: result.samples.map(({ frameIndex, positionMs, inferenceMs, detections }) => ({ frameIndex, positionMs, inferenceMs, detections: detections.length }))
  });
  assert.equal((await api(cookie, `/api/analysis/result?analysisId=${job.body.id}`, { tenant: 'beta' })).status, 404);
  assert.equal((await api(cookie, '/api/analysis/review', { method: 'POST', body: { analysisId: job.body.id, decision: 'REVIEWED' } })).status, 200);
  pass('scoped saved-result access and human review');
  const firstFingerprint = app.fingerprint;
  const firstDigest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  assert.equal((await app.stop()).cleanup, true);
  app = await startProduct({ root, dataRoot, profilePath, port: 0 });
  assert.equal(app.fingerprint, firstFingerprint);
  cookie = await login();
  const reopened = await api(cookie, `/api/analysis/result?analysisId=${job.body.id}`);
  assert.equal(reopened.body.reviewState, 'REVIEWED');
  assert.equal(createHash('sha256').update(JSON.stringify(reopened.body.result)).digest('hex'), firstDigest);
  assert.deepEqual(JSON.parse(await readFile(app.configPath, 'utf8')).principals, []);
  pass('graceful restart retains exact accepted result and review without reseeding');
  const cancelJob = await api(cookie, '/api/analysis', { method: 'POST', body: { ...input, frameCount: 6, sampleStride: 30 }, key: 'e2e-cancel-analysis' });
  assert.equal(cancelJob.status, 200);
  await waitFor(cookie, cancelJob.body.id, ['RUNNING']);
  const cancelled = await api(cookie, '/api/analysis/cancel', { method: 'POST', body: { analysisId: cancelJob.body.id }, key: 'e2e-cancel' });
  assert.equal(cancelled.status, 200);
  assert.equal((await waitFor(cookie, cancelJob.body.id)).jobState, 'CANCELLED');
  assert.equal((await api(cookie, `/api/analysis/result?analysisId=${cancelJob.body.id}`)).body.result, null);
  pass('running-job cancellation cannot adopt a successful result');
  assert.equal((await app.stop()).cleanup, true); app = null;
  pass('owned runtime and worker observed closed');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.message;
  process.exitCode = 1; console.error(error);
} finally {
  if (app) {
    try { await app.stop(); }
    catch (error) { report.cleanupError = error.message; report.status = 'FAIL'; process.exitCode = 1; }
  }
  report.completedAt = new Date().toISOString();
  await mkdir(dataRoot, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${reportPath}`);
}
