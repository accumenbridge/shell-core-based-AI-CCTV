import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const sourceRoot=resolve(process.cwd());
const targetRoot=resolve(process.argv[2]??'');
if(!targetRoot||targetRoot===sourceRoot)throw new Error('Expected a separate owned temporary project root');
const {copyReviewedBuildInputs,copyPrivateToolchain}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/build-inputs.js')));
await copyReviewedBuildInputs(sourceRoot,targetRoot);
await copyPrivateToolchain(sourceRoot,targetRoot);
await mkdir(join(targetRoot,'.local'),{recursive:true});
await copyFile(join(sourceRoot,'.local','platform-build-host.json'),join(targetRoot,'.local','platform-build-host.json'));
await copyFile(join(sourceRoot,'tools','registry-publish.ps1'),join(targetRoot,'tools','registry-publish.ps1'));
const built=spawnSync(process.execPath,[join(targetRoot,'tools','build.mjs')],{
  cwd:targetRoot,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024
});
if(built.error||built.status!==0||built.signal)throw new Error(`Temporary browser source build failed (${built.status??'spawn'}): ${(built.stderr??built.error?.message??'').slice(-3000)}`);
const {loadSourceSnapshot}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/source-import.js')));
const snapshot=loadSourceSnapshot(targetRoot);
const {startControlPlane}=await import(pathToFileURL(join(sourceRoot,'apps/control-plane/dist/main.js')));
const databasePath=join(targetRoot,'.local','control-plane.sqlite');
const operator=await startControlPlane({root:targetRoot,databasePath,port:0});
const profile=JSON.parse(await readFile(join(targetRoot,'.local','platform-build-host.json'),'utf8'));
const {maintainedSourceFingerprint}=await import(pathToFileURL(join(sourceRoot,'tools/verify-core.mjs')));
const maintainedFingerprint=await maintainedSourceFingerprint(sourceRoot);
console.log(JSON.stringify({
  type:'QB_CP3_BROWSER_SERVER',url:operator.url,pairingCode:operator.pairingCode,maintainedFingerprint,
  sourceFingerprint:snapshot.sourceFingerprint,nodeVersion:process.version,
  hostIdentity:{kind:profile.kind,version:profile.version,sha256:profile.sha256,policy:profile.policy}
}));

process.stdin.setEncoding('utf8');
await new Promise(resolveClose=>process.stdin.once('data',()=>{process.stdin.pause();process.stdin.destroy();resolveClose();}));
await operator.close();
console.log(JSON.stringify({type:'QB_CP3_BROWSER_SERVER_CLOSED',exitCode:process.exitCode??0}));
