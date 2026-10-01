import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';

const actor = 'system:test-suite';
const product = (version = '1.0.0', title = 'Sample') => ({ id: 'sample-product', version, platformAbi: 'quadbridge.module.v1', title, description: '', layout: 'sidebar', modules: [], bindings: [] });
const pipeline = (label = 'Assistant', version = '1.0.0') => ({
    schema: 'quadbridge.ai-pipeline.v1', id: 'document-assistant', version, label,
    nodes: [{ id: 'input', kind: 'input' }, { id: 'answer', kind: 'model', capability: 'text.generate', config: { temperature: 0.1 } }, { id: 'output', kind: 'output' }],
    edges: [{ from: 'input', to: 'answer' }, { from: 'answer', to: 'output' }],
    policy: { timeoutMs: 30000, maxParallel: 4, dataClass: 'internal', placement: 'hybrid' }
});

test('control plane persists source versions and admits builds/deployments only with exact successful build evidence', () => {
    const store = new ControlPlaneStore(':memory:');
    try {
        store.putProduct(product(), actor);
        assert.equal(store.products().length, 1);
        assert.equal(store.product('sample-product', '')?.version, undefined);
        assert.throws(() => store.requestBuild('sample-product', '', actor), /Invalid build product reference/);
        assert.throws(() => store.requestBuild('sample-product', '2.0.0', actor), /Product version not found/);
        const build = store.requestBuild('sample-product', '1.0.0', actor);
        assert.equal(build.state, 'QUEUED');
        store.putEnvironment({ id: 'local-dev', label: 'Local', kind: 'development', target: 'local' }, actor);
        assert.throws(() => store.requestDeployment('local-dev', 'sample-product', '1.0.0', build.id, actor), /not successful/);
        assert.equal(store.deployments().length, 0);
        const digest = 'a'.repeat(64);
        store.db.prepare("UPDATE builds SET state='SUCCEEDED',artifact_digest=? WHERE id=?").run(digest, build.id);
        const deployment = store.requestDeployment('local-dev', 'sample-product', '1.0.0', build.id, actor);
        assert.equal(deployment.state, 'REQUESTED');
        assert.equal(deployment.buildId, build.id);
        assert.equal(store.deployments().length, 1);
        assert.throws(() => store.requestDeployment('local-dev', 'sample-product', '1.0.1', build.id, actor), /Product version not found/);
        assert.throws(() => store.requestDeployment('other-env', 'sample-product', '1.0.0', build.id, actor), /Environment not found/);
        const audit = store.auditLog();
        assert.ok(audit.every(row => row.actorId === actor));
    } finally { store.close(); }
});

test('product and AI versions are idempotent when equal and immutable across store restarts', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'qb-control-plane-immutable-'));
    let store;
    t.after(async () => { try { store?.close(); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } });
    const path = join(dir, 'state.sqlite');
    store = new ControlPlaneStore(path);
    store.putProduct(product(), actor);
    store.putAiPipeline(pipeline(), actor);
    const firstAudit = store.auditLog(500).length;
    const originalProductTimestamp = store.db.prepare('SELECT updated FROM products WHERE id=?').get('sample-product').updated;
    store.putProduct(product(), actor);
    store.putAiPipeline(pipeline(), actor);
    assert.equal(store.auditLog(500).length, firstAudit);
    assert.equal(store.db.prepare('SELECT updated FROM products WHERE id=?').get('sample-product').updated, originalProductTimestamp);
    assert.throws(() => store.putProduct(product('1.0.0', 'Changed under same version'), actor), /immutable/);
    assert.throws(() => store.putAiPipeline(pipeline('Changed under same version'), actor), /immutable/);
    store.close();
    store = undefined;

    store = new ControlPlaneStore(path);
    assert.equal(store.product('sample-product', '1.0.0').title, 'Sample');
    assert.equal(store.aiPipelines()[0].spec.label, 'Assistant');
    assert.equal(store.auditLog(500).length, firstAudit);
    store.putProduct(product(), actor);
    store.putAiPipeline(pipeline(), actor);
    assert.equal(store.auditLog(500).length, firstAudit);
    store.putProduct(product('1.0.1', 'Sample v2'), actor);
    store.putAiPipeline(pipeline('Assistant v2', '1.0.1'), actor);
    assert.equal(store.product('sample-product', '1.0.0').title, 'Sample');
    assert.equal(store.product('sample-product', '1.0.1').title, 'Sample v2');
    assert.equal(store.products()[0].version, '1.0.1');
    assert.deepEqual(store.productVersions().map(row=>row.version),['1.0.0','1.0.1']);
    store.putProduct(product('9.0.0', 'Sample 9'), actor);
    store.putProduct(product('10.0.0', 'Sample 10'), actor);
    store.db.prepare('UPDATE product_versions SET created=42 WHERE id=?').run('sample-product');
    assert.equal(store.product('sample-product').version, '10.0.0');
    assert.equal(store.products()[0].version, '10.0.0');
    assert.deepEqual(new Set(store.productVersions().map(row=>row.version)),new Set(['1.0.0','1.0.1','9.0.0','10.0.0']));
});

test('legacy audit migration preserves every old value and marks its actor unknown', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'qb-control-plane-legacy-'));
    let legacy;
    let store;
    t.after(async () => { try { store?.close(); } finally { try { legacy?.close(); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } } });
    const path = join(dir, 'legacy.sqlite');
    legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE products(id TEXT PRIMARY KEY,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE product_versions(id TEXT NOT NULL,version TEXT NOT NULL,definition TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version),FOREIGN KEY(id) REFERENCES products(id));
      CREATE TABLE builds(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,version TEXT NOT NULL,state TEXT NOT NULL,artifact_digest TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE environments(id TEXT PRIMARY KEY,label TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,region TEXT,created INTEGER NOT NULL);
      CREATE TABLE deployments(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL,product_id TEXT NOT NULL,version TEXT NOT NULL,build_id TEXT,state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE ai_pipelines(id TEXT NOT NULL,version TEXT NOT NULL,spec TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,subject TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL);
    `);
    const invalidProduct = JSON.stringify({ ...product('1.0.0'), version: ['1.0.0'] });
    legacy.prepare('INSERT INTO products VALUES(?,?,?,?)').run('legacy-product', 'Legacy', 1, 2);
    legacy.prepare('INSERT INTO product_versions VALUES(?,?,?,?)').run('legacy-product', '1.0.0', invalidProduct, 3);
    const buildId = '123e4567-e89b-42d3-a456-426614174000';
    legacy.prepare('INSERT INTO builds VALUES(?,?,?,?,?,?,?)').run(buildId, 'legacy-product', '1.0.0', 'SUCCEEDED', 'legacy-invalid-digest', 4, 5);
    legacy.prepare('INSERT INTO environments VALUES(?,?,?,?,?,?)').run('legacy-env', 'Legacy', 'mystery', 'moon', null, 6);
    legacy.prepare('INSERT INTO deployments VALUES(?,?,?,?,?,?,?,?)').run('legacy-deploy', 'legacy-env', 'legacy-product', 'broken', buildId, 'HEALTHY', 7, 8);
    legacy.prepare('INSERT INTO ai_pipelines VALUES(?,?,?,?,?)').run('legacy-pipeline', '0.0.1', '{"unvalidated":"legacy"}', 'legacy-digest', 9);
    legacy.prepare('INSERT INTO audit(action,subject,payload,at) VALUES(?,?,?,?)').run('', 'legacy subject', '{not-json', 123);
    const oldValues = Object.fromEntries(['products', 'product_versions', 'builds', 'environments', 'deployments', 'ai_pipelines', 'audit'].map(table => [table, legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    legacy.close();
    legacy = undefined;

    store = new ControlPlaneStore(path);
    const [row] = store.auditLog();
    assert.equal(row.action, '');
    assert.equal(row.subject, 'legacy subject');
    assert.equal(row.payload, '{not-json');
    assert.equal(row.at, 123);
    assert.equal(row.actorId, null);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(store.productVersions()[0].valid,false,'an invalid legacy definition remains visible but cannot be offered for execution');
    assert.throws(() => store.requestBuild('legacy-product', '1.0.0', actor), /Stored product identity/);
    assert.throws(() => store.requestDeployment('legacy-env', 'legacy-product', '1.0.0', buildId, actor), /Invalid environment kind/);
    for (const table of Object.keys(oldValues)) {
        const expectedColumns = Object.keys(oldValues[table][0] ?? {});
        const projection = expectedColumns.join(',');
        assert.deepEqual(store.db.prepare(`SELECT ${projection} FROM ${table} ORDER BY rowid`).all(), oldValues[table], `${table} migration values`);
    }
    assert.equal(store.builds().length, 1);
    assert.equal(store.deployments().length, 1);
    assert.equal(store.aiPipelines()[0].spec.unvalidated, 'legacy');
    store.close();
    store = undefined;

    store = new ControlPlaneStore(path);
    for (const table of Object.keys(oldValues)) {
        const expectedColumns = Object.keys(oldValues[table][0] ?? {});
        assert.deepEqual(store.db.prepare(`SELECT ${expectedColumns.join(',')} FROM ${table} ORDER BY rowid`).all(), oldValues[table], `${table} restart values`);
    }
});

test('future database versions are rejected without changing schema metadata', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'qb-control-plane-future-'));
    let future;
    let check;
    t.after(async () => { try { check?.close(); } finally { try { future?.close(); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } } });
    const path = join(dir, 'future.sqlite');
    future = new DatabaseSync(path);
    future.exec('PRAGMA user_version=6');
    future.close();
    future = undefined;
    assert.throws(() => new ControlPlaneStore(path), /Unsupported control-plane schema version 6/);
    check = new DatabaseSync(path);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count, 0);
    check.close();
    check = undefined;
});

test('schema 3 artifact publication facts are added without changing older operation values', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'qb-control-plane-v3-'));
    const path = join(dir, 'schema-v3.sqlite');
    let store;
    let legacy;
    t.after(async () => {
        try { store?.close(); } finally { try { legacy?.close(); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } }
    });
    store = new ControlPlaneStore(path);
    const id = '123e4567-e89b-42d3-a456-426614174001';
    store.db.prepare(`INSERT INTO artifact_operations(id,kind,state,physical_state,build_id,artifact_digest,snapshot_id,snapshot_ref,
      product_id,version,input_digest,release_digest,size_bytes,file_count,original_build_actor_id,initiating_actor_id,registering_actor_id,
      owner_token,staging_ref,host_identity,publisher_digest,error_code,error_message,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'REGISTER','PUBLISHED','COPY_VERIFIED','legacy-build','a'.repeat(64),
        '123e4567-e89b-42d3-a456-426614174002','snapshots/123e4567-e89b-42d3-a456-426614174002','legacy-product','1.0.0','b'.repeat(64),
        'c'.repeat(64),123,7,'system:legacy-origin','system:legacy-origin','system:legacy-register','legacy-owner-token','staging/legacy-op','{}','d'.repeat(64),
        'LEGACY_ERROR','preserve this text',10,20);
    const oldProjection='id,kind,state,physical_state,build_id,artifact_digest,snapshot_id,snapshot_ref,product_id,version,input_digest,release_digest,size_bytes,file_count,original_build_actor_id,initiating_actor_id,registering_actor_id,owner_token,staging_ref,host_identity,publisher_digest,error_code,error_message,created,updated';
    const before=store.db.prepare(`SELECT ${oldProjection} FROM artifact_operations WHERE id=?`).get(id);
    store.db.exec('PRAGMA user_version=3');
    store.close();store=undefined;
    legacy=new DatabaseSync(path);
    legacy.exec('ALTER TABLE artifact_operations DROP COLUMN destination_verified; ALTER TABLE artifact_operations DROP COLUMN staging_clean;');
    legacy.close();legacy=undefined;

    store=new ControlPlaneStore(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,5,'additive CP5A recovery migration advances the current schema');
    assert.deepEqual(store.db.prepare(`SELECT ${oldProjection} FROM artifact_operations WHERE id=?`).get(id),before,'all preexisting operation values survive');
    const facts=store.db.prepare('SELECT destination_verified AS destinationVerified,staging_clean AS stagingClean FROM artifact_operations WHERE id=?').get(id);
    assert.deepEqual({...facts},{destinationVerified:0,stagingClean:0},'new monotonic publication facts default to unverified');
});

test('mutation and actor audit commit atomically and audit faults roll back the record', () => {
    const store = new ControlPlaneStore(':memory:');
    try {
        store.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
        assert.throws(() => store.putEnvironment({ id: 'local-dev', label: 'Local', kind: 'development', target: 'local' }, actor), /injected audit failure/);
        assert.equal(store.environments().length, 0);
        assert.equal(store.auditLog().length, 0);
    } finally { store.close(); }
});

test('environment and product validators fail closed on coercible primitive values', () => {
    const store = new ControlPlaneStore(':memory:');
    try {
        assert.throws(() => store.putProduct({ ...product(), layout: ['sidebar'] }, actor), /Invalid product layout/);
        assert.throws(() => store.putProduct({ ...product(), bindings: [{ contract: 'c', instanceId: 'i', implementation: 'm', scope: ['application'], consumer: 'x', mode: 'local' }] }, actor), /Invalid binding/);
        assert.throws(() => store.putEnvironment({ id: 'local-dev', label: 'Local', kind: 'development', target: ['local'] }, actor), /Invalid environment target/);
        assert.equal(store.products().length, 0);
        assert.equal(store.environments().length, 0);
        assert.equal(store.auditLog().length, 0);
    } finally { store.close(); }
});
