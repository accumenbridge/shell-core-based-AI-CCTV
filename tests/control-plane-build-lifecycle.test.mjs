import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { LocalBuildWorker } from '../apps/control-plane/dist/build-worker.js';

const actor = 'system:lifecycle-test';
const product = { id: 'lifecycle-product', version: '1.0.0', platformAbi: 'quadbridge.module.v1', title: 'Lifecycle product', description: '', layout: 'sidebar', modules: [], bindings: [] };
const frozen = { product, plan: { product, modules: [], bindings: [], requiresWorker: false }, sourceFingerprint: 'a'.repeat(64), toolchainDigest: 'b'.repeat(64), recipeVersion: 'lifecycle-test-v1' };
const digest = 'c'.repeat(64);
async function stores(t) {
    const dir = await mkdtemp(join(tmpdir(), 'qb-build-lifecycle-'));
    const opened = new Set();
    t.after(async () => {
        const failures=[];
        for (const store of [...opened].reverse()) { try { store.close(); } catch (error) { failures.push(error); } }
        try { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { failures.push(error); }
        if(failures.length)throw new AggregateError(failures,'Failed to close and remove build lifecycle fixture');
    });
    const open = () => { const store = new ControlPlaneStore(join(dir, 'state.sqlite')); opened.add(store); return store; };
    const close = store => { if (opened.has(store)) { store.close(); opened.delete(store); } };
    const first = open(), second = open();
    first.putProduct(product, actor);
    return { dir, first, second, open, close };
}
function admit(store, requestKey) { return store.admitBuild(product.id, product.version, requestKey, frozen, actor); }
test('the build worker refuses a frozen claim from an incompatible fingerprint recipe before copying or launching tools', async t => {
    const { dir, first } = await stores(t);
    const admitted = admit(first, 'lifecycle-old-recipe-0001');
    const claim = first.claimBuild(randomUUID(), 10000);
    assert.equal(claim?.id, admitted.id);
    assert.equal(claim.input.recipeVersion, 'lifecycle-test-v1');
    const worker = new LocalBuildWorker({root:dir,store:first,snapshot:{modules:[],solutions:[],sourcePlans:[],sourceFingerprint:'not-used'}},
        'a'.repeat(64),'b'.repeat(64),{kind:'fixture-host',sha256:'',version:process.version,policy:'not-applicable'});
    await worker.execute(claim);
    const settled = first.build(admitted.id);
    assert.equal(settled.state, 'FAILED');
    assert.equal(settled.failureCode, 'BUILD_RECIPE_UNSUPPORTED');
    assert.equal(settled.cleanupState, 'CLEAN');
    assert.equal(settled.attemptDetail.errorCode, 'BUILD_RECIPE_UNSUPPORTED');
});

function waitForOutput(child, expected, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Child did not emit ${expected}`)); }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (output.includes(expected)) { clearTimeout(timer); resolve(output); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Lock holder exited ${code}: ${output}`)); } });
    });
}

test('two stores fence actors and stale claims, reclaim at most twice, and retain expired cancellation as UNKNOWN', async t => {
    const { first, second, open, close } = await stores(t);
    const legacy = first.requestBuild(product.id,product.version,actor);
    const admitted = admit(first, 'lifecycle-retry-key-0001');
    const ownerOne = randomUUID(), ownerTwo = randomUUID();
    const firstClaim = first.claimBuild(ownerOne, 1000);
    assert.equal(firstClaim?.id,admitted.id,'the worker claims only rows with a frozen input record');
    assert.equal(first.build(legacy.id).state,'QUEUED');
    assert.equal(first.build(legacy.id).inputDigest,null);
    assert.equal(first.build(legacy.id).attempt,0);
    assert.equal(second.claimBuild(ownerTwo, 1000), undefined, 'a second database connection cannot claim active work');

    const forged = { ...firstClaim, actorId: 'system:forged-agent' };
    assert.equal(first.renewBuild(forged, 1000), false);
    assert.equal(first.updateBuildPhase(forged, 'forged phase'), false);
    assert.equal(first.appendBuildAttemptLog(forged, 'forged log'), false);
    assert.equal(first.failBuild(forged, { code: 'FORGED', message: 'no', cleanupState: 'CLEAN' }), false);
    assert.equal(first.requestBuildStop(forged, 'no'), false);
    assert.throws(() => first.completeBuild(forged, { snapshotRef: `snapshots/${randomUUID()}`, snapshotDigest: digest, releaseDigest: digest, cleanupState: 'CLEAN' }), /no longer owns publication/);
    assert.equal(first.build(admitted.id).state, 'RUNNING');
    assert.equal(first.auditLog(500).some(row => row.actorId === 'system:forged-agent'), false);

    first.db.prepare('UPDATE builds SET lease_until=0 WHERE id=?').run(admitted.id);
    const secondClaim = second.claimBuild(ownerTwo, 1000);
    assert.equal(secondClaim?.attempt, 2);
    assert.throws(() => first.completeBuild(firstClaim, { snapshotRef: `snapshots/${randomUUID()}`, snapshotDigest: digest, releaseDigest: digest, cleanupState: 'CLEAN' }), /no longer owns publication/);
    assert.equal(first.build(admitted.id).state, 'RUNNING');
    second.db.prepare('UPDATE builds SET lease_until=0 WHERE id=?').run(admitted.id);
    assert.equal(first.claimBuild(ownerOne, 1000), undefined);
    assert.equal(first.build(admitted.id).state, 'FAILED');
    assert.equal(first.build(admitted.id).attempt, 2);
    assert.equal(first.build(admitted.id).cleanupState, 'UNKNOWN');
    assert.equal(first.claimBuild(ownerOne, 1000), undefined, 'an exhausted request never receives a third attempt');
    assert.equal(first.build(legacy.id).state,'QUEUED','legacy admission-only work remains unmodified and non-executable');
    assert.equal(first.build(legacy.id).attempt,0);

    const cancellation = admit(first, 'lifecycle-cancel-key-0001');
    const cancelClaim = first.claimBuild(ownerOne, 1000);
    assert.equal(cancelClaim?.id, cancellation.id);
    assert.equal(first.cancelBuild(cancellation.id, actor).build.state, 'CANCEL_REQUESTED');
    first.db.prepare('UPDATE builds SET lease_until=0 WHERE id=?').run(cancellation.id);
    close(first); close(second);
    const restarted = open();
    assert.equal(restarted.claimBuild(ownerTwo, 1000), undefined);
    const pending = restarted.build(cancellation.id);
    assert.equal(pending.state, 'CANCEL_REQUESTED');
    assert.equal(pending.cleanupState, 'UNKNOWN');
    assert.match(pending.phase, /process state unknown/);
    assert.equal(pending.attempt, 1, 'an expired uncertain cancellation is never retried');
});

test('cleanup failure records UNKNOWN and cannot publish a clean cancellation', async t => {
    const { first, second } = await stores(t);
    const admitted=admit(first,'lifecycle-cleanup-unknown-0001');
    const claim=first.claimBuild(randomUUID(),1000);
    assert.equal(claim?.id,admitted.id);
    assert.equal(first.requestBuildStop(claim,'Injected cleanup failure'),true);
    assert.equal(first.finishBuildCancellation(claim,'UNKNOWN','Injected cleanup failure'),true);
    assert.equal(first.build(admitted.id).state,'CANCEL_REQUESTED');
    assert.equal(first.build(admitted.id).cleanupState,'UNKNOWN');
    assert.equal(first.finishBuildCancellation(claim,'CLEAN'),false,'a prior UNKNOWN cleanup result cannot be rewritten as clean');
    assert.equal(second.claimBuild(randomUUID(),1000),undefined,'uncertain cancellation cannot be treated as clean or replaced');
});

test('build request keys are idempotent for the same actor/input and conflict on changed input', async t => {
    const { first } = await stores(t);
    const requestKey='lifecycle-idempotency-scope-0001';
    const initial=admit(first,requestKey);
    assert.equal(admit(first,requestKey).id,initial.id);
    const changed={...frozen,sourceFingerprint:'d'.repeat(64)};
    assert.throws(()=>first.admitBuild(product.id,product.version,requestKey,changed,actor),/already used with different frozen input/);
    const anotherActor=first.admitBuild(product.id,product.version,requestKey,frozen,'system:another-operator');
    assert.notEqual(anotherActor.id,initial.id,'the request key namespace is actor-scoped');
    const rows=first.builds();
    assert.equal(rows.length,2);
    assert.equal(rows.some(row=>Object.hasOwn(row,'requestKey')),false,'public build records do not expose the private request key');
});

test('terminal publication binds the claim to its persisted frozen product, version and input digests', async t => {
    const { first } = await stores(t);
    const admitted=admit(first,'lifecycle-frozen-publication-0001');
    const claim=first.claimBuild(randomUUID(),10000);
    assert.equal(claim?.id,admitted.id);
    const result=()=>({snapshotRef:`snapshots/${randomUUID()}`,snapshotDigest:digest,releaseDigest:digest,cleanupState:'CLEAN'});
    const before=first.auditLog(500).filter(row=>row.action==='build.succeeded').length;
    assert.throws(()=>first.completeBuild({...claim,inputDigest:'d'.repeat(64)},result()),/no longer owns publication/);
    assert.throws(()=>first.completeBuild({...claim,productId:'another-product'},result()),/no longer owns publication/);
    assert.throws(()=>first.completeBuild({...claim,version:'2.0.0'},result()),/no longer owns publication/);
    assert.throws(()=>first.completeBuild({...claim,input:{...claim.input,product:{...claim.input.product,title:'substituted'}}},result()),/no longer owns publication/);
    assert.equal(first.build(admitted.id).state,'RUNNING');
    assert.equal(first.auditLog(500).filter(row=>row.action==='build.succeeded').length,before,'forged frozen identities append no success audit');
    assert.equal(first.completeBuild(claim,result()).state,'SUCCEEDED','the original persisted identity remains publishable');
});

test('terminal publication rechecks lease time after waiting for another SQLite writer', async t => {
    const { dir, first } = await stores(t);
    const admitted = admit(first, 'lifecycle-lock-key-0001');
    const claim = first.claimBuild(randomUUID(), 1000);
    assert.ok(claim);
    first.db.exec('PRAGMA busy_timeout=4000');
    const databasePath = JSON.stringify(join(dir, 'state.sqlite'));
    const source = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${databasePath},{timeout:4000});db.exec('BEGIN IMMEDIATE');console.log('LOCKED');setTimeout(()=>{db.exec('COMMIT');db.close();console.log('RELEASED')},1500);`;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    t.after(() => { if (holder.exitCode === null) holder.kill(); });
    const exited = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lock holder exited ${code}`))); });
    await waitForOutput(holder, 'LOCKED');
    assert.throws(() => first.completeBuild(claim, { snapshotRef: `snapshots/${randomUUID()}`, snapshotDigest: digest, releaseDigest: digest, cleanupState: 'CLEAN' }), /no longer owns publication/);
    await exited;
    assert.equal(first.build(admitted.id).state, 'RUNNING', 'an expired lease never publishes success after lock release');
});
