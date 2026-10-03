import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductExperience } from '../packages/contracts/dist/index.js';
import { createWorkspaceNavigation, parseWorkspaceRoute } from '../packages/web-shell/dist/navigation.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { boot, flush, harness, json } from './support/shell-harness.mjs';

const experience = () => ({
  schema: 'quadbridge.product-experience.v1',
  designSystem: { id: 'quadbridge.standard', version: '0.1.0' },
  browserProfile: 'quadbridge.browser-profile.native-esm.v1',
  brand: { name: 'Requests' },
  theme: { surface: 'light', text: 'standard', accent: 'blue', status: 'semantic', density: 'comfortable' },
  login: { title: 'Requests', description: 'Work on requests', help: 'Ask your administrator.' },
  navigation: [
    { id: 'requests', workspaceId: 'requests', label: 'Requests', order: 0, mobilePriority: 0 },
    { id: 'knowledge', workspaceId: 'knowledge', label: 'Knowledge', order: 1, mobilePriority: 1 }
  ],
  routes: [
    { id: 'requests', workspaceId: 'requests', kind: 'workspace' },
    { id: 'requests.record', workspaceId: 'requests', kind: 'record' },
    { id: 'requests.create', workspaceId: 'requests', kind: 'create' },
    { id: 'requests.edit', workspaceId: 'requests', kind: 'edit' },
    { id: 'knowledge', workspaceId: 'knowledge', kind: 'workspace' }
  ],
  layoutByWorkspace: [{ workspaceId: 'requests', mode: 'operational' }]
});
const workspaces = [
  { id: 'requests', path: '/requests' },
  { id: 'knowledge', path: '/knowledge' }
];

test('product experience validation is closed, normalized and source-bound', () => {
  const input = experience();
  const normalized = validateProductExperience(input, { workspaceIds: ['requests', 'knowledge'] });
  assert.notEqual(normalized, input);
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.theme));
  for (const invalid of [
    { ...experience(), theme: { ...experience().theme, surface: ['dark'] } },
    { ...experience(), brand: { name: 'Requests', logoAssetId: 'service-desk:ui/overview.css' } },
    { ...experience(), routes: [{ ...experience().routes[1], resourceType: 'request' }, ...experience().routes.slice(0, 1), ...experience().routes.slice(2)] },
    { ...experience(), navigation: [{ ...experience().navigation[0], workspaceId: 'unselected' }, experience().navigation[1]] }
  ]) assert.throws(() => validateProductExperience(invalid, { workspaceIds: ['requests', 'knowledge'] }));
});

test('control-plane immutable product storage retains normalized experience without changing legacy shape', () => {
  const store = new ControlPlaneStore(':memory:');
  try {
    const definition = { id: 'experience-product', version: '1.0.0', platformAbi: 'quadbridge.module.v1', title: 'Experience', description: '', layout: 'sidebar', modules: [], bindings: [], experience: experience() };
    const written = store.putProduct(definition, 'system:test-suite');
    assert.equal(written.experience.brand.name, 'Requests');
    assert.deepEqual(store.product('experience-product', '1.0.0').experience, written.experience);
    assert.equal(store.putProduct(definition, 'system:test-suite').experience.theme.surface, 'light');
    const legacy = { id: 'legacy-product', version: '1.0.0', platformAbi: 'quadbridge.module.v1', title: 'Legacy', description: '', layout: 'sidebar', modules: [], bindings: [] };
    store.putProduct(legacy, 'system:test-suite');
    assert.equal(Object.hasOwn(store.product('legacy-product'), 'experience'), false);
  } finally { store.close(); }
});

test('fixed child route parser round-trips bounded opaque pages and Unicode search', () => {
  const exp = validateProductExperience(experience(), { workspaceIds: ['requests', 'knowledge'] });
  const hash = '#/requests/_route/requests.record/R-17?q=' + encodeURIComponent('café / rôle') + '&page=YXJyYXlfY3Vyc29y';
  assert.deepEqual(parseWorkspaceRoute(hash, workspaces, exp), {
    routeId: 'requests.record', workspaceId: 'requests', kind: 'record', params: { id: 'R-17' },
    query: { q: 'café / rôle', page: 'YXJyYXlfY3Vyc29y' }
  });
  assert.equal(parseWorkspaceRoute('#/requests/_route/requests.create/extra', workspaces, exp), undefined);
  assert.equal(parseWorkspaceRoute('#/knowledge/_route/requests.record/R-17', workspaces, exp), undefined);
  assert.equal(parseWorkspaceRoute('#/unavailable', workspaces, exp), undefined);
});

test('same-workspace route changes preserve the provider lifetime and explicit draft guard', () => harness(async (_env, start) => {
  const snapshot = boot();
  const exp = {
    schema: 'quadbridge.product-experience.v1', designSystem: { id: 'quadbridge.standard', version: '0.1.0' },
    browserProfile: 'quadbridge.browser-profile.native-esm.v1', brand: { name: 'Example' },
    theme: { surface: 'light', text: 'standard', accent: 'blue', status: 'semantic', density: 'comfortable' },
    login: { title: 'Example', description: 'Work', help: 'Ask support.' },
    navigation: [{ id: 'example.main', workspaceId: 'example.main', label: 'Records', order: 0, mobilePriority: 0 }],
    routes: [
      { id: 'example.main', workspaceId: 'example.main', kind: 'workspace' },
      { id: 'example.record', workspaceId: 'example.main', kind: 'record' },
      { id: 'example.create', workspaceId: 'example.main', kind: 'create' }
    ], layoutByWorkspace: []
  };
  snapshot.product.experience = exp;
  globalThis.fetch = async () => json(snapshot);
  const contexts = [], disposed = [];
  start({ experience: exp, loaders: { example: async () => ({ workspace: { mount(ctx) { contexts.push(ctx); return () => disposed.push(ctx); } } }) } });
  await flush();
  const first = contexts[0];
  assert.ok(first);
  assert.equal(await first.navigation.navigate('example.record', { params: { id: 'REQ-17' } }), true);
  assert.equal(first.route.kind, 'record');
  assert.equal(first.route.params.id, 'REQ-17');
  assert.equal(contexts.length, 1);
  assert.equal(disposed.length, 0);
  const unregister = first.navigation.registerUnsavedGuard(() => false);
  assert.equal(await first.navigation.navigate('example.create'), false);
  assert.equal(first.route.kind, 'record');
  assert.equal(contexts.length, 1);
  unregister();
  assert.equal(await first.navigation.navigate('example.create'), true);
  assert.equal(first.route.kind, 'create');
  assert.equal(contexts.length, 1);
}));

test('router owns hash traversal once, awaits mounts and preserves history on rejected Back', async () => {
  const original = new Map(['window', 'location', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const handlers = new Map(), entries = [{ url: '/#/requests', state: null }];
  let index = 0, scrollX = 13, scrollY = 47, focused = '';
  const location = { pathname: '/', search: '', get hash() { return entries[index].url.split('#')[1] ? `#${entries[index].url.split('#')[1]}` : ''; } };
  const setUrl = url => { entries[index] = { ...entries[index], url }; };
  const updateLocation = url => { location.pathname = url.split('#')[0] || '/'; setUrl(url); };
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) { entries.splice(index + 1); entries.push({ state, url }); index++; updateLocation(url); },
    replaceState(state, _title, url) { entries[index] = { state, url }; updateLocation(url); },
    go(delta) { index = Math.max(0, Math.min(entries.length - 1, index + delta)); const callbacks = handlers.get('hashchange') ?? []; for (const callback of callbacks) callback(); }
  };
  const window = {
    location, history, get scrollX() { return scrollX; }, get scrollY() { return scrollY; },
    scrollTo(x, y) { scrollX = x; scrollY = y; },
    addEventListener(type, listener) { const list = handlers.get(type) ?? []; list.push(listener); handlers.set(type, list); },
    removeEventListener(type, listener) { handlers.set(type, (handlers.get(type) ?? []).filter(item => item !== listener)); },
    emit(type) { for (const listener of handlers.get(type) ?? []) listener(); }
  };
  const document = { activeElement: { id: 'request-search' }, getElementById(id) { return { focus() { focused = id; } }; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let mounts = 0;
  const exp = validateProductExperience(experience(), { workspaceIds: ['requests', 'knowledge'] });
  let holdReturn = false, releaseReturn;
  const returnMount = new Promise(resolve => { releaseReturn = resolve; });
  const controller = createWorkspaceNavigation({
    workspaces, experience: exp,
    async onRoute(route) { mounts++; if (holdReturn && route.kind === 'workspace') await returnMount; },
    onInvalidRoute() { assert.fail('unexpected invalid route'); }
  });
  try {
    assert.deepEqual([...handlers.keys()], ['hashchange'], 'the shell handles the hash route once, even when browsers also emit popstate');
    assert.equal(await controller.port.navigate('requests.create'), true);
    assert.equal(mounts, 1);
    assert.equal(entries.length, 2);
    scrollX = 31; scrollY = 63;
    assert.equal(await controller.port.navigate('requests.edit', { params: { id: 'R-17' } }), true);
    assert.equal(mounts, 2);
    assert.equal(entries.length, 3);
    scrollX = 0; scrollY = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let guardCalls = 0;
    const unregister = controller.port.registerUnsavedGuard(async () => { guardCalls++; return gate; });
    history.go(-2);
    window.emit('popstate');
    window.emit('hashchange');
    assert.equal(guardCalls, 1, 'the paired popstate/hashchange notification does not ask twice');
    release(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.port.current().kind, 'edit');
    assert.equal(index, 2, 'rejecting a multi-entry Back returns to its exact original entry without overwriting history');
    assert.equal(entries.length, 3);
    unregister();
    holdReturn = true;
    history.go(-2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.port.current().kind, 'workspace');
    assert.equal(index, 0);
    assert.equal(mounts, 3);
    assert.equal(scrollX, 0, 'focus and scroll restoration waits for the asynchronous route mount');
    assert.equal(focused, '');
    releaseReturn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scrollX, 13);
    assert.equal(scrollY, 47);
    assert.equal(focused, 'request-search');
    holdReturn = false;
    history.go(2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.port.current().kind, 'edit', 'Forward to the last accepted route remains a live transition');
    assert.equal(index, 2);
    assert.equal(mounts, 4);
    window.emit('popstate');
    assert.equal(mounts, 4, 'popstate is not a second owner of hash-route transitions');
  } finally {
    controller.dispose();
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});
