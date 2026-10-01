import test from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from '../modules/knowledge/dist/ui.js';

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.listeners = new Map(); this.attributes = {}; this.value = ''; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { const list = this.listeners.get(name) ?? []; list.push(listener); this.listeners.set(name, list); }
  fire(name, event = {}) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {}, ...event }); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return (this._text ?? '') + this.children.map(child => child.textContent ?? '').join(''); }
}
function walk(root) { return [root, ...root.children.flatMap(walk)]; }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) { if (predicate()) return; await pause(); }
  assert.fail(`Timed out waiting for ${label}`);
}

test('Knowledge answer UI sends per-call cancellation and discards late answers after cancel or question edits', async t => {
  const previousDocument = globalThis.document, previousSetInterval = globalThis.setInterval, previousClearInterval = globalThis.clearInterval;
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  const gates = [], calls = [];
  const root = new Element('main'), scope = new AbortController();
  const cleanup = workspace.mount({ root, scope: { productId: 'combined', instanceId: 'ui-test', tenantId: 'tenant-a' }, signal: scope.signal,
    locale: 'en', permissions: ['knowledge.read'], notice() {},
    api: { async get() { return { items: [] }; }, post(path, body, _key, signal) { const gate = deferred(); gates.push(gate); calls.push({ path, body, signal }); return gate.promise; } } });
  t.after(() => {
    cleanup?.(); scope.abort();
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    globalThis.setInterval = previousSetInterval; globalThis.clearInterval = previousClearInterval;
  });
  await pause();
  const forms = walk(root).filter(node => node.tagName === 'form');
  assert.equal(forms.length, 2);
  const question = walk(root).find(node => node.tagName === 'textarea');
  const cancel = walk(root).find(node => node.tagName === 'button' && node.textContent === 'Cancel');
  const status = walk(root).find(node => node.attributes['aria-live'] === 'polite');
  assert.ok(question && cancel && status);
  const submit = () => forms[1].fire('submit');
  const late = { label: 'Local extractive answer', state: 'ANSWERED', coverage: 'INDEXED_DOCUMENTS_ONLY', answer: 'A late answer.', citations: [{ title: 'Source', version: 1, start: 0, end: 5, excerpt: 'secret' }] };

  question.value = 'Where is isolation control?';
  submit();
  await until(() => calls.length === 1, 'first answer request');
  assert.equal(calls[0].path, '/api/documents/answer');
  cancel.fire('click');
  assert.equal(calls[0].signal.aborted, true);
  gates[0].resolve(late);
  await pause(); await pause();
  assert.match(status.textContent, /Answer cancelled/);
  assert.doesNotMatch(status.textContent, /A late answer|secret/);

  submit();
  await until(() => calls.length === 2, 'answer request before question edit');
  question.value = 'A different question';
  question.fire('input');
  assert.equal(calls[1].signal.aborted, true);
  gates[1].resolve(late);
  await pause(); await pause();
  assert.match(status.textContent, /Question changed/);
  assert.doesNotMatch(status.textContent, /A late answer|secret/);
});
