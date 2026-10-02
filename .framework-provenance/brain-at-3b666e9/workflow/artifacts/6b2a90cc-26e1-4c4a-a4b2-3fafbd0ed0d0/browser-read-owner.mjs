import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {runtimeDataDirectory} from '../../apps/control-plane/dist/runtime-manager.js';
const dir='.local/extension-001',read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const ready=read(`${dir}/browser-01-ready.json`),closed=read(`${dir}/browser-01-closed.json`),frozen=read(`${dir}/frozen.json`),close=read(`${dir}/browser-console-original-close.json`);
if(!closed.closed||closed.fixtureId!==ready.fixtureId||close.fixtureId!==ready.fixtureId||close.observedExitCode!==0)throw Error('Actual same-fixture graceful original console close0 required');
for(const f of frozen.candidate.files)if(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw Error('Frozen source changed');
const db=new DatabaseSync(join(ready.root,'.local/control-plane.sqlite'),{readOnly:true});let evidence;
try{
 const builds=db.prepare('SELECT id,product_id AS productId,version,state,snapshot_digest AS snapshotDigest,cleanup_state AS cleanupState FROM builds').all();
 const slot=db.prepare('SELECT state,instance_id AS instanceId,operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get();
 const instances=db.prepare('SELECT id,product_id AS productId,version,artifact_digest AS artifactDigest,profile_digest AS profileDigest,config_digest AS configDigest,state,current_attempt AS attempt FROM runtime_instances').all();
 const attempts=db.prepare('SELECT id,instance_id AS instanceId,attempt_no AS attempt,state,physical_state AS physicalState,empty_observed AS emptyObserved,helper_closed AS helperClosed,execution_clean AS executionClean FROM runtime_attempts ORDER BY attempt_no').all();
 const registry=db.prepare('SELECT operation_id,reserved_bytes,reserved_files,reserved_objects FROM artifact_registry_state WHERE singleton=1').get();
 if(slot.state!=='EMPTY'||slot.operationId||instances.length!==1||instances[0].state!=='STOPPED'||attempts.length!==2||attempts.some(a=>a.state!=='STOPPED'||a.physicalState!=='EMPTY'||!a.emptyObserved||!a.helperClosed||!a.executionClean))throw Error('Actual two original positive managed closures required');
 if(builds.length!==1||builds[0].state!=='SUCCEEDED'||builds[0].cleanupState!=='CLEAN'||registry.operation_id||builds[0].snapshotDigest!==instances[0].artifactDigest||instances[0].productId!=='combined'||instances[0].version!=='0.2.3')throw Error('Exact new immutable full product build required');
 const row=db.prepare('SELECT definition FROM product_versions WHERE id=? AND version=?').get('combined','0.2.3');
 evidence={fixtureId:ready.fixtureId,candidate:frozen.candidate.digest,contractDigest:frozen.contractDigest,sourceFingerprint:ready.sourceFingerprint,studioSha:ready.studioSha,url:ready.url,observedAt:new Date().toISOString(),builds,slot,instances,attempts,registry,product:JSON.parse(row.definition),sourceUnchanged:true,consoleOriginalClose:close};
 const dataDirectory=runtimeDataDirectory(ready.root,instances[0].id,instances[0].artifactDigest);
 const desk=new DatabaseSync(join(dataDirectory,'modules','service-desk.sqlite'),{readOnly:true});try{evidence.requests=desk.prepare('SELECT id,tenant,title,state,version FROM requests ORDER BY created').all();}finally{desk.close();}
 const knowledge=new DatabaseSync(join(dataDirectory,'modules','knowledge.sqlite'),{readOnly:true});try{evidence.documents=knowledge.prepare('SELECT id,tenant,title,version,state FROM documents ORDER BY id').all();}finally{knowledge.close();}
}finally{db.close();}
fs.writeFileSync(`${dir}/browser-01-owner-evidence.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({candidate:evidence.candidate,builds:evidence.builds,attempts:evidence.attempts,documents:evidence.documents,requests:evidence.requests}));
