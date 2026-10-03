import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve as pathResolve, sep } from 'node:path';
import { canonical, type CompositionPlan, type ProductDefinition } from '@quadbridge/contracts';
import { resolve } from '@quadbridge/composition';
import { ControlPlaneStore, type BuildClaim, type FrozenBuildInput } from '@quadbridge/control-plane';
import { assertExpectedFactoryInventory, createSnapshotManifest, expectedFactoryInventory, verifyReleaseArtifacts, verifySnapshotManifest } from '@quadbridge/composition/integrity';
import { assertWindowsBuildHost, type WindowsBuildHostProfile } from './build-host.js';
import { maintainedSourceFingerprint, type SourceSnapshot } from './source-import.js';
import { BUILD_FINGERPRINT_FORMAT_VERSION, copyPrivateToolchain, copyReviewedBuildInputs, privateToolchainDigest, reviewedBuildFingerprint } from './build-inputs.js';

const RECIPE = `local-compiled-export-v2-fingerprint-v${BUILD_FINGERPRINT_FORMAT_VERSION}`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type BuildHostIdentity = { kind: string; sha256: string; version: string; policy: string };
function publicBuildHostIdentity(profile: WindowsBuildHostProfile | undefined): BuildHostIdentity {
  return profile ? { kind:profile.kind,sha256:profile.sha256,version:profile.version,policy:profile.policy } :
    { kind:`native-node-${process.platform}`,sha256:'',version:process.version,policy:'not-applicable' };
}
function frozenToolchainDigest(compilerDigest: string, identity: BuildHostIdentity): string {
  return createHash('sha256').update(canonical({schema:`quadbridge.build-toolchain.v${BUILD_FINGERPRINT_FORMAT_VERSION}`,
    compilerDigest,executionHost:identity})).digest('hex');
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = process.platform === 'win32'
    ? ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT']
    : ['PATH','TMPDIR'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  env.NODE_ENV = 'development';
  return env;
}

function redact(text: string, root?: string, stateRoot?: string): string {
  let safe = text;
  for (const [path, label] of [[root, '[project]'], [stateRoot, '[build-state]']] as const) {
    if (!path) continue;
    const forms = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]);
    for (const form of forms) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      safe = safe.replace(new RegExp(escaped,'gi'),label);
    }
  }
  return safe.replace(/(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(token|secret|password|pairing code)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/QB_READY:[^\r\n]*/g,'QB_READY:[redacted]')
    .replace(/QB_EXIT:[^\r\n]*/g,'QB_EXIT:[redacted]')
    .slice(-32768);
}

type RunningCommand = { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; text: string; protocolText: string; callbackError?: Error; inputError?: Error; nonce?: string; logFile?: string; windowsJob: boolean };
function launch(root: string, stateRoot: string, script: string, args: readonly string[], logFile: string, onText: (text: string) => void, windowsHostPath?: string): RunningCommand {
  const windowsJob = process.platform === 'win32';
  const nonce = windowsJob ? randomBytes(24).toString('base64url') : undefined;
  let executable: string, commandArgs: string[];
  if (windowsJob) {
    if (script !== 'tools/build.mjs' && script !== 'tools/factory.mjs') throw new Error('Unreviewed local build command');
    if (script === 'tools/build.mjs' && args.length !== 0) throw new Error('Build recipe does not accept command arguments');
    if (script === 'tools/factory.mjs') {
      const destination = args[2] ? pathResolve(args[2]) : '';
      const snapshots = pathResolve(stateRoot, 'snapshots');
      const relativeDestination = destination ? relative(snapshots, destination) : '..';
      if (args.length !== 3 || args[0] !== 'assemble' || !/^[a-z][a-z0-9-]{1,47}$/.test(args[1]!) ||
          !/^[0-9a-f-]{36}$/i.test(destination.split(sep).at(-1) ?? '') || relativeDestination.includes(sep) || relativeDestination === '..' || !relativeDestination)
        throw new Error('Invalid fixed assembly arguments');
    }
    if (!windowsHostPath) throw new Error('The private Windows build-host profile is unavailable');
    executable = windowsHostPath;
    commandArgs = ['-NoLogo','-NoProfile','-NonInteractive','-File',join(root,'tools','build-job.ps1'),'-RunnerNonce',nonce!,'-NodeExe',process.execPath,'-WorkingDirectory',root,'-ScriptPath',join(root,script),'-ArgumentsJson',JSON.stringify(args),'-LogPath',logFile];
  } else {
    executable = process.execPath;
    commandArgs = [join(root,script),...args];
  }
  const child = spawn(executable,commandArgs,{
    cwd: root, env: childEnvironment(), shell: false, windowsHide: true, detached: !windowsJob,
    stdio: [windowsJob ? 'pipe' : 'ignore','pipe','pipe']
  });
  let text = '';
  let protocolText = '';
  let logPending = '';
  let callbackError: Error | undefined;
  let inputError: Error | undefined;
  const emitLog = (raw: string) => {
    const commandOutput=raw.split(/\r?\n/).filter(line=>!/^QB_(?:READY|EXIT):/.test(line)).join('\n');
    const safe = redact(commandOutput,root,stateRoot);
    text = `${text}${safe}`.slice(-32768);
    if (safe) {
      try { onText(safe); }
      catch (error) { callbackError = error instanceof Error ? error : new Error('Build output callback failed'); }
    }
  };
  const collect = (chunk: Buffer) => {
    const raw=chunk.toString('utf8');
    protocolText=`${protocolText}${raw}`.slice(-65536);
    logPending+=raw;
    const lastNewline=logPending.lastIndexOf('\n');
    if(lastNewline>=0){emitLog(logPending.slice(0,lastNewline+1));logPending=logPending.slice(lastNewline+1);}
    if(logPending.length>32768){emitLog(logPending.slice(0,16384));logPending=logPending.slice(16384);}
  };
  child.stdout?.on('data',collect); child.stderr?.on('data',collect);
  child.stdin?.on('error',error=>{inputError=error;});
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve,reject) => {
    child.once('error',reject);
    child.once('close',(code,signal) => { if(logPending)emitLog(logPending); logPending=''; resolve({code,signal}); });
  });
  return { child, closed, get text() { return text; }, get protocolText() { return protocolText; }, get callbackError() { return callbackError; }, get inputError() { return inputError; }, nonce, logFile:windowsJob?logFile:undefined, windowsJob };
}

async function observeClose(command: RunningCommand, timeoutMs: number): Promise<boolean> {
  return await Promise.race([command.closed.then(() => true,() => true),delay(timeoutMs).then(() => false)]);
}

async function stopTree(command: RunningCommand): Promise<boolean> {
  const pid = command.child.pid;
  if (!pid) return await observeClose(command,5000);
  try {
    if (command.windowsJob) {
      try { command.child.stdin?.write('STOP\n'); } catch { /* the natural close proof below remains authoritative */ }
      if (!await observeClose(command,10000)) return false;
      const closed=await command.closed.catch(()=>undefined);
      const marker=command.nonce?new RegExp('(?:^|\\r?\\n)QB_EXIT:'+command.nonce+':(-?\\d+):EMPTY(?:\\r?\\n|$)').exec(command.protocolText):null;
      return Boolean(closed&&marker&&Number(marker[1])===closed.code);
    } else {
      try { process.kill(-pid,'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      const groupExists = () => { try { process.kill(-pid,0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
      const waitGroupGone = async (ms: number) => { const end=Date.now()+ms; while(Date.now()<end){if(!groupExists())return true;await delay(100);}return !groupExists(); };
      if (!await waitGroupGone(3000)) {
        try { process.kill(-pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      if (!await waitGroupGone(10000) || !await observeClose(command,10000)) return false;
    }
  } catch { return false; }
  return true;
}

async function removeOwned(path: string): Promise<void> {
  await rm(path,{recursive:true,force:true,maxRetries:0});
}

export interface BuildWorkerOptions { root: string; store: ControlPlaneStore; snapshot: SourceSnapshot; leaseMs?: number; pollMs?: number; timeoutMs?: number; }
export class BuildExecutorUnavailable extends Error {
  constructor() { super('The pinned local build toolchain or host profile is unavailable'); this.name = 'BuildExecutorUnavailable'; }
}
function assertSafeBuildStateAncestors(root: string) {
  const project = pathResolve(root), rootInfo = lstatSync(project);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || realpathSync(project).toLowerCase() !== project.toLowerCase()) throw new Error('Build worker source root is not a physical directory');
  for (const path of [join(project,'.local'),join(project,'.local','platform-builds'),join(project,'.local','platform-builds','work'),join(project,'.local','platform-builds','snapshots')]) {
    try {
      const info=lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(path).toLowerCase() !== pathResolve(path).toLowerCase()) throw new Error('Build worker state path contains a junction, link, or non-directory');
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (path !== join(project,'.local')) {
        const parent=dirname(path);
        try { lstatSync(parent); } catch(parentError) { if ((parentError as NodeJS.ErrnoException).code === 'ENOENT') break; throw parentError; }
      }
    }
  }
}
function assertWindowsPathBudget(root: string) {
  if (process.platform !== 'win32') return;
  const id='f'.repeat(36), staged=join(root,'.local','platform-builds','work',id,`attempt-2-${id}`,'source');
  const snapshot=join(root,'.local','platform-builds','snapshots',id);
  const candidates=[
    join(staged,'node_modules','typescript','lib','typescript.js'),
    join(staged,'node_modules','@types','node','stream.d.ts'),
    process.platform==='win32'
      ? join(staged,'node_modules','@esbuild',`${process.platform}-${process.arch}`,'esbuild.exe')
      : join(staged,'node_modules','@esbuild',`${process.platform}-${process.arch}`,'bin','esbuild'),
    join(root,'.local','platform-builds','work',id,`attempt-2-${id}`,'build-output.log'),
    join(snapshot,'modules','a'.repeat(48),'src','ui','overview.css'),
    join(snapshot,'tools','link-workspaces.mjs')
  ];
  if (Math.max(...candidates.map(path=>path.length))>240) throw new Error('The selected checkout path exceeds the supported bounded Windows build path');
}
export class LocalBuildWorker {
  readonly ownerId = randomUUID();
  readonly root: string;
  readonly stateRoot: string;
  readonly startupFingerprint: string;
  readonly toolchainDigest: string;
  private readonly compilerDigest: string;
  private readonly hostIdentity: BuildHostIdentity;
  private running = false;
  private loop?: Promise<void>;
  private activeClaim?: BuildClaim;
  private command?: RunningCommand;
  private stopping = false;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly solutions: SourceSnapshot['solutions'];

  private constructor(private readonly options: BuildWorkerOptions, compilerDigest: string, toolchainDigest: string, hostIdentity: BuildHostIdentity) {
    this.root = options.root; this.stateRoot = join(options.root,'.local','platform-builds');
    this.startupFingerprint = options.snapshot.sourceFingerprint; this.compilerDigest=compilerDigest; this.toolchainDigest = toolchainDigest; this.hostIdentity=hostIdentity;
    this.leaseMs = options.leaseMs ?? 30000; this.pollMs = options.pollMs ?? 500; this.timeoutMs = options.timeoutMs ?? 10*60*1000;
    this.solutions = options.snapshot.solutions;
  }
  static async create(options: BuildWorkerOptions): Promise<LocalBuildWorker> {
    const actualSource = maintainedSourceFingerprint(options.root);
    if (actualSource !== options.snapshot.sourceFingerprint) throw new Error('Source catalogue fingerprint changed before the build worker started');
    assertSafeBuildStateAncestors(options.root);
    if (process.platform === 'win32') {
      try { assertWindowsPathBudget(options.root); }
      catch { throw new BuildExecutorUnavailable(); }
    }
    try {
      const hostProfile=assertWindowsBuildHost(options.root);
      if(process.platform==='win32'&&((hostProfile?.path.length??0)>240))throw new Error('The configured host path exceeds the supported bounded Windows path');
      const hostIdentity=publicBuildHostIdentity(hostProfile);
      const compilerDigest=await privateToolchainDigest(options.root);
      return new LocalBuildWorker(options,compilerDigest,frozenToolchainDigest(compilerDigest,hostIdentity),hostIdentity);
    } catch {
      throw new BuildExecutorUnavailable();
    }
  }
  async start() {
    if (this.running) return;
    await this.ensureStateArea('work');
    await this.ensureStateArea('snapshots');
    this.running = true;
    this.loop = this.runLoop();
  }
  async admit(product: ProductDefinition, plan: CompositionPlan, requestKey: string, actorId: string, beforeMutation?: () => void) {
    const current = maintainedSourceFingerprint(this.root);
    if (current !== this.startupFingerprint) throw new Error('Maintained source changed; restart Studio to reload the catalogue');
    const currentHost=publicBuildHostIdentity(assertWindowsBuildHost(this.root));
    const currentCompiler=await privateToolchainDigest(this.root);
    const currentToolchain=frozenToolchainDigest(currentCompiler,currentHost);
    if (canonical(currentHost)!==canonical(this.hostIdentity)||currentToolchain!==this.toolchainDigest) throw new Error('Pinned local compiler or build-host profile changed; restart Studio before requesting a build');
    beforeMutation?.();
    return this.options.store.admitBuild(product.id,product.version,requestKey,{product,plan,sourceFingerprint:this.startupFingerprint,toolchainDigest:this.toolchainDigest,recipeVersion:RECIPE},actorId);
  }
  async inspect(buildId: string) {
    const build = this.options.store.build(buildId) as Record<string,any> | undefined;
    if (!build || build.state !== 'SUCCEEDED' || !build.snapshotId || !build.snapshotDigest) throw new Error('No verified local snapshot is available');
    const path = join(this.stateRoot,'snapshots',build.snapshotId);
    await this.ensureStateDirectory(path,false);
    const manifestPath=join(path,'QUADBRIDGE-SNAPSHOT.json');
    const manifestInfo=await lstat(manifestPath);
    if(manifestInfo.isSymbolicLink()||!manifestInfo.isFile())throw new Error('Local snapshot manifest is not a regular owned file');
    const manifest = JSON.parse(await readFile(manifestPath,'utf8')) as unknown;
    const verified = verifySnapshotManifest(path,manifest,{buildId,productId:build.productId,version:build.version,inputDigest:build.inputDigest});
    if (verified.snapshotDigest !== build.snapshotDigest) throw new Error('Local snapshot no longer matches its fenced database identity');
    return { build, snapshot: { id: build.snapshotId, digest: verified.snapshotDigest, releaseDigest: build.releaseDigest, status: 'VERIFIED_LOCAL_EXPORT' } };
  }
  private async runLoop() {
    while (this.running) {
      try {
        const claim = this.options.store.claimBuild(this.ownerId,this.leaseMs);
        if (claim) { this.activeClaim = claim; await this.execute(claim); this.activeClaim = undefined; this.command = undefined; continue; }
      } catch (error) { console.error('Local build worker could not claim work',error instanceof Error ? error.message : 'unknown error'); }
      await delay(this.pollMs);
    }
  }
  private async execute(claim: BuildClaim) {
    const work = join(this.stateRoot,...claim.workspaceRef.split('/'));
    const source = join(work,'source');
    let snapshotPath = '';
    let outputId = '';
    let log = '';
    let lost = false;
    const append = (chunk: string) => {
      const safe = redact(chunk,this.root,this.stateRoot);
      log = `${log}${safe}`.slice(-32768);
      this.options.store.appendBuildAttemptLog(claim,safe.slice(-8192));
    };
    const heartbeat = setInterval(() => {
      try { if (!this.options.store.renewBuild(claim,this.leaseMs)) lost = true; }
      catch { lost = true; }
    },Math.max(250,Math.floor(this.leaseMs/3)));
    heartbeat.unref?.();
    const isCancelled = () => (this.options.store.build(claim.id) as Record<string,any> | undefined)?.state === 'CANCEL_REQUESTED';
    const checkpoint = async (): Promise<'cancelled'|'shutdown'|'lost'|undefined> => {
      if (isCancelled()) return 'cancelled';
      if (lost || !this.options.store.buildClaimCurrent(claim)) return 'lost';
      if (this.stopping) return 'shutdown';
      return undefined;
    };
    const settleWithoutProcess = async (status: 'cancelled'|'shutdown'|'lost', reason?: string) => {
      const workClean = await this.cleanup(work,'private build work');
      const snapshotClean = !snapshotPath || !(await this.exists(snapshotPath)) || await this.cleanup(snapshotPath,'unadvertised snapshot');
      if (status === 'cancelled') this.options.store.finishBuildCancellation(claim,workClean&&snapshotClean?'CLEAN':'UNKNOWN',reason ?? (workClean&&snapshotClean?undefined:'Cancellation cleanup failed'));
      else if (status === 'shutdown' && workClean && snapshotClean && !isCancelled()) this.options.store.abandonBuild(claim);
      else if (status === 'shutdown' && isCancelled()) this.options.store.finishBuildCancellation(claim,workClean&&snapshotClean?'CLEAN':'UNKNOWN',reason);
      else if (status === 'shutdown' && (!workClean || !snapshotClean) && this.options.store.buildClaimCurrent(claim)) this.options.store.failBuild(claim,{code:'CLEANUP_UNKNOWN',message:'Shutdown cleanup failed; private files remain quarantined',cleanupState:'UNKNOWN',log});
      if (status === 'lost' && snapshotPath && await this.exists(snapshotPath)) this.options.store.recordBuildOrphan(claim,`snapshots/${outputId}`,'A stale attempt left an unadvertised snapshot for quarantine');
    };
    try {
      if (claim.input.recipeVersion !== RECIPE) throw Object.assign(new Error('This frozen build admission uses an incompatible fingerprint recipe'),{code:'BUILD_RECIPE_UNSUPPORTED'});
      if (!await this.options.store.updateBuildPhase(claim,'Checking reviewed source and private toolchain')) throw new Error('Build claim is no longer current');
      const beforeCopy = await checkpoint(); if (beforeCopy) { await settleWithoutProcess(beforeCopy); return; }
      if (maintainedSourceFingerprint(this.root) !== claim.input.sourceFingerprint) throw Object.assign(new Error('Reviewed source changed since this build was admitted'),{code:'SOURCE_DRIFT'});
      await this.ensureStateDirectory(work,true);
      await this.ensureStateDirectory(source,true);
      await copyReviewedBuildInputs(this.root,source);
      if (reviewedBuildFingerprint(source) !== claim.input.sourceFingerprint || maintainedSourceFingerprint(this.root) !== claim.input.sourceFingerprint) throw Object.assign(new Error('Reviewed source changed during the private source copy'),{code:'SOURCE_DRIFT'});
      const afterCopy = await checkpoint(); if (afterCopy) { await settleWithoutProcess(afterCopy); return; }
      const currentHost=publicBuildHostIdentity(assertWindowsBuildHost(this.root));
      const currentCompiler=await privateToolchainDigest(this.root);
      const currentToolchain=frozenToolchainDigest(currentCompiler,currentHost);
      if (canonical(currentHost)!==canonical(this.hostIdentity)||currentCompiler!==this.compilerDigest||currentToolchain!==claim.input.toolchainDigest||currentToolchain!==this.toolchainDigest) throw Object.assign(new Error('Pinned compiler or build-host profile changed after admission'),{code:'TOOLCHAIN_MISMATCH'});
      await copyPrivateToolchain(this.root,source);
      const copiedCompilerDigest=await privateToolchainDigest(source);
      if (copiedCompilerDigest!==this.compilerDigest||frozenToolchainDigest(copiedCompilerDigest,currentHost)!==claim.input.toolchainDigest) throw Object.assign(new Error('Private toolchain copy failed its digest check'),{code:'TOOLCHAIN_MISMATCH'});
      const afterToolchain = await checkpoint(); if (afterToolchain) { await settleWithoutProcess(afterToolchain); return; }
      if (maintainedSourceFingerprint(this.root) !== claim.input.sourceFingerprint) throw Object.assign(new Error('Reviewed source changed before the product overlay'),{code:'SOURCE_DRIFT'});
      const productPath = join(source,'products',claim.productId,'product.json');
      await mkdir(dirname(productPath),{recursive:true});
      await writeFile(productPath,canonical(claim.input.product)+'\n',{flag:'w'});
      if (maintainedSourceFingerprint(this.root) !== claim.input.sourceFingerprint) throw Object.assign(new Error('Reviewed source changed before compilation'),{code:'SOURCE_DRIFT'});
      const overlayPlan = resolve(claim.input.product,this.options.snapshot.modules);
      if (canonical(overlayPlan) !== canonical(claim.input.plan)) throw Object.assign(new Error('Frozen composition plan no longer matches the startup catalogue'),{code:'PLAN_MISMATCH'});
      const stagedReviewedFingerprint = reviewedBuildFingerprint(source);
      const afterOverlay = await checkpoint(); if (afterOverlay) { await settleWithoutProcess(afterOverlay); return; }
      outputId = randomUUID();
      snapshotPath = join(this.stateRoot,'snapshots',outputId);
      await this.ensureStateArea('snapshots');
      let producerRelease: ReturnType<typeof verifyReleaseArtifacts> | undefined;
      let expectedInventory: Record<string,string> | undefined;
      for (const [script,args,phase] of [
        ['tools/build.mjs',[],'Compiling frozen product source'],
        ['tools/factory.mjs',['assemble',claim.productId,snapshotPath],'Assembling verified local snapshot']
      ] as const) {
        const beforeCommand = await checkpoint(); if (beforeCommand) { await settleWithoutProcess(beforeCommand); return; }
        if (!this.options.store.updateBuildPhase(claim,phase)) throw Object.assign(new Error('Build claim is no longer current'),{code:'CLAIM_LOST'});
        const outcome = await this.runCommand(claim,source,script,args,join(work,script === 'tools/build.mjs'?'build-output.log':'assemble-output.log'),append);
        if (!outcome.observed) {
          if (!isCancelled()) this.options.store.requestBuildStop(claim,'The fixed local process runner did not confirm an empty owned process tree');
          this.options.store.finishBuildCancellation(claim,'UNKNOWN','The process runner did not confirm an empty owned process tree; private files remain quarantined');
          return;
        }
        if (outcome.cancelled) { await settleWithoutProcess('cancelled'); return; }
        if (outcome.lost) { await settleWithoutProcess('lost'); return; }
        if (outcome.shutdown) { await settleWithoutProcess(isCancelled()?'cancelled':'shutdown'); return; }
        if (outcome.timedOut) throw Object.assign(new Error('The fixed local build exceeded its bounded execution time'),{code:'BUILD_TIMEOUT'});
        if ('error' in outcome && outcome.error) throw Object.assign(new Error(outcome.error),{code:'BUILD_SPAWN_FAILED'});
        if (outcome.code !== 0 || outcome.signal) throw Object.assign(new Error(`${script} exited ${outcome.signal ?? outcome.code}`),{code:'BUILD_COMMAND_FAILED'});
        if (script === 'tools/build.mjs') {
          producerRelease = verifyReleaseArtifacts(source,claim.productId,claim.version);
          if (producerRelease.planDigest !== claim.planDigest || canonical(producerRelease.plan) !== canonical(claim.input.plan)) throw Object.assign(new Error('Private build output differs from the admitted product plan'),{code:'PRODUCER_IDENTITY_MISMATCH'});
          expectedInventory = expectedFactoryInventory(source,claim.input.plan);
        }
        const afterCommand = await checkpoint(); if (afterCommand) { await settleWithoutProcess(afterCommand); return; }
      }
      if (reviewedBuildFingerprint(source) !== stagedReviewedFingerprint) throw Object.assign(new Error('Reviewed private build inputs changed during compilation or export'),{code:'PRIVATE_SOURCE_DRIFT'});
      if (!expectedInventory) throw Object.assign(new Error('Trusted factory inventory was not captured before assembly'),{code:'PRODUCER_INVENTORY_MISSING'});
      assertExpectedFactoryInventory(snapshotPath,expectedInventory);
      const verified = verifyReleaseArtifacts(snapshotPath,claim.productId,claim.version);
      if (!producerRelease || verified.releaseDigest !== producerRelease.releaseDigest) throw Object.assign(new Error('Factory export release bytes differ from the trusted private build output'),{code:'EXPORT_RELEASE_MISMATCH'});
      if (verified.planDigest !== claim.planDigest || canonical(verified.plan) !== canonical(claim.input.plan)) throw Object.assign(new Error('Exported composition plan differs from frozen build input'),{code:'EXPORT_IDENTITY_MISMATCH'});
      const beforeManifest = await checkpoint(); if (beforeManifest) { await settleWithoutProcess(beforeManifest); return; }
      const manifest = createSnapshotManifest(snapshotPath,{buildId:claim.id,productId:claim.productId,version:claim.version,inputDigest:claim.inputDigest,sourceFingerprint:claim.input.sourceFingerprint,toolchainDigest:claim.input.toolchainDigest,recipeVersion:claim.input.recipeVersion,releaseDigest:verified.releaseDigest});
      await writeFile(join(snapshotPath,'QUADBRIDGE-SNAPSHOT.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
      const check = verifySnapshotManifest(snapshotPath,manifest,{buildId:claim.id,productId:claim.productId,version:claim.version,inputDigest:claim.inputDigest,sourceFingerprint:claim.input.sourceFingerprint,toolchainDigest:claim.input.toolchainDigest,recipeVersion:claim.input.recipeVersion,releaseDigest:verified.releaseDigest});
      const clean = await this.cleanup(work,'build work directory');
      if (!clean) throw Object.assign(new Error('Build completed but private work cleanup failed'),{code:'BUILD_CLEANUP_FAILED'});
      const beforePublish = await checkpoint();
      if (beforePublish === 'cancelled') { await settleWithoutProcess('cancelled'); return; }
      if (beforePublish === 'shutdown') { await settleWithoutProcess('shutdown'); return; }
      if (beforePublish === 'lost' || !this.options.store.buildClaimCurrent(claim)) {
        this.options.store.recordBuildOrphan(claim,`snapshots/${outputId}`,'Verified snapshot publication was fenced by a stale build claim');
        return;
      }
      try {
        this.options.store.completeBuild(claim,{snapshotRef:`snapshots/${outputId}`,snapshotDigest:check.snapshotDigest,releaseDigest:verified.releaseDigest,cleanupState:'CLEAN',log});
      } catch (error) {
        const removed = await this.cleanup(snapshotPath,'unadvertised snapshot');
        if (!removed) this.options.store.recordBuildOrphan(claim,`snapshots/${outputId}`,'Success transaction failed and verified snapshot cleanup failed');
        if (this.options.store.buildClaimCurrent(claim)) this.options.store.failBuild(claim,{code:'PUBLICATION_FAILED',message:'Verified snapshot could not be committed as a durable build result',cleanupState:removed?'CLEAN':'UNKNOWN',log});
        if (!removed) throw error;
      }
      return;
    } catch (error) {
      const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'BUILD_FAILED';
      const message = redact(error instanceof Error ? error.message : 'Local build failed',this.root,this.stateRoot).slice(0,500);
      const state = await checkpoint();
      if (state === 'cancelled') { await settleWithoutProcess('cancelled'); return; }
      if (state === 'shutdown') { await settleWithoutProcess('shutdown'); return; }
      const clean = await this.cleanup(work,'failed build work');
      const outputClean = !snapshotPath || !(await this.exists(snapshotPath)) || await this.cleanup(snapshotPath,'failed unadvertised snapshot');
      if (state === 'lost' || !this.options.store.buildClaimCurrent(claim)) {
        if (snapshotPath && await this.exists(snapshotPath)) this.options.store.recordBuildOrphan(claim,`snapshots/${outputId}`,'A stale attempt left an unadvertised snapshot for quarantine');
      } else this.options.store.failBuild(claim,{code,message,cleanupState:clean&&outputClean?'CLEAN':'UNKNOWN',log});
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async runCommand(claim: BuildClaim, cwd: string, script: string, args: readonly string[], logFile: string, append: (text: string) => void) {
    const windowsHost = assertWindowsBuildHost(this.root,cwd);
    if(canonical(publicBuildHostIdentity(windowsHost))!==canonical(this.hostIdentity))throw new Error('Private build-host profile changed during the queued build');
    const rowBeforeLaunch = this.options.store.build(claim.id) as Record<string,any> | undefined;
    if (rowBeforeLaunch?.state === 'CANCEL_REQUESTED') return { code:null,signal:null,cancelled:true,lost:false,timedOut:false,shutdown:false,observed:true };
    if (this.stopping) return { code:null,signal:null,cancelled:false,lost:false,timedOut:false,shutdown:true,observed:true };
    if (!this.options.store.buildClaimCurrent(claim)) return { code:null,signal:null,cancelled:false,lost:true,timedOut:false,shutdown:false,observed:true };
    const command = launch(cwd,this.stateRoot,script,args,logFile,append,windowsHost?.path); this.command = command;
    const started = Date.now();
    while (true) {
      const outcome = await Promise.race([command.closed.then(value => ({closed:true as const,...value}),error => ({closed:true as const,code:null,signal:null,error:error instanceof Error?error.message:'spawn failed'})),delay(750).then(() => ({closed:false as const}))]);
      if (outcome.closed) {
        let observed = false;
        if ('error' in outcome && outcome.error && !command.child.pid) observed = true;
        else if (command.windowsJob) {
          const marker = command.nonce ? new RegExp(`(?:^|\\r?\\n)QB_EXIT:${command.nonce}:(-?\\d+):EMPTY(?:\\r?\\n|$)`).exec(command.protocolText) : null;
          observed = Boolean(marker && Number(marker[1]) === outcome.code);
        } else if (command.child.pid) {
          const groupExists = () => { try { process.kill(-command.child.pid! ,0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
          observed = !groupExists();
          if (!observed) observed = await stopTree(command);
        }
        let outputError=command.callbackError;
        if (command.windowsJob && command.logFile) {
          try { await this.readPrivateLog(command.logFile,append); }
          catch (error) { outputError=error instanceof Error?error:new Error('Build output could not be persisted'); }
        }
        return { ...outcome, ...(outputError?{error:`Build output could not be persisted: ${outputError.message}`} : {}), cancelled:false, lost:false, timedOut:false, observed };
      }
      if(command.callbackError){
        const observed=await stopTree(command);
        return {code:null,signal:null,cancelled:false,lost:false,timedOut:false,shutdown:false,observed,error:`Build output could not be persisted: ${command.callbackError.message}`};
      }
      const row = this.options.store.build(claim.id) as Record<string,any> | undefined;
      const cancelled = row?.state === 'CANCEL_REQUESTED';
      const timedOut = Date.now()-started > this.timeoutMs;
      if (cancelled || timedOut || !this.options.store.buildClaimCurrent(claim) || this.stopping) {
        const observed = await stopTree(command);
        if (!observed) return { code:null,signal:null,cancelled,lost:!cancelled&&!timedOut&&!this.stopping,timedOut,shutdown:this.stopping,observed:false,error:'Owned process tree termination was not observed' };
        if (cancelled) return { code:null,signal:null,cancelled:true,lost:false,timedOut:false,shutdown:false,observed:true };
        if (this.stopping) return { code:null,signal:null,cancelled:false,lost:false,timedOut:false,shutdown:true,observed:true };
        if (timedOut) return { code:null,signal:null,cancelled:false,lost:false,timedOut:true,shutdown:false,observed:true };
        return { code:null,signal:null,cancelled:false,lost:true,timedOut:false,shutdown:false,observed:true };
      }
    }
  }
  private async cleanup(path: string, label: string): Promise<boolean> {
    let failure: unknown;
    for(let attempt=0;attempt<3;attempt++){
      try { await this.ensureStateDirectory(path,false); await removeOwned(path); return true; }
      catch (error) {
        failure=error;
        const code=(error as NodeJS.ErrnoException)?.code;
        if(attempt===2||!['EBUSY','EPERM','EACCES','ENOTEMPTY','EMFILE','ENFILE','EAGAIN'].includes(code??''))break;
        await delay(100);
      }
    }
    console.error(`Unable to clean ${label}`,failure instanceof Error?failure.message:'unknown error');
    return false;
  }
  private async ensureStateArea(area:'work'|'snapshots') {
    const root=pathResolve(this.root), state=pathResolve(this.stateRoot);
    const rootInfo=lstatSync(root);
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()||realpathSync(root)!==root)throw new Error('Build worker source root is not a physical directory');
    const stateRel=relative(root,state);
    if(stateRel.startsWith(`..${sep}`)||stateRel==='..'||pathResolve(root,stateRel)!==state)throw new Error('Build worker state root escaped the project');
    for(const part of ['.local','platform-builds',area]){
      const current=this.statePathBase(part);
      try{await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(current);}
      const info=await lstat(current);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Build worker state path contains a junction, link, or non-directory');
    }
  }
  private statePathBase(last: string) { return last === '.local' ? join(this.root,'.local') : last === 'platform-builds' ? join(this.root,'.local','platform-builds') : join(this.stateRoot,last); }
  private async ensureStateDirectory(path:string,create:boolean) {
    const state=pathResolve(this.stateRoot),target=pathResolve(path),rel=relative(state,target);
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||pathResolve(state,rel)!==target)throw new Error('Build worker path is outside its owned state root');
    const parts=rel.split(sep);if(!['work','snapshots'].includes(parts[0]!)||parts.length<2||parts.some(part=>!part||part==='.'||part==='..'))throw new Error('Invalid build worker state path');
    await this.ensureStateArea(parts[0] as 'work'|'snapshots');
    let current=join(state,parts[0]!);
    for(const part of parts.slice(1)){
      current=join(current,part);
      try{await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&create){await mkdir(current);continue;}if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      const info=await lstat(current);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Build worker path contains a junction, symbolic link, or non-directory');
    }
  }
  private async readPrivateLog(path:string,append:(text:string)=>void) {
    try{const info=await stat(path);if(info.size>1024*1024)throw new Error('Private build log exceeded its byte limit');const bytes=await readFile(path);append(bytes.subarray(-32768).toString('utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  private async exists(path: string) { try { await lstat(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; } }
  async close() {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    await this.loop;
  }
}
