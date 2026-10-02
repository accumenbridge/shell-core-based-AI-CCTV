import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const sourceRoot=resolve(process.cwd());
const targetRoot=resolve(process.argv[2]??'');
if(!targetRoot||targetRoot===sourceRoot)throw new Error('Expected a separate owned temporary project root');
const {copyReviewedBuildInputs,copyPrivateToolchain}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/build-inputs.js')));
await copyReviewedBuildInputs(sourceRoot,targetRoot);
await copyPrivateToolchain(sourceRoot,targetRoot);
await mkdir(join(targetRoot,'.local'),{recursive:true});
await copyFile(join(sourceRoot,'.local','platform-build-host.json'),join(targetRoot,'.local','platform-build-host.json'));
const built=spawnSync(process.execPath,[join(targetRoot,'tools','build.mjs')],{cwd:targetRoot,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
if(built.error||built.status!==0)throw new Error(`Temporary source build failed (${built.status??'spawn'}): ${(built.stderr??built.error?.message??'').slice(-4000)}`);

const {loadSourceSnapshot}=await import(pathToFileURL(join(targetRoot,'apps/control-plane/dist/source-import.js')));
const fixtureSource=loadSourceSnapshot(targetRoot);
const hostProfile=JSON.parse(await readFile(join(targetRoot,'.local','platform-build-host.json'),'utf8'));
const {startControlPlane}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/main.js')));
const operator=await startControlPlane({root:targetRoot,databasePath:join(targetRoot,'.local','control-plane.sqlite'),port:0});
const fixtureDb=new DatabaseSync(join(targetRoot,'.local','control-plane.sqlite'));
const legacyBuildId=randomUUID();
fixtureDb.prepare(`INSERT INTO builds(id,product_id,version,state,artifact_digest,created,updated,actor_id,phase,attempt,cleanup_state,log)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(legacyBuildId,'legacy-product','0.1.0','SUCCEEDED','legacy-historical-digest',Date.now(),Date.now(),'system:browser-fixture','Historical imported row',0,'NOT_STARTED','');
fixtureDb.close();
console.log(JSON.stringify({type:'QB_BROWSER_SERVER',url:operator.url,pairingCode:operator.pairingCode,reviewedSourceFingerprint:fixtureSource.sourceFingerprint,nodeVersion:process.version,hostIdentity:{kind:hostProfile.kind,sha256:hostProfile.sha256,version:hostProfile.version,policy:hostProfile.policy}}));
process.stdin.setEncoding('utf8');
await new Promise(resolveClose=>process.stdin.once('data',()=>{process.stdin.pause();process.stdin.destroy();resolveClose();}));
await operator.close();
console.log(JSON.stringify({type:'QB_BROWSER_SERVER_CLOSED',exitCode:process.exitCode??0}));
