import { ControlPlaneStore } from '../../packages/control-plane/dist/index.js';
import { LocalArtifactStore } from '../../apps/control-plane/dist/artifact-store.js';
import { ManagedRuntimeManager } from '../../apps/control-plane/dist/runtime-manager.js';

const [root,databasePath,instanceId,expectedOperationId]=process.argv.slice(2);
let store,artifacts,runtimes,report;

async function denial(operation){
  try{await operation();return 'ADMITTED';}
  catch(error){return typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)?error.code:'ERROR';}
}

async function main(){
  if(typeof root!=='string'||typeof databasePath!=='string'||typeof instanceId!=='string'||typeof expectedOperationId!=='string')throw new Error('invalid fixed observer inputs');
  store=new ControlPlaneStore(databasePath);
  artifacts=await LocalArtifactStore.create(root,store);
  runtimes=ManagedRuntimeManager.create(root,store,artifacts);
  const beforeSlot=store.managedRuntimeSlot();
  const beforeOwner=store.db.prepare('SELECT instance_id AS instanceId,operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get();
  const beforeCommands=store.db.prepare('SELECT COUNT(*) AS count FROM runtime_commands').get().count;
  const beforeAudit=store.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  const detail=runtimes.detail(instanceId);
  if(!detail)throw new Error('expected retained runtime record was missing');
  const startCode=await denial(()=>runtimes.start({productId:detail.productId,version:detail.version,requestKey:'runtime-observer-start-0001'},
    'system:runtime-observer',()=>undefined));
  const stopCode=await denial(()=>runtimes.stop({instanceId,requestKey:'runtime-observer-stop-0001'},'system:runtime-observer',()=>undefined));
  const restartCode=await denial(()=>runtimes.restart({instanceId,requestKey:'runtime-observer-restart-0001'},'system:runtime-observer',()=>undefined));
  const afterSlot=store.managedRuntimeSlot();
  const afterOwner=store.db.prepare('SELECT instance_id AS instanceId,operation_id AS operationId FROM runtime_physical_slot WHERE singleton=1').get();
  const afterCommands=store.db.prepare('SELECT COUNT(*) AS count FROM runtime_commands').get().count;
  const afterAudit=store.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  report={state:detail.state,attempt:detail.currentAttempt,processObservation:detail.processObservation,hasUrl:typeof detail.url==='string',
    exactOperationId:detail.attempts.find(row=>row.attempt===detail.currentAttempt)?.id===expectedOperationId,
    startCode,stopCode,restartCode,slotUnchanged:beforeSlot.instanceId===afterSlot.instanceId&&beforeSlot.state===afterSlot.state&&beforeSlot.reservedBytes===afterSlot.reservedBytes&&
      beforeOwner.instanceId===afterOwner.instanceId&&beforeOwner.operationId===afterOwner.operationId,
    commandsUnchanged:beforeCommands===afterCommands,auditUnchanged:beforeAudit===afterAudit};
}

try{
  await main();
  await runtimes?.close();
  await artifacts?.close();
  store?.close();
  process.stdout.write(`OBSERVED:${JSON.stringify(report)}\n`);
}catch{
  try{await runtimes?.close();}catch{}
  try{await artifacts?.close();}catch{}
  try{store?.close();}catch{}
  process.stdout.write('OBSERVER_FAILED\n');
  process.exitCode=2;
}
