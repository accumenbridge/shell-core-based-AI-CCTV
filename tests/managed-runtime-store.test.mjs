import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';

const digest = (letter) => letter.repeat(64);
const id = (n) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const actor = 'system:runtime-store-test';
const origin = 'system:promoted-origin';
const request = (overrides = {}) => ({
  instanceId: `runtime-${id(1)}`,
  operationId: id(2),
  ownerId: id(3),
  ownerToken: 'a'.repeat(48),
  actorId: actor,
  originatingActorId: origin,
  requestKey: 'runtime-start-key-001',
  productId: 'sample-product',
  version: '1.2.3',
  artifactDigest: digest('a'),
  profileDigest: digest('b'),
  configDigest: digest('c'),
  adapterDigest: digest('d'),
  toolchainDigest: digest('e'),
  recipeDigest: digest('f'),
  workerRequired: true,
  executionBytes: 1024,
  ...overrides
});

function seedPromotedRelease(store) {
  const input = request();
  const buildId = id(4);
  const now = 100;
  store.db.prepare('INSERT INTO builds(id,product_id,version,state,artifact_digest,created,updated) VALUES(?,?,?,\'SUCCEEDED\',?,?,?)')
    .run(buildId, input.productId, input.version, input.artifactDigest, now, now);
  store.db.prepare(`INSERT INTO artifacts(digest,build_id,snapshot_id,product_id,version,input_digest,release_digest,snapshot_digest,
    object_ref,size_bytes,file_count,originating_actor_id,registering_actor_id,manifest_json,entries_json,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.artifactDigest, buildId, id(5), input.productId, input.version, digest('1'), digest('2'), input.artifactDigest,
      `objects/${input.artifactDigest}`, 1024, 1, origin, actor, '{}', '[]', now);
  store.db.prepare(`INSERT INTO artifact_releases(product_id,version,artifact_digest,build_id,input_digest,release_digest,
    originating_actor_id,registering_actor_id,promoting_actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(input.productId, input.version, input.artifactDigest, buildId, digest('1'), digest('2'), origin, actor, actor, now);
  return input;
}

test('managed runtime schema 4 reserves one exact promoted instance and gates RUNNING/STOPPED on lifecycle facts', () => {
  const store = new ControlPlaneStore(':memory:');
  try {
    const input = seedPromotedRelease(store);
    const authorize = () => true;
    const started = store.beginManagedRuntimeStart(input, authorize);
    assert.equal(started.command.state, 'PREPARING');
    assert.equal(started.instance.state, 'PREPARING');
    assert.equal(started.operationId, input.operationId);
    assert.equal(store.managedRuntimeSlot().occupied, true);

    const replay = store.managedRuntimeCommandForRequest(actor, input.requestKey, 'START', {
      productId: input.productId, version: input.version
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.command.id, started.command.id);
    assert.throws(() => store.managedRuntimeCommandForRequest(actor, input.requestKey, 'START', {
      productId: input.productId, version: '9.9.9'
    }), /another immutable command/);
    assert.throws(() => store.beginManagedRuntimeStart(request({ instanceId: `runtime-${id(6)}`, operationId: id(7), ownerToken: 'z'.repeat(48), requestKey: 'runtime-start-key-002' }), authorize), /non-expiring local runtime slot/);

    store.markManagedRuntimeStarting(input.instanceId, input.operationId, input.ownerToken, authorize);
    assert.throws(()=>store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'LAUNCH',authorize),/not ready/);
    store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'ENROLLMENT',authorize);
    store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'LAUNCH',authorize);
    assert.throws(() => store.publishManagedRuntimeRunning(input.instanceId, input.operationId, input.ownerToken, authorize), /readiness or authorization is incomplete/);
    store.recordManagedRuntimeReadiness(input.instanceId, input.operationId, input.ownerToken, { apiReady: true, workerAttached: false, port: 43123 });
    assert.throws(() => store.publishManagedRuntimeRunning(input.instanceId, input.operationId, input.ownerToken, authorize), /readiness or authorization is incomplete/);
    store.recordManagedRuntimeReadiness(input.instanceId, input.operationId, input.ownerToken, { apiReady: true, workerAttached: true, port: 43123 });
    assert.equal(store.publishManagedRuntimeRunning(input.instanceId, input.operationId, input.ownerToken, authorize).state, 'RUNNING');
    assert.equal(store.auditLog().find(row => row.action === 'runtime.started').actorId, actor);

    const stopCommandId = id(8);
    const stop = store.requestManagedRuntimeStop({ instanceId: input.instanceId, operationId: input.operationId, commandId: stopCommandId, actorId: 'system:stop-actor', requestKey: 'runtime-stop-key-001', ownerToken: input.ownerToken }, authorize);
    assert.equal(stop.command.state, 'STOP_REQUESTED');
    const unknown = store.completeManagedRuntimeStop(input.instanceId, input.operationId, input.ownerToken, {
      emptyObserved: true, helperClosed: true, executionClean: false, errorCode: 'CLEANUP_UNKNOWN',
      errorMessage: 'token=must-not-be-public C:\\private\\runtime'
    });
    assert.equal(unknown.state, 'UNKNOWN');
    assert.equal(store.managedRuntimeSlot().occupied, true);
    assert.equal(store.managedRuntime(input.instanceId).attempts[0].errorMessage, 'Runtime stop or owned cleanup proof is incomplete');

    const stopped = store.completeManagedRuntimeStop(input.instanceId, input.operationId, input.ownerToken, { emptyObserved: true, helperClosed: true, executionClean: true });
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(store.managedRuntimeSlot().occupied, false);

    store.beginManagedRuntimeRestart({
      instanceId: input.instanceId, operationId: id(9), ownerId: id(10), ownerToken: 'b'.repeat(48),
      actorId: 'system:restart-actor', requestKey: 'runtime-restart-key-001', profileDigest: input.profileDigest,
      configDigest: input.configDigest, adapterDigest: input.adapterDigest, toolchainDigest: input.toolchainDigest,
      recipeDigest: input.recipeDigest, executionBytes: input.executionBytes
    }, authorize);
    // Simulate a historical/corrupt token reuse to prove that callbacks are fenced by operation ID too.
    store.db.exec('DROP INDEX runtime_attempts_owner_token');
    store.db.prepare('UPDATE runtime_attempts SET owner_token=? WHERE id=?').run(input.ownerToken, id(9));
    store.db.prepare('UPDATE runtime_physical_slot SET owner_token=? WHERE operation_id=?').run(input.ownerToken, id(9));
    const beforeStaleCallback={
      state:store.managedRuntime(input.instanceId).state,
      slot:store.managedRuntimeSlot(),
      log:store.managedRuntimeEvents(input.instanceId),
      audits:store.auditLog().length
    };
    assert.throws(()=>store.markManagedRuntimeStarting(input.instanceId,input.operationId,input.ownerToken,authorize),/no longer owns dispatch/);
    assert.throws(()=>store.recordManagedRuntimeEvent(input.instanceId,input.operationId,input.ownerToken,{type:'ROLE_READY',role:'web-backend'}),/no current physical owner/);
    assert.deepEqual({state:store.managedRuntime(input.instanceId).state,slot:store.managedRuntimeSlot(),log:store.managedRuntimeEvents(input.instanceId),audits:store.auditLog().length},beforeStaleCallback);
    store.markManagedRuntimeStarting(input.instanceId, id(9), input.ownerToken, authorize);
    store.authorizeManagedRuntimeStage(input.instanceId,id(9),input.ownerToken,'ENROLLMENT',authorize);
    store.authorizeManagedRuntimeStage(input.instanceId,id(9),input.ownerToken,'LAUNCH',authorize);
    store.recordManagedRuntimeReadiness(input.instanceId, id(9), input.ownerToken, { apiReady: true, workerAttached: true, port: 43124 });
    store.publishManagedRuntimeRunning(input.instanceId, id(9), input.ownerToken, authorize);
    const runtimeAudit = store.auditLog().filter(row => row.subject === input.instanceId);
    assert.equal(runtimeAudit.find(row => row.action === 'runtime.started' && JSON.parse(row.payload).attempt === 2).actorId, 'system:restart-actor');

    for (let index = 0; index < 205; index++) store.recordManagedRuntimeEvent(input.instanceId, id(9), input.ownerToken, { type: 'ROLE_READY', role: 'web-backend' });
    assert.equal(store.managedRuntimeEvents(input.instanceId).split('\n').length, 200);
  } finally { store.close(); }
});

test('managed runtime admission and stop settlement roll back completely on denied or thenable authorization and audit faults', () => {
  const store=new ControlPlaneStore(':memory:');
  try{
    const input=seedPromotedRelease(store);
    const initialAuditCount=store.auditLog().length;
    assert.throws(()=>store.beginManagedRuntimeStart(input,()=>{throw new Error('expired session');}),/expired session/);
    assert.throws(()=>store.beginManagedRuntimeStart(input,()=>Promise.resolve(true)),/must be synchronous/);
    store.db.exec("CREATE TRIGGER fail_runtime_start BEFORE INSERT ON audit WHEN NEW.action='runtime.start.requested' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
    assert.throws(()=>store.beginManagedRuntimeStart(input,()=>true),/injected audit failure/);
    store.db.exec('DROP TRIGGER fail_runtime_start');
    assert.equal(store.managedRuntimeInstances().length,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runtime_commands').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runtime_attempts').get().n,0);
    assert.equal(store.managedRuntimeSlot().occupied,false);
    assert.equal(store.auditLog().length,initialAuditCount);

    store.beginManagedRuntimeStart(input,()=>true);
    store.markManagedRuntimeStarting(input.instanceId,input.operationId,input.ownerToken,()=>true);
    store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'ENROLLMENT',()=>true);
    store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'LAUNCH',()=>true);
    store.recordManagedRuntimeReadiness(input.instanceId,input.operationId,input.ownerToken,{apiReady:true,workerAttached:true,port:43123});
    store.publishManagedRuntimeRunning(input.instanceId,input.operationId,input.ownerToken,()=>true);
    const stopInput={instanceId:input.instanceId,operationId:input.operationId,actorId:'system:stop-actor',ownerToken:input.ownerToken};
    const beforeDeniedStop=store.auditLog().length;
    assert.throws(()=>store.requestManagedRuntimeStop({...stopInput,commandId:id(18),requestKey:'runtime-stop-denied-001'},()=>{throw new Error('session expired');}),/session expired/);
    assert.throws(()=>store.requestManagedRuntimeStop({...stopInput,commandId:id(19),requestKey:'runtime-stop-thenable-001'},()=>Promise.resolve(true)),/must be synchronous/);
    store.db.exec("CREATE TRIGGER fail_runtime_stop_request BEFORE INSERT ON audit WHEN NEW.action='runtime.stop.requested' BEGIN SELECT RAISE(ABORT,'injected stop admission audit failure'); END;");
    assert.throws(()=>store.requestManagedRuntimeStop({...stopInput,commandId:id(20),requestKey:'runtime-stop-audit-001'},()=>true),/injected stop admission audit failure/);
    store.db.exec('DROP TRIGGER fail_runtime_stop_request');
    assert.equal(store.managedRuntime(input.instanceId).state,'RUNNING');
    assert.equal(store.managedRuntimeSlot().occupied,true);
    assert.equal(store.auditLog().length,beforeDeniedStop);
    store.requestManagedRuntimeStop({instanceId:input.instanceId,operationId:input.operationId,commandId:id(8),actorId:'system:stop-actor',requestKey:'runtime-stop-key-002',ownerToken:input.ownerToken},()=>true);
    const priorAuditCount=store.auditLog().length;
    assert.throws(()=>store.completeManagedRuntimeStop(input.instanceId,input.operationId,input.ownerToken,{emptyObserved:true,helperClosed:true,executionClean:true,errorCode:'C:\\private\\secret'}),/Invalid runtime stop proof/);
    store.db.exec("CREATE TRIGGER fail_runtime_stop BEFORE INSERT ON audit WHEN NEW.action='runtime.stopped' BEGIN SELECT RAISE(ABORT,'injected stop audit failure'); END;");
    assert.throws(()=>store.completeManagedRuntimeStop(input.instanceId,input.operationId,input.ownerToken,{emptyObserved:true,helperClosed:true,executionClean:true}),/injected stop audit failure/);
    store.db.exec('DROP TRIGGER fail_runtime_stop');
    assert.equal(store.managedRuntime(input.instanceId).state,'STOP_REQUESTED');
    assert.equal(store.managedRuntime(input.instanceId).attempts[0].emptyObserved,false);
    assert.equal(store.managedRuntimeSlot().occupied,true);
    assert.equal(store.auditLog().length,priorAuditCount);
    assert.equal(store.completeManagedRuntimeStop(input.instanceId,input.operationId,input.ownerToken,{emptyObserved:true,helperClosed:true,executionClean:true}).state,'STOPPED');
  }finally{store.close();}
});

test('schema 4 refuses startup claims without exact promotion and preserves an occupied slot after uncertain process proof', () => {
  const store = new ControlPlaneStore(':memory:');
  try {
    const input = request({ artifactDigest: digest('9') });
    assert.throws(() => store.beginManagedRuntimeStart(input, () => true), /No promoted local artifact/);
    assert.equal(store.managedRuntimeInstances().length, 0);
    assert.equal(store.managedRuntimeSlot().occupied, false);

    seedPromotedRelease(store);
    const valid = request();
    store.beginManagedRuntimeStart(valid, () => true);
    store.markManagedRuntimeStarting(valid.instanceId, valid.operationId, valid.ownerToken, () => true);
    assert.throws(()=>store.recordManagedRuntimeUnknown(valid.instanceId,valid.operationId,valid.ownerToken,'C:\\secret','private','UNKNOWN'),/Invalid runtime uncertainty record/);
    store.recordManagedRuntimeUnknown(valid.instanceId, valid.operationId, valid.ownerToken, 'HELPER_LOST', 'private C:\\secret\\token=not-a-public-value', 'UNKNOWN');
    const runtime = store.managedRuntime(valid.instanceId);
    assert.equal(runtime.state, 'UNKNOWN');
    assert.equal(runtime.attempts[0].errorMessage, 'Runtime state is uncertain; native process-tree proof is required');
    assert.equal(store.managedRuntimeSlot().occupied, true);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6);
  } finally { store.close(); }
});

test('undispatched cleanup uncertainty cannot use JOB_EXIT and shutdown during STARTING fails the pending start', () => {
  const store=new ControlPlaneStore(':memory:');
  try{
    seedPromotedRelease(store);
    const first=request({instanceId:`runtime-${id(21)}`,operationId:id(22),ownerToken:'c'.repeat(48),requestKey:'runtime-prep-unknown-001',configDigest:'0'.repeat(64),preparationComplete:false});
    const pending=store.beginManagedRuntimeStart(first,()=>true);
    assert.throws(()=>store.markManagedRuntimeStarting(first.instanceId,first.operationId,first.ownerToken,()=>true),/no longer owns dispatch/);
    store.settleManagedRuntimePreparation(first.instanceId,first.operationId,first.ownerToken,{executionClean:false,repairRequired:true,errorCode:'PREP_CLEANUP'});
    assert.equal(store.managedRuntime(first.instanceId).state,'UNKNOWN');
    assert.equal(store.managedRuntime(first.instanceId).attempts[0].emptyObserved,false);
    assert.equal(store.managedRuntime(first.instanceId).attempts[0].helperClosed,false);
    assert.equal(store.managedRuntimeSlot().occupied,true);
    assert.throws(()=>store.settleManagedRuntimeOwnerExit(first.instanceId,first.operationId,first.ownerToken,
      {reason:'OPERATOR_SHUTDOWN',emptyObserved:true,helperClosed:true,executionClean:true,errorCode:'OWNER_EXIT'}),/dispatched runtime owner/);
    store.settleManagedRuntimePreparation(first.instanceId,first.operationId,first.ownerToken,{executionClean:true,repairRequired:true,errorCode:'PREP_CLEAN'});
    const repaired=store.managedRuntime(first.instanceId);
    assert.equal(repaired.state,'REPAIR_REQUIRED');
    assert.equal(repaired.attempts[0].physicalState,'NOT_DISPATCHED');
    assert.equal(repaired.attempts[0].emptyObserved,false);
    assert.equal(repaired.attempts[0].helperClosed,false);
    assert.equal(store.managedRuntimeSlot().occupied,false);
    assert.equal(store.db.prepare('SELECT state FROM runtime_commands WHERE id=?').get(pending.command.id).state,'FAILED');

    const second=request({instanceId:`runtime-${id(23)}`,operationId:id(24),ownerToken:'d'.repeat(48),requestKey:'runtime-shutdown-starting-001',configDigest:'0'.repeat(64),preparationComplete:false});
    const starting=store.beginManagedRuntimeStart(second,()=>true);
    store.completeManagedRuntimePreparation(second.instanceId,second.operationId,second.ownerToken,digest('c'),()=>true);
    store.markManagedRuntimeStarting(second.instanceId,second.operationId,second.ownerToken,()=>true);
    const stoppedDuringStart=store.settleManagedRuntimeOwnerExit(second.instanceId,second.operationId,second.ownerToken,
      {reason:'OPERATOR_SHUTDOWN',emptyObserved:true,helperClosed:true,executionClean:true,errorCode:'OWNER_SHUTDOWN'});
    assert.equal(stoppedDuringStart.state,'REPAIR_REQUIRED');
    assert.equal(store.db.prepare('SELECT state FROM runtime_commands WHERE id=?').get(starting.command.id).state,'FAILED');
    assert.equal(store.managedRuntimeSlot().occupied,false);

    const ambiguous=request({instanceId:`runtime-${id(25)}`,operationId:id(26),ownerToken:'e'.repeat(48),requestKey:'runtime-prep-unknown-002',configDigest:'0'.repeat(64),preparationComplete:false});
    store.beginManagedRuntimeStart(ambiguous,()=>true);
    store.settleManagedRuntimePreparation(ambiguous.instanceId,ambiguous.operationId,ambiguous.ownerToken,{executionClean:false,repairRequired:true,errorCode:'PREP_CLEANUP'});
    store.recordManagedRuntimeUnknown(ambiguous.instanceId,ambiguous.operationId,ambiguous.ownerToken,'PREP_IO_UNKNOWN','private detail','UNKNOWN');
    assert.throws(()=>store.settleManagedRuntimeOwnerExit(ambiguous.instanceId,ambiguous.operationId,ambiguous.ownerToken,
      {reason:'REQUIRED_ROLE_EXIT',emptyObserved:true,helperClosed:true,executionClean:true,errorCode:'OWNER_EXIT'}),/dispatched runtime owner/);
    const retained=store.managedRuntime(ambiguous.instanceId);
    assert.equal(retained.state,'UNKNOWN');
    assert.equal(retained.attempts[0].dispatchBegun,false);
    assert.equal(retained.attempts[0].emptyObserved,false);
    assert.equal(retained.attempts[0].helperClosed,false);
    assert.equal(store.managedRuntimeSlot().occupied,true);
  }finally{store.close();}
});

test('schema 4 additive dispatch migration treats legacy mutable uncertainty labels conservatively', t => {
  const directory=mkdtempSync(join(tmpdir(),'qbrt-'));
  const path=join(directory,'store.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true,maxRetries:4,retryDelay:100}));
  const store=new ControlPlaneStore(path);
  try{
    seedPromotedRelease(store);
    const input=request({instanceId:`runtime-${id(31)}`,operationId:id(32),ownerToken:'g'.repeat(48),requestKey:'runtime-migration-unknown-001'});
    store.beginManagedRuntimeStart(input,()=>true);
    store.markManagedRuntimeStarting(input.instanceId,input.operationId,input.ownerToken,()=>true);
    store.recordManagedRuntimeUnknown(input.instanceId,input.operationId,input.ownerToken,'OWNER_UNKNOWN','private','UNKNOWN');
  }finally{store.close();}
  const old=new DatabaseSync(path);
  try{
    old.exec('ALTER TABLE runtime_attempts DROP COLUMN dispatch_begun');
    old.exec('ALTER TABLE runtime_attempts DROP COLUMN enrollment_authorized');
    old.exec('ALTER TABLE runtime_attempts DROP COLUMN launch_authorized');
    old.prepare("UPDATE runtime_attempts SET physical_state='NOT_DISPATCHED' WHERE id=?").run(id(32));
  }finally{old.close();}
  const reopened=new ControlPlaneStore(path);
  try{
    const migrated=reopened.managedRuntime(`runtime-${id(31)}`);
    assert.equal(migrated.state,'UNKNOWN');
    assert.equal(migrated.attempts[0].dispatchBegun,true);
    assert.equal(reopened.managedRuntimeSlot().occupied,true);
    assert.throws(()=>reopened.markManagedRuntimeStarting(`runtime-${id(31)}`,id(32),'g'.repeat(48),()=>true),/no longer owns dispatch/);
    assert.throws(()=>reopened.settleManagedRuntimePreparation(`runtime-${id(31)}`,id(32),'g'.repeat(48),
      {executionClean:true,repairRequired:false,errorCode:'MIGRATION_CLEAN'}),/original undispatched preparation owner/);
    assert.equal(reopened.managedRuntime(`runtime-${id(31)}`).state,'UNKNOWN');
    assert.equal(reopened.managedRuntimeSlot().occupied,true);
  }finally{reopened.close();}
});
