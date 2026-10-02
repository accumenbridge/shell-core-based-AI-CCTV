import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/runtime/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { createOperatorServer } from '../apps/control-plane/dist/operator-server.js';
import { RuntimePreparationError } from '../apps/control-plane/dist/runtime-manager.js';

const CODE = 'test-pairing-code-123456';
async function start(t, options = {}) {
    const temp = await mkdtemp(join(tmpdir(), 'qb-control-plane-http-'));
    let store;
    let operator;
    const stop = async () => {
        const failures = [];
        if (operator) { try { await operator.close(); } catch (error) { failures.push(error); } operator = undefined; }
        if (store) { try { store.close(); } catch (error) { failures.push(error); } store = undefined; }
        if (failures.length) throw new AggregateError(failures, 'test server cleanup failed');
    };
    t.after(async () => { try { await stop(); } finally { await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } });
    store = new ControlPlaneStore(join(temp, 'state.sqlite'));
    const begin = async () => {
        operator = await createOperatorServer({ root: ROOT, store, port: 0, pairingCode: CODE, ...options });
        return operator;
    };
    await begin();
    return {
        get operator() { return operator; },
        get store() { return store; },
        async restart() { await stop(); store = new ControlPlaneStore(join(temp, 'state.sqlite')); await begin(); }
    };
}
function request(context, path, { method = 'GET', json, raw, contentType = 'application/json', origin, host, cookie } = {}) {
    const url = new URL(context.operator.url);
    const headers = { host: host ?? url.host, connection: 'close' };
    if (origin !== null) headers.origin = origin ?? context.operator.url;
    if (cookie) headers.cookie = cookie;
    let body;
    if (json !== undefined) body = JSON.stringify(json);
    else if (raw !== undefined) body = raw;
    if (body !== undefined) {
        headers['content-type'] = contentType;
        headers['content-length'] = String(Buffer.byteLength(body));
    }
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: url.port, path, method, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}
const body = response => JSON.parse(response.text);
function withTimeout(promise, label, milliseconds = 5000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function pair(context) {
    const response = await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE } });
    assert.equal(response.status, 200, response.text);
    const cookie = String(response.headers['set-cookie']).split(';', 1)[0];
    return { cookie, token: cookie.slice(cookie.indexOf('=') + 1) };
}

test('public health and static entry are narrow while state and audit require pairing and exact Host', async t => {
    const context = await start(t);
    const initialAudit = context.store.auditLog(500).length;
    const health = await request(context, '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(body(health), { status: 'ok' });
    assert.equal(Object.keys(body(health)).length, 1);
    const page = await request(context, '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /id="app"/);
    assert.equal((await request(context, '/main.js')).status, 200);
    assert.equal((await request(context, '/studio.css')).status, 200);
    assert.equal((await request(context, '/README.md')).status, 404);
    for (const path of ['/platform-api/session', '/platform-api/overview', '/platform-api/audit']) {
        const response = await request(context, path);
        assert.equal(response.status, 401, `${path}: ${response.text}`);
    }
    const wrongHost = await request(context, '/healthz', { host: `localhost:${new URL(context.operator.url).port}` });
    assert.equal(wrongHost.status, 403);
    assert.equal(context.store.auditLog(500).length, initialAudit);
});

test('pairing rejects bad input, issues a scoped HttpOnly session, and logout removes it', async t => {
    const context = await start(t);
    const initialAudit = context.store.auditLog(500).length;
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: 'wrong-code-000000000' } })).status, 401);
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE }, origin: null })).status, 403);
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE }, origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE, extra: true } })).status, 400);
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', raw: '{', contentType: 'application/json' })).status, 400);
    assert.equal(context.store.auditLog(500).length, initialAudit);

    const paired = await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE } });
    assert.equal(paired.status, 200, paired.text);
    const setCookie = String(paired.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/platform-api/);
    assert.equal(paired.text.includes(CODE), false);
    const cookie = setCookie.split(';', 1)[0];
    const session = await request(context, '/platform-api/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.text.includes(cookie.split('=')[1]), false);

    const overview = await request(context, '/platform-api/overview', { cookie });
    assert.equal(overview.status, 200, overview.text);
    const logout = await request(context, '/platform-api/logout', { method: 'POST', json: {}, cookie });
    assert.equal(logout.status, 200, logout.text);
    assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await request(context, '/platform-api/overview', { cookie })).status, 401);
});

test('paired family derivation is source-authoritative and immutable provenance follows only the exact saved version', async t => {
    const context=await start(t);
    const {cookie}=await pair(context);
    const catalogueResponse=await request(context,'/platform-api/catalogue',{cookie});
    assert.equal(catalogueResponse.status,200,catalogueResponse.text);
    const catalogue=body(catalogueResponse);
    const family=catalogue.families.find(item=>item.id==='service-operations');
    assert.ok(family,'the paired catalogue reads the reviewed source family');
    const derivationRequest={familyId:family.id,selection:['requests','shared-library'],identity:{
        id:'family-http-provenance',title:'Requests and Library',version:'1.2.0',description:'Saved from the reviewed family.',layout:'sidebar'}};
    const derivedResponse=await request(context,'/platform-api/products/derive-family',{method:'POST',json:derivationRequest,cookie});
    assert.equal(derivedResponse.status,200,derivedResponse.text);
    const derived=body(derivedResponse);
    assert.deepEqual(derived.product.modules.map(item=>item.id).sort(),['knowledge','service-desk']);
    assert.deepEqual(derived.product.bindings,[]);
    assert.equal(derived.familyDerivation.familyId,family.id);
    assert.equal(derived.familyDerivation.familyVersion,family.version);
    assert.equal(derived.familyDerivation.sourceFingerprint.length,64);
    assert.equal(derived.familyDerivation.productDigest.length,64);

    const auditBefore=context.store.auditLog(500).length;
    const mismatch=await request(context,'/platform-api/products',{method:'POST',cookie,json:{confirm:true,
        product:{...derived.product,title:'Client changed the family result.'},derivation:derivationRequest}});
    assert.equal(mismatch.status,409,'the server rederives the family instead of trusting a client product claim');
    assert.equal(context.store.product(derived.product.id,derived.product.version),undefined);
    assert.equal(context.store.auditLog(500).length,auditBefore);

    const savedResponse=await request(context,'/platform-api/products',{method:'POST',cookie,json:{confirm:true,product:derived.product,derivation:derivationRequest}});
    assert.equal(savedResponse.status,201,savedResponse.text);
    const saved=body(savedResponse);
    assert.deepEqual(saved.product,derived.product);
    assert.equal(saved.familyDerivation.familyId,family.id);
    const exactVersion=await request(context,`/platform-api/products/${derived.product.id}/${derived.product.version}`,{cookie});
    assert.equal(exactVersion.status,200,exactVersion.text);
    assert.deepEqual(body(exactVersion).familyDerivation,saved.familyDerivation);
    const auditAfter=context.store.auditLog(500).length;
    const replay=await request(context,'/platform-api/products',{method:'POST',cookie,json:{confirm:true,product:derived.product,derivation:derivationRequest}});
    assert.equal(replay.status,201,replay.text);
    assert.deepEqual(body(replay).familyDerivation,saved.familyDerivation);
    assert.equal(context.store.auditLog(500).length,auditAfter,'an identical immutable-version retry does not add another provenance audit');

    const retryWithoutClaim=await request(context,'/platform-api/products',{method:'POST',cookie,json:{confirm:true,product:derived.product}});
    assert.equal(retryWithoutClaim.status,201,retryWithoutClaim.text);
    assert.deepEqual(body(retryWithoutClaim).familyDerivation,saved.familyDerivation,
        'an identical version retry returns its stored family claim even when the request omits a new claim');
    assert.equal(context.store.auditLog(500).length,auditAfter,'returning existing provenance does not create another audit');

    const manual={...derived.product,version:'1.2.1',description:'A manual version has no historical family claim.'};
    const manualSave=await request(context,'/platform-api/products',{method:'POST',cookie,json:{confirm:true,product:manual}});
    assert.equal(manualSave.status,201,manualSave.text);
    assert.equal(body(manualSave).familyDerivation,null);
    const manualRead=await request(context,`/platform-api/products/${manual.id}/${manual.version}`,{cookie});
    assert.equal(manualRead.status,200,manualRead.text);
    assert.equal(body(manualRead).familyDerivation,null,'manual edits do not inherit an earlier version claim');
});

test('managed runtime API exposes fixed authenticated routes and exact confirmed request envelopes',async t=>{
    const calls=[];
    const instanceId='runtime-123e4567-e89b-42d3-a456-426614174000';
    const runtimeManager={
        list:()=>({capability:{status:'local-only'},slot:{state:'EMPTY'},instances:[]}),
        detail:id=>id===instanceId?{id,state:'STOPPED',events:'{"type":"STOPPED"}',processObservation:'positively-stopped'}:undefined,
        start:(input,actorId,authorize)=>{authorize();calls.push({kind:'START',input,actorId});return Promise.resolve({state:'STARTING',instance:{id:instanceId}});},
        stop:(input,actorId,authorize)=>{authorize();calls.push({kind:'STOP',input,actorId});return Promise.resolve({state:'STOPPED',instance:{id:instanceId}});},
        restart:(input,actorId,authorize)=>{authorize();calls.push({kind:'RESTART',input,actorId});return Promise.resolve({state:'RUNNING',instance:{id:instanceId}});}
    };
    const context=await start(t,{runtimeManager});
    const {cookie}=await pair(context);
    const overview=await request(context,'/platform-api/overview',{cookie});
    assert.equal(body(overview).capabilities.find(item=>item.id==='application-runtime').status,'attached');
    assert.equal((await request(context,'/platform-api/runtime-instances')).status,401);
    const list=await request(context,'/platform-api/runtime-instances',{cookie});
    assert.equal(list.status,200);assert.deepEqual(body(list).instances,[]);
    const detail=await request(context,`/platform-api/runtime-instances/${instanceId}`,{cookie});
    assert.equal(detail.status,200);assert.equal(body(detail).processObservation,'positively-stopped');
    const log=await request(context,`/platform-api/runtime-instances/${instanceId}/log`,{cookie});
    assert.deepEqual(body(log),{instanceId,events:'{"type":"STOPPED"}'});

    const started=await request(context,'/platform-api/runtime-instances',{method:'POST',cookie,json:{confirm:true,productId:'service-desk',version:'1.0.0',requestKey:'runtime-start-key-001'}});
    assert.equal(started.status,202,started.text);assert.equal(body(started).state,'STARTING');
    assert.deepEqual(calls[0],{kind:'START',input:{productId:'service-desk',version:'1.0.0',requestKey:'runtime-start-key-001'},actorId:calls[0].actorId});
    assert.match(calls[0].actorId,/^operator:[0-9a-f-]{36}$/i);
    const extra=await request(context,'/platform-api/runtime-instances',{method:'POST',cookie,json:{confirm:true,productId:'service-desk',version:'1.0.0',requestKey:'runtime-start-key-002',path:'C:/private'}});
    assert.equal(extra.status,400);assert.equal(calls.length,1);
    const stop=await request(context,`/platform-api/runtime-instances/${instanceId}/stop`,{method:'POST',cookie,json:{confirm:true,requestKey:'runtime-stop-key-001'}});
    assert.equal(stop.status,202,stop.text);assert.equal(calls.at(-1).kind,'STOP');
    const restart=await request(context,`/platform-api/runtime-instances/${instanceId}/restart`,{method:'POST',cookie,json:{confirm:true,requestKey:'runtime-restart-key-001'}});
    assert.equal(restart.status,202,restart.text);assert.equal(calls.at(-1).kind,'RESTART');
    const uppercaseStop=await request(context,`/platform-api/runtime-instances/${instanceId}/STOP`,{method:'POST',cookie,json:{confirm:true,requestKey:'runtime-stop-key-002'}});
    assert.equal(uppercaseStop.status,404);assert.equal(calls.length,3,'case-variant action paths cannot dispatch a different runtime action');
    const privatePath=await request(context,'/platform-api/runtime-instances',{method:'POST',cookie,json:{confirm:true,productId:'service-desk',version:'1.0.0',requestKey:'runtime-start-key-003',argv:['node','arbitrary.js']}});
    assert.equal(privatePath.status,400);assert.equal(calls.length,3);
});

test('private recovery routes require confirmation and never expose operation ownership secrets',async t=>{
    const instanceId='runtime-123e4567-e89b-42d3-a456-426614174000',digest='a'.repeat(64),calls=[];
    const internal={id:'123e4567-e89b-42d3-a456-426614174001',kind:'BACKUP',state:'SUCCEEDED',instanceId,backupDigest:digest,
        ownerId:'123e4567-e89b-42d3-a456-426614174002',ownerToken:'private-owner-token-value',requestKey:'private-request-key-0001',payloadDigest:'f'.repeat(64)};
    const recoveryManager={
        list:id=>({capability:{status:'ready'},instanceId:id,backups:[{digest}],operations:[internal]}),
        backup:(input,actorId,authorize)=>{authorize();calls.push({kind:'BACKUP',input,actorId});return Promise.resolve(internal);},
        restore:(input,actorId,authorize)=>{authorize();calls.push({kind:'RESTORE',input,actorId});return Promise.resolve({...internal,kind:'RESTORE'});},
        verifyBackup:requested=>Promise.resolve({instanceId,digest:requested,verified:true,sizeBytes:2048,fileCount:6})
    };
    const context=await start(t,{recoveryManager});
    const backupsPath=`/platform-api/runtime-instances/${instanceId}/backups`;
    assert.equal((await request(context,backupsPath)).status,401);
    const {cookie}=await pair(context);
    const listed=await request(context,backupsPath,{cookie});
    assert.equal(listed.status,200,listed.text);assert.equal(body(listed).operations.length,1);
    for(const field of ['ownerToken','ownerId','requestKey','payloadDigest'])assert.equal(Object.hasOwn(body(listed).operations[0],field),false);
    const missingConfirmation=await request(context,backupsPath,{method:'POST',cookie,json:{requestKey:'backup-http-key-0001'}});
    assert.equal(missingConfirmation.status,400);assert.equal(calls.length,0);
    const created=await request(context,backupsPath,{method:'POST',cookie,json:{confirm:true,requestKey:'backup-http-key-0001'}});
    assert.equal(created.status,201,created.text);assert.equal(body(created).backupDigest,digest);
    for(const field of ['ownerToken','ownerId','requestKey','payloadDigest'])assert.equal(Object.hasOwn(body(created),field),false);
    assert.equal((await request(context,`/platform-api/runtime-backups/${digest}`,{cookie})).status,200);
    const restored=await request(context,`/platform-api/runtime-instances/${instanceId}/restore`,{method:'POST',cookie,
        json:{confirm:true,backupDigest:digest,requestKey:'restore-http-key-0001'}});
    assert.equal(restored.status,200,restored.text);assert.equal(body(restored).kind,'RESTORE');
    for(const field of ['ownerToken','ownerId','requestKey','payloadDigest'])assert.equal(Object.hasOwn(body(restored),field),false);
    assert.deepEqual(calls.map(row=>row.kind),['BACKUP','RESTORE']);
});

test('managed runtime HTTP errors use fixed non-path messages',async t=>{
    const runtimeManager={list:()=>({instances:[]}),detail:()=>undefined,
        start:()=>Promise.reject(new RuntimePreparationError('RUNTIME_REPAIR_REQUIRED','C:/private/runtime-secret')),stop:()=>Promise.resolve({}),restart:()=>Promise.resolve({})};
    const context=await start(t,{runtimeManager});const {cookie}=await pair(context);
    const response=await request(context,'/platform-api/runtime-instances',{method:'POST',cookie,json:{confirm:true,productId:'service-desk',version:'1.0.0',requestKey:'runtime-error-key-001'}});
    assert.equal(response.status,409);assert.equal(body(response).code,'RUNTIME_REPAIR_REQUIRED');
    assert.doesNotMatch(response.text,/C:\\private|runtime-secret/);
});

test('pairing attempts are bounded and expire their rate window', async t => {
    let time = 1000;
    const context = await start(t, { now: () => time, pairWindowMs: 100, maxPairAttempts: 2 });
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: 'bad-code-value-000000' } })).status, 401);
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: 'bad-code-value-000000' } })).status, 401);
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE } })).status, 429);
    time += 101;
    assert.equal((await request(context, '/platform-api/session', { method: 'POST', json: { code: CODE } })).status, 200);
});

test('authenticated mutations require exact origin, JSON, bounded shape, confirmation, and server-derived audit actor', async t => {
    const context = await start(t);
    const { cookie, token } = await pair(context);
    const environment = { id: 'test-env', label: 'Test', kind: 'test', target: 'local' };
    const initialAudit = context.store.auditLog(500).length;
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment }, cookie, origin: 'http://wrong.invalid' })).status, 403);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment }, cookie, origin: null })).status, 403);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment }, cookie, host: 'localhost:4480' })).status, 403);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment }, cookie, contentType: 'text/plain' })).status, 415);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', raw: '{', cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', raw: 'x'.repeat(65 * 1024), cookie })).status, 413);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment, unknown: 1 }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { environment }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment: { ...environment, target: ['local'] } }, cookie })).status, 400);
    assert.equal(context.store.environments().some(row => row.id === environment.id), false);
    assert.equal(context.store.auditLog(500).length, initialAudit);

    const added = await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment }, cookie });
    assert.equal(added.status, 200, added.text);
    const audit = context.store.auditLog(500)[0];
    assert.match(audit.actorId, /^operator:[0-9a-f-]{36}$/);
    assert.equal(audit.actorId.includes(token), false);
    assert.equal(audit.payload.includes(token), false);
});

test('AI pipeline writes validate runtime schemas and identical versions do not add audit rows', async t => {
    const context = await start(t);
    const { cookie } = await pair(context);
    const pipeline = {
        schema: 'quadbridge.ai-pipeline.v1', id: 'http-pipeline', version: '1.0.0', label: 'HTTP pipeline',
        nodes: [{ id: 'input', kind: 'input' }, { id: 'answer', kind: 'model', capability: 'text.generate' }, { id: 'output', kind: 'output' }],
        edges: [{ from: 'input', to: 'answer' }, { from: 'answer', to: 'output' }],
        policy: { timeoutMs: 1000, maxParallel: 1, dataClass: 'internal', placement: 'edge' }
    };
    const auditCount = context.store.auditLog(500).length;
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { confirm: true, pipeline }, cookie })).status, 200);
    const afterFirstWrite = context.store.auditLog(500).length;
    assert.equal(afterFirstWrite, auditCount + 1);
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { confirm: true, pipeline }, cookie })).status, 200);
    assert.equal(context.store.auditLog(500).length, afterFirstWrite);
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { confirm: true, pipeline: { ...pipeline, id: ['http-pipeline'] } }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { confirm: true, pipeline: { ...pipeline, nodes: [...pipeline.nodes.slice(0, 1), { id: 'answer', kind: 'mystery' }, pipeline.nodes[2]] } }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { confirm: true, pipeline: { ...pipeline, policy: { ...pipeline.policy, placement: ['edge'] } } }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { confirm: true, pipeline, extra: true }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/ai/pipelines', { method: 'POST', json: { pipeline }, cookie })).status, 400);
    assert.equal(context.store.auditLog(500).length, afterFirstWrite);
    assert.equal(context.store.aiPipelines().find(row => row.id === pipeline.id).spec.label, pipeline.label);
});

test('build requests fail closed without an executor and deployment requests enforce immutable references', async t => {
    const context = await start(t);
    const { cookie } = await pair(context);
    const productRow = context.store.products()[0];
    const beforeBuildRequest = context.store.builds().length;
    const unavailable = await request(context, '/platform-api/builds', { method: 'POST', json: { confirm: true, productId: productRow.id, version: productRow.version, requestKey: 'no-executor-build-0001' }, cookie });
    assert.equal(unavailable.status, 503, unavailable.text);
    assert.equal(context.store.builds().length, beforeBuildRequest);
    assert.equal((await request(context, '/platform-api/builds', { method: 'POST', json: { confirm: true, productId: productRow.id, version: productRow.version, requestKey: 'no-executor-build-0001', state: 'SUCCEEDED', artifactDigest: 'a'.repeat(64) }, cookie })).status, 400);
    const missingEnvironment = await request(context, '/platform-api/deployments', { method: 'POST', json: { confirm: true, environmentId: 'missing-env', productId: productRow.id, version: productRow.version, buildId: '123e4567-e89b-42d3-a456-426614174000' }, cookie });
    assert.equal(missingEnvironment.status, 404);
    const env = await request(context, '/platform-api/environments', { method: 'POST', json: { confirm: true, environment: { id: 'test-env', label: 'Test', kind: 'test', target: 'local' } }, cookie });
    assert.equal(env.status, 200);
    const queuedBuild = context.store.requestBuild(productRow.id, productRow.version, 'system:test-suite').id;
    const absentBuild = await request(context, '/platform-api/deployments', { method: 'POST', json: { confirm: true, environmentId: 'test-env', productId: productRow.id, version: productRow.version, buildId: '123e4567-e89b-42d3-a456-426614174000' }, cookie });
    assert.equal(absentBuild.status, 404);
    const queuedDeployment = await request(context, '/platform-api/deployments', { method: 'POST', json: { confirm: true, environmentId: 'test-env', productId: productRow.id, version: productRow.version, buildId: queuedBuild }, cookie });
    assert.equal(queuedDeployment.status, 409);
    assert.equal(context.store.deployments().length, 0);
    context.store.db.prepare("UPDATE builds SET state='SUCCEEDED',artifact_digest=? WHERE id=?").run('bad-digest', queuedBuild);
    assert.equal((await request(context, '/platform-api/deployments', { method: 'POST', json: { confirm: true, environmentId: 'test-env', productId: productRow.id, version: productRow.version, buildId: queuedBuild }, cookie })).status, 409);
    context.store.db.prepare("UPDATE builds SET state='SUCCEEDED',artifact_digest=? WHERE id=?").run('b'.repeat(64), queuedBuild);
    const otherProduct = context.store.products().find(row => row.id !== productRow.id);
    assert.ok(otherProduct, 'source importer provides a second product fixture');
    const otherBuild = context.store.requestBuild(otherProduct.id, otherProduct.version, 'system:test-suite').id;
    context.store.db.prepare("UPDATE builds SET state='SUCCEEDED',artifact_digest=? WHERE id=?").run('c'.repeat(64), otherBuild);
    const mismatchedBuild = await request(context, '/platform-api/deployments', { method: 'POST', json: { confirm: true, environmentId: 'test-env', productId: productRow.id, version: productRow.version, buildId: otherBuild }, cookie });
    assert.equal(mismatchedBuild.status, 409);
    const admitted = await request(context, '/platform-api/deployments', { method: 'POST', json: { confirm: true, environmentId: 'test-env', productId: productRow.id, version: productRow.version, buildId: queuedBuild }, cookie });
    assert.equal(admitted.status, 202, admitted.text);
    assert.equal(body(admitted).state, 'REQUESTED');
    assert.equal(context.store.deployments().length, 1);

    const overview = body(await request(context, '/platform-api/overview', { cookie }));
    const buildExecutor = overview.capabilities.find(item => item.id === 'build-executor');
    const deployController = overview.capabilities.find(item => item.id === 'deployment-controller');
    const modelServing = overview.capabilities.find(item => item.id === 'model-serving');
    assert.equal(buildExecutor.status, 'not-attached');
    assert.equal(deployController.status, 'not-attached');
    assert.equal(modelServing.status, 'not-attached');
    assert.ok(overview.audit.every(item => item.actorId));
});

test('overview is read-only and restart re-imports equal source versions without new audit or timestamp writes', async t => {
    const context = await start(t);
    const { cookie } = await pair(context);
    const first = body(await request(context, '/platform-api/overview', { cookie }));
    const productTimestamp = context.store.db.prepare('SELECT updated FROM products ORDER BY id LIMIT 1').get().updated;
    const auditCount = context.store.auditLog(500).length;
    const second = body(await request(context, '/platform-api/overview', { cookie }));
    assert.deepEqual(second, first);
    assert.equal(context.store.db.prepare('SELECT updated FROM products ORDER BY id LIMIT 1').get().updated, productTimestamp);
    assert.equal(context.store.auditLog(500).length, auditCount);
    await context.restart();
    assert.equal((await request(context, '/platform-api/overview', { cookie })).status, 401);
    const { cookie: restartedCookie } = await pair(context);
    const afterRestart = body(await request(context, '/platform-api/overview', { cookie: restartedCookie }));
    assert.equal(context.store.auditLog(500).length, auditCount);
    assert.equal(context.store.db.prepare('SELECT updated FROM products ORDER BY id LIMIT 1').get().updated, productTimestamp);
    assert.deepEqual(afterRestart.products, first.products);
});

test('a body is rejected if its exact authenticated session expires while the stream is pending', async t => {
    let time = 1000;
    let markRead;
    let destroyStream = () => {};
    const bodyRead = new Promise(resolve => { markRead = resolve; });
    t.after(() => destroyStream());
    const context = await start(t, { now: () => time, sessionTtlMs: 100, onProtectedBodyRead: () => markRead() });
    const { cookie } = await pair(context);
    const url = new URL(context.operator.url);
    let finishRequest;
    const outcome = new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: url.port, path: '/platform-api/environments', method: 'POST', headers: { host: url.host, origin: context.operator.url, cookie, 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'close' } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        destroyStream = () => req.destroy();
        req.write('{"confirm":true,"environment":');
        finishRequest = () => req.end('{"id":"late-env","label":"Late","kind":"test","target":"local"}}');
    });
    outcome.catch(() => {});
    await withTimeout(bodyRead, 'authenticated request body hook');
    time += 101;
    finishRequest();
    const response = await outcome;
    assert.equal(response.status, 401, response.text);
    assert.equal(context.store.environments().some(row => row.id === 'late-env'), false);
});

test('a body is rejected if that session logs out before streaming completes', async t => {
    let markRead;
    let destroyStream = () => {};
    const bodyRead = new Promise(resolve => { markRead = resolve; });
    t.after(() => destroyStream());
    const context = await start(t, { onProtectedBodyRead: () => markRead() });
    const { cookie } = await pair(context);
    const url = new URL(context.operator.url);
    let finishRequest;
    const pending = new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: url.port, path: '/platform-api/environments', method: 'POST', headers: { host: url.host, origin: context.operator.url, cookie, 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'close' } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        destroyStream = () => req.destroy();
        req.write('{"confirm":true,"environment":');
        finishRequest = () => req.end('{"id":"logged-out-env","label":"Late","kind":"test","target":"local"}}');
    });
    pending.catch(() => {});
    await withTimeout(bodyRead, 'authenticated request body hook');
    const logout = await request(context, '/platform-api/logout', { method: 'POST', json: {}, cookie });
    assert.equal(logout.status, 200, logout.text);
    finishRequest();
    const response = await pending;
    assert.equal(response.status, 401, response.text);
    assert.equal(context.store.environments().some(row => row.id === 'logged-out-env'), false);
});

test('canonical compose preview, immutable save, and idempotent local build admission stay behind the paired session', async t => {
    let context;
    const workerCalls = [];
    const worker = {
        async admit(product, plan, requestKey, actorId, beforeMutation) {
            beforeMutation?.();
            const admitted = context.store.admitBuild(product.id, product.version, requestKey, {
                product, plan, sourceFingerprint: 'a'.repeat(64), toolchainDigest: 'b'.repeat(64), recipeVersion: 'test-fixed-runner-v1'
            }, actorId);
            workerCalls.push({ productId: product.id, version: product.version, requestKey, actorId });
            return admitted;
        }
    };
    context = await start(t, { worker });
    const { cookie } = await pair(context);
    const initialAudit = context.store.auditLog(500).length;
    const draft = { id: 'studio-api-product', title: 'Studio API product', selected: ['service-desk'], layout: 'sidebar', version: '1.0.0' };
    const preview = await request(context, '/platform-api/products/compose', { method: 'POST', json: { draft }, cookie });
    assert.equal(preview.status, 200, preview.text);
    const previewValue = body(preview);
    assert.equal(previewValue.status, 'VALIDATED_DEFINITION_NOT_RUNNING');
    assert.equal(previewValue.product.id, draft.id);
    assert.deepEqual(previewValue.product.modules, [{ id: 'service-desk', version: '0.2.1' }]);
    assert.equal(previewValue.plan.product.version, draft.version);
    assert.equal(context.store.product(draft.id, draft.version), undefined);
    assert.equal(context.store.auditLog(500).length, initialAudit);
    for (const malformed of [
        { ...draft, version: ['1.0.0'] },
        { ...draft, selected: ['service-desk', { toString: 'service-desk' }] },
        { ...draft, choices: { 'service-desk:desk.requests.create.v2': ['configured-desk-http'] } }
    ]) assert.equal((await request(context, '/platform-api/products/compose', { method: 'POST', json: { draft: malformed }, cookie })).status, 400);

    assert.equal((await request(context, '/platform-api/products', { method: 'POST', json: { confirm: false, product: previewValue.product }, cookie })).status, 400);
    const saved = await request(context, '/platform-api/products', { method: 'POST', json: { confirm: true, product: previewValue.product }, cookie });
    assert.equal(saved.status, 201, saved.text);
    assert.equal(body(saved).product.id, draft.id);
    const afterSaveAudit = context.store.auditLog(500).length;
    assert.equal(afterSaveAudit, initialAudit + 1);
    assert.equal((await request(context, '/platform-api/products', { method: 'POST', json: { confirm: true, product: previewValue.product }, cookie })).status, 201);
    assert.equal(context.store.auditLog(500).length, afterSaveAudit);
    assert.equal((await request(context, '/platform-api/products', { method: 'POST', json: { confirm: true, product: { ...previewValue.product, version: ['1.0.0'] } }, cookie })).status, 400);
    assert.equal((await request(context, '/platform-api/products', { method: 'POST', json: { confirm: true, product: { ...previewValue.product, title: 'Conflicting immutable version' } }, cookie })).status, 409);

    const requestBody = { confirm: true, productId: draft.id, version: draft.version, requestKey: 'studio-api-build-request-1' };
    const admitted = await request(context, '/platform-api/builds', { method: 'POST', json: requestBody, cookie });
    assert.equal(admitted.status, 202, admitted.text);
    const admittedValue = body(admitted);
    assert.equal(admittedValue.state, 'QUEUED');
    assert.equal(admittedValue.productId, draft.id);
    assert.equal('claimToken' in admittedValue, false);
    assert.equal('snapshotRef' in admittedValue, false);
    const duplicate = await request(context, '/platform-api/builds', { method: 'POST', json: requestBody, cookie });
    assert.equal(duplicate.status, 202, duplicate.text);
    assert.equal(body(duplicate).id, admittedValue.id);
    assert.equal(context.store.builds().filter(row => row.productId === draft.id).length, 1);
    assert.equal(workerCalls.length, 2);
    assert.match(workerCalls[0].actorId, /^operator:[0-9a-f-]{36}$/);
    assert.equal((await request(context, '/platform-api/builds', { method: 'POST', json: { ...requestBody, version: ['1.0.0'] }, cookie })).status, 400);

    const cancelled = await request(context, `/platform-api/builds/${admittedValue.id}/cancel`, { method: 'POST', json: { confirm: true }, cookie });
    assert.equal(cancelled.status, 202, cancelled.text);
    assert.equal(body(cancelled).build.state, 'CANCELLED');
    assert.equal('claimToken' in body(cancelled), false);
});

test('complete ProductDefinition keeps custom reviewed bindings through exact read-only preview, immutable save and build', async t => {
    let context;
    const buildPlans=[];
    const worker={async admit(product,plan,requestKey,actorId,beforeMutation){
        beforeMutation?.();buildPlans.push(structuredClone(plan.product));
        return context.store.admitBuild(product.id,product.version,requestKey,{product,plan,sourceFingerprint:'c'.repeat(64),toolchainDigest:'d'.repeat(64),recipeVersion:'test-fixed-runner-v1'},actorId);
    }};
    context=await start(t,{worker});
    const {cookie}=await pair(context);
    const starterResponse=await request(context,'/platform-api/products/compose',{method:'POST',json:{draft:{id:'complete-definition',title:'Complete definition',selected:['handoff'],version:'3.4.0'}},cookie});
    assert.equal(starterResponse.status,200,starterResponse.text);
    const original=body(starterResponse).product;
    const definition={...original,description:'Preserve this product-owned description.',bindings:original.bindings.map((binding,index)=>({...binding,instanceId:index===0?'customer-owned-desk':`customer-owned-connection-${index}`}))};
    const auditBefore=context.store.auditLog(500).length;
    assert.equal((await request(context,`/platform-api/products/${definition.id}/${definition.version}`)).status,401);
    const previewResponse=await request(context,'/platform-api/products/preview',{method:'POST',json:{product:definition},cookie});
    assert.equal(previewResponse.status,200,previewResponse.text);
    const preview=body(previewResponse);
    assert.equal(preview.valid,true,JSON.stringify(preview.diagnostics));
    assert.equal(preview.product.description,definition.description);
    assert.deepEqual(preview.product.bindings.map(binding=>binding.instanceId),definition.bindings.map(binding=>binding.instanceId));
    assert.equal(preview.status,'VALIDATED_DEFINITION_NOT_RUNNING');
    assert.equal(context.store.product(definition.id,definition.version),undefined);
    assert.equal(context.store.auditLog(500).length,auditBefore);

    const unsupported={...definition,bindings:definition.bindings.map(binding=>({...binding,mode:'shell-command'}))};
    const invalid=body(await request(context,'/platform-api/products/preview',{method:'POST',json:{product:unsupported},cookie}));
    assert.equal(invalid.valid,false);
    assert.ok(invalid.diagnostics.length>0);
    assert.equal(unsupported.bindings[0].mode,'shell-command','preview diagnostics must not rewrite imported source data');
    assert.equal((await request(context,'/platform-api/products',{method:'POST',json:{confirm:true,product:unsupported},cookie})).status,400);

    const saved=await request(context,'/platform-api/products',{method:'POST',json:{confirm:true,product:preview.product},cookie});
    assert.equal(saved.status,201,saved.text);
    const loaded=await request(context,`/platform-api/products/${definition.id}/${definition.version}`,{cookie});
    assert.equal(loaded.status,200,loaded.text);
    assert.deepEqual(body(loaded).product,preview.product);
    const auditAfter=context.store.auditLog(500).length;
    assert.equal((await request(context,'/platform-api/products',{method:'POST',json:{confirm:true,product:preview.product},cookie})).status,201);
    assert.equal(context.store.auditLog(500).length,auditAfter,'equal version saves are idempotent');
    assert.equal((await request(context,'/platform-api/products',{method:'POST',json:{confirm:true,product:{...preview.product,title:'Conflicting same version'}},cookie})).status,409);

    const nextVersion={...preview.product,version:'3.4.1'};
    assert.equal((await request(context,'/platform-api/products',{method:'POST',json:{confirm:true,product:nextVersion},cookie})).status,201);
    for(const [version,requestKey] of [[definition.version,'complete-definition-build-original-001'],[nextVersion.version,'complete-definition-build-next-001']]){
      const admitted=await request(context,'/platform-api/builds',{method:'POST',json:{confirm:true,productId:definition.id,version,requestKey},cookie});
      assert.equal(admitted.status,202,admitted.text);
    }
    assert.deepEqual(buildPlans[0],preview.product);
    assert.deepEqual(buildPlans[1],nextVersion);
});

test('logout during awaited worker admission rejects the original request before queue mutation', async t => {
    const started=deferred(),continuePreparation=deferred();
    let context;
    const worker={async admit(product,plan,requestKey,actorId,beforeMutation){
        started.resolve();
        await continuePreparation.promise;
        beforeMutation?.();
        return context.store.admitBuild(product.id,product.version,requestKey,{product,plan,sourceFingerprint:'a'.repeat(64),toolchainDigest:'b'.repeat(64),recipeVersion:'test-fixed-runner-v1'},actorId);
    }};
    context=await start(t,{worker});
    const {cookie}=await pair(context);
    const product=context.store.products()[0];
    const baseline=context.store.builds().length;
    const pending=request(context,'/platform-api/builds',{method:'POST',json:{confirm:true,productId:product.id,version:product.version,requestKey:'logout-during-worker-admit-001'},cookie});
    try{
        await withTimeout(started.promise,'worker admission start');
        assert.equal((await request(context,'/platform-api/logout',{method:'POST',json:{},cookie})).status,200);
        continuePreparation.resolve();
        const response=await withTimeout(pending,'worker admission response');
        assert.equal(response.status,401,response.text);
        assert.equal(context.store.builds().length,baseline,'no queued record is inserted after the original session is logged out');
    }finally{continuePreparation.resolve();}
});

test('logout during awaited result inspection returns 401 and accepted work remains independent of the session', async t => {
    const inspectStarted=deferred(),finishInspect=deferred();
    let context;
    const worker={
        async admit(product,plan,requestKey,actorId,beforeMutation){beforeMutation?.();return context.store.admitBuild(product.id,product.version,requestKey,{product,plan,sourceFingerprint:'a'.repeat(64),toolchainDigest:'b'.repeat(64),recipeVersion:'test-fixed-runner-v1'},actorId);},
        async inspect(id){inspectStarted.resolve();await finishInspect.promise;return {build:context.store.build(id),snapshot:{status:'VERIFIED_LOCAL_EXPORT'}};}
    };
    context=await start(t,{worker});
    const {cookie}=await pair(context);
    const product=context.store.products()[0];
    const admission=await request(context,'/platform-api/builds',{method:'POST',json:{confirm:true,productId:product.id,version:product.version,requestKey:'http-logout-inspect-accepted-work'},cookie});
    assert.equal(admission.status,202,admission.text);
    const accepted=body(admission).id;
    const pending=request(context,`/platform-api/builds/${accepted}/result`,{cookie});
    try{
        await withTimeout(inspectStarted.promise,'result inspection start');
        assert.equal((await request(context,'/platform-api/logout',{method:'POST',json:{},cookie})).status,200);
        finishInspect.resolve();
        const response=await withTimeout(pending,'result inspection response');
        assert.equal(response.status,401,response.text,'the exact session is rechecked after inspection finishes');
        assert.equal(context.store.build(accepted).state,'QUEUED','logging out does not cancel already accepted work');
    }finally{finishInspect.resolve();}
});
