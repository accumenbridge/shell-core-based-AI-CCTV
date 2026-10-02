import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';

const digest=letter=>letter.repeat(64);
const id=n=>`123e4567-e89b-42d3-a456-${String(n).padStart(12,'0')}`;
const instanceId=`runtime-${id(1)}`;
const source={instanceId,operationId:id(2),ownerId:id(3),ownerToken:'a'.repeat(48),actorId:'system:upgrade-source',
  originatingActorId:'system:source-origin',requestKey:'upgrade-start-key-001',productId:'combined',version:'0.2.3',artifactDigest:digest('a'),
  profileDigest:digest('b'),configDigest:digest('c'),adapterDigest:digest('d'),toolchainDigest:digest('e'),recipeDigest:digest('f'),
  workerRequired:true,executionBytes:1024};

function seedRelease(store,release,buildNo){
  const buildId=id(buildNo),now=Date.now();
  store.db.prepare("INSERT INTO builds(id,product_id,version,state,artifact_digest,created,updated) VALUES(?,?,?,'SUCCEEDED',?,?,?)")
    .run(buildId,release.productId,release.version,release.artifactDigest,now,now);
  store.db.prepare(`INSERT INTO artifacts(digest,build_id,snapshot_id,product_id,version,input_digest,release_digest,snapshot_digest,
    object_ref,size_bytes,file_count,originating_actor_id,registering_actor_id,manifest_json,entries_json,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(release.artifactDigest,buildId,id(buildNo+1),release.productId,release.version,digest('1'),digest('2'),
      release.artifactDigest,`objects/${release.artifactDigest}`,1024,1,release.originatingActorId,'system:artifact-register','{}','[]',now);
  store.db.prepare(`INSERT INTO artifact_releases(product_id,version,artifact_digest,build_id,input_digest,release_digest,
    originating_actor_id,registering_actor_id,promoting_actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(release.productId,release.version,release.artifactDigest,buildId,digest('1'),digest('2'),release.originatingActorId,
      'system:artifact-register','system:artifact-promote',now);
}
function startAndStop(store){
  const authorize=()=>true;seedRelease(store,{productId:source.productId,version:source.version,artifactDigest:source.artifactDigest,originatingActorId:source.originatingActorId},4);
  store.beginManagedRuntimeStart(source,authorize);
  store.markManagedRuntimeStarting(source.instanceId,source.operationId,source.ownerToken,authorize);
  store.authorizeManagedRuntimeStage(source.instanceId,source.operationId,source.ownerToken,'ENROLLMENT',authorize);
  store.authorizeManagedRuntimeStage(source.instanceId,source.operationId,source.ownerToken,'LAUNCH',authorize);
  store.recordManagedRuntimeReadiness(source.instanceId,source.operationId,source.ownerToken,{apiReady:true,workerAttached:true,port:43123});
  store.publishManagedRuntimeRunning(source.instanceId,source.operationId,source.ownerToken,authorize);
  const stop=store.requestManagedRuntimeStop({instanceId:source.instanceId,operationId:source.operationId,commandId:id(8),actorId:'system:upgrade-stop',
    requestKey:'upgrade-stop-key-001',ownerToken:source.ownerToken},authorize);
  store.completeManagedRuntimeStop(source.instanceId,source.operationId,source.ownerToken,{emptyObserved:true,helperClosed:true,executionClean:true});
  return {stopCommandId:stop.command.id,attempt:store.managedRuntimeAttempt(source.instanceId,source.operationId),generation:store.managedRuntimeGenerations(source.instanceId)[0]};
}
function backupSource(store,owner){
  const row={digest:digest('9'),instanceId:source.instanceId,attemptId:owner.attempt.id,attempt:owner.attempt.attempt,generationId:owner.generation.id,
    commandId:owner.attempt.commandId,productId:source.productId,version:source.version,artifactDigest:source.artifactDigest,
    originatingActorId:source.originatingActorId,profileDigest:source.profileDigest,configDigest:source.configDigest,adapterDigest:source.adapterDigest,
    toolchainDigest:source.toolchainDigest,recipeDigest:source.recipeDigest,capturedAt:Date.now(),sizeBytes:1024,fileCount:1,
    manifest:'{}',entries:'[]',creatingActorId:'system:backup-create'};
  store.db.prepare(`INSERT INTO runtime_backups(digest,instance_id,attempt_id,attempt_no,generation_id,command_id,product_id,version,artifact_digest,
    originating_actor_id,profile_digest,config_digest,adapter_digest,toolchain_digest,recipe_digest,captured_at,size_bytes,file_count,manifest_json,
    entries_json,creating_actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.digest,row.instanceId,row.attemptId,row.attempt,row.generationId,row.commandId,row.productId,row.version,row.artifactDigest,
      row.originatingActorId,row.profileDigest,row.configDigest,row.adapterDigest,row.toolchainDigest,row.recipeDigest,row.capturedAt,row.sizeBytes,
      row.fileCount,row.manifest,row.entries,row.creatingActorId,row.capturedAt);
  return row;
}
function upgradeIntent(owner,backup){return {operationId:id(20),ownerId:id(21),ownerToken:'c'.repeat(48),actorId:'system:upgrade-operator',requestKey:'upgrade-request-key-001',
  instanceId:source.instanceId,sourceGenerationId:owner.generation.id,sourceAttemptId:owner.attempt.id,sourceAttempt:owner.attempt.attempt,
  sourceCommandId:owner.attempt.commandId,targetVersion:'0.2.4',targetArtifactDigest:digest('8'),targetProfileDigest:digest('b'),targetConfigDigest:digest('7'),
  targetAdapterDigest:digest('d'),targetToolchainDigest:digest('e'),targetRecipeDigest:digest('f'),targetWorkerRequired:true,
  sourceBackupDigest:backup.digest,reservedBytes:4096};}
function upgradeSlot(store){
  const row=store.db.prepare('SELECT operation_id AS operationId,instance_id AS instanceId,state,reserved_bytes AS reservedBytes FROM runtime_upgrade_slot WHERE singleton=1').get();
  return {...row,occupied:row.operationId!==null};
}

test('schema 5 backfills immutable runtime generations and backup lineage without relabeling the stopped command',()=>{
  const directory=mkdtempSync(join(tmpdir(),'qb-upgrade-schema6-')),database=join(directory,'state.sqlite');let store=new ControlPlaneStore(database);
  try{
    const owner=startAndStop(store),backup=backupSource(store,owner),instanceBefore=store.managedRuntime(source.instanceId);
    const commandBefore=store.managedRuntimeCommand(owner.attempt.commandId);
    store.db.exec(`DROP TABLE runtime_upgrade_operations; DROP TABLE runtime_upgrade_slot; DROP TABLE runtime_generations;
      ALTER TABLE runtime_instances DROP COLUMN active_generation_id; ALTER TABLE runtime_attempts DROP COLUMN generation_id;
      ALTER TABLE runtime_commands DROP COLUMN generation_id; ALTER TABLE runtime_recovery_operations DROP COLUMN generation_id;
      ALTER TABLE runtime_backups DROP COLUMN generation_id; PRAGMA user_version=5`);
    store.close();store=undefined;
    store=new ControlPlaneStore(database);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,6);
    const generations=store.managedRuntimeGenerations(source.instanceId),instanceAfter=store.managedRuntime(source.instanceId);
    assert.equal(generations.length,1);assert.equal(generations[0].id,`generation:${source.instanceId}:1`);
    assert.equal(generations[0].productId,source.productId);
    assert.equal(generations[0].version,source.version);
    assert.equal(generations[0].artifactDigest,source.artifactDigest);
    assert.equal(instanceAfter.activeGenerationId,generations[0].id);
    assert.equal(instanceAfter.attempts[0].generationId,generations[0].id);
    assert.equal(store.runtimeRecoveryBackup(backup.digest).generationId,generations[0].id);
    const commandAfter=store.managedRuntimeCommand(owner.attempt.commandId);
    assert.equal(commandAfter.id,commandBefore.id);assert.equal(commandAfter.actorId,commandBefore.actorId);
    assert.equal(commandAfter.state,commandBefore.state);assert.equal(store.managedRuntime(source.instanceId).state,instanceBefore.state);
  }finally{try{store?.close();}finally{rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
});

test('a confirmed upgrade cuts over only after exact native and publication facts and replays its original identity',()=>{
  const store=new ControlPlaneStore(':memory:');
  try{
    const owner=startAndStop(store),backup=backupSource(store,owner),target={productId:source.productId,version:'0.2.4',artifactDigest:digest('8'),originatingActorId:'system:target-origin'};
    seedRelease(store,target,30);
    const intent=upgradeIntent(owner,backup),authorize=()=>true;
    const admitted=store.beginManagedRuntimeUpgrade(intent,()=>({backupBytes:1024,stagingBytes:0,objectCount:1,entryCount:1}),authorize);
    assert.equal(admitted.operation.state,'PREPARING');assert.equal(upgradeSlot(store).occupied,true);
    assert.throws(()=>store.beginManagedRuntimeRestart({instanceId:source.instanceId,operationId:id(40),ownerId:id(41),ownerToken:'d'.repeat(48),
      actorId:'system:upgrade-restart',requestKey:'upgrade-restart-key-001',profileDigest:source.profileDigest,configDigest:source.configDigest,
      adapterDigest:source.adapterDigest,toolchainDigest:source.toolchainDigest,recipeDigest:source.recipeDigest,executionBytes:1024},authorize),/upgrade slot/);
    store.markManagedRuntimeUpgradeDispatch(intent.operationId,intent.ownerToken,authorize);
    store.recordManagedRuntimeUpgradeDriver(intent.operationId,intent.ownerToken,{empty:true,closed:true,stagingClean:true});
    store.markManagedRuntimeUpgradePublishing(intent.operationId,intent.ownerToken,authorize);
    store.recordManagedRuntimeUpgradePublisher(intent.operationId,intent.ownerToken,{moved:true,resultObserved:true,closed:true});
    store.recordManagedRuntimeUpgradeVerified(intent.operationId,intent.ownerToken);
    const result=store.completeManagedRuntimeUpgrade(intent.operationId,intent.ownerToken,authorize);
    assert.equal(result.state,'SUCCEEDED');assert.equal(result.physicalState,'CLEAN');
    const runtime=store.managedRuntime(source.instanceId),generations=store.managedRuntimeGenerations(source.instanceId);
    assert.equal(runtime.state,'UPGRADE_READY');assert.equal(runtime.version,target.version);assert.equal(runtime.artifactDigest,target.artifactDigest);
    assert.equal(runtime.originatingActorId,target.originatingActorId);assert.equal(runtime.activeGenerationId,generations[1].id);
    assert.equal(generations[0].originatingActorId,source.originatingActorId);assert.equal(generations[1].originatingActorId,target.originatingActorId);
    assert.equal(runtime.attempts[0].generationId,generations[0].id);assert.equal(runtime.attempts[0].generation.version,source.version);
    assert.equal(store.managedRuntimeCommand(owner.attempt.commandId).generationId,generations[0].id);
    assert.equal(upgradeSlot(store).occupied,false);
    const audit=store.auditLog(500).find(row=>row.action==='runtime.upgrade.completed');assert.equal(audit.actorId,intent.actorId);
    const replay=store.beginManagedRuntimeUpgrade({...intent,operationId:id(22),ownerId:id(23),ownerToken:'e'.repeat(48)},
      ()=>{throw new Error('replay must not observe capacity');},authorize);
    assert.equal(replay.reused,true);assert.equal(replay.operationId,intent.operationId);assert.equal(replay.ownerToken,null);
    assert.throws(()=>store.beginManagedRuntimeUpgrade({...intent,targetVersion:'0.2.5'},()=>({backupBytes:0,stagingBytes:0,objectCount:0,entryCount:0}),authorize),/another immutable operation/);
    assert.equal(store.managedRuntimeGenerations(source.instanceId).length,2);assert.equal(upgradeSlot(store).occupied,false);
  }finally{store.close();}
});
