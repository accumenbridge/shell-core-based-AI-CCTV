import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, realpathSync, rmSync, writeSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonical, PlatformError } from '@quadbridge/contracts';
import { ControlPlaneStore, MANAGED_RUNTIME_RECOVERY_LIMITS, type ManagedRuntimeRecoveryIdentity, type ManagedRuntimeRecoveryIntent } from '@quadbridge/control-plane';
import type { LocalArtifactStore } from './artifact-store.js';
import { captureManagedRuntimeNativeHost, completedRuntimeEnrollment, runtimeDataDirectory, runtimePlanIdentity } from './runtime-manager.js';

const HASH=/^[a-f0-9]{64}$/;
const INSTANCE=/^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PATH=240, MAX_ENTRIES=16384, MAX_SCAN_MS=2000, MAX_DEPTH=32;
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const recoveryScriptDigest='8fd0981ee90b31673e4487a2de72b4dd6918d8b16abab1dea8131885a364cf35';
const recoveryPublisherDigest='5f08724183c1e6abf21fe4dbd470762df21cb8f26e8c8f98d39335e8079175c5';

export class RuntimeRecoveryError extends Error {
  constructor(readonly code:'RUNTIME_UNAVAILABLE'|'RUNTIME_REPAIR_REQUIRED'|'RUNTIME_BACKUP_INVALID'|'RUNTIME_RECOVERY_UNKNOWN',message:string){super(message);this.name='RuntimeRecoveryError';}
}
type NativeHost={hostPath:string;nodePath:string;toolchainDigest:string;buildJobDigest:string};
type PhysicalInventory={files:Map<string,{size:number;dev:number;ino:number}>;directories:string[];bytes:number;entries:number};
type NativeJob={child:ChildProcess;nonce:string;ready:Promise<void>;closed:Promise<{code:number|null;signal:NodeJS.Signals|null}>;lines:string[];
  transcriptError?:Error;controlError?:Error;send(line:string):void};

function physicalDirectory(path:string,create:boolean):string{
  const full=resolve(path);if(full.length>=MAX_PATH)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The private recovery path exceeds its fixed Windows path bound');
  const parent=dirname(full);if(parent!==full)physicalDirectory(parent,create);
  try{const info=lstatSync(full);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery storage must use physical directories');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||!create)throw error;mkdirSync(full);const info=lstatSync(full);if(!info.isDirectory()||info.isSymbolicLink())throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery directory could not be created safely');}
  return full;
}
function readBounded(path:string,maxBytes:number):Buffer{
  const full=resolve(path),named=lstatSync(full);if(full.length>=MAX_PATH||!named.isFile()||named.isSymbolicLink()||named.size<1||named.size>maxBytes||realpathSync(full).toLowerCase()!==full.toLowerCase())
    throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery input is linked, missing, or outside its fixed byte bound');
  const fd=openSync(full,'r');try{const opened=fstatSync(fd);if(opened.dev!==named.dev||opened.ino!==named.ino||opened.size!==named.size)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery input changed while opening');
    const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery input changed while reading');offset+=count;}
    const probe=Buffer.alloc(1),extra=readSync(fd,probe,0,1,opened.size),after=fstatSync(fd),afterPath=lstatSync(full);
    if(extra||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||afterPath.dev!==opened.dev||afterPath.ino!==opened.ino)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery input changed while reading');return bytes;
  }finally{closeSync(fd);}
}
function writeExclusive(path:string,bytes:Buffer):void{
  const full=resolve(path);if(full.length>=MAX_PATH)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private recovery metadata exceeds the fixed Windows path bound');
  physicalDirectory(dirname(full),false);const fd=openSync(full,'wx');try{const info=fstatSync(fd);if(!info.isFile())throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery output is not a regular file');
    let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery output was incomplete');offset+=count;}fsyncSync(fd);
  }finally{closeSync(fd);}
  const check=lstatSync(full);if(!check.isFile()||check.isSymbolicLink()||check.size!==bytes.length||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery output changed after close');
}
function scanTree(root:string):PhysicalInventory{
  const start=performance.now(),files=new Map<string,{size:number;dev:number|number;ino:number|number}>(),directories:string[]=[],pending=[{path:root,depth:0}];let bytes=0,entries=0;
  const check=()=>{if(entries>MAX_ENTRIES||performance.now()-start>MAX_SCAN_MS)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery metadata scan exceeded its fixed bound');};
  while(pending.length){check();const current=pending.pop()!;if(current.depth>MAX_DEPTH)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery tree exceeds its fixed depth');
    const dir=opendirSync(current.path,{bufferSize:32});try{for(;;){check();const entry=dir.readSync();if(!entry)break;if(++entries>MAX_ENTRIES)check();const path=join(current.path,entry.name);if(path.length>=MAX_PATH)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private recovery file exceeds its fixed path bound');
      const info=lstatSync(path);if(info.isSymbolicLink()||realpathSync(path).toLowerCase()!==path.toLowerCase())throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery tree contains a link or reparse point');
      if(info.isDirectory()){directories.push(path);pending.push({path,depth:current.depth+1});}else if(info.isFile()){files.set(path,{size:info.size,dev:info.dev,ino:info.ino});bytes+=info.size;}else throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery tree contains a special file');
    }}finally{dir.closeSync();}check();
  }
  return {files,directories,bytes,entries};
}
function ensureEmptyAbsent(path:string):boolean{try{const info=lstatSync(path);if(info.isSymbolicLink()||!info.isDirectory())throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Runtime data destination is not an owned physical directory');return false;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}}
function safeDeleteOwned(root:string,path:string):void{
  const base=physicalDirectory(root,false),target=resolve(path),inside=relative(base,target);
  if(!inside||inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside)||target.length>=MAX_PATH)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Recovery cleanup escaped its owner root');
  try{lstatSync(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  scanTree(target);rmSync(target,{recursive:true,force:false,maxRetries:0});try{lstatSync(target);throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Recovery staging cleanup was not observed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
function parseJson(bytes:Buffer):any{try{return JSON.parse(bytes.toString('utf8'));}catch{throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery metadata is malformed');}}
function actorValid(actor:string){return /^operator:[0-9a-f-]{36}$/i.test(actor);}
function validateStopped(store:ControlPlaneStore,instanceId:string):{instance:any;attempt:any;identity:ManagedRuntimeRecoveryIdentity}{
  if(!INSTANCE.test(instanceId))throw new PlatformError('INVALID','Invalid runtime instance reference');
  const instance=store.managedRuntime(instanceId) as Record<string,any>|undefined;if(!instance)throw new PlatformError('NOT_FOUND','Managed runtime instance not found');
  const attempt=(instance.attempts as any[]).find(row=>row.attempt===instance.currentAttempt);
  if(instance.state!=='STOPPED'||!attempt||attempt.state!=='STOPPED'||attempt.physicalState!=='EMPTY'||!attempt.emptyObserved||!attempt.helperClosed||!attempt.executionClean)
    throw new PlatformError('CONFLICT','Recovery requires the exact positively stopped runtime');
  const proof=store.managedRuntimeAttempt(instanceId,attempt.id) as Record<string,any>|undefined;
  if(!proof||proof.id!==attempt.id||proof.state!=='STOPPED'||proof.physicalState!=='EMPTY'||!proof.emptyObserved||!proof.helperClosed||!proof.executionClean||proof.commandState!=='SUCCEEDED'||proof.stopCommandId!==null&&proof.stopCommandState!=='SUCCEEDED')
    throw new PlatformError('CONFLICT','Recovery requires the exact terminal runtime owner proof');
  const identity:ManagedRuntimeRecoveryIdentity={instanceId,attemptId:proof.id,attempt:proof.attempt,commandId:proof.commandId,productId:instance.productId,version:instance.version,
    artifactDigest:instance.artifactDigest,originatingActorId:instance.originatingActorId,profileDigest:instance.profileDigest,configDigest:instance.configDigest,
    adapterDigest:instance.adapterDigest,toolchainDigest:instance.toolchainDigest,recipeDigest:instance.recipeDigest};
  return {instance,attempt:proof,identity};
}
function moduleDescriptors(snapshot:any,plan:any):any[]{
  return plan.plan.modules.map((module:any)=>{
    const entry=snapshot.entries.find((row:any)=>row.path===`modules/${module.id}/module.json`);if(!entry)throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','Promoted snapshot is missing a selected module schema');
    const manifest=parseJson(entry.bytes);if(manifest.id!==module.id||!manifest.schema)throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','Selected promoted module schema is invalid');
    return {id:module.id,schema:manifest.schema};
  });
}
function parseCanonical(bytes:Buffer):any{const value=parseJson(bytes);if(canonical(value)!==bytes.toString('utf8'))throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','Private recovery metadata is not canonical');return value;}
async function withTimeout<T>(promise:Promise<T>,timeoutMs:number,message:string):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new RuntimeRecoveryError('RUNTIME_RECOVERY_UNKNOWN',message)),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
}

export class RuntimeRecoveryManager{
  readonly objectRoot:string;readonly stagingRoot:string;
  private readonly operations=new Set<Promise<unknown>>();private readonly ownedClosures=new Set<Promise<unknown>>();private closing=false;private closeFlight?:Promise<void>;
  private readonly native?:NativeHost;private readonly hostError?:string;private readonly driverSource:Buffer;private readonly publisherSource:Buffer;private readonly helperSource:Buffer;
  private constructor(private readonly root:string,private readonly store:ControlPlaneStore,private readonly artifacts:LocalArtifactStore){
    physicalDirectory(root,false);const local=physicalDirectory(join(root,'.local'),true);const base=physicalDirectory(join(local,'platform-runtime-backups'),true);
    this.objectRoot=physicalDirectory(join(base,'objects'),true);this.stagingRoot=physicalDirectory(join(base,'staging'),true);
    this.driverSource=readBounded(join(root,'tools','runtime-recovery.mjs'),1024*1024);
    this.publisherSource=readBounded(join(root,'tools','runtime-recovery-publish.ps1'),1024*1024);
    this.helperSource=readBounded(join(root,'tools','build-job.ps1'),1024*1024);
    if(sha(this.driverSource)!==recoveryScriptDigest||sha(this.publisherSource)!==recoveryPublisherDigest)
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The fixed local recovery tools do not match their reviewed identities');
    let host:NativeHost|undefined,error:string|undefined;
    try{host=captureManagedRuntimeNativeHost(root);if(host.buildJobDigest!==sha(this.helperSource))throw new Error('helper-identity');}
    catch{error='The selected local native recovery host is unavailable';}
    this.native=host;this.hostError=error;
  }
  static create(root:string,store:ControlPlaneStore,artifacts:LocalArtifactStore){return new RuntimeRecoveryManager(resolve(root),store,artifacts);}
  capability(){return {status:this.native&&!this.closing?'ready':'unavailable',profile:'selected-windows-powershell7',limits:MANAGED_RUNTIME_RECOVERY_LIMITS,
    detail:this.native?'Private local runtime backups are attached to the selected native process-owner profile.':this.hostError??'Private local recovery is closing.'};}
  list(instanceId:string){return {capability:this.capability(),instanceId,backups:this.store.runtimeRecoveryBackups(instanceId),operations:this.store.runtimeRecoveryOperations(instanceId)};}
  operation(operationId:string){return this.store.runtimeRecoveryOperation(operationId);}
  private assertReady(expected=this.native){if(this.closing)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private runtime recovery is closing');if(!this.native)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE',this.hostError??'The selected local recovery host is unavailable');
    if(sha(readBounded(join(this.root,'tools','runtime-recovery.mjs'),1024*1024))!==recoveryScriptDigest||sha(readBounded(join(this.root,'tools','runtime-recovery-publish.ps1'),1024*1024))!==recoveryPublisherDigest||
       sha(readBounded(join(this.root,'tools','build-job.ps1'),1024*1024))!==this.native.buildJobDigest)
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','A fixed recovery tool changed after startup');
    let current:NativeHost;try{current=captureManagedRuntimeNativeHost(this.root);}catch{throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The selected native recovery host changed or is unavailable');}
    if(!expected||current.hostPath.toLowerCase()!==expected.hostPath.toLowerCase()||current.nodePath.toLowerCase()!==expected.nodePath.toLowerCase()||
       current.toolchainDigest!==expected.toolchainDigest||current.buildJobDigest!==expected.buildJobDigest||current.toolchainDigest!==this.native.toolchainDigest)
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The selected native recovery host changed after admission');
    return current;}
  private authorizeCurrent(authorize:()=>unknown):void{
    if(this.closing)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private runtime recovery is closing');
    const value=authorize();
    if(value===false)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The original operator session is no longer authorized');
    if(value!==undefined&&value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as any).then==='function')
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Recovery authorization must be checked synchronously');
    if(this.closing)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private runtime recovery is closing');
  }
  private assertSpawnInputs(host:NativeHost,cwd:string,scriptPath:string,scriptDigest:string):NativeHost{
    const current=this.assertReady(host),helper=readBounded(join(cwd,'build-job.ps1'),1024*1024),script=readBounded(scriptPath,1024*1024);
    if(sha(helper)!==sha(this.helperSource)||sha(script)!==scriptDigest)
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','A staged recovery executable changed before native dispatch');
    return current;
  }
  private safeOperation(operation:Record<string,any>|undefined):Record<string,unknown>|undefined{
    if(!operation)return undefined;
    const id=typeof operation.operationId==='string'?operation.operationId:typeof operation.id==='string'?operation.id:undefined;
    return id?this.store.runtimeRecoveryOperation(id):undefined;
  }
  private track<T>(promise:Promise<T>):Promise<T>{this.operations.add(promise);void promise.finally(()=>this.operations.delete(promise)).catch(()=>{});return promise;}
  private trackClosure<T>(promise:Promise<T>):Promise<T>{this.ownedClosures.add(promise);void promise.finally(()=>this.ownedClosures.delete(promise)).catch(()=>{});return promise;}
  backup(input:{instanceId:string;requestKey:string},actorId:string,authorize:()=>unknown){return this.track(this.createOperation('BACKUP',input.instanceId,actorId,input.requestKey,undefined,authorize));}
  restore(input:{instanceId:string;backupDigest:string;requestKey:string},actorId:string,authorize:()=>unknown){return this.track(this.createOperation('RESTORE',input.instanceId,actorId,input.requestKey,input.backupDigest,authorize));}
  private async createOperation(kind:'BACKUP'|'RESTORE',instanceId:string,actorId:string,requestKey:string,backupDigest:string|undefined,authorize:()=>unknown):Promise<Record<string,unknown>>{
    if(!actorValid(actorId))throw new PlatformError('INVALID','Invalid recovery actor');
    const host=this.assertReady();this.authorizeCurrent(authorize);
      const {instance,attempt,identity}=validateStopped(this.store,instanceId),dataDirectory=runtimeDataDirectory(this.root,instanceId,identity.artifactDigest);
    const release=await this.artifacts.verifyArtifact(identity.artifactDigest) as {artifact:any;snapshot:any};this.authorizeCurrent(authorize);
    if(release.artifact.productId!==identity.productId||release.artifact.version!==identity.version||release.artifact.originatingActorId!==identity.originatingActorId)
      throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','The promoted artifact no longer matches the stopped runtime identity');
    const plan=runtimePlanIdentity(release.snapshot,identity.productId,identity.version),modules=moduleDescriptors(release.snapshot,plan);
    if(plan.profileDigest!==identity.profileDigest)throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','The stopped runtime profile differs from its verified release');
    const payload={kind,instanceId,artifactDigest:identity.artifactDigest,...(backupDigest?{backupDigest}:{})};
    this.authorizeCurrent(authorize);
    const prior=this.store.runtimeRecoveryOperationForRequest(actorId,requestKey,kind,payload) as Record<string,any>|undefined;
    if(prior)return this.safeOperation(prior)!;
    let backup:any,enrollmentDigest='';
    if(kind==='BACKUP'){
      const enrollment=completedRuntimeEnrollment({projectRoot:this.root,dataDirectory,identity:{instanceId,productId:identity.productId,version:identity.version,
        artifactDigest:identity.artifactDigest,profileDigest:identity.profileDigest,adapterDigest:identity.adapterDigest}});
      if(!enrollment||enrollment.configDigest!==identity.configDigest)throw new RuntimeRecoveryError('RUNTIME_REPAIR_REQUIRED','The exact stopped runtime has no valid completed enrollment');
      const intent=parseCanonical(readBounded(join(dataDirectory,'enrollment-intent.json'),1024*1024));
      enrollmentDigest=sha(canonical(intent));
    }
    if(kind==='RESTORE'){
      if(!HASH.test(backupDigest??''))throw new PlatformError('INVALID','Invalid private backup reference');
      backup=this.store.runtimeRecoveryBackup(backupDigest!);if(!backup)throw new PlatformError('NOT_FOUND','Private runtime backup not found');
      if(backup.instanceId!==instanceId||backup.artifactDigest!==identity.artifactDigest||backup.productId!==identity.productId||backup.version!==identity.version||
         backup.originatingActorId!==identity.originatingActorId||backup.configDigest!==identity.configDigest||backup.profileDigest!==identity.profileDigest||
         backup.adapterDigest!==identity.adapterDigest||backup.toolchainDigest!==identity.toolchainDigest||backup.recipeDigest!==identity.recipeDigest)
        throw new PlatformError('CONFLICT','Selected backup does not belong to this exact stopped runtime');
      if(Date.now()<Number(backup.capturedAt))throw new PlatformError('CONFLICT','The local clock is earlier than the selected backup capture time');
      if(!ensureEmptyAbsent(dataDirectory))throw new PlatformError('CONFLICT','Restore requires the exact runtime data destination to be absent');
      if(sha(readBounded(join(this.root,'tools','runtime-recovery.mjs'),1024*1024))!==recoveryScriptDigest)
        throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The fixed recovery verifier changed after startup');
      const verifier=await import(pathToFileURL(join(this.root,'tools','runtime-recovery.mjs')).href) as any;this.authorizeCurrent(authorize);
      const verified=verifier.verifyBackupObject(join(this.root,'.local','platform-runtime-backups'),backupDigest,identity,modules);
      const entries=canonical([...verified.files.entries()].map(([path,bytes]:[string,Buffer])=>({path,digest:sha(bytes),sizeBytes:bytes.length})));
      if(verified.manifestJson!==backup.manifest||verified.manifest.identity.attemptId!==backup.attemptId||verified.manifest.identity.attempt!==backup.attempt||
         verified.manifest.identity.commandId!==backup.commandId||verified.sizeBytes!==backup.sizeBytes||verified.fileCount!==backup.fileCount||entries!==backup.entries)
        throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','The selected immutable backup differs from its verified metadata');
      enrollmentDigest=verified.manifest.enrollmentDigest;
    }
    let estimate:number;
    if(kind==='BACKUP'){
      const source=scanTree(dataDirectory);estimate=source.bytes+2*1024*1024;
    }else estimate=Number(backup.sizeBytes)+2*1024*1024;
    if(!HASH.test(enrollmentDigest))throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','Recovery enrollment identity is invalid');
    if(!Number.isSafeInteger(estimate)||estimate<1||estimate>MANAGED_RUNTIME_RECOVERY_LIMITS.maxStagingBytes)
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','This runtime exceeds the fixed recovery staging reservation');
    const operationId=randomUUID(),ownerId=randomUUID(),ownerToken=randomBytes(32).toString('base64url');
    const operationIdentity={...identity};
    const input:ManagedRuntimeRecoveryIntent={...operationIdentity,operationId,ownerId,ownerToken,actorId,requestKey,kind,
      ...(backupDigest?{backupDigest}:{}),reservedBytes:estimate};
    this.authorizeCurrent(authorize);
    const reservation=this.store.beginManagedRuntimeRecovery(input,()=>this.observeCapacity(estimate),()=>this.authorizeCurrent(authorize));
    if(reservation.reused)return this.safeOperation(reservation.operation)!;
    if(reservation.operationId!==operationId||reservation.ownerToken!==ownerToken)throw new PlatformError('CONFLICT','Recovery admission did not retain exact process ownership');
    const operationRoot=join(this.stagingRoot,operationId);let ownsStage=false,dispatched=false,driverProof=false,driverRecorded=false,publisherStarted=false,publisherProof=false,published=false,settled=false;
    try{
      this.authorizeCurrent(authorize);if(kind==='RESTORE')physicalDirectory(dirname(dataDirectory),true);mkdirSync(operationRoot);ownsStage=true;physicalDirectory(operationRoot,false);
      const envelope={schema:'quadbridge.runtime-recovery-operation.v1',operationId,kind,projectRoot:this.root,recoveryRoot:join(this.root,'.local','platform-runtime-backups'),
        operationRoot,identity:operationIdentity,dataDirectory,...(kind==='BACKUP'?{sourceDataDirectory:dataDirectory}:{destinationDataDirectory:dataDirectory,backupDigest}),
        enrollmentDigest,moduleIds:modules.map(row=>row.id),moduleSchemas:modules};
      writeExclusive(join(operationRoot,'operation.json'),Buffer.from(canonical(envelope)));
      writeExclusive(join(operationRoot,'build-job.ps1'),this.helperSource);
      writeExclusive(join(operationRoot,'runtime-recovery.mjs'),this.driverSource);
      const driverPath=join(operationRoot,'runtime-recovery.mjs');
      this.authorizeCurrent(authorize);
      this.store.markManagedRuntimeRecoveryDispatch(operationId,ownerToken,()=>this.authorizeCurrent(authorize));dispatched=true;
      const nonce=randomBytes(24).toString('base64url');
      this.authorizeCurrent(authorize);
      const job=this.spawnJob(host,operationRoot,driverPath,['--operation',join(operationRoot,'operation.json')],join(operationRoot,'private.log'),nonce);
      const proof=await this.runJob(job,30000,()=>this.authorizeCurrent(authorize));driverProof=proof.empty&&proof.helperClosed;
      this.store.recordManagedRuntimeRecoveryDriverClosed(operationId,ownerToken,proof.empty,proof.helperClosed);driverRecorded=true;
      if(!driverProof)throw new RuntimeRecoveryError('RUNTIME_RECOVERY_UNKNOWN','The fixed recovery driver did not return a complete owned result');
      if(proof.operationError||proof.code!==0)throw proof.operationError??new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','The fixed recovery driver reported a bounded operation failure');
      this.authorizeCurrent(authorize);
      const driverResult=parseCanonical(readBounded(join(operationRoot,'result.json'),1024*1024));
      if(driverResult.schema!=='quadbridge.runtime-recovery-result.v1'||driverResult.operationId!==operationId||driverResult.kind!==kind)
        throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','The bounded recovery driver result does not match its operation');
      if(kind==='BACKUP'&&(!HASH.test(driverResult.digest)||!Number.isSafeInteger(driverResult.capturedAt)||driverResult.sizeBytes<1||driverResult.fileCount<1))
        throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','The recovery driver returned invalid backup metadata');
      this.authorizeCurrent(authorize);
      this.store.markManagedRuntimeRecoveryPublishing(operationId,ownerToken,()=>this.authorizeCurrent(authorize));publisherStarted=true;
      this.authorizeCurrent(authorize);
      const move=await this.publish(host,{kind,operationId,instanceId,artifactDigest:identity.artifactDigest,backupDigest:kind==='BACKUP'?driverResult.digest:'none'},nonce);
      publisherProof=move.resultObserved&&move.closed;published=move.moved;
      this.store.recordManagedRuntimeRecoveryPublisherClosed(operationId,ownerToken,move.moved,move.resultObserved,move.closed);
      if(!move.resultObserved||!move.closed)throw new RuntimeRecoveryError('RUNTIME_RECOVERY_UNKNOWN','The fixed recovery publisher result could not be verified');
      if(!move.moved){safeDeleteOwned(this.stagingRoot,operationRoot);ownsStage=false;
        this.store.failManagedRuntimeRecoveryCleanly(operationId,ownerToken,move.status==='EXISTS'?'RECOVERY_DESTINATION_EXISTS':'RECOVERY_PUBLICATION_FAILED');
        settled=true;
        throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID',move.status==='EXISTS'?'The exact recovery destination already exists':'The fixed recovery publication did not move its owned payload');}
      this.authorizeCurrent(authorize);
      const copiedDriver=await import(pathToFileURL(driverPath).href) as any;
      this.authorizeCurrent(authorize);
      if(kind==='BACKUP'){
        const verified=copiedDriver.verifyBackupObject(join(this.root,'.local','platform-runtime-backups'),driverResult.digest,identity,modules);
        if(verified.manifestJson!==driverResult.manifest||verified.manifest.identity.attemptId!==identity.attemptId||verified.manifest.identity.attempt!==identity.attempt||
           verified.manifest.identity.commandId!==identity.commandId||verified.sizeBytes!==driverResult.sizeBytes||verified.fileCount!==driverResult.fileCount)
          throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','Published backup bytes differ from their closed driver result');
        this.store.recordManagedRuntimeRecoveryVerified(operationId,ownerToken,driverResult.digest,driverResult.capturedAt);
        safeDeleteOwned(this.stagingRoot,operationRoot);ownsStage=false;
        const completed=this.store.completeManagedRuntimeRecovery(operationId,ownerToken,{digest:driverResult.digest,capturedAt:driverResult.capturedAt,
          sizeBytes:verified.sizeBytes,fileCount:verified.fileCount,manifest:verified.manifestJson,entries:canonical([...verified.files.entries()].map(([path,bytes]:[string,Buffer])=>({path,digest:sha(bytes),sizeBytes:bytes.length})) )},()=>this.authorizeCurrent(authorize));
        settled=true;return this.safeOperation(completed)!;
      }
      const manifest=parseCanonical(Buffer.from(backup.manifest));
      const checked=copiedDriver.verifyRestoredDataDirectory(dataDirectory,manifest,identity,modules);
      if(checked.fileCount!==manifest.files.length)throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','Restored runtime data inventory differs from its verified backup');
      this.store.recordManagedRuntimeRecoveryVerified(operationId,ownerToken,undefined,undefined);
      safeDeleteOwned(this.stagingRoot,operationRoot);ownsStage=false;
      const completed=this.store.completeManagedRuntimeRecovery(operationId,ownerToken,undefined,()=>this.authorizeCurrent(authorize));settled=true;return this.safeOperation(completed)!;
    }catch(error){
      if(!settled&&!dispatched){let clean=false;if(ownsStage){try{safeDeleteOwned(this.stagingRoot,operationRoot);ownsStage=false;clean=true;}catch{} }
        else{try{lstatSync(operationRoot);}catch(statError){if((statError as NodeJS.ErrnoException).code==='ENOENT')clean=true;}}
        if(clean)this.store.settleManagedRuntimeRecoveryPreparation(operationId,ownerToken,{stagingClean:true,errorCode:this.safeCode(error)});
        else this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_PREPARATION_CLEANUP_UNKNOWN');}
      else if(!settled&&dispatched&&!driverRecorded){try{this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_DRIVER_UNVERIFIED');}catch{}}
      else if(!settled&&dispatched&&driverRecorded&&driverProof&&!publisherStarted){let clean=false;try{safeDeleteOwned(this.stagingRoot,operationRoot);ownsStage=false;clean=true;}catch{}
        if(clean){try{this.store.failManagedRuntimeRecoveryCleanly(operationId,ownerToken,'RECOVERY_DRIVER_FAILED');settled=true;}
          catch{try{this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_FAILURE_SETTLEMENT_UNKNOWN');}catch{}}}
        else try{this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_DRIVER_CLEANUP_UNKNOWN');}catch{}}
      else if(!settled&&dispatched&&publisherStarted&&!publisherProof&&!published){try{this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_PUBLICATION_UNVERIFIED');}catch{}}
      else if(!settled&&dispatched&&publisherStarted&&publisherProof&&!published){try{this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_FAILURE_SETTLEMENT_UNKNOWN');}catch{}}
      else if(!settled&&dispatched&&published){try{this.store.markManagedRuntimeRecoveryUnknown(operationId,ownerToken,'RECOVERY_COMPLETION_UNVERIFIED');}catch{}}
      throw error;
    }
  }
  private safeCode(error:unknown){const code=(error as any)?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(code)?code:'RECOVERY_PREPARATION_FAILED';}
  private observeCapacity(reserved:number){
    const objects=scanTree(this.objectRoot),staging=scanTree(this.stagingRoot);const objectEntries=[...objects.files.keys()].filter(path=>path!==join(this.objectRoot,'') ).length+objects.directories.length;
    return {backupBytes:objects.bytes,stagingBytes:staging.bytes,objectCount:objects.directories.filter(path=>dirname(path)===this.objectRoot).length,
      entryCount:objects.entries+staging.entries};
  }
  private spawnJob(host:NativeHost,cwd:string,script:string,args:string[],logPath:string,nonce:string):NativeJob{
    const argsJson=JSON.stringify(args),helper=join(cwd,'build-job.ps1'),selected=this.assertSpawnInputs(host,cwd,script,sha(this.driverSource));
    const child=spawn(selected.hostPath,['-NoLogo','-NoProfile','-NonInteractive','-File',helper,'-RunnerNonce',nonce,'-NodeExe',selected.nodePath,'-WorkingDirectory',cwd,
      '-ScriptPath',script,'-ArgumentsJson',argsJson,'-LogPath',logPath,'-RuntimeProtocol'],{cwd,windowsHide:true,shell:false,env:this.minimalEnvironment(),stdio:['pipe','pipe','pipe']});
    let resolveReady!:()=>void,resolveClose!:(value:{code:number|null;signal:NodeJS.Signals|null})=>void;
    const ready=new Promise<void>(resolveReadyPromise=>{resolveReady=resolveReadyPromise;}),closed=this.trackClosure(new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolvePromise=>{resolveClose=resolvePromise;}));
    const lines:string[]=[];let buffer='',stdoutBytes=0,transcriptError:Error|undefined,controlError:Error|undefined;
    child.stdout?.on('data',(chunk:Buffer)=>{stdoutBytes+=chunk.length;if(stdoutBytes>4096){transcriptError=new Error('native-protocol-overflow');return;}buffer+=chunk.toString('ascii');
      for(;;){const at=buffer.indexOf('\n');if(at<0)break;let line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.endsWith('\r'))line=line.slice(0,-1);lines.push(line);
        if(line===`QB_READY:${nonce}`){if(lines.filter(value=>value===`QB_READY:${nonce}`).length!==1)transcriptError=new Error('native-ready-duplicate');else resolveReady();}
        else if(!new RegExp(`^QB_EXIT:${nonce}:(?:\\d+:EMPTY|UNKNOWN)$`).test(line))transcriptError=new Error('native-protocol-invalid');}
    });
    child.once('error',()=>{transcriptError=new Error('native-helper-error');});
    child.once('close',(code,signal)=>{if(buffer)transcriptError=new Error('native-protocol-incomplete');resolveClose({code,signal});});
    child.stdin?.on('error',()=>{controlError??=new Error('native-control-error');});
    const sent=new Set<string>(),send=(line:string)=>{if(!['RESUME','STOP'].includes(line.split(':')[0]!)||line!==`${line.split(':')[0]}:${nonce}`||sent.has(line))throw new RuntimeRecoveryError('RUNTIME_RECOVERY_UNKNOWN','Invalid recovery driver control');sent.add(line);try{child.stdin?.write(`${line}\n`,error=>{if(error)controlError??=new Error('native-control-error');});}catch{controlError??=new Error('native-control-error');}};
    return {child,nonce,ready,closed,lines,get transcriptError(){return transcriptError;},get controlError(){return controlError;},send};
  }
  private async runJob(job:NativeJob,timeoutMs:number,authorize:()=>void){
    let closed:{code:number|null;signal:NodeJS.Signals|null}|undefined,operationError:unknown;
    try{
      await withTimeout(Promise.race([job.ready,job.closed.then(()=>{throw new Error('native-closed-before-ready');})]),timeoutMs,'The recovery helper did not become ready within its fixed bound');
      if(job.transcriptError)throw job.transcriptError;
      if(job.controlError)throw job.controlError;
      authorize();
      job.send(`RESUME:${job.nonce}`);
      closed=await withTimeout(job.closed,timeoutMs,'The owned recovery process tree did not close within its fixed bound');
    }catch(error){
      operationError=error;
      if(job.child.exitCode===null&&job.child.signalCode===null){try{job.send(`STOP:${job.nonce}`);}catch{} }
      try{closed=await withTimeout(job.closed,10000,'The owned recovery process tree did not close within its fixed bound');}
      catch{throw new RuntimeRecoveryError('RUNTIME_RECOVERY_UNKNOWN','The owned recovery process tree did not close within its fixed bound');}
    }
    if(job.controlError&&!operationError)operationError=job.controlError;
    const exitLines=job.lines.filter(line=>line.startsWith(`QB_EXIT:${job.nonce}:`));
    const exit=exitLines.length===1?new RegExp(`^QB_EXIT:${job.nonce}:(\\d+):EMPTY$`).exec(exitLines[0]!):null;
    const unknown=exitLines.length===1&&exitLines[0]===`QB_EXIT:${job.nonce}:UNKNOWN`;
    const helperClosed=closed!.signal===null&&closed!.code!==null,empty=!job.transcriptError&&!!exit&&!unknown&&Number(exit[1])===closed!.code&&helperClosed;
    return {code:closed!.code,signal:closed!.signal,empty,helperClosed,operationError};
  }
  private async publish(host:NativeHost,input:{kind:'BACKUP'|'RESTORE';operationId:string;instanceId:string;artifactDigest:string;backupDigest:string},nonce:string){
    const script=join(this.root,'tools','runtime-recovery-publish.ps1');const selected=this.assertReady(host);
    if(sha(readBounded(script,1024*1024))!==recoveryPublisherDigest||sha(this.publisherSource)!==recoveryPublisherDigest)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The fixed no-overwrite recovery publisher changed');
    const child=spawn(selected.hostPath,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-ProjectRoot',this.root,'-OperationId',input.operationId,'-Kind',input.kind,
      '-ArtifactDigest',input.artifactDigest,'-BackupDigest',input.backupDigest,'-InstanceId',input.instanceId,'-Nonce',nonce],{cwd:this.root,windowsHide:true,shell:false,env:this.minimalEnvironment(),stdio:['ignore','pipe','ignore']});
    let stdout='',stdoutBytes=0,overflow=false,signal:NodeJS.Signals|null=null,exitCode:number|null=null,spawnError=false,closeObserved=false;
    child.stdout?.on('data',(chunk:Buffer)=>{stdoutBytes+=chunk.length;if(stdoutBytes>256){overflow=true;return;}stdout+=chunk.toString('ascii');});
    child.once('error',()=>{spawnError=true;});
    const closed=this.trackClosure(new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolveClose=>child.once('close',(code,childSignal)=>{closeObserved=true;exitCode=code;signal=childSignal;resolveClose({code,signal:childSignal});})));
    try{await withTimeout(closed,30000,'The fixed recovery publisher did not close within its bound');}
    catch(error){try{child.kill();}catch{}try{await withTimeout(closed,10000,'The fixed recovery publisher remains owned after its close request');}catch{}
      throw error;}
    const rows=stdout.split(/\r?\n/).filter(Boolean),match=rows.length===1?new RegExp(`^QB_RECOVERY_MOVE:${nonce}:(MOVED|EXISTS|FAILED)$`).exec(rows[0]!):null;
    const closedPositive=exitCode!==null&&signal===null&&!spawnError&&!overflow&&!!match&&((match[1]==='MOVED'&&exitCode===0)||(match[1]==='EXISTS'&&exitCode===3)||(match[1]==='FAILED'&&exitCode===1));
    return {moved:closedPositive&&match![1]==='MOVED',resultObserved:closedPositive,closed:closeObserved,status:closedPositive?match![1]:'UNKNOWN'};
  }
  private minimalEnvironment():NodeJS.ProcessEnv{const env:NodeJS.ProcessEnv={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];return env;}
  async verify(instanceId:string,digest:string){
    if(this.closing)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private runtime recovery is closing');
    const metadata=this.store.runtimeRecoveryBackup(digest) as Record<string,any>|undefined;if(!metadata||metadata.instanceId!==instanceId)throw new PlatformError('NOT_FOUND','Private runtime backup not found');
    if(sha(readBounded(join(this.root,'tools','runtime-recovery.mjs'),1024*1024))!==recoveryScriptDigest)
      throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','The fixed recovery verifier changed after startup');
    const loaded=await import(pathToFileURL(join(this.root,'tools','runtime-recovery.mjs')).href) as any;
    if(this.closing)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private runtime recovery is closing');
    const release=this.store.artifactRecord(metadata.artifactDigest);if(!release)throw new PlatformError('NOT_FOUND','The immutable runtime release is unavailable');
    const verifiedArtifact=await this.artifacts.verifyArtifact(metadata.artifactDigest);
    if(this.closing)throw new RuntimeRecoveryError('RUNTIME_UNAVAILABLE','Private runtime recovery is closing');
    const plan=runtimePlanIdentity(verifiedArtifact.snapshot,metadata.productId,metadata.version),modules=moduleDescriptors(verifiedArtifact.snapshot,plan);
    const check=loaded.verifyBackupObject(join(this.root,'.local','platform-runtime-backups'),digest,metadata,modules);
    if(check.manifestJson!==metadata.manifest||canonical([...check.files.entries()].map(([path,bytes]:[string,Buffer])=>({path,digest:sha(bytes),sizeBytes:bytes.length})))!==metadata.entries)
      throw new RuntimeRecoveryError('RUNTIME_BACKUP_INVALID','Private backup metadata does not match its verified local object');
    return {digest,instanceId,sizeBytes:check.sizeBytes,fileCount:check.fileCount,capturedAt:metadata.capturedAt,verified:true};
  }
  async verifyBackup(digest:string){
    const metadata=this.store.runtimeRecoveryBackup(digest) as Record<string,any>|undefined;
    if(!metadata)throw new PlatformError('NOT_FOUND','Private runtime backup not found');
    return this.verify(String(metadata.instanceId),digest);
  }
  async close(){if(this.closeFlight)return this.closeFlight;this.closing=true;const flight=(async()=>{
    const deadline=performance.now()+60000;
    while(this.operations.size||this.ownedClosures.size){
      const remaining=deadline-performance.now();if(remaining<=0)throw new RuntimeRecoveryError('RUNTIME_RECOVERY_UNKNOWN','Owned recovery work remains active; its private reservation is retained');
      const pending=[...this.operations,...this.ownedClosures];
      await withTimeout(Promise.allSettled(pending).then(()=>undefined),remaining,'Owned recovery work remains active; its private reservation is retained');
    }
  })();this.closeFlight=flight;try{await flight;}catch(error){if(this.closeFlight===flight)this.closeFlight=undefined;throw error;}}
}
