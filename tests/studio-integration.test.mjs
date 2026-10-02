import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {TextEncoder} from 'node:util';
import {request} from 'node:http';
import {validSourceDirectoryId} from '../packages/contracts/dist/index.js';
import {ROOT} from '../apps/runtime/dist/index.js';
import {readCatalogue,browserCore} from '../tools/studio-catalogue.mjs';
import {composeDraft,validProductId,validateProduct} from '../packages/composition/dist/studio.js';
import {localConfiguration} from '../tools/local-profile.mjs';
import {createStudio} from '../tools/studio.mjs';
import {fixture,admin} from './helpers.mjs';
import {copyPortableFixture} from './source-copy.mjs';

const c=await readCatalogue(ROOT),profile=JSON.parse(await readFile(join(ROOT,'profiles/local-developer.json'),'utf8'));
const args={credentials:{admin:'test-admin-password',viewer:'test-viewer-password',serviceToken:'test-service-token'},dataDirectory:'/test-only/data'};
const draft=(selected,extra={})=>composeDraft({id:'fresh-product',title:'Fresh product',selected,...extra},c.modules,c.solutions,c.sourceVersion);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const run=(cwd,...args)=>{const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r.stdout;};
async function copyRoot(t){const copied=await copyPortableFixture(t,ROOT,{prefix:'qb-studio-'});try{run(copied.root,'tools/link-workspaces.mjs');run(copied.root,'tools/build.mjs');return copied;}catch(error){await copied.cleanup();throw error;}}

function htmlContext(html,route='modules'){const root={innerHTML:''},ctx=vm.createContext({TextEncoder,document:{getElementById:()=>root,addEventListener(){}},window:{addEventListener(){}},location:{hash:`#/${route}`},fetch(){assert.fail('Offline preview must not contact a server');}});for(const s of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(s[1]).runInContext(ctx);return {ctx,html:root.innerHTML};}
function parseInContext(context,value){context.__jsonFixture=JSON.stringify(value);try{return vm.runInContext('JSON.parse(globalThis.__jsonFixture)',context);}finally{delete context.__jsonFixture;}}

// V01: setup follows reviewed contract profile, not known example names.
test('Studio: newly named products receive the reviewed local provider identity',()=>{const d=draft(['handoff']);const {config}=localConfiguration(d.plan,profile,args);assert.equal(config.instanceId,'fresh-product-local');assert.ok(config.principals.some(p=>p.id==='knowledge-link'));assert.equal(config.connections['local-desk'].destinationProduct,'fresh-product');assert.equal(config.connections['local-desk'].serviceActor,'knowledge-link');});
test('Studio: neutral product does not receive unrelated service identities',()=>{const {config}=localConfiguration(draft([]).plan,profile,args);assert.deepEqual(config.principals.map(p=>p.id),['admin','viewer']);assert.deepEqual(config.connections,{});});
test('Studio: local seed cannot request an undeclared permission',()=>{const p=structuredClone(profile);p.providerSeeds[0].permissions.push('unrelated.admin');assert.throws(()=>localConfiguration(draft(['handoff']).plan,p,args),/undeclared/);});
test('Studio: connected selection retains explicit tenant relationship without silently embedding the destination',()=>{const d=draft(['handoff'],{choices:{'handoff:desk.requests.create.v2':'connected'}});assert.ok(!d.product.modules.some(m=>m.id==='service-desk'));const {config,tenants}=localConfiguration(d.plan,profile,{...args,basePort:4500});assert.deepEqual(tenants,['org-a','org-b']);assert.equal(config.connections['connected-desk'].tenantMap['org-a'],'customer-a');assert.equal(config.connections['connected-desk'].baseUrl,'http://127.0.0.1:4510');});
test('Studio: unsupported remote fixture origin is refused',()=>{const d=draft(['handoff'],{choices:{'handoff:desk.requests.create.v2':'connected'}});assert.throws(()=>localConfiguration(d.plan,profile,{...args,deskUrl:'http://arbitrary.example'}),/loopback/);});
test('Studio: dependency explanation is source-derived and uses actual versions',()=>{const d=draft(['handoff']);assert.ok(d.explanation.some(e=>e.moduleId==='knowledge'&&!e.requested));assert.ok(d.explanation.some(e=>e.moduleId==='service-desk'&&e.reason.includes('desk.requests.create.v2')));for(const m of d.product.modules)assert.equal(m.version,c.modules.find(x=>x.id===m.id).version);});
test('Studio: no guessed provider for an unsupported new required contract',()=>{const m={...c.modules[1],id:'unbound-feature',dependencies:[],requires:['new.contract.v1'],provides:[],routes:[],workspaces:[],permissions:[]};assert.throws(()=>composeDraft({id:'test-product',title:'Test',selected:['unbound-feature']},[...c.modules,m],c.solutions),/reviewed Studio wiring/);});
test('Studio: unused or invalid binding selection fails rather than retargeting',()=>{assert.throws(()=>draft(['handoff'],{choices:{'handoff:desk.requests.create.v2':'wrong'}}),/Unsupported binding/);assert.throws(()=>draft(['service-desk'],{choices:{'handoff:desk.requests.create.v2':'connected'}}),/Unused binding/);});
test('Studio: import rejects runtime authority, path escape and unknown source wiring',()=>{const p=draft(['handoff']).product;for(const q of [{...p,permissions:['admin']},{...p,id:'../outside'},{...p,wiring:'../../tool'},{...p,bindings:p.bindings.map(b=>({...b,implementation:'unreviewed'}))}])assert.throws(()=>validateProduct(q,c.modules,c.solutions));});
test('Studio: browser and CLI use the same compiled resolver',async()=>{const context=vm.createContext({TextEncoder});new vm.Script(await browserCore(ROOT)).runInContext(context);const expected=draft(['handoff']);const browserCatalogue=parseInContext(context,{modules:c.modules,solutions:c.solutions});const browserDraft=parseInContext(context,{id:'fresh-product',title:'Fresh product',selected:['handoff']});const actual=context.QBComposer.composeDraft(browserDraft,browserCatalogue.modules,browserCatalogue.solutions,c.sourceVersion);assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected);});
test('Studio: browser, product and package source IDs share the exact 2–48 identity predicate',async()=>{const context=vm.createContext({TextEncoder});new vm.Script(await browserCore(ROOT)).runInContext(context);for(const candidate of ['a1','a'.repeat(48)]){assert.equal(validSourceDirectoryId(candidate),true);assert.equal(validProductId(candidate),true);assert.equal(context.QBContracts.validSourceDirectoryId(candidate),true);assert.equal(context.QBComposer.validProductId(candidate),true);}for(const candidate of ['a','a'.repeat(49),'A1']){assert.equal(validSourceDirectoryId(candidate),false);assert.equal(validProductId(candidate),false);assert.equal(context.QBContracts.validSourceDirectoryId(candidate),false);assert.equal(context.QBComposer.validProductId(candidate),false);}});

test('Runtime: Handoff document picker uses the permitted Knowledge owner query',async t=>{const f=await fixture(t,'combined');const d=await f.call('POST','/api/documents',{title:'Select this source',body:'Owner data'},'doc-options');const options=await f.call('GET','/api/handoffs/options');assert.equal(options.documents[0].id,d.id);assert.equal(options.connection.state,'READY');f.runtime.access.revoke('admin','tenant-a','knowledge.read');await assert.rejects(f.call('GET','/api/handoffs/options'),e=>e.code==='DENIED');});
test('Runtime: missing destination authority is visible before new handoff submission',async t=>{const f=await fixture(t,'combined');const d=await f.call('POST','/api/documents',{title:'Source',body:'Content'},'src');f.runtime.access.revoke('link','tenant-a','desk.create');const opt=await f.call('GET','/api/handoffs/options');assert.equal(opt.connection.state,'BLOCKED');assert.equal(opt.connection.code,'DENIED');await assert.rejects(f.call('POST','/api/handoffs',{documentId:d.id,reason:'No grant'},'h'),e=>e.code==='DENIED');assert.equal((await f.call('GET','/api/handoffs')).items.length,0);assert.equal((await f.call('GET','/api/requests')).items.length,0);});

async function pair(studio){const r=await fetch(studio.url+'/studio-api/session',{method:'POST',headers:{Origin:studio.url,'Content-Type':'application/json'},body:JSON.stringify({code:studio.code})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
async function call(studio,cookie,path,method='GET',data){const r=await fetch(studio.url+'/studio-api'+path,{method,headers:{Cookie:cookie,Origin:studio.url,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,body:await r.json()};}
test('Studio server: pairing, exact origin/host, bounded routes and no filesystem or shell endpoint',async t=>{const copied=await copyRoot(t),{root,temp}=copied;const studio=await createStudio({root,stateRoot:join(temp,'operator'),port:0,quiet:true});copied.registerCleanup(()=>studio.close());assert.equal((await fetch(studio.url+'/studio-api/catalogue')).status,401);const cookie=await pair(studio);assert.equal((await call(studio,cookie,'/catalogue')).status,200);for(const path of ['/run','/exec','/files','/read'])assert.equal((await call(studio,cookie,path,'POST',{command:'ignored'})).status,404);const hostile=await fetch(studio.url+'/studio-api/products',{method:'POST',headers:{Origin:'https://unrelated.example',Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(hostile.status,403);const rebind=await new Promise((resolve,reject)=>{const req=request(studio.url+'/studio-api/catalogue',{headers:{Host:'evil.invalid',Cookie:cookie}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(rebind,403);assert.equal((await call(studio,cookie,'/products/neutral/build','POST',{})).status,400);assert.equal((await call(studio,cookie,'/products','POST',{...draft([]).product,id:'../escape'})).status,400);assert.equal((await call(studio,cookie,'/logout','POST',{})).status,200);assert.equal((await call(studio,cookie,'/catalogue')).status,401);});

test('Acceptance: generate module → dynamic Studio → compose new name → build → launch → persistent record and real receipt',async t=>{
    const copied=await copyRoot(t),{root,temp}=copied;
    const original=await readFile(join(root,'packages/backend-host/src/index.ts'),'utf8');
    run(root,'tools/factory.mjs','create-module','checklist');
    const catalogue=await readCatalogue(root);assert.equal(catalogue.modules.length,4);
    const result=composeDraft({id:'facility-new',title:'Facility studio acceptance',selected:['checklist','handoff']},catalogue.modules,catalogue.solutions);
    const studio=await createStudio({root,stateRoot:join(temp,'operator'),port:0,quiet:true});copied.registerCleanup(()=>studio.close());const cookie=await pair(studio);
    const saved=await call(studio,cookie,'/products','POST',result.product);assert.equal(saved.status,201);assert.equal((await call(studio,cookie,'/products','POST',result.product)).status,409);
    const build=await call(studio,cookie,'/products/facility-new/build','POST',{confirm:true});assert.equal(build.status,202);
    await studio.manager.jobs.get(build.body.id).promise;assert.equal(studio.manager.job(build.body.id).status,'BUILT',JSON.stringify(studio.manager.job(build.body.id)));
    assert.equal(await readFile(join(root,'packages/backend-host/src/index.ts'),'utf8'),original);
    const html=await readFile(join(root,'OPEN_PLATFORM.html'),'utf8');const moduleView=htmlContext(html,'modules');assert.match(moduleView.html,/Checklist/);
    const home=htmlContext(html,'overview');assert.match(home.html,/Facility studio acceptance/);
    const exported=home.ctx.QBPreviewModel.compose('second-new','Another',['checklist','handoff']);assert.ok(exported.modules.some(m=>m.id==='checklist'));
    const preserveLaunchFailure=async response=>{
        if(response.status===200)return;
        const state=studio.manager.running.get('facility-new'),facts=state?.launchDiagnostics;
        if(!facts){t.diagnostic(JSON.stringify({evidenceRef:null,category:'STARTUP_EVIDENCE_UNAVAILABLE',httpStatus:response.status}));return;}
        const evidenceRef=randomUUID(),directory=join(ROOT,'.local','studio-startup-evidence');let privateEvidenceSaved=false;
        try {
            await mkdir(directory,{recursive:true,mode:0o700});
            const privateRecord={schema:1,evidenceRef,productId:'facility-new',attempt:facts};
            await writeFile(join(directory,`${evidenceRef}.json`),`${JSON.stringify(privateRecord)}\n`,{flag:'wx',mode:0o600});
            privateEvidenceSaved=true;
        } catch { /* report capture failure without replacing the original acceptance result */ }
        const code=facts.firstSpawnError?.code;
        const safeCode=typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:typeof code==='number'?String(code):null;
        const safeSignal=value=>typeof value==='string'&&/^SIG[A-Z0-9]+$/.test(value)?value:null;
        const safeStderrCategory=['PORT_IN_USE','DATABASE_BUSY','MODULE_NOT_FOUND','SQLITE_ERROR','UNCLASSIFIED_STDERR','NO_STDERR'].includes(facts.stderrCategory)?facts.stderrCategory:'UNCLASSIFIED_STDERR';
        t.diagnostic(JSON.stringify({evidenceRef,category:'APPLICATION_STARTUP_FAILED',httpStatus:response.status,
            phase:['STAGING_SNAPSHOT','VALIDATE_LOCAL_PLAN','RESERVE_LOOPBACK_PORT','SPAWN_APPLICATION','WAIT_API_READINESS','API_READY'].includes(facts.phase)?facts.phase:'OTHER',
            elapsedMs:Number.isInteger(facts.elapsedMs)?facts.elapsedMs:null,readiness:facts.readiness==='API_READY'?'API_READY':'NOT_READY',
            firstSpawnErrorObserved:Boolean(facts.firstSpawnError),firstSpawnErrorCode:safeCode,
            stderrCategory:safeStderrCategory,
            exitObserved:facts.exitObserved===true,exitCode:Number.isInteger(facts.exitCode)?facts.exitCode:null,exitSignal:safeSignal(facts.exitSignal),
            closeObserved:facts.closeObserved===true,closeCode:Number.isInteger(facts.closeCode)?facts.closeCode:null,closeSignal:safeSignal(facts.closeSignal),
            stderrBytes:Number.isSafeInteger(facts.stderrBytes)?facts.stderrBytes:null,stderrCapturedBytes:Number.isSafeInteger(facts.stderrCapturedBytes)?facts.stderrCapturedBytes:null,
            stderrTruncated:facts.stderrTruncated===true,stderrSha256:/^[a-f0-9]{64}$/.test(facts.stderrSha256)?facts.stderrSha256:null,privateEvidenceSaved}));
    };
    let launched=await call(studio,cookie,'/products/facility-new/launch','POST',{confirm:true});await preserveLaunchFailure(launched);assert.equal(launched.status,200,JSON.stringify(launched.body));assert.equal(launched.body.status,'RUNNING');
    let state=studio.manager.running.get('facility-new');const credentials=JSON.parse(await readFile(join(state.data,'developer-credentials.json'),'utf8'));
    const login=async(url)=>{const r=await fetch(url+'/api/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:credentials.admin})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
    let appUrl=launched.body.url,session=await login(appUrl);
    const api=async(path,method='GET',body,key='studio-case')=>{const r=await fetch(appUrl+path,{method,headers:{Cookie:session,Origin:appUrl,'Content-Type':'application/json','X-QB-Tenant':'customer-a','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});const out=await r.json();assert.equal(r.status,200,JSON.stringify(out));return out;};
    await api('/api/checklist','POST',{title:'A real generated module record'},'check');
    const doc=await api('/api/documents','POST',{title:'Studio-linked source',body:'Created through the actual composed application.'},'doc');
    const options=await api('/api/handoffs/options');assert.equal(options.documents[0].id,doc.id);assert.equal(options.connection.state,'READY');
    await api('/api/handoffs','POST',{documentId:doc.id,reason:'Verify the reusable cross-product operation'},'handoff');
    let handoffs;for(let i=0;i<100;i++){handoffs=await api('/api/handoffs');if(handoffs.items[0]?.outcome==='DESTINATION_COMMITTED')break;await wait(100);}
    assert.equal(handoffs.items[0].outcome,'DESTINATION_COMMITTED');assert.equal(handoffs.items[0].acceptance.receipt.destination.productId,'facility-new');assert.equal((await api('/api/requests')).items.length,1);
    await api('/api/modules/mode','POST',{moduleId:'service-desk',mode:'read-only'},'pause');assert.equal((await api('/api/handoffs/options')).connection.state,'BLOCKED');
    await call(studio,cookie,'/products/facility-new/stop','POST',{confirm:true});
    launched=await call(studio,cookie,'/products/facility-new/launch','POST',{confirm:true});await preserveLaunchFailure(launched);assert.equal(launched.status,200);appUrl=launched.body.url;session=await login(appUrl);
    assert.equal((await api('/api/checklist')).items.length,1);assert.equal((await api('/api/requests')).items.length,1);
    assert.equal((await api('/api/handoffs/options')).connection.state,'BLOCKED','Restart must not restore removed authority/mode');
    assert.equal((await api('/api/handoffs')).items[0].outcome,'DESTINATION_COMMITTED','Existing receipt remains true while new actions are blocked');
    await mkdir(join(ROOT,'evidence'),{recursive:true});
    await writeFile(join(ROOT,'evidence/studio-journey.json'),JSON.stringify({status:'PASSED_FOR_LOCAL_API_WORKFLOW',at:new Date().toISOString(),fixtureProduct:'facility-new',fixtureModule:'checklist',sourceCatalogueModules:4,maintainedBackendHostUnchanged:true,studioDefinitionSaved:true,studioBuild:'BUILT',instance:'API_READY',generatedModuleRecordsAfterRestart:1,destinationRecordsAfterRestart:1,receipt:handoffs.items[0].acceptance.receipt,pausedDestinationAfterRestart:'BLOCKED',browser:'NOT_PROVEN_BY_THIS_TEST',credentialsIncluded:false},null,2)+'\n');
});
