import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_ID = /^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,47}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const HASH = /^[a-f0-9]{64}$/;
const EVENT_LIMIT = 4096;
const EVENT_STREAM_LIMIT = 64 * 1024;
const GATE_LIMIT = 4096;
const ROLE_READY_LIMIT_MS = 30_000;
const MINIMAL_ENV_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'];
let eventBytes = 0;
let privateLogBytes = 0;
let privateLogFailed = false;
let eventFd;
let failureOccurred=false;
let canonical;
let identity;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function physicalFile(path) {
  const full = resolve(path), info = lstatSync(full);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase()) fail('RUNTIME_CONFIG_INVALID');
  return full;
}

function physicalDirectory(path) {
  const full = resolve(path), info = lstatSync(full);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase()) fail('RUNTIME_CONFIG_INVALID');
  return full;
}

function readPrivateBytes(path, limit = 1024 * 1024) {
  const full = physicalFile(path), beforePath = lstatSync(full);
  if (beforePath.size < 1 || beforePath.size > limit) fail('RUNTIME_PRIVATE_INPUT_INVALID');
  const fd=openSync(full,'r');
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size!==beforePath.size||before.dev!==beforePath.dev||before.ino!==beforePath.ino)fail('RUNTIME_PRIVATE_INPUT_CHANGED');
    const bytes=Buffer.alloc(before.size);
    let offset=0;
    while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(count<1)fail('RUNTIME_PRIVATE_INPUT_CHANGED');offset+=count;}
    const probe=Buffer.alloc(1),extra=readSync(fd,probe,0,1,before.size),after=fstatSync(fd),afterPath=lstatSync(full);
    if(extra!==0||after.size!==before.size||after.dev!==before.dev||after.ino!==before.ino||afterPath.size!==before.size||afterPath.dev!==before.dev||afterPath.ino!==before.ino||
       realpathSync(full).toLowerCase()!==full.toLowerCase())fail('RUNTIME_PRIVATE_INPUT_CHANGED');
    return bytes;
  }finally{closeSync(fd);}
}

function readPrivateJson(path, limit = 1024 * 1024) {
  const bytes=readPrivateBytes(path,limit);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('RUNTIME_PRIVATE_INPUT_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RUNTIME_PRIVATE_INPUT_INVALID');
  return value;
}

function exactKeys(value, names) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...names].sort().join('\0');
}

function readConfig() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config' || typeof args[1] !== 'string' || args[1].length > 240) fail('RUNTIME_ARGUMENTS_INVALID');
  const configPath = physicalFile(args[1]), operationRoot = dirname(configPath);
  const value = readPrivateJson(configPath, 1024 * 1024);
  const hasNativeProfile = Object.hasOwn(value,'nativeApiProfile');
  const keys = ['schema','attemptId','operationId','nonce','instanceId','productId','version','artifactDigest','profileDigest','configDigest','adapterDigest','enrollmentDigest','freshEnrollment',
    'projectRoot','snapshotRoot','dataDirectory','nodePath','nodeVersion','nodeDigest','workerRequired','planDigest',...(hasNativeProfile?['nativeApiProfile','nativeApiIdentity']:[])];
  if (!exactKeys(value, keys)) fail('RUNTIME_CONFIG_INVALID');
  const projectRoot = physicalDirectory(value.projectRoot), expectedOperationRoot = resolve(projectRoot,'.local','platform-runtime-executions',value.instanceId,value.operationId);
  if (value.schema !== 'quadbridge.managed-runtime-supervisor.v1' || !UUID.test(value.attemptId) || value.operationId !== value.attemptId ||
      typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(value.nonce) || !RUNTIME_ID.test(value.instanceId) ||
      !PRODUCT_ID.test(value.productId) || !VERSION.test(value.version) || !HASH.test(value.artifactDigest) || !HASH.test(value.profileDigest) ||
      !HASH.test(value.configDigest) || !HASH.test(value.adapterDigest) || !HASH.test(value.enrollmentDigest) || typeof value.freshEnrollment!=='boolean' || typeof value.workerRequired !== 'boolean' ||
      !isAbsoluteString(value.nodePath) || typeof value.nodeVersion !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(value.nodeVersion) || !HASH.test(value.nodeDigest) || !HASH.test(value.planDigest) ||
      hasNativeProfile&&(value.nativeApiProfile!=='local-native-forwarded-v1'||!value.nativeApiIdentity||typeof value.nativeApiIdentity!=='object'||Array.isArray(value.nativeApiIdentity)) ||
      resolve(operationRoot) !== expectedOperationRoot || configPath !== resolve(operationRoot,'supervisor-config.json') ||
      ![resolve(operationRoot,'snapshot'),resolve(operationRoot,'s')].includes(resolve(value.snapshotRoot)) ||
      resolve(value.dataDirectory) !== resolve(projectRoot,'.local','platform-runtime-data',value.instanceId,value.artifactDigest)) fail('RUNTIME_CONFIG_INVALID');
  physicalDirectory(operationRoot);
  const snapshotRoot = physicalDirectory(value.snapshotRoot), dataDirectory = physicalDirectory(value.dataDirectory);
  const roleConfigPath=physicalFile(join(dataDirectory,'runtime-config.json'));
  const runtimeConfig=readPrivateJson(roleConfigPath,1024*1024);
  if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig) || runtimeConfig.instanceId !== value.instanceId ||
      typeof runtimeConfig.dataDirectory!=='string' || resolve(runtimeConfig.dataDirectory) !== dataDirectory || !Array.isArray(runtimeConfig.principals) || runtimeConfig.principals.length !== 0 ||
      !runtimeConfig.connections || typeof runtimeConfig.connections !== 'object' || Array.isArray(runtimeConfig.connections)) fail('RUNTIME_CONFIG_INVALID');
  if ((runtimeConfig.nativeApiProfile ?? undefined) !== (value.nativeApiProfile ?? undefined)) fail('RUNTIME_CONFIG_INVALID');
  if (hasNativeProfile) {
    const native = value.nativeApiIdentity;
    if (!exactKeys(native,['productId','productVersion','instanceId','planDigest','modules']) || native.productId!==value.productId || native.productVersion!==value.version ||
        native.instanceId!==value.instanceId || native.planDigest!==value.planDigest || !Array.isArray(native.modules) || native.modules.length>64 ||
        native.modules.some(item=>!exactKeys(item,['id','version'])||typeof item.id!=='string'||!PRODUCT_ID.test(item.id)||typeof item.version!=='string'||!VERSION.test(item.version)))
      fail('RUNTIME_CONFIG_INVALID');
  }
  for (const connection of Object.values(runtimeConfig.connections)) {
    if (!connection || typeof connection !== 'object' || connection.mode !== 'local' || connection.destinationProduct !== value.productId ||
        connection.destinationInstance !== value.instanceId || 'baseUrl' in connection || 'serviceToken' in connection) fail('RUNTIME_CONFIG_INVALID');
  }
  if (process.execPath.toLowerCase() !== resolve(value.nodePath).toLowerCase() || process.version !== value.nodeVersion || sha256(readFileSync(value.nodePath)) !== value.nodeDigest)
    fail('RUNTIME_TOOLCHAIN_CHANGED');
  for(const name of ['events.ndjson','enroll-gate.json','launch-gate.json'])if(existsSync(join(operationRoot,name)))fail('RUNTIME_OPERATION_REUSED');
  const runtimeEntry = physicalFile(join(snapshotRoot,'apps','runtime','dist','index.js'));
  const localAccessEntry = physicalFile(join(snapshotRoot,'packages','local-access','dist','index.js'));
  const contractsEntry = physicalFile(join(snapshotRoot,'packages','contracts','dist','index.js'));
  return { ...value, configPath, operationRoot, projectRoot, snapshotRoot, dataDirectory, roleConfigPath, runtimeEntry, localAccessEntry, contractsEntry, runtimeConfig };
}

function isAbsoluteString(value) { return typeof value === 'string' && value.length > 0 && /^[a-z]:[\\/]/i.test(value); }

function emit(type, fields = {}) {
  const value = JSON.stringify({ schema:'quadbridge.managed-runtime-event.v1',type,...fields,attemptId:identity.attemptId,operationId:identity.operationId,
    instanceId:identity.instanceId,nonce:identity.nonce,bindingDigest:identity.enrollmentDigest });
  const bytes = Buffer.byteLength(value) + 1;
  if (!eventFd || bytes > EVENT_LIMIT || eventBytes + bytes > EVENT_STREAM_LIMIT) fail('RUNTIME_EVENT_LIMIT');
  eventBytes += bytes;
  const line=Buffer.from(value+'\n');
  let offset=0;
  while(offset<line.length){const written=writeSync(eventFd,line,offset,line.length-offset);if(written<1)fail('RUNTIME_EVENT_WRITE_FAILED');offset+=written;}
}

function privateLog(chunk) {
  if(privateLogFailed)return false;
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk),remaining=1024*1024-privateLogBytes;
  if(remaining<=0){privateLogFailed=true;supervisorFailure('PRIVATE_LOG_LIMIT');return false;}
  const part=bytes.subarray(0,remaining);
  try{process.stdout.write(part);privateLogBytes+=part.length;}catch{privateLogFailed=true;supervisorFailure('PRIVATE_LOG_WRITE_FAILED');return false;}
  if(part.length!==bytes.length){privateLogFailed=true;supervisorFailure('PRIVATE_LOG_LIMIT');return false;}
  return true;
}

function sanitizedCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'RUNTIME_ROLE_FAILED';
}

function exactEnrollmentIntent(value) {
  return exactKeys(value,['schema','state','instanceId','productId','version','artifactDigest','profileDigest','configDigest','adapterDigest','dataDirectory','seedDigest']) &&
    value.schema === 'quadbridge.managed-runtime-enrollment.v1' && value.state === 'INTENT' &&
    value.instanceId === identity.instanceId && value.productId === identity.productId && value.version === identity.version && value.artifactDigest === identity.artifactDigest &&
    value.profileDigest === identity.profileDigest && value.configDigest === identity.configDigest && value.adapterDigest === identity.adapterDigest &&
    value.dataDirectory === identity.dataDirectory && HASH.test(value.seedDigest);
}

async function loadEnrollmentInputs() {
  const imported = await import(pathToFileURL(identity.contractsEntry).href);
  if (typeof imported.canonical !== 'function') fail('RUNTIME_ENROLLMENT_INVALID');
  canonical = imported.canonical;
  const intentPath = join(identity.dataDirectory,'enrollment-intent.json');
  const privatePath = join(identity.dataDirectory,'enrollment-private.json');
  const intent = readPrivateJson(intentPath,256*1024);
  if (!exactEnrollmentIntent(intent)) fail('RUNTIME_ENROLLMENT_INVALID');
  const intentDigest=sha256(canonical(intent));
  const privateData = readPrivateJson(privatePath,1024*1024);
  if (!exactKeys(privateData,['principals']) || !Array.isArray(privateData.principals) || privateData.principals.length < 1 ||
      privateData.principals.length > 32 || sha256(canonical(privateData.principals)) !== intent.seedDigest) fail('RUNTIME_ENROLLMENT_INVALID');
  const credentials=readPrivateJson(join(identity.dataDirectory,'credentials.json'),256*1024);
  const expectedCredentials={schema:'quadbridge.managed-runtime-credentials.v1',principals:privateData.principals.filter(seed=>seed.password).map(seed=>({id:seed.id,password:seed.password}))};
  if(!exactKeys(credentials,['schema','principals'])||canonical(credentials)!==canonical(expectedCredentials))fail('RUNTIME_ENROLLMENT_INVALID');
  const configDigest = sha256(canonical({config:identity.runtimeConfig,seedDigest:intent.seedDigest,profileDigest:intent.profileDigest}));
  if (configDigest !== intent.configDigest) fail('RUNTIME_ENROLLMENT_INVALID');
  if(configDigest!==identity.configDigest||intentDigest!==identity.enrollmentDigest)fail('RUNTIME_ENROLLMENT_INVALID');
  identity.runtimeConfigCanonical=canonical(identity.runtimeConfig);
  return { intent, intentDigest, seeds:privateData.principals };
}

function assertRuntimeConfigBound(enrollment){
  const bytes=readPrivateBytes(identity.roleConfigPath,1024*1024),current=JSON.parse(bytes.toString('utf8'));
  if(bytes.toString('utf8')!==identity.runtimeConfigCanonical)fail('RUNTIME_CONFIG_CHANGED');
  if(!current||typeof current!=='object'||Array.isArray(current)||current.instanceId!==identity.instanceId||!Array.isArray(current.principals)||current.principals.length!==0||
     sha256(canonical({config:current,seedDigest:enrollment.intent.seedDigest,profileDigest:identity.profileDigest}))!==identity.configDigest)
    fail('RUNTIME_CONFIG_CHANGED');
}

function assertAccessSidecarsSafe(accessPath,mustBeAbsent=false) {
  for (const suffix of ['-wal','-shm','-journal']) {
    const path=accessPath+suffix;
    if(!existsSync(path))continue;
    if(mustBeAbsent)fail('RUNTIME_REPAIR_REQUIRED');
    const info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||realpathSync(path).toLowerCase()!==path.toLowerCase())fail('RUNTIME_REPAIR_REQUIRED');
  }
}

function verifyAccessBinding(accessPath) {
  const accessInfo = lstatSync(accessPath);
  if (!accessInfo.isFile() || accessInfo.isSymbolicLink() || realpathSync(accessPath).toLowerCase() !== accessPath.toLowerCase()) fail('RUNTIME_REPAIR_REQUIRED');
  const db = new DatabaseSync(accessPath,{readOnly:true,timeout:1000});
  try {
    const rows = db.prepare('SELECT product,instance FROM instance_binding').all();
    if (rows.length !== 1 || rows[0].product !== identity.productId || rows[0].instance !== identity.instanceId) fail('RUNTIME_REPAIR_REQUIRED');
  } finally { db.close(); }
}

function verifySeededAccess(access, seeds) {
  const db = access.store.db;
  const binding = db.prepare('SELECT product,instance FROM instance_binding').all();
  if (binding.length !== 1 || binding[0].product !== identity.productId || binding[0].instance !== identity.instanceId) fail('RUNTIME_ENROLLMENT_INVALID');
  const actualPrincipals = db.prepare('SELECT id,kind,active FROM principals ORDER BY id').all();
  const expectedPrincipals = seeds.map(seed => ({id:seed.id,kind:seed.serviceToken?'service':'user',active:1})).sort((a,b)=>a.id.localeCompare(b.id));
  if (canonical(actualPrincipals) !== canonical(expectedPrincipals)) fail('RUNTIME_ENROLLMENT_INVALID');
  const actualGrants = db.prepare('SELECT principal,tenant,permission FROM grants').all().map(row=>`${row.principal}\0${row.tenant}\0${row.permission}`).sort();
  const expectedGrants = seeds.flatMap(seed=>seed.grants.flatMap(grant=>grant.permissions.map(permission=>`${seed.id}\0${grant.tenantId}\0${permission}`))).sort();
  if (canonical(actualGrants) !== canonical(expectedGrants)) fail('RUNTIME_ENROLLMENT_INVALID');
  for (const seed of seeds) {
    if (seed.password) {
      const before = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
      const session = access.login(seed.id,seed.password);
      access.logout(session.token);
      if (db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count !== before) fail('RUNTIME_ENROLLMENT_INVALID');
    }
    if (seed.serviceToken) {
      const service = access.authenticate(undefined,seed.serviceToken);
      if (service.id !== seed.id || service.kind !== 'service') fail('RUNTIME_ENROLLMENT_INVALID');
    }
  }
}

function gatePath(kind){return join(identity.operationRoot,`${kind.toLowerCase()}-gate.json`);}

async function waitForGate(kind,bindingDigest,timeoutMs=30_000){
  const path=gatePath(kind),deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(existsSync(path)){
      const gate=readPrivateJson(path,GATE_LIMIT);
      if(!exactKeys(gate,['schema','kind','attemptId','operationId','instanceId','nonce','bindingDigest','decision'])||
         gate.schema!=='quadbridge.managed-runtime-gate.v1'||gate.kind!==kind||gate.attemptId!==identity.attemptId||gate.operationId!==identity.operationId||
         gate.instanceId!==identity.instanceId||gate.nonce!==identity.nonce||gate.bindingDigest!==bindingDigest||!['ALLOW','DENY'].includes(gate.decision))
        fail('RUNTIME_GATE_INVALID');
      unlinkSync(path);
      if(gate.decision!=='ALLOW')fail('RUNTIME_GATE_DENIED');
      return;
    }
    await new Promise(resolveDelay=>setTimeout(resolveDelay,50));
  }
  fail('RUNTIME_GATE_TIMEOUT');
}

async function enrollOrVerify(importedAccess, enrollment) {
  const accessPath = join(identity.dataDirectory,'access.sqlite');
  const markerPath = join(identity.dataDirectory,'enrollment-complete.json');
  const suffixes = ['','-wal','-shm','-journal'];
  if (existsSync(markerPath)) {
    const marker = readPrivateJson(markerPath,256*1024);
    if (!exactKeys(marker,['schema','state','intentDigest','instanceId','productId','version','artifactDigest','profileDigest','configDigest','adapterDigest','seedDigest','completedAt']) ||
        marker.schema !== 'quadbridge.managed-runtime-enrollment.v1' || marker.state !== 'COMPLETE' || marker.intentDigest !== enrollment.intentDigest ||
        marker.instanceId !== identity.instanceId || marker.productId !== identity.productId || marker.version !== identity.version || marker.artifactDigest !== identity.artifactDigest ||
        marker.profileDigest !== identity.profileDigest || marker.configDigest !== identity.configDigest || marker.adapterDigest !== identity.adapterDigest ||
        marker.seedDigest !== enrollment.intent.seedDigest || !Number.isSafeInteger(marker.completedAt)) fail('RUNTIME_REPAIR_REQUIRED');
    if (!existsSync(accessPath)) fail('RUNTIME_REPAIR_REQUIRED');
    assertAccessSidecarsSafe(accessPath);
    verifyAccessBinding(accessPath);
    return;
  }
  if(!identity.freshEnrollment)fail('RUNTIME_REPAIR_REQUIRED');
  if (suffixes.some(suffix=>existsSync(accessPath+suffix))) fail('RUNTIME_REPAIR_REQUIRED');
  const dir = opendirSync(identity.dataDirectory), entries=[];
  try { for (;;) { const item=dir.readSync(); if(!item)break; entries.push(item.name); if(entries.length>8)fail('RUNTIME_REPAIR_REQUIRED'); } }
  finally { dir.closeSync(); }
  if (entries.some(name=>!['enrollment-intent.json','enrollment-private.json','runtime-config.json','credentials.json'].includes(name))) fail('RUNTIME_REPAIR_REQUIRED');
  const reservationFd = openSync(accessPath,'wx');
  let access;
  try {
    const reserved=fstatSync(reservationFd),opened=lstatSync(accessPath);
    if (!reserved.isFile()||!opened.isFile()||opened.isSymbolicLink()||reserved.dev!==opened.dev||reserved.ino!==opened.ino||realpathSync(accessPath).toLowerCase()!==accessPath.toLowerCase()) fail('RUNTIME_REPAIR_REQUIRED');
    assertAccessSidecarsSafe(accessPath,true);
    access = new importedAccess.LocalAccess(accessPath,{productId:identity.productId,instanceId:identity.instanceId});
    const after=lstatSync(accessPath),held=fstatSync(reservationFd);
    if (!after.isFile()||after.isSymbolicLink()||after.dev!==reserved.dev||after.ino!==reserved.ino||held.dev!==reserved.dev||held.ino!==reserved.ino) fail('RUNTIME_REPAIR_REQUIRED');
    access.seed(enrollment.seeds);
    verifySeededAccess(access,enrollment.seeds);
  } finally {
    if (access) access.close();
    closeSync(reservationFd);
  }
  const marker={schema:'quadbridge.managed-runtime-enrollment.v1',state:'COMPLETE',intentDigest:enrollment.intentDigest,
    instanceId:identity.instanceId,productId:identity.productId,version:identity.version,artifactDigest:identity.artifactDigest,
    profileDigest:identity.profileDigest,configDigest:identity.configDigest,adapterDigest:identity.adapterDigest,
    seedDigest:enrollment.intent.seedDigest,completedAt:Date.now()};
  writeFileSync(markerPath,canonical(marker),{flag:'wx'});
  const info=lstatSync(markerPath);
  if (!info.isFile()||info.isSymbolicLink()||realpathSync(markerPath).toLowerCase()!==markerPath.toLowerCase()) fail('RUNTIME_REPAIR_REQUIRED');
}

function minimalEnvironment() {
  const env={NODE_ENV:'development'};
  for (const key of MINIMAL_ENV_KEYS) if (process.env[key]) env[key]=process.env[key];
  return env;
}

const children = new Map();
let intentionalClosing = false;
let failureResolve;
const failure = new Promise(resolveFailure=>{failureResolve=resolveFailure;});
let supervisorSummaryEmitted=false;
function supervisorSummary(code){
  if(supervisorSummaryEmitted)return;
  supervisorSummaryEmitted=true;
  try{emit('SUPERVISOR_FAILED',{code});}catch{/* native exit remains the failure proof */}
}
function roleFailure(role,code) {
  if (intentionalClosing||failureOccurred) return;
  failureOccurred=true;
  try { emit('ROLE_FAILED',{role,code}); } catch { /* parent still observes the native exit record */ }
  supervisorSummary(code);
  failureResolve({role,code});
}

function supervisorFailure(code){
  if(intentionalClosing||failureOccurred)return;
  failureOccurred=true;
  supervisorSummary(code);
  failureResolve({role:'supervisor',code});
}

process.stdout.on('error',()=>supervisorFailure('PRIVATE_LOG_WRITE_FAILED'));

function parseReadyLine(role,line) {
  if (line.length > EVENT_LIMIT) return undefined;
  let value;
  try { value=JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value!=='object' || Array.isArray(value) || value.role!==role || value.product!==identity.productId ||
      value.instance!==identity.instanceId || value.state!=='READY') return undefined;
  if (role==='web-backend') {
    const expectedKeys=identity.nativeApiProfile?['role','product','instance','url','nativeApiUrl','nativeApiProfile','nativeApiIdentity','state']:['role','product','instance','url','state'];
    if(Object.keys(value).sort().join('\0')!==expectedKeys.sort().join('\0'))return undefined;
    if (typeof value.url!=='string') return undefined;
    let url;
    try { url=new URL(value.url); } catch { return undefined; }
    if (url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
        !Number.isInteger(Number(url.port))||Number(url.port)<1||Number(url.port)>65535) return undefined;
    if(identity.nativeApiProfile) {
      const native=value.nativeApiUrl;
      let nativeUrl;
      try { nativeUrl=new URL(native); } catch { return undefined; }
      if (value.nativeApiProfile!==identity.nativeApiProfile || nativeUrl.protocol!=='http:' || nativeUrl.hostname!=='127.0.0.1' || nativeUrl.port!=='4350' ||
          nativeUrl.pathname!=='/' || nativeUrl.username || nativeUrl.password || nativeUrl.search || nativeUrl.hash ||
          !identity.nativeApiIdentity || !value.nativeApiIdentity ||
          value.nativeApiIdentity.productId!==identity.nativeApiIdentity.productId || value.nativeApiIdentity.productVersion!==identity.nativeApiIdentity.productVersion ||
          value.nativeApiIdentity.instanceId!==identity.nativeApiIdentity.instanceId || value.nativeApiIdentity.planDigest!==identity.nativeApiIdentity.planDigest ||
          Object.keys(value.nativeApiIdentity).sort().join('\0')!==['productId','productVersion','instanceId','planDigest','modules'].sort().join('\0') ||
          !Array.isArray(value.nativeApiIdentity.modules) || value.nativeApiIdentity.modules.length!==identity.nativeApiIdentity.modules.length ||
          value.nativeApiIdentity.modules.some((module,index)=>module?.id!==identity.nativeApiIdentity.modules[index]?.id||module?.version!==identity.nativeApiIdentity.modules[index]?.version)) return undefined;
      return {role,url:url.origin,port:Number(url.port),nativeApiUrl:nativeUrl.origin,nativeApiProfile:identity.nativeApiProfile,nativeApiIdentity:value.nativeApiIdentity};
    }
    if (Object.hasOwn(value,'nativeApiUrl')||Object.hasOwn(value,'nativeApiProfile')||Object.hasOwn(value,'nativeApiIdentity')) return undefined;
    return {role,url:url.origin,port:Number(url.port)};
  }
  return {role};
}

function startRole(role,args) {
  const child=spawn(identity.nodePath,args,{cwd:identity.snapshotRoot,env:minimalEnvironment(),stdio:['ignore','pipe','pipe'],windowsHide:true});
  children.set(role,child);
  let readyValue,settled=false,buffer='';
  const ready=new Promise((resolveReady,rejectReady)=>{
    const timer=setTimeout(()=>{if(!settled){settled=true;rejectReady(Object.assign(new Error('ROLE_READY_TIMEOUT'),{code:'ROLE_READY_TIMEOUT'}));}},30000);
    child.once('error',()=>{roleFailure(role,'ROLE_SPAWN_FAILED');if(!settled){settled=true;clearTimeout(timer);rejectReady(Object.assign(new Error('ROLE_SPAWN_FAILED'),{code:'ROLE_SPAWN_FAILED'}));}});
    child.once('close',(code,signal)=>{
      if(!intentionalClosing)roleFailure(role,'ROLE_EXITED');
      if(!settled){settled=true;clearTimeout(timer);rejectReady(Object.assign(new Error(signal?'ROLE_SIGNALLED':'ROLE_EXITED'),{code:'ROLE_EXITED'}));}
    });
    child.stdout.on('data',chunk=>{
      if(!privateLog(chunk)){roleFailure(role,'PRIVATE_LOG_LIMIT');return;}
      buffer+=chunk.toString('utf8');
      if(buffer.length>EVENT_LIMIT*2){buffer='';roleFailure(role,'ROLE_OUTPUT_LINE_TOO_LARGE');return;}
      for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);
        const parsed=parseReadyLine(role,line);if(parsed&&!settled){settled=true;clearTimeout(timer);readyValue=parsed;resolveReady(parsed);}}
    });
    child.stderr.on('data',chunk=>{if(!privateLog(chunk))roleFailure(role,'PRIVATE_LOG_LIMIT');});
  });
  return {child,ready,get value(){return readyValue;}};
}

async function requireApiReady(baseUrl,workerRequired,deadline,signal) {
  const expected=workerRequired?'SEPARATE_WORKER_REQUIRED':'NOT_REQUIRED';
  const target=`${baseUrl}/api/health`;
  while(Date.now()<deadline){
    const remaining=deadline-Date.now();
    try{
      const response=await fetch(target,{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(Math.min(1000,remaining))])});
      if(response.url!==target||response.redirected||response.status!==200||!response.body){await response.body?.cancel();continue;}
      const reader=response.body.getReader(),chunks=[];let size=0;
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16*1024){await reader.cancel();fail('API_HEALTH_FAILED');}chunks.push(Buffer.from(value));}
      const health=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
      if(health&&health.api==='READY'&&health.background===expected)return;
    }catch(error){if(signal.aborted)throw error;}
    await new Promise(resolveDelay=>setTimeout(resolveDelay,Math.min(100,Math.max(1,deadline-Date.now()))));
  }
  fail('API_HEALTH_FAILED');
}

async function withinReadiness(operation,deadline){
  const remaining=deadline-Date.now();
  if(remaining<=0)fail('ROLE_READY_TIMEOUT');
  let timerId;
  const timer=new Promise((_,reject)=>{timerId=setTimeout(()=>reject(Object.assign(new Error('ROLE_READY_TIMEOUT'),{code:'ROLE_READY_TIMEOUT'})),remaining);});
  const failed=failure.then(outcome=>{throw Object.assign(new Error(outcome.code),{code:outcome.code});});
  try{return await Promise.race([operation,timer,failed]);}finally{clearTimeout(timerId);}
}

async function stopRoleChildren() {
  intentionalClosing=true;
  const closing=[];
  for(const child of children.values()){
    closing.push(new Promise(resolveClose=>{if(child.exitCode!==null||child.signalCode!==null){resolveClose();return;}child.once('close',resolveClose);try{child.kill('SIGTERM');}catch{resolveClose();}}));
  }
  await Promise.race([Promise.all(closing),new Promise(resolveTimer=>setTimeout(resolveTimer,3000))]);
}

async function main() {
  identity=readConfig();
  eventFd=openSync(join(identity.operationRoot,'events.ndjson'),'wx');
  const enrollment=await loadEnrollmentInputs();
  const importedAccess=await import(pathToFileURL(identity.localAccessEntry).href);
  if(typeof importedAccess.LocalAccess!=='function')fail('RUNTIME_ENROLLMENT_INVALID');
  emit('ENROLL_AUTH_REQUIRED',{intentDigest:enrollment.intentDigest});
  await waitForGate('ENROLL',enrollment.intentDigest);
  await enrollOrVerify(importedAccess,enrollment);
  emit('ENROLLMENT_CLOSED',{intentDigest:enrollment.intentDigest});
  emit('LAUNCH_AUTH_REQUIRED',{configDigest:identity.configDigest});
  await waitForGate('LAUNCH',enrollment.intentDigest);

  const readinessDeadline=Date.now()+ROLE_READY_LIMIT_MS,readinessAbort=new AbortController();
  const runtimeMain=join(identity.snapshotRoot,'apps','runtime','dist','main.js');
  assertRuntimeConfigBound(enrollment);
  const web=startRole('web-backend',[runtimeMain,'--product',identity.productId,'--config',identity.roleConfigPath,'--port','0',...(identity.nativeApiProfile?['--native-api']:[])]);
  const webReady=await withinReadiness(web.ready,readinessDeadline);
  emit('ROLE_READY',{role:'web-backend',url:webReady.url,port:webReady.port,
    ...(webReady.nativeApiProfile?{nativeApiUrl:webReady.nativeApiUrl,nativeApiProfile:webReady.nativeApiProfile,nativeApiIdentity:webReady.nativeApiIdentity}:{})});
  try{await withinReadiness(requireApiReady(webReady.url,identity.workerRequired,readinessDeadline,readinessAbort.signal),readinessDeadline);}
  catch(error){readinessAbort.abort();throw error;}
  emit('API_READY',{url:webReady.url,background:identity.workerRequired?'SEPARATE_WORKER_REQUIRED':'NOT_REQUIRED'});
  if(identity.workerRequired){
    assertRuntimeConfigBound(enrollment);
    const worker=startRole('worker',[runtimeMain,'--product',identity.productId,'--config',identity.roleConfigPath,'--worker']);
    await withinReadiness(worker.ready,readinessDeadline);
    emit('ROLE_READY',{role:'worker'});
  }
  const outcome=await failure;
  return outcome.code==='OWNER_STOP_REQUESTED'?0:1;
}

let exitCode=1;
try {
  exitCode=await main();
} catch(error) {
  if(identity)supervisorSummary(sanitizedCode(error));
  exitCode=1;
} finally {
  await stopRoleChildren();
  if(eventFd!==undefined)closeSync(eventFd);
  process.exitCode=exitCode;
}
