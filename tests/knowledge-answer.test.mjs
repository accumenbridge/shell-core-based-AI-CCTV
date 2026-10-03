import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteOwner } from '@quadbridge/sqlite';
import { ApplicationHost } from '@quadbridge/backend-host';
import { listen } from '@quadbridge/backend-host/http';
import { LocalAccess } from '@quadbridge/local-access';
import { createKnowledge } from '../modules/knowledge/dist/index.js';
import { fixture, admin } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate, label) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function context({ tenantId = 'tenant-a', signal = new AbortController().signal, isAllowed = () => true } = {}) {
  return { productId: 'combined', instanceId: 'answer-test-instance', tenantId, actor: admin, requestId: 'answer-test', signal,
    assertAllowed(permission, kind) {
      assert.equal(permission, 'knowledge.read');
      assert.equal(kind, 'read');
      if (!isAllowed()) { const error = new Error('read denied'); error.code = 'DENIED'; throw error; }
      if (signal.aborted) { const error = new Error('cancelled'); error.code = 'UNAVAILABLE'; throw error; }
    } };
}
async function privateKnowledge(t, answerProvider, modelAnswer) {
  const root = await mkdtemp(join(tmpdir(), 'q6-'));
  const owner = new SqliteOwner(join(root, 'knowledge.sqlite'), 'knowledge');
  const manifest = JSON.parse(await readFile(join(ROOT, 'modules/knowledge/module.json'), 'utf8'));
  const module = createKnowledge(manifest, owner, { answerProvider, modelAnswer });
  t.after(async () => { try { module.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const seed = (id, tenant, title, body) => {
    owner.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').run(id, tenant, title, body, 1, 'READY', `job-${id}`, 1);
    owner.db.prepare('INSERT INTO document_search(document_id,tenant,title,body) VALUES(?,?,?,?)').run(id, tenant, title, body);
  };
  const retrieval = module.services['knowledge.document.retrieve.v1'];
  return { module, owner, seed, retrieval };
}
const identity = Object.freeze({ adapter: 'ollama', model: 'qwen3:4b', label: 'Ollama · qwen3:4b' });
const capability = answer => Object.freeze({ contract: 'quadbridge.model-answer.v1', profile: 'local-ollama-qwen3-4b', identity, answer });

test('real Knowledge route answers only from indexed tenant records with exact UTF-16 citations', async t => {
  const app = await fixture(t, 'combined');
  const body = 'Intro 😀. Conveyor lockout requires the orange isolation switch before service. A separate note describes ordinary maintenance.';
  const created = await app.call('POST', '/api/documents', { title: 'Conveyor isolation', body }, 'answer-source');
  const tenantB = await app.call('POST', '/api/documents', { title: 'Hydraulic interlock', body: 'A hydraulic interlock uses a blue valve.' }, 'answer-tenant-b', admin, 'tenant-b');
  await app.tick();
  await app.tick();
  const answer = await app.call('POST', '/api/documents/answer', { question: 'How should conveyor be isolated?' }, 'answer-question');
  assert.equal(answer.label, 'Local extractive answer');
  assert.equal(answer.state, 'ANSWERED');
  assert.equal(answer.coverage, 'INDEXED_DOCUMENTS_ONLY');
  assert.match(answer.answer, /Conveyor lockout requires the orange isolation switch/);
  assert.equal(answer.citations.length, 1);
  const citation = answer.citations[0];
  assert.deepEqual({ productId: citation.productId, instanceId: citation.instanceId, tenantId: citation.tenantId, documentId: citation.documentId },
    { productId: 'combined', instanceId: app.config.instanceId, tenantId: 'tenant-a', documentId: created.id });
  assert.equal(citation.version, 1);
  assert.equal(citation.bodyDigest, digest(body));
  assert.equal(body.slice(citation.start, citation.end), citation.excerpt);
  assert.ok(citation.start > body.indexOf('😀'), 'offsets use JavaScript UTF-16 indices even with a preceding astral character');

  const none = await app.call('POST', '/api/documents/answer', { question: 'Where is the zebra equipment?' }, 'answer-empty');
  assert.deepEqual({ label: none.label, state: none.state, coverage: none.coverage, answer: none.answer, citations: none.citations },
    { label: 'Local extractive answer', state: 'NO_EVIDENCE', coverage: 'INDEXED_DOCUMENTS_ONLY', answer: '', citations: [] });
  const hidden = await app.call('POST', '/api/documents/answer', { question: 'hydraulic interlock' }, 'answer-hidden', admin, 'tenant-a');
  assert.equal(hidden.state, 'NO_EVIDENCE', 'a document indexed under tenant-b is not returned to tenant-a');
  const visible = await app.call('POST', '/api/documents/answer', { question: 'hydraulic interlock' }, 'answer-visible', admin, 'tenant-b');
  assert.equal(visible.citations[0].documentId, tenantB.id);
});

test('Knowledge captures an unpunctuated CRLF line after indexing with original Unicode UTF-16 offsets', async t => {
  const app = await fixture(t, 'combined');
  const body = 'Setup 😀. Conveyor isolation uses the orange switch\r\nA separate line describes routine belt inspection.';
  const created = await app.call('POST', '/api/documents', { title: 'Conveyor isolation', body }, 'answer-unpunctuated-line');
  await app.tick();
  await app.tick();
  const result = await app.call('POST', '/api/documents/answer', { question: 'conveyor isolation orange switch' }, 'answer-unpunctuated-question');
  assert.equal(result.state, 'ANSWERED');
  assert.equal(result.citations.length, 1);
  const citation = result.citations[0];
  assert.equal(citation.documentId, created.id);
  assert.equal(citation.excerpt, 'Conveyor isolation uses the orange switch');
  assert.equal(body.slice(citation.start, citation.end), citation.excerpt);
  assert.ok(citation.start > body.indexOf('😀'));
  assert.equal(citation.bodyDigest, digest(body));
});

test('Knowledge keeps document meaning inside its owner and rechecks the original read permission after provider await', async t => {
  const gate = deferred();
  let received;
  const f = await privateKnowledge(t, async (input, { signal }) => {
    received = input;
    assert.equal(signal.aborted, false);
    await gate.promise;
    return { evidenceIds: ['e0'] };
  });
  const body = 'A private unrelated sentence. Conveyor isolation uses a guarded orange switch.';
  f.seed('doc-a', 'tenant-a', 'Isolation procedure', body);
  f.seed('doc-b', 'tenant-b', 'Other tenant', 'Conveyor isolation uses another tenant private switch.');
  let allowed = true;
  const answer = f.retrieval.answer(context({ isAllowed: () => allowed }), 'How should conveyor isolation work?');
  await until(() => !!received, 'bounded provider input');
  assert.deepEqual(Object.keys(received).sort(), ['evidence', 'question']);
  assert.deepEqual(received.evidence.map(item => Object.keys(item).sort()), [['id', 'text']]);
  assert.equal(received.evidence.length, 1);
  assert.equal(received.evidence[0].text, 'Conveyor isolation uses a guarded orange switch.');
  assert.doesNotMatch(JSON.stringify(received), /private unrelated|Other tenant/);
  allowed = false;
  gate.resolve();
  await assert.rejects(answer, error => error.code === 'DENIED');

  let providerCalls = 0;
  const denied = await privateKnowledge(t, async () => { providerCalls++; return { evidenceIds: ['e0'] }; });
  denied.seed('doc-a', 'tenant-a', 'Private row', 'A matching conveyor isolation procedure exists.');
  await assert.rejects(denied.retrieval.answer(context({ isAllowed: () => false }), 'conveyor isolation'), error => error.code === 'DENIED');
  assert.equal(providerCalls, 0, 'denied reads never dispatch excerpts to the provider');
});

test('Knowledge rejects provider selections outside its captured excerpt set', async t => {
  const f = await privateKnowledge(t, async () => ({ evidenceIds: ['untrusted-document-id'] }));
  f.seed('doc-a', 'tenant-a', 'Isolation', 'Conveyor isolation requires a verified guarded switch.');
  await assert.rejects(f.retrieval.answer(context(), 'conveyor isolation'), error => error.code === 'INCOMPATIBLE');
});

test('Knowledge renders generated segments only with exact current owner citations', async t => {
  let received;
  const f = await privateKnowledge(t, undefined, capability(async input => {
    received = input;
    return { segments: [{ text: 'Stop the conveyor before maintenance.', evidenceIds: input.evidence.map(item => item.id) }] };
  }));
  const first = 'Conveyor maintenance requires the orange isolation switch.';
  const second = 'Stop the conveyor before the technician begins maintenance.';
  f.seed('doc-a', 'tenant-a', 'Isolation switch', first);
  f.seed('doc-b', 'tenant-a', 'Technician procedure', second);
  const result = await f.retrieval.answer(context(), 'conveyor maintenance stop technician isolation');
  assert.equal(result.label, 'Local model-generated answer');
  assert.equal(result.mode, 'generated');
  assert.equal(result.identity.label, identity.label);
  assert.equal(result.answer, 'Stop the conveyor before maintenance.');
  assert.equal(result.segments.length, 1);
  assert.equal(result.citations.length, 2);
  assert.deepEqual(new Set(result.citations.map(citation => citation.documentId)), new Set(['doc-a', 'doc-b']));
  assert.deepEqual(result.segments[0].citations, result.citations);
  for (const citation of result.citations) {
    const body = citation.documentId === 'doc-a' ? first : second;
    assert.equal(body.slice(citation.start, citation.end), citation.excerpt);
    assert.equal(citation.bodyDigest, digest(body));
  }
  assert.equal(received.evidence.length, 2);
  assert.deepEqual(received.evidence.map(item => Object.keys(item).sort()), [['id', 'text'], ['id', 'text']]);
});

test('Knowledge permits one captured excerpt to support multiple generated segments', async t => {
  const f = await privateKnowledge(t, undefined, capability(async () => ({ segments: [
    { text: 'First point from the source.', evidenceIds: ['e0'] },
    { text: 'A second point can reuse that source and add another.', evidenceIds: ['e0', 'e1'] }
  ] })));
  f.seed('doc-a', 'tenant-a', 'Isolation switch', 'Conveyor maintenance requires the orange isolation switch.');
  f.seed('doc-b', 'tenant-a', 'Technician procedure', 'Stop the conveyor before the technician begins maintenance.');
  const result = await f.retrieval.answer(context(), 'conveyor maintenance stop technician isolation');
  assert.deepEqual(result.segments.map(segment => segment.citations.map(citation => citation.documentId)), [
    [result.segments[1].citations[0].documentId],
    [result.segments[1].citations[0].documentId, result.segments[1].citations[1].documentId]
  ]);
  assert.notEqual(result.segments[1].citations[0].documentId, result.segments[1].citations[1].documentId);
  assert.equal(result.citations.length, 2, 'the answer-level source list contains each exact excerpt once');
  assert.deepEqual(result.citations, [result.segments[1].citations[0], result.segments[1].citations[1]]);
});

test('generated providers receive the same newline-bounded excerpts within per-item and total byte limits', async t => {
  let received;
  const f = await privateKnowledge(t, undefined, capability(async input => {
    received = input;
    return { segments: [{ text: 'The indexed procedure identifies the switch.', evidenceIds: ['e0'] }] };
  }));
  const bodies = new Map();
  for (let index = 0; index < 5; index++) {
    const id = `bounded-${index}`;
    const body = `Conveyor isolation uses the orange switch ${'x'.repeat(3650)}\r\nRoutine check follows.`;
    bodies.set(id, body);
    f.seed(id, 'tenant-a', `Procedure ${index}`, body);
  }
  const result = await f.retrieval.answer(context(), 'conveyor isolation orange switch');
  assert.equal(result.mode, 'generated');
  assert.ok(received.evidence.length < 5, 'the aggregate byte ceiling excludes an otherwise eligible final record');
  const totalBytes = received.evidence.reduce((total, item) => total + Buffer.byteLength(item.text, 'utf8'), 0);
  assert.ok(totalBytes <= 16 * 1024);
  for (const item of received.evidence) assert.ok(Buffer.byteLength(item.text, 'utf8') <= 4096);
  const citation = result.citations[0];
  assert.equal(bodies.get(citation.documentId).slice(citation.start, citation.end), citation.excerpt);
});

test('selected model with no indexed evidence returns honestly without dispatch', async t => {
  let calls = 0;
  const f = await privateKnowledge(t, undefined, capability(async () => { calls++; return { segments: [] }; }));
  const result = await f.retrieval.answer(context(), 'unmatched zebra procedure');
  assert.deepEqual({ label: result.label, mode: result.mode, state: result.state, answer: result.answer, citations: result.citations },
    { label: 'Local model answer not called', mode: 'generated', state: 'NO_EVIDENCE', answer: '', citations: [] });
  assert.equal(calls, 0);
});

test('Knowledge rejects unknown or repeated model evidence references', async t => {
  const f = await privateKnowledge(t, undefined, capability(async () => ({ segments: [{ text: 'A supported answer.', evidenceIds: ['e0', 'e99'] }] })));
  f.seed('doc-a', 'tenant-a', 'Isolation', 'Conveyor isolation requires a verified guarded switch.');
  await assert.rejects(f.retrieval.answer(context(), 'conveyor isolation'), error => error.code === 'INCOMPATIBLE');
  const repeated = await privateKnowledge(t, undefined, capability(async () => ({ segments: [{ text: 'A supported answer.', evidenceIds: ['e0', 'e0'] }] })));
  repeated.seed('doc-a', 'tenant-a', 'Isolation', 'Conveyor isolation requires a verified guarded switch.');
  await assert.rejects(repeated.retrieval.answer(context(), 'conveyor isolation'), error => error.code === 'INCOMPATIBLE');
});

test('selected model unavailability surfaces without extractive fallback', async t => {
  const f = await privateKnowledge(t, undefined, capability(async () => { const error = new Error('model unavailable'); error.code = 'UNAVAILABLE'; throw error; }));
  f.seed('doc-a', 'tenant-a', 'Isolation', 'Conveyor isolation requires a verified guarded switch.');
  await assert.rejects(f.retrieval.answer(context(), 'conveyor isolation'), error => error.code === 'UNAVAILABLE');
});

test('HTTP logout during an awaited Knowledge provider suppresses the original answer response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'q6-http-'));
  const owner = new SqliteOwner(join(root, 'knowledge.sqlite'), 'knowledge');
  const manifest = JSON.parse(await readFile(join(ROOT, 'modules/knowledge/module.json'), 'utf8'));
  const actor = { id: 'answer-user', kind: 'user' };
  const instanceId = 'knowledge-http-answer-test';
  const access = new LocalAccess(join(root, 'access.sqlite'), { productId: 'knowledge-http-test', instanceId });
  access.seed([{ id: actor.id, password: 'answer-test-password-12', grants: [{ tenantId: 'tenant-a', permissions: ['knowledge.read', 'platform.modules.manage'] }] }]);
  const providerGates = [deferred(), deferred()];
  const providerStarts = [deferred(), deferred()];
  const providerSignals = [];
  const cancellationObserved = deferred();
  let providerCall = 0;
  const module = createKnowledge(manifest, owner, { modelAnswer: capability(async (_input, { signal }) => {
    const index = providerCall++;
    providerSignals.push(signal);
    if (index === 0) signal.addEventListener('abort', () => cancellationObserved.resolve(), { once: true });
    providerStarts[index].resolve();
    await providerGates[index].promise;
    return { segments: [{ text: 'Generated answer from the authorized evidence.', evidenceIds: ['e0'] }] };
  }) });
  const body = 'A conveyor isolation procedure uses a guarded orange switch.';
  owner.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').run('http-doc', 'tenant-a', 'Isolation', body, 1, 'READY', 'job-http', 1);
  owner.db.prepare('INSERT INTO document_search(document_id,tenant,title,body) VALUES(?,?,?,?)').run('http-doc', 'tenant-a', 'Isolation', body);
  const plan = { product: { id: 'knowledge-http-test', version: '0.2.1', platformAbi: 'quadbridge.module.v1', title: 'Knowledge test', description: '', layout: 'top' },
    modules: [manifest], bindings: [], permissions: manifest.permissions, requiresWorker: false };
  const host = new ApplicationHost(plan, instanceId, [module], access);
  let http, answerRequest;
  t.after(async () => {
    for (const providerGate of providerGates) providerGate.resolve();
    if (answerRequest) await Promise.race([answerRequest.catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
    try { await http?.close(); } finally { try { await host.stop(); } finally { try { access.close(); } finally { await rm(root, { recursive: true, force: true }); } } }
  });
  await host.start();
  http = await listen({ host, access, port: 0, asset: () => undefined, index: () => '<!doctype html>' });
  const loginResponse = await fetch(`${http.url}/api/session`, { method: 'POST', headers: { Origin: http.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'answer-user', password: 'answer-test-password-12' }) });
  assert.equal(loginResponse.status, 200);
  const firstCookie = loginResponse.headers.get('set-cookie').split(';')[0];

  let modeAuthenticated = deferred();
  const realAuthenticate = access.authenticate.bind(access);
  access.authenticate = (session, bearer) => {
    const authenticated = realAuthenticate(session, bearer);
    modeAuthenticated.resolve();
    return authenticated;
  };
  let modeRequest;
  const modeResponse = new Promise((resolve, reject) => {
    modeRequest = httpRequest(`${http.url}/api/modules/mode`, {
      method: 'POST',
      headers: { Origin: http.url, Cookie: firstCookie, 'X-QB-Tenant': 'tenant-a', 'Content-Type': 'application/json' }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', part => text += part);
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    modeRequest.on('error', reject);
    modeRequest.write('{"moduleId":"knowledge",');
  });
  await Promise.race([modeAuthenticated.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Module mode request did not authenticate')), 2000))]);
  const firstLogout = await fetch(`${http.url}/api/logout`, { method: 'POST', headers: { Origin: http.url, Cookie: firstCookie } });
  assert.equal(firstLogout.status, 200);
  modeRequest.end('"mode":"off"}');
  const modeResult = await modeResponse;
  assert.equal(modeResult.status, 401, 'the original session is rechecked after awaiting the mode request body');
  assert.equal(access.mode('tenant-a', 'knowledge'), 'enabled', 'logout during body parsing cannot change module mode');

  const loginAgain = await fetch(`${http.url}/api/session`, { method: 'POST', headers: { Origin: http.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: actor.id, password: 'answer-test-password-12' }) });
  assert.equal(loginAgain.status, 200);
  const cookie = loginAgain.headers.get('set-cookie').split(';')[0];
  const cancelController = new AbortController();
  const cancelledRequest = fetch(`${http.url}/api/documents/answer`, { method: 'POST', signal: cancelController.signal, headers: { Origin: http.url, Cookie: cookie, 'X-QB-Tenant': 'tenant-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'conveyor isolation' }) })
    .then(response => ({ response }), error => ({ error }));
  await Promise.race([providerStarts[0].promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Provider dispatch did not start')), 2000))]);
  cancelController.abort();
  await Promise.race([cancellationObserved.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP disconnect did not abort the awaited provider')), 2000))]);
  const cancelled = await cancelledRequest;
  assert.equal(cancelled.error?.name, 'AbortError');
  providerGates[0].resolve();
  await new Promise(resolve => setTimeout(resolve, 0));

  answerRequest = fetch(`${http.url}/api/documents/answer`, { method: 'POST', headers: { Origin: http.url, Cookie: cookie, 'X-QB-Tenant': 'tenant-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'conveyor isolation' }) });
  await Promise.race([providerStarts[1].promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Second provider dispatch did not start')), 2000))]);
  const logout = await fetch(`${http.url}/api/logout`, { method: 'POST', headers: { Origin: http.url, Cookie: cookie } });
  assert.equal(logout.status, 200);
  providerGates[1].resolve();
  const answerResponse = await answerRequest;
  assert.equal(answerResponse.status, 401);
  const denied = await answerResponse.json();
  assert.equal(denied.error.code, 'UNAUTHENTICATED');
  assert.doesNotMatch(JSON.stringify(denied), /orange switch|A conveyor isolation/);
});
