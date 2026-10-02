import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, rmSync, writeSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonical, PlatformError } from '@quadbridge/contracts';
import { ControlPlaneStore, MANAGED_RUNTIME_RECOVERY_LIMITS, type ManagedRuntimeRecoveryIdentity, type ManagedRuntimeUpgradeIntent } from '@quadbridge/control-plane';
import type { BoundedSnapshot } from '@quadbridge/composition/snapshot-access';
import type { LocalArtifactStore } from './artifact-store.js';
import { copyVerifiedRuntimeSnapshot, linkCopiedRuntimeWorkspaces, MANAGED_RUNTIME_ADAPTER_DIGEST, runtimeDataDirectory,
  completedRuntimeEnrollment, runtimeModuleDescriptors, runtimePlanIdentity, runtimeSnapshotExpected, runManagedRuntimeOwnedNativeJob,
  removeRuntimeUpgradeWorkspaceLinks, type RuntimePlanIdentity } from './runtime-manager.js';
import { RUNTIME_RECOVERY_TOOL_SHA256, type RuntimeRecoveryManager } from './runtime-recovery.js';

const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE=/^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PATH=240,MAX_ENTRIES=16384,MAX_DEPTH=32,MAX_FILE=1024*1024;
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export const RUNTIME_UPGRADE_TOOL_SHA256='216c516f525d95c6c17b5c77d7a6d7e578358c3e51fa329d5763fc120d709825';
export const RUNTIME_UPGRADE_PUBLISHER_SHA256='edfc065d234885678d252e9bd13ebd2bef9814353335671fac662b243cddf57f';

type NativeHost={hostPath:string;nodePath:string;toolchainDigest:string;buildJobDigest:string};
type StoppedSource={instance:Record<string,any>;attempt:Record<string,any>;generation:Record<string,any>;identity:ManagedRuntimeRecoveryIdentity&{workerRequired:boolean}};
type PublisherProof={moved:boolean;resultObserved:boolean;closed:boolean;status:'MOVED'|'EXISTS'|'FAILED'|'UNKNOWN'};

export class RuntimeUpgradeError extends Error {
  constructor(readonly code:'RUNTIME_UNAVAILABLE'|'RUNTIME_REPAIR_REQUIRED'|'RUNTIME_SOURCE_INVALID'|'RUNTIME_BACKUP_INVALID'|'RUNTIME_UPGRADE_UNKNOWN',message:string){super(message);this.name='RuntimeUpgradeError';}
}
function isObject(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function physicalRoot(path:string):string{
  const full=resolve(path),info=lstatSync(full);if(full.length>=MAX_PATH||!info.isDirectory()||info.isSymbolicLink()||realpathSync(full).toLowerCase()!==full.toLowerCase())
    throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade storage must remain under a physical project directory');return full;
}
function physicalDirectory(path:string,create=false):string{
  const full=resolve(path);if(full.length>=MAX_PATH)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','Runtime upgrade path exceeds the fixed Windows path bound');
  const parent=dirname(full);if(parent!==full)physicalDirectory(parent,create);
  try{const info=lstatSync(full);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade path contains a link or non-directory');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||!create)throw error;mkdirSync(full);const info=lstatSync(full);if(!info.isDirectory()||info.isSymbolicLink())throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade directory could not be created safely');}
  return full;
}
function makeChild(parent:string,name:string):string{
  if(!/^[a-zA-Z0-9.-]{1,128}$/.test(name)||name==='.'||name==='..')throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Invalid private runtime upgrade directory identity');
  const base=physicalDirectory(parent,false),target=join(base,name);if(target.length>=MAX_PATH)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','Runtime upgrade path exceeds the fixed Windows path bound');
  try{lstatSync(target);throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','A private runtime upgrade operation directory already exists');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  mkdirSync(target);return physicalDirectory(target,false);
}
function contained(root:string,path:string):string{
  const base=resolve(root),full=resolve(path),rel=relative(base,full);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||resolve(base,rel)!==full)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade path escaped its fixed owner root');
  return full;
}
function readBounded(path:string,max=MAX_FILE):Buffer{
  const full=resolve(path),named=lstatSync(full);if(full.length>=MAX_PATH||!named.isFile()||named.isSymbolicLink()||named.size<1||named.size>max||realpathSync(full).toLowerCase()!==full.toLowerCase())
    throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','A fixed runtime upgrade input is unsafe or outside its byte bound');
  const fd=openSync(full,'r');try{const opened=fstatSync(fd);if(opened.dev!==named.dev||opened.ino!==named.ino||opened.size!==named.size)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade input changed while opening');
    const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade input changed while reading');offset+=count;}
    const extra=readSync(fd,Buffer.alloc(1),0,1,opened.size),after=fstatSync(fd),afterName=lstatSync(full);if(extra||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||afterName.dev!==opened.dev||afterName.ino!==opened.ino)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade input changed while reading');return bytes;
  }finally{closeSync(fd);}
}
function writeExact(path:string,bytes:Buffer):void{
  const full=resolve(path);if(full.length>=MAX_PATH)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','Runtime upgrade metadata exceeds its fixed path bound');physicalDirectory(dirname(full),false);
  const fd=openSync(full,'wx');try{const info=fstatSync(fd);if(!info.isFile())throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade output is not a regular file');let offset=0;
    while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade output was incomplete');offset+=count;}fsyncSync(fd);
  }finally{closeSync(fd);}
  const after=lstatSync(full);if(!after.isFile()||after.isSymbolicLink()||after.size!==bytes.length||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade output changed after close');
}
function ensureChildDirectories(root:string,relativePath:string):string{
  if(typeof relativePath!=='string'||relativePath.includes('\\')||relativePath.startsWith('/')||relativePath.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f\x7f:]/.test(part)))
    throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','Verified source backup contains an unsupported path');
  let current=physicalDirectory(root,false);const parts=relativePath.split('/');
  for(const part of parts.slice(0,-1))current=physicalDirectory(join(current,part),true);
  return join(current,parts.at(-1)!);
}
function scanOwned(root:string):{files:number;directories:number;entries:number;bytes:number}{
  const base=physicalDirectory(root,false),pending=[{path:base,depth:0}];let files=0,directories=0,entries=0,bytes=0,started=performance.now();
  while(pending.length){if(performance.now()-started>2000)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup exceeded its fixed scan bound');const current=pending.pop()!;
    if(current.depth>MAX_DEPTH)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup exceeded its depth bound');const dir=opendirSync(current.path,{bufferSize:32});
    try{for(;;){const item=dir.readSync();if(!item)break;if(++entries>MAX_ENTRIES)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup exceeded its entry bound');const full=join(current.path,item.name);if(full.length>=MAX_PATH)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','Runtime upgrade cleanup path exceeds its bound');
      const info=lstatSync(full);if(info.isSymbolicLink()||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup found a link');
      if(info.isDirectory()){directories++;pending.push({path:full,depth:current.depth+1});}else if(info.isFile()){files++;bytes+=info.size;}else throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup found a special file');
    }}finally{dir.closeSync();}
  }
  if(performance.now()-started>2000)throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup exceeded its fixed scan bound');
  return {files,directories,entries,bytes};
}
function deleteOwned(ownerRoot:string,path:string):void{
  const root=physicalDirectory(ownerRoot,false),target=contained(root,path);try{lstatSync(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  scanOwned(target);rmSync(target,{recursive:true,force:false,maxRetries:10,retryDelay:100});try{lstatSync(target);throw new RuntimeUpgradeError('RUNTIME_REPAIR_REQUIRED','Runtime upgrade cleanup was not observed');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
function deleteExecutionOwned(projectRoot:string,path:string):void{
  removeRuntimeUpgradeWorkspaceLinks(projectRoot,path);
  deleteOwned(join(projectRoot,'.local','platform-runtime-upgrade-executions'),path);
}
function parseCanonical(bytes:Buffer):any{let value:any;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','Private upgrade metadata is malformed');}
  if(canonical(value)!==bytes.toString('utf8'))throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','Private upgrade metadata is not canonical');return value;}
function sorted(value:unknown):string{return canonical(Array.isArray(value)?[...value].sort((a:any,b:any)=>canonical(a).localeCompare(canonical(b))):value);}
function compareVersions(left:string,right:string):number{
  const a=left.split('.').map(Number),b=right.split('.').map(Number);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]!<b[i]!?-1:1;}return 0;
}
function compatiblePlans(source:RuntimePlanIdentity,target:RuntimePlanIdentity):void{
  if(source.productId!==target.productId||source.profileDigest!==target.profileDigest||source.workerRequired!==target.workerRequired||
    source.plan.product.platformAbi!==target.plan.product.platformAbi||sorted(source.plan.modules.map((row:any)=>row.id))!==sorted(target.plan.modules.map((row:any)=>row.id))||
    sorted(source.plan.bindings)!==sorted(target.plan.bindings)||sorted(source.plan.permissions??[])!==sorted(target.plan.permissions??[]))
    throw new PlatformError('INCOMPATIBLE','The promoted target changes the stopped runtime profile, selected owners, bindings, or permissions');
}
function stoppedSource(store:ControlPlaneStore,instanceId:string):StoppedSource{
  if(!INSTANCE.test(instanceId))throw new PlatformError('INVALID','Invalid runtime instance reference');
  const instance=store.managedRuntime(instanceId) as Record<string,any>|undefined;if(!instance)throw new PlatformError('NOT_FOUND','Managed runtime instance not found');
  const attempt=(instance.attempts as Record<string,any>[]).find(row=>row.attempt===instance.currentAttempt);
  if(instance.state!=='STOPPED'||!attempt||attempt.state!=='STOPPED'||attempt.physicalState!=='EMPTY'||!attempt.emptyObserved||!attempt.helperClosed||!attempt.executionClean||
    !attempt.generation||attempt.generation.generationId!==instance.activeGenerationId)
    throw new PlatformError('CONFLICT','Upgrade requires the exact positively stopped current runtime generation');
  const proof=store.managedRuntimeAttempt(instanceId,attempt.id) as Record<string,any>|undefined;
  const generation=store.managedRuntimeGenerations(instanceId).find((row:any)=>row.id===instance.activeGenerationId) as Record<string,any>|undefined;
  if(!proof||proof.id!==attempt.id||proof.state!=='STOPPED'||proof.physicalState!=='EMPTY'||!proof.emptyObserved||!proof.helperClosed||!proof.executionClean||
    proof.commandState!=='SUCCEEDED'||!proof.stopCommandId||proof.stopCommandState!=='SUCCEEDED'||proof.generationId!==instance.activeGenerationId||
    !generation||generation.version!==instance.version||generation.productId!==instance.productId||generation.artifactDigest!==instance.artifactDigest||
    generation.profileDigest!==instance.profileDigest||generation.configDigest!==instance.configDigest||generation.adapterDigest!==instance.adapterDigest||
    generation.toolchainDigest!==instance.toolchainDigest||generation.recipeDigest!==instance.recipeDigest||generation.originatingActorId!==instance.originatingActorId)
    throw new PlatformError('CONFLICT','Current stopped attempt no longer matches its immutable generation');
  const identity:ManagedRuntimeRecoveryIdentity&{workerRequired:boolean}={instanceId,attemptId:proof.id,attempt:proof.attempt,commandId:proof.commandId,productId:instance.productId,version:instance.version,
    artifactDigest:instance.artifactDigest,originatingActorId:instance.originatingActorId,profileDigest:instance.profileDigest,configDigest:instance.configDigest,
    adapterDigest:instance.adapterDigest,toolchainDigest:instance.toolchainDigest,recipeDigest:instance.recipeDigest,workerRequired:instance.workerRequired};
  return {instance,attempt:proof,generation,identity};
}
function exactFalseOrThenable(authorize:()=>unknown):void{
  if(typeof authorize!=='function'||authorize.constructor.name==='AsyncFunction')throw new PlatformError('DENIED','Original paired operator authorization is unavailable');
  const value=authorize();if(value===false||(value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as any).then==='function'))throw new PlatformError('DENIED','Original paired operator authorization is no longer valid');
}
function safeUpgrade(value:Record<string,any>|undefined):Record<string,unknown>|undefined{
  if(!value)return undefined;const {ownerToken:_token,ownerId:_owner,requestKey:_key,payloadDigest:_payload,...row}=value;return row;
}

/** Executes one explicit same-instance migration under the exact original stopped-runtime owner. */
export class RuntimeUpgradeManager {
  private closing=false;private closeFlight?:Promise<void>;private readonly operations=new Set<Promise<unknown>>();
  private readonly root:string;private readonly driverBytes:Buffer;private readonly publisherBytes:Buffer;private readonly helperBytes:Buffer;
  private constructor(root:string,private readonly store:ControlPlaneStore,private readonly artifacts:LocalArtifactStore,private readonly recovery:RuntimeRecoveryManager){
    this.root=physicalRoot(root);this.driverBytes=readBounded(join(this.root,'tools','runtime-upgrade.mjs'));this.publisherBytes=readBounded(join(this.root,'tools','runtime-upgrade-publish.ps1'));
    this.helperBytes=readBounded(join(this.root,'tools','build-job.ps1'));
    if(sha(this.driverBytes)!==RUNTIME_UPGRADE_TOOL_SHA256||sha(this.publisherBytes)!==RUNTIME_UPGRADE_PUBLISHER_SHA256)
      throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','The fixed local upgrade tools do not match their reviewed identities');
  }
  static create(root:string,store:ControlPlaneStore,artifacts:LocalArtifactStore,recovery:RuntimeRecoveryManager){return new RuntimeUpgradeManager(resolve(root),store,artifacts,recovery);}
  list(instanceId:string){return {instanceId,generations:this.store.managedRuntimeGenerations(instanceId),operations:this.store.managedRuntimeUpgrades(instanceId).map((row:any)=>safeUpgrade(row))};}
  operation(operationId:string){return safeUpgrade(this.store.managedRuntimeUpgrade(operationId) as Record<string,any>|undefined);}
  upgrade(input:{instanceId:string;targetVersion:string;targetArtifactDigest:string;sourceBackupDigest:string;requestKey:string;confirm:boolean},actorId:string,authorize:()=>unknown){
    if(this.closing)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','The runtime upgrade manager is closing');exactFalseOrThenable(authorize);
    return this.track(this.runUpgrade(input,actorId,authorize));
  }
  private track<T>(promise:Promise<T>):Promise<T>{this.operations.add(promise);void promise.finally(()=>this.operations.delete(promise)).catch(()=>{});return promise;}
  private authorize(authorize:()=>unknown):void{if(this.closing)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','The runtime upgrade manager is closing');exactFalseOrThenable(authorize);}
  private async runUpgrade(input:{instanceId:string;targetVersion:string;targetArtifactDigest:string;sourceBackupDigest:string;requestKey:string;confirm:boolean},actorId:string,authorize:()=>unknown){
    if(!input||input.confirm!==true||!INSTANCE.test(input.instanceId)||!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(input.targetVersion)||!HASH.test(input.targetArtifactDigest)||
      !HASH.test(input.sourceBackupDigest)||typeof input.requestKey!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestKey))throw new PlatformError('INVALID','Invalid explicit runtime upgrade confirmation');
    this.authorize(authorize);
    const replay=this.store.managedRuntimeUpgradeForRequest(actorId,input.requestKey,{instanceId:input.instanceId,targetVersion:input.targetVersion,
      targetArtifactDigest:input.targetArtifactDigest,sourceBackupDigest:input.sourceBackupDigest});
    if(replay)return safeUpgrade(replay as Record<string,any>);
    const stopped=stoppedSource(this.store,input.instanceId),source=stopped.identity;
    if(compareVersions(input.targetVersion,source.version)<=0)throw new PlatformError('CONFLICT','The selected promoted target is not newer than the stopped runtime');
    const targetRelease=this.store.artifactReleases().find((row:any)=>row.productId===source.productId&&row.version===input.targetVersion) as Record<string,any>|undefined;
    if(!targetRelease||targetRelease.artifactDigest!==input.targetArtifactDigest)throw new PlatformError('NOT_FOUND','The exact requested target release is not promoted');
    const sourceVerified=await this.artifacts.verifyArtifact(source.artifactDigest) as {artifact:Record<string,any>;snapshot:BoundedSnapshot};this.authorize(authorize);
    if(sourceVerified.snapshot.snapshotDigest!==source.artifactDigest||sourceVerified.artifact.productId!==source.productId||sourceVerified.artifact.version!==source.version||
      sourceVerified.artifact.originatingActorId!==source.originatingActorId)throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','Stopped source export no longer matches its captured generation');
    const sourcePlan=runtimePlanIdentity(sourceVerified.snapshot,source.productId,source.version),sourceModules=runtimeModuleDescriptors(sourceVerified.snapshot,sourcePlan);
    if(sourcePlan.profileDigest!==source.profileDigest||source.adapterDigest!==MANAGED_RUNTIME_ADAPTER_DIGEST)
      throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','Stopped source generation differs from the selected local runtime profile');
    const targetVerified=await this.artifacts.verifyArtifact(input.targetArtifactDigest) as {artifact:Record<string,any>;snapshot:BoundedSnapshot};this.authorize(authorize);
    if(targetVerified.snapshot.snapshotDigest!==input.targetArtifactDigest||targetVerified.artifact.productId!==source.productId||targetVerified.artifact.version!==input.targetVersion||
      targetVerified.artifact.originatingActorId!==targetRelease.originatingActorId)throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','Promoted target export does not match its immutable registry identity');
    const targetPlan=runtimePlanIdentity(targetVerified.snapshot,source.productId,input.targetVersion);compatiblePlans(sourcePlan,targetPlan);
    const targetModules=runtimeModuleDescriptors(targetVerified.snapshot,targetPlan),targetDataDirectory=runtimeDataDirectory(this.root,input.instanceId,input.targetArtifactDigest);
    const sourceDataDirectory=runtimeDataDirectory(this.root,input.instanceId,source.artifactDigest);
    const enrollment=completedEnrollment(this.root,sourceDataDirectory,source);
    if(!enrollment||enrollment.configDigest!==source.configDigest)throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','The exact stopped source has no valid completed enrollment');
    const sourceEnrollment=parseCanonical(readBounded(join(sourceDataDirectory,'enrollment-intent.json')));
    const sourceEnrollmentDigest=sha(canonical(sourceEnrollment));
    const backup=await this.recovery.verifyBackupForUpgrade(input.sourceBackupDigest,source,sourceModules);this.authorize(authorize);
    if(backup.metadata.generationId!==stopped.generation.id||backup.manifest.identity.attemptId!==source.attemptId||backup.manifest.identity.attempt!==source.attempt||
      backup.manifest.identity.commandId!==source.commandId||backup.manifest.enrollmentDigest!==sourceEnrollmentDigest)
      throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','The selected backup is not the exact stopped generation and completed enrollment');
    const targetParent=physicalDirectory(dirname(targetDataDirectory),false);
    try{lstatSync(targetDataDirectory);throw new PlatformError('CONFLICT','The target generation data destination already exists');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const sourceConfig=parseCanonical(readBounded(join(sourceDataDirectory,'runtime-config.json'))),seedData=parseCanonical(readBounded(join(sourceDataDirectory,'enrollment-private.json')));
    const seeds=seedData.principals;if(!Array.isArray(seeds))throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','Completed source enrollment has no immutable seed record');
    const seedDigest=sha(canonical(seeds)),targetConfig={...sourceConfig,instanceId:input.instanceId,dataDirectory:targetDataDirectory,principals:[]};
    const targetConfigDigest=sha(canonical({config:targetConfig,seedDigest,profileDigest:targetPlan.profileDigest}));
    const host=this.recovery.captureUpgradeNativeHost();this.assertHost(host);
    if(source.toolchainDigest!==host.toolchainDigest)throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','Stopped source generation differs from the selected local runtime toolchain');
    const operationId=randomUUID(),ownerId=randomUUID(),ownerToken=randomBytes(32).toString('base64url');
    const estimate=backup.sizeBytes+targetVerified.snapshot.sizeBytes+this.driverBytes.length+this.publisherBytes.length+this.helperBytes.length+2*1024*1024;
    if(!Number.isSafeInteger(estimate)||estimate<1||estimate>MANAGED_RUNTIME_RECOVERY_LIMITS.maxStagingBytes)throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','The verified upgrade inputs exceed the fixed local staging limit');
    const intent:ManagedRuntimeUpgradeIntent={operationId,ownerId,ownerToken,actorId,requestKey:input.requestKey,instanceId:input.instanceId,
      sourceGenerationId:stopped.generation.id,sourceAttemptId:source.attemptId,sourceAttempt:source.attempt,sourceCommandId:source.commandId,
      targetVersion:input.targetVersion,targetArtifactDigest:input.targetArtifactDigest,targetProfileDigest:targetPlan.profileDigest,targetConfigDigest,
      targetAdapterDigest:source.adapterDigest,targetToolchainDigest:host.toolchainDigest,targetRecipeDigest:source.recipeDigest,targetWorkerRequired:targetPlan.workerRequired,
      sourceBackupDigest:input.sourceBackupDigest,reservedBytes:estimate};
    this.authorize(authorize);
    const reservation=this.store.beginManagedRuntimeUpgrade(intent,()=>this.recovery.upgradeCapacityObservation(),()=>this.authorize(authorize));
    if(reservation.reused)return safeUpgrade(reservation.operation as Record<string,any>);
    if(reservation.operationId!==operationId||reservation.ownerToken!==ownerToken)throw new PlatformError('CONFLICT','Upgrade admission did not retain this exact process owner');
    let stageRoot:string|undefined,executionRoot:string|undefined,dispatchBegun=false,driverRecorded=false,driverProofRecorded=false,driverEmptyObserved=false,driverHelperClosed=false,
      executionClean=false,driverComplete=false,publisherStarted=false,publisherComplete=false,published=false,settled=false;
    let driverResult:Record<string,any>|undefined;
    let sourceAccessStateDigest='';
    try{
      this.authorize(authorize);const local=physicalDirectory(join(this.root,'.local'),false),stagingBase=physicalDirectory(join(local,'platform-runtime-upgrades'),true),executionBase=physicalDirectory(join(local,'platform-runtime-upgrade-executions'),true);
      stageRoot=makeChild(stagingBase,operationId);executionRoot=makeChild(executionBase,operationId);
      const payloadRoot=physicalDirectory(join(stageRoot,'payload'),true),dataStage=physicalDirectory(join(payloadRoot,'data'),true);
      const snapshotRoot=join(executionRoot,'snapshot');
    const sourceRows=new Map((backup.manifest.files as Array<any>).map(row=>[row.path,row]));
      for(const [path,bytes] of [...backup.files.entries()].sort(([a],[b])=>a.localeCompare(b))){
        const row=sourceRows.get(path);if(!row||!Buffer.isBuffer(bytes)||row.sizeBytes!==bytes.length||row.digest!==sha(bytes))throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','Verified source backup bytes changed before staging');
        const destination=ensureChildDirectories(dataStage,path);writeExact(destination,bytes);
      }
      const sourceProjection=await this.recovery.inspectUpgradePayload(dataStage,source as unknown as Record<string,unknown>,sourceEnrollmentDigest,sourceModules,sourceDataDirectory);this.authorize(authorize);
      sourceAccessStateDigest=sourceProjection.accessStateDigest;
      if(!HASH.test(sourceAccessStateDigest)||canonical(sourceProjection.files)!==canonical(backup.manifest.files))
        throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','The staged source copy differs from its verified backup projection');
      const copied=copyVerifiedRuntimeSnapshot(targetVerified.snapshot,snapshotRoot,runtimeSnapshotExpected(targetVerified.snapshot));
      if(copied.snapshotDigest!==input.targetArtifactDigest)throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','The copied target export does not retain its registered snapshot identity');
      linkCopiedRuntimeWorkspaces(snapshotRoot);
      const helperPath=join(executionRoot,'build-job.ps1'),driverPath=join(executionRoot,'runtime-upgrade.mjs'),recoveryPath=join(executionRoot,'runtime-recovery.mjs');
      writeExact(helperPath,this.helperBytes);writeExact(driverPath,this.driverBytes);writeExact(recoveryPath,readBounded(join(this.root,'tools','runtime-recovery.mjs')));
      if(sha(readBounded(helperPath))!==host.buildJobDigest||sha(readBounded(driverPath))!==RUNTIME_UPGRADE_TOOL_SHA256||sha(readBounded(recoveryPath))!==RUNTIME_RECOVERY_TOOL_SHA256)
        throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','A fixed upgrade execution input changed during private copying');
      const operationPath=join(executionRoot,'operation.json'),resultPath=join(executionRoot,'result.json'),logPath=join(executionRoot,'private.log');
      const envelope={schema:'quadbridge.runtime-upgrade-operation.v1',operationId,projectRoot:this.root,stagingRoot:stageRoot,executionRoot,
        sourceDataDirectory,targetDataDirectory,dataStage,snapshotRoot,recoveryVerifierPath:recoveryPath,resultPath,sourceIdentity:source,sourceAccessStateDigest,
        sourceBackupDigest:input.sourceBackupDigest,sourceEnrollmentDigest,sourceManifest:backup.manifest,
        sourceModules,targetIdentity:{instanceId:input.instanceId,productId:source.productId,version:input.targetVersion,artifactDigest:input.targetArtifactDigest,
          originatingActorId:targetRelease.originatingActorId,profileDigest:targetPlan.profileDigest,configDigest:targetConfigDigest,adapterDigest:source.adapterDigest,
          toolchainDigest:host.toolchainDigest,recipeDigest:source.recipeDigest,workerRequired:targetPlan.workerRequired},
        targetModules,targetConnections:targetConfig.connections};
      writeExact(operationPath,Buffer.from(canonical(envelope)));
      const refreshedTarget=await this.artifacts.verifyArtifact(input.targetArtifactDigest) as {artifact:Record<string,any>;snapshot:BoundedSnapshot};this.authorize(authorize);
      if(refreshedTarget.snapshot.snapshotDigest!==input.targetArtifactDigest||refreshedTarget.artifact.originatingActorId!==targetRelease.originatingActorId)
        throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','The selected target artifact changed before migration dispatch');
      this.assertHost(this.recovery.captureUpgradeNativeHost());this.authorize(authorize);
      this.store.markManagedRuntimeUpgradeDispatch(operationId,ownerToken,()=>this.authorize(authorize));dispatchBegun=true;
      const proof=await runManagedRuntimeOwnedNativeJob({projectRoot:this.root,operationRoot:executionRoot,helperPath,scriptPath:driverPath,logPath,
        scriptDigest:RUNTIME_UPGRADE_TOOL_SHA256,args:['--operation',operationPath],expectedHost:host,timeoutMs:600000,authorize:()=>this.authorize(authorize)});
      driverEmptyObserved=proof.emptyObserved;driverHelperClosed=proof.helperClosed;
      this.store.recordManagedRuntimeUpgradeDriver(operationId,ownerToken,{empty:proof.emptyObserved,closed:proof.helperClosed,stagingClean:false});driverRecorded=true;
      if(proof.emptyObserved&&proof.helperClosed&&proof.exitCode===0&&!proof.errorCode){
        const result=parseCanonical(readBounded(resultPath)) as Record<string,any>;
        if(result.schema!=='quadbridge.runtime-upgrade-result.v1'||result.operationId!==operationId||result.sourceBackupDigest!==input.sourceBackupDigest||
          canonical(result.targetIdentity)!==canonical(envelope.targetIdentity)||result.sourceEnrollmentDigest!==sourceEnrollmentDigest||
          result.seedDigest!==seedDigest||result.credentialDigest!==sha(backup.files.get('credentials.json')!)||result.privateSeedDigest!==sha(backup.files.get('enrollment-private.json')!)||
          result.accessStateDigestBefore!==sourceAccessStateDigest||result.accessStateDigestAfter!==sourceAccessStateDigest||!Array.isArray(result.targetInventory)||!Array.isArray(result.targetDatabases))
          throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','The closed migration result does not match the selected source and target identities');
        driverResult=result;driverComplete=true;
      }
      if(proof.emptyObserved&&proof.helperClosed){try{deleteExecutionOwned(this.root,executionRoot);executionRoot=undefined;executionClean=true;}catch{}}
      if(executionClean){this.store.recordManagedRuntimeUpgradeDriver(operationId,ownerToken,{empty:proof.emptyObserved,closed:proof.helperClosed,stagingClean:true});driverProofRecorded=true;}
      if(!proof.emptyObserved||!proof.helperClosed||!executionClean)
        throw new RuntimeUpgradeError('RUNTIME_UPGRADE_UNKNOWN','The migration Job did not provide complete original-owner closure and execution cleanup proof');
      if(!driverComplete||proof.exitCode!==0||proof.errorCode){
        this.cleanKnownFailure(stageRoot,executionRoot);stageRoot=undefined;executionRoot=undefined;
        this.store.failManagedRuntimeUpgradeCleanly(operationId,ownerToken,proof.errorCode??'UPGRADE_DRIVER_FAILED',{stagingClean:true});settled=true;
        throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','The initialization-only target migration failed before publication');
      }
      const result=driverResult;
      if(!result)throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','The original migration result was not retained after native closure');
      this.authorize(authorize);
      const independentlyChecked=await this.recovery.inspectUpgradePayload(dataStage,envelope.targetIdentity, result.targetEnrollmentDigest,targetModules,targetDataDirectory);this.authorize(authorize);
      this.assertInspectedResult(result,independentlyChecked,backup,sourceAccessStateDigest);
      const refreshedBackup=await this.recovery.verifyBackupForUpgrade(input.sourceBackupDigest,source,sourceModules);this.authorize(authorize);
      if(refreshedBackup.manifestJson!==backup.manifestJson)throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','The exact source backup changed during migration');
      const refreshedArtifact=await this.artifacts.verifyArtifact(input.targetArtifactDigest) as {artifact:Record<string,any>;snapshot:BoundedSnapshot};this.authorize(authorize);
      if(refreshedArtifact.snapshot.snapshotDigest!==input.targetArtifactDigest||refreshedArtifact.artifact.originatingActorId!==targetRelease.originatingActorId)
        throw new RuntimeUpgradeError('RUNTIME_SOURCE_INVALID','The target artifact changed before no-replace publication');
      this.store.markManagedRuntimeUpgradePublishing(operationId,ownerToken,()=>this.authorize(authorize));
      this.authorize(authorize);publisherStarted=true;
      const move=await this.publish(host,{operationId,instanceId:input.instanceId,targetDigest:input.targetArtifactDigest});publisherComplete=move.resultObserved&&move.closed;published=move.moved;
      this.store.recordManagedRuntimeUpgradePublisher(operationId,ownerToken,move);
      if(!move.resultObserved||!move.closed)throw new RuntimeUpgradeError('RUNTIME_UPGRADE_UNKNOWN','The fixed no-replace publisher result was not fully observed');
      if(!move.moved){this.cleanKnownFailure(stageRoot,executionRoot);stageRoot=undefined;executionRoot=undefined;
        this.store.failManagedRuntimeUpgradeCleanly(operationId,ownerToken,move.status==='EXISTS'?'UPGRADE_DESTINATION_EXISTS':'UPGRADE_PUBLICATION_FAILED',{stagingClean:true});settled=true;
        throw new PlatformError('CONFLICT',move.status==='EXISTS'?'The exact target generation data destination already exists':'The fixed target data publisher did not move its owned payload');}
      this.authorize(authorize);
      const publishedCheck=await this.recovery.inspectUpgradePayload(targetDataDirectory,envelope.targetIdentity,result.targetEnrollmentDigest,targetModules,targetDataDirectory);this.authorize(authorize);
      this.assertInspectedResult(result,publishedCheck,backup,sourceAccessStateDigest);
      if(stageRoot){deleteOwned(physicalDirectory(join(this.root,'.local','platform-runtime-upgrades'),false),stageRoot);stageRoot=undefined;}
      this.authorize(authorize);this.store.recordManagedRuntimeUpgradeVerified(operationId,ownerToken);
      const finalBackup=await this.recovery.verifyBackupForUpgrade(input.sourceBackupDigest,source,sourceModules);this.authorize(authorize);
      if(finalBackup.manifestJson!==backup.manifestJson)throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','The captured source backup changed before generation cutover');
      const completed=this.store.completeManagedRuntimeUpgrade(operationId,ownerToken,()=>this.authorize(authorize));settled=true;return safeUpgrade(completed);
    }catch(error){
      if(!settled){
        if(!dispatchBegun){let clean=false;try{if(executionRoot)deleteExecutionOwned(this.root,executionRoot);if(stageRoot)deleteOwned(join(this.root,'.local','platform-runtime-upgrades'),stageRoot);clean=true;}catch{}
          if(clean){try{this.store.failManagedRuntimeUpgradeCleanly(operationId,ownerToken,this.safeCode(error),{stagingClean:true});settled=true;}catch{try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_PREPARATION_SETTLEMENT_UNKNOWN');}catch{}}}
          else try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_PREPARATION_CLEANUP_UNKNOWN');}catch{}
        }else if(!driverRecorded){try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_DRIVER_UNVERIFIED');}catch{}}
        else if(driverProofRecorded&&!publisherStarted){
          if(stageRoot){try{this.cleanKnownFailure(stageRoot,executionRoot);stageRoot=undefined;executionRoot=undefined;
              this.store.failManagedRuntimeUpgradeCleanly(operationId,ownerToken,this.safeCode(error),{stagingClean:true});settled=true;}
            catch{try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_MIGRATION_CLEANUP_UNKNOWN');}catch{}}}
        }else if(driverRecorded&&!publisherStarted){
          try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,driverEmptyObserved&&driverHelperClosed?'UPGRADE_EXECUTION_CLEANUP_UNVERIFIED':'UPGRADE_DRIVER_UNVERIFIED');}catch{}
        }else if(publisherStarted&&!publisherComplete&&!published){try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_PUBLICATION_UNVERIFIED');}catch{}}
        else if(publisherStarted&&publisherComplete&&!published){try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_FAILURE_SETTLEMENT_UNKNOWN');}catch{}}
        else if(published){try{this.store.markManagedRuntimeUpgradeUnknown(operationId,ownerToken,'UPGRADE_CUTOVER_UNVERIFIED');}catch{}}
      }
      throw error;
    }
  }
  private assertInspectedResult(result:Record<string,any>,checked:Record<string,any>,backup:Record<string,any>,sourceAccessStateDigest:string):void{
    const sourceFiles=new Map((backup.manifest.files as Array<any>).map(row=>[row.path,row]));
    const sourceDb=new Map((backup.manifest.databases as Array<any>).map(row=>[row.path,row]));
    const targetDb=new Map((checked.databases as Array<any>).map(row=>[row.path,row]));
    if(checked.enrollmentDigest!==result.targetEnrollmentDigest||checked.seedDigest!==result.seedDigest||canonical(checked.files)!==canonical(result.targetInventory)||
      canonical(checked.databases)!==canonical(result.targetDatabases)||checked.identity.instanceId!==result.targetIdentity.instanceId||
      checked.identity.productId!==result.targetIdentity.productId||checked.identity.version!==result.targetIdentity.version||checked.identity.artifactDigest!==result.targetIdentity.artifactDigest||
      checked.identity.originatingActorId!==result.targetIdentity.originatingActorId||checked.identity.configDigest!==result.targetIdentity.configDigest||
      result.accessStateDigestBefore!==sourceAccessStateDigest||result.accessStateDigestAfter!==sourceAccessStateDigest||checked.accessStateDigest!==sourceAccessStateDigest||
      result.credentialDigest!==sourceFiles.get('credentials.json')?.digest||
      result.privateSeedDigest!==sourceFiles.get('enrollment-private.json')?.digest||canonical(result.sourceMigrationRows)!==canonical(Object.fromEntries([...sourceDb].map(([path,row])=>[path,(row as any).migrations]))))
      throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','Independent target inspection differs from the closed migration result');
    for(const [path,old] of sourceDb){const current=targetDb.get(path) as Record<string,any>|undefined;const migrations=(old as any).migrations;
      if(!current||!Array.isArray(migrations)||!Array.isArray(current.migrations)||current.migrations.length<migrations.length||canonical(current.migrations.slice(0,migrations.length))!==canonical(migrations))
        throw new RuntimeUpgradeError('RUNTIME_BACKUP_INVALID','Target migration history does not preserve its exact source prefix');}
  }
  private assertHost(host:NativeHost):void{
    const selected=this.recovery.captureUpgradeNativeHost();
    if(host.hostPath.toLowerCase()!==selected.hostPath.toLowerCase()||host.nodePath.toLowerCase()!==selected.nodePath.toLowerCase()||host.toolchainDigest!==selected.toolchainDigest||
      host.buildJobDigest!==selected.buildJobDigest||sha(readBounded(join(this.root,'tools','runtime-upgrade.mjs')))!==RUNTIME_UPGRADE_TOOL_SHA256||
      sha(readBounded(join(this.root,'tools','runtime-upgrade-publish.ps1')))!==RUNTIME_UPGRADE_PUBLISHER_SHA256||sha(readBounded(join(this.root,'tools','runtime-recovery.mjs')))!==RUNTIME_RECOVERY_TOOL_SHA256)
      throw new RuntimeUpgradeError('RUNTIME_UNAVAILABLE','A fixed local upgrade executable or selected native host changed after admission');
  }
  private async publish(host:NativeHost,input:{operationId:string;instanceId:string;targetDigest:string}):Promise<PublisherProof>{
    this.assertHost(host);const nonce=randomBytes(24).toString('hex'),script=join(this.root,'tools','runtime-upgrade-publish.ps1');
    const child=spawn(host.hostPath,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-ProjectRoot',this.root,'-OperationId',input.operationId,
      '-InstanceId',input.instanceId,'-TargetDigest',input.targetDigest,'-Nonce',nonce],{cwd:this.root,windowsHide:true,shell:false,env:this.minimalEnvironment(),stdio:['ignore','pipe','ignore']});
    let output='',outputBytes=0,overflow=false,signal:NodeJS.Signals|null=null,code:number|null=null,spawnError=false,closeObserved=false;
    child.stdout?.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>256){overflow=true;return;}output+=chunk.toString('ascii');});
    child.once('error',()=>{spawnError=true;});
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolveClose=>child.once('close',(exit,closeSignal)=>{closeObserved=true;code=exit;signal=closeSignal;resolveClose({code,signal:closeSignal});}));
    let timedOut=false;try{await this.withTimeout(closed,30000);}
    catch{timedOut=true;try{child.kill();}catch{}try{await this.withTimeout(closed,10000);}catch{}}
    const lines=output.split(/\r?\n/).filter(Boolean),match=lines.length===1&&!overflow?new RegExp(`^QB_UPGRADE_MOVE:${nonce}:(MOVED|EXISTS|FAILED)$`).exec(lines[0]!):null;
    const valid=!timedOut&&closeObserved&&!spawnError&&signal===null&&code!==null&&!!match&&((match[1]==='MOVED'&&code===0)||(match[1]==='EXISTS'&&code===3)||(match[1]==='FAILED'&&code===1));
    const status=valid?match![1] as PublisherProof['status']:'UNKNOWN';return {moved:valid&&status==='MOVED',resultObserved:valid,closed:closeObserved,status};
  }
  private withTimeout<T>(promise:Promise<T>,ms:number):Promise<T>{let timer:NodeJS.Timeout|undefined;return Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('upgrade-timeout')),ms);})]).finally(()=>{if(timer)clearTimeout(timer);});}
  private minimalEnvironment():NodeJS.ProcessEnv{const env:NodeJS.ProcessEnv={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];return env;}
  private cleanKnownFailure(stageRoot:string|undefined,executionRoot:string|undefined):void{
    if(executionRoot)deleteExecutionOwned(this.root,executionRoot);
    if(stageRoot)deleteOwned(join(this.root,'.local','platform-runtime-upgrades'),stageRoot);
  }
  private safeCode(error:unknown){const code=(error as any)?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(code)?code:'UPGRADE_PREPARATION_FAILED';}
  async close(){if(this.closeFlight)return this.closeFlight;this.closing=true;const flight=(async()=>{
    const deadline=performance.now()+60000;while(this.operations.size){const remaining=deadline-performance.now();if(remaining<=0)throw new RuntimeUpgradeError('RUNTIME_UPGRADE_UNKNOWN','Owned runtime upgrade remains active; its operation and dependencies are retained');
      const pending=[...this.operations];await this.withTimeout(Promise.allSettled(pending).then(()=>undefined),remaining);}
  })();this.closeFlight=flight;try{await flight;}catch(error){if(this.closeFlight===flight)this.closeFlight=undefined;throw error;}}
}

function completedEnrollment(root:string,dataDirectory:string,identity:Record<string,any>){
  return completedRuntimeEnrollment({projectRoot:root,dataDirectory,identity:{instanceId:identity.instanceId,productId:identity.productId,version:identity.version,
    artifactDigest:identity.artifactDigest,profileDigest:identity.profileDigest,adapterDigest:identity.adapterDigest}});
}
