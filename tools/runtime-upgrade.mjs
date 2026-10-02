import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, realpathSync, writeSync, fsyncSync, ftruncateSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_PATH=240,MAX_FILE=1024*1024,MAX_DEPTH=32,MAX_ENTRIES=16384,MAX_BYTES=128*1024*1024;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE=/^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE=['credentials.json','enrollment-complete.json','enrollment-intent.json','enrollment-private.json','runtime-config.json'];
const sha=value=>createHash('sha256').update(value).digest('hex');
function canonical(value){
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('invalid-canonical-value');
}
function physicalDirectory(path){
  const full=resolve(path);if(full.length>=MAX_PATH)throw new Error('upgrade-path-limit');
  const info=lstatSync(full);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new Error('upgrade-physical-directory-required');
  return full;
}
function physicalFile(path,max=MAX_FILE,mode='r'){
  const full=resolve(path),named=lstatSync(full);if(full.length>=MAX_PATH||!named.isFile()||named.isSymbolicLink()||named.size<1||named.size>max||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new Error('upgrade-physical-file-invalid');
  const fd=openSync(full,mode);try{const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==named.dev||opened.ino!==named.ino||opened.size!==named.size)throw new Error('upgrade-file-changed');return {fd,stat:opened};}catch(error){closeSync(fd);throw error;}
}
function readBounded(path,max=MAX_FILE){
  const {fd,stat}=physicalFile(path,max);try{const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new Error('upgrade-file-short-read');offset+=count;}
    const extra=readSync(fd,Buffer.alloc(1),0,1,stat.size),after=fstatSync(fd),named=lstatSync(path);if(extra||after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||named.dev!==stat.dev||named.ino!==stat.ino)throw new Error('upgrade-file-changed');return bytes;
  }finally{closeSync(fd);}
}
function parseCanonical(bytes){const value=JSON.parse(bytes.toString('utf8'));if(canonical(value)!==bytes.toString('utf8'))throw new Error('upgrade-noncanonical-metadata');return value;}
function writeExclusive(path,bytes){
  const full=resolve(path);if(full.length>=MAX_PATH)throw new Error('upgrade-path-limit');physicalDirectory(dirname(full));const fd=openSync(full,'wx');
  try{const info=fstatSync(fd);if(!info.isFile())throw new Error('upgrade-output-not-file');let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new Error('upgrade-output-short-write');offset+=count;}fsyncSync(fd);}finally{closeSync(fd);}
  const after=lstatSync(full);if(!after.isFile()||after.isSymbolicLink()||after.size!==bytes.length||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new Error('upgrade-output-changed');
}
function replaceExact(path,bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_FILE)throw new Error('upgrade-private-file-size-invalid');
  const full=resolve(path),before=physicalFile(full,MAX_FILE,'r+'),fd=before.fd,stat=before.stat;
  try{const now=fstatSync(fd);if(now.dev!==stat.dev||now.ino!==stat.ino)throw new Error('upgrade-private-file-changed');ftruncateSync(fd,0);let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)throw new Error('upgrade-private-file-short-write');offset+=count;}fsyncSync(fd);
    const after=fstatSync(fd),named=lstatSync(full);if(after.dev!==stat.dev||after.ino!==stat.ino||after.size!==bytes.length||named.dev!==stat.dev||named.ino!==stat.ino||named.size!==bytes.length)throw new Error('upgrade-private-file-changed');
  }finally{closeSync(fd);}
}
function scanFiles(root){
  const files=new Map(),directories=[],pending=[{path:root,depth:0}];let entries=0,bytes=0;
  while(pending.length){const current=pending.pop();if(current.depth>MAX_DEPTH)throw new Error('upgrade-tree-depth-limit');const dir=opendirSync(current.path,{bufferSize:32});
    try{for(;;){const item=dir.readSync();if(!item)break;if(++entries>MAX_ENTRIES)throw new Error('upgrade-tree-entry-limit');const full=join(current.path,item.name);if(full.length>=MAX_PATH)throw new Error('upgrade-path-limit');const info=lstatSync(full);
      if(info.isSymbolicLink()||realpathSync(full).toLowerCase()!==full.toLowerCase())throw new Error('upgrade-tree-link-refused');
      if(info.isDirectory()){directories.push(full);pending.push({path:full,depth:current.depth+1});}else if(info.isFile()){files.set(full,{sizeBytes:info.size,digest:sha(readBounded(full,full.endsWith('.sqlite')?32*1024*1024:MAX_FILE))});bytes+=info.size;if(bytes>MAX_BYTES)throw new Error('upgrade-tree-size-limit');}else throw new Error('upgrade-tree-special-file-refused');
    }}finally{dir.closeSync();}
  }
  return {files,directories,bytes,entries};
}
function expectedUpgradePaths(operation){
  const dataRoot=resolve(operation.dataStage),moduleIds=operation.targetModules.map(row=>row.id);
  const expected=new Set(PRIVATE.concat(['access.sqlite',...moduleIds.map(id=>`modules/${id}.sqlite`)]));
  if(expected.size>64||new Set(moduleIds).size!==moduleIds.length)throw new Error('upgrade-target-inventory-limit');
  return {dataRoot,expected,moduleIds};
}
function assertIdentity(identity,requireAttempt=false){
  if(!identity||!INSTANCE.test(identity.instanceId)||!/^[a-z][a-z0-9-]{1,47}$/.test(identity.productId)||!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(identity.version)||
    !HASH.test(identity.artifactDigest)||!/^operator:[0-9a-f-]{36}$/i.test(identity.originatingActorId)||!HASH.test(identity.profileDigest)||!HASH.test(identity.configDigest)||
    !HASH.test(identity.adapterDigest)||!HASH.test(identity.toolchainDigest)||!HASH.test(identity.recipeDigest)||typeof identity.workerRequired!=='boolean'||
    requireAttempt&&(!UUID.test(identity.attemptId)||!UUID.test(identity.commandId)||!Number.isSafeInteger(identity.attempt)||identity.attempt<1))throw new Error('upgrade-runtime-identity-invalid');
}
function assertFixedOperation(operation,operationPath){
  if(operation.schema!=='quadbridge.runtime-upgrade-operation.v1'||!UUID.test(operation.operationId))throw new Error('upgrade-operation-invalid');
  const root=physicalDirectory(operation.projectRoot),local=resolve(root,'.local');physicalDirectory(local);
  const staging=resolve(local,'platform-runtime-upgrades',operation.operationId),execution=resolve(local,'platform-runtime-upgrade-executions',operation.operationId);
  if(resolve(operation.stagingRoot)!==staging||resolve(operation.executionRoot)!==execution||resolve(dirname(operationPath))!==execution||
    resolve(operation.snapshotRoot)!==resolve(execution,'snapshot')||resolve(operation.dataStage)!==resolve(staging,'payload','data')||
    resolve(operation.sourceDataDirectory)!==resolve(local,'platform-runtime-data',operation.sourceIdentity.instanceId,operation.sourceIdentity.artifactDigest)||
    resolve(operation.targetDataDirectory)!==resolve(local,'platform-runtime-data',operation.sourceIdentity.instanceId,operation.targetIdentity.artifactDigest)||
    resolve(operation.recoveryVerifierPath)!==resolve(execution,'runtime-recovery.mjs')||resolve(operation.resultPath)!==resolve(execution,'result.json'))throw new Error('upgrade-fixed-path-mismatch');
  physicalDirectory(staging);physicalDirectory(execution);physicalDirectory(operation.snapshotRoot);physicalDirectory(operation.dataStage);physicalDirectory(operation.sourceDataDirectory);physicalDirectory(dirname(operation.targetDataDirectory));
  if(resolve(operationPath)!==resolve(execution,'operation.json'))throw new Error('upgrade-operation-path-mismatch');
  assertIdentity(operation.sourceIdentity,true);assertIdentity(operation.targetIdentity);
  if(operation.sourceIdentity.instanceId!==operation.targetIdentity.instanceId||operation.sourceIdentity.productId!==operation.targetIdentity.productId||
    operation.sourceIdentity.artifactDigest===operation.targetIdentity.artifactDigest||operation.sourceIdentity.profileDigest!==operation.targetIdentity.profileDigest||
    operation.sourceIdentity.workerRequired!==operation.targetIdentity.workerRequired||
    !HASH.test(operation.sourceEnrollmentDigest)||!HASH.test(operation.sourceAccessStateDigest)||!operation.sourceManifest||operation.sourceManifest.schema!=='quadbridge.runtime-backup.v1'||
    !Array.isArray(operation.sourceManifest.files)||!Array.isArray(operation.sourceManifest.databases)||!Array.isArray(operation.targetModules)||
    operation.targetModules.length>62||!Array.isArray(operation.sourceModules)||operation.sourceModules.length!==operation.targetModules.length||
    !HASH.test(operation.sourceBackupDigest)||sha(Buffer.from(canonical(operation.sourceManifest)))!==operation.sourceBackupDigest||
    operation.sourceManifest.identity.instanceId!==operation.sourceIdentity.instanceId||operation.sourceManifest.identity.productId!==operation.sourceIdentity.productId||
    operation.sourceManifest.identity.attemptId!==operation.sourceIdentity.attemptId||operation.sourceManifest.identity.attempt!==operation.sourceIdentity.attempt||
    operation.sourceManifest.identity.commandId!==operation.sourceIdentity.commandId||
    operation.sourceManifest.identity.version!==operation.sourceIdentity.version||operation.sourceManifest.identity.artifactDigest!==operation.sourceIdentity.artifactDigest||
    operation.sourceManifest.identity.originatingActorId!==operation.sourceIdentity.originatingActorId||operation.sourceManifest.identity.profileDigest!==operation.sourceIdentity.profileDigest||
    operation.sourceManifest.identity.configDigest!==operation.sourceIdentity.configDigest||operation.sourceManifest.identity.adapterDigest!==operation.sourceIdentity.adapterDigest||
    operation.sourceManifest.identity.toolchainDigest!==operation.sourceIdentity.toolchainDigest||operation.sourceManifest.identity.recipeDigest!==operation.sourceIdentity.recipeDigest||
    operation.sourceManifest.enrollmentDigest!==operation.sourceEnrollmentDigest)
    throw new Error('upgrade-source-target-binding-invalid');
  const sourceIds=operation.sourceModules.map(row=>row.id).sort(),targetIds=operation.targetModules.map(row=>row.id).sort();
  if(canonical(sourceIds)!==canonical(targetIds))throw new Error('upgrade-module-set-changed');
}
function assertCopiedBackup(operation,dataRoot,expected){
  const rows=new Map(operation.sourceManifest.files.map(row=>[row.path,row]));
  if(rows.size!==expected.size||operation.sourceManifest.files.length!==expected.size)throw new Error('upgrade-source-manifest-inventory-invalid');
  const tree=scanFiles(dataRoot),actual=new Map([...tree.files].map(([path,row])=>[path.slice(dataRoot.length+1).replaceAll('\\','/'),row]));
  if(actual.size!==expected.size||[...actual.keys()].some(path=>!expected.has(path)))throw new Error('upgrade-source-copy-inventory-invalid');
  for(const path of expected){const row=rows.get(path),seen=actual.get(path);if(!row||!seen||row.sizeBytes!==seen.sizeBytes||row.digest!==seen.digest)throw new Error('upgrade-source-copy-digest-invalid');}
}
function sourceEnrollment(operation,dataRoot){
  const get=name=>parseCanonical(readBounded(join(dataRoot,name)));
  const intent=get('enrollment-intent.json'),config=get('runtime-config.json'),privateData=get('enrollment-private.json'),credentials=get('credentials.json'),completion=get('enrollment-complete.json');
  const identity=operation.sourceIdentity,seeds=privateData.principals,seedDigest=sha(canonical(seeds));
  if(intent.schema!=='quadbridge.managed-runtime-enrollment.v1'||intent.state!=='INTENT'||intent.instanceId!==identity.instanceId||intent.productId!==identity.productId||
    intent.version!==identity.version||intent.artifactDigest!==identity.artifactDigest||intent.profileDigest!==identity.profileDigest||intent.configDigest!==identity.configDigest||
    intent.adapterDigest!==identity.adapterDigest||intent.dataDirectory!==operation.sourceDataDirectory||intent.seedDigest!==seedDigest||sha(canonical(intent))!==operation.sourceEnrollmentDigest||
    config.instanceId!==identity.instanceId||config.dataDirectory!==operation.sourceDataDirectory||!Array.isArray(config.principals)||config.principals.length!==0||
    sha(canonical({config,seedDigest,profileDigest:identity.profileDigest}))!==identity.configDigest||completion.schema!=='quadbridge.managed-runtime-enrollment.v1'||completion.state!=='COMPLETE'||
    completion.intentDigest!==operation.sourceEnrollmentDigest||completion.configDigest!==identity.configDigest||completion.seedDigest!==seedDigest||
    credentials.schema!=='quadbridge.managed-runtime-credentials.v1'||canonical(credentials)!==canonical({schema:'quadbridge.managed-runtime-credentials.v1',principals:seeds.filter(row=>row&&row.password).map(row=>({id:row.id,password:row.password}))}))
    throw new Error('upgrade-source-enrollment-invalid');
  return {config,seeds,seedDigest,privateDigest:sha(readBounded(join(dataRoot,'enrollment-private.json'))),credentialsDigest:sha(readBounded(join(dataRoot,'credentials.json')))};
}

async function run(){
  if(process.argv.length!==4||process.argv[2]!=='--operation')throw new Error('upgrade-fixed-arguments-invalid');
  const operationPath=resolve(process.argv[3]),operation=parseCanonical(readBounded(operationPath));assertFixedOperation(operation,operationPath);
  const {dataRoot,expected,moduleIds}=expectedUpgradePaths(operation);assertCopiedBackup(operation,dataRoot,expected);
  const source=sourceEnrollment(operation,dataRoot),target=operation.targetIdentity;
  const targetConfig={...source.config,dataDirectory:resolve(operation.targetDataDirectory),instanceId:target.instanceId,principals:[]};
  const targetConfigDigest=sha(canonical({config:targetConfig,seedDigest:source.seedDigest,profileDigest:target.profileDigest}));
  if(targetConfigDigest!==target.configDigest)throw new Error('upgrade-target-configuration-invalid');
  const sourceDatabaseRows=new Map(operation.sourceManifest.databases.map(row=>[row.path,row]));
  if(sourceDatabaseRows.size!==moduleIds.length+1)throw new Error('upgrade-source-database-set-invalid');
  const sourceMigrationRows={};for(const row of sourceDatabaseRows.values())sourceMigrationRows[row.path]=row.migrations;
  const accessBefore=operation.sourceAccessStateDigest;
  const stagedRuntimeConfig={...targetConfig,dataDirectory:dataRoot};
  const entry=join(operation.snapshotRoot,'apps','runtime','dist','index.js');readBounded(entry,8*1024*1024);
  const loaded=await import(pathToFileURL(entry).href);if(typeof loaded.createRuntime!=='function')throw new Error('upgrade-target-runtime-unavailable');
  let runtime;
  try{runtime=await loaded.createRuntime(target.productId,stagedRuntimeConfig,operation.snapshotRoot,{initializationOnly:true});}
  finally{if(runtime)await runtime.close();}
  if(sha(readBounded(join(dataRoot,'enrollment-private.json')))!==source.privateDigest||sha(readBounded(join(dataRoot,'credentials.json')))!==source.credentialsDigest)
    throw new Error('upgrade-private-credential-seed-changed');
  replaceExact(join(dataRoot,'runtime-config.json'),Buffer.from(canonical(targetConfig)));
  const targetIntent={schema:'quadbridge.managed-runtime-enrollment.v1',state:'INTENT',instanceId:target.instanceId,productId:target.productId,version:target.version,
    artifactDigest:target.artifactDigest,profileDigest:target.profileDigest,configDigest:target.configDigest,adapterDigest:target.adapterDigest,
    dataDirectory:resolve(operation.targetDataDirectory),seedDigest:source.seedDigest};
  const targetEnrollmentDigest=sha(canonical(targetIntent));
  replaceExact(join(dataRoot,'enrollment-intent.json'),Buffer.from(canonical(targetIntent)));
  const targetCompletion={schema:'quadbridge.managed-runtime-enrollment.v1',state:'COMPLETE',intentDigest:targetEnrollmentDigest,instanceId:target.instanceId,
    productId:target.productId,version:target.version,artifactDigest:target.artifactDigest,profileDigest:target.profileDigest,configDigest:target.configDigest,
    adapterDigest:target.adapterDigest,seedDigest:source.seedDigest,completedAt:Date.now()};
  replaceExact(join(dataRoot,'enrollment-complete.json'),Buffer.from(canonical(targetCompletion)));
  const verifier=await import(pathToFileURL(operation.recoveryVerifierPath).href);
  verifier.normalizeRuntimeDataDirectory(dataRoot,operation.targetModules);
  const inspected=verifier.inspectRuntimeDataDirectory(dataRoot,target,targetEnrollmentDigest,operation.targetModules,operation.targetDataDirectory);
  if(inspected.accessStateDigest!==accessBefore)throw new Error('upgrade-access-owner-state-changed');
  const targetRows=new Map(inspected.databases.map(row=>[row.path,row]));
  for(const [path,old] of sourceDatabaseRows){const next=targetRows.get(path);if(!next||!Array.isArray(old.migrations)||!Array.isArray(next.migrations)||next.migrations.length<old.migrations.length||
      canonical(next.migrations.slice(0,old.migrations.length))!==canonical(old.migrations))throw new Error('upgrade-migration-history-not-preserved');}
  const result={schema:'quadbridge.runtime-upgrade-result.v1',operationId:operation.operationId,sourceBackupDigest:operation.sourceBackupDigest,
    sourceEnrollmentDigest:operation.sourceEnrollmentDigest,targetEnrollmentDigest,seedDigest:source.seedDigest,targetIdentity:target,accessStateDigestBefore:accessBefore,
    accessStateDigestAfter:inspected.accessStateDigest,credentialDigest:source.credentialsDigest,
    privateSeedDigest:source.privateDigest,sourceMigrationRows,targetInventory:inspected.files,targetDatabases:inspected.databases,sizeBytes:inspected.sizeBytes,fileCount:inspected.fileCount};
  writeExclusive(operation.resultPath,Buffer.from(canonical(result)));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  run().catch(error=>{process.stderr.write(`Runtime upgrade stopped safely (${error?.code==='SQLITE_BUSY'?'DATABASE_BUSY':'UPGRADE_DRIVER_FAILED'}).\n`);process.exitCode=1;});
}
