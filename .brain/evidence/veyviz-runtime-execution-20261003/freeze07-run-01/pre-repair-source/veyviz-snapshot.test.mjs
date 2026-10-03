import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { canonical } from '@quadbridge/contracts';
import { startProduct, ROOT } from '../tools/veyviz-start.mjs';
import {
  createRuntimeExecution,
  prepareVerifiedSnapshot,
  removeOwnedRuntimeExecution,
  verifyRuntimeExecutionLinks
} from '../tools/veyviz-snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const QUALIFICATION_PATH = '.local/veyviz-build-qualification';

function runBuildWrapper(producerRoot, timeout = 180_000) {
  return childProcess.spawnSync(process.execPath, [join(producerRoot, 'tools', 'veyviz-build.mjs')], {
    cwd: producerRoot, encoding: 'utf8', windowsHide: true, timeout
  });
}

async function waitForFile(path, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(`Timed out waiting for test-owned build marker: ${path}`);
}

async function runDriftedBuild(producerRoot, mutate) {
  const builderPath = join(producerRoot, 'tools', 'build.mjs');
  const originalBuilder = await readFile(builderPath);
  const helperPath = join(producerRoot, 'tools', 'build-qualification-fixture.mjs');
  await copyFile(builderPath, helperPath);
  const marker = join(producerRoot, '.local', 'build-child-started');
  const release = join(producerRoot, '.local', 'build-child-release');
  const stub = `import { existsSync, writeFileSync } from 'node:fs';\nimport { setTimeout as delay } from 'node:timers/promises';\nwriteFileSync(${JSON.stringify(marker)}, 'started');\nwhile (!existsSync(${JSON.stringify(release)})) await delay(10);\nawait import('./build-qualification-fixture.mjs');\n`;
  await writeFile(builderPath, stub);
  const child = childProcess.spawn(process.execPath, [join(producerRoot, 'tools', 'veyviz-build.mjs')], {
    cwd: producerRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2_000_000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2_000_000); });
  const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  try {
    await waitForFile(marker);
    await mutate();
    await writeFile(release, 'continue');
    return { ...(await closed), stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await writeFile(release, 'continue').catch(() => {});
      await closed;
    }
    await writeFile(builderPath, originalBuilder);
    await rm(helperPath, { force: true });
    await rm(marker, { force: true });
    await rm(release, { force: true });
  }
}

async function makeProducerFixture(t) {
  const fixtureHome = await mkdtemp(join(dirname(ROOT), 'veyviz-snapshot-test-'));
  let passed = false;
  t.after(async () => {
    if (passed) await rm(fixtureHome, { recursive: true, force: true });
    else t.diagnostic(`Snapshot fixture retained after failure: ${fixtureHome}`);
  });
  const producerRoot = join(fixtureHome, 'producer');
  // Copy authored sources only. The test-owned build wrapper creates generated outputs inside this clean producer.
  const skipped = new Set(['.git', '.brain', '.codex', '.local', 'node_modules', 'dist', '.artifacts', 'generated']);
  await cp(ROOT, producerRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(ROOT, source).replaceAll('\\', '/');
      const normalized = rel.toLowerCase();
      return !rel.split('/').some(part => skipped.has(part.toLowerCase())) &&
        !normalized.endsWith('.tsbuildinfo') && !normalized.endsWith('.pyc');
    }
  });
  for (const workspace of ['ai-core', 'studio-model']) {
    assert.equal(existsSync(join(producerRoot, 'packages', workspace, 'tsconfig.tsbuildinfo')), false, `${workspace} incremental state is not copied into the fresh producer`);
  }
  await mkdir(join(producerRoot, 'node_modules'), { recursive: true });
  for (const name of ['typescript', 'esbuild']) {
    await cp(join(ROOT, 'node_modules', name), join(producerRoot, 'node_modules', name), { recursive: true });
  }
  await mkdir(join(producerRoot, 'node_modules', '@types'), { recursive: true });
  await cp(join(ROOT, 'node_modules', '@types', 'node'), join(producerRoot, 'node_modules', '@types', 'node'), { recursive: true });
  await cp(join(ROOT, 'node_modules', 'undici-types'), join(producerRoot, 'node_modules', 'undici-types'), { recursive: true });
  const esbuildPlatform = `${process.platform}-${process.arch}`;
  await mkdir(join(producerRoot, 'node_modules', '@esbuild'), { recursive: true });
  await cp(join(ROOT, 'node_modules', '@esbuild', esbuildPlatform), join(producerRoot, 'node_modules', '@esbuild', esbuildPlatform), { recursive: true });
  const linked = childProcess.spawnSync(process.execPath, [join(producerRoot, 'tools', 'link-workspaces.mjs')], {
    cwd: producerRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.equal(linked.status, 0, `fixture workspace links failed: ${linked.stderr || linked.stdout}`);
  const built = runBuildWrapper(producerRoot);
  assert.equal(built.status, 0, `test-owned producer fixture build failed: ${built.stderr || built.stdout}`);
  for (const workspace of ['ai-core', 'studio-model']) {
    assert.equal(existsSync(join(producerRoot, 'packages', workspace, 'dist', 'index.d.ts')), true, `${workspace} declarations were emitted by this fixture's fresh build`);
  }
  return {
    producerRoot,
    fixtureHome,
    markPassed() { passed = true; }
  };
}

async function login(app, username = 'admin') {
  const credentials = JSON.parse(await readFile(app.credentialsPath, 'utf8'));
  const response = await fetch(app.url + '/api/session', {
    method: 'POST',
    headers: { Origin: app.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: credentials[username] })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function api(app, cookie, path, { method = 'GET', body, tenant = 'alpha', key = 'snapshot-test-command' } = {}) {
  const response = await fetch(app.url + path, {
    method,
    headers: {
      Cookie: cookie, Origin: app.url, 'X-QB-Tenant': tenant,
      'Content-Type': 'application/json', 'Idempotency-Key': key
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, body: await response.json() };
}

function withForkReplacement(replacement, run) {
  const original = childProcess.fork;
  childProcess.fork = replacement;
  syncBuiltinESMExports();
  return Promise.resolve().then(run).finally(() => {
    childProcess.fork = original;
    syncBuiltinESMExports();
  });
}

async function assertRefusedBeforeFork(producerRoot, dataRoot, expected) {
  let forks = 0;
  await withForkReplacement(() => {
    forks++;
    throw Error('runtime fork must not be reached for an invalid snapshot');
  }, async () => {
    await assert.rejects(startProduct({ root: producerRoot, product: 'veyviz-catalog', dataRoot, port: 0 }), expected);
  });
  assert.equal(forks, 0, 'invalid producer/snapshot evidence is refused before the runtime fork');
  assert.equal(existsSync(dataRoot), false, 'invalid producer/snapshot evidence creates no enrollment or credentials');
}

test('the running catalog serves captured web bytes and backend state after its producer asset changes', { timeout: 300_000 }, async t => {
  const fixture = await makeProducerFixture(t);
  const { producerRoot } = fixture;
  const dataRoot = join(fixture.fixtureHome, 'runtime-data');
  let app;
  try {
    app = await startProduct({ root: producerRoot, product: 'veyviz-catalog', dataRoot, port: 0 });
    assert.notEqual(app.runtimeRoot, app.producerRoot);
    for (const name of app.runtimeLinks) {
      const link = join(app.runtimeRoot, 'node_modules', ...name.split('/'));
      const real = await realpath(link);
      assert.ok(real.toLowerCase().startsWith(`${app.runtimeRoot.toLowerCase()}${sep}`), `${name} resolves inside the copied runtime`);
    }
    const page = await fetch(app.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    const composition = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
    assert.equal(composition, '/assets/composition.js', 'the actual shell loads the reviewed composition asset');
    const web = JSON.parse(await readFile(join(app.runtimeRoot, '.artifacts', 'veyviz-catalog', 'web.json'), 'utf8'));
    const producerAssetRelative = web.files[composition];
    assert.equal(typeof producerAssetRelative, 'string');
    const producerAsset = join(producerRoot, producerAssetRelative);
    const originalProducerBytes = await readFile(producerAsset);
    const firstResponse = await fetch(app.url + composition);
    assert.equal(firstResponse.status, 200);
    const servedBytes = Buffer.from(await firstResponse.arrayBuffer());
    assert.equal(hash(servedBytes), hash(originalProducerBytes));

    const cookie = await login(app);
    const created = await api(app, cookie, '/api/sources', {
      method: 'POST', body: { name: 'Snapshot-bound source', fixtureId: 'mivia-vid0062' }
    });
    assert.equal(created.status, 200);
    const backendBefore = await api(app, cookie, '/api/sources');
    assert.deepEqual(backendBefore.body.items.map(item => item.id), [created.body.id]);

    await writeFile(producerAsset, Buffer.concat([originalProducerBytes, Buffer.from('\n// test-owned producer mutation\n')]));
    const afterResponse = await fetch(app.url + composition);
    assert.equal(afterResponse.status, 200);
    const afterBytes = Buffer.from(await afterResponse.arrayBuffer());
    assert.equal(hash(afterBytes), hash(servedBytes), 'live HTTP still serves the immutable captured asset bytes');
    assert.deepEqual(afterBytes, servedBytes);
    assert.deepEqual(await api(app, cookie, '/api/sources'), backendBefore, 'backend source rows remain available after the producer mutation');
    const closed = await app.stop();
    assert.equal(closed.code, 0);
    assert.equal(closed.cleanup, true);
    assert.equal(closed.runtimeCopyCleanup, 'REMOVED');
    assert.equal(existsSync(app.runtimeRoot), false, 'a positively closed launch copy is removed');
    app = null;
    fixture.markPassed();
  } finally {
    if (app) await app.stop();
  }
});

test('unchanged snapshot restart retains data while a changed valid export gets isolated storage', { timeout: 360_000 }, async t => {
  const fixture = await makeProducerFixture(t);
  const { producerRoot } = fixture;
  const dataRoot = join(fixture.fixtureHome, 'runtime-data');
  let app;
  try {
    app = await startProduct({ root: producerRoot, product: 'veyviz-catalog', dataRoot, port: 0 });
    const originalFingerprint = app.fingerprint;
    const originalSnapshotDigest = app.snapshotDigest;
    const selectedManifest = JSON.parse(await readFile(join(app.snapshotRoot, 'QUADBRIDGE-SNAPSHOT.json'), 'utf8'));
    assert.equal(originalSnapshotDigest, hash(canonical(selectedManifest)), 'the selected digest binds the full manifest and file inventory');
    const manifestIdentity = Object.fromEntries(Object.entries(selectedManifest).filter(([key]) => !['schema', 'files'].includes(key)));
    const selectionName = (await readdir(dirname(app.snapshotRoot))).find(name => name.startsWith('selection-') && name.endsWith('.json'));
    assert.ok(selectionName);
    const selectionReceipt = JSON.parse(await readFile(join(dirname(app.snapshotRoot), selectionName), 'utf8'));
    const candidateIdentity = { ...manifestIdentity, qualificationDigest: selectionReceipt.qualificationDigest };
    assert.equal(selectionReceipt.candidateKey, hash(canonical(candidateIdentity)));
    assert.match(selectionReceipt.qualificationDigest, /^[0-9a-f]{64}$/);
    assert.equal(selectionReceipt.snapshotDigest, originalSnapshotDigest);
    const cookie = await login(app);
    const created = await api(app, cookie, '/api/sources', {
      method: 'POST', body: { name: 'Original generation row', fixtureId: 'mivia-vid0062' }
    });
    assert.equal(created.status, 200);
    const originalDataDirectory = app.dataDirectory;
    assert.equal((await app.stop()).cleanup, true);
    app = await startProduct({ root: producerRoot, product: 'veyviz-catalog', dataRoot, port: 0 });
    assert.equal(app.fingerprint, originalFingerprint);
    assert.equal(app.snapshotDigest, originalSnapshotDigest);
    const afterRestart = await api(app, await login(app), '/api/sources');
    assert.deepEqual(afterRestart.body.items.map(item => item.id), [created.body.id]);
    const access = new DatabaseSync(join(app.dataDirectory, 'access.sqlite'));
    try {
      const initialGrantCount = Number(access.prepare("SELECT count(*) AS count FROM grants WHERE principal='viewer'").get().count);
      assert.ok(initialGrantCount > 0);
      access.prepare("DELETE FROM grants WHERE principal='viewer'").run();
      assert.equal(Number(access.prepare("SELECT count(*) AS count FROM grants WHERE principal='viewer'").get().count), 0);
    } finally { access.close(); }
    assert.equal((await app.stop()).cleanup, true);
    app = await startProduct({ root: producerRoot, product: 'veyviz-catalog', dataRoot, port: 0 });
    assert.equal(app.fingerprint, originalFingerprint);
    const viewerCookie = await login(app, 'viewer');
    assert.equal((await api(app, viewerCookie, '/api/sources')).status, 403, 'a removed viewer grant stays removed');
    assert.deepEqual(JSON.parse(await readFile(app.configPath, 'utf8')).principals, [], 'same-snapshot restart does not reseed principals');
    const retainedAccess = new DatabaseSync(join(app.dataDirectory, 'access.sqlite'));
    try { assert.equal(Number(retainedAccess.prepare("SELECT count(*) AS count FROM grants WHERE principal='viewer'").get().count), 0); }
    finally { retainedAccess.close(); }
    assert.equal((await app.stop()).cleanup, true);
    app = null;

    const oldBusinessDb = new DatabaseSync(join(originalDataDirectory, 'modules', 'veyviz-sources.sqlite'));
    try {
      assert.equal(Number(oldBusinessDb.prepare("SELECT count(*) AS count FROM video_sources WHERE name='Original generation row'").get().count), 1);
    } finally { oldBusinessDb.close(); }
    const profilePath = join(producerRoot, 'profiles', 'local-developer.json');
    const originalProfile = await readFile(profilePath);
    const qualificationPath = join(producerRoot, QUALIFICATION_PATH, 'current.json');
    const originalQualification = JSON.parse(await readFile(qualificationPath, 'utf8'));
    const changedProfile = Buffer.concat([originalProfile, Buffer.from('\n')]);
    const driftAttempt = await runDriftedBuild(producerRoot, async () => writeFile(profilePath, changedProfile));
    assert.equal(driftAttempt.code, 1, `input drift during the original build must fail qualification: ${driftAttempt.stderr}`);
    assert.match(driftAttempt.stderr, /Authored source changed during the fixed core build/i);
    assert.equal(existsSync(qualificationPath), false, 'a drifted build cannot leave the retired qualification current');
    assert.ok((await readdir(join(producerRoot, QUALIFICATION_PATH, 'history'))).length > 0, 'the previous qualification remains in history');
    const attemptsDirectory = join(producerRoot, QUALIFICATION_PATH, 'attempts');
    const attemptRecords = await Promise.all((await readdir(attemptsDirectory)).map(async id => JSON.parse(await readFile(join(attemptsDirectory, id, 'attempt.json'), 'utf8'))));
    const driftRecord = attemptRecords.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
    assert.equal(driftRecord.original.closeObserved, true);
    assert.equal(driftRecord.original.code, 0, 'the original fixed builder close is retained even though input drift rejects publication');
    assert.equal(driftRecord.original.signal, null);
    assert.match(driftRecord.qualificationError.message, /source changed/i);

    const builderPath = join(producerRoot, 'tools', 'build.mjs');
    const originalBuilder = await readFile(builderPath);
    await writeFile(builderPath, `process.stdout.write('synthetic builder stdout');\nprocess.stderr.write('synthetic builder stderr');\nprocess.exitCode = 23;\n`);
    const failedBuild = runBuildWrapper(producerRoot);
    assert.equal(failedBuild.status, 1, `a nonzero original builder close must fail qualification: ${failedBuild.stderr}`);
    assert.equal(existsSync(qualificationPath), false, 'a failed build cannot publish a current qualification');
    const afterFailure = await Promise.all((await readdir(attemptsDirectory)).map(async id => JSON.parse(await readFile(join(attemptsDirectory, id, 'attempt.json'), 'utf8'))));
    const failedRecord = afterFailure.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
    assert.equal(failedRecord.original.closeObserved, true);
    assert.equal(failedRecord.original.code, 23);
    assert.equal(failedRecord.original.signal, null);
    assert.equal((await readFile(join(producerRoot, ...failedRecord.stdout.path.split('/')))).toString(), 'synthetic builder stdout');
    assert.equal((await readFile(join(producerRoot, ...failedRecord.stderr.path.split('/')))).toString(), 'synthetic builder stderr');
    await writeFile(builderPath, originalBuilder);

    const rebuilt = runBuildWrapper(producerRoot);
    assert.equal(rebuilt.status, 0, `the explicit fixed build after the profile change must qualify: ${rebuilt.stderr || rebuilt.stdout}`);
    const changedQualification = JSON.parse(await readFile(qualificationPath, 'utf8'));
    assert.notEqual(changedQualification.stableDigest, originalQualification.stableDigest);
    const stableAfterChangedBuild = changedQualification.stableDigest;
    const unchangedRebuild = runBuildWrapper(producerRoot);
    assert.equal(unchangedRebuild.status, 0, `an unchanged repeat build must qualify: ${unchangedRebuild.stderr || unchangedRebuild.stdout}`);
    assert.equal(JSON.parse(await readFile(qualificationPath, 'utf8')).stableDigest, stableAfterChangedBuild, 'random attempt IDs, timestamps and logs do not rotate stable build identity');
    const changedSnapshot = await prepareVerifiedSnapshot({ root: producerRoot, product: 'veyviz-catalog' });
    assert.notEqual(changedSnapshot.snapshotDigest, originalSnapshotDigest, 'changed valid export bytes produce a new verified selection');
    app = await startProduct({ root: producerRoot, product: 'veyviz-catalog', dataRoot, port: 0 });
    assert.notEqual(app.fingerprint, originalFingerprint);
    assert.notEqual(app.dataDirectory, originalDataDirectory);
    assert.deepEqual((await api(app, await login(app), '/api/sources')).body.items, [], 'new generation does not read or migrate rows from the old database');
    assert.deepEqual(JSON.parse(await readFile(app.configPath, 'utf8')).principals.map(principal => principal.id), ['admin', 'viewer'], 'the isolated generation receives fresh identities without importing the prior database');
    assert.equal((await app.stop()).cleanup, true);
    app = null;
    fixture.markPassed();
  } finally {
    if (app) await app.stop();
  }
});

test('tampered, incomplete, forged, stale and escaped snapshot inputs are refused before fork', { timeout: 300_000 }, async t => {
  const fixture = await makeProducerFixture(t);
  const { producerRoot } = fixture;
  const selected = await prepareVerifiedSnapshot({ root: producerRoot, product: 'veyviz-catalog' });
  const qualificationPath = join(producerRoot, QUALIFICATION_PATH, 'current.json');
  const qualificationBytes = await readFile(qualificationPath);
  const dataRoot = join(fixture.fixtureHome, 'denied-data');

  await unlink(qualificationPath);
  await assertRefusedBeforeFork(producerRoot, dataRoot, /qualification|current|ENOENT/i);
  await writeFile(qualificationPath, qualificationBytes, { flag: 'wx', mode: 0o600 });

  const forgedQualification = JSON.parse(qualificationBytes.toString('utf8'));
  forgedQualification.stableDigest = 'f'.repeat(64);
  await writeFile(qualificationPath, JSON.stringify(forgedQualification, null, 2) + '\n');
  await assertRefusedBeforeFork(producerRoot, dataRoot, /qualification|identity|receipt/i);
  await writeFile(qualificationPath, qualificationBytes);

  const moduleSource = join(producerRoot, 'modules', 'veyviz-sources', 'src', 'index.ts');
  const originalModuleSource = await readFile(moduleSource);
  await writeFile(moduleSource, Buffer.concat([originalModuleSource, Buffer.from('\n// stale producer source fixture\n')]));
  await assertRefusedBeforeFork(producerRoot, dataRoot, /source|qualification|changed/i);
  await writeFile(moduleSource, originalModuleSource);

  const typescriptManifest = join(producerRoot, 'node_modules', 'typescript', 'package.json');
  const originalTypescriptManifest = await readFile(typescriptManifest);
  await writeFile(typescriptManifest, Buffer.concat([originalTypescriptManifest, Buffer.from('\n')]));
  await assertRefusedBeforeFork(producerRoot, dataRoot, /toolchain|qualification|changed/i);
  await writeFile(typescriptManifest, originalTypescriptManifest);

  const nodeTypeSource = join(producerRoot, 'node_modules', '@types', 'node', 'index.d.ts');
  const originalNodeTypeSource = await readFile(nodeTypeSource);
  const undiciTypeSource = join(producerRoot, 'node_modules', 'undici-types', 'index.d.ts');
  const originalUndiciTypeSource = await readFile(undiciTypeSource);
  await writeFile(nodeTypeSource, Buffer.concat([originalNodeTypeSource, Buffer.from('\n')]));
  await writeFile(undiciTypeSource, Buffer.concat([originalUndiciTypeSource, Buffer.from('\n')]));
  await assertRefusedBeforeFork(producerRoot, dataRoot, /toolchain|qualification|changed/i);
  await writeFile(nodeTypeSource, originalNodeTypeSource);
  await writeFile(undiciTypeSource, originalUndiciTypeSource);

  const receiptBytes = await readFile(selected.receiptPath);
  const planRelative = '.artifacts/veyviz-catalog/plan.json';
  const snapshotPlan = join(selected.snapshotRoot, ...planRelative.split('/'));
  const producerPlan = join(producerRoot, ...planRelative.split('/'));
  const originalPlan = await readFile(snapshotPlan);
  const extraPath = join(selected.snapshotRoot, 'unexpected-extra.txt');
  await writeFile(extraPath, 'extra snapshot inventory entry');
  await assertRefusedBeforeFork(producerRoot, dataRoot, /inventory|snapshot|candidate/i);
  await rm(extraPath);

  await unlink(snapshotPlan);
  await assertRefusedBeforeFork(producerRoot, dataRoot, /snapshot|inventory|destination|ENOENT/i);
  await copyFile(producerPlan, snapshotPlan);

  const altered = JSON.parse(originalPlan.toString('utf8'));
  altered.permissions.push('forged.snapshot.permission');
  await writeFile(snapshotPlan, JSON.stringify(altered, null, 2) + '\n');
  await assertRefusedBeforeFork(producerRoot, dataRoot, /inventory|snapshot|candidate|Factory output differs from its trusted input: \.artifacts\/veyviz-catalog\/plan\.json/i);
  await writeFile(snapshotPlan, originalPlan);

  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const forgedBase = { ...receipt, snapshotDigest: 'f'.repeat(64) };
  delete forgedBase.receiptDigest;
  await writeFile(selected.receiptPath, JSON.stringify({ ...forgedBase, receiptDigest: hash(canonical(forgedBase)) }, null, 2) + '\n');
  await assertRefusedBeforeFork(producerRoot, dataRoot, /selection receipt|independently derived|receipt/i);
  await writeFile(selected.receiptPath, receiptBytes);

  const release = JSON.parse(await readFile(join(producerRoot, '.artifacts/veyviz-catalog/release.json'), 'utf8'));
  const trackedBuildFile = Object.keys(release.backend)[0];
  const producerBuildFile = join(producerRoot, ...trackedBuildFile.split('/'));
  const originalBuildBytes = await readFile(producerBuildFile);
  await writeFile(producerBuildFile, Buffer.concat([originalBuildBytes, Buffer.from('\n// stale producer build\n')]));
  await assertRefusedBeforeFork(producerRoot, dataRoot, /digest mismatch|release|digest/i);
  await writeFile(producerBuildFile, originalBuildBytes);

  const runtimeCopy = createRuntimeExecution({ root: producerRoot, snapshot: selected, product: 'veyviz-catalog' });
  const linkName = runtimeCopy.runtimeLinks[0];
  const linkPath = join(runtimeCopy.runtimeRoot, 'node_modules', ...linkName.split('/'));
  await unlink(linkPath);
  let linked;
  try {
    await symlink(join(producerRoot, 'tools'), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      await t.test('platform permits the required escaped-link fixture', t => t.skip(`blocked by host filesystem policy: ${error.code}`));
      linked = false;
    } else throw error;
  }
  if (linked) {
    assert.throws(() => verifyRuntimeExecutionLinks(runtimeCopy.runtimeRoot, runtimeCopy.runtimeLinks), /escaped|in-copy|inventory/i);
    assert.throws(() => removeOwnedRuntimeExecution(runtimeCopy.runtimeRoot, runtimeCopy.runtimeLinks), /escaped|in-copy|inventory/i);
  }
  assert.equal(existsSync(dataRoot), false);
  fixture.markPassed();
});
