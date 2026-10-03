import test from 'node:test';
import assert from 'node:assert/strict';
import { startPackagedMobileShell } from '../packages/mobile-shell/dist/index.js';
import { boot, flush, harness, json } from './support/shell-harness.mjs';
import { startMobileShell } from '../packages/mobile-shell/dist/index.js';
import { createNativeRequestTransport, validateNativeBootstrapIdentity } from '../packages/mobile-shell/dist/native.js';
import { resolveUiContributionBindings } from '../packages/contracts/dist/ui-contributions.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const mobile = (options) => startMobileShell(options);

function mobileContributionFixture() {
  const descriptors = [
    { id:'example.asideTools', permission:'example.read', export:'asideTools', label:'Aside tools' },
    { id:'example.footerTools', permission:'example.write', export:'footerTools', label:'Footer tools' }
  ];
  const moduleManifest = { id:'example', permissions:['example.read','example.write'],
    workspaces:[{id:'example.main'},{id:'example.settings'}], uiContributions:descriptors };
  const mapping = { schema:'quadbridge.ui-slots.v1', bindings:[
    {workspaceId:'example.main',slot:'workspace.aside',contributionId:'example.asideTools'},
    {workspaceId:'example.main',slot:'workspace.footer',contributionId:'example.footerTools'}
  ] };
  const resolved = resolveUiContributionBindings({modules:[moduleManifest]},mapping,[moduleManifest]);
  return { descriptors:descriptors.map(item=>({...item,moduleId:'example'})), bindings:resolved.bindings };
}

test('F10: compiled mobile presentation mounts resolved aside/footer and disposes once across navigation and permission refresh', () => harness(async (env, start) => {
  const snapshot=boot(),{descriptors,bindings}=mobileContributionFixture(),mounted=[],disposed=[],bootstrapTenants=[];
  snapshot.workspaces.push({id:'example.settings',label:'Settings',path:'/settings',moduleId:'example',export:'workspace'});
  snapshot.uiContributions=descriptors;
  const permissionsByTenant={ 'tenant-a':['example.read','example.write'], 'tenant-b':['example.write'] };
  globalThis.fetch=async(path,options={})=>{
    if(path==='/api/bootstrap'){
      const tenant=new Headers(options.headers).get('X-QB-Tenant')??'tenant-a';bootstrapTenants.push(tenant);
      return json({...snapshot,scope:{...snapshot.scope,tenantId:tenant},permissions:permissionsByTenant[tenant]??[]});
    }
    return json({});
  };
  const contribution=(id,tag)=>({mount(ctx){mounted.push({id,tenant:ctx.scope.tenantId,permissions:[...ctx.permissions],signal:ctx.signal});ctx.root.append(document.createElement(tag));
    return ()=>disposed.push(`${id}:${ctx.scope.tenantId}`);}});
  start({uiBindings:bindings,loaders:{example:async()=>({workspace:{mount(){}},asideTools:contribution('aside','aside-widget'),footerTools:contribution('footer','footer-widget')})}});
  await flush();
  assert.deepEqual(bindings.map(binding=>binding.slot),['workspace.aside','workspace.footer']);
  assert.deepEqual(mounted.map(item=>[item.id,item.tenant,item.permissions]),[['aside','tenant-a',['example.read']],['footer','tenant-a',['example.write']]]);
  const asideSlot=()=>env.all().find(node=>node.className.includes('mobile-contribution-aside'));
  const footerSlot=()=>env.all().find(node=>node.className.includes('mobile-contribution-footer'));
  assert.equal(asideSlot().hidden,false);
  assert.equal(footerSlot().hidden,false);
  assert.ok(env.all().some(node=>node.tag==='aside-widget'));
  assert.ok(env.all().some(node=>node.tag==='footer-widget'));

  env.loc.hash='#/settings';env.all().find(node=>node.getAttribute('data-workspace-path')==='/settings').emit('click');env.win.emit('hashchange');await flush();
  assert.deepEqual([...disposed].sort(),['aside:tenant-a','footer:tenant-a'].sort(),'leaving the bound workspace disposes each mounted contribution once');
  env.loc.hash='#/records';env.win.emit('hashchange');await flush();
  assert.equal(mounted.length,4,'returning to the bound workspace remounts its two authorized contributions');
  const tenant=env.all().find(node=>node.tag==='select');tenant.value='tenant-b';tenant.emit('change');await flush();
  assert.deepEqual(bootstrapTenants,['tenant-a','tenant-b']);
  assert.deepEqual([...disposed].sort(),['aside:tenant-a','footer:tenant-a','aside:tenant-a','footer:tenant-a'].sort(),'permission refresh disposes the prior scope exactly once');
  assert.deepEqual(mounted.slice(4).map(item=>[item.id,item.tenant]),[['footer','tenant-b']], 'the refreshed permission set excludes Aside and retains Footer');
  assert.equal(asideSlot().hidden,true);
  assert.equal(footerSlot().hidden,false);
  assert.equal(env.all().some(node=>node.tag==='aside-widget'),false);
  assert.equal(env.all().some(node=>node.tag==='footer-widget'),true);
},mobile));

test('F10: mobile preview never mounts a contribution denied by the initial permission set', () => harness(async (env,start)=>{
  const snapshot=boot(),{descriptors,bindings}=mobileContributionFixture(),mounted=[];
  snapshot.uiContributions=descriptors;
  globalThis.fetch=async path=>path==='/api/bootstrap'?json({...snapshot,permissions:['example.write']}):json({});
  const contribution=id=>({mount(){mounted.push(id);return ()=>{};}});
  start({uiBindings:bindings,loaders:{example:async()=>({workspace:{mount(){}},asideTools:contribution('aside'),footerTools:contribution('footer')})}});
  await flush();
  assert.deepEqual(mounted,['footer']);
  const aside=env.all().find(node=>node.className.includes('mobile-contribution-aside'));
  const footer=env.all().find(node=>node.className.includes('mobile-contribution-footer'));
  assert.equal(aside.hidden,true);
  assert.equal(aside.children.length,0);
  assert.equal(footer.hidden,false);
},mobile));

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

test('mobile experience priority chooses primary workspaces after source navigation ordering', () => harness(async (env, start) => {
  const snapshot = boot();
  snapshot.workspaces = [
    ...snapshot.workspaces,
    { ...snapshot.workspaces[0], id: 'example.knowledge', label: 'Knowledge', path: '/knowledge' },
    { ...snapshot.workspaces[0], id: 'example.settings', label: 'Settings', path: '/settings' }
  ];
  const experience = {
    schema: 'quadbridge.product-experience.v1', designSystem: { id: 'quadbridge.standard', version: '0.1.0' },
    browserProfile: 'quadbridge.browser-profile.native-esm.v1', brand: { name: 'Example Desk' },
    theme: { surface: 'dark', text: 'standard', accent: 'teal', status: 'semantic', density: 'compact' },
    login: { title: 'Example Desk', description: 'Work', help: 'Contact support.' },
    navigation: [
      { id: 'example.main', workspaceId: 'example.main', label: 'Requests', order: 1, mobilePriority: 2 },
      { id: 'example.knowledge', workspaceId: 'example.knowledge', label: 'Knowledge', order: 0, mobilePriority: 0 },
      { id: 'example.settings', workspaceId: 'example.settings', label: 'Settings', order: 2, mobilePriority: 1 }
    ],
    routes: [
      { id: 'example.main', workspaceId: 'example.main', kind: 'workspace' },
      { id: 'example.knowledge', workspaceId: 'example.knowledge', kind: 'workspace' },
      { id: 'example.settings', workspaceId: 'example.settings', kind: 'workspace' }
    ], layoutByWorkspace: []
  };
  snapshot.product.experience = experience;
  globalThis.fetch = async () => json(snapshot);
  start({ experience, loaders: { example: async () => ({ workspace: { mount() {} } }) } });
  await flush();
  const links = env.all().filter(node => node.tag === 'a' && node.getAttribute('data-workspace-path'));
  assert.deepEqual(links.slice(0, 3).map(node => node.textContent), ['Knowledge', 'Settings', 'Requests']);
  assert.equal(env.root.getAttribute('data-qb-surface'), 'dark');
  assert.equal(env.all().find(node => node.className === 'mobile-title').textContent.includes('Example Desk'), true);
}, mobile));

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

test('unchanged mobile resume preserves the mounted workspace and its local draft', () => harness(async (env, start) => {
  let requests = 0;
  let holdCommand = true;
  const refresh = deferred(), admittedCommand = deferred(), mounted = [], apiCalls = [];
  globalThis.fetch = async path => {
    if (path === '/api/bootstrap') return ++requests === 2 ? refresh.promise : json(boot());
    apiCalls.push(path);
    if (path === '/api/records' && holdCommand) return admittedCommand.promise;
    return json({ accepted: true });
  };
  start({ loaders: { example: async () => ({ workspace: { mount(ctx) { mounted.push(ctx); ctx.root.append(document.createElement('draft-state')); } } }) } });
  await flush();
  assert.equal(mounted.length, 1);
  const context = mounted[0];
  const alreadyAdmitted = context.api.post('/api/records', { title: 'original command' }, 'original-command-key');
  await flush();
  assert.deepEqual(apiCalls, ['/api/records']);
  env.doc.visibilityState = 'hidden';
  env.doc.emit('visibilitychange');
  assert.equal(env.root.hidden, true);
  assert.equal(context.signal.aborted, false);
  assert.equal(context.route, undefined);
  env.loc.hash = '#/other';
  env.win.emit('hashchange');
  assert.equal(env.loc.hash, '#/records', 'a browser history transition is restored while the mount awaits session revalidation');
  await assert.rejects(context.api.get('/api/records'), error => error.name === 'AbortError');
  await assert.rejects(context.api.post('/api/records', { title: 'blocked' }, 'paused-key'), error => error.name === 'AbortError');
  assert.equal(await context.navigation.navigate('example.main'), false);
  assert.deepEqual(apiCalls, ['/api/records'], 'only the command admitted before suspension reached the transport');
  admittedCommand.resolve(json({ accepted: true, commandId: 'original-command-key' }));
  assert.deepEqual(await alreadyAdmitted, { accepted: true, commandId: 'original-command-key' });
  holdCommand = false;
  env.doc.visibilityState = 'visible';
  env.doc.emit('visibilitychange');
  await flush();
  assert.equal(requests, 2);
  assert.equal(env.root.hidden, true, 'the retained workspace stays unavailable while bootstrap revalidates');
  assert.equal(context.route, undefined);
  env.loc.hash = '#/other';
  env.win.emit('hashchange');
  assert.equal(env.loc.hash, '#/records');
  await assert.rejects(context.api.get('/api/records'), error => error.name === 'AbortError');
  await assert.rejects(context.api.post('/api/records', { title: 'blocked' }, 'pending-key'), error => error.name === 'AbortError');
  assert.equal(await context.navigation.navigate('example.main'), false);
  assert.deepEqual(apiCalls, ['/api/records']);
  refresh.resolve(json(boot()));
  await flush();
  assert.equal(env.root.hidden, false);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0], context);
  assert.equal(context.signal.aborted, false);
  assert.equal(context.route.kind, 'workspace');
  assert.deepEqual(await context.api.get('/api/records'), { accepted: true });
  assert.equal(await context.navigation.navigate('example.main'), true);
  assert.deepEqual(apiCalls, ['/api/records', '/api/records']);
  assert.ok(env.all().some(node => node.tag === 'draft-state'));
}, mobile));

test('logout remains fenced across suspend/resume until the server returns signedOut true', () => harness(async (env, start) => {
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
  logout.resolve(json({ signedOut: true }));
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

test('packaged native entry refuses a browser runtime before mounting or making requests', () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  assert.throws(() => startPackagedMobileShell({
    root: {}, title: 'Selected Product', loaders: {}, identity: {
      productId: 'combined', productVersion: '0.2.4', instanceId: 'combined-local', modules: []
    }
  }), error => error?.code === 'INCOMPATIBLE');
  assert.equal(requests, 0);
});

test('native transport treats an omitted request method as GET for bootstrap routing', async () => {
  const calls = [];
  const transport = createNativeRequestTransport({
    async read() { return { token: 'abcdefghijklmnopqrstuvwx123456' }; },
    async save() {}, async clear() {}
  }, async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await transport('/api/bootstrap');
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:4350/native-api/bootstrap', method: 'GET' }]);
});

test('packaged bootstrap identity must match the selected product, instance and exact modules', () => {
  const expected = { productId: 'combined', productVersion: '0.2.4', instanceId: 'combined-local', planDigest: 'a'.repeat(64), modules: [{ id: 'service-desk', version: '0.2.2' }, { id: 'knowledge', version: '0.2.4' }] };
  const snapshot = {
    product: { id: 'combined', version: '0.2.4' }, scope: { instanceId: 'combined-local' },
    nativeIdentity: { ...expected, modules: expected.modules },
    modules: [{ id: 'service-desk', version: '0.2.2', mode: 'enabled' }]
  };
  assert.equal(validateNativeBootstrapIdentity(snapshot, expected), snapshot);
  assert.throws(() => validateNativeBootstrapIdentity({ ...snapshot, scope: { instanceId: 'other-local' } }, expected), error => error?.code === 'INCOMPATIBLE');
  assert.equal(validateNativeBootstrapIdentity({ ...snapshot, modules: [] }, expected).modules.length, 0);
  assert.throws(() => validateNativeBootstrapIdentity({ ...snapshot, modules: [{ id: 'handoff', version: '0.2.4', mode: 'enabled' }] }, expected), error => error?.code === 'INCOMPATIBLE');
  assert.throws(() => validateNativeBootstrapIdentity({ ...snapshot, modules: [snapshot.modules[0], snapshot.modules[0]] }, expected), error => error?.code === 'INCOMPATIBLE');
  assert.throws(() => validateNativeBootstrapIdentity({ ...snapshot, nativeIdentity: { ...snapshot.nativeIdentity, planDigest: 'b'.repeat(64) } }, expected), error => error?.code === 'INCOMPATIBLE');
});

test('F06: native remote logout failure clears local credentials but reports revocation as unknown', async () => {
  const calls = [], authorizations = [], events = [];
  const transport = createNativeRequestTransport({
    async read() { events.push('read'); return { token: 'abcdefghijklmnopqrstuvwx123456' }; },
    async save() {},
    async clear() { events.push('clear'); if (events.filter(event => event === 'clear').length === 1) throw new Error('secure store unavailable'); }
  }, async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    authorizations.push(new Headers(init.headers).get('Authorization'));
    return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'session expired' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  });
  const first = await transport('/api/logout', { method: 'POST' });
  assert.deepEqual(first, { kind: 'quadbridge.native-logout.v1', remoteRevocation: 'unknown', localCredentials: 'unresolved', recovery: 'retry-local-cleanup' });
  const second = await transport('/api/logout', { method: 'POST' });
  assert.deepEqual(second, { kind: 'quadbridge.native-logout.v1', remoteRevocation: 'unknown', localCredentials: 'removed', recovery: 'return-to-sign-in' });
  assert.equal(calls.length, 1, 'local cleanup retry never sends another remote logout');
  assert.deepEqual(authorizations, ['QBUserSession abcdefghijklmnopqrstuvwx123456']);
  assert.equal(events.filter(event => event === 'read').length, 1, 'retry does not reload the erased secret');
  assert.equal(events.filter(event => event === 'clear').length, 2);
});

test('F06: native logout with no local token makes no server call and does not claim remote revocation', async () => {
  let reads = 0, clears = 0, calls = 0;
  const transport = createNativeRequestTransport({
    async read() { reads++; return { token: null }; }, async save() {}, async clear() { clears++; }
  }, async () => { calls++; throw new Error('must not contact the server'); });
  const result = await transport('/api/logout', { method: 'POST' });
  assert.deepEqual(result, { kind: 'quadbridge.native-logout.v1', remoteRevocation: 'unknown', localCredentials: 'removed', recovery: 'return-to-sign-in' });
  assert.equal(reads, 1);
  assert.equal(clears, 1);
  assert.equal(calls, 0);
});

test('F06: native local-clear recovery preserves confirmed server logout without resending the token', async () => {
  let clears = 0, reads = 0, calls = 0;
  const transport = createNativeRequestTransport({
    async read() { reads++; return { token: 'abcdefghijklmnopqrstuvwx123456' }; }, async save() {},
    async clear() { if (++clears === 1) throw new Error('secure store unavailable'); }
  }, async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get('Authorization'), 'QBUserSession abcdefghijklmnopqrstuvwx123456');
    return new Response(JSON.stringify({ signedOut: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  assert.deepEqual(await transport('/api/logout', { method: 'POST' }), {
    kind: 'quadbridge.native-logout.v1', remoteRevocation: 'confirmed', localCredentials: 'unresolved', recovery: 'retry-local-cleanup'
  });
  assert.deepEqual(await transport('/api/logout', { method: 'POST' }), {
    kind: 'quadbridge.native-logout.v1', remoteRevocation: 'confirmed', localCredentials: 'removed', recovery: 'return-to-sign-in'
  });
  assert.equal(calls, 1);
  assert.equal(reads, 1);
  assert.equal(clears, 2);
});

test('F06: mobile shell shows the unconfirmed-server notice only after local credential removal', () => harness(async (env) => {
  const snapshot = boot();
  const request = async path => path === '/api/bootstrap' ? snapshot : {
    kind: 'quadbridge.native-logout.v1', remoteRevocation: 'unknown', localCredentials: 'removed', recovery: 'return-to-sign-in'
  };
  mobile({ root: env.root, title: 'Example', loaders: { example: async () => ({ workspace: { mount() {} } }) }, request });
  await flush();
  env.all().find(node => node.textContent === 'Sign out').emit('click');
  await flush();
  assert.match(env.root.textContent, /Sign in/);
  assert.match(env.root.textContent, /server could not confirm that the session was revoked/);
}));
