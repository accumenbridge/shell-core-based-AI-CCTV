import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { workspace as recordingsWorkspace } from '../modules/veyviz-sources/dist/ui.js';
import { commandCenter, workspace as investigateWorkspace } from '../modules/veyviz-analysis/dist/ui.js';
import { healthWorkspace } from '../modules/veyviz-rfdetr/dist/ui.js';
import { workspace as intelligenceWorkspace } from '../modules/veyviz-intelligence/dist/ui.js';

class MountedElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = Object.create(null);
    this.style = Object.create(null);
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.checked = false;
    this.files = [];
    this._className = '';
    this.classList = {
      add: (...names) => this.setClasses([...this.classes(), ...names]),
      remove: (...names) => this.setClasses(this.classes().filter(name => !names.includes(name))),
      contains: name => this.classes().includes(name),
      toggle: (name, force) => {
        const has = this.classes().includes(name), next = force ?? !has;
        this.classList[next ? 'add' : 'remove'](name);
        return next;
      }
    };
  }
  classes() { return this._className.split(/\s+/).filter(Boolean); }
  setClasses(names) { this._className = [...new Set(names.filter(Boolean))].join(' '); }
  set className(value) { this._className = String(value); }
  get className() { return this._className; }
  append(...nodes) { for (const node of nodes) { if (!node) continue; node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { const listeners = this.listeners.get(name) ?? []; listeners.push(listener); this.listeners.set(name, listeners); }
  fire(name, event = {}) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {}, target: this, currentTarget: this, ...event }); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return (this._text ?? '') + this.children.map(child => child.textContent ?? '').join(''); }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classes().includes(selector.slice(1));
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    return this.tagName === selector.toLowerCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  insertBefore(node, before) { const index = this.children.indexOf(before); if (index < 0) this.append(node); else { node.parentNode = this; this.children.splice(index, 0, node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  focus() { globalThis.document.activeElement = this; }
  pause() {}
  load() {}
  getContext() { return { clearRect() {}, beginPath() {}, lineTo() {}, moveTo() {}, closePath() {}, fill() {}, stroke() {}, fillText() {}, drawImage() {} }; }
}

function walk(root) { return [root, ...root.children.flatMap(walk)]; }
const pause = () => new Promise(resolve => setImmediate(resolve));

function makeApi() {
  return {
    async get(path) {
      if (path.includes('/sources/query') || path.includes('/sources/query?')) return { items: [], page: { limit: 20, coverage: 'filtered-owner-query' } };
      if (path.startsWith('/api/analysis/query')) return { items: [], page: { limit: 20, coverage: 'filtered-owner-query' } };
      if (path === '/api/analysis/readiness') return { status: 'READY', profileId: 'local-profile', message: 'Ready' };
      if (path === '/api/ai/readiness') return { status: 'UNAVAILABLE', profileId: 'local-profile', fixtureId: 'mivia-vid0062', modelId: 'rfdetr-small-cpu-v1', message: 'Profile unavailable', versions: {} };
      if (path === '/api/intelligence/capabilities') return { advanced: false };
      if (path === '/api/intelligence/catalog') return { items: [] };
      if (path === '/api/intelligence/sources' || path === '/api/intelligence/runs') return { items: [], nextCursor: null };
      if (path === '/api/intelligence/batches' || path === '/api/intelligence/watches' || path === '/api/intelligence/alerts' || path === '/api/intelligence/rules') return { items: [] };
      throw new Error(`Unexpected UI fixture read: ${path}`);
    },
    async post(path) { throw new Error(`Unexpected UI fixture mutation: ${path}`); }
  };
}

test('Veyviz workspaces mount their public theme/layout boundaries and products declare ordered closed experiences', async t => {
  const previousDocument = globalThis.document;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  globalThis.document = { activeElement: null, body: new MountedElement('body'), createElement: tag => new MountedElement(tag) };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  const contexts = [];
  const mount = (workspace, permissions = ['veyviz.sources.read', 'veyviz.sources.write', 'veyviz.analysis.read', 'veyviz.analysis.write', 'veyviz.ai.read', 'veyviz.intelligence.read', 'veyviz.intelligence.write']) => {
    const root = new MountedElement('main'), scope = new AbortController();
    const cleanup = workspace.mount({ root, scope: { productId: 'veyviz-review', instanceId: 'ui-core-test', tenantId: 'tenant-a' }, signal: scope.signal,
      locale: 'en', permissions, notice() {}, api: makeApi() });
    contexts.push({ root, scope, cleanup });
    return root;
  };
  t.after(() => {
    for (const context of contexts) { context.cleanup?.(); context.scope.abort(); }
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
  });

  const recordings = mount(recordingsWorkspace);
  const investigate = mount(investigateWorkspace);
  const command = mount(commandCenter);
  const health = mount(healthWorkspace, ['veyviz.ai.read']);
  const intelligence = mount(intelligenceWorkspace);
  await pause(); await pause();

  const recordingPage = recordings.children[0];
  assert.equal(recordingPage.getAttribute('data-qb-ui-boundary'), '');
  assert.equal(recordingPage.getAttribute('data-qb-surface'), 'light');
  assert.equal(recordingPage.getAttribute('data-qb-layout-mode'), 'reading');
  assert.match(recordingPage.textContent, /Recordings/);

  assert.equal(investigate.getAttribute('data-qb-surface'), 'light');
  assert.equal(investigate.getAttribute('data-qb-accent'), 'teal');
  assert.equal(investigate.getAttribute('data-qb-layout-mode'), 'operational');
  assert.match(investigate.textContent, /Investigate/);
  assert.equal(command.getAttribute('data-qb-surface'), 'dark');
  assert.equal(command.getAttribute('data-qb-density'), 'compact');
  assert.match(command.textContent, /Command Center/);

  const healthPage = health.children[0];
  assert.equal(healthPage.getAttribute('data-qb-surface'), 'dark');
  assert.equal(healthPage.getAttribute('data-qb-layout-mode'), 'operational');
  assert.match(healthPage.textContent, /System Health/);
  const intelligencePage = intelligence.children[0];
  assert.equal(intelligencePage.getAttribute('data-qb-surface'), 'dark');
  assert.equal(intelligencePage.getAttribute('data-qb-layout-mode'), 'operational');
  assert.match(intelligencePage.textContent, /Recording intelligence/);
  assert.equal(walk(intelligencePage).find(node => node.tagName === 'video')?.getAttribute('aria-label'), 'Selected recording playback');

  const review = JSON.parse(await readFile(new URL('../products/veyviz-review/product.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../products/veyviz-catalog/product.json', import.meta.url), 'utf8'));
  assert.equal(review.version, '0.2.0');
  assert.equal(review.experience.schema, 'quadbridge.product-experience.v1');
  assert.equal(review.experience.navigation[0].workspaceId, 'veyviz.command', 'Command Center is the ordered default workspace');
  assert.deepEqual(review.experience.navigation.map(item => item.workspaceId), ['veyviz.command', 'veyviz.analysis', 'veyviz.sources', 'veyviz.health', 'veyviz.intelligence']);
  assert.deepEqual(review.experience.routes.map(item => item.workspaceId), review.experience.navigation.map(item => item.workspaceId));
  assert.equal(catalog.version, '0.2.0');
  assert.deepEqual(catalog.experience.navigation.map(item => item.workspaceId), ['veyviz.sources']);
});
