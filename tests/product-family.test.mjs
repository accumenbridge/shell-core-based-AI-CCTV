import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime, ROOT } from '../apps/runtime/dist/index.js';
import { canonical } from '../packages/contracts/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { resolve as resolveProduct } from '../packages/composition/dist/index.js';
import { deriveFamily, validateProductFamily } from '../packages/composition/dist/family.js';
import { LocalArtifactStore } from '../apps/control-plane/dist/artifact-store.js';
import { LocalBuildWorker } from '../apps/control-plane/dist/build-worker.js';
import { ManagedRuntimeManager, runtimeDataDirectory, copyVerifiedRuntimeSnapshot, runtimeSnapshotExpected, linkCopiedRuntimeWorkspaces } from '../apps/control-plane/dist/runtime-manager.js';
import { copyPrivateToolchain, copyReviewedBuildInputs } from '../apps/control-plane/dist/build-inputs.js';
import { importSourceSnapshot, loadSourceSnapshot } from '../apps/control-plane/dist/source-import.js';
import { readCatalogue } from '../tools/studio-catalogue.mjs';

const identity = id => ({ id, title: 'Service Operations', version: '1.0.0', description: '', layout: 'sidebar' });
const WINDOWS = process.platform === 'win32';

async function waitForBuild(store,id,timeoutMs=180000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){const row=store.build(id);if(row&&['SUCCEEDED','FAILED','CANCELLED'].includes(row.state))return row;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('The family build did not settle within its bounded fixture deadline');
}
async function responseJson(response,label){
  const text=await response.text();assert.equal(response.status,200,`${label} returned an unexpected status`);return JSON.parse(text);
}
async function loginRuntime(base,credentials){
  const admin=credentials.principals?.find(principal=>principal.id==='admin');assert.ok(admin?.password,'the private generated admin credential exists');
  const login=await fetch(`${base}/api/session`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:admin.password})});
  assert.equal(login.status,200,'the private generated administrator can authenticate');
  const cookie=login.headers.get('set-cookie')?.split(';',1)[0];assert.ok(cookie);
  return cookie;
}
function runtimeHeaders(base,cookie,tenant='customer-a',writeKey){
  return {Origin:base,Cookie:cookie,'X-QB-Tenant':tenant,'Content-Type':'application/json',...(writeKey?{'Idempotency-Key':writeKey}:{})};
}

test('Service Operations derives three exact source-grounded business selections through the canonical composer', async () => {
  const family = JSON.parse(await readFile(pathResolve(ROOT, 'families/service-operations/family.json'), 'utf8'));
  const catalogue = await readCatalogue(ROOT);
  const source = catalogue.families.find(item => item.id === 'service-operations');
  assert.ok(source);
  const cases = [
    { selection: ['requests'], modules: ['service-desk'], bindings: 0, worker: false },
    { selection: ['requests','shared-library'], modules: ['knowledge','service-desk'], bindings: 0, worker: true },
    { selection: ['requests','shared-library','document-handoff'], modules: ['handoff','knowledge','service-desk'], bindings: 2, worker: true }
  ];
  for (const [index, row] of cases.entries()) {
    const input = [...row.selection];
    const result = deriveFamily(source, input, identity(`family-variant-${index + 1}`), catalogue.modules, catalogue.solutions);
    assert.deepEqual(input, row.selection, 'pure derivation does not mutate the caller selection');
    assert.deepEqual(result.product.modules.map(module => module.id).sort(), row.modules);
    assert.equal(result.product.bindings.length, row.bindings);
    assert.equal(result.plan.requiresWorker, row.worker);
    assert.equal(result.product.description, '');
    assert.deepEqual(result.derivation.selection, [...row.selection].sort());
    assert.deepEqual(result.technicalExplanations.map(item => item.moduleId), row.modules);
  }
  const full = deriveFamily(source, cases[2].selection, identity('family-reordered'), catalogue.modules, catalogue.solutions);
  const reordered = deriveFamily(source, [...cases[2].selection].reverse(), identity('family-reordered'), catalogue.modules, catalogue.solutions);
  assert.deepEqual(reordered, full);
  assert.throws(() => deriveFamily(source, ['requests','document-handoff'], identity('family-invalid'), catalogue.modules, catalogue.solutions),
    error => error.code === 'FAMILY_REQUIREMENT_UNMET' && /Shared library/.test(error.message));
  assert.throws(() => validateProductFamily({ ...family, executable: 'file:///tmp/module.mjs' }), error => error.code === 'FAMILY_INVALID');
});

test('family derivation rejects unavailable modules and never silently selects a new default port', async () => {
  const catalogue = await readCatalogue(ROOT);
  const family = catalogue.families.find(item => item.id === 'service-operations');
  const identityValue = identity('family-unavailable');
  const missingModule = structuredClone(family);
  missingModule.features[0].moduleIds = ['not-registered'];
  assert.throws(() => deriveFamily(missingModule, ['requests'], identityValue, catalogue.modules, catalogue.solutions),
    error => error.code === 'FAMILY_IMPLEMENTATION_UNAVAILABLE');
  const newPort = structuredClone(family);
  newPort.features.find(item => item.id === 'document-handoff').bindingChoices = {};
  assert.throws(() => deriveFamily(newPort, ['requests','shared-library','document-handoff'], identityValue, catalogue.modules, catalogue.solutions),
    error => error.code === 'FAMILY_BINDING_UNAVAILABLE');
});

test('three family variants build, register, promote and run as exact owned local artifacts', {skip:!WINDOWS}, async t=>{
  const temp=await mkdtemp(join(tmpdir(),'qf-')),root=join(temp,'checkout'),dbPath=join(temp,'control-plane.sqlite');
  let store,worker,artifacts,runtimes,runtimeOwnerClosed=false,settled=true,publicationUncertain=false;
  t.after(async()=>{
    const failures=[];
    try{await runtimes?.close();runtimeOwnerClosed=true;}catch(error){settled=false;failures.push(new Error('The exact managed family owner did not close positively',{cause:error}));}
    try{await worker?.close();}catch(error){failures.push(new Error('The private compiler worker did not close',{cause:error}));}
    if(runtimeOwnerClosed){try{await artifacts?.close();}catch(error){settled=false;failures.push(new Error('The private artifact registry did not close',{cause:error}));}
      if(store){
        try{
          const slot=store.artifactRegistrySlot();
          const operations=store.artifactOperations(200);
          if(slot?.operationId||operations.some(row=>row.state==='UNKNOWN'||row.physicalState==='UNKNOWN'))publicationUncertain=true;
        }catch(error){publicationUncertain=true;failures.push(new Error('The durable registry uncertainty could not be checked; fixture retained',{cause:error}));}
      }
      try{await store?.close();}catch(error){failures.push(new Error('The family control-plane database did not close',{cause:error}));}}
    if(publicationUncertain){settled=false;failures.push(new Error('Registry publication is uncertain; fixture retained for owner reconciliation'));}
    if(failures.length)throw new AggregateError(failures,`Family runtime fixture retained at ${temp}`);
    if(settled)await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await copyReviewedBuildInputs(ROOT,root);
  await copyPrivateToolchain(ROOT,root);
  await mkdir(join(root,'.local'),{recursive:true});
  for(const file of ['platform-build-host.json'])await copyFile(join(ROOT,'.local',file),join(root,'.local',file));
  for(const file of ['registry-publish.ps1','runtime-supervisor.mjs','runtime-recovery.mjs','runtime-recovery-publish.ps1'])
    await copyFile(join(ROOT,'tools',file),join(root,'tools',file));
  const snapshot=loadSourceSnapshot(root),catalogue=await readCatalogue(root),family=catalogue.families.find(item=>item.id==='service-operations');
  assert.ok(family,'the privately copied snapshot carries the reviewed family mapping');
  store=new ControlPlaneStore(dbPath);importSourceSnapshot(store,snapshot);
  artifacts=await LocalArtifactStore.create(root,store);
  worker=await LocalBuildWorker.create({root,store,snapshot,pollMs:50,leaseMs:30000,timeoutMs:120000});await worker.start();
  const productId='family-ops',operator='system:family-core-journey';
  const variants=[
    {version:'1.0.0',selection:['requests'],modules:['service-desk'],worker:false},
    {version:'1.0.1',selection:['requests','shared-library'],modules:['knowledge','service-desk'],worker:true},
    {version:'1.0.2',selection:['requests','shared-library','document-handoff'],modules:['handoff','knowledge','service-desk'],worker:true}
  ];
  const builtVariants=[];
  for(const variant of variants){
    const derived=deriveFamily(family,variant.selection,{...identity(productId),version:variant.version,title:`Service Operations ${variant.version}`},snapshot.modules,snapshot.solutions);
    assert.deepEqual(derived.product.modules.map(item=>item.id).sort(),variant.modules);
    assert.equal(derived.plan.requiresWorker,variant.worker);
    const provenance={...derived.derivation,productDigest:createHash('sha256').update(canonical(derived.product)).digest('hex'),sourceFingerprint:snapshot.sourceFingerprint};
    store.putProduct(derived.product,operator,undefined,provenance);
    assert.deepEqual(store.productFamilyDerivation(productId,variant.version),provenance);
    const plan=resolveProduct(store.product(productId,variant.version),snapshot.modules);
    const admitted=await worker.admit(plan.product,plan,`family-${variant.version}-build-${randomUUID()}`,operator);
    const built=await waitForBuild(store,admitted.id);
    assert.equal(built.state,'SUCCEEDED',`family ${variant.version} is built by the actual fixed local worker`);
    assert.equal(built.productId,productId);assert.equal(built.version,variant.version);assert.ok(built.snapshotDigest);
    let registered;
    try{registered=await artifacts.register(built.id,operator,()=>undefined);}
    catch(error){
      const descriptor=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'__qbRegistryPublisherDiagnostics'):undefined;
      if((error&&typeof error==='object'&&(error).code==='ARTIFACT_PUBLICATION_UNKNOWN')||descriptor?.enumerable===false)publicationUncertain=true;
      throw error;
    }
    const verified=await artifacts.verifyArtifact(registered.digest);
    await artifacts.promote(productId,variant.version,registered.digest,operator,()=>undefined);
    const webEntry=verified.snapshot.entries.find(entry=>entry.path===`.artifacts/${productId}/web.json`);
    assert.ok(webEntry,'the exact registered snapshot includes its immutable selected web manifest');
    const web=JSON.parse(webEntry.bytes.toString('utf8'));
    for(const moduleId of ['service-desk','knowledge','handoff']){
      const included=variant.modules.includes(moduleId);
      assert.equal(Object.keys(web.imports).some(key=>key===`@quadbridge/${moduleId}/ui`),included,`${variant.version} web import closure follows selected modules`);
      assert.equal(Object.keys(web.files).some(path=>path.startsWith(`/assets/modules/${moduleId}/`)),included,`${variant.version} served asset closure follows selected modules`);
    }
    assert.equal(verified.snapshot.manifest.productId,productId);
    builtVariants.push({variant,registered,verified});
  }
  await worker.close();worker=undefined;
  runtimes=ManagedRuntimeManager.create(root,store,artifacts);
  const records=new Map();
  for(const [index,{variant,registered,verified}] of builtVariants.entries()){
    assert.equal(verified.snapshot.manifest.productId,productId);
    const sampleInstance='runtime-00000000-0000-4000-8000-000000000000',sampleOperation='00000000-0000-4000-8000-000000000000';
    const sampleSnapshotRoot=join(root,'.local','platform-runtime-executions',sampleInstance,sampleOperation,'snapshot');
    const longestRuntimeCopyPath=Math.max(...verified.snapshot.entries.map(entry=>join(sampleSnapshotRoot,...entry.path.split('/')).length));
    assert.ok(longestRuntimeCopyPath<240,`the exact runtime copy paths exceed the maintained bound (${longestRuntimeCopyPath})`);
    const started=await runtimes.start({productId,version:variant.version,requestKey:`family-${variant.version}-start-${randomUUID()}`},operator,()=>undefined);
    assert.equal(started.command.state,'SUCCEEDED');assert.equal(started.instance.state,'RUNNING');assert.ok(started.operationId);
    assert.equal(started.instance.workerRequired,variant.worker);
    const instanceId=started.instance.id,detail=runtimes.detail(instanceId);
    assert.equal(detail.processObservation,'owned-in-this-process');assert.ok(detail.url);
    const credentials=JSON.parse(await readFile(join(runtimeDataDirectory(root,instanceId,registered.digest),'credentials.json'),'utf8'));
    const cookie=await loginRuntime(detail.url,credentials);
    const health=await fetch(`${detail.url}/api/health`);assert.equal(health.status,200);
    if(index===0){
      assert.equal((await fetch(`${detail.url}/api/documents`,{headers:runtimeHeaders(detail.url,cookie)})).status,404,'Desk-only variant omits Knowledge routes');
      assert.equal((await fetch(`${detail.url}/api/handoffs`,{headers:runtimeHeaders(detail.url,cookie)})).status,404,'Desk-only variant omits Handoff routes');
      assert.equal((await fetch(`${detail.url}/assets/modules/knowledge/ui.js`)).status,404,'Desk-only variant does not serve Knowledge assets');
      const created=await fetch(`${detail.url}/api/requests`,{method:'POST',headers:runtimeHeaders(detail.url,cookie,'customer-a','family-desk-create-0001'),body:JSON.stringify({title:'Family desk persistence',details:'Created in the Requests-only variant.'})});
      const request=await responseJson(created,'Desk request create');
      const listed=await responseJson(await fetch(`${detail.url}/api/requests`,{headers:runtimeHeaders(detail.url,cookie)}),'Desk request read');
      assert.ok(listed.items.some(item=>item.id===request.id&&item.title==='Family desk persistence'));
      const closed=await fetch(`${detail.url}/api/requests/close`,{method:'POST',headers:runtimeHeaders(detail.url,cookie,'customer-a','family-desk-close-0001'),body:JSON.stringify({id:request.id,expectedVersion:request.version})});
      assert.equal((await responseJson(closed,'Desk request close')).state,'CLOSED');
      records.set('deskRequestId',request.id);
    }else{
      if(index===1){
        const created=await fetch(`${detail.url}/api/requests`,{method:'POST',headers:runtimeHeaders(detail.url,cookie,'customer-a','family-middle-desk-create-0001'),body:JSON.stringify({title:'Library variant request',details:'The middle family retains its selected Desk feature.'})});
        const request=await responseJson(created,'middle variant Desk request create');
        const listed=await responseJson(await fetch(`${detail.url}/api/requests`,{headers:runtimeHeaders(detail.url,cookie)}),'middle variant Desk request read');
        assert.ok(listed.items.some(item=>item.id===request.id&&item.title==='Library variant request'));
        records.set('middleDeskRequestId',request.id);
      }
      const documentResponse=await fetch(`${detail.url}/api/documents`,{method:'POST',headers:runtimeHeaders(detail.url,cookie,'customer-a',`family-document-${index}-0001`),body:JSON.stringify({title:`Family reference ${variant.version}`,body:'familylibraryneedle indexed evidence for actual selected Knowledge runtime'})});
      const document=await responseJson(documentResponse,'Knowledge document create');assert.equal(document.state,'PENDING');
      const deadline=Date.now()+30000;let listed;
      while(Date.now()<deadline){listed=await responseJson(await fetch(`${detail.url}/api/documents`,{headers:runtimeHeaders(detail.url,cookie)}),'Knowledge document listing');
        const current=listed.items.find(item=>item.id===document.id);if(current?.state==='READY'&&current?.indexJob?.state==='SUCCEEDED')break;await new Promise(resolve=>setTimeout(resolve,100));}
      const ready=listed?.items.find(item=>item.id===document.id);assert.equal(ready?.state,'READY','the actual separate module worker indexes the document');assert.equal(ready?.indexJob?.state,'SUCCEEDED');
      const search=await responseJson(await fetch(`${detail.url}/api/documents/search?q=familylibraryneedle`,{headers:runtimeHeaders(detail.url,cookie)}),'Knowledge search');
      assert.ok(search.items.some(item=>item.id===document.id&&item.title===document.title));
      const documentRows=await responseJson(await fetch(`${detail.url}/api/documents`,{headers:runtimeHeaders(detail.url,cookie)}),'Knowledge document read');
      assert.ok(documentRows.items.some(item=>item.id===document.id&&item.state==='READY'&&item.indexJob?.state==='SUCCEEDED'));
      records.set(`${variant.version}:documentId`,document.id);
      assert.equal((await fetch(`${detail.url}/api/handoffs`,{headers:runtimeHeaders(detail.url,cookie)})).status,index===1?404:200,
        index===1?'Library variant omits Handoff route':'Full family includes the reviewed Handoff route');
      assert.equal((await fetch(`${detail.url}/assets/modules/handoff/ui.js`)).status,index===1?404:200,'selected asset closure follows the family variant');
      if(index===2){
        const options=await responseJson(await fetch(`${detail.url}/api/handoffs/options`,{headers:runtimeHeaders(detail.url,cookie)}),'Knowledge document contract read');
        assert.ok(options.documents.some(item=>item.id===document.id&&item.title===document.title),'selected Handoff reads the Knowledge document through the existing public binding');
        const posted=await fetch(`${detail.url}/api/handoffs`,{method:'POST',headers:runtimeHeaders(detail.url,cookie,'customer-a','family-handoff-create-0001'),body:JSON.stringify({documentId:document.id,reason:'Use this approved indexed reference to resolve the request.'})});
        const accepted=await responseJson(posted,'Handoff creation');
        const replay=await fetch(`${detail.url}/api/handoffs`,{method:'POST',headers:runtimeHeaders(detail.url,cookie,'customer-a','family-handoff-create-0001'),body:JSON.stringify({documentId:document.id,reason:'Use this approved indexed reference to resolve the request.'})});
        const replayed=await responseJson(replay,'Handoff idempotent replay');assert.equal(replayed.id,accepted.id);
        const handoffDeadline=Date.now()+30000;let handoffs;
        while(Date.now()<handoffDeadline){handoffs=await responseJson(await fetch(`${detail.url}/api/handoffs`,{headers:runtimeHeaders(detail.url,cookie)}),'Handoff list');
          const row=handoffs.items.find(item=>item.id===accepted.id);if(row?.outcome==='DESTINATION_COMMITTED')break;await new Promise(resolve=>setTimeout(resolve,100));}
        const committed=handoffs?.items.find(item=>item.id===accepted.id);
        assert.equal(committed?.outcome,'DESTINATION_COMMITTED','the reviewed local destination commits the actual receipt');
        assert.equal(committed?.acceptance?.state,'COMMITTED');assert.equal(committed?.acceptance?.receipt?.outcome,'COMMITTED');
        const destinationRequestId=committed.acceptance.receipt.resource.id;
        const desk=await responseJson(await fetch(`${detail.url}/api/requests`,{headers:runtimeHeaders(detail.url,cookie)}),'Destination-owned request read');
        assert.ok(desk.items.some(item=>item.id===destinationRequestId),'the destination owns the committed request');
        records.set('handoffId',accepted.id);records.set('documentId',document.id);records.set('destinationRequestId',destinationRequestId);
      }
    }
      const stopped=await runtimes.stop({instanceId,requestKey:`family-${variant.version}-stop-${randomUUID()}`},operator,()=>undefined);
    assert.equal(stopped.command.state,'SUCCEEDED');assert.equal(stopped.instance.state,'STOPPED');
    const attempt=stopped.instance.attempts.find(item=>item.id===started.operationId);
    assert.equal(attempt?.emptyObserved,true);assert.equal(attempt?.helperClosed,true);assert.equal(attempt?.executionClean,true);
    assert.equal(store.managedRuntimeSlot().occupied,false);
    if(index===1){
      const inspectionRoot=join(temp,'inspect');
      copyVerifiedRuntimeSnapshot(verified.snapshot,inspectionRoot,runtimeSnapshotExpected(verified.snapshot));
      linkCopiedRuntimeWorkspaces(inspectionRoot);
      const storedConfig=JSON.parse(await readFile(join(runtimeDataDirectory(root,instanceId,registered.digest),'runtime-config.json'),'utf8'));
      let inspection;
      try{
        inspection=await createRuntime(productId,storedConfig,inspectionRoot);
        const admin=credentials.principals.find(principal=>principal.id==='admin');
        const session=inspection.access.login('admin',admin.password),actor=session.actor;
        const assertOriginal=()=>{const current=inspection.access.authenticate(session.token);if(current.id!==actor.id||current.kind!==actor.kind)throw new Error('The original Knowledge read identity changed');};
        const descriptor=inspection.host.operationCatalogue(actor,'customer-a',assertOriginal).find(item=>item.id==='knowledge.documents.get'&&item.version===1);
        assert.ok(descriptor,'the exact promoted middle export declares its Knowledge get operation');
        const projection=await inspection.host.invokeOperation(descriptor.id,descriptor.version,actor,'customer-a',{documentId:records.get(`${variant.version}:documentId`)},
          undefined,new AbortController().signal,randomUUID(),assertOriginal);
        assert.equal(projection.id,records.get(`${variant.version}:documentId`));
        assert.equal(projection.state,'READY');assert.ok(projection.excerpt.includes('familylibraryneedle'));
        assert.equal(projection.bodyDigest,createHash('sha256').update('familylibraryneedle indexed evidence for actual selected Knowledge runtime','utf8').digest('hex'));
      }finally{await inspection?.close();}
    }
    records.set(variant.version,{instanceId,version:variant.version,digest:registered.digest,attempt:started.operationId});
    if(index===2){
      const restarted=await runtimes.restart({instanceId,requestKey:'family-full-restart-0001'},operator,()=>undefined);
      assert.equal(restarted.command.state,'SUCCEEDED');assert.equal(restarted.instance.state,'RUNNING');assert.equal(restarted.instance.currentAttempt,2);
      const afterRestart=runtimes.detail(instanceId),credentialsAfter=JSON.parse(await readFile(join(runtimeDataDirectory(root,instanceId,registered.digest),'credentials.json'),'utf8'));
      assert.deepEqual(credentialsAfter,credentials,'full variant restart reuses the original private credentials');
      const nextCookie=await loginRuntime(afterRestart.url,credentialsAfter);
      const documentsAfterRestart=await responseJson(await fetch(`${afterRestart.url}/api/documents`,{headers:runtimeHeaders(afterRestart.url,nextCookie)}),'Knowledge document read after restart');
      const retainedDocument=documentsAfterRestart.items.find(item=>item.id===records.get(`${variant.version}:documentId`));
      assert.equal(retainedDocument?.state,'READY');assert.equal(retainedDocument?.indexJob?.state,'SUCCEEDED');
      const searchAfterRestart=await responseJson(await fetch(`${afterRestart.url}/api/documents/search?q=familylibraryneedle`,{headers:runtimeHeaders(afterRestart.url,nextCookie)}),'Knowledge search after restart');
      assert.ok(searchAfterRestart.items.some(item=>item.id===records.get(`${variant.version}:documentId`)));
      const persistedHandoffs=await responseJson(await fetch(`${afterRestart.url}/api/handoffs`,{headers:runtimeHeaders(afterRestart.url,nextCookie)}),'Persisted handoff read after restart');
      const retained=persistedHandoffs.items.find(item=>item.id===records.get('handoffId'));
      assert.equal(retained?.outcome,'DESTINATION_COMMITTED');assert.equal(retained?.acceptance?.receipt?.outcome,'COMMITTED');
      assert.equal(retained?.acceptance?.receipt?.resource?.id,records.get('destinationRequestId'));
      const destinationRows=await responseJson(await fetch(`${afterRestart.url}/api/requests`,{headers:runtimeHeaders(afterRestart.url,nextCookie)}),'Destination request read after restart');
      assert.ok(destinationRows.items.some(item=>item.id===records.get('destinationRequestId')));
      const finalStop=await runtimes.stop({instanceId,requestKey:'family-full-final-stop-0001'},operator,()=>undefined);
      assert.equal(finalStop.command.state,'SUCCEEDED');assert.equal(finalStop.instance.state,'STOPPED');
      const finalAttempt=finalStop.instance.attempts.find(item=>item.id===restarted.operationId);
      assert.equal(finalAttempt?.emptyObserved,true);assert.equal(finalAttempt?.helperClosed,true);assert.equal(finalAttempt?.executionClean,true);
      assert.equal(store.managedRuntimeSlot().occupied,false);
    }
  }
  assert.equal(store.managedRuntimeInstances().filter(instance=>instance.state==='STOPPED').length,3,'the three exact family variants remain separately recorded');
});
