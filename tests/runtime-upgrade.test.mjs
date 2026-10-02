import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/runtime/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { createOperatorServer } from '../apps/control-plane/dist/operator-server.js';
import { RUNTIME_RECOVERY_TOOL_SHA256 } from '../apps/control-plane/dist/runtime-recovery.js';
import { RuntimeUpgradeManager, RUNTIME_UPGRADE_PUBLISHER_SHA256, RUNTIME_UPGRADE_TOOL_SHA256 } from '../apps/control-plane/dist/runtime-upgrade.js';

const PAIRING='upgrade-route-pairing-code-1234';
const INSTANCE='runtime-123e4567-e89b-42d3-a456-426614174000';
const OPERATION='123e4567-e89b-42d3-a456-426614174001';
const ARTIFACT='a'.repeat(64),BACKUP='b'.repeat(64);
const fileDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
function request(context,path,{method='GET',json,cookie}={}){
  const url=new URL(context.server.url),headers={host:url.host,origin:context.server.url,connection:'close'};
  if(cookie)headers.cookie=cookie;
  const body=json===undefined?undefined:JSON.stringify(json);
  if(body!==undefined){headers['content-type']='application/json';headers['content-length']=String(Buffer.byteLength(body));}
  return new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port:url.port,path,method,headers},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));});
    req.on('error',reject);if(body!==undefined)req.write(body);req.end();});
}
const body=response=>JSON.parse(response.text);
test('recovery and upgrade exports pin the exact maintained native helpers',async()=>{
  const [recovery,upgrade,publisher]=await Promise.all([
    readFile(new URL('../tools/runtime-recovery.mjs',import.meta.url)),
    readFile(new URL('../tools/runtime-upgrade.mjs',import.meta.url)),
    readFile(new URL('../tools/runtime-upgrade-publish.ps1',import.meta.url))
  ]);
  for(const digest of [RUNTIME_RECOVERY_TOOL_SHA256,RUNTIME_UPGRADE_TOOL_SHA256,RUNTIME_UPGRADE_PUBLISHER_SHA256])
    assert.match(digest,/^[0-9a-f]{64}$/,'exported native tool pins are complete SHA-256 digests');
  assert.equal(fileDigest(recovery),RUNTIME_RECOVERY_TOOL_SHA256,'recovery export pins the checked-in recovery helper');
  assert.equal(fileDigest(upgrade),RUNTIME_UPGRADE_TOOL_SHA256,'upgrade export pins the checked-in upgrade helper');
  assert.equal(fileDigest(publisher),RUNTIME_UPGRADE_PUBLISHER_SHA256,'upgrade export pins the checked-in publisher');
});
async function fixture(t,upgradeManager){
  const directory=await mkdtemp(join(tmpdir(),'qb-runtime-upgrade-http-'));
  const store=new ControlPlaneStore(join(directory,'state.sqlite'));
  const server=await createOperatorServer({root:ROOT,store,port:0,pairingCode:PAIRING,upgradeManager});
  t.after(async()=>{try{await server.close();}finally{try{store.close();}finally{await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}});
  return {server,async pair(){const response=await request({server},'/platform-api/session',{method:'POST',json:{code:PAIRING}});
    assert.equal(response.status,200,response.text);return String(response.headers['set-cookie']).split(';',1)[0];}};
}

test('the upgrade manager keeps read-only history attached when the selected native host is unavailable',async t=>{
  const store={managedRuntimeGenerations:()=>[],managedRuntimeUpgrades:()=>[],managedRuntimeUpgrade:()=>undefined};
  const recovery={captureUpgradeNativeHost(){throw Object.assign(new Error('selected profile unavailable'),{code:'RUNTIME_UNAVAILABLE'});}};
  const manager=RuntimeUpgradeManager.create(ROOT,store,{},recovery);
  t.after(()=>manager.close());
  assert.deepEqual(manager.list(INSTANCE),{instanceId:INSTANCE,generations:[],operations:[]});
  assert.equal(manager.operation(OPERATION),undefined);
});

test('plural generation-upgrade routes require pairing and explicit exact-input confirmation',async t=>{
  const calls=[];
  const operation={id:OPERATION,instanceId:INSTANCE,sourceGenerationId:'generation:source:1',targetGenerationId:'generation:target:2',
    sourceAttemptId:'123e4567-e89b-42d3-a456-426614174002',sourceAttempt:1,sourceCommandId:'123e4567-e89b-42d3-a456-426614174003',
    sourceBackupDigest:BACKUP,targetVersion:'0.2.4',targetArtifactDigest:ARTIFACT,state:'SUCCEEDED',physicalState:'CLEAN',
    dispatchBegun:1,driverEmpty:1,driverClosed:1,stagingClean:1,publisherResultObserved:1,publisherClosed:1,destinationPublished:1,destinationVerified:1};
  const upgradeManager={list:id=>({instanceId:id,generations:[],operations:[operation]}),operation:id=>id===OPERATION?operation:undefined,
    upgrade:(input,actor,authorize)=>{authorize();calls.push({input,actor});return Promise.resolve(operation);}};
  const context=await fixture(t,upgradeManager),path=`/platform-api/runtime-instances/${INSTANCE}/upgrades`;
  assert.equal((await request(context,path)).status,401,'upgrade history is paired');
  const cookie=await context.pair();
  const listed=await request(context,path,{cookie});assert.equal(listed.status,200,listed.text);
  const listedOperation=body(listed).operations[0];assert.equal(body(listed).operations.length,1);
  for(const field of ['ownerToken','ownerId','requestKey','payloadDigest'])assert.equal(Object.hasOwn(listedOperation,field),false);
  for(const field of ['dispatchBegun','driverEmpty','driverClosed','stagingClean','publisherResultObserved','publisherClosed','destinationPublished','destinationVerified']){
    assert.equal(listedOperation[field],true,`${field} is represented as a JSON boolean`);
    assert.equal(typeof listedOperation[field],'boolean');
  }
  const operationRead=await request(context,`/platform-api/runtime-upgrades/${OPERATION}`,{cookie});assert.equal(operationRead.status,200);
  assert.equal(body(operationRead).driverEmpty,true);
  const input={confirm:true,targetVersion:'0.2.4',targetArtifactDigest:ARTIFACT,sourceBackupDigest:BACKUP,requestKey:'upgrade-http-key-001'};
  assert.equal((await request(context,`/platform-api/runtime-instances/${INSTANCE}/upgrade`,{method:'POST',cookie,json:input})).status,404,
    'there is no singular or compatibility alias');
  assert.equal((await request(context,path,{method:'POST',cookie,json:{...input,confirm:false}})).status,400);
  assert.equal((await request(context,path,{method:'POST',cookie,json:{...input,privatePath:'C:/secret'}})).status,400);
  assert.equal(calls.length,0);
  const submitted=await request(context,path,{method:'POST',cookie,json:input});
  assert.equal(submitted.status,202,submitted.text);assert.equal(body(submitted).id,OPERATION);assert.equal(body(submitted).driverEmpty,true);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].input,{instanceId:INSTANCE,targetVersion:'0.2.4',targetArtifactDigest:ARTIFACT,
    sourceBackupDigest:BACKUP,requestKey:input.requestKey,confirm:true});
  assert.match(calls[0].actor,/^operator:[0-9a-f-]{36}$/);
});
