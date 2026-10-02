// Task-owned ordinary-browser observation fixture; never a maintained source owner.
import fs from 'node:fs';
import {mkdtemp,copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const dir=fileURLToPath(new URL('.',import.meta.url)),sourceRoot=resolve(dir,'../..');
const readyPath=join(dir,'browser-01-ready.json'),closedPath=join(dir,'browser-01-closed.json');
if([readyPath,closedPath].some(p=>fs.existsSync(p)))throw Error('Existing fixture evidence requires reconciliation; no overwrite');
const frozen=JSON.parse(await readFile(join(dir,'frozen.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inspect=async()=>{for(const f of frozen.candidate.files)if(sha(await readFile(join(sourceRoot,f.path)))!==f.sha256)throw Error(`Frozen candidate changed: ${f.path}`);};
await inspect();
const fixtureId=randomUUID(),privateRoot=await mkdtemp(join(tmpdir(),'qbfbr-'));
const {copyReviewedBuildInputs,copyPrivateToolchain}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/build-inputs.js')));
await copyReviewedBuildInputs(sourceRoot,privateRoot);await copyPrivateToolchain(sourceRoot,privateRoot);
await mkdir(join(privateRoot,'.local'),{recursive:true});
await copyFile(join(sourceRoot,'.local/platform-build-host.json'),join(privateRoot,'.local/platform-build-host.json'));
for(const helper of ['registry-publish.ps1','runtime-supervisor.mjs','runtime-recovery.mjs','runtime-recovery-publish.ps1'])
 await copyFile(join(sourceRoot,'tools',helper),join(privateRoot,'tools',helper));
const build=spawnSync(process.execPath,[join(privateRoot,'tools/build.mjs')],{cwd:privateRoot,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
await writeFile(join(dir,'browser-private-build-01.log'),String(build.stdout??'')+String(build.stderr??''),{flag:'wx'});
if(build.error||build.status!==0||build.signal!==null)throw Error('Private browser console build failed; owned fixture retained');
const {loadSourceSnapshot}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/source-import.js')));
const {startControlPlane}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/main.js')));
const snapshot=loadSourceSnapshot(privateRoot);
let server;const originalLog=console.log,originalWarn=console.warn;console.log=()=>{};console.warn=()=>{};
try{server=await startControlPlane({root:privateRoot,port:0});}finally{console.log=originalLog;console.warn=originalWarn;}
await inspect();
await writeFile(readyPath,JSON.stringify({fixtureId,url:server.url,pairingCode:server.pairingCode,root:privateRoot,candidate:frozen.candidate.digest,contractDigest:frozen.contractDigest,sourceFingerprint:snapshot.sourceFingerprint,studioSha:sha(await readFile(join(privateRoot,'apps/studio-web/dist/main.js'))),purpose:'Actual ordinary family derive/confirm-save/build/register/promote/start/domain journey; no prebuilt family product.'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log('FAMILY_BROWSER_READY');
let closeFlight;
process.stdin.resume();
process.stdin.on('data',chunk=>{if(!chunk.toString('utf8').split(/\r?\n/).includes(`STOP:${fixtureId}`)||closeFlight)return;closeFlight=(async()=>{
 await server.close();await inspect();
 const db=new DatabaseSync(join(privateRoot,'.local/control-plane.sqlite'),{readOnly:true});let summary;
 try{summary={products:db.prepare('SELECT id,version FROM product_versions ORDER BY id,version').all(),builds:db.prepare('SELECT id,product_id AS productId,version,state,snapshot_digest AS snapshotDigest FROM builds ORDER BY created').all(),slot:db.prepare('SELECT state,instance_id AS instanceId,operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get(),runtimes:db.prepare('SELECT i.id,i.product_id AS productId,i.version,i.artifact_digest AS artifactDigest,i.state,i.current_attempt AS attempt,a.physical_state AS physicalState,a.empty_observed AS emptyObserved,a.helper_closed AS helperClosed,a.execution_clean AS executionClean FROM runtime_instances i JOIN runtime_attempts a ON a.instance_id=i.id AND a.attempt_no=i.current_attempt').all()};}finally{db.close();}
 await writeFile(closedPath,JSON.stringify({fixtureId,closed:true,candidate:frozen.candidate.digest,closedAt:new Date().toISOString(),summary},null,2)+'\n',{flag:'wx',mode:0o600});process.stdin.pause();console.log('FAMILY_BROWSER_CLOSED');
})().catch(error=>{closeFlight=undefined;console.error('FAMILY_BROWSER_CLOSE_UNVERIFIED',error?.code??'UNKNOWN');});});
