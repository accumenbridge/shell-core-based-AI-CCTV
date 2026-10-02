import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlPlaneStore, MANAGED_RUNTIME_RECOVERY_LIMITS } from '../packages/control-plane/dist/index.js';

const hash = letter => letter.repeat(64);
const id = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const actor = 'system:recovery-store-test';
const origin = 'system:recovery-promoted-origin';
const identity = overrides => ({
  instanceId:`runtime-${id(1)}`, operationId:id(2), ownerId:id(3), ownerToken:'a'.repeat(48), actorId:actor,
  originatingActorId:origin, requestKey:'runtime-start-recovery-001', productId:'sample-product', version:'1.2.3',
  artifactDigest:hash('a'), profileDigest:hash('b'), configDigest:hash('c'), adapterDigest:hash('d'),
  toolchainDigest:hash('e'), recipeDigest:hash('f'), workerRequired:true, executionBytes:1024, ...overrides
});

function seedRelease(store,input) {
  const buildId=id(4),now=100;
  store.db.prepare("INSERT INTO builds(id,product_id,version,state,artifact_digest,created,updated) VALUES(?,?,?,'SUCCEEDED',?,?,?)")
    .run(buildId,input.productId,input.version,input.artifactDigest,now,now);
  store.db.prepare(`INSERT INTO artifacts(digest,build_id,snapshot_id,product_id,version,input_digest,release_digest,snapshot_digest,
    object_ref,size_bytes,file_count,originating_actor_id,registering_actor_id,manifest_json,entries_json,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.artifactDigest,buildId,id(5),input.productId,input.version,hash('1'),hash('2'),input.artifactDigest,
      `objects/${input.artifactDigest}`,1024,1,origin,actor,'{}','[]',now);
  store.db.prepare(`INSERT INTO artifact_releases(product_id,version,artifact_digest,build_id,input_digest,release_digest,
    originating_actor_id,registering_actor_id,promoting_actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(input.productId,input.version,input.artifactDigest,buildId,hash('1'),hash('2'),origin,actor,actor,now);
}

function positivelyStop(store,input) {
  const authorize=()=>true;
  store.beginManagedRuntimeStart(input,authorize);
  store.markManagedRuntimeStarting(input.instanceId,input.operationId,input.ownerToken,authorize);
  store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'ENROLLMENT',authorize);
  store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'LAUNCH',authorize);
  store.recordManagedRuntimeReadiness(input.instanceId,input.operationId,input.ownerToken,{apiReady:true,workerAttached:true,port:43123});
  store.publishManagedRuntimeRunning(input.instanceId,input.operationId,input.ownerToken,authorize);
  const stop=store.requestManagedRuntimeStop({instanceId:input.instanceId,operationId:input.operationId,commandId:id(8),actorId:'system:recovery-stop',
    requestKey:'runtime-stop-recovery-001',ownerToken:input.ownerToken},authorize);
  store.completeManagedRuntimeStop(input.instanceId,input.operationId,input.ownerToken,{emptyObserved:true,helperClosed:true,executionClean:true});
  return {startCommandId:store.managedRuntimeAttempt(input.instanceId,input.operationId).commandId,stopCommandId:stop.command.id};
}

function positivelyExitWithoutStop(store,input) {
  const authorize=()=>true;
  store.beginManagedRuntimeStart(input,authorize);
  store.markManagedRuntimeStarting(input.instanceId,input.operationId,input.ownerToken,authorize);
  store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'ENROLLMENT',authorize);
  store.authorizeManagedRuntimeStage(input.instanceId,input.operationId,input.ownerToken,'LAUNCH',authorize);
  store.recordManagedRuntimeReadiness(input.instanceId,input.operationId,input.ownerToken,{apiReady:true,workerAttached:true,port:43123});
  store.publishManagedRuntimeRunning(input.instanceId,input.operationId,input.ownerToken,authorize);
  store.settleManagedRuntimeOwnerExit(input.instanceId,input.operationId,input.ownerToken,
    {reason:'REQUIRED_ROLE_EXIT',emptyObserved:true,helperClosed:true,executionClean:true,errorCode:'REQUIRED_ROLE_EXIT'});
  return {startCommandId:store.managedRuntimeAttempt(input.instanceId,input.operationId).commandId};
}

test('schema 5 adds recovery owners and admission mutually fences the stopped runtime', () => {
  const store=new ControlPlaneStore(':memory:');
  try {
    const runtime=identity();seedRelease(store,runtime);const commands=positivelyStop(store,runtime);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,6);
    assert.equal(store.managedRuntime(runtime.instanceId).state,'STOPPED');
    assert.deepEqual(store.runtimeRecoverySlot(),{state:'EMPTY',reservedBytes:0,updated:0,occupied:false});
    const op={...runtime,operationId:id(20),ownerId:id(21),ownerToken:'b'.repeat(48),actorId:'system:backup-actor',requestKey:'runtime-backup-key-001',
      kind:'BACKUP',attemptId:runtime.operationId,attempt:1,commandId:commands.startCommandId,reservedBytes:1024};
    const capacity=()=>({backupBytes:0,stagingBytes:0,objectCount:0,entryCount:0});
    const admitted=store.beginManagedRuntimeRecovery(op,capacity,()=>true);
    assert.equal(admitted.operation.state,'PREPARING');
    assert.equal(admitted.operationId,op.operationId);
    assert.equal(store.runtimeRecoverySlot().occupied,true);
    assert.throws(()=>store.beginManagedRuntimeRestart({instanceId:runtime.instanceId,operationId:id(22),ownerId:id(23),ownerToken:'c'.repeat(48),
      actorId:'system:restart-actor',requestKey:'runtime-restart-key-001',profileDigest:runtime.profileDigest,configDigest:runtime.configDigest,
      adapterDigest:runtime.adapterDigest,toolchainDigest:runtime.toolchainDigest,recipeDigest:runtime.recipeDigest,executionBytes:1024},()=>true),/recovery slot/);
    assert.throws(()=>store.completeManagedRuntimeRecovery(op.operationId,op.ownerToken,undefined,()=>true),/lacks verified native publication facts/);
    store.markManagedRuntimeRecoveryDispatch(op.operationId,op.ownerToken,()=>true);
    store.recordManagedRuntimeRecoveryDriverClosed(op.operationId,op.ownerToken,true,true);
    store.markManagedRuntimeRecoveryPublishing(op.operationId,op.ownerToken,()=>true);
    store.recordManagedRuntimeRecoveryPublisherClosed(op.operationId,op.ownerToken,true,true,true);
    const backupDigest=hash('9'),capturedAt=Date.now();
    store.recordManagedRuntimeRecoveryVerified(op.operationId,op.ownerToken,backupDigest,capturedAt);
    const completed=store.completeManagedRuntimeRecovery(op.operationId,op.ownerToken,{digest:backupDigest,capturedAt,sizeBytes:512,fileCount:7,
      manifest:'{}',entries:'[]'},()=>true);
    assert.equal(completed.state,'SUCCEEDED');
    const publicOperation=store.runtimeRecoveryOperation(op.operationId);
    assert.equal(publicOperation.destinationPublished,true);
    assert.equal(publicOperation.destinationVerified,true);
    assert.equal(publicOperation.publisherResultObserved,true);
    assert.equal(publicOperation.publisherClosed,true);
    assert.equal(publicOperation.emptyObserved,true);
    assert.equal(publicOperation.helperClosed,true);
    assert.equal(publicOperation.stagingClean,true);
    assert.equal(store.runtimeRecoverySlot().occupied,false);
    assert.equal(store.runtimeRecoveryBackups(runtime.instanceId).length,1);
    assert.equal(store.runtimeRecoveryBackup(backupDigest).creatingActorId,'system:backup-actor');
    assert.equal(store.runtimeRecoveryOperation(op.operationId).ownerToken,undefined);
  } finally { store.close(); }
});

test('recovery accepts a positively settled required-role exit without inventing a STOP and clean pre-dispatch settlement preserves native facts', () => {
  const store=new ControlPlaneStore(':memory:');
  try {
    const runtime=identity();seedRelease(store,runtime);const commands=positivelyExitWithoutStop(store,runtime);
    assert.equal(store.managedRuntime(runtime.instanceId).state,'STOPPED');
    assert.equal(store.managedRuntimeAttempt(runtime.instanceId,runtime.operationId).stopCommandId,null);
    const op={...runtime,operationId:id(30),ownerId:id(31),ownerToken:'d'.repeat(48),actorId:'system:recovery-prep-actor',requestKey:'runtime-prep-key-001',
      kind:'BACKUP',attemptId:runtime.operationId,attempt:1,commandId:commands.startCommandId,reservedBytes:1024};
    const capacity=()=>({backupBytes:0,stagingBytes:0,objectCount:0,entryCount:0});
    store.beginManagedRuntimeRecovery(op,capacity,()=>true);
    const failed=store.settleManagedRuntimeRecoveryPreparation(op.operationId,op.ownerToken,{stagingClean:true,errorCode:'RECOVERY_PREP_FAILED'});
    assert.equal(failed.state,'FAILED');
    assert.equal(failed.physicalState,'NOT_DISPATCHED_CLEAN');
    assert.equal(failed.stagingClean,1);
    assert.equal(failed.driverEmpty,0);
    assert.equal(failed.driverClosed,0);
    assert.equal(failed.publisherResultObserved,0);
    assert.equal(failed.emptyObserved,0);
    assert.equal(failed.helperClosed,0);
    assert.equal(store.runtimeRecoverySlot().occupied,false);
    assert.throws(()=>store.settleManagedRuntimeRecoveryPreparation(op.operationId,op.ownerToken,{stagingClean:true,errorCode:'RACE'}),/cannot prove clean pre-dispatch/);
  } finally { store.close(); }
});

test('schema 4 migration preserves existing runtime and recovery slots become conservative empties', t => {
  const dir=mkdtempSync(join(tmpdir(),'q5-mig-')),path=join(dir,'cp.sqlite');let store,observer;
  t.after(()=>{try{observer?.close();}finally{try{store?.close();}finally{rmSync(dir,{recursive:true,force:true});}}});
  store=new ControlPlaneStore(path);
  const runtime=identity();seedRelease(store,runtime);positivelyStop(store,runtime);
  const before=store.db.prepare('SELECT id,state,artifact_digest,profile_digest,config_digest,current_attempt FROM runtime_instances WHERE id=?').get(runtime.instanceId);
  store.db.exec(`DROP TABLE runtime_upgrade_operations; DROP TABLE runtime_upgrade_slot; DROP TABLE runtime_generations;
    DROP TABLE runtime_backups; DROP TABLE runtime_recovery_operations; DROP TABLE runtime_recovery_slot;
    ALTER TABLE runtime_instances DROP COLUMN active_generation_id; ALTER TABLE runtime_attempts DROP COLUMN generation_id;
    ALTER TABLE runtime_commands DROP COLUMN generation_id; PRAGMA user_version=4`);store.close();store=undefined;
  observer=new DatabaseSync(path,{readOnly:true});
  assert.deepEqual(observer.prepare('SELECT id,state,artifact_digest,profile_digest,config_digest,current_attempt FROM runtime_instances WHERE id=?').get(runtime.instanceId),before);
  assert.equal(observer.prepare('PRAGMA user_version').get().user_version,4);
  observer.close();observer=undefined;
  store=new ControlPlaneStore(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,6);
  assert.deepEqual({...store.db.prepare('SELECT operation_id,owner_id,owner_token,reserved_bytes,state FROM runtime_recovery_slot WHERE singleton=1').get()},
    {operation_id:null,owner_id:null,owner_token:null,reserved_bytes:0,state:'EMPTY'});
  assert.deepEqual(store.db.prepare('SELECT id,state,artifact_digest,profile_digest,config_digest,current_attempt FROM runtime_instances WHERE id=?').get(runtime.instanceId),before);
  assert.equal(MANAGED_RUNTIME_RECOVERY_LIMITS.maxDatabaseBytes,32*1024*1024);
});
