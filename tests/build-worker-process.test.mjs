import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../apps/runtime/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { resolve } from '../packages/composition/dist/index.js';
import { LocalBuildWorker } from '../apps/control-plane/dist/build-worker.js';
import { copyPrivateToolchain, copyReviewedBuildInputs } from '../apps/control-plane/dist/build-inputs.js';
import { importSourceSnapshot, loadSourceSnapshot } from '../apps/control-plane/dist/source-import.js';

const actor = 'system:runner-test';
function markerBuildScript(markerPath) {
    const marker=JSON.stringify(markerPath);
    const child=`import{writeFileSync}from'node:fs';const f=${marker};let beat=0;const tick=()=>writeFileSync(f,JSON.stringify({pid:process.pid,beat:++beat}));tick();setInterval(tick,40);`;
    return `import {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{stdio:'ignore',windowsHide:true});await new Promise(()=>{});\n`;
}
async function fixture(t, { buildScript, runnerScript, sourceEdits = {}, timeoutMs = 15000, autoStart = true } = {}) {
    const temp=await mkdtemp(join(tmpdir(),'qb-build-runner-'));
    const root=join(temp,'source');
    let store,worker;
    const ownedClosers=[];
    t.after(async()=>{
        const failures=[];
        try{await worker?.close();}catch(error){failures.push(error);}
        try{store?.close();}catch(error){failures.push(error);}
        for(const close of ownedClosers.reverse())try{await close();}catch(error){failures.push(error);}
        try{await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){failures.push(error);}
        if(failures.length)throw new AggregateError(failures,'Build runner fixture cleanup failed');
    });
    await copyReviewedBuildInputs(ROOT,root);
    await copyPrivateToolchain(ROOT,root);
    const host=JSON.parse(await readFile(join(ROOT,'.local','platform-build-host.json'),'utf8'));
    await mkdir(join(root,'.local'),{recursive:true});
    await writeFile(join(root,'.local','platform-build-host.json'),JSON.stringify(host));
    if(buildScript)await writeFile(join(root,'tools','build.mjs'),typeof buildScript==='function'?buildScript(temp):buildScript);
    if(runnerScript)await writeFile(join(root,'tools','build-job.ps1'),runnerScript);
    for(const [path,contents] of Object.entries(sourceEdits))await writeFile(join(root,...path.split('/')),contents);
    const snapshot=loadSourceSnapshot(root);
    store=new ControlPlaneStore(join(temp,'control-plane.sqlite'));
    importSourceSnapshot(store,snapshot);
    const definition={id:'runner-probe-product',version:'1.0.0',platformAbi:'quadbridge.module.v1',title:'Runner probe product',description:'',layout:'sidebar',modules:[{id:'service-desk',version:'0.2.0'}],bindings:[]};
    const plan=resolve(definition,snapshot.modules);
    store.putProduct(plan.product,actor);
    const createWorker=async()=>{worker=await LocalBuildWorker.create({root,store,snapshot,pollMs:100,timeoutMs,leaseMs:30000});return worker;};
    const startWorker=async()=>{await createWorker();await worker.start();return worker;};
    if(autoStart)await startWorker();else await createWorker();
    return {temp,root,get store(){return store;},replaceStore(value){store=value;},plan,get worker(){return worker;},restartWorker:startWorker,ownCleanup(close){ownedClosers.push(close);},admit(key){return worker.admit(plan.product,plan,key,actor);}};
}
async function waitForState(store,id,states,timeoutMs=20000){
    const end=Date.now()+timeoutMs;
    while(Date.now()<end){const value=store.build(id);if(states.includes(value.state))return value;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error(`Build ${id} did not reach ${states.join(' or ')}; last state ${store.build(id)?.state}`);
}
async function waitForMarker(path,timeoutMs=10000){
    const end=Date.now()+timeoutMs;
    while(Date.now()<end){try{const value=JSON.parse(await readFile(path,'utf8'));if(Number.isSafeInteger(value.pid)&&value.beat>0)return value;}catch{}await new Promise(resolve=>setTimeout(resolve,25));}
    throw new Error('Owned descendant did not start its marker heartbeat');
}
function processAlive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function assertStopped(pid){
    const end=Date.now()+5000;
    while(Date.now()<end){if(!processAlive(pid))return;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.fail(`Owned descendant PID ${pid} remains alive after terminal cleanup`);
}
function workspacePath(root,store,id){
    const row=store.db.prepare('SELECT workspace_ref AS ref FROM build_attempts WHERE build_id=? ORDER BY attempt_no DESC LIMIT 1').get(id);
    return join(root,'.local','platform-builds',...row.ref.split('/'));
}
async function waitForText(child,expected,timeoutMs=10000){
    let text='';
    return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`Owned helper did not emit ${expected}`)),timeoutMs);
        child.stdout.on('data',chunk=>{text+=chunk.toString();if(text.includes(expected)){clearTimeout(timer);resolve(text);}});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('exit',(code,signal)=>{if(!text.includes(expected)){clearTimeout(timer);reject(new Error(`Owned helper exited before ${expected}: ${signal??code}`));}});
    });
}
async function waitForCleanupUnknown(store,id,timeoutMs=10000){
    const end=Date.now()+timeoutMs;
    while(Date.now()<end){const value=store.build(id);if(value?.cleanupState==='UNKNOWN')return value;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error(`Build ${id} did not record UNKNOWN cleanup`);
}

test('Windows job cancellation and timeout observe the compiler descendant exit before CLEAN cleanup', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t,{buildScript:temp=>markerBuildScript(join(temp,'descendant.json'))});
    const marker=join(context.temp,'descendant.json');
    let admitted=await context.admit(`cancel-${randomUUID()}`);
    let child=await waitForMarker(marker);
    await new Promise(resolve=>setTimeout(resolve,150));
    const live=await waitForMarker(marker);
    assert.equal(live.pid,child.pid);
    assert.ok(live.beat>child.beat,'the descendant remains active immediately before cancellation');
    child=live;
    context.store.cancelBuild(admitted.id,actor);
    let final=await waitForState(context.store,admitted.id,['CANCELLED']);
    assert.equal(final.cleanupState,'CLEAN');
    await assertStopped(child.pid);
    assert.equal(existsSync(workspacePath(context.root,context.store,admitted.id)),false,'the attempt directory is removed only after the job reports empty');

    await rm(marker,{force:true});
    admitted=await context.admit(`timeout-${randomUUID()}`);
    const timedChild=await waitForMarker(marker);
    final=await waitForState(context.store,admitted.id,['FAILED']);
    assert.equal(final.failureCode,'BUILD_TIMEOUT');
    assert.equal(final.cleanupState,'CLEAN');
    await assertStopped(timedChild.pid);
    assert.equal(existsSync(workspacePath(context.root,context.store,admitted.id)),false);
});

test('worker shutdown observes an active job, requeues cleanly, and the restarted worker claims attempt two', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t,{buildScript:temp=>markerBuildScript(join(temp,'descendant.json')),timeoutMs:15000});
    const marker=join(context.temp,'descendant.json');
    const admitted=await context.admit(`shutdown-${randomUUID()}`);
    const firstChild=await waitForMarker(marker);
    await context.worker.close();
    let current=context.store.build(admitted.id);
    assert.equal(current.state,'QUEUED');
    assert.equal(current.attempt,1);
    assert.equal(current.cleanupState,'CLEAN');
    await assertStopped(firstChild.pid);
    assert.equal(existsSync(workspacePath(context.root,context.store,admitted.id)),false);

    await rm(marker,{force:true});
    await context.restartWorker();
    const secondChild=await waitForMarker(marker);
    current=context.store.build(admitted.id);
    assert.equal(current.state,'RUNNING');
    assert.equal(current.attempt,2);
    context.store.cancelBuild(admitted.id,actor);
    current=await waitForState(context.store,admitted.id,['CANCELLED']);
    assert.equal(current.cleanupState,'CLEAN');
    await assertStopped(secondChild.pid);
    assert.equal(existsSync(workspacePath(context.root,context.store,admitted.id)),false);
});

test('a worker that loses its live lease observes its descendant and preserves the successor attempt workspace', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t,{buildScript:temp=>markerBuildScript(join(temp,'lease-loss-descendant.json')),timeoutMs:20000,leaseMs:30000});
    const successorStore=new ControlPlaneStore(join(context.temp,'control-plane.sqlite'));
    context.ownCleanup(()=>successorStore.close());
    const marker=join(context.temp,'lease-loss-descendant.json');
    const admitted=await context.admit(`lease-loss-${randomUUID()}`);
    const descendant=await waitForMarker(marker);
    const oldWorkspace=workspacePath(context.root,context.store,admitted.id);
    successorStore.db.prepare('UPDATE builds SET lease_until=0 WHERE id=?').run(admitted.id);
    const successor=successorStore.claimBuild(randomUUID(),30000);
    assert.equal(successor?.id,admitted.id);
    assert.equal(successor?.attempt,2);
    const successorWorkspace=join(context.root,'.local','platform-builds',...successor.workspaceRef.split('/'));
    await mkdir(successorWorkspace,{recursive:true});
    const sentinel=join(successorWorkspace,'successor-owned.txt');
    await writeFile(sentinel,'owned by the replacement claim\n');

    await assertStopped(descendant.pid);
    const cleanupDeadline=Date.now()+10000;
    while(Date.now()<cleanupDeadline&&existsSync(oldWorkspace))await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(existsSync(oldWorkspace),false,'the stale owner removes only its own attempt after observing process exit');
    assert.equal(await readFile(sentinel,'utf8'),'owned by the replacement claim\n','stale cleanup preserves the successor attempt workspace');
    assert.equal(successorStore.build(admitted.id).state,'RUNNING');
    assert.equal(successorStore.build(admitted.id).attempt,2,'the stale owner cannot publish over its successor');
});

test('missing Windows empty-job proof leaves cancellation pending with private work retained and redacted logs', {skip:process.platform!=='win32'}, async t=>{
    const helper=`param([string]$RunnerNonce,[string]$NodeExe,[string]$WorkingDirectory,[string]$ScriptPath,[string]$ArgumentsJson,[string]$LogPath)\nWrite-Output ("QB_READY:"+$RunnerNonce)\nexit 0\n`;
    const context=await fixture(t,{runnerScript:helper});
    const admitted=await context.admit(`no-proof-${randomUUID()}`);
    const final=await waitForState(context.store,admitted.id,['CANCEL_REQUESTED']);
    assert.equal(final.cleanupState,'UNKNOWN');
    assert.match(final.phase,/termination unknown/);
    const privateWork=workspacePath(context.root,context.store,admitted.id);
    assert.equal(existsSync(privateWork),true,'uncertain work is retained for quarantine');
    const log=context.store.buildLog(admitted.id);
    assert.doesNotMatch(log,/QB_(?:READY|EXIT):/,'private runner protocol markers are omitted from public build logs');
});

test('Windows file-lock cleanup failure retains the cancelled attempt as UNKNOWN', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t,{buildScript:temp=>markerBuildScript(join(temp,'descendant.json')),timeoutMs:15000});
    const admitted=await context.admit(`locked-cleanup-${randomUUID()}`);
    const child=await waitForMarker(join(context.temp,'descendant.json'));
    const work=workspacePath(context.root,context.store,admitted.id);
    const lockedFile=join(work,'cleanup-held-file.bin');
    await writeFile(lockedFile,'held by a separate owner');
    const profile=JSON.parse(await readFile(join(context.root,'.local','platform-build-host.json'),'utf8'));
    const script=join(context.temp,'hold-file.ps1');
    await writeFile(script,`param([string]$Path)\n$stream=[System.IO.File]::Open($Path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::Read)\n[Console]::Out.WriteLine('LOCKED')\n[Console]::Out.Flush()\n[Console]::ReadLine() | Out-Null\n$stream.Dispose()\n`);
    const helper=spawn(profile.path,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-Path',lockedFile],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    const release=async()=>{
        if(helper.exitCode===null&&helper.signalCode===null){
            const closed=new Promise(resolve=>helper.once('close',resolve));
            helper.stdin.write('\n');
            let timer;
            await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);
            clearTimeout(timer);
        }
        if(helper.exitCode===null&&helper.signalCode===null)helper.kill();
    };
    context.ownCleanup(release);
    await waitForText(helper,'LOCKED');
    context.store.cancelBuild(admitted.id,actor);
    const final=await waitForCleanupUnknown(context.store,admitted.id);
    assert.equal(final.state,'CANCEL_REQUESTED');
    assert.equal(final.cleanupState,'UNKNOWN');
    await assertStopped(child.pid);
    assert.equal(existsSync(work),true,'the owned attempt is retained when Windows refuses deletion of an open file');
    await release();
});

test('source and pinned compiler drift are rejected before a build is admitted', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t);
    const changedSource=join(context.root,'modules','service-desk','module.json');
    const originalSource=await readFile(changedSource,'utf8');
    await writeFile(changedSource,`${originalSource}\n`);
    await assert.rejects(context.admit(`source-drift-${randomUUID()}`),/Maintained source changed/);
    await writeFile(changedSource,originalSource);

    const hostPath=join(context.root,'.local','platform-build-host.json');
    const originalHost=await readFile(hostPath,'utf8');
    const host=JSON.parse(originalHost);host.policy='UntrustedPolicy';
    await writeFile(hostPath,JSON.stringify(host));
    await assert.rejects(context.admit(`host-drift-${randomUUID()}`),/Pinned local build host|policy|profile/i);
    await writeFile(hostPath,originalHost);

    const compilerPath=join(context.root,'node_modules','typescript','lib','typescript.js');
    const originalCompiler=await readFile(compilerPath);
    await writeFile(compilerPath,Buffer.concat([originalCompiler,Buffer.from('\n// fixture drift\n')]));
    await assert.rejects(context.admit(`toolchain-drift-${randomUUID()}`),/Pinned local compiler or build-host profile changed/);
    await writeFile(compilerPath,originalCompiler);
    assert.equal(context.store.db.prepare('SELECT count(*) AS count FROM builds').get().count,0);
});

test('source and toolchain drift after admission fail the queued request before export', {skip:process.platform!=='win32'}, async t=>{
    const sourceCase=await fixture(t,{autoStart:false});
    const sourceBuild=await sourceCase.admit(`queued-source-drift-${randomUUID()}`);
    const modulePath=join(sourceCase.root,'modules','service-desk','module.json');
    const moduleBytes=await readFile(modulePath,'utf8');
    await writeFile(modulePath,`${moduleBytes}\n`);
    await sourceCase.worker.start();
    const sourceResult=await waitForState(sourceCase.store,sourceBuild.id,['FAILED']);
    assert.equal(sourceResult.failureCode,'SOURCE_DRIFT');
    assert.equal(sourceResult.cleanupState,'CLEAN');
    assert.equal(sourceResult.snapshotId,null);

    const toolchainCase=await fixture(t,{autoStart:false});
    const toolchainBuild=await toolchainCase.admit(`queued-toolchain-drift-${randomUUID()}`);
    const compilerPath=join(toolchainCase.root,'node_modules','typescript','lib','typescript.js');
    const compilerBytes=await readFile(compilerPath);
    await writeFile(compilerPath,Buffer.concat([compilerBytes,Buffer.from('\n// admitted toolchain drift\n')]));
    await toolchainCase.worker.start();
    const toolchainResult=await waitForState(toolchainCase.store,toolchainBuild.id,['FAILED']);
    assert.equal(toolchainResult.failureCode,'TOOLCHAIN_MISMATCH');
    assert.equal(toolchainResult.cleanupState,'CLEAN');
    assert.equal(toolchainResult.snapshotId,null);
});

test('fixed factory output tampering fails before a local snapshot is published', {skip:process.platform!=='win32'}, async t=>{
    const factory=await readFile(join(ROOT,'tools','factory.mjs'),'utf8');
    const maliciousFactory=`${factory}\nif(process.argv[2]==='assemble'){const {readFile,writeFile}=await import('node:fs/promises');const path=join(process.argv[4],'generated/catalog.mjs');await writeFile(path,(await readFile(path,'utf8'))+'\\n// changed after fixed assembly\\n');}\n`;
    const context=await fixture(t,{sourceEdits:{'tools/factory.mjs':maliciousFactory},timeoutMs:60000});
    const admitted=await context.admit(`prepublication-tamper-${randomUUID()}`);
    const final=await waitForState(context.store,admitted.id,['FAILED'],60000);
    assert.equal(final.failureCode,'BUILD_FAILED');
    assert.equal(final.cleanupState,'CLEAN');
    assert.equal(final.snapshotId,null);
    assert.match(final.failureMessage,/Factory output differs from its trusted input: generated\/catalog\.mjs/);
});

test('real compile and factory export persist a verified snapshot and detect package, catalogue, and launcher tampering', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t,{timeoutMs:60000});
    const admitted=await context.admit(`real-export-${randomUUID()}`);
    const completed=await waitForState(context.store,admitted.id,['SUCCEEDED'],60000);
    assert.equal(completed.cleanupState,'CLEAN');
    assert.match(completed.snapshotDigest,/^[a-f0-9]{64}$/);
    await context.worker.close();
    context.store.close();
    const reopened=new ControlPlaneStore(join(context.temp,'control-plane.sqlite'));
    context.replaceStore(reopened);
    const snapshot=loadSourceSnapshot(context.root);
    const inspector=await LocalBuildWorker.create({root:context.root,store:reopened,snapshot,pollMs:100,leaseMs:30000});
    const verified=await inspector.inspect(admitted.id);
    assert.equal(verified.snapshot.status,'VERIFIED_LOCAL_EXPORT');
    assert.equal(verified.snapshot.digest,completed.snapshotDigest);
    const exportRoot=join(context.root,'.local','platform-builds','snapshots',completed.snapshotId);
    for(const relative of ['package.json','generated/catalog.mjs','tools/demo.mjs']){
        const path=join(exportRoot,...relative.split('/'));
        const original=await readFile(path);
        try{
            await writeFile(path,Buffer.concat([original,Buffer.from('\n// post-publication tamper\n')]));
            await assert.rejects(inspector.inspect(admitted.id),/inventory|Artifact drift|snapshot/);
        }finally{await writeFile(path,original);}
    }
    const unexpected=join(exportRoot,'unlisted.tsbuildinfo');
    await writeFile(unexpected,'unexpected export entry');
    try{await assert.rejects(inspector.inspect(admitted.id),/Snapshot file inventory mismatch/);}
    finally{await rm(unexpected,{force:true});}
});

test('real TypeScript compiler failure is terminal and cleans the private attempt without exporting success', {skip:process.platform!=='win32'}, async t=>{
    const context=await fixture(t,{sourceEdits:{'packages/contracts/src/index.ts':'export const __platform002ExpectedCompilerFailure: number = "not a number";\n'}});
    const admitted=await context.admit(`compiler-failure-${randomUUID()}`);
    const final=await waitForState(context.store,admitted.id,['FAILED']);
    assert.equal(final.failureCode,'BUILD_COMMAND_FAILED');
    assert.equal(final.cleanupState,'CLEAN');
    assert.equal(final.snapshotId,null);
    const attempts=context.store.db.prepare('SELECT workspace_ref AS ref FROM build_attempts WHERE build_id=?').all(admitted.id);
    assert.equal(attempts.length,1);
    assert.equal(existsSync(join(context.root,'.local','platform-builds',...attempts[0].ref.split('/'))),false);
    assert.match(context.store.buildLog(admitted.id),/error TS|Type .string. is not assignable/);
});
