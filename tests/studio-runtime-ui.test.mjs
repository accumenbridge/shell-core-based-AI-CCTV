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
  return { ok: status >= 200 && status < 300, status, body, async json() { return body; } };
}
function runtimeInstance(overrides = {}) {
  const state=overrides.state??'RUNNING',currentAttempt=overrides.currentAttempt??1,workerRequired=overrides.workerRequired??false;
  const facts=state==='RUNNING'?{apiReady:true,workerAttached:false,emptyObserved:false,helperClosed:false,executionClean:false}:
    state==='STOPPED'?{apiReady:true,workerAttached:false,emptyObserved:true,helperClosed:true,executionClean:true}:
    {apiReady:false,workerAttached:false,emptyObserved:false,helperClosed:false,executionClean:false};
  return { id:'runtime-123e4567-e89b-42d3-a456-426614174000',productId:'service-desk',version:'1.0.0',artifactDigest:'a'.repeat(64),
    state,currentAttempt,workerRequired,processObservation:state==='STOPPED'?'positively-stopped':'owned-in-this-process',
    attempts:[{id:`123e4567-e89b-42d3-a456-${String(currentAttempt).padStart(12,'0')}`,attempt:currentAttempt,...facts}],...overrides };
}

class FakeApp {
  _html = '';
  renderCount = 0;
  inputs = [];
  set innerHTML(value) {
    this.renderCount++;
    this._html = value;
    this.inputs = [...value.matchAll(/<input\b([^>]*)>/g)].map(match => {
      const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(found => [found[1], found[2] ?? true]));
      const dataset = {};
      for (const [name, attribute] of Object.entries(attributes)) if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_whole, letter) => letter.toUpperCase());
        dataset[key] = attribute;
      }
      return { dataset, checked: Object.hasOwn(attributes, 'checked'), disabled: Object.hasOwn(attributes, 'disabled') };
    });
  }
  get innerHTML() { return this._html; }
  querySelectorAll(selector) { return selector === '[data-runtime-confirmation]' ? this.inputs.filter(input => input.dataset.runtimeConfirmation !== undefined) : []; }
}

async function uiHarness(t, { initial = runtimeInstance(), runtimeReads = [], detailReads = [], startReplies = [], stopReply,
  recoveryList, backupReply, verifyReply, restoreReply, upgradeList, upgradeReply, upgradeReleases, restartReply, onUpgrade, onRestart } = {}) {
  const source = (await readFile(mainPath, 'utf8')).replace(/^export \{\};?\s*$/m,'').replace(/^\/\/# sourceMappingURL=.*$/m,'')+
    '\nglobalThis.__runtimeUiDebug=()=>({route,connected,navigationGeneration,runtimeOverviewSequence,runtimeOverview,runtimeLoadError,actionError});';
  const app = new FakeApp();
  const documentListeners = new Map(), windowListeners = new Map(), calls = [];
  let timerCallback;
  const runtime = { capability:{status:'ready',profile:'local',details:'Local managed runtime'},slot:{state:'EMPTY',instanceId:null,reservedBytes:0},instances:[initial] };
  const releases = upgradeReleases ?? [{productId:'service-desk',version:'1.0.0',artifactDigest:initial.artifactDigest}];
  const overview = { platform:{version:'0.3',mode:'local'},modules:[],products:[],productVersions:[],coverage:[],builds:[],environments:[],deployments:[],aiPipelines:[],audit:[],capabilities:[] };
  const runtimeQueue=[...runtimeReads];
  let detailIndex = 0, runtimeIndex = 0, startIndex = 0;
  const runtimeResponseTrace=[];
  const fetch = async (path, options = {}) => {
    calls.push({path,options,body:options.body ? JSON.parse(options.body) : undefined});
    if (path === '/platform-api/session') return response({});
    if (path === '/platform-api/overview') return response(overview);
    if (path === '/platform-api/runtime-instances' && options.method !== 'POST') {
      const next=runtimeQueue.shift(),index=next?runtimeIndex++:-1;
      if(!next)return response(runtime);
      return await next.promise.then(value=>{runtimeResponseTrace.push({index,body:value.body});return value;});
    }
    if (path === '/platform-api/releases') return response(releases);
    if (path === '/platform-api/runtime-instances' && options.method === 'POST') {
      const next = startReplies[startIndex++];
      if (next instanceof Error) throw next;
      return next ? response(next) : response({command:{state:'SUCCEEDED'},instance:runtimeInstance({state:'RUNNING'})});
    }
    if (path.endsWith('/stop') && options.method === 'POST') return response(stopReply ?? {command:{state:'UNKNOWN'},instance:runtimeInstance({state:'UNKNOWN',processObservation:'not-observed-in-this-process'})});
    if (path.endsWith('/restart') && options.method === 'POST') { onRestart?.(options.body?JSON.parse(options.body):undefined,runtime);return response(restartReply ?? {command:{state:'SUCCEEDED'},instance:runtimeInstance({currentAttempt:2})}); }
    if (path.endsWith('/backups') && options.method === 'GET') return response(recoveryList ?? {capability:{status:'ready',detail:'Private local recovery is ready'},instanceId:initial.id,backups:[],operations:[]});
    if (path.endsWith('/backups') && options.method === 'POST') return response(backupReply ?? {id:'recovery-op-1',kind:'BACKUP',state:'SUCCEEDED',physicalState:'CLEAN',errorCode:null});
    if (path.startsWith('/platform-api/runtime-backups/')) return response(verifyReply ?? {digest:'b'.repeat(64),instanceId:initial.id,sizeBytes:1234,fileCount:4,capturedAt:1700000000000,verified:true});
    if (path.endsWith('/restore') && options.method === 'POST') return response(restoreReply ?? {id:'recovery-op-2',kind:'RESTORE',state:'SUCCEEDED',physicalState:'CLEAN',errorCode:null});
    if (/^\/platform-api\/runtime-instances\/[^/]+\/upgrades$/.test(path) && options.method !== 'POST') return response(upgradeList ?? {instanceId:initial.id,generations:[],operations:[]});
    if (path.endsWith('/upgrades') && options.method === 'POST') { onUpgrade?.(options.body?JSON.parse(options.body):undefined,runtime,upgradeList);return response(upgradeReply ?? {id:'upgrade-op-1',state:'SUCCEEDED',physicalState:'CLEAN'}); }
    if (path.startsWith('/platform-api/runtime-instances/')) {
      const next = detailReads[detailIndex++];
      return next ? await next.promise : response(runtimeInstance({events:'current events'}));
    }
    throw new Error(`Unexpected UI request ${options.method ?? 'GET'} ${path}`);
  };
  const context = vm.createContext({
    document:{getElementById:id=>id==='app'?app:null,addEventListener:(name,listener)=>documentListeners.set(name,listener)},
    window:{addEventListener:(name,listener)=>windowListeners.set(name,listener)},
    location:{hash:'#runtime-instances'},fetch,crypto:{randomUUID:()=>`test-key-${calls.length}`},
    setInterval:callback=>{timerCallback=callback;return 1;},clearInterval:()=>{},console
  });
  new vm.Script(source,{filename:'studio-main.js'}).runInContext(context);
  await until(()=>app.innerHTML.includes('Managed local runtime'),'initial runtime dashboard');
  t.after(()=>{ if(timerCallback) timerCallback=undefined; });
  const dispatch = (selector, dataset = {}, checked = true, values = {}) => {
    const element = {
      dataset,
      closest(name) {
        if (name === selector) return this;
        if (name === 'article') return {querySelector:query=>query.includes('confirm')?{checked}:{value:values.target??''}};
        return null;
      }
    };
    documentListeners.get('click')({target:{closest:name=>name===selector?element:null}});
  };
  return {app,calls,dispatch,documentListeners,windowListeners,get timerCallback(){return timerCallback;},runtime,releases,runtimeReads:runtimeQueue,runtimeResponseTrace,debug:()=>context.__runtimeUiDebug(),until};
}

test('runtime overview consumes the public promoted-release array and offers the exact release', async t=>{
  const ui=await uiHarness(t);
  await ui.until(()=>ui.app.innerHTML.includes('data-runtime-start')&&ui.app.innerHTML.includes('Promoted local immutable release'),'promoted release choices');
  assert.ok(ui.calls.some(call=>call.path==='/platform-api/releases'&&call.options.method==='GET'),
    'the UI fetched the canonical releases endpoint');
  assert.match(ui.app.innerHTML,/data-product="service-desk" data-version="1\.0\.0"/);
  assert.match(ui.app.innerHTML,/Start this exact promoted local release on this machine/);
});

test('runtime UI reports UNKNOWN stop facts and reuses the same request key after an ambiguous start error', async t => {
  const unknown={command:{state:'UNKNOWN'},instance:runtimeInstance({state:'UNKNOWN',processObservation:'not-observed-in-this-process'})};
  const ui=await uiHarness(t,{initial:runtimeInstance(),startReplies:[new Error('connection reset after dispatch'),unknown],stopReply:unknown});
  ui.dispatch('[data-runtime-stop]',{runtimeStop:'runtime-123e4567-e89b-42d3-a456-426614174000',attempt:'1',artifactDigest:'a'.repeat(64)});
  await until(()=>ui.calls.some(call=>call.path.endsWith('/stop')),'stop request');
  await until(()=>ui.app.innerHTML.includes('Stop result: command UNKNOWN; runtime UNKNOWN.'),'honest UNKNOWN stop result');
  assert.doesNotMatch(ui.app.innerHTML,/process tree was stopped with its owner proof recorded/);

  ui.dispatch('[data-runtime-start]',{product:'service-desk',version:'1.0.0'});
  await until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method==='POST').length===1,'ambiguous start request');
  await until(()=>ui.app.innerHTML.includes('Local runtime start failed'),'ambiguous start error');
  ui.dispatch('[data-runtime-start]',{product:'service-desk',version:'1.0.0'});
  await until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method==='POST').length===2,'start retry');
  const requests=ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method==='POST');
  assert.equal(requests[0].body.requestKey,requests[1].body.requestKey,'the retry resolves the same captured start intent');
  await until(()=>ui.app.innerHTML.includes('Start result: command UNKNOWN; runtime UNKNOWN.'),'UNKNOWN start result');
  assert.doesNotMatch(ui.app.innerHTML,/reached its required readiness checks/);
});

test('runtime action success messages require proof in the exact current-attempt DTO', async t=>{
  const started={command:{state:'SUCCEEDED'},operationId:'123e4567-e89b-42d3-a456-000000000001',instance:runtimeInstance()};
  const stopped={command:{state:'SUCCEEDED'},operationId:'123e4567-e89b-42d3-a456-000000000001',instance:runtimeInstance({state:'STOPPED'})};
  const ui=await uiHarness(t,{initial:runtimeInstance(),startReplies:[started],stopReply:stopped});
  ui.dispatch('[data-runtime-start]',{product:'service-desk',version:'1.0.0'});
  await ui.until(()=>ui.app.innerHTML.includes('The runtime is RUNNING and its selected roles passed readiness checks.'),'positive start facts');
  ui.dispatch('[data-runtime-stop]',{runtimeStop:'runtime-123e4567-e89b-42d3-a456-426614174000',attempt:'1',artifactDigest:'a'.repeat(64)});
  await ui.until(()=>ui.app.innerHTML.includes('The runtime is STOPPED with an empty process tree and cleaned execution recorded.'),'positive stop facts');

  const staleFacts={...runtimeInstance(),attempts:[{id:'123e4567-e89b-42d3-a456-000000000099',attempt:1,apiReady:true,workerAttached:false,emptyObserved:true,helperClosed:true,executionClean:true}]};
  const stale=await uiHarness(t,{initial:runtimeInstance(),stopReply:{command:{state:'SUCCEEDED'},operationId:'123e4567-e89b-42d3-a456-000000000001',instance:{...staleFacts,state:'STOPPED'}}});
  stale.dispatch('[data-runtime-stop]',{runtimeStop:'runtime-123e4567-e89b-42d3-a456-426614174000',attempt:'1',artifactDigest:'a'.repeat(64)});
  await stale.until(()=>stale.app.innerHTML.includes('Stop result: command SUCCEEDED; runtime STOPPED.'),'stale attempt facts rejected');
  assert.doesNotMatch(stale.app.innerHTML,/runtime is STOPPED with an empty process tree/);
});

test('runtime overview and detail responses cannot restore stale routes, attempts, or application addresses', async t => {
  const slowOverview=deferred(),fastOverview=deferred(),oldDetail=deferred(),newDetail=deferred();
  const ui=await uiHarness(t,{initial:runtimeInstance(),detailReads:[oldDetail,newDetail]});
  ui.runtimeReads.push(slowOverview,fastOverview);
  ui.timerCallback();
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=2,'slow overview request');
  const routeButton={dataset:{route:'runtime-instances'},closest(name){return name==='article'?{querySelector:()=>null}:this;}};
  ui.documentListeners.get('click')({target:{closest:name=>name==='[data-route]'?routeButton:null}});
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=3,'newer overview request');
  fastOverview.resolve(response({...ui.runtime,instances:[runtimeInstance({currentAttempt:2,artifactDigest:'b'.repeat(64),url:'http://127.0.0.1:4999/'})]}));
  try { await ui.until(()=>ui.app.innerHTML.includes('attempt 2'),'runtime route reload'); }
  catch(error) { throw new Error(`${error.message}; debug=${JSON.stringify(ui.debug())}; trace=${JSON.stringify(ui.runtimeResponseTrace.map(item=>({index:item.index,attempt:item.body?.instances?.[0]?.currentAttempt})))}; requests=${ui.calls.filter(call=>call.path.startsWith('/platform-api/runtime-instances')).map(call=>call.path+':'+(call.options.method??'GET')).join(',')}; html=${ui.app.innerHTML.slice(-400)}`); }
  const rendersBeforeStaleCompletion=ui.app.renderCount;
  slowOverview.resolve(response({...ui.runtime,instances:[runtimeInstance({currentAttempt:1,artifactDigest:'a'.repeat(64),url:'http://127.0.0.1:4888/'})]}));
  await ui.until(()=>ui.runtimeResponseTrace.length===2,'older overview transport completed');
  // The trace is recorded when fetch resolves, before the UI continuation applies
  // or discards the response. Drain its promise continuation before checking the
  // negative render assertion so an already-visible attempt 2 cannot pass early.
  await pause();
  await pause();
  assert.equal(ui.app.renderCount,rendersBeforeStaleCompletion,'the completed stale response did not repaint the current route');
  assert.match(ui.app.innerHTML,/attempt 2/,'the newer overview remains rendered after the older response has completed');
  assert.doesNotMatch(ui.app.innerHTML,/Artifact a{64}|127\.0\.0\.1:4888/,'the completed stale response cannot restore its artifact or URL');
  assert.match(ui.app.innerHTML,/Artifact b{64}/);

  const id='runtime-123e4567-e89b-42d3-a456-426614174000';
  ui.dispatch('[data-runtime-detail]',{runtimeDetail:id});
  ui.dispatch('[data-runtime-detail]',{runtimeDetail:id});
  newDetail.resolve(response(runtimeInstance({currentAttempt:2,artifactDigest:'b'.repeat(64),events:'new attempt events',url:'http://127.0.0.1:4999/'})));
  await ui.until(()=>ui.app.innerHTML.includes('new attempt events'),'newer detail');
  oldDetail.resolve(response(runtimeInstance({currentAttempt:2,artifactDigest:'b'.repeat(64),events:'stale detail events',url:'http://127.0.0.1:4888/'})));
  await pause();
  assert.match(ui.app.innerHTML,/new attempt events/);
  assert.doesNotMatch(ui.app.innerHTML,/stale detail events|127\.0\.0\.1:4888/);

  const next=deferred();
  // A newer periodic overview invalidates detail tied to the previous artifact.
  ui.runtimeReads.push(next);
  ui.timerCallback();
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=4,'successor overview request');
  next.resolve(response({...ui.runtime,instances:[runtimeInstance({currentAttempt:3,artifactDigest:'c'.repeat(64),state:'STOPPED',processObservation:'positively-stopped'})]}));
  await ui.until(()=>ui.app.innerHTML.includes('attempt 3'),'successor attempt');
  assert.match(ui.app.innerHTML,/attempt 3/);
  assert.doesNotMatch(ui.app.innerHTML,/new attempt events|127\.0\.0\.1:4999/);
});

test('a stale runtime overview failure cannot replace a newer successful refresh', async t => {
  const olderFailure=deferred(),newerSuccess=deferred();
  const ui=await uiHarness(t,{initial:runtimeInstance()});
  ui.runtimeReads.push(olderFailure,newerSuccess);
  ui.timerCallback();
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=2,'older overview request');
  const routeButton={dataset:{route:'runtime-instances'},closest(name){return name==='article'?{querySelector:()=>null}:this;}};
  ui.documentListeners.get('click')({target:{closest:name=>name==='[data-route]'?routeButton:null}});
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=3,'newer overview request');
  newerSuccess.resolve(response({...ui.runtime,instances:[runtimeInstance({currentAttempt:2,artifactDigest:'b'.repeat(64)})]}));
  await ui.until(()=>ui.app.innerHTML.includes('attempt 2'),'newer overview result');
  olderFailure.reject(new Error('stale request failed'));
  await pause();
  assert.match(ui.app.innerHTML,/attempt 2/);
  assert.doesNotMatch(ui.app.innerHTML,/stale request failed|role="alert"/);
});

test('runtime confirmations survive same-attempt polling and are scoped away from a successor attempt', async t => {
  const next=deferred();
  const ui=await uiHarness(t,{initial:runtimeInstance()});
  const confirmation=ui.app.inputs.find(input=>input.dataset.runtimeConfirmation===`STOP:runtime-123e4567-e89b-42d3-a456-426614174000:1:${'a'.repeat(64)}`);
  assert.ok(confirmation);
  confirmation.checked=true;
  ui.runtimeReads.push(next);ui.timerCallback();
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=2,'same-attempt poll');
  next.resolve(response({...ui.runtime,instances:[runtimeInstance()]}));
  await ui.until(()=>ui.runtimeResponseTrace.length===1,'same-attempt response applied');
  assert.equal(ui.app.inputs.find(input=>input.dataset.runtimeConfirmation===confirmation.dataset.runtimeConfirmation).checked,true);

  const successor=deferred();ui.runtimeReads.push(successor);
  ui.runtimeReads.push(successor);ui.timerCallback();
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=3,'successor poll');
  successor.resolve(response({...ui.runtime,instances:[runtimeInstance({currentAttempt:2,artifactDigest:'b'.repeat(64)})]}));
  await ui.until(()=>ui.app.innerHTML.includes('attempt 2'),'successor refresh');
  assert.equal(ui.app.inputs.find(input=>input.dataset.runtimeConfirmation?.startsWith('STOP:')).checked,false);
});

test('recovery controls require positive stop proof, verify opaque backups, and confirm backup and absent-root restore', async t=>{
  const stoppedDetail=runtimeInstance({state:'STOPPED',processObservation:'positively-stopped'});
  const {attempts:_attempts,...stoppedSummary}=stoppedDetail;
  const detail=deferred(),backupDigest='b'.repeat(64);
  const ui=await uiHarness(t,{initial:stoppedSummary,detailReads:[detail],recoveryList:{capability:{status:'ready',detail:'Private local recovery is ready'},instanceId:stoppedSummary.id,
    backups:[{digest:backupDigest,instanceId:stoppedDetail.id,attempt:1,productId:'service-desk',version:'1.0.0',artifactDigest:stoppedDetail.artifactDigest,capturedAt:1700000000000,sizeBytes:1234,fileCount:4}],
    operations:[{id:'recovery-op-old',kind:'BACKUP',state:'UNKNOWN',physicalState:'UNKNOWN',created:1700000000000,destinationVerified:false,stagingClean:false,errorCode:'RECOVERY_UNKNOWN'}]}});
  assert.doesNotMatch(ui.app.innerHTML,/Private local recovery|Load backups|Create backup/,'the actual summary DTO has no attempt facts');
  ui.dispatch('[data-runtime-detail]',{runtimeDetail:stoppedSummary.id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-instances/${stoppedSummary.id}`),'inspect stopped runtime detail');
  detail.resolve(response(stoppedDetail));
  await ui.until(()=>ui.app.innerHTML.includes('Private local recovery'),'stopped recovery controls');
  const id=stoppedSummary.id;
  ui.dispatch('[data-runtime-backups-load]',{runtimeBackupsLoad:id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-instances/${id}/backups`&&call.options.method==='GET'),'load recovery list');
  await ui.until(()=>ui.app.innerHTML.includes(backupDigest),'loaded backup inventory');
  assert.match(ui.app.innerHTML,/Create a private backup of this exact stopped runtime/);

  ui.dispatch('[data-runtime-backup-create]',{runtimeBackupCreate:id},false);
  assert.doesNotMatch(ui.calls.map(call=>call.path+':'+(call.options.method??'GET')).join('\n'),/backups:POST/,'backup creation is gated by its confirmation');
  ui.dispatch('[data-runtime-backup-create]',{runtimeBackupCreate:id},true);
  await ui.until(()=>ui.calls.some(call=>call.path.endsWith('/backups')&&call.options.method==='POST'),'confirmed private backup');
  const create=ui.calls.find(call=>call.path.endsWith('/backups')&&call.options.method==='POST');
  assert.equal(create.body.confirm,true);
  assert.match(create.body.requestKey,/^runtime:/);
  await ui.until(()=>ui.app.innerHTML.includes('Backup operation SUCCEEDED'),'backup result');

  // The loaded inventory is deliberately limited to metadata; no local paths or credentials reach the UI.
  const digest=backupDigest;
  ui.dispatch('[data-runtime-backup-verify]',{runtimeBackupVerify:digest,runtimeInstance:id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-backups/${digest}`),'verify exact opaque backup');
  await ui.until(()=>ui.app.innerHTML.includes('verified')&&ui.app.innerHTML.includes('Restore this backup'),'verified restore choice');
  ui.dispatch('[data-runtime-restore]',{runtimeRestore:id,backupDigest:digest},false);
  assert.equal(ui.calls.filter(call=>call.path.endsWith('/restore')&&call.options.method==='POST').length,0,'restore requires explicit confirmation');
  ui.dispatch('[data-runtime-restore]',{runtimeRestore:id,backupDigest:digest},true);
  await ui.until(()=>ui.calls.some(call=>call.path.endsWith('/restore')&&call.options.method==='POST'),'confirmed absent-root restore');
  const restore=ui.calls.find(call=>call.path.endsWith('/restore')&&call.options.method==='POST');
  assert.deepEqual(restore.body,{confirm:true,backupDigest:digest,requestKey:restore.body.requestKey});
  assert.match(restore.body.requestKey,/^runtime:/);
  await ui.until(()=>ui.app.innerHTML.includes('Restore operation SUCCEEDED'),'restore result');
  assert.doesNotMatch(ui.app.innerHTML,/ownerToken|ownerId|requestKey|dataDirectory|executionPath|credentials\.json/i);
  const unknown=deferred();ui.runtimeReads.push(unknown);
  ui.dispatch('[data-route]',{route:'overview'});
  ui.dispatch('[data-route]',{route:'runtime-instances'});
  await ui.until(()=>ui.calls.filter(call=>call.path==='/platform-api/runtime-instances'&&call.options.method!=='POST').length>=2,'refresh summary after inspection');
  unknown.resolve(response({...ui.runtime,instances:[runtimeInstance({state:'UNKNOWN',processObservation:'not-observed-in-this-process'})]}));
  await ui.until(()=>ui.debug().runtimeOverview?.instances?.[0]?.state==='UNKNOWN','current unknown summary applied');
  assert.doesNotMatch(ui.app.innerHTML,/Private local recovery|Load backups|Create backup/,'current UNKNOWN summary denies stale inspected stop proof');
});

test('recovery controls stay hidden when a stopped runtime lacks current positive cleanup facts', async t=>{
  const stopped=runtimeInstance({state:'STOPPED',processObservation:'positively-stopped',attempts:[{id:'prior',attempt:1,emptyObserved:true,helperClosed:true,executionClean:false}]});
  const detail=deferred(),currentPositiveDetail=runtimeInstance({state:'STOPPED',processObservation:'positively-stopped',events:'current events'});
  const ui=await uiHarness(t,{initial:stopped,detailReads:[detail]});
  ui.dispatch('[data-runtime-detail]',{runtimeDetail:stopped.id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-instances/${stopped.id}`),'inspect contradictory stopped summary');
  detail.resolve(response(currentPositiveDetail));
  await ui.until(()=>ui.app.innerHTML.includes('current events'),'positive detail loaded behind contradictory summary');
  assert.doesNotMatch(ui.app.innerHTML,/Private local recovery|Load backups|Create backup/);
  assert.match(ui.app.innerHTML,/Restart exact runtime/);
});

test('upgrade UI requires the exact stopped generation, verified backup, target confirmation, then explicit target restart', async t=>{
  const id='runtime-123e4567-e89b-42d3-a456-426614174000',sourceGenerationId=`generation:${id}:1`,targetGenerationId=`generation:${id}:2`;
  const sourceDigest='a'.repeat(64),backupDigest='b'.repeat(64),targetDigest='c'.repeat(64),sourceAttemptId='123e4567-e89b-42d3-a456-000000000001';
  const initial=runtimeInstance({id,productId:'combined',version:'0.2.3',artifactDigest:sourceDigest,state:'STOPPED',processObservation:'positively-stopped',
    activeGenerationId:sourceGenerationId,attempts:[{id:sourceAttemptId,attempt:1,state:'STOPPED',physicalState:'EMPTY',emptyObserved:true,helperClosed:true,executionClean:true,
      generation:{generationId:sourceGenerationId,generation:1,productId:'combined',version:'0.2.3',artifactDigest:sourceDigest}}]});
  const initialSummary={...initial};delete initialSummary.activeGenerationId;delete initialSummary.attempts;
  const history={instanceId:id,generations:[{id:sourceGenerationId,instanceId:id,generation:1,productId:'combined',version:'0.2.3',artifactDigest:sourceDigest,
    profileDigest:'1'.repeat(64),configDigest:'2'.repeat(64),adapterDigest:'3'.repeat(64),toolchainDigest:'4'.repeat(64),recipeDigest:'5'.repeat(64),originatingActorId:'operator-source',created:1}],operations:[]};
  const targetRelease={productId:'combined',version:'0.2.4',artifactDigest:targetDigest};
  const targetReady={...initial,version:targetRelease.version,artifactDigest:targetDigest,state:'UPGRADE_READY',processObservation:'not-observed-in-this-process',activeGenerationId:targetGenerationId};
  const targetSummary={...targetReady};delete targetSummary.activeGenerationId;delete targetSummary.attempts;
  const restartOperationId='123e4567-e89b-42d3-a456-000000000002';
  const runningTarget={...targetReady,state:'RUNNING',processObservation:'owned-in-this-process',currentAttempt:2,url:'http://127.0.0.1:43210',
    attempts:[{id:restartOperationId,attempt:2,state:'RUNNING',apiReady:true,workerAttached:true}]};
  const runningSummary={...runningTarget};delete runningSummary.activeGenerationId;delete runningSummary.attempts;
  const sourceDetail=deferred(),targetDetail=deferred();
  const ui=await uiHarness(t,{initial:initialSummary,detailReads:[sourceDetail,targetDetail],upgradeList:history,upgradeReleases:[{productId:'combined',version:'0.2.3',artifactDigest:sourceDigest},targetRelease],
    recoveryList:{capability:{status:'ready',detail:'Private recovery is ready'},instanceId:id,backups:[{digest:backupDigest,instanceId:id,generationId:sourceGenerationId,
      attemptId:sourceAttemptId,attempt:1,productId:'combined',version:'0.2.3',artifactDigest:sourceDigest,capturedAt:1700000000000,sizeBytes:2048,fileCount:6}],operations:[]},
    verifyReply:{digest:backupDigest,instanceId:id,sizeBytes:2048,fileCount:6,capturedAt:1700000000000,verified:true},
    upgradeReply:{id:'upgrade-op-1',instanceId:id,sourceGenerationId,targetGenerationId,state:'SUCCEEDED',physicalState:'CLEAN',destinationPublished:true,destinationVerified:true,
      driverEmpty:true,driverClosed:true,publisherResultObserved:true,publisherClosed:true,stagingClean:true},
    onUpgrade:(_body,runtimeState)=>{runtimeState.instances=[targetSummary];history.generations.push({...history.generations[0],id:targetGenerationId,generation:2,version:'0.2.4',artifactDigest:targetDigest,
      originatingActorId:'operator-target',sourceGenerationId,upgradeOperationId:'upgrade-op-1',created:2});history.operations.push({id:'upgrade-op-1',instanceId:id,
      sourceGenerationId,targetGenerationId,sourceAttemptId,sourceAttempt:1,sourceCommandId:'source-command',targetVersion:'0.2.4',targetArtifactDigest:targetDigest,
      sourceBackupDigest:backupDigest,state:'SUCCEEDED',physicalState:'CLEAN',driverEmpty:true,driverClosed:true,stagingClean:true,publisherResultObserved:true,
      publisherClosed:true,destinationPublished:true,destinationVerified:true,created:2,updated:3});},
    restartReply:{operationId:restartOperationId,command:{state:'SUCCEEDED'},instance:runningTarget},onRestart:(_body,runtimeState)=>{runtimeState.instances=[runningSummary];}});
  await ui.until(()=>ui.app.innerHTML.includes('Immutable generations'),'generation history loaded');
  ui.dispatch('[data-runtime-detail]',{runtimeDetail:id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-instances/${id}`),'inspect source generation detail');
  sourceDetail.resolve(response({...initial,events:'source generation detail'}));
  await ui.until(()=>ui.app.innerHTML.includes('source generation detail')&&ui.app.innerHTML.includes(`generation ${sourceGenerationId}`),'matched detail proves source generation');
  ui.dispatch('[data-runtime-backups-load]',{runtimeBackupsLoad:id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-instances/${id}/backups`&&call.options.method==='GET'),'source-generation backups loaded');
  await ui.until(()=>ui.app.innerHTML.includes('Backup from attempt 1')&&ui.app.innerHTML.includes(backupDigest),'source backup response rendered');
  ui.dispatch('[data-runtime-backup-verify]',{runtimeBackupVerify:backupDigest,runtimeInstance:id});
  await ui.until(()=>ui.calls.some(call=>call.path===`/platform-api/runtime-backups/${backupDigest}`),'source backup verification requested');
  await ui.until(()=>ui.app.innerHTML.includes('data-runtime-upgrade="'),'verified backup upgrade controls');
  assert.match(ui.app.innerHTML,/generation:runtime-123e4567-e89b-42d3-a456-426614174000:1/);
  assert.match(ui.app.innerHTML,/Upgrade this stopped generation 1/);
  const targetValue=`${targetRelease.version}|${targetRelease.artifactDigest}`;
  ui.dispatch('[data-runtime-upgrade]',{runtimeUpgrade:id,backupDigest},false,{target:targetValue});
  assert.equal(ui.calls.filter(call=>call.path.endsWith('/upgrades')&&call.options.method==='POST').length,0,'upgrade is denied until the exact source, verified backup and target are confirmed');
  ui.dispatch('[data-runtime-upgrade]',{runtimeUpgrade:id,backupDigest},true,{target:targetValue});
  await ui.until(()=>ui.calls.some(call=>call.path.endsWith('/upgrades')&&call.options.method==='POST'),'confirmed exact-generation upgrade');
  const upgrade=ui.calls.find(call=>call.path.endsWith('/upgrades')&&call.options.method==='POST');
  assert.deepEqual(upgrade.body,{confirm:true,targetVersion:'0.2.4',targetArtifactDigest:targetDigest,sourceBackupDigest:backupDigest,requestKey:upgrade.body.requestKey});
  assert.match(upgrade.body.requestKey,/^runtime:/);
  await ui.until(()=>ui.app.innerHTML.includes('UPGRADE_READY'),'target cutover summary');
  ui.dispatch('[data-runtime-detail]',{runtimeDetail:id});
  await ui.until(()=>ui.calls.filter(call=>call.path===`/platform-api/runtime-instances/${id}`).length===2,'inspect target generation detail');
  targetDetail.resolve(response({...targetReady,events:'target generation detail'}));
  await ui.until(()=>ui.app.innerHTML.includes('target generation detail')&&ui.app.innerHTML.includes('Start upgraded generation'),'matched target detail proves restart eligibility');
  assert.match(ui.app.innerHTML,/target generation is verified and cut over, but has not been started/);
  assert.doesNotMatch(ui.app.innerHTML,/Open local application/,'upgrade cutover does not invent target readiness or a URL');
  ui.dispatch('[data-runtime-restart]',{runtimeRestart:id,attempt:'1',artifactDigest:targetDigest},false);
  assert.equal(ui.calls.filter(call=>call.path.endsWith('/restart')&&call.options.method==='POST').length,0,'target start remains a separate explicit action');
  ui.dispatch('[data-runtime-restart]',{runtimeRestart:id,attempt:'1',artifactDigest:targetDigest},true);
  await ui.until(()=>ui.calls.some(call=>call.path.endsWith('/restart')&&call.options.method==='POST'),'explicit target restart');
  assert.equal(ui.calls.find(call=>call.path.endsWith('/restart')&&call.options.method==='POST').body.confirm,true);
  await ui.until(()=>ui.app.innerHTML.includes('combined@0.2.4')&&ui.app.innerHTML.includes('RUNNING'),'target runtime state after restart');
  assert.doesNotMatch(ui.app.innerHTML,/ownerToken|ownerId|requestKey|dataDirectory|executionPath|credentials\.json/i);
});
