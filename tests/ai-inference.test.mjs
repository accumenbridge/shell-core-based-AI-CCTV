import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaQwen3Provider, OLLAMA_QWEN3_IDENTITY } from '../packages/ai-core/dist/ollama.js';

const input = Object.freeze({ question: 'How should conveyor and service access be coordinated?', evidence: Object.freeze([
  Object.freeze({ id: 'e0', text: 'Stop the conveyor before service.' }),
  Object.freeze({ id: 'e1', text: 'Use the guarded orange isolation switch.' })
]) });
const envelope = content => new Response(JSON.stringify({ model: 'qwen3:4b', done: true, message: { role: 'assistant', content: JSON.stringify(content) } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });

test('fixed Ollama adapter sends bounded cited-answer protocol to the selected loopback model', async () => {
  let call;
  const provider = createOllamaQwen3Provider(async (url, options) => {
    call = { url, options };
    return envelope({ segments: [{ text: 'Stop the conveyor before service.', evidenceIds: ['e0'] },
      { text: 'Use the guarded isolation switch.', evidenceIds: ['e1'] }] });
  });
  const result = await provider(input, { signal: new AbortController().signal });
  assert.deepEqual(OLLAMA_QWEN3_IDENTITY, { adapter: 'ollama', model: 'qwen3:4b', label: 'Ollama · qwen3:4b' });
  assert.equal(call.url, 'http://127.0.0.1:21434/api/chat');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.redirect, 'error');
  const body = JSON.parse(call.options.body);
  assert.equal(body.model, 'qwen3:4b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(Object.hasOwn(body, 'tools'), false);
  assert.deepEqual(body.format.properties.segments.items.properties.evidenceIds.items.enum, ['e0', 'e1']);
  assert.equal(body.options.num_predict, 512);
  assert.deepEqual(result, { segments: [{ text: 'Stop the conveyor before service.', evidenceIds: ['e0'] },
    { text: 'Use the guarded isolation switch.', evidenceIds: ['e1'] }] });
});

test('fixed adapter rejects ungrounded, malformed and oversized output without fallback', async () => {
  const unknown = createOllamaQwen3Provider(async () => envelope({ segments: [{ text: 'Not in the supplied sources.', evidenceIds: ['external-id'] }] }));
  await assert.rejects(unknown(input, { signal: new AbortController().signal }), error => error.code === 'INCOMPATIBLE');
  const malformed = createOllamaQwen3Provider(async () => envelope({ segments: [{ text: 'No citation.' }] }));
  await assert.rejects(malformed(input, { signal: new AbortController().signal }), error => error.code === 'INCOMPATIBLE');
  const oversized = createOllamaQwen3Provider(async () => new Response('x'.repeat(12 * 1024 + 1), { status: 200 }));
  await assert.rejects(oversized(input, { signal: new AbortController().signal }), /fixed byte bound/);
  const unavailable = createOllamaQwen3Provider(async () => new Response('{}', { status: 503 }));
  await assert.rejects(unavailable(input, { signal: new AbortController().signal }), error => error.code === 'UNAVAILABLE');
});

test('fixed adapter passes actual cancellation signal and does not accept empty evidence', async () => {
  let observedSignal, calls = 0;
  const provider = createOllamaQwen3Provider((_url, options) => {
    calls++;
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const controller = new AbortController();
  const pending = provider(input, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'UNAVAILABLE');
  assert.equal(observedSignal.aborted, true);
  await assert.rejects(provider({ question: 'question', evidence: [] }, { signal: new AbortController().signal }), error => error.code === 'INVALID');
  assert.equal(calls, 1);
});
