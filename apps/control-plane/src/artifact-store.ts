import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonical, PlatformError } from '@quadbridge/contracts';
import { ControlPlaneStore, ARTIFACT_REGISTRY_LIMITS, type ArtifactCapacityObservation, type ArtifactBuildIdentity } from '@quadbridge/control-plane';
import { readBoundedSnapshot, type BoundedSnapshot } from '@quadbridge/composition/snapshot-access';
import { assertWindowsBuildHost, type WindowsBuildHostProfile } from './build-host.js';

const PUBLISHER_SHA256 = '21193a3fb4ac19b966bc797f980eddc800cf7673485060ab02a09caa9adf3bb9';
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const actorPattern = /^(?:operator:[0-9a-f-]{36}|system:[a-z][a-z0-9-]{1,63})$/;

function physicalDirectory(path: string, create: boolean): string {
  const full = resolve(path);
  const parent = dirname(full);
  if (parent !== full) physicalDirectory(parent, false);
  try {
    const info = lstatSync(full);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase()) throw new Error('Local artifact storage contains a link or special directory');
    return full;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    mkdirSync(full);
    const info = lstatSync(full);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase()) throw new Error('Local artifact storage could not be created as a physical directory');
    return full;
  }
}

function physicalRegularFile(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('Local artifact file is not a physical regular file');
  return path;
}

function scanPhysicalCapacity(objects: string, staging: string): ArtifactCapacityObservation {
  let registryBytes = 0, stagingBytes = 0, objectDirectories = 0, seen = 0;
  const started=performance.now();
  const walk = (root: string, isStaging: boolean) => {
    const pending: Array<{ path: string; depth: number; direct: boolean }> = [{path:root,depth:0,direct:false}];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.depth > ARTIFACT_REGISTRY_LIMITS.maxDirectoryDepth) throw new Error('Artifact registry storage exceeds the supported directory depth');
      const handle=opendirSync(current.path,{bufferSize:32});
      try { while(true) {
        const entry=handle.readSync();
        if(!entry)break;
        if (++seen > ARTIFACT_REGISTRY_LIMITS.maxMetadataEntries||performance.now()-started>ARTIFACT_REGISTRY_LIMITS.maxMetadataScanMs) throw new Error('Artifact registry storage exceeds the bounded metadata scan');
        const full = join(current.path,entry.name), info = lstatSync(full);
        if (info.isSymbolicLink()) throw new Error('Artifact registry storage contains a link');
        if (info.isDirectory()) {
          if (!isStaging && current.depth===0) objectDirectories++;
          if(objectDirectories>ARTIFACT_REGISTRY_LIMITS.maxObjectDirectories)throw new Error('Artifact registry object-directory capacity is over its configured limit');
          pending.push({path:full,depth:current.depth+1,direct:false});
        } else if (info.isFile()) {
          if (isStaging) stagingBytes += info.size; else registryBytes += info.size;
          if (registryBytes > ARTIFACT_REGISTRY_LIMITS.maxRegistryBytes || stagingBytes > ARTIFACT_REGISTRY_LIMITS.maxStagingBytes) throw new Error('Artifact registry physical capacity is over its configured limit');
        } else throw new Error('Artifact registry storage contains a non-regular entry');
      }} finally { handle.closeSync(); }
    }
  };
  physicalDirectory(objects,false); physicalDirectory(staging,false);
  walk(objects,false); walk(staging,true);
  if(performance.now()-started>ARTIFACT_REGISTRY_LIMITS.maxMetadataScanMs)throw new Error('Artifact registry storage exceeds the bounded metadata scan');
  registryBytes+=stagingBytes;
  return {registryBytes,stagingBytes,objectDirectories};
}

function safeUnder(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.split('/').some(part => !part || part==='.' || part==='..' || /[\x00-\x1f\x7f:]/.test(part))) throw new Error('Unsafe private artifact path');
  const full=resolve(root,...relativePath.split('/')), rel=relative(root,full);
  if (!rel || rel==='..' || rel.startsWith(`..${sep}`)) throw new Error('Private artifact path escaped its owned root');
  return full;
}

function checkPathPhysical(path: string, root: string): void {
  physicalDirectory(root,false);
  const full=resolve(path), base=resolve(root), rel=relative(base,full);
  if (!rel || rel==='..' || rel.startsWith(`..${sep}`)) throw new Error('Artifact path is outside its owned storage root');
  let current=base;
  const parts=rel.split(sep);
  for (const [index,part] of parts.entries()) {
    current=join(current,part);
    const info=lstatSync(current);
    if (info.isSymbolicLink() || (index<parts.length-1&&!info.isDirectory())) throw new Error('Artifact path crosses a link or non-directory component');
  }
}

function ensurePhysicalDirectory(path:string,root:string):void {
  const full=resolve(path),base=resolve(root),rel=relative(base,full);
  if(!rel){physicalDirectory(base,false);return;}
  if(rel==='..'||rel.startsWith(`..${sep}`))throw new Error('Artifact directory escaped its owned root');
  let current=base;
  for(const part of rel.split(sep)) {
    current=join(current,part);
    try { mkdirSync(current); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error; }
    const info=lstatSync(current);
    if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(current).toLowerCase()!==current.toLowerCase())throw new Error('Artifact directory crosses a link or special entry');
  }
}

function assertPhysicalTree(root:string,ownedRoot:string):void {
  checkPathPhysical(root,ownedRoot);
  const pending:Array<{path:string;depth:number}>=[{path:root,depth:0}],started=performance.now();
  let seen=0;
  while(pending.length) {
    const current=pending.pop()!;
    if(current.depth>ARTIFACT_REGISTRY_LIMITS.maxDirectoryDepth)throw new Error('Private staging exceeds the supported directory depth');
    const handle=opendirSync(current.path,{bufferSize:32});
    try { while(true) {
      const entry=handle.readSync();if(!entry)break;
      if(++seen>ARTIFACT_REGISTRY_LIMITS.maxMetadataEntries||performance.now()-started>ARTIFACT_REGISTRY_LIMITS.maxMetadataScanMs)throw new Error('Private staging exceeds its bounded cleanup scan');
      const full=join(current.path,entry.name),info=lstatSync(full);
      if(info.isSymbolicLink())throw new Error('Private staging contains a link; cleanup is not safe');
      if(info.isDirectory())pending.push({path:full,depth:current.depth+1});
      else if(!info.isFile())throw new Error('Private staging contains a special file; cleanup is not safe');
    }} finally {handle.closeSync();}
  }
  if(performance.now()-started>ARTIFACT_REGISTRY_LIMITS.maxMetadataScanMs)throw new Error('Private staging exceeds its bounded cleanup scan');
}

export interface ArtifactPublicCapability {
  status: 'ready'|'unavailable';
  detail: string;
  platform: string;
  hostIdentity: string;
}

export class ArtifactStoreUnavailable extends Error {
  constructor(message: string) { super(message); this.name='ArtifactStoreUnavailable'; }
}
class PhysicalPublicationUnknown extends Error {}
class KnownNoPublication extends Error {}

type PublisherFailureCategory = 'CLOSE_TIMEOUT'|'TIMED_OUT'|'OUTPUT_OVERFLOW'|'SIGNAL_EXIT'|'MISSING_RECORD'|'MULTIPLE_RECORDS'|'NONCE_MISMATCH'|'MALFORMED_RECORD'|'EXIT_MISMATCH'|'UNEXPECTED_OUTPUT';
interface RegistryPublisherFailureDiagnostics {
  category:PublisherFailureCategory; elapsedMs:number; closeCode:number|null; closeSignal:NodeJS.Signals|null;
  closeObserved:boolean; stdoutBytes:number; stdoutBytesCapped:boolean; stdoutSha256:string;
  stderrBytes:number; stderrBytesCapped:boolean; stderrSummary:string;
}
const publisherDiagnosticsKey='__qbRegistryPublisherDiagnostics';
function attachPublisherDiagnostics(error:PhysicalPublicationUnknown,diagnostics:RegistryPublisherFailureDiagnostics) {
  Object.defineProperty(error,publisherDiagnosticsKey,{value:Object.freeze(diagnostics),enumerable:false});
  return error;
}

function publisherFailureCategory(stdout:string,nonce:string,code:number|null,signal:NodeJS.Signals|null,overflow:boolean):PublisherFailureCategory {
  if(overflow)return 'OUTPUT_OVERFLOW';
  if(signal)return 'SIGNAL_EXIT';
  const lines=stdout.split(/\r?\n/).filter(Boolean);
  if(lines.length===0)return 'MISSING_RECORD';
  if(lines.length!==1)return 'MULTIPLE_RECORDS';
  const match=/^QB_REGISTRY_MOVE:([-_A-Za-z0-9]{16,64}):(MOVED|EXISTS|FAILED)$/.exec(lines[0]!);
  if(!match)return lines[0]!.startsWith('QB_REGISTRY_MOVE:')?'MALFORMED_RECORD':'UNEXPECTED_OUTPUT';
  if(match[1]!==nonce)return 'NONCE_MISMATCH';
  const expectedCode=match[2]==='MOVED'?0:match[2]==='EXISTS'?3:1;
  return code===expectedCode?'UNEXPECTED_OUTPUT':'EXIT_MISMATCH';
}
function redactedPublisherStderr(stderr:string,nonce:string,operationId:string,paths:readonly string[]):string {
  let value=stderr.replaceAll(nonce,'[nonce]').replaceAll(operationId,'[operation]');
  const variants=new Set<string>();
  for(const path of paths)if(path){variants.add(path);variants.add(path.replaceAll('\\','/'));variants.add(path.replaceAll('/','\\'));}
  for(const path of [...variants].sort((a,b)=>b.length-a.length))value=value.replace(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'[path]');
  value=value.replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\)[^"']+\1/g,'[path]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g,'[path]')
    .replace(/(?<![A-Za-z0-9])\/(?:[^\s"'<>|]+\/?)+/g,'[path]')
    .replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g,' ').replace(/\s+/g,' ').trim();
  let summary='';
  for(const character of Array.from(value).reverse()) {
    if(Buffer.byteLength(summary+character)>2048)break;
    summary=character+summary;
  }
  return summary;
}

export function parseRegistryPublisherTranscript(stdout:string,nonce:string,code:number|null,signal:NodeJS.Signals|null,overflow=false):'MOVED'|'EXISTS'|'FAILED'|'UNKNOWN' {
  if(overflow||!/^[-_A-Za-z0-9]{16,64}$/.test(nonce))return 'UNKNOWN';
  const lines=stdout.split(/\r?\n/).filter(Boolean);
  if(lines.length!==1)return 'UNKNOWN';
  const match=new RegExp(`^QB_REGISTRY_MOVE:${nonce}:(MOVED|EXISTS|FAILED)$`).exec(lines[0]!);
  if(!match||signal)return 'UNKNOWN';
  if(match[1]==='MOVED'&&code===0)return 'MOVED';
  if(match[1]==='EXISTS'&&code===3)return 'EXISTS';
  if(match[1]==='FAILED'&&code===1)return 'FAILED';
  return 'UNKNOWN';
}

export class LocalArtifactStore {
  readonly objectsRoot: string;
  readonly stagingRoot: string;
  readonly capability: ArtifactPublicCapability;
  private readonly sourceSnapshotsRoot: string;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly activeHelpers = new Set<Promise<unknown>>();
  private readonly startedOperationIds = new Set<string>();
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly publisherPath: string;
  private readonly host?: WindowsBuildHostProfile;
  private readonly publisherProblem: string;

  private constructor(private readonly root:string, private readonly store:ControlPlaneStore, host?:WindowsBuildHostProfile, hostError?:string) {
    this.host=host;
    physicalDirectory(join(root,'.local','platform-artifacts'),true);
    this.objectsRoot=physicalDirectory(join(root,'.local','platform-artifacts','objects'),true);
    this.stagingRoot=physicalDirectory(join(root,'.local','platform-artifacts','staging'),true);
    this.sourceSnapshotsRoot=join(root,'.local','platform-builds','snapshots');
    this.publisherPath=join(root,'tools','registry-publish.ps1');
    let helperValid=false, publisherProblem='';
    try {
      const info=lstatSync(this.publisherPath);
      if(info.isSymbolicLink()||!info.isFile())throw new Error('The fixed registry publisher must be a regular file');
      helperValid=sha256(readFileSync(physicalRegularFile(this.publisherPath)))===PUBLISHER_SHA256;
      if(!helperValid)publisherProblem='The fixed registry publisher changed from its reviewed identity.';
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')publisherProblem='The fixed local registry publisher is not installed; existing artifacts remain readable and promotable.';
      else throw error;
    }
    this.publisherProblem=publisherProblem;
    const hostIdentity=host?canonical({kind:host.kind,sha256:host.sha256,version:host.version,policy:host.policy}):'';
    const ready=helperValid&&Boolean(host)&&!hostError;
    this.capability={status:ready?'ready':'unavailable',platform:process.platform,hostIdentity,
      detail:ready?'Fixed local no-overwrite publisher is pinned and passed its selected private host preflight.':
        publisherProblem?publisherProblem:
        process.platform!=='win32'?'Physical registry publication is unavailable on this host profile.':
        hostError??'The selected private publication host is unavailable; existing artifacts remain readable and promotable.'};
  }

  static async create(root:string,store:ControlPlaneStore):Promise<LocalArtifactStore> {
    const project=physicalDirectory(root,false);
    physicalDirectory(join(project,'.local'),true);
    physicalDirectory(join(project,'.local','platform-artifacts'),true);
    let host:WindowsBuildHostProfile|undefined, hostError:string|undefined;
    if(process.platform==='win32') {
      try { host=assertWindowsBuildHost(project,project); }
      catch { hostError='Private publication host preflight failed'; }
    }
    return new LocalArtifactStore(project,store,host,hostError);
  }

  private assertReady() {
    if(this.closing) throw new ArtifactStoreUnavailable('The local artifact registry is closing');
    if(this.capability.status!=='ready'||!this.host) throw new ArtifactStoreUnavailable(this.capability.detail);
    if(this.publisherHash()!==PUBLISHER_SHA256) throw new ArtifactStoreUnavailable('The fixed registry publisher identity changed; restart the local control plane');
    if(resolve(this.host.path).length>=240) throw new ArtifactStoreUnavailable('The selected local publication host path exceeds the supported Windows path bound');
    let current:WindowsBuildHostProfile|undefined;
    try { current=assertWindowsBuildHost(this.root,this.root); } catch { throw new ArtifactStoreUnavailable('The selected private publication host failed its current preflight'); }
    if(!current||current.path!==this.host.path||canonical({kind:current.kind,sha256:current.sha256,version:current.version,policy:current.policy})!==this.capability.hostIdentity)
      throw new ArtifactStoreUnavailable('The selected private publication host changed; restart the local control plane');
    return this.host;
  }

  private publisherHash() { try { return sha256(readFileSync(physicalRegularFile(this.publisherPath))); } catch { return ''; } }
  private observeCapacitySync() { return scanPhysicalCapacity(this.objectsRoot,this.stagingRoot); }
  private targetPath(digest:string) {
    if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('Invalid local artifact digest');
    const target=safeUnder(this.objectsRoot,digest);
    const rel=relative(this.objectsRoot,target);
    if(rel!==digest)throw new Error('Artifact target identity mismatch');
    return target;
  }
  private sourcePath(identity:ArtifactBuildIdentity) {
    physicalDirectory(this.sourceSnapshotsRoot,false);
    const snapshot=safeUnder(this.sourceSnapshotsRoot,identity.snapshotId);
    checkPathPhysical(snapshot,this.sourceSnapshotsRoot);
    return snapshot;
  }
  private expected(identity:ArtifactBuildIdentity) {
    return {buildId:identity.buildId,productId:identity.productId,version:identity.version,inputDigest:identity.inputDigest,
      sourceFingerprint:identity.sourceFingerprint,toolchainDigest:identity.toolchainDigest,recipeVersion:identity.recipeVersion,
      releaseDigest:identity.releaseDigest,snapshotDigest:identity.snapshotDigest};
  }
  private readSnapshot(path:string,identity:ArtifactBuildIdentity):BoundedSnapshot {
    return readBoundedSnapshot(path,this.expected(identity),ARTIFACT_REGISTRY_LIMITS);
  }

  private tracked<T>(promise:Promise<T>):Promise<T> {
    this.operations.add(promise);
    return promise.finally(()=>this.operations.delete(promise));
  }
  private assertOpen() { if(this.closing)throw new ArtifactStoreUnavailable('The local artifact registry is closing'); }

  async register(buildId:string,registeringActorId:string,authorize:()=>unknown):Promise<unknown> {
    if(typeof buildId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(buildId)||!actorPattern.test(registeringActorId))throw new Error('Invalid artifact registration request');
    this.assertOpen();
    return this.tracked(this.registerInner(buildId,registeringActorId,authorize));
  }

  private async registerInner(buildId:string,actor:string,authorize:()=>unknown):Promise<unknown> {
    const identity=this.store.artifactBuildIdentity(buildId);
    const existing=this.store.artifactRecord(identity.snapshotDigest);
    if(existing) {
      await this.verifyArtifactInner(existing.digest);
      authorize();
      return existing;
    }
    const target=this.targetPath(identity.snapshotDigest);
    try {
      const info=lstatSync(target);
      if(info.isSymbolicLink()||!info.isDirectory())throw new Error('An untrusted object already occupies the artifact destination');
      const snapshot=this.readSnapshot(target,identity);
      return this.store.adoptVerifiedArtifact({operationId:randomUUID(),buildId,artifactDigest:identity.snapshotDigest,snapshotId:identity.snapshotId,
        originatingActorId:identity.originatingActorId,
        productId:identity.productId,version:identity.version,inputDigest:identity.inputDigest,releaseDigest:identity.releaseDigest,
        sizeBytes:snapshot.sizeBytes,fileCount:snapshot.fileCount,observedRegistryBytes:0,observedObjectDirectories:0,
        manifestJson:snapshot.manifestJson,entriesJson:snapshot.entriesJson,registeringActorId:actor},authorize,()=>this.observeCapacitySync());
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    }
    const source=this.sourcePath(identity);
    const snapshot=this.readSnapshot(source,identity);
    const host=this.assertReady();
    const publisherBytes=readFileSync(this.publisherPath);
    if(sha256(publisherBytes)!==PUBLISHER_SHA256)throw new ArtifactStoreUnavailable('The fixed registry publisher identity changed');
    const operationId=randomUUID(),ownerToken=randomBytes(32).toString('base64url');
    const intent={operationId,ownerToken,buildId,artifactDigest:identity.snapshotDigest,snapshotId:identity.snapshotId,originatingActorId:identity.originatingActorId,productId:identity.productId,
      version:identity.version,inputDigest:identity.inputDigest,releaseDigest:identity.releaseDigest,sizeBytes:snapshot.sizeBytes,fileCount:snapshot.fileCount,
      stagingOverheadBytes:publisherBytes.length,observedRegistryBytes:0,observedObjectDirectories:0,
      hostIdentity:canonical({kind:host.kind,sha256:host.sha256,version:host.version,policy:host.policy}),publisherDigest:PUBLISHER_SHA256,registeringActorId:actor};
    const reservation=this.store.beginArtifactPublication(intent,authorize,()=>this.observeCapacitySync());
    if(reservation.kind==='REGISTERED') { await this.verifyArtifactInner(identity.snapshotDigest); authorize(); return reservation.artifact; }
    this.startedOperationIds.add(reservation.operationId);
    try { return await this.publishAndCommit(reservation.operationId,reservation.ownerToken,identity,actor,snapshot,publisherBytes,authorize,host); }
    finally { if(this.store.artifactRegistrySlot().operationId!==reservation.operationId)this.startedOperationIds.delete(reservation.operationId); }
  }

  private async publishAndCommit(operationId:string,ownerToken:string,identity:ArtifactBuildIdentity,actor:string,snapshot:BoundedSnapshot,
    publisherBytes:Buffer,authorize:()=>unknown,host:WindowsBuildHostProfile):Promise<unknown> {
    const operationRoot=safeUnder(this.stagingRoot,operationId), payload=join(operationRoot,'payload'), publisher=join(operationRoot,'publisher.ps1');
    let published=false, settled=false, stageCreated=false;
    try {
      authorize();
      await mkdir(operationRoot,{recursive:false}); stageCreated=true;
      physicalDirectory(operationRoot,false);
      await mkdir(payload,{recursive:false});
      for(const entry of snapshot.entries) {
        authorize();
        const output=safeUnder(payload,entry.path), parent=dirname(output);
        ensurePhysicalDirectory(parent,payload);
        await writeFile(output,entry.bytes,{flag:'wx'});
      }
      authorize();
      await writeFile(publisher,publisherBytes,{flag:'wx'});
      const stagedPublisherHash=sha256(await readFile(publisher));
      authorize();
      if(stagedPublisherHash!==PUBLISHER_SHA256)throw new Error('Private publisher copy failed its reviewed hash check');
      const staged=this.readSnapshot(payload,identity);
      if(staged.snapshotDigest!==snapshot.snapshotDigest||staged.sizeBytes!==snapshot.sizeBytes||staged.entriesJson!==snapshot.entriesJson)throw new Error('Private artifact copy differs from the verified source snapshot');
      this.store.recordArtifactPublication(operationId,ownerToken,'PUBLISHING');
      authorize();
      const publisherCopyHash=sha256(await readFile(publisher));
      authorize();
      if(this.publisherHash()!==PUBLISHER_SHA256||publisherCopyHash!==PUBLISHER_SHA256)throw new KnownNoPublication('The fixed registry publisher changed before launch');
      const destination=this.targetPath(identity.snapshotDigest);
      try { lstatSync(destination); throw new Error('Artifact destination already exists'); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
      const result=await this.runPublisher(host.path,publisher,operationId,identity.snapshotDigest,authorize);
      if(result==='EXISTS') {
        const existing=this.readSnapshot(destination,identity);
        await this.cleanupStage(operationRoot);
        stageCreated=false;
        this.store.abortArtifactPublication(operationId,ownerToken,'Another verified identical artifact already occupied the destination');
        return this.store.adoptVerifiedArtifact({operationId:randomUUID(),buildId:identity.buildId,artifactDigest:identity.snapshotDigest,snapshotId:identity.snapshotId,
          originatingActorId:identity.originatingActorId,
          productId:identity.productId,version:identity.version,inputDigest:identity.inputDigest,releaseDigest:identity.releaseDigest,sizeBytes:existing.sizeBytes,
          fileCount:existing.fileCount,observedRegistryBytes:0,observedObjectDirectories:0,manifestJson:existing.manifestJson,entriesJson:existing.entriesJson,registeringActorId:actor},authorize,()=>this.observeCapacitySync());
      }
      if(result!=='MOVED')throw new Error('The fixed registry publisher did not confirm the artifact move');
      published=true;
      this.store.recordArtifactPublication(operationId,ownerToken,'MOVE_OBSERVED');
      const copied=this.readSnapshot(destination,identity);
      if(copied.snapshotDigest!==snapshot.snapshotDigest||copied.entriesJson!==snapshot.entriesJson)throw new Error('Published artifact bytes differ from the verified build snapshot');
      this.store.recordArtifactPublication(operationId,ownerToken,'PUBLISHED');
      try { await this.cleanupStage(operationRoot); stageCreated=false; }
      catch(error) { this.store.recordArtifactPublication(operationId,ownerToken,'UNKNOWN','Published artifact is verified but private staging cleanup failed'); throw error; }
      this.store.recordArtifactPublication(operationId,ownerToken,'STAGING_CLEAN');
      this.store.settleArtifactPublication(operationId,ownerToken);
      settled=true;
      authorize();
      return this.store.completeArtifactPublication(operationId,ownerToken,copied.manifestJson,copied.entriesJson,copied.sizeBytes,copied.fileCount,authorize);
    } catch(error) {
      if(error instanceof PhysicalPublicationUnknown) {
        try { this.store.recordArtifactPublication(operationId,ownerToken,'UNKNOWN','The fixed publisher closed without a unique physical result proof'); } catch { /* retain the full durable reservation */ }
      } else if(published&&!settled) {
        try { this.store.recordArtifactPublication(operationId,ownerToken,'UNKNOWN','Publication completed but registration did not complete'); } catch { /* durable physical evidence may already be committed */ }
      } else if(stageCreated) {
        try {
          await this.cleanupStage(operationRoot);
          stageCreated=false;
          this.store.abortArtifactPublication(operationId,ownerToken,'Registration stopped before publication');
        } catch {
          try { this.store.recordArtifactPublication(operationId,ownerToken,'UNKNOWN','Private staging cleanup could not be verified'); } catch { /* preserve original error and any durable reservation */ }
        }
      } else {
        try { this.store.abortArtifactPublication(operationId,ownerToken,'Registration stopped before staging'); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  private async runPublisher(executable:string,script:string,operationId:string,artifactDigest:string,authorize:()=>unknown):Promise<'MOVED'|'EXISTS'> {
    const registryRoot=join(this.root,'.local','platform-artifacts');
    const source=join(registryRoot,'staging',operationId,'payload'),destination=join(registryRoot,'objects',artifactDigest);
    for(const path of [script,registryRoot,source,destination]) if(resolve(path).length>=240)throw new ArtifactStoreUnavailable('The selected local registry path exceeds the supported Windows path bound');
    let freshHost:WindowsBuildHostProfile|undefined;
    try { freshHost=assertWindowsBuildHost(this.root,this.root); } catch { throw new KnownNoPublication('The selected private publisher host failed preflight before launch'); }
    if(!freshHost||freshHost.path!==executable||canonical({kind:freshHost.kind,sha256:freshHost.sha256,version:freshHost.version,policy:freshHost.policy})!==this.capability.hostIdentity)
      throw new KnownNoPublication('The selected private publisher host changed before launch');
    physicalDirectory(registryRoot,false);
    physicalDirectory(dirname(destination),false);
    checkPathPhysical(source,this.stagingRoot);
    if(process.platform==='win32'&&resolve(source).slice(0,2).toLowerCase()!==resolve(destination).slice(0,2).toLowerCase())throw new KnownNoPublication('Registry staging and object paths are not on the same volume');
    const nonce=randomBytes(24).toString('hex');
    authorize();
    return await new Promise((resolveResult,rejectResult)=>{
      const startedAt=performance.now();
      const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',script,registryRoot,operationId,artifactDigest,nonce],
        {cwd:this.rootEnvCwd(),env:this.minimalEnvironment(),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stdoutBytes=0,stdoutBytesCapped=false,stdoutOverflow=false,stderr='',stderrBytes=0,stderrBytesCapped=false;
      let settled=false,spawnError:Error|undefined,timedOut=false,closeObserved=false,closeCode:number|null=null,closeSignal:NodeJS.Signals|null=null;
      const stdoutHash=createHash('sha256');
      const boundedAdd=(current:number,amount:number)=>current>Number.MAX_SAFE_INTEGER-amount?Number.MAX_SAFE_INTEGER:current+amount;
      const diagnostic=(category:PublisherFailureCategory):RegistryPublisherFailureDiagnostics=>({
        category,elapsedMs:Math.max(0,Math.round(performance.now()-startedAt)),closeCode,closeSignal,closeObserved,
        stdoutBytes,stdoutBytesCapped,stdoutSha256:stdoutHash.copy().digest('hex'),stderrBytes,stderrBytesCapped,
        stderrSummary:redactedPublisherStderr(stderr,nonce,operationId,[dirname(this.root),this.root,executable,script,registryRoot,source,destination])
      });
      const unknown=(message:string,category:PublisherFailureCategory)=>attachPublisherDiagnostics(new PhysicalPublicationUnknown(message),diagnostic(category));
      const closed=new Promise<void>(resolveClosed=>child.once('close',()=>resolveClosed()));
      this.activeHelpers.add(closed);
      void closed.finally(()=>this.activeHelpers.delete(closed));
      const timer=setTimeout(()=>{timedOut=true;child.kill();},10000);
      let hardTimer:NodeJS.Timeout;
      const finish=(error?:Error,value?:'MOVED'|'EXISTS')=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(hardTimer);error?rejectResult(error):resolveResult(value!);};
      hardTimer=setTimeout(()=>{if(!settled)finish(unknown('The fixed publisher did not close after termination was requested','CLOSE_TIMEOUT'));},15000);
      child.stdout?.on('data',chunk=>{
        const next=boundedAdd(stdoutBytes,chunk.length);stdoutBytesCapped||=next===Number.MAX_SAFE_INTEGER&&stdoutBytes!==next;stdoutBytes=next;
        stdoutHash.update(chunk);
        if(stdoutBytes>4096)stdoutOverflow=true;
        if(!stdoutOverflow)stdout+=chunk.toString('utf8');
      });
      child.stderr?.on('data',chunk=>{
        const next=boundedAdd(stderrBytes,chunk.length);stderrBytesCapped||=next===Number.MAX_SAFE_INTEGER&&stderrBytes!==next;stderrBytes=next;
        stderr=(stderr+chunk.toString('utf8')).slice(-4096);
      });
      child.once('error',error=>{spawnError=error;});
      child.once('close',(code,signal)=>{
        closeObserved=true;closeCode=code;closeSignal=signal;
        if(spawnError&&!child.pid){finish(new KnownNoPublication('The fixed local registry publisher could not start'));return;}
        if(timedOut){finish(unknown('The fixed local registry publisher exceeded its bounded wait','TIMED_OUT'));return;}
        const proof=parseRegistryPublisherTranscript(stdout,nonce,code,signal,stdoutOverflow);
        if(proof==='MOVED'){finish(undefined,'MOVED');return;}
        if(proof==='EXISTS'){finish(undefined,'EXISTS');return;}
        if(proof==='FAILED'){finish(new KnownNoPublication('The fixed registry publisher reported a no-publication failure'));return;}
        const category=publisherFailureCategory(stdout,nonce,code,signal,stdoutOverflow);
        finish(unknown(stdoutOverflow?'The fixed registry publisher exceeded its bounded proof output':'The fixed registry publisher did not provide one valid physical result proof',category));
      });
    });
  }
  private rootEnvCwd() { return this.root; }
  private minimalEnvironment():NodeJS.ProcessEnv {
    const env:NodeJS.ProcessEnv={};
    for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[name])env[name]=process.env[name];
    return env;
  }

  private async cleanupStage(path:string):Promise<void> {
    assertPhysicalTree(path,this.stagingRoot);
    const end=Date.now()+1500;
    let last:unknown;
    while(Date.now()<end) {
      try { await rm(path,{recursive:true,force:true,maxRetries:0}); }
      catch(error) { last=error; }
      try { await lstat(path); }
      catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return; last=error; }
      await delay(100);
      assertPhysicalTree(path,this.stagingRoot);
    }
    throw new Error('Private staging cleanup could not be verified',{cause:last});
  }

  private async verifyArtifactInner(digest:string):Promise<{artifact:unknown;snapshot:BoundedSnapshot}> {
    const record=this.store.artifactRecord(digest);
    if(!record)throw new Error('Registered artifact not found');
    const target=this.targetPath(digest); checkPathPhysical(target,this.objectsRoot);
    const identity=this.store.artifactBuildIdentity(record.buildId);
    if(record.digest!==identity.snapshotDigest||record.snapshotDigest!==identity.snapshotDigest||record.productId!==identity.productId||record.version!==identity.version||record.inputDigest!==identity.inputDigest||record.releaseDigest!==identity.releaseDigest||record.originatingActorId!==identity.originatingActorId)
      throw new Error('Registered artifact metadata no longer matches its successful build proof');
    const snapshot=this.readSnapshot(target,identity);
    if(snapshot.snapshotDigest!==record.digest||snapshot.sizeBytes!==record.sizeBytes||snapshot.fileCount!==record.fileCount||snapshot.manifestJson!==record.manifestJson||snapshot.entriesJson!==record.entriesJson)
      throw new Error('Registered artifact bytes differ from their immutable stored inventory');
    return {artifact:record,snapshot};
  }
  async verifyArtifact(digest:string):Promise<{artifact:unknown;snapshot:BoundedSnapshot}> {
    this.assertOpen();
    return this.tracked(this.verifyArtifactInner(digest));
  }
  async artifact(digest:string) { this.assertOpen();return this.tracked((async()=> (await this.verifyArtifactInner(digest)).artifact)()); }
  async manifest(digest:string) { this.assertOpen();return this.tracked((async()=> (await this.verifyArtifactInner(digest)).snapshot.manifest)()); }
  async entry(digest:string,entryId:string) {
    this.assertOpen();
    return this.tracked(this.entryInner(digest,entryId));
  }
  private async entryInner(digest:string,entryId:string) {
    if(typeof entryId!=='string'||!/^[a-f0-9]{64}$/.test(entryId))throw new Error('Invalid opaque artifact entry selector');
    const {snapshot}=await this.verifyArtifactInner(digest);
    const entry=snapshot.entries.find(item=>item.id===entryId);
    if(!entry)throw new PlatformError('NOT_FOUND','Artifact entry not found');
    return {entry:{id:entry.id,path:entry.path,digest:entry.digest,sizeBytes:entry.sizeBytes},bytes:entry.bytes};
  }
  async list() {
    this.assertOpen();
    return this.tracked(this.listInner());
  }
  private async listInner() {
    const capacity=this.observeCapacitySync(),slot=this.store.artifactRegistrySlot();
    const operations=this.store.artifactOperations(200).map((operation:any)=>({...operation,
      ownerObservation:['RESERVED','PUBLISHING','UNKNOWN'].includes(operation.state)
        ? this.startedOperationIds.has(operation.id)?'initiated-in-this-process':'not-observed-in-this-process'
        : 'not-active'})),operationCount=this.store.artifactOperationCount();
    return {capability:this.capability,limits:ARTIFACT_REGISTRY_LIMITS,capacity:{...capacity,reservedBytes:slot.reservedBytes,reservedFiles:slot.reservedFiles,reservedObjects:slot.reservedObjects,objectDirectories:capacity.objectDirectories+slot.reservedObjects},
      artifacts:this.store.artifacts(),operations,operationHistory:{limit:200,count:operationCount,truncated:operationCount>operations.length},releases:this.store.artifactReleases()};
  }
  async releases() { this.assertOpen();return this.tracked(Promise.resolve().then(()=>this.store.artifactReleases())); }
  async promote(productId:string,version:string,digest:string,actorId:string,authorize:()=>unknown) {
    this.assertOpen();
    return this.tracked(this.promoteInner(productId,version,digest,actorId,authorize));
  }
  private async promoteInner(productId:string,version:string,digest:string,actorId:string,authorize:()=>unknown) {
    await this.verifyArtifactInner(digest);
    authorize();
    return this.store.promoteArtifact({productId,version,artifactDigest:digest,actorId},authorize);
  }
  async close() {
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    this.closePromise=(async()=>{
      await Promise.allSettled([...this.operations]);
      const deadline=Date.now()+15000;
      while(this.activeHelpers.size&&Date.now()<deadline)await delay(50);
      if(this.activeHelpers.size)throw new Error('Registry publisher shutdown remains UNKNOWN; physical ownership and staging are retained');
    })();
    try{return await this.closePromise;}
    catch(error){this.closePromise=undefined;throw error;}
  }
}
