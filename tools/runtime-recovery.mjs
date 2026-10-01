import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, writeSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 64;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES = 16384;
const MAX_DEPTH = 32;
const MAX_SCAN_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE = /^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PRIVATE_FILES = [
  'credentials.json', 'enrollment-complete.json', 'enrollment-intent.json',
  'enrollment-private.json', 'runtime-config.json'
];
const IMMUTABLE_IDENTITY_FIELDS = ['instanceId','productId','version','artifactDigest','originatingActorId','profileDigest','configDigest','adapterDigest','toolchainDigest','recipeDigest'];

const sha256 = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('invalid-json-value');
}
function assertPhysicalChain(path) {
  const full = resolve(path);
  if (full.length >= 240) throw new Error('unsupported-path-length');
  let current = full;
  for (;;) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== full) || realpathSync(current).toLowerCase() !== current.toLowerCase())
      throw new Error('unsafe-physical-path');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const info = lstatSync(full);
  if (!info.isDirectory()) throw new Error('expected-physical-directory');
  return full;
}
function assertPhysicalFile(path, maxBytes) {
  const full = resolve(path), named = lstatSync(full);
  if (full.length >= 240) throw new Error('unsupported-path-length');
  if (!named.isFile() || named.isSymbolicLink() || named.size < 1 || named.size > maxBytes || realpathSync(full).toLowerCase() !== full.toLowerCase())
    throw new Error('unsafe-or-oversized-file');
  const fd = openSync(full, 'r');
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size)
      throw new Error('file-changed-while-opening');
    return { fd, stat: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function readBounded(path, maxBytes) {
  const { fd, stat } = assertPhysicalFile(path, maxBytes);
  try {
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error('file-changed-while-reading');
      offset += count;
    }
    const probe = Buffer.alloc(1), extra = readSync(fd, probe, 0, 1, stat.size), after = fstatSync(fd), named = lstatSync(path);
    if (extra !== 0 || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || named.dev !== stat.dev || named.ino !== stat.ino)
      throw new Error('file-changed-while-reading');
    return bytes;
  } finally { closeSync(fd); }
}
function writeExclusive(path, bytes) {
  if (resolve(path).length >= 240) throw new Error('unsupported-path-length');
  const parent = assertPhysicalChain(dirname(path));
  if (resolve(dirname(path)) !== parent) throw new Error('unsafe-output-parent');
  const fd = openSync(path, 'wx');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('unsafe-output-file');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error('short-output-write');
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const after = lstatSync(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.length || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())
    throw new Error('output-file-changed');
}
function boundedTree(root) {
  const scan = { start: performance.now(), entries: 0 };
  const files = new Map(), directories = [], pending = [{ path: root, depth: 0 }];
  while (pending.length) {
    if (performance.now() - scan.start > MAX_SCAN_MS) throw new Error('metadata-scan-timeout');
    const current = pending.pop();
    if (current.depth > MAX_DEPTH) throw new Error('metadata-depth-limit');
    const directory = opendirSync(current.path, { bufferSize: 32 });
    try {
      for (;;) {
        if (performance.now() - scan.start > MAX_SCAN_MS) throw new Error('metadata-scan-timeout');
        const entry = directory.readSync();
        if (!entry) break;
        if (++scan.entries > MAX_ENTRIES) throw new Error('metadata-entry-limit');
        const path = join(current.path, entry.name), stat = lstatSync(path);
        if (stat.isSymbolicLink() || realpathSync(path).toLowerCase() !== path.toLowerCase()) throw new Error('unsafe-tree-entry');
        if (stat.isDirectory()) { directories.push(path); pending.push({ path, depth: current.depth + 1 }); }
        else if (stat.isFile()) files.set(path, stat);
        else throw new Error('special-tree-entry');
      }
    } finally { directory.closeSync(); }
  }
  if (performance.now() - scan.start > MAX_SCAN_MS) throw new Error('metadata-scan-timeout');
  return { files, directories };
}
function validateIdentity(value) {
  if (!value || typeof value !== 'object' || !INSTANCE.test(value.instanceId) || !UUID.test(value.attemptId) || !UUID.test(value.commandId) ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1 || !/^[a-z][a-z0-9-]{1,47}$/.test(value.productId) ||
      !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.version) || !HASH.test(value.artifactDigest) ||
      !/^(?:operator:[0-9a-f-]{36}|system:[a-z][a-z0-9-]{1,63})$/.test(value.originatingActorId) ||
      !HASH.test(value.profileDigest) || !HASH.test(value.configDigest) || !HASH.test(value.adapterDigest) ||
      !HASH.test(value.toolchainDigest) || !HASH.test(value.recipeDigest)) throw new Error('invalid-runtime-identity');
}
function sameImmutableIdentity(left, right) {
  return !!left && !!right && IMMUTABLE_IDENTITY_FIELDS.every(key => left[key] === right[key]);
}
function parseCanonicalJson(bytes, label) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (canonical(value) !== bytes.toString('utf8')) throw new Error(`noncanonical-${label}`);
  return value;
}
function validateEnrollment(dataDirectory, identity, expectedEnrollmentDigest) {
  const files = new Map();
  for (const name of PRIVATE_FILES) files.set(name, readBounded(join(dataDirectory, name), MAX_MANIFEST_BYTES));
  const intent = parseCanonicalJson(files.get('enrollment-intent.json'), 'intent');
  const config = parseCanonicalJson(files.get('runtime-config.json'), 'config');
  const privateData = parseCanonicalJson(files.get('enrollment-private.json'), 'private-data');
  const credentials = parseCanonicalJson(files.get('credentials.json'), 'credentials');
  const completion = parseCanonicalJson(files.get('enrollment-complete.json'), 'completion');
  const seeds = privateData.principals;
  if (intent.schema !== 'quadbridge.managed-runtime-enrollment.v1' || intent.state !== 'INTENT' || !Array.isArray(seeds) ||
      intent.instanceId !== identity.instanceId || intent.productId !== identity.productId || intent.version !== identity.version ||
      intent.artifactDigest !== identity.artifactDigest || intent.profileDigest !== identity.profileDigest || intent.configDigest !== identity.configDigest ||
      intent.adapterDigest !== identity.adapterDigest || intent.dataDirectory !== dataDirectory || !HASH.test(intent.seedDigest) ||
      sha256(canonical(seeds)) !== intent.seedDigest || sha256(canonical(intent)) !== expectedEnrollmentDigest ||
      config.instanceId !== identity.instanceId || config.dataDirectory !== dataDirectory || !Array.isArray(config.principals) || config.principals.length !== 0 ||
      sha256(canonical({ config, seedDigest: intent.seedDigest, profileDigest: identity.profileDigest })) !== identity.configDigest ||
      completion.schema !== 'quadbridge.managed-runtime-enrollment.v1' || completion.state !== 'COMPLETE' ||
      completion.intentDigest !== expectedEnrollmentDigest || completion.instanceId !== identity.instanceId ||
      completion.productId !== identity.productId || completion.version !== identity.version || completion.artifactDigest !== identity.artifactDigest ||
      completion.profileDigest !== identity.profileDigest || completion.configDigest !== identity.configDigest || completion.adapterDigest !== identity.adapterDigest ||
      completion.seedDigest !== intent.seedDigest || credentials.schema !== 'quadbridge.managed-runtime-credentials.v1' ||
      sha256(canonical(credentials)) !== sha256(canonical({ schema: 'quadbridge.managed-runtime-credentials.v1',
        principals: seeds.filter(item => item && item.password).map(item => ({ id: item.id, password: item.password })) })))
    throw new Error('enrollment-identity-mismatch');
  return { files, seedDigest: intent.seedDigest };
}
function schemaEnvelope(value,owner) {
  const schema=value?.schema;
  if(!value||value.id!==owner||!schema||!Number.isSafeInteger(schema.current)||!Number.isSafeInteger(schema.readMin)||
      !Number.isSafeInteger(schema.readMax)||schema.readMin<1||schema.readMin>schema.current||schema.current>schema.readMax)
    throw new Error('database-schema-envelope-invalid');
  return {id:owner,schema:{current:schema.current,readMin:schema.readMin,readMax:schema.readMax}};
}
function inspectDatabase(path, expectedOwner, identity, capturedAt, kind, schema) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_DATABASE_BYTES || realpathSync(path).toLowerCase() !== path.toLowerCase())
    throw new Error('database-size-or-path-limit');
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('database-integrity-failed');
    const owner = db.prepare('SELECT name FROM _owner ORDER BY name').all();
    if (owner.length !== 1 || owner[0].name !== expectedOwner) throw new Error('database-owner-mismatch');
    const migrations = db.prepare('SELECT version,digest FROM _migrations ORDER BY version').all();
    const envelope=schemaEnvelope(schema,expectedOwner);
    if (migrations.length < 1 || migrations.length > 128 || migrations.some((row,index) =>
        !Number.isSafeInteger(row.version) || row.version !== index + 1 || !HASH.test(row.digest)) ||
        migrations.at(-1).version !== envelope.schema.current || migrations.at(-1).version < envelope.schema.readMin ||
        migrations.at(-1).version > envelope.schema.readMax)
      throw new Error('database-migration-history-invalid');
    if (kind === 'access') {
      if(envelope.schema.current!==1||envelope.schema.readMin!==1||envelope.schema.readMax!==1)throw new Error('access-schema-envelope-invalid');
      const binding = db.prepare('SELECT product,instance FROM instance_binding').all();
      if (binding.length !== 1 || binding[0].product !== identity.productId || binding[0].instance !== identity.instanceId)
        throw new Error('access-instance-binding-mismatch');
      const unexpired = Number(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires>?').get(capturedAt).count);
      if (unexpired !== 0) throw new Error('active-session-prevents-backup');
    }
    return { owner: expectedOwner, schema:envelope.schema, generation:migrations.at(-1).version, migrations };
  } finally { db.close(); }
}
function normalizeOwnedBackupDatabase(path) {
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>MAX_DATABASE_BYTES||realpathSync(path).toLowerCase()!==path.toLowerCase())
    throw new Error('backup-database-size-or-path-limit');
  const db=new DatabaseSync(path,{timeout:1000});
  try{
    const row=db.prepare('PRAGMA journal_mode=DELETE').get();
    if(String(row?.journal_mode??'').toLowerCase()!=='delete')throw new Error('backup-database-journal-mode-not-standalone');
  }finally{db.close();}
  for(const suffix of ['-wal','-shm','-journal']){
    try{lstatSync(`${path}${suffix}`);throw new Error('backup-database-sidecar-remains');}
    catch(error){if(error?.code!=='ENOENT')throw error;}
  }
}
function expectedRuntimeDataRoot(projectRoot, identity) {
  return resolve(projectRoot, '.local', 'platform-runtime-data', identity.instanceId, identity.artifactDigest);
}
export function verifyBackupObject(root, digest, expectedIdentity, expectedModules = []) {
  if (!HASH.test(digest)) throw new Error('invalid-backup-digest');
  const objectRoot = join(root, 'objects', digest);
  assertPhysicalChain(objectRoot);
  const manifestBytes = readBounded(join(objectRoot, 'manifest.json'), MAX_MANIFEST_BYTES);
  const manifest = parseCanonicalJson(manifestBytes, 'manifest');
  if (sha256(manifestBytes) !== digest || manifest.schema !== 'quadbridge.runtime-backup.v1' ||
      expectedIdentity && !sameImmutableIdentity(manifest.identity, expectedIdentity)) throw new Error('backup-manifest-identity-mismatch');
  validateIdentity(manifest.identity);
  if (!Number.isSafeInteger(manifest.capturedAt) || manifest.capturedAt < 0 || manifest.sessions?.checkedAt !== manifest.capturedAt ||
      manifest.sessions?.unexpired !== 0 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length + 1 > MAX_FILES ||
      !Array.isArray(manifest.databases) || !HASH.test(manifest.enrollmentDigest) || !HASH.test(manifest.seedDigest))
    throw new Error('backup-manifest-fields-invalid');
  const files = new Map(), total = { bytes: manifestBytes.length };
  for (const row of manifest.files) {
    if (!row || typeof row.path !== 'string' || row.path.includes('\\') || row.path.startsWith('/') || row.path.length >= 240 ||
        row.path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:]/.test(part)) ||
        !HASH.test(row.digest) || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || row.sizeBytes > MAX_DATABASE_BYTES && !PRIVATE_FILES.includes(row.path))
      throw new Error('backup-file-entry-invalid');
    const bytes = readBounded(join(objectRoot, ...row.path.split('/')), row.path.endsWith('.sqlite') ? MAX_DATABASE_BYTES : MAX_MANIFEST_BYTES);
    if (bytes.length !== row.sizeBytes || sha256(bytes) !== row.digest || files.has(row.path)) throw new Error('backup-file-digest-mismatch');
    files.set(row.path, bytes); total.bytes += bytes.length;
  }
  if (total.bytes > MAX_BACKUP_BYTES) throw new Error('backup-size-limit');
  if(!Array.isArray(expectedModules)||expectedModules.length>256)throw new Error('backup-selected-modules-invalid');
  const moduleSchemas=new Map(expectedModules.map(item=>[item?.id,schemaEnvelope(item,item?.id)]));
  const expectedDatabasePaths = new Set(['access.sqlite', ...[...moduleSchemas.keys()].map(id=>`modules/${id}.sqlite`)]);
  if([...files.keys()].some(path=>path.startsWith('modules/')&&!expectedDatabasePaths.has(path)))throw new Error('backup-unselected-module-file');
  const expectedFilePaths = new Set([...PRIVATE_FILES, ...expectedDatabasePaths]);
  if (files.size !== expectedFilePaths.size || [...files.keys()].some(path => !expectedFilePaths.has(path)))
    throw new Error('backup-file-set-mismatch');
  const actual = boundedTree(objectRoot), expectedPaths = new Set(['manifest.json', ...files.keys()].map(path => resolve(objectRoot, ...path.split('/'))));
  const expectedDirectories = new Set([...files.keys()].some(path => path.startsWith('modules/')) ? [resolve(objectRoot, 'modules')] : []);
  if (actual.files.size !== expectedPaths.size || [...actual.files.keys()].some(path => !expectedPaths.has(path)) ||
      actual.directories.length !== expectedDirectories.size || actual.directories.some(path => !expectedDirectories.has(path))) throw new Error('backup-inventory-mismatch');
  const databaseRows = new Map();
  for (const row of manifest.databases) {
    if (!row || typeof row.path !== 'string' || typeof row.owner !== 'string' || databaseRows.has(row.path))
      throw new Error('backup-database-set-mismatch');
    databaseRows.set(row.path, row);
  }
  if (manifest.databases.length !== expectedDatabasePaths.size || databaseRows.size !== expectedDatabasePaths.size || [...databaseRows.keys()].some(path => !expectedDatabasePaths.has(path)))
    throw new Error('backup-database-set-mismatch');
  for (const [path, owner, kind, schema] of [['access.sqlite', 'local-access', 'access', {id:'local-access',schema:{current:1,readMin:1,readMax:1}}], ...[...expectedDatabasePaths].filter(path => path.startsWith('modules/')).map(path => {
    const id=path.slice('modules/'.length,-'.sqlite'.length);return [path,id,'module',moduleSchemas.get(id)];
  })]) {
    const expected = databaseRows.get(path);
    if (!expected || expected.owner !== owner || !Array.isArray(expected.migrations) || !Number.isSafeInteger(expected.generation))
      throw new Error('backup-database-inventory-mismatch');
    const checked = inspectDatabase(resolve(objectRoot, ...path.split('/')), owner, manifest.identity, manifest.capturedAt, kind, schema);
    if (canonical(checked.migrations) !== canonical(expected.migrations) || checked.generation !== expected.generation || canonical(checked.schema)!==canonical(expected.schema))
      throw new Error('backup-migration-history-mismatch');
  }
  for (const privatePath of PRIVATE_FILES) if (!files.has(privatePath)) throw new Error('backup-private-inventory-incomplete');
  return { objectRoot, manifest, manifestJson: manifestBytes.toString('utf8'), files, sizeBytes: total.bytes, fileCount: files.size + 1 };
}

export function verifyRestoredDataDirectory(dataDirectory,manifest,expectedIdentity,expectedModules=[]) {
  assertPhysicalChain(dataDirectory);
  if(!manifest||manifest.schema!=='quadbridge.runtime-backup.v1'||!sameImmutableIdentity(manifest.identity,expectedIdentity)||
      Date.now()<manifest.capturedAt||manifest.sessions?.checkedAt!==manifest.capturedAt||manifest.sessions?.unexpired!==0)
    throw new Error('restored-data-identity-or-clock-invalid');
  const enrollment=validateEnrollment(dataDirectory,expectedIdentity,manifest.enrollmentDigest);
  if(enrollment.seedDigest!==manifest.seedDigest)throw new Error('restored-enrollment-seed-mismatch');
  const tree=boundedTree(dataDirectory), files=new Map();
  for(const row of manifest.files){
    const path=row.path;
    if(!path||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('restored-inventory-entry-invalid');
    const full=resolve(dataDirectory,...path.split('/')),bytes=readBounded(full,path.endsWith('.sqlite')?MAX_DATABASE_BYTES:MAX_MANIFEST_BYTES);
    if(bytes.length!==row.sizeBytes||sha256(bytes)!==row.digest||files.has(path))throw new Error('restored-file-digest-mismatch');
    files.set(path,bytes);
  }
  if(tree.files.size!==files.size||[...tree.files.keys()].some(path=>!files.has(path.slice(dataDirectory.length+1).replaceAll('\\','/'))))
    throw new Error('restored-file-inventory-mismatch');
  const rows=new Map(manifest.databases.map(row=>[row.path,row]));
  const schemas=new Map(expectedModules.map(item=>[item.id,schemaEnvelope(item,item.id)]));
  const expectedPaths=new Set(['access.sqlite',...[...schemas.keys()].map(id=>`modules/${id}.sqlite`)]);
  if(rows.size!==expectedPaths.size||manifest.databases.length!==expectedPaths.size||[...rows.keys()].some(path=>!expectedPaths.has(path)))
    throw new Error('restored-database-set-mismatch');
  for(const [path,owner,kind,schema] of [['access.sqlite','local-access','access',{id:'local-access',schema:{current:1,readMin:1,readMax:1}}],...[...schemas.keys()].map(id=>[`modules/${id}.sqlite`,id,'module',schemas.get(id)])]){
    const row=rows.get(path);if(!row||row.owner!==owner)throw new Error('restored-database-owner-mismatch');
    const checked=inspectDatabase(resolve(dataDirectory,...path.split('/')),owner,expectedIdentity,manifest.capturedAt,kind,schema);
    if(canonical(checked.migrations)!==canonical(row.migrations)||checked.generation!==row.generation||canonical(checked.schema)!==canonical(row.schema))
      throw new Error('restored-database-migration-mismatch');
  }
  return {sizeBytes:manifest.files.reduce((sum,row)=>sum+row.sizeBytes,0),fileCount:manifest.files.length};
}

async function run() {
  if (process.argv.length !== 4 || process.argv[2] !== '--operation') throw new Error('invalid-driver-arguments');
  const operationPath = resolve(process.argv[3]);
  const operationBytes = readBounded(operationPath, MAX_MANIFEST_BYTES);
  const operation = parseCanonicalJson(operationBytes, 'operation');
  if (operation.schema !== 'quadbridge.runtime-recovery-operation.v1' || !UUID.test(operation.operationId) ||
      !['BACKUP', 'RESTORE'].includes(operation.kind)) throw new Error('invalid-operation-envelope');
  const root = assertPhysicalChain(operation.projectRoot), recoveryRoot = resolve(root, '.local', 'platform-runtime-backups');
  if (resolve(operation.recoveryRoot) !== recoveryRoot) throw new Error('recovery-root-mismatch');
  assertPhysicalChain(recoveryRoot);
  const operationRoot = resolve(recoveryRoot, 'staging', operation.operationId);
  if (resolve(operation.operationRoot) !== operationRoot) throw new Error('operation-root-mismatch');
  assertPhysicalChain(operationRoot);
  const payload = join(operationRoot, 'payload');
  mkdirSync(payload);
  const identity = operation.identity;
  validateIdentity(identity);
  const sourceDataDirectory = expectedRuntimeDataRoot(root, identity);
  if (operation.kind === 'BACKUP') {
    if (resolve(operation.sourceDataDirectory) !== sourceDataDirectory || !HASH.test(operation.enrollmentDigest)) throw new Error('backup-source-identity-mismatch');
    assertPhysicalChain(sourceDataDirectory);
    const enrollment = validateEnrollment(sourceDataDirectory, identity, operation.enrollmentDigest);
    const moduleIds = operation.moduleIds;
    if (!Array.isArray(moduleIds) || moduleIds.length > 256 || moduleIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(id)) || new Set(moduleIds).size !== moduleIds.length)
      throw new Error('module-owner-list-invalid');
    const sourceTree = boundedTree(sourceDataDirectory), sourceFiles = sourceTree.files;
    const expectedPaths = new Set(PRIVATE_FILES.map(name => resolve(sourceDataDirectory, name)));
    const moduleSchemas=operation.moduleSchemas;
    if(!Array.isArray(moduleSchemas)||moduleSchemas.length!==moduleIds.length||moduleSchemas.some((item,index)=>item.id!==moduleIds[index]))
      throw new Error('selected-module-schema-set-invalid');
    const databasePaths = [['access.sqlite', 'local-access', 'access', {id:'local-access',schema:{current:1,readMin:1,readMax:1}}], ...moduleSchemas.map(item => [`modules/${item.id}.sqlite`, item.id, 'module', schemaEnvelope(item,item.id)])];
    const sidecars = new Set();
    for (const [relativePath] of databasePaths) {
      const full = resolve(sourceDataDirectory, ...relativePath.split('/'));
      expectedPaths.add(full);
      sidecars.add(`${full}-wal`); sidecars.add(`${full}-shm`); sidecars.add(`${full}-journal`);
      for (const suffix of ['-wal', '-shm', '-journal']) expectedPaths.add(`${full}${suffix}`);
    }
    const expectedDirectories = new Set(moduleIds.length ? [resolve(sourceDataDirectory, 'modules')] : []);
    if (sourceTree.directories.length !== expectedDirectories.size || sourceTree.directories.some(path => !expectedDirectories.has(path)) ||
        [...sourceFiles.keys()].some(path => !expectedPaths.has(path)) || [...expectedPaths].some(path => !sourceFiles.has(path) && !sidecars.has(path)))
      throw new Error('runtime-data-inventory-mismatch');
    for (const [relativePath, owner, kind, schema] of databasePaths) {
      const full = resolve(sourceDataDirectory, ...relativePath.split('/'));
      let relatedBytes = 0;
      for (const sidecar of [full, `${full}-wal`, `${full}-shm`, `${full}-journal`]) {
        const stat = sourceFiles.get(sidecar);
        if (stat) relatedBytes += stat.size;
      }
      if (relatedBytes > MAX_DATABASE_BYTES) throw new Error('source-database-size-limit');
      const database = inspectDatabase(full, owner, identity, Date.now(), kind, schema);
      const destination = resolve(payload, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      const reserved = openSync(destination, 'wx'); closeSync(reserved);
      const source = new DatabaseSync(full, { readOnly: true, timeout: 1000 });
      try { await backup(source, destination); } finally { source.close(); }
      normalizeOwnedBackupDatabase(destination);
      const backed = inspectDatabase(destination, owner, identity, Date.now(), kind, schema);
      if (canonical(backed.migrations) !== canonical(database.migrations) || backed.generation !== database.generation)
        throw new Error('database-changed-during-backup');
    }
    for (const name of PRIVATE_FILES) {
      const bytes = enrollment.files.get(name);
      if (!bytes) throw new Error('private-file-missing');
      const destination = join(payload, name); writeExclusive(destination, bytes);
    }
    const capturedAt = Date.now();
    const databases = [];
    for (const [relativePath, owner, kind, schema] of databasePaths) databases.push({path:relativePath,...inspectDatabase(resolve(payload, ...relativePath.split('/')), owner, identity, capturedAt, kind, schema)});
    const access = new DatabaseSync(join(payload, 'access.sqlite'), { readOnly: true, timeout: 1000 });
    try {
      const unexpired = Number(access.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires>?').get(capturedAt).count);
      if (unexpired !== 0) throw new Error('active-session-prevents-backup');
    } finally { access.close(); }
    const files = [];
    const copiedTree = boundedTree(payload), copied = copiedTree.files;
    const expectedPayloadDirectories = new Set(moduleIds.length ? [resolve(payload, 'modules')] : []);
    if (copiedTree.directories.length !== expectedPayloadDirectories.size || copiedTree.directories.some(path => !expectedPayloadDirectories.has(path)))
      throw new Error('staged-backup-directory-inventory-mismatch');
    for (const [path, stat] of copied) {
      const relativePath = path.slice(payload.length + 1).replaceAll('\\', '/');
      const bytes = readBounded(path, relativePath.endsWith('.sqlite') ? MAX_DATABASE_BYTES : MAX_MANIFEST_BYTES);
      if (bytes.length !== stat.size) throw new Error('staged-file-size-changed');
      files.push({ path: relativePath, sizeBytes: bytes.length, digest: sha256(bytes) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (files.length + 1 > MAX_FILES) throw new Error('backup-file-count-limit');
    const manifest = { schema: 'quadbridge.runtime-backup.v1', identity, capturedAt,
      enrollmentDigest: operation.enrollmentDigest, seedDigest: enrollment.seedDigest,
      sessions: { checkedAt: capturedAt, unexpired: 0 }, databases, files };
    const manifestJson = canonical(manifest), manifestBytes = Buffer.from(manifestJson);
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('backup-manifest-size-limit');
    const digest = sha256(manifestBytes), totalBytes = manifestBytes.length + files.reduce((total, row) => total + row.sizeBytes, 0);
    if (totalBytes < 1 || totalBytes > MAX_BACKUP_BYTES) throw new Error('backup-size-limit');
    writeExclusive(join(payload, 'manifest.json'), manifestBytes);
    writeExclusive(join(operationRoot, 'result.json'), Buffer.from(canonical({schema:'quadbridge.runtime-recovery-result.v1',operationId:operation.operationId,
      kind:'BACKUP',digest,capturedAt,sizeBytes:totalBytes,fileCount:files.length+1,manifest:manifestJson})));
  } else {
    if (resolve(operation.destinationDataDirectory) !== sourceDataDirectory || !HASH.test(operation.backupDigest)) throw new Error('restore-destination-identity-mismatch');
    const targetInfo = (() => { try { return lstatSync(sourceDataDirectory); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } })();
    if (targetInfo) throw new Error('restore-destination-already-exists');
    const selected = verifyBackupObject(recoveryRoot, operation.backupDigest, identity, operation.moduleSchemas);
    if (selected.manifest.enrollmentDigest !== operation.enrollmentDigest) throw new Error('backup-enrollment-identity-mismatch');
    if(Date.now()<selected.manifest.capturedAt)throw new Error('restore-clock-before-backup-capture');
    for (const [relativePath, bytes] of selected.files) {
      const destination = resolve(payload, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeExclusive(destination, bytes);
    }
    writeExclusive(join(operationRoot, 'result.json'), Buffer.from(canonical({schema:'quadbridge.runtime-recovery-result.v1',operationId:operation.operationId,
      kind:'RESTORE',backupDigest:operation.backupDigest,capturedAt:selected.manifest.capturedAt,sizeBytes:selected.sizeBytes,fileCount:selected.fileCount})));
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  run().catch(error => {
    process.stderr.write(`Recovery driver stopped safely (${error?.code === 'SQLITE_BUSY' ? 'DATABASE_BUSY' : 'RECOVERY_DRIVER_FAILED'}).\n`);
    process.exitCode = 1;
  });
}
