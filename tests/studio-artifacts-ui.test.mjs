import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const mainPath = new URL('../apps/studio-web/dist/main.js', import.meta.url);
const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause();
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
const overview = { platform:{version:'0.3',mode:'local'},modules:[],products:[],productVersions:[],coverage:[],builds:[],
  environments:[],deployments:[],aiPipelines:[],audit:[],capabilities:[] };
function artifact(digest, productId) {
  return { digest, productId, version:'1.0.0', buildId:`build-${productId}`, fileCount:1, sizeBytes:9, registeredAt:1700000000000 };
}
function registry(artifacts = []) {
  return { capability:{status:'ready',detail:'Local registry is ready.'},capacity:{objectDirectories:artifacts.length,registryBytes:9,stagingBytes:0,reservedBytes:0},
    limits:{maxObjectDirectories:20,maxRegistryBytes:100000,maxStagingBytes:100000},artifacts,operations:[],operationHistory:{limit:200,count:0,truncated:false},releases:[] };
}
function detail(digest, productId, path) {
  return { digest, productId, version:'1.0.0', entries:[{id:`entry-${productId}`,path,digest:'b'.repeat(64),sizeBytes:9}] };
}

class FakeApp {
  _html = '';
  set innerHTML(value) { this._html = value; }
  get innerHTML() { return this._html; }
  querySelectorAll() { return []; }
}

async function artifactUiHarness({ hash = '#overview', registryReplies = [], detailReplies = [] } = {}) {
  const source = (await readFile(mainPath, 'utf8')).replace(/^export \{\};?\s*$/m,'').replace(/^\/\/# sourceMappingURL=.*$/m,'');
  const app = new FakeApp(), documentListeners = new Map(), windowListeners = new Map(), calls = [];
  let currentHash=hash;
  const location = { get hash(){return currentHash;}, set hash(value){currentHash=String(value).startsWith('#')?String(value):`#${value}`;} };
  const fetch = async (path, options = {}) => {
    calls.push({path, options});
    if (path === '/platform-api/session') return response({});
    if (path === '/platform-api/overview') return response(overview);
    if (path === '/platform-api/logout') return response({});
    if (path === '/platform-api/artifacts') {
      const next = registryReplies.shift();
      if (next instanceof Error) throw next;
      if (next?.promise) return await next.promise;
      if (next) return next;
      return response(registry());
    }
    if (path.startsWith('/platform-api/artifacts/')) {
      const next = detailReplies.shift();
      if (next instanceof Error) throw next;
      if (next?.promise) return await next.promise;
      if (next) return next;
      throw new Error(`Unexpected artifact inspection ${path}`);
    }
    throw new Error(`Unexpected UI request ${options.method ?? 'GET'} ${path}`);
  };
  const context = vm.createContext({
    document:{getElementById:id=>id==='app'?app:null,addEventListener:(name,listener)=>documentListeners.set(name,listener)},
    window:{addEventListener:(name,listener)=>windowListeners.set(name,listener)},location,fetch,console,
    setInterval:()=>1,clearInterval:()=>{}
  });
  new vm.Script(source,{filename:'studio-main.js'}).runInContext(context);
  await until(()=>calls.some(call=>call.path==='/platform-api/overview'),'initial Studio overview');
  await until(()=>app.innerHTML.includes('<main class="main">')||app.innerHTML.includes('Connect Studio'),'initial Studio render');
  const dispatch = (selector, dataset = {}) => {
    const element = {dataset,closest(name) { return name === selector ? this : null; }};
    documentListeners.get('click')({target:{closest:name=>name===selector?element:null}});
  };
  return {app,calls,dispatch,location,windowListeners,
    changeHash(value){location.hash=value;windowListeners.get('hashchange')();},
    async settle(){await pause();await pause();}};
}

test('artifact registry activates once for direct URLs, clicks, history, empty/error states and retry', async () => {
  const initial=deferred(),back=deferred();
  const ui=await artifactUiHarness({hash:'#artifacts',registryReplies:[initial,back,response({error:'Registry is offline.'},503),response(registry([artifact('a'.repeat(64),'service-desk')]))]});
  await until(()=>ui.calls.filter(call=>call.path==='/platform-api/artifacts').length===1,'direct artifact registry request');
  assert.match(ui.app.innerHTML,/Loading local artifact registry/);
  initial.resolve(response(registry()));
  await until(()=>ui.app.innerHTML.includes('No verified local artifacts are registered.'),'explicit empty artifact state');

  ui.dispatch('[data-route]',{route:'modules'});
  ui.dispatch('[data-route]',{route:'artifacts'});
  ui.windowListeners.get('hashchange')();
  await until(()=>ui.calls.filter(call=>call.path==='/platform-api/artifacts').length===2,'click activation of artifact registry');
  assert.equal(ui.calls.filter(call=>call.path==='/platform-api/artifacts').length,2,'the click and its hashchange share one route activation');
  assert.match(ui.app.innerHTML,/Loading local artifact registry/);
  back.resolve(response(registry([artifact('a'.repeat(64),'service-desk')])));
  await until(()=>ui.app.innerHTML.includes('service-desk@1.0.0'),'artifact registry success state');

  ui.dispatch('[data-route]',{route:'modules'});
  ui.changeHash('#artifacts');
  await until(()=>ui.calls.filter(call=>call.path==='/platform-api/artifacts').length===3,'forward navigation to artifact registry');
  await until(()=>ui.app.innerHTML.includes('Registry is offline.'),'explicit registry error state');
  assert.match(ui.app.innerHTML,/data-retry-artifact-registry/);
  ui.dispatch('[data-retry-artifact-registry]');
  await until(()=>ui.calls.filter(call=>call.path==='/platform-api/artifacts').length===4,'registry retry');
  await until(()=>ui.app.innerHTML.includes('service-desk@1.0.0'),'successful retry state');
});

test('artifact registry response from a departed route cannot replace the current view', async () => {
  const late=deferred();
  const pending=await artifactUiHarness({hash:'#overview',registryReplies:[late]});
  pending.dispatch('[data-route]',{route:'artifacts'});
  await until(()=>pending.calls.filter(call=>call.path==='/platform-api/artifacts').length===1,'pending registry response');
  pending.dispatch('[data-route]',{route:'modules'});
  late.resolve(response(registry([artifact('c'.repeat(64),'stale-product')])));
  await pending.settle();
  assert.match(pending.app.innerHTML,/<h1>Modules<\/h1>/);
  assert.doesNotMatch(pending.app.innerHTML,/stale-product|Local artifact registry/);
});

test('new artifact inspection supersedes earlier success and failure responses', async () => {
  const digestA='a'.repeat(64),digestB='b'.repeat(64),first=deferred(),second=deferred();
  const ui=await artifactUiHarness({hash:'#artifacts',registryReplies:[response(registry([artifact(digestA,'alpha'),artifact(digestB,'beta')]))],detailReplies:[first,second]});
  await until(()=>ui.app.innerHTML.includes('alpha@1.0.0')&&ui.app.innerHTML.includes('beta@1.0.0'),'two registered artifacts');
  ui.dispatch('[data-inspect-artifact]',{inspectArtifact:digestA});
  ui.dispatch('[data-inspect-artifact]',{inspectArtifact:digestB});
  await until(()=>ui.calls.filter(call=>call.path.startsWith('/platform-api/artifacts/')&&call.path!=='/platform-api/artifacts').length===2,'two artifact inspections');
  second.resolve(response(detail(digestB,'beta','beta/index.html')));
  await until(()=>ui.app.innerHTML.includes('Verified inventory: beta@1.0.0'),'newer detail response');
  first.reject(new Error('stale alpha inspection failed'));
  await ui.settle();
  assert.match(ui.app.innerHTML,/beta\/index\.html/);
  assert.doesNotMatch(ui.app.innerHTML,/Verified inventory: alpha|stale alpha inspection failed/);
});

test('Close while an artifact inspection is pending invalidates its late result', async () => {
  const digest='d'.repeat(64),pending=deferred();
  const ui=await artifactUiHarness({hash:'#artifacts',registryReplies:[response(registry([artifact(digest,'delta')]))],detailReplies:[pending]});
  await until(()=>ui.app.innerHTML.includes('delta@1.0.0'),'registered artifact');
  ui.dispatch('[data-inspect-artifact]',{inspectArtifact:digest});
  await until(()=>ui.app.innerHTML.includes('Loading verified inventory…'),'pending artifact inspection');
  ui.dispatch('[data-close-artifact]');
  pending.resolve(response(detail(digest,'delta','delta/index.html')));
  await ui.settle();
  assert.doesNotMatch(ui.app.innerHTML,/Verified inventory: delta|delta\/index\.html/);
  assert.match(ui.app.innerHTML,/Registered immutable artifacts/);
});

test('artifact inspection refuses a response bound to a different digest', async () => {
  const requested='1'.repeat(64),returned='2'.repeat(64);
  const ui=await artifactUiHarness({hash:'#artifacts',registryReplies:[response(registry([artifact(requested,'requested')]))],
    detailReplies:[response(detail(returned,'different','different/index.html'))]});
  await until(()=>ui.app.innerHTML.includes('requested@1.0.0'),'registered artifact');
  ui.dispatch('[data-inspect-artifact]',{inspectArtifact:requested});
  await until(()=>ui.app.innerHTML.includes('did not match the requested digest'),'mismatched detail response rejected');
  assert.doesNotMatch(ui.app.innerHTML,/Verified inventory:|different\/index\.html/);
});

test('route changes and disconnect invalidate pending artifact detail responses', async t => {
  await t.test('navigation',async()=>{
    const digest='e'.repeat(64),pending=deferred();
    const ui=await artifactUiHarness({hash:'#artifacts',registryReplies:[response(registry([artifact(digest,'epsilon')]))],detailReplies:[pending]});
    await until(()=>ui.app.innerHTML.includes('epsilon@1.0.0'),'registered artifact');
    ui.dispatch('[data-inspect-artifact]',{inspectArtifact:digest});
    await until(()=>ui.app.innerHTML.includes('Loading verified inventory…'),'pending artifact detail');
    ui.dispatch('[data-route]',{route:'modules'});
    pending.resolve(response(detail(digest,'epsilon','epsilon/index.html')));
    await ui.settle();
    assert.match(ui.app.innerHTML,/<h1>Modules<\/h1>/);
    assert.doesNotMatch(ui.app.innerHTML,/epsilon\/index\.html|Verified inventory:/);
  });
  await t.test('disconnect',async()=>{
    const digest='f'.repeat(64),pending=deferred();
    const ui=await artifactUiHarness({hash:'#artifacts',registryReplies:[response(registry([artifact(digest,'foxtrot')]))],detailReplies:[pending]});
    await until(()=>ui.app.innerHTML.includes('foxtrot@1.0.0'),'registered artifact');
    ui.dispatch('[data-inspect-artifact]',{inspectArtifact:digest});
    await until(()=>ui.app.innerHTML.includes('Loading verified inventory…'),'pending artifact detail');
    ui.dispatch('[data-logout]');
    await until(()=>ui.app.innerHTML.includes('Connect Studio'),'disconnected view');
    pending.resolve(response(detail(digest,'foxtrot','foxtrot/index.html')));
    await ui.settle();
    assert.match(ui.app.innerHTML,/Connect Studio/);
    assert.doesNotMatch(ui.app.innerHTML,/Verified inventory:|foxtrot\/index\.html/);
  });
});
