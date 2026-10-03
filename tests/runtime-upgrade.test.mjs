import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ROOT } from '../apps/runtime/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { LocalArtifactStore } from '../apps/control-plane/dist/artifact-store.js';
import { LocalBuildWorker } from '../apps/control-plane/dist/build-worker.js';
import { createOperatorServer } from '../apps/control-plane/dist/operator-server.js';
import { captureManagedRuntimeNativeHost, runManagedRuntimeOwnedNativeJob } from '../apps/control-plane/dist/runtime-manager.js';
import { RUNTIME_RECOVERY_TOOL_SHA256 } from '../apps/control-plane/dist/runtime-recovery.js';
import { RuntimeUpgradeManager, RUNTIME_UPGRADE_PUBLISHER_SHA256, RUNTIME_UPGRADE_TOOL_SHA256 } from '../apps/control-plane/dist/runtime-upgrade.js';
import { RuntimeRecoveryManager } from '../apps/control-plane/dist/runtime-recovery.js';
import { copyReviewedBuildInputs } from '../apps/control-plane/dist/build-inputs.js';
import { startControlPlane } from '../apps/control-plane/dist/main.js';
import { isValidRuntimeUpgradeActorId, loadRuntimeInitializer } from '../tools/runtime-upgrade.mjs';

const PAIRING='upgrade-route-pairing-code-1234';
const INSTANCE='runtime-123e4567-e89b-42d3-a456-426614174000';
const OPERATION='123e4567-e89b-42d3-a456-426614174001';
const ARTIFACT='a'.repeat(64),BACKUP='b'.repeat(64);
const fileDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>{
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('invalid fixture metadata');
};
async function initializerSnapshot(t,{legacy=false}={}){
  const root=await mkdtemp(join(tmpdir(),'qb-upgrade-initializer-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const productId='service-desk',version='0.2.0',entryPath='apps/runtime/dist/index.js',releasePath='.artifacts/service-desk/release.json';
  const entry=join(root,...entryPath.split('/')),releaseFile=join(root,...releasePath.split('/'));
  await mkdir(join(root,'apps/runtime/dist'),{recursive:true});await mkdir(join(root,'.artifacts/service-desk'),{recursive:true});
  await writeFile(join(root,'package.json'),'{"type":"module"}\n');
  const marker=join(root,'legacy-import-side-effect.txt');
  const entryBytes=Buffer.from(legacy
    ? `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');export function createRuntime(){return 'legacy';}\n`
    : `export function createRuntime(){return 'legacy-fallback';}export function initializeRuntime(){return 'versioned-initializer';}\n`);
  await writeFile(entry,entryBytes);
  const initializer={schema:'quadbridge.runtime-initializer.v1',entryPath,exportName:'initializeRuntime',sha256:fileDigest(entryBytes)};
  const release={product:productId,version,backend:{[entryPath]:fileDigest(entryBytes)},...(legacy?{}:{runtimeInitializerCapability:initializer})};
  const releaseBytes=Buffer.from(JSON.stringify(release)+'\n');await writeFile(releaseFile,releaseBytes);
  const packageBytes=await readFile(join(root,'package.json'));
  const snapshot={schema:'quadbridge.local-snapshot.v1',productId,version,releaseDigest:fileDigest(releaseBytes),files:{
    'package.json':fileDigest(packageBytes),[entryPath]:fileDigest(entryBytes),[releasePath]:fileDigest(releaseBytes)
  }};
  await writeFile(join(root,'QUADBRIDGE-SNAPSHOT.json'),canonical(snapshot));
  return {root,marker,target:{productId,version,artifactDigest:fileDigest(Buffer.from(canonical(snapshot)))},initializer};
}
function request(context,path,{method='GET',json,cookie}={}){
  const url=new URL(context.server.url),headers={host:url.host,origin:context.server.url,connection:'close'};
  if(cookie)headers.cookie=cookie;
  const body=json===undefined?undefined:JSON.stringify(json);
  if(body!==undefined){headers['content-type']='application/json';headers['content-length']=String(Buffer.byteLength(body));}
  return new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port:url.port,path,method,headers},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));});
    req.on('error',reject);if(body!==undefined)req.write(body);req.end();});
}
const body=response=>JSON.parse(response.text);
test('recovery and upgrade exports pin the exact maintained native helpers',async()=>{
  const [recovery,upgrade,publisher]=await Promise.all([
    readFile(new URL('../tools/runtime-recovery.mjs',import.meta.url)),
    readFile(new URL('../tools/runtime-upgrade.mjs',import.meta.url)),
    readFile(new URL('../tools/runtime-upgrade-publish.ps1',import.meta.url))
  ]);
  for(const digest of [RUNTIME_RECOVERY_TOOL_SHA256,RUNTIME_UPGRADE_TOOL_SHA256,RUNTIME_UPGRADE_PUBLISHER_SHA256])
    assert.match(digest,/^[0-9a-f]{64}$/,'exported native tool pins are complete SHA-256 digests');
  assert.equal(fileDigest(recovery),RUNTIME_RECOVERY_TOOL_SHA256,'recovery export pins the checked-in recovery helper');
  assert.equal(fileDigest(upgrade),RUNTIME_UPGRADE_TOOL_SHA256,'upgrade export pins the checked-in upgrade helper');
  assert.equal(fileDigest(publisher),RUNTIME_UPGRADE_PUBLISHER_SHA256,'upgrade export pins the checked-in publisher');
});

test('upgrade driver preserves the canonical build-origin actor grammar',()=>{
  assert.equal(isValidRuntimeUpgradeActorId('system:artifact-acceptance'),true,'system build provenance remains a valid immutable artifact origin');
  assert.equal(isValidRuntimeUpgradeActorId(`operator:${'123e4567-e89b-42d3-a456-426614174000'}`),true,'paired-operator build provenance remains valid');
  for(const actor of ['SYSTEM:artifact-acceptance','system:','system:bad actor','service:artifact-acceptance','operator:not-a-uuid'])
    assert.equal(isValidRuntimeUpgradeActorId(actor),false,`noncanonical build actor ${actor} is rejected`);
});

test('upgrade targets validate the fixed initializer before import and never fall back to createRuntime',async t=>{
  const legacy=await initializerSnapshot(t,{legacy:true});
  await assert.rejects(loadRuntimeInitializer(legacy.root,legacy.target,undefined),/upgrade-target-runtime-capability-invalid/u);
  assert.equal(await readFile(legacy.marker).then(()=>true,()=>false),false,'legacy module startup side effects do not run during upgrade admission');

  const current=await initializerSnapshot(t);
  const initialize=await loadRuntimeInitializer(current.root,current.target,current.initializer);
  assert.equal(await initialize(), 'versioned-initializer','the fixed export is initializeRuntime even when createRuntime also exists');
});
async function fixture(t,upgradeManager){
  const directory=await mkdtemp(join(tmpdir(),'qb-runtime-upgrade-http-'));
  const store=new ControlPlaneStore(join(directory,'state.sqlite'));
  const server=await createOperatorServer({root:ROOT,store,port:0,pairingCode:PAIRING,upgradeManager});
  t.after(async()=>{try{await server.close();}finally{try{store.close();}finally{await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}});
  return {server,async pair(){const response=await request({server},'/platform-api/session',{method:'POST',json:{code:PAIRING}});
    assert.equal(response.status,200,response.text);return String(response.headers['set-cookie']).split(';',1)[0];}};
}

test('the upgrade manager keeps read-only history attached when the selected native host is unavailable',async t=>{
  const store={managedRuntimeGenerations:()=>[],managedRuntimeUpgrades:()=>[],managedRuntimeUpgrade:()=>undefined};
  const recovery={captureUpgradeNativeHost(){throw Object.assign(new Error('selected profile unavailable'),{code:'RUNTIME_UNAVAILABLE'});}};
  const manager=RuntimeUpgradeManager.create(ROOT,store,{},recovery);
  t.after(()=>manager.close());
  assert.deepEqual(manager.list(INSTANCE),{instanceId:INSTANCE,generations:[],operations:[]});
  assert.equal(manager.operation(OPERATION),undefined);
});

test('migration and publisher launch paths retain original close promises through request failure and bounded shutdown', {
  skip: process.platform !== 'win32' ? 'requires the selected Windows process-owner profile; child launches are mocked' : false
},async t=>{
  const executionRoot=join(ROOT,'.local','platform-runtime-upgrade-executions',`audit-close-${randomUUID()}`);
  await mkdir(executionRoot,{recursive:true});
  const helperPath=join(executionRoot,'build-job.ps1'),scriptPath=join(executionRoot,'runtime-upgrade.mjs'),logPath=join(executionRoot,'private.log');
  await writeFile(helperPath,await readFile(join(ROOT,'tools','build-job.ps1')));
  await writeFile(scriptPath,'console.log("test-owned migration fixture");\n');
  t.after(async()=>rm(executionRoot,{recursive:true,force:true,maxRetries:4,retryDelay:100}));
  const host=captureManagedRuntimeNativeHost(ROOT),scriptDigest=fileDigest(await readFile(scriptPath));
  const store={};
  const manager=RuntimeUpgradeManager.create(ROOT,store,{}, {captureUpgradeNativeHost:()=>host});
  const childProcess=process.getBuiltinModule('node:child_process'),originalSpawn=childProcess.spawn,originalSetTimeout=globalThis.setTimeout;
  const children=[];
  childProcess.spawn=(executable,args)=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.write=(line,encoding,callback)=>{const done=typeof encoding==='function'?encoding:callback;if(done)queueMicrotask(()=>done());return true;};
    child.kill=()=>true;child.exitCode=null;child.signalCode=null;child.pid=12345;
    const nonce=args[args.indexOf('-RunnerNonce')+1];
    const kind=args.includes('-RuntimeProtocol')?'migration':'publisher';children.push({kind,child,nonce});
    if(kind==='migration')queueMicrotask(()=>child.stdout.emit('data',Buffer.from(`QB_READY:${nonce}\n`)));
    return child;
  };
  globalThis.setTimeout=(callback,ms,...args)=>originalSetTimeout(callback,Math.min(ms,25),...args);
  syncBuiltinESMExports();
  t.after(()=>{globalThis.setTimeout=originalSetTimeout;childProcess.spawn=originalSpawn;syncBuiltinESMExports();});
  try {
    const migrationRequest=manager.track((async()=>{
      const proof=await runManagedRuntimeOwnedNativeJob({projectRoot:ROOT,operationRoot:executionRoot,helperPath,scriptPath,logPath,scriptDigest,
        args:['--operation','fixture'],expectedHost:host,timeoutMs:600000,authorize:()=>undefined,registerOwnedClosure:promise=>manager.trackClosure(promise)});
      if(!proof.emptyObserved||!proof.helperClosed)throw Object.assign(new Error('migration request could not prove original child close'),{code:'RUNTIME_UPGRADE_UNKNOWN'});
      return proof;
    })());
    await assert.rejects(migrationRequest,error=>error.code==='RUNTIME_UPGRADE_UNKNOWN');
    assert.equal(children.filter(row=>row.kind==='migration').length,1,'the fixed managed migration launch path used the mocked child');
    await Promise.resolve();
    assert.equal(manager.operations.size,0,'the failed migration request is removed independently from its unresolved process close');
    assert.equal(manager.ownedClosures.size,1,'the original migration ChildProcess close promise remains registered');

    const publisherProof=await manager.publish(host,{operationId:randomUUID(),instanceId:INSTANCE,targetDigest:ARTIFACT});
    assert.equal(publisherProof.status,'UNKNOWN');assert.equal(publisherProof.closed,false);
    assert.equal(children.filter(row=>row.kind==='publisher').length,1,'the fixed publisher launch path used the mocked child');
    assert.equal(manager.ownedClosures.size,2,'publisher timeout adds a second independent original close promise');

    let clockCall=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clockCall++===0?0:60001});
    try { await assert.rejects(manager.close(),error=>error.code==='RUNTIME_UPGRADE_UNKNOWN'); }
    finally { delete performance.now; }
    assert.equal(manager.ownedClosures.size,2,'bounded shutdown reports UNKNOWN without discarding migration or publisher owners');

    const migrationChild=children.find(row=>row.kind==='migration').child;
    migrationChild.exitCode=1;migrationChild.emit('close',1,null);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(manager.ownedClosures.size,1,'the late migration close settles only the original migration obligation');
    const publisherChild=children.find(row=>row.kind==='publisher').child;
    publisherChild.exitCode=0;publisherChild.emit('close',0,null);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(manager.ownedClosures.size,0,'the late publisher close settles its original obligation');
    await manager.close();
  } finally {
    for(const {child} of children)if(child.exitCode===null){child.exitCode=1;child.emit('close',1,null);}
    await manager.close();
  }
});

test('the real control-plane shutdown keeps recovery, registry, and SQLite open after UNKNOWN and retries after the original close',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'qb-upgrade-controller-close-')),root=join(temp,'checkout');
  await copyReviewedBuildInputs(ROOT,root);
  await mkdir(join(root,'tools'),{recursive:true});
  for(const name of ['registry-publish.ps1','runtime-supervisor.mjs','runtime-recovery.mjs','runtime-recovery-publish.ps1','runtime-upgrade.mjs','runtime-upgrade-publish.ps1'])
    await copyFile(join(ROOT,'tools',name),join(root,'tools',name));
  await mkdir(join(root,'apps/studio-web/dist'),{recursive:true});
  await copyFile(join(ROOT,'apps/studio-web/dist/main.js'),join(root,'apps/studio-web/dist/main.js'));
  const counts={recovery:0,registry:0,store:0};
  const originals={upgrade:RuntimeUpgradeManager.prototype.close,recovery:RuntimeRecoveryManager.prototype.close,
    registry:LocalArtifactStore.prototype.close,store:ControlPlaneStore.prototype.close,worker:LocalBuildWorker.prototype.close};
  let releaseOriginalClose,originalClosePromise,controller,perfRestored=false;
  RuntimeUpgradeManager.prototype.close=function(...args){
    if(!originalClosePromise){originalClosePromise=new Promise(resolve=>{releaseOriginalClose=resolve;});this.trackClosure(originalClosePromise);}
    return originals.upgrade.apply(this,args);
  };
  RuntimeRecoveryManager.prototype.close=function(...args){counts.recovery++;return originals.recovery.apply(this,args);};
  LocalArtifactStore.prototype.close=function(...args){counts.registry++;return originals.registry.apply(this,args);};
  ControlPlaneStore.prototype.close=function(...args){counts.store++;return originals.store.apply(this,args);};
  const restorePerf=()=>{if(perfRestored)return;delete performance.now;perfRestored=true;};
  t.after(async()=>{
    restorePerf();
    releaseOriginalClose?.();
    try{await controller?.close();}catch{}
    RuntimeUpgradeManager.prototype.close=originals.upgrade;
    RuntimeRecoveryManager.prototype.close=originals.recovery;
    LocalArtifactStore.prototype.close=originals.registry;
    ControlPlaneStore.prototype.close=originals.store;
    LocalBuildWorker.prototype.close=originals.worker;
    await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  controller=await startControlPlane({root,databasePath:join(temp,'control-plane.sqlite'),port:0});
  let clockCall=0;
  Object.defineProperty(performance,'now',{configurable:true,value:()=>clockCall++===0?0:60001});
  try{await assert.rejects(controller.close(),error=>error.code==='RUNTIME_UPGRADE_UNKNOWN');}
  finally{restorePerf();}
  assert.deepEqual(counts,{recovery:0,registry:0,store:0},'failed upgrade-owner close prevents downstream manager and storage closure');
  releaseOriginalClose();await new Promise(resolve=>setImmediate(resolve));
  await controller.close();
  assert.deepEqual(counts,{recovery:1,registry:1,store:1},'a retry after the exact late close settles dependent services once');
});

test('plural generation-upgrade routes require pairing and explicit exact-input confirmation',async t=>{
  const calls=[];
  const operation={id:OPERATION,instanceId:INSTANCE,sourceGenerationId:'generation:source:1',targetGenerationId:'generation:target:2',
    sourceAttemptId:'123e4567-e89b-42d3-a456-426614174002',sourceAttempt:1,sourceCommandId:'123e4567-e89b-42d3-a456-426614174003',
    sourceBackupDigest:BACKUP,targetVersion:'0.2.4',targetArtifactDigest:ARTIFACT,state:'SUCCEEDED',physicalState:'CLEAN',
    dispatchBegun:1,driverEmpty:1,driverClosed:1,stagingClean:1,publisherResultObserved:1,publisherClosed:1,destinationPublished:1,destinationVerified:1};
  const upgradeManager={list:id=>({instanceId:id,generations:[],operations:[operation]}),operation:id=>id===OPERATION?operation:undefined,
    upgrade:(input,actor,authorize)=>{authorize();calls.push({input,actor});return Promise.resolve(operation);}};
  const context=await fixture(t,upgradeManager),path=`/platform-api/runtime-instances/${INSTANCE}/upgrades`;
  assert.equal((await request(context,path)).status,401,'upgrade history is paired');
  const cookie=await context.pair();
  const listed=await request(context,path,{cookie});assert.equal(listed.status,200,listed.text);
  const listedOperation=body(listed).operations[0];assert.equal(body(listed).operations.length,1);
  for(const field of ['ownerToken','ownerId','requestKey','payloadDigest'])assert.equal(Object.hasOwn(listedOperation,field),false);
  for(const field of ['dispatchBegun','driverEmpty','driverClosed','stagingClean','publisherResultObserved','publisherClosed','destinationPublished','destinationVerified']){
    assert.equal(listedOperation[field],true,`${field} is represented as a JSON boolean`);
    assert.equal(typeof listedOperation[field],'boolean');
  }
  const operationRead=await request(context,`/platform-api/runtime-upgrades/${OPERATION}`,{cookie});assert.equal(operationRead.status,200);
  assert.equal(body(operationRead).driverEmpty,true);
  const input={confirm:true,targetVersion:'0.2.4',targetArtifactDigest:ARTIFACT,sourceBackupDigest:BACKUP,requestKey:'upgrade-http-key-001'};
  assert.equal((await request(context,`/platform-api/runtime-instances/${INSTANCE}/upgrade`,{method:'POST',cookie,json:input})).status,404,
    'there is no singular or compatibility alias');
  assert.equal((await request(context,path,{method:'POST',cookie,json:{...input,confirm:false}})).status,400);
  assert.equal((await request(context,path,{method:'POST',cookie,json:{...input,privatePath:'C:/secret'}})).status,400);
  assert.equal(calls.length,0);
  const submitted=await request(context,path,{method:'POST',cookie,json:input});
  assert.equal(submitted.status,202,submitted.text);assert.equal(body(submitted).id,OPERATION);assert.equal(body(submitted).driverEmpty,true);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].input,{instanceId:INSTANCE,targetVersion:'0.2.4',targetArtifactDigest:ARTIFACT,
    sourceBackupDigest:BACKUP,requestKey:input.requestKey,confirm:true});
  assert.match(calls[0].actor,/^operator:[0-9a-f-]{36}$/);
});
