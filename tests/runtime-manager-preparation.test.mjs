import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonical } from '@quadbridge/contracts';
import { adaptCanonicalLocalConfiguration, completedRuntimeEnrollment, copyVerifiedRuntimeSnapshot, enrollOrVerifyRuntimeAccess, linkCopiedRuntimeWorkspaces, ManagedRuntimeManager, MANAGED_RUNTIME_MODEL_PROFILE, parseManagedRuntimeModelProfile, prepareRuntimeEnrollment, resolveManagedRuntimeModelProfile, RuntimePreparationError, runtimeDataDirectory, runtimePlanIdentity, runtimePrivateRoot, runtimeSupportsManagedModelProfile } from '../apps/control-plane/dist/runtime-manager.js';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const bytesEntry=(path,value)=>{const bytes=Buffer.from(canonical(value));return {path,bytes,digest:sha256(bytes),sizeBytes:bytes.length};};
const project=resolve('.');

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'q-'));
  t.after(()=>{
    rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  runtimePrivateRoot(root);
  return {root};
}

function enrollmentInput(root,adapted,instanceId,artifactDigest){
  const dataDirectory=runtimeDataDirectory(root,instanceId,artifactDigest);
  const identity={instanceId,productId:'sample-product',version:'1.2.3',artifactDigest,
    profileDigest:adapted.planIdentity.profileDigest,configDigest:adapted.configuration.configDigest,adapterDigest:'d'.repeat(64)};
  const {config,seedPrincipals,seedDigest}=adapted.configuration;
  return {projectRoot:root,executionRoot:project,dataDirectory,identity,config,seedPrincipals,seedDigest};
}

async function canonicalFixture(root,modelProfile){
  const plan={product:{id:'sample-product',version:'1.2.3'},modules:[{id:'knowledge',provides:['desk.requests.create.v2'],permissions:['desk.create'],routes:[]}],
    bindings:[
      {instanceId:'local-desk',mode:'local',consumer:'knowledge',contract:'desk.requests.create.v2',implementation:'service-desk'},
      {instanceId:'local-documents',mode:'local',consumer:'knowledge',contract:'knowledge.document.read.v1',implementation:'knowledge'}
    ],requiresWorker:true,permissions:['desk.create']};
  const profile={id:'quadbridge.local-developer.v1',profile:'loopback-developer-only',defaultTenants:['customer-a'],providerSeeds:[{contract:'desk.requests.create.v2',serviceActor:'knowledge-link',permissions:['desk.create']}],connections:[{contract:'desk.requests.create.v2',revision:'local-link-v2',serviceActor:'knowledge-link'}]};
  const snapshot={entries:[bytesEntry('.artifacts/sample-product/plan.json',plan),bytesEntry('profiles/local-developer.json',profile)]};
  const planIdentity=runtimePlanIdentity(snapshot,'sample-product','1.2.3');
  const instanceId=`runtime-${randomUUID()}`,artifactDigest='a'.repeat(64);
  const adaptedConfiguration=await adaptCanonicalLocalConfiguration({executionRoot:project,planIdentity,instanceId,
    dataDirectory:runtimeDataDirectory(root,instanceId,artifactDigest),credentialReference:`${instanceId}:${artifactDigest}`,modelProfile});
  return {planIdentity,configuration:adaptedConfiguration,instanceId,artifactDigest,snapshot};
}

test('canonical runtime adapter accepts helper-omitted local document bindings and changes only reviewed local identity fields',async t=>{
  const {root}=fixture(t),adapted=await canonicalFixture(root);
  assert.equal(adapted.planIdentity.workerRequired,true);
  assert.deepEqual(Object.keys(adapted.configuration.config.connections),['local-desk']);
  assert.equal(adapted.configuration.config.connections['local-desk'].destinationInstance,adapted.instanceId);
  assert.equal(adapted.configuration.config.principals.length,0);
  assert.ok(adapted.configuration.seedPrincipals.some(principal=>principal.id==='admin'&&principal.password));
  assert.ok(adapted.configuration.seedPrincipals.some(principal=>principal.id==='knowledge-link'&&principal.serviceToken));
});

test('managed model policy is a fixed bootstrap choice, captured before enrollment digest, and retained without reseeding',async t=>{
  assert.equal(parseManagedRuntimeModelProfile(undefined),undefined);
  assert.equal(resolveManagedRuntimeModelProfile(''),undefined);
  assert.equal(parseManagedRuntimeModelProfile(MANAGED_RUNTIME_MODEL_PROFILE),MANAGED_RUNTIME_MODEL_PROFILE);
  assert.throws(()=>resolveManagedRuntimeModelProfile('ollama-qwen3-4b'),/not supported/);

  const {root}=fixture(t),adapted=await canonicalFixture(root,MANAGED_RUNTIME_MODEL_PROFILE);
  assert.equal(adapted.configuration.config.modelAnswerProfile,MANAGED_RUNTIME_MODEL_PROFILE);
  const withoutPolicy={...adapted.configuration.config};delete withoutPolicy.modelAnswerProfile;
  assert.notEqual(adapted.configuration.configDigest,
    sha256(canonical({config:withoutPolicy,seedDigest:adapted.configuration.seedDigest,profileDigest:adapted.planIdentity.profileDigest})),
    'the selected policy participates in the immutable config digest');
  const dataDirectory=runtimeDataDirectory(root,adapted.instanceId,adapted.artifactDigest);
  const identity={instanceId:adapted.instanceId,productId:'sample-product',version:'1.2.3',artifactDigest:adapted.artifactDigest,
    profileDigest:adapted.planIdentity.profileDigest,adapterDigest:'d'.repeat(64)};
  const fresh=adapted.configuration;
  const enrollment={projectRoot:root,executionRoot:project,dataDirectory,identity:{...identity,configDigest:fresh.configDigest},
    config:fresh.config,seedPrincipals:fresh.seedPrincipals,seedDigest:fresh.seedDigest,authorize:()=>true};
  assert.equal(await enrollOrVerifyRuntimeAccess(enrollment),'ENROLLED');
  const intent=JSON.parse(fs.readFileSync(join(dataDirectory,'enrollment-intent.json'),'utf8'));
  const storedConfig=JSON.parse(fs.readFileSync(join(dataDirectory,'runtime-config.json'),'utf8'));
  assert.equal(storedConfig.modelAnswerProfile,MANAGED_RUNTIME_MODEL_PROFILE);
  assert.equal(intent.configDigest,fresh.configDigest,'the selected config digest is frozen into enrollment intent');

  const access=new DatabaseSync(join(dataDirectory,'access.sqlite'));
  try{access.prepare("DELETE FROM principals WHERE id='viewer'").run();}
  finally{access.close();}
  const reopened=await prepareRuntimeEnrollment({projectRoot:root,executionRoot:project,dataDirectory,identity,planIdentity:adapted.planIdentity,
    freshEnrollmentAllowed:false,modelProfile:undefined,authorize:()=>true});
  assert.equal(reopened.freshEnrollment,false);
  assert.equal(reopened.config.modelAnswerProfile,MANAGED_RUNTIME_MODEL_PROFILE,
    'restart reads the completed selection instead of the current bootstrap default');
  assert.equal(reopened.configDigest,fresh.configDigest);
  assert.equal(await enrollOrVerifyRuntimeAccess({...enrollment,identity:{...identity,configDigest:reopened.configDigest},config:reopened.config,
    seedPrincipals:reopened.seedPrincipals,seedDigest:reopened.seedDigest}),'VERIFIED_EXISTING');
  const verify=new DatabaseSync(join(dataDirectory,'access.sqlite'),{readOnly:true});
  try{assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM principals WHERE id='viewer'").get().count,0,
    'valid restart does not reseed a removed principal');}
  finally{verify.close();}
});

test('managed model profile support comes only from the exact captured runtime manifest',()=>{
  const snapshot=profiles=>({entries:[bytesEntry('apps/runtime/package.json',{name:'@quadbridge/runtime',...(profiles===undefined?{}:{quadbridgeRuntimeProfiles:profiles})})]});
  assert.equal(runtimeSupportsManagedModelProfile(snapshot([MANAGED_RUNTIME_MODEL_PROFILE]),MANAGED_RUNTIME_MODEL_PROFILE),true);
  assert.equal(runtimeSupportsManagedModelProfile(snapshot(undefined),MANAGED_RUNTIME_MODEL_PROFILE),false,
    'a legacy artifact without the captured declaration is explicitly unsupported');
  assert.equal(runtimeSupportsManagedModelProfile(snapshot(['another-profile']),MANAGED_RUNTIME_MODEL_PROFILE),false,
    'a different declared profile does not authorize this fixed selection');
  assert.throws(()=>runtimeSupportsManagedModelProfile(snapshot({malformed:true}),MANAGED_RUNTIME_MODEL_PROFILE),
    error=>error instanceof RuntimePreparationError&&error.code==='RUNTIME_SOURCE_INVALID');
});

test('fresh manager preparation writes only bounded enrollment inputs and rechecks authorization after canonical import',async t=>{
  const {root}=fixture(t),adapted=await canonicalFixture(root),instanceId=adapted.instanceId,dataDirectory=runtimeDataDirectory(root,instanceId,adapted.artifactDigest);
  const identity={instanceId,productId:'sample-product',version:'1.2.3',artifactDigest:adapted.artifactDigest,
    profileDigest:adapted.planIdentity.profileDigest,adapterDigest:'d'.repeat(64)};
  let authorizations=0;
  const prepared=await prepareRuntimeEnrollment({projectRoot:root,executionRoot:project,identity,planIdentity:adapted.planIdentity,freshEnrollmentAllowed:true,
    modelProfile:MANAGED_RUNTIME_MODEL_PROFILE,authorize:()=>{authorizations++;return true;}});
  assert.equal(prepared.freshEnrollment,true);
  assert.equal(prepared.config.modelAnswerProfile,MANAGED_RUNTIME_MODEL_PROFILE);
  assert.ok(authorizations>=1,'the captured session must be rechecked after importing the canonical adapter');
  assert.deepEqual(readdirSync(dataDirectory).sort(),['credentials.json','enrollment-intent.json','enrollment-private.json','runtime-config.json']);
  assert.equal(existsSync(join(dataDirectory,'access.sqlite')),false,'canonical access storage is created only inside the owned supervisor job');
  assert.equal(existsSync(join(dataDirectory,'enrollment-complete.json')),false,'private preparation is not enrollment completion');

  const deniedInstance=`runtime-${randomUUID()}`,deniedPath=runtimeDataDirectory(root,deniedInstance,adapted.artifactDigest);
  await assert.rejects(prepareRuntimeEnrollment({projectRoot:root,executionRoot:project,
    identity:{...identity,instanceId:deniedInstance},planIdentity:adapted.planIdentity,freshEnrollmentAllowed:true,authorize:()=>false}),/no longer authorized/);
  assert.equal(existsSync(deniedPath),false,'expired authorization after import must leave no enrollment files');
});

test('owned execution cleanup removes only exact copied-workspace junctions and quarantines changed targets',async t=>{
  const {root}=fixture(t),settlements=[],settlementByOperation=new Map();
  const store={managedRuntime:()=>undefined,completeManagedRuntimeStop:(instanceId,operationId,_token,proof)=>{settlements.push(proof);settlementByOperation.set(operationId,{instanceId,proof});},
    managedRuntimeAttempt(instanceId,operationId){const value=settlementByOperation.get(operationId);if(!value)return undefined;const complete=value.proof.emptyObserved&&value.proof.helperClosed&&value.proof.executionClean;
      return {id:operationId,instanceId:value.instanceId,commandId:'test-command',stopCommandId:null,state:complete?'STOPPED':'UNKNOWN',commandState:complete?'SUCCEEDED':'UNKNOWN',
        physicalState:complete?'EMPTY':'UNKNOWN',emptyObserved:complete,helperClosed:complete,executionClean:complete};}};
  const manager=ManagedRuntimeManager.create(root,store,{});
  const makeOperation=(suffix,snapshotDirectory='snapshot')=>{
    const operationRoot=join(root,'.local','platform-runtime-executions',`runtime-${randomUUID()}`,suffix);
    const snapshotRoot=join(operationRoot,snapshotDirectory),workspace=join(snapshotRoot,'packages','local-access');
    mkdirSync(workspace,{recursive:true});
    writeFileSync(join(workspace,'package.json'),JSON.stringify({name:'@quadbridge/local-access'}));
    assert.deepEqual(linkCopiedRuntimeWorkspaces(snapshotRoot),['@quadbridge/local-access']);
    return {operationRoot,snapshotRoot,workspace,link:join(snapshotRoot,'node_modules','@quadbridge','local-access')};
  };
  const runnerFor=operation=>({instanceId:`runtime-${randomUUID()}`,operationId:randomUUID(),ownerToken:randomUUID(),operationRoot:operation.operationRoot,
    commandId:'test-command',
    child:{exitCode:0,signalCode:null},closed:Promise.resolve({code:0,signal:null}),closeValue:{code:0,signal:null},exitMarker:{code:0,empty:true},
    protocolError:undefined,closeError:undefined,controlLines:new Set(),stopping:true});

  const valid=makeOperation('valid');
  assert.equal(lstatSync(valid.link).isSymbolicLink(),true);
  const validResult=await manager.finalizeRunner(runnerFor(valid),'STOP',100);
  assert.equal(validResult.complete,true);
  assert.equal(existsSync(valid.operationRoot),false,'an exactly validated copied-inventory link is unlinked before recursive cleanup');
  assert.equal(settlements.at(-1).executionClean,true);

  const changed=makeOperation('changed'),external=join(root,'.local','external-runtime-target');
  mkdirSync(external);writeFileSync(join(external,'sentinel'),'keep');
  unlinkSync(changed.link);symlinkSync(external,changed.link,process.platform==='win32'?'junction':'dir');
  await manager.finalizeRunner(runnerFor(changed),'STOP',100);
  assert.equal(settlements.at(-1).emptyObserved,true);
  assert.equal(settlements.at(-1).helperClosed,true);
  assert.equal(settlements.at(-1).executionClean,false,'a changed workspace target retains the owned execution as cleanup-unknown');
  assert.equal(existsSync(join(changed.operationRoot,'snapshot','node_modules','@quadbridge','local-access')),true);
  assert.equal(existsSync(join(external,'sentinel')),true,'cleanup never follows the substituted target');

  const short=makeOperation('short','s');
  const shortResult=await manager.finalizeRunner(runnerFor(short),'STOP',100);
  assert.equal(shortResult.complete,true,'the shortened private snapshot root keeps the exact original-owner cleanup protocol');
  assert.equal(existsSync(short.operationRoot),false,'the fixed short snapshot root is recognized and cleaned through the same verified link inventory');
});

test('the fixed short private snapshot root keeps selected long exported files below the Windows path limit',()=>{
  const operationRoot=join(project,'.local','platform-runtime-executions',`runtime-${randomUUID()}`,randomUUID());
  const selectedPaths=[
    '.artifacts/core-app/m/assets/raw/60eb54f00e625752.css',
    'modules/service-desk/dist/ui/recent-requests.js.map'
  ];
  const privatePaths=selectedPaths.map(path=>resolve(operationRoot,'s',...path.split('/')));
  assert.ok(privatePaths.every(path=>path.length<240),'the copied snapshot uses the fixed short segment while retaining the complete registered file paths');
});

test('one-use runtime gate is published without a post-publication lookup that can race its consumer',async t=>{
  const root=mkdtempSync(join(tmpdir(),'q-')),store={managedRuntimeSlot:()=>undefined};
  runtimePrivateRoot(root);
  const manager=ManagedRuntimeManager.create(root,store,{});
  const operationRoot=join(runtimePrivateRoot(root),'platform-runtime-executions',`runtime-${randomUUID()}`,randomUUID());
  mkdirSync(operationRoot,{recursive:true});
  const count=32,ready=join(operationRoot,'consumer-ready'),script=`
    const fs=require('node:fs'),path=require('node:path');
    const root=process.argv[1],count=Number(process.argv[2]),gate=path.join(root,'launch-gate.json');
    fs.writeFileSync(path.join(root,'consumer-ready'),'ready',{flag:'wx'});
    let consumed=0;const deadline=Date.now()+15000;
    while(consumed<count&&Date.now()<deadline){
      let bytes;try{bytes=fs.readFileSync(gate)}catch(error){if(error.code==='ENOENT')continue;process.exit(3)}
      try{const value=JSON.parse(bytes.toString('utf8'));if(value.kind!=='LAUNCH'||value.decision!=='ALLOW'||value.operationId!==process.env.QB_GATE_OPERATION)process.exit(4);
        fs.unlinkSync(gate);fs.writeFileSync(path.join(root,'consumed-'+(++consumed)),value.operationId,{flag:'wx'});
      }catch{process.exit(5)}
    }
    process.exit(consumed===count?0:2);
  `;
  const operationId=randomUUID();
  const child=spawn(process.execPath,['-e',script,operationRoot,String(count)],{stdio:'ignore',windowsHide:true,
    env:{QB_GATE_OPERATION:operationId,SystemRoot:process.env.SystemRoot??'',TEMP:process.env.TEMP??''}});
  let closeResolve;const closed=new Promise(resolvePromise=>{closeResolve=resolvePromise;});
  child.once('close',(code,signal)=>closeResolve({code,signal}));
  const waitClosed=async()=>{let timer;const timeout=new Promise(resolvePromise=>{timer=setTimeout(()=>resolvePromise(undefined),5000);});
    const result=await Promise.race([closed,timeout]);clearTimeout(timer);return result;};
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    const result=await waitClosed();
    if(!result)assert.fail('owned one-use consumer process must close before fixture removal');
    rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  const waitFor=async predicate=>{const until=Date.now()+5000;while(Date.now()<until){if(predicate())return;await new Promise(resolvePromise=>setTimeout(resolvePromise,5));}assert.fail('bounded one-use gate consumer did not make progress');};
  await waitFor(()=>existsSync(ready));
  const runner={operationRoot,operationId,instanceId:`runtime-${randomUUID()}`,nonce:randomUUID()};
  for(let index=1;index<=count;index++){
    manager.publishGate(runner,'LAUNCH','e'.repeat(64));
    await waitFor(()=>existsSync(join(operationRoot,`consumed-${index}`)));
  }
  const result=await waitClosed();
  assert.deepEqual(result,{code:0,signal:null});
  assert.equal(existsSync(join(operationRoot,'launch-gate.json')),false,'the supervisor consumed each complete gate exactly once');
});

test('original runtime owner can reconcile a late close and retry a rolled-back settlement audit',async t=>{
  const {root}=fixture(t),instanceId=`runtime-${randomUUID()}`,operationId=randomUUID(),ownerToken='o'.repeat(48),commandId=randomUUID();
  const operationRoot=join(runtimePrivateRoot(root),'platform-runtime-executions',instanceId,operationId);
  mkdirSync(operationRoot,{recursive:true});
  let state='RUNNING',attemptState='RUNNING',settlements=0,failSettlementOnce=false;
  const store={
    managedRuntime:()=>({state}),
    managedRuntimeEvents:()=>'',
    completeManagedRuntimeStop(_instance,_operation,_owner,proof){
      settlements++;
      if(failSettlementOnce){failSettlementOnce=false;throw new Error('audit insert failed');}
      state=proof.emptyObserved&&proof.helperClosed&&proof.executionClean?'STOPPED':'UNKNOWN';attemptState=state;
    },
    managedRuntimeAttempt(_instance,operation){return {id:operation,instanceId,commandId,stopCommandId:null,state:attemptState,commandState:attemptState==='STOPPED'?'SUCCEEDED':'UNKNOWN',
      physicalState:attemptState==='STOPPED'?'EMPTY':'UNKNOWN',emptyObserved:attemptState==='STOPPED',helperClosed:attemptState==='STOPPED',executionClean:attemptState==='STOPPED'};}
  };
  const manager=ManagedRuntimeManager.create(root,store,{});
  let closeResolve;const closed=new Promise(resolvePromise=>{closeResolve=resolvePromise;});
  const runner={instanceId,operationId,ownerToken,commandId,nonce:randomUUID(),operationRoot,child:{exitCode:null,signalCode:null},closed,closeValue:undefined,
    exitMarker:undefined,protocolError:undefined,closeError:undefined,controlError:new Error('expected stop-channel EPIPE'),controlLines:new Set(),stdoutBuffer:'',stdoutBytes:0,stderrBytes:0,
    eventOffset:0,eventBytes:0,eventRemainder:'',phase:6,workerRequired:true,stopping:true,stopReason:'STOP',deadline:Date.now()+30000};
  const pending=await manager.finalizeRunner(runner,'STOP',1);
  assert.equal(pending.complete,false);
  assert.equal(state,'UNKNOWN','a stop timeout remains reserved until exact exit proof arrives');
  runner.closeValue={code:0,signal:null};runner.child.exitCode=0;runner.exitMarker={code:0,empty:true};closeResolve(runner.closeValue);
  await new Promise(resolvePromise=>setTimeout(resolvePromise,0));
  const late=await manager.finalizeRunner(runner,'STOP',1);
  assert.equal(late.complete,true);
  assert.equal(state,'STOPPED');
  assert.equal(existsSync(operationRoot),false,'owned execution is removed only after matching native empty proof');

  const retryInstance=`runtime-${randomUUID()}`,retryOperation=randomUUID(),retryCommand=randomUUID(),retryRoot=join(runtimePrivateRoot(root),'platform-runtime-executions',retryInstance,retryOperation);
  mkdirSync(retryRoot,{recursive:true});
  let retryState='RUNNING',retryAttempt='RUNNING';
  const retryStore={
    managedRuntime:()=>({state:retryState}),managedRuntimeEvents:()=>'',
    completeManagedRuntimeStop(_instance,_operation,_owner,proof){if(failSettlementOnce)throw new Error('unexpected repeat fault');
      if(retrySettlements++===0)throw new Error('audit insert failed');
      retryState=proof.emptyObserved&&proof.helperClosed&&proof.executionClean?'STOPPED':'UNKNOWN';retryAttempt=retryState;},
    managedRuntimeAttempt(_instance,operation){return {id:operation,instanceId:retryInstance,commandId:retryCommand,stopCommandId:null,state:retryAttempt,
      commandState:retryAttempt==='STOPPED'?'SUCCEEDED':'UNKNOWN',physicalState:retryAttempt==='STOPPED'?'EMPTY':'UNKNOWN',
      emptyObserved:retryAttempt==='STOPPED',helperClosed:retryAttempt==='STOPPED',executionClean:retryAttempt==='STOPPED'};}
  };
  let retrySettlements=0;failSettlementOnce=false;
  const retryManager=ManagedRuntimeManager.create(root,retryStore,{});
  const retryRunner={instanceId:retryInstance,operationId:retryOperation,ownerToken,commandId:retryCommand,nonce:randomUUID(),operationRoot:retryRoot,
    child:{exitCode:0,signalCode:null},closed:Promise.resolve({code:0,signal:null}),closeValue:{code:0,signal:null},exitMarker:{code:0,empty:true},
    protocolError:undefined,closeError:undefined,controlError:undefined,controlLines:new Set(),stdoutBuffer:'',stdoutBytes:0,stderrBytes:0,
    eventOffset:0,eventBytes:0,eventRemainder:'',phase:6,workerRequired:true,stopping:true,stopReason:'STOP',deadline:Date.now()+30000};
  retryManager.active.set(retryInstance,retryRunner);
  await assert.rejects(retryManager.finalizeRunner(retryRunner,'STOP',1),/audit insert failed/);
  assert.equal(retryRunner.executionCleanObserved,true,'positive cleanup remains attached to the original owner after audit rollback');
  assert.equal(existsSync(retryRoot),false,'completed physical cleanup is not repeated or misreported after an audit rollback');
  await retryManager.close();
  assert.equal(retryState,'STOPPED','same exact owner can retry the rolled-back terminal audit');
});

test('public close bounds an unresolved monitor and retries incomplete or rolled-back exact-owner settlement',async t=>{
  const {root}=fixture(t),instanceId=`runtime-${randomUUID()}`,operationId=randomUUID(),commandId=randomUUID();
  let attemptState='UNKNOWN',calls=0;
  const store={managedRuntimeAttempt(_instance,operation){
    assert.equal(operation,operationId);
    const terminal=attemptState==='STOPPED';
    return {id:operationId,instanceId,commandId,stopCommandId:null,state:attemptState,commandState:terminal?'SUCCEEDED':'UNKNOWN',
      physicalState:terminal?'EMPTY':'UNKNOWN',emptyObserved:terminal,helperClosed:terminal,executionClean:terminal};
  }};
  const manager=ManagedRuntimeManager.create(root,store,{});
  const runner={instanceId,operationId,ownerToken:'q'.repeat(48),commandId,nonce:randomUUID(),operationRoot:join(root,'.local','owned-runtime'),
    child:{exitCode:0,signalCode:null},closed:new Promise(()=>{}),closeValue:undefined,exitMarker:undefined,stopping:true,stopReason:'OPERATOR_SHUTDOWN',
    monitorPromise:new Promise(()=>{}),operationalError:undefined,proof:undefined};
  manager.active.set(instanceId,runner);
  manager.finalizeRunner=async(current)=>{
    calls++;
    if(calls===1)return {complete:false,emptyObserved:false,helperClosed:false};
    if(calls===2)throw new Error('audit insert failed');
    current.closeValue={code:0,signal:null};current.exitMarker={code:0,empty:true};current.proof={empty:true};
    current.terminalSettlement=true;current.terminalResult={complete:true,emptyObserved:true,helperClosed:true};attemptState='STOPPED';
    return current.terminalResult;
  };
  const deadline=Date.now()+1000;
  await assert.rejects(manager.close(),/physically unverified/);
  assert.ok(Date.now()<deadline,'shutdown returned a bounded quarantine result instead of awaiting the unresolved monitor');
  assert.equal(attemptState,'UNKNOWN','an unresolved helper retains its exact physical slot and data');
  assert.equal(manager.closing,true,'a failed close continues to bar new runtime launches');
  await assert.rejects(manager.close(),/audit insert failed/,'a later public close retries the same exact-owner settlement');
  await manager.close();
  assert.equal(calls,3);
  assert.equal(attemptState,'STOPPED');
});

test('terminal capture drains a coalesced startup tail when the event file has no new bytes',async t=>{
  const {root}=fixture(t),instanceId=`runtime-${randomUUID()}`,operationId=randomUUID(),ownerToken='r'.repeat(48);
  const operationRoot=join(runtimePrivateRoot(root),'platform-runtime-executions',instanceId,operationId);mkdirSync(operationRoot,{recursive:true});
  const runner={instanceId,operationId,ownerToken,nonce:randomUUID(),enrollmentDigest:'f'.repeat(64),operationRoot,child:{exitCode:null,signalCode:null},
    closed:new Promise(()=>{}),closeValue:undefined,exitMarker:undefined,protocolError:undefined,closeError:undefined,controlLines:new Set(),stdoutBuffer:'',stdoutBytes:0,
    stderrBytes:0,eventOffset:0,eventBytes:0,eventRemainder:'',eventDev:undefined,eventIno:undefined,phase:3,workerRequired:false,terminalRoleFailure:undefined,
    terminalSupervisorFailure:false,terminalEventInvalid:false,pendingEvents:[],deadline:Date.now()+30_000};
  const base={schema:'quadbridge.managed-runtime-event.v1',attemptId:operationId,operationId,instanceId,nonce:runner.nonce,bindingDigest:runner.enrollmentDigest};
  const roleFailure={...base,type:'ROLE_FAILED',role:'web-backend',code:'WEB_FAILED'};
  const supervisorFailure={...base,type:'SUPERVISOR_FAILED',code:'SUPERVISOR_FAILED'};
  writeFileSync(join(operationRoot,'events.ndjson'),`${canonical(roleFailure)}\n${canonical(supervisorFailure)}\n`);
  const records=[];const manager=ManagedRuntimeManager.create(root,{recordManagedRuntimeEvent:(_instance,_operation,_token,event)=>records.push(event)},{});
  await assert.rejects(manager.driveStartup(runner,()=>true),/required managed runtime role did not become ready/);
  assert.equal(runner.pendingEvents.length,1,'startup retained the unprocessed tail from its coalesced read');
  runner.closeValue={code:2,signal:null};runner.child.exitCode=2;runner.exitMarker={code:2,empty:false};
  await manager.captureTerminalEvents(runner);
  assert.equal(runner.terminalRoleFailure,'web-backend');
  assert.equal(runner.terminalSupervisorFailure,true);
  assert.equal(runner.terminalEventInvalid,false);
  assert.deepEqual(records,[{type:'ROLE_EXITED',role:'web-backend',code:'WEB_FAILED'}]);
});

test('terminal capture rejects disappearance of an established event channel without erasing native exit proof',async t=>{
  const {root}=fixture(t),instanceId=`runtime-${randomUUID()}`,operationId=randomUUID(),ownerToken='s'.repeat(48);
  const operationRoot=join(runtimePrivateRoot(root),'platform-runtime-executions',instanceId,operationId);mkdirSync(operationRoot,{recursive:true});
  const eventPath=join(operationRoot,'events.ndjson');writeFileSync(eventPath,'');
  const runner={instanceId,operationId,ownerToken,nonce:randomUUID(),enrollmentDigest:'c'.repeat(64),operationRoot,child:{exitCode:0,signalCode:null},
    closed:Promise.resolve({code:0,signal:null}),closeValue:{code:0,signal:null},exitMarker:{code:0,empty:true},protocolError:undefined,closeError:undefined,
    controlLines:new Set(),stdoutBuffer:'',stdoutBytes:0,stderrBytes:0,eventOffset:0,eventBytes:0,eventRemainder:'',eventDev:undefined,eventIno:undefined,
    phase:6,workerRequired:true};
  const manager=ManagedRuntimeManager.create(root,{},{});
  assert.deepEqual(await manager.readEvents(runner),[],'an existing empty channel still establishes its physical identity');
  unlinkSync(eventPath);
  await manager.captureTerminalEvents(runner);
  assert.equal(runner.operationalError,'RUNTIME_EVENT_INVALID','a known channel disappearing is not treated as an empty event stream');
  const proof=await manager.tryStopOwner(runner,1);
  assert.equal(proof.complete,true,'event-channel corruption remains separate from matching native EMPTY and helper close');
  assert.equal(proof.emptyObserved,true);
  assert.equal(proof.helperClosed,true);
});

test('late semantic event errors remain separate from a matching native empty and helper-close proof',async t=>{
  const {root}=fixture(t),instanceId=`runtime-${randomUUID()}`,operationId=randomUUID(),ownerToken='p'.repeat(48),operationRoot=join(runtimePrivateRoot(root),'platform-runtime-executions',`runtime-${randomUUID()}`,randomUUID());
  mkdirSync(operationRoot,{recursive:true});
  const runner={instanceId,operationId,ownerToken,nonce:randomUUID(),enrollmentDigest:'d'.repeat(64),operationRoot,child:{exitCode:0,signalCode:null},closed:Promise.resolve({code:0,signal:null}),
    closeValue:{code:0,signal:null},exitMarker:{code:0,empty:true},protocolError:undefined,closeError:undefined,controlLines:new Set(),stdoutBuffer:'',stdoutBytes:0,
    stderrBytes:0,eventOffset:0,eventBytes:0,eventRemainder:'',eventDev:undefined,eventIno:undefined,phase:3,workerRequired:false};
  writeFileSync(join(operationRoot,'events.ndjson'),`${canonical({schema:'quadbridge.managed-runtime-event.v1',type:'ROLE_FAILED',attemptId:operationId,operationId,
    instanceId,nonce:runner.nonce,bindingDigest:'d'.repeat(64),role:'worker',code:'WORKER_FAILED'})}\n`);
  const manager=ManagedRuntimeManager.create(root,{},{});
  assert.throws(()=>manager.validateTerminalFailure(runner,{schema:'quadbridge.managed-runtime-event.v1',type:'ROLE_FAILED',attemptId:operationId,operationId,
    instanceId,nonce:runner.nonce,bindingDigest:runner.enrollmentDigest,role:'worker',code:'WORKER_FAILED'}),/terminal role event is invalid/);
  await manager.captureTerminalEvents(runner);
  assert.equal(runner.operationalError,'RUNTIME_EVENT_INVALID','an unselected worker failure is rejected by the terminal event grammar');
  const proof=await manager.tryStopOwner(runner,1);
  assert.equal(proof.complete,true,'invalid business events do not erase independently matching native EMPTY and helper-close facts');
  assert.equal(proof.emptyObserved,true);
  assert.equal(proof.helperClosed,true);
});

test('runtime start preserves profile and admission rejection without creating unowned execution',async()=>{
  const plan={product:{id:'sample-product',version:'1.2.3'},modules:[{id:'knowledge'}],bindings:[],requiresWorker:false};
  const profile={id:'quadbridge.local-developer.v1',profile:'loopback-developer-only',defaultTenants:[],providerSeeds:[],connections:[]};
  const planEntry=bytesEntry('.artifacts/sample-product/plan.json',plan),profileEntry=bytesEntry('profiles/local-developer.json',profile);
  const artifactDigest='c'.repeat(64);let settleCalls=0,beginCalls=0,verifyCalls=0;
  let preparedInstance;
  const store={
    managedRuntimeCommandForRequest:()=>undefined,
    artifactReleases:()=>[{productId:'sample-product',version:'1.2.3',artifactDigest,originatingActorId:'actor-source'}],
    beginManagedRuntimeStart(input){beginCalls++;preparedInstance=input.instanceId;throw new Error('occupied physical slot fixture');},
    settleManagedRuntimePreparation(){settleCalls++;throw new Error('must not settle an admission this process did not obtain');}
  };
  const artifacts={verifyArtifact:async()=>{verifyCalls++;return {artifact:{digest:artifactDigest,productId:'sample-product',version:'1.2.3',originatingActorId:'actor-source'},
    snapshot:{entries:[planEntry,profileEntry],snapshotDigest:artifactDigest,fileCount:2,sizeBytes:planEntry.sizeBytes+profileEntry.sizeBytes}};}};
  const manager=ManagedRuntimeManager.create(project,store,artifacts);
  if(process.platform==='win32'){
    await assert.rejects(manager.start({productId:'sample-product',version:'1.2.3',requestKey:'admission-failure-key'},'actor-runtime',()=>true),/occupied physical slot fixture/);
    assert.equal(verifyCalls,1,'the supported Windows host verifies the promoted artifact before the occupied-slot rejection');
    assert.equal(beginCalls,1);
    assert.equal(settleCalls,0,'a rejected transaction did not admit this operation as physical owner');
    assert.equal(existsSync(runtimeDataDirectory(project,preparedInstance,artifactDigest)),false,'no enrollment files are written before durable admission');
    assert.equal(existsSync(join(project,'.local','platform-runtime-executions',preparedInstance)),false,'no execution directory is created before durable admission');
  }else{
    await assert.rejects(manager.start({productId:'sample-product',version:'1.2.3',requestKey:'admission-failure-key'},'actor-runtime',()=>true),error=>{
      assert.ok(error instanceof RuntimePreparationError);
      assert.equal(error.code,'RUNTIME_UNAVAILABLE');
      assert.match(error.message,/selected Windows process-owner profile/);
      return true;
    });
    assert.equal(verifyCalls,0,'unsupported hosts fail before promoted-artifact verification');
    assert.equal(beginCalls,0,'unsupported hosts never request durable admission');
    assert.equal(settleCalls,0);
    assert.equal(preparedInstance,undefined,'no unowned runtime identity was prepared');
  }
});

test('verified snapshot copy preflights every path and digest before creating its destination',t=>{
  const {root}=fixture(t),destination=join(root,'.local','runtime-copy');
  const snapshot={sizeBytes:2,fileCount:2,entries:[
    {path:'safe.txt',bytes:Buffer.from('a'),digest:sha256('a'),sizeBytes:1},
    {path:'nested/../escape.txt',bytes:Buffer.from('b'),digest:sha256('b'),sizeBytes:1}
  ]};
  assert.throws(()=>copyVerifiedRuntimeSnapshot(snapshot,destination,{}),/unsupported Windows path/);
  assert.equal(existsSync(destination),false,'invalid later entries must be rejected before the destination directory is created');
  const collision={...snapshot,entries:[
    {path:'folder',bytes:Buffer.from('a'),digest:sha256('a'),sizeBytes:1},
    {path:'folder/child.txt',bytes:Buffer.from('b'),digest:sha256('b'),sizeBytes:1}
  ]};
  assert.throws(()=>copyVerifiedRuntimeSnapshot(collision,destination,{}),/file\/directory collision/);
  assert.equal(existsSync(destination),false);
  const mismatchedTotal={sizeBytes:3,fileCount:1,entries:[
    {path:'safe.txt',bytes:Buffer.from('a'),digest:sha256('a'),sizeBytes:1}
  ]};
  assert.throws(()=>copyVerifiedRuntimeSnapshot(mismatchedTotal,destination,{}),/byte total differs/);
  assert.equal(existsSync(destination),false,'a false aggregate size must be rejected before destination creation');
  const mismatchedCount={sizeBytes:1,fileCount:2,entries:[
    {path:'safe.txt',bytes:Buffer.from('a'),digest:sha256('a'),sizeBytes:1}
  ]};
  assert.throws(()=>copyVerifiedRuntimeSnapshot(mismatchedCount,destination,{}),/exact copied-entry bounds/);
  assert.equal(existsSync(destination),false,'a false file count must be rejected before destination creation');
});

test('runtime enrollment binds the exact owner path, reserves fresh access storage after awaited authorization, and never reseeds a completed store',async t=>{
  const {root}=fixture(t),adapted=await canonicalFixture(root),input=enrollmentInput(root,adapted,adapted.instanceId,adapted.artifactDigest);
  const dataRoot=join(root,'.local','platform-runtime-data');
  const baseIdentity={instanceId:input.identity.instanceId,productId:input.identity.productId,version:input.identity.version,
    artifactDigest:input.identity.artifactDigest,profileDigest:input.identity.profileDigest,adapterDigest:input.identity.adapterDigest};
  assert.equal(completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),undefined);
  await assert.rejects(enrollOrVerifyRuntimeAccess({...input,dataDirectory:join(root,'.local','platform-runtime-data','runtime-123e4567-e89b-42d3-a456-000000000001',adapted.artifactDigest)}),/path or immutable identity/);
  assert.deepEqual(readdirSync(dataRoot),[],'a mismatched caller path must not create or alter owner data');
  const changed={...input,config:{...input.config,instanceId:'runtime-123e4567-e89b-42d3-a456-000000000099'}};
  await assert.rejects(enrollOrVerifyRuntimeAccess(changed),/does not match its immutable enrollment identity/);
  assert.deepEqual(readdirSync(dataRoot),[],'a config digest failure must precede filesystem mutation');
  await assert.rejects(enrollOrVerifyRuntimeAccess({...input,authorize:()=>{throw new Error('session expired after import');}}),/session expired after import/);
  assert.deepEqual(readdirSync(dataRoot),[],'expired authorization after the awaited import must precede enrollment writes');
  const oversizedConfig={...input.config,fixturePadding:'x'.repeat(1024*1024)};
  const oversized={...input,config:oversizedConfig,identity:{...input.identity,configDigest:sha256(canonical({config:oversizedConfig,seedDigest:input.seedDigest,profileDigest:input.identity.profileDigest}))}};
  await assert.rejects(enrollOrVerifyRuntimeAccess(oversized),/exceeds its private metadata bound/);
  assert.deepEqual(readdirSync(dataRoot),[],'oversized private metadata must be rejected before owner directories or files are written');

  assert.equal(await enrollOrVerifyRuntimeAccess(input),'ENROLLED');
  assert.equal(await enrollOrVerifyRuntimeAccess(input),'VERIFIED_EXISTING');
  const accessPath=join(input.dataDirectory,'access.sqlite');
  const accessDb=new DatabaseSync(accessPath);
  try{
    accessDb.prepare("DELETE FROM grants WHERE principal='viewer'").run();
    accessDb.prepare("DELETE FROM principals WHERE id='viewer'").run();
  }finally{accessDb.close();}
  const loaded=completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity});
  assert.ok(loaded,'completed binding remains valid after legitimate principal removal');
  assert.equal(loaded.configDigest,input.identity.configDigest);
  assert.equal(await enrollOrVerifyRuntimeAccess(input),'VERIFIED_EXISTING');
  const checkDb=new DatabaseSync(accessPath,{readOnly:true});
  try{assert.equal(checkDb.prepare("SELECT COUNT(*) AS n FROM principals WHERE id='viewer'").get().n,0,'restart validation must not reseed a removed principal');}
  finally{checkDb.close();}
  unlinkSync(join(input.dataDirectory,'enrollment-complete.json'));
  assert.throws(()=>completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),/no valid completed enrollment marker/);
});

test('completed enrollment tolerates only a vanished SQLite sidecar while rejecting vanished owner data',async t=>{
  const {root}=fixture(t),adapted=await canonicalFixture(root),input=enrollmentInput(root,adapted,adapted.instanceId,adapted.artifactDigest);
  const baseIdentity={instanceId:input.identity.instanceId,productId:input.identity.productId,version:input.identity.version,
    artifactDigest:input.identity.artifactDigest,profileDigest:input.identity.profileDigest,adapterDigest:input.identity.adapterDigest};
  assert.equal(await enrollOrVerifyRuntimeAccess(input),'ENROLLED');
  const accessPath=join(input.dataDirectory,'access.sqlite');
  const originalLstat=fs.lstatSync;
  function disappearOnce(target){
    let hit=false;
    fs.lstatSync=function(path,...args){
      if(!hit&&resolve(String(path))===resolve(target)){
        hit=true;
        unlinkSync(target);
      }
      return originalLstat.call(this,path,...args);
    };
    syncBuiltinESMExports();
    return ()=>{fs.lstatSync=originalLstat;syncBuiltinESMExports();return hit;};
  }

  const transientSidecar=join(input.dataDirectory,'access.sqlite-SHM.TMP');
  writeFileSync(transientSidecar,'transient fixture sidecar',{flag:'wx'});
  const restoreSidecar=disappearOnce(transientSidecar);
  try{
    assert.ok(completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),
      'the exact uppercase WAL/SHM plus case-insensitive temporary spelling is tolerated only after ENOENT');
  }finally{assert.equal(restoreSidecar(),true,'the controlled lstat interleaving exercised the sidecar path');}

  const modulesDirectory=join(input.dataDirectory,'modules'),moduleDatabase=join(modulesDirectory,'service-desk.sqlite');
  mkdirSync(modulesDirectory);writeFileSync(moduleDatabase,'owned module database',{flag:'wx'});
  const moduleSidecar=join(modulesDirectory,'service-desk.sqlite-WAL.TMP');
  writeFileSync(moduleSidecar,'transient module sidecar',{flag:'wx'});
  const restoreModuleSidecar=disappearOnce(moduleSidecar);
  try{
    assert.ok(completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),
      'the modules/<id>.sqlite owner accepts its exact disappearing uppercase sidecar spelling');
  }finally{assert.equal(restoreModuleSidecar(),true,'the controlled lstat interleaving exercised the module sidecar path');}

  const ordinaryTemporary=join(input.dataDirectory,'access.sqlite.tmp');
  writeFileSync(ordinaryTemporary,'not a WAL/SHM sibling',{flag:'wx'});
  const restoreOrdinary=disappearOnce(ordinaryTemporary);
  try{
    assert.throws(()=>completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),
      error=>error?.code==='ENOENT','a standalone access.sqlite.tmp is not a tolerated transient SQLite sidecar');
  }finally{assert.equal(restoreOrdinary(),true,'the standalone temporary file was removed at lstat');}

  const credentialsPath=join(input.dataDirectory,'credentials.json');
  const restoreCredentials=disappearOnce(credentialsPath);
  try{
    assert.throws(()=>completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),
      error=>error?.code==='ENOENT','missing stable credential data remains an integrity failure');
  }finally{assert.equal(restoreCredentials(),true,'the stable credential path was removed at lstat');}
});

test('a failed canonical LocalAccess seed leaves repair-required evidence and never publishes enrollment completion',async t=>{
  const {root}=fixture(t),adapted=await canonicalFixture(root),input=enrollmentInput(root,adapted,adapted.instanceId,adapted.artifactDigest);
  const fakeExecution=join(root,'.local','seed-failure-fixture');
  mkdirSync(join(fakeExecution,'packages','local-access','dist'),{recursive:true});
  writeFileSync(join(fakeExecution,'packages','local-access','dist','index.js'),
    'export class LocalAccess { constructor(){ this.store={db:{}} } seed(){ throw new Error("seed fixture fault") } close(){} }');
  await assert.rejects(enrollOrVerifyRuntimeAccess({...input,executionRoot:fakeExecution}),/seed fixture fault/);
  assert.equal(readdirSync(input.dataDirectory).includes('enrollment-complete.json'),false);
  const baseIdentity={instanceId:input.identity.instanceId,productId:input.identity.productId,version:input.identity.version,
    artifactDigest:input.identity.artifactDigest,profileDigest:input.identity.profileDigest,adapterDigest:input.identity.adapterDigest};
  assert.throws(()=>completedRuntimeEnrollment({projectRoot:root,dataDirectory:input.dataDirectory,identity:baseIdentity}),/no valid completed enrollment marker/);
});
