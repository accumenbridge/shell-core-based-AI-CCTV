import test from 'node:test';
import assert from 'node:assert/strict';
import { startPackagedMobileShell } from '../packages/mobile-shell/dist/index.js';
import { boot, flush, harness, json } from './support/shell-harness.mjs';
import { startMobileShell } from '../packages/mobile-shell/dist/index.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const mobile = (options) => startMobileShell(options);

test('mobile shell derives tenant, account and workspace navigation from the accepted bootstrap', () => harness(async (env, start) => {
  const snapshot = boot();
  snapshot.workspaces = [
    ...snapshot.workspaces,
    { ...snapshot.workspaces[0], id: 'example.queue', label: 'Queue', path: '/queue' },
    { ...snapshot.workspaces[0], id: 'example.reports', label: 'Reports', path: '/reports' },
    { ...snapshot.workspaces[0], id: 'example.settings', label: 'Settings', path: '/settings' }
  ];
  globalThis.fetch = async () => json(snapshot);
  const mounted = [];
  start({ loaders: { example: async () => ({ workspace: { mount(ctx) { mounted.push(ctx.scope.tenantId); } } }) } });
  await flush();
  assert.ok(env.all().some(n => n.className === 'mobile-shell'));
  assert.ok(env.all().some(n => n.className === 'mobile-bottom-nav'));
  assert.ok(env.all().find(n => n.tag === 'select')?.children.some(option => option.textContent === 'tenant-a' && option.selected));
  assert.equal(mounted[0], 'tenant-a');

  const account = env.all().find(n => n.textContent === 'Account');
  account.emit('click');
  assert.equal(account.getAttribute('aria-expanded'), 'true');
  assert.ok(env.all().some(n => n.textContent === 'admin'));

  const more = env.all().find(n => n.textContent === 'More');
  more.emit('click');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  const settings = env.all().find(n => n.getAttribute('data-workspace-path') === '/settings');
  assert.ok(settings);
  env.loc.hash = '#/settings';
  settings.emit('click');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  env.win.emit('hashchange');
  await flush();
  assert.equal(mounted.length, 2);
  assert.equal(settings.getAttribute('aria-current'), 'page');
} , mobile));

test('initially hidden mobile page stays suspended until visibility resumes', () => harness(async (env, start) => {
  env.doc.visibilityState = 'hidden';
  let requests = 0, mounts = 0;
  globalThis.fetch = async path => { requests++; assert.equal(path, '/api/bootstrap'); return json(boot()); };
  start({ loaders: { example: async () => ({ workspace: { mount() { mounts++; } } }) } });
  await flush();
  assert.equal(requests, 0);
  assert.equal(mounts, 0);
  assert.match(env.root.textContent, /Workspace paused/);
  env.doc.visibilityState = 'visible';
  env.doc.emit('visibilitychange');
  await flush();
  assert.equal(requests, 1);
  assert.equal(mounts, 1);
}, mobile));

test('logout remains fenced across suspend/resume and renders login only after a visible settle', () => harness(async (env, start) => {
  const logout = deferred(), calls = [], mounted = [];
  globalThis.fetch = async (path, options = {}) => {
    calls.push(path);
    if (path === '/api/logout') return logout.promise;
    assert.equal(path, '/api/bootstrap');
    return json(boot());
  };
  start({ loaders: { example: async () => ({ workspace: { mount(ctx) { mounted.push(ctx); } } }) } });
  await flush();
  const signOut = env.all().find(n => n.textContent === 'Sign out');
  signOut.emit('click');
  await flush();
  assert.equal(mounted[0].signal.aborted, true);
  assert.equal(calls.filter(path => path === '/api/bootstrap').length, 1);

  env.doc.visibilityState = 'hidden';
  env.doc.emit('visibilitychange');
  env.doc.visibilityState = 'visible';
  env.doc.emit('visibilitychange');
  await flush();
  assert.equal(calls.filter(path => path === '/api/bootstrap').length, 1);
  assert.equal(mounted.length, 1);

  env.doc.visibilityState = 'hidden';
  env.doc.emit('visibilitychange');
  logout.resolve(json({ ok: true }));
  await flush();
  assert.doesNotMatch(env.root.textContent, /Sign in/);
  assert.equal(calls.filter(path => path === '/api/bootstrap').length, 1);
  env.doc.visibilityState = 'visible';
  env.doc.emit('visibilitychange');
  await flush();
  assert.match(env.root.textContent, /Sign in/);
  assert.equal(calls.filter(path => path === '/api/bootstrap').length, 1);
  assert.equal(mounted.length, 1);
}, mobile));

test('packaged mobile shell shows deferred connection state without auth or API requests', () => harness(async (env, start) => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  start({ title: 'Selected Product' });
  await flush();
  assert.match(env.root.textContent, /CONNECTION NOT CONFIGURED/);
  assert.equal(requests, 0);
}, options => startPackagedMobileShell(options)));
