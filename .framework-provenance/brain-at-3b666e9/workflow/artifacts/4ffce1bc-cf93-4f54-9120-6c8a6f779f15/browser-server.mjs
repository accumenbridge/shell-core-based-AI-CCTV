// Root-owned observation fixture; generated products use the maintained CLI unchanged.
import fs from 'node:fs';
import {mkdtemp,copyFile,mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';import {join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
const dir=fileURLToPath(new URL('.',import.meta.url)),sourceRoot=resolve(dir,'../..');
const readyPath=join(dir,'browser-01-ready.json'),closedPath=join(dir,'browser-01-closed.json');
if([readyPath,closedPath].some(p=>fs.existsSync(p)))throw Error('Existing browser evidence; explicit reconciliation required');
const frozen=JSON.parse(await readFile(join(dir,'frozen.json'),'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const inspect=async()=>{for(const f of frozen.candidate.files)if(sha(await readFile(join(sourceRoot,f.path)))!==f.sha256)throw Error(`Frozen source changed: ${f.path}`);};
await inspect();const fixtureId=randomUUID(),privateRoot=await mkdtemp(join(tmpdir(),'qe-'));
const {copyReviewedBuildInputs,copyPrivateToolchain}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/build-inputs.js')));
await copyReviewedBuildInputs(sourceRoot,privateRoot);await copyPrivateToolchain(sourceRoot,privateRoot);
await mkdir(join(privateRoot,'.local/specs'),{recursive:true});
await copyFile(join(sourceRoot,'.local/platform-build-host.json'),join(privateRoot,'.local/platform-build-host.json'));
for(const helper of ['registry-publish.ps1','runtime-supervisor.mjs','runtime-recovery.mjs','runtime-recovery-publish.ps1'])await copyFile(join(sourceRoot,'tools',helper),join(privateRoot,'tools',helper));
const commands=[];
function run(label,args){
 const startedAt=new Date().toISOString(),result=spawnSync(process.execPath,args,{cwd:privateRoot,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
 fs.writeFileSync(join(dir,`browser-${label}.log`),String(result.stdout??'')+String(result.stderr??''),{flag:'wx'});
 commands.push({label,args:args.map(p=>p.replaceAll(privateRoot,'<owned-private-root>')),startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,signal:result.signal});
 fs.writeFileSync(join(dir,'browser-command-execution-01.json'),JSON.stringify({fixtureId,candidate:frozen.candidate.digest,commands},null,2)+'\n');
 if(result.error||result.status!==0||result.signal!==null)throw Error(`Actual ${label} failed; private fixture retained`);
}
run('preparation-build-01',[join(privateRoot,'tools/build.mjs')]);
const cases=[{moduleId:'asset-register',productId:'maintenance-assets',version:'1.0.0'},{moduleId:'room-inspection',productId:'site-inspections',version:'2.1.0'}];
for(const c of cases){
 const spec=join(privateRoot,'.local/specs',`${c.moduleId}.json`);await copyFile(join(sourceRoot,'examples/entities',`${c.moduleId}.json`),spec);
 run(`generate-${c.moduleId}-01`,[join(privateRoot,'tools/factory.mjs'),'generate-entity',spec]);
 run(`create-${c.productId}-01`,[join(privateRoot,'tools/factory.mjs'),'create-product',c.productId,'--modules',c.moduleId,'--version',c.version]);
}
async function generatedFiles(){
 const files=[];
 async function visit(path){for(const e of await readdir(path,{withFileTypes:true})){if(['dist','node_modules'].includes(e.name)||e.name.endsWith('.tsbuildinfo'))continue;const p=join(path,e.name),info=await lstat(p);if(info.isSymbolicLink())throw Error('Generated source contains link');if(info.isDirectory())await visit(p);else if(info.isFile())files.push({path:relative(privateRoot,p).replaceAll('\\','/'),sha256:sha(await readFile(p))});else throw Error('Special generated file');}}
 for(const c of cases){await visit(join(privateRoot,'modules',c.moduleId));await visit(join(privateRoot,'products',c.productId));}return files.sort((a,b)=>a.path.localeCompare(b.path));
}
const generated=await generatedFiles();
run('generated-build-01',[join(privateRoot,'tools/build.mjs')]);
if(JSON.stringify(await generatedFiles())!==JSON.stringify(generated))throw Error('Generated source changed during build');
await writeFile(join(dir,'browser-generated-source-01.json'),JSON.stringify({fixtureId,candidate:frozen.candidate.digest,files:generated,manualRepairs:false,cases},null,2)+'\n',{flag:'wx'});
const {loadSourceSnapshot}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/source-import.js')));
const {startControlPlane}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/main.js')));
const snapshot=loadSourceSnapshot(privateRoot);let server;const originalLog=console.log,originalWarn=console.warn;console.log=()=>{};console.warn=()=>{};
try{server=await startControlPlane({root:privateRoot,port:0});}finally{console.log=originalLog;console.warn=originalWarn;}
await inspect();
await writeFile(readyPath,JSON.stringify({fixtureId,url:server.url,pairingCode:server.pairingCode,root:privateRoot,candidate:frozen.candidate.digest,contractDigest:frozen.contractDigest,sourceFingerprint:snapshot.sourceFingerprint,studioSha:sha(await readFile(join(privateRoot,'apps/studio-web/dist/main.js'))),cases,purpose:'Actual two generated promoted product create/detail/edit/conflict/restart; Asset existing stopped backup/verify/refusal/absent root restore.'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log('ENTITY_BROWSER_READY');let closeFlight;process.stdin.resume();
process.stdin.on('data',chunk=>{if(!chunk.toString('utf8').split(/\r?\n/).includes(`STOP:${fixtureId}`)||closeFlight)return;closeFlight=(async()=>{
 await server.close();await inspect();if(JSON.stringify(await generatedFiles())!==JSON.stringify(generated))throw Error('Generated source changed during browser run');
 const db=new DatabaseSync(join(privateRoot,'.local/control-plane.sqlite'),{readOnly:true});let summary;
 try{summary={products:db.prepare('SELECT id,version FROM product_versions ORDER BY id,version').all(),builds:db.prepare('SELECT id,product_id AS productId,version,state,snapshot_digest AS snapshotDigest FROM builds ORDER BY created').all(),slot:db.prepare('SELECT state,instance_id AS instanceId,operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get(),runtimes:db.prepare('SELECT i.id,i.product_id AS productId,i.version,i.artifact_digest AS artifactDigest,i.state,i.current_attempt AS attempt,a.physical_state AS physicalState,a.empty_observed AS emptyObserved,a.helper_closed AS helperClosed,a.execution_clean AS executionClean FROM runtime_instances i JOIN runtime_attempts a ON a.instance_id=i.id AND a.attempt_no=i.current_attempt').all()};}finally{db.close();}
 await writeFile(closedPath,JSON.stringify({fixtureId,closed:true,candidate:frozen.candidate.digest,generatedUnchanged:true,closedAt:new Date().toISOString(),summary},null,2)+'\n',{flag:'wx',mode:0o600});process.stdin.pause();console.log('ENTITY_BROWSER_CLOSED');
})().catch(error=>{closeFlight=undefined;console.error('ENTITY_BROWSER_CLOSE_UNVERIFIED',error?.code??'UNKNOWN');});});
