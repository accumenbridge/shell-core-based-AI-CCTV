import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyPortableFixture, shouldIncludeMaintainedPath } from './source-copy.mjs';
import { evaluateTestRun, maintainedSourceFingerprint, makeVerificationReport, parseTapReport } from '../tools/verify-core.mjs';
import { ROOT } from '../apps/runtime/dist/index.js';
import { copyReviewedBuildInputs } from '../apps/control-plane/dist/build-inputs.js';

const validTap = ({ tests = 1, passed = tests, failed = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) => [
    'TAP version 13',
    ...Array.from({ length: tests }, (_, index) => {
        const number = index + 1;
        if (number <= passed) return `ok ${number} - case ${number}`;
        if (number <= passed + failed) return `not ok ${number} - case ${number}`;
        if (number <= passed + failed + cancelled) return `not ok ${number} - case ${number} # CANCELLED`;
        if (number <= passed + failed + cancelled + skipped) return `ok ${number} - case ${number} # SKIP`;
        return `ok ${number} - case ${number} # TODO`;
    }), `1..${tests}`, `# tests ${tests}`,
    '# suites 0', `# pass ${passed}`, `# fail ${failed}`, `# cancelled ${cancelled}`,
    `# skipped ${skipped}`, `# todo ${todo}`, '# duration_ms 1', ''
].join('\n');

test('source paths normalize both separators and exclude operational components exactly', () => {
    for (const path of [
        'D:/repo/.brain/START_HERE.md', 'D:\\repo\\.codex\\agents\\brain.toml',
        'analysis/input.json', 'D:\\repo\\.git\\index', 'reference/Veyviz.md',
        'exports/build.zip', 'node_modules/pkg/index.js', 'generated/catalog.mjs',
        'evidence/last_run.json', '.artifacts/neutral/plan.json', '.local/state.db',
        'src/cache.tsbuildinfo', 'BUNDLE_SHA256.json'
    ]) assert.equal(shouldIncludeMaintainedPath(path), false, path);
    for (const path of ['profiles/local-developer.json', 'tools/build.mjs', 'analysis-notes/README.md'])
        assert.equal(shouldIncludeMaintainedPath(path), true, path);
});

test('maintained fingerprint ignores operational records and changes with source', async t => {
    const root = await mkdtemp(join(tmpdir(), 'qb-fingerprint-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.brain'), { recursive: true });
    await mkdir(join(root, 'analysis'), { recursive: true });
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'maintained source\n');
    await writeFile(join(root, 'profiles/local.json'), '{}\n');
    await writeFile(join(root, '.brain/progress.json'), '{"status":"one"}\n');
    await writeFile(join(root, 'analysis/notes.json'), '{"notes":1}\n');
    const initial = await maintainedSourceFingerprint(root);
    await writeFile(join(root, '.brain/progress.json'), '{"status":"two"}\n');
    await writeFile(join(root, 'analysis/notes.json'), '{"notes":2}\n');
    assert.equal(await maintainedSourceFingerprint(root), initial);
    await writeFile(join(root, 'README.md'), 'maintained source changed\n');
    assert.notEqual(await maintainedSourceFingerprint(root), initial);
});

test('portable copy retains maintained source and profiles, excludes operational state, and cleans early failures', async t => {
    const source = await mkdtemp(join(tmpdir(), 'qb-copy-source-'));
    t.after(() => rm(source, { recursive: true, force: true }));
    for (const path of ['.git/index', '.brain/project.json', '.codex/agents/brain.toml', 'analysis/input.json', 'generated/catalog.mjs', 'evidence/run.json', 'profiles/local.json', 'src/index.ts', 'node_modules/typescript/package.json']) {
        const full = join(source, path);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, 'fixture\n');
    }
    const normal = await copyPortableFixture(t, source, { prefix: 'qb-copy-target-' });
    for (const path of ['.git', '.brain', '.codex', 'analysis', 'generated', 'evidence']) {
        await assert.rejects(access(join(normal.root, path)));
    }
    await access(join(normal.root, 'profiles/local.json'));
    await access(join(normal.root, 'src/index.ts'));
    assert.equal((await lstat(join(normal.root, 'node_modules/typescript'))).isSymbolicLink(), true);

    let failedTemp;
    await assert.rejects(copyPortableFixture(undefined, source, {
        prefix: 'qb-copy-failure-',
        afterSetup: async ({ root, temp }) => {
            failedTemp = temp;
            assert.equal((await lstat(join(root, 'node_modules/typescript'))).isSymbolicLink(), true);
            throw new Error('injected setup failure');
        }
    }), /injected setup failure/);
    await assert.rejects(access(failedTemp));
    await normal.cleanup();

    const failingCleanup = await copyPortableFixture(undefined, source, { prefix: 'qb-copy-close-failure-' });
    failingCleanup.registerCleanup(() => { throw new Error('owned service failed to close'); });
    await assert.rejects(failingCleanup.cleanup(), AggregateError);
    await assert.rejects(access(failingCleanup.temp));
});

test('reviewed source copy detects a maintained input changed while the asynchronous copy is active', {skip:process.platform==='linux'}, async t => {
    const root=await mkdtemp(join(tmpdir(),'qb-reviewed-copy-source-'));
    const destination=await mkdtemp(join(tmpdir(),'qb-reviewed-copy-destination-'));
    t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});
    const sourceFile=join(root,'apps','control-plane','src','large-fixture.ts');
    await mkdir(join(root,'apps','control-plane','src'),{recursive:true});
    await writeFile(join(root,'apps','control-plane','package.json'),'{}\n');
    await writeFile(sourceFile,Buffer.alloc(32*1024*1024,0x61));
    const watcher=watch(destination,{recursive:true});
    let copySettled=false,changedDuringCopy=false,mutationStarted=false,eventResolve,eventReject;
    const firstDestinationEvent=new Promise((resolve,reject)=>{eventResolve=resolve;eventReject=reject;});
    const timer=setTimeout(()=>eventReject(new Error('No output event arrived during private source copy')),10000);
    watcher.on('error',eventReject);
    watcher.on('change',()=>{
        if(copySettled||mutationStarted)return;
        mutationStarted=true;
        try{writeFileSync(sourceFile,Buffer.alloc(32*1024*1024,0x62));changedDuringCopy=true;eventResolve();}
        catch(error){eventReject(error);}
    });
    const copy=copyReviewedBuildInputs(root,destination).then(()=>{copySettled=true;return undefined;},error=>{copySettled=true;return error;});
    try{
        await firstDestinationEvent;
        assert.equal(changedDuringCopy,true);
        assert.equal(copySettled,false,'the source mutation happens before the copy operation settles');
        const failure=await copy;
        assert.ok(failure instanceof Error);
        assert.match(failure.message,/Reviewed source changed during its private copy/);
    }finally{clearTimeout(timer);watcher.close();}
});

test('reviewed source copy includes fixed family data as inert input and rejects neighboring files', async t => {
    const root=await mkdtemp(join(tmpdir(),'qb-family-copy-source-'));
    const destination=await mkdtemp(join(tmpdir(),'qb-family-copy-destination-'));
    t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});
    const file=join(root,'families','service-operations','family.json');
    await mkdir(join(root,'families','service-operations'),{recursive:true});
    await writeFile(file,'{"schema":"quadbridge.product-family.v1","id":"service-operations"}\n');
    await copyReviewedBuildInputs(root,destination);
    assert.equal(await readFile(join(destination,'families','service-operations','family.json'),'utf8'),await readFile(file,'utf8'));
    await writeFile(join(root,'families','service-operations','unexpected.mjs'),'export default true;\n');
    await assert.rejects(copyReviewedBuildInputs(root,destination),/Unreviewed build input path/);
});

test('TAP verification accepts explicit terminal summaries with skipped and TODO accounting', () => {
    const output = validTap({ tests: 3, passed: 1, skipped: 1, todo: 1 });
    assert.deepEqual(parseTapReport(output, 1), {
        status: 'VALID', counts: { tests: 3, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 1 }
    });
    assert.deepEqual(evaluateTestRun({ discoveredFiles: ['tests/a.test.mjs'], result: { status: 0, output } }).status, 'PASSED');
});

test('TAP verification follows actual Node nested, TODO, and skipped report counts', async t => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-tap-fixture-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;

    const nestedFixture = join(temp, 'nested.test.mjs');
    await writeFile(nestedFixture, "import test from 'node:test';\ntest('parent',async t=>{await t.test('child',()=>{});});\n");
    const nested = spawnSync(process.execPath, ['--test', '--test-reporter=tap', nestedFixture], { encoding: 'utf8', env: childEnv });
    assert.equal(nested.status, 0, nested.stderr);
    assert.deepEqual(evaluateTestRun({ discoveredFiles: ['tests/nested.test.mjs'], result: { ...nested, output: `${nested.stdout}${nested.stderr}` } }), {
        status: 'PASSED', counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 }
    }, `${nested.stdout}\n${nested.stderr}`);

    const directiveFixture = join(temp, 'directives.test.mjs');
    await writeFile(directiveFixture, "import test from 'node:test';\ntest('passes',()=>{});\ntest.skip('skips');\ntest.todo('todo');\n");
    const directives = spawnSync(process.execPath, ['--test', '--test-reporter=tap', directiveFixture], { encoding: 'utf8', env: childEnv });
    assert.equal(directives.status, 0, directives.stderr);
    assert.deepEqual(evaluateTestRun({ discoveredFiles: ['tests/directives.test.mjs'], result: { ...directives, output: `${directives.stdout}${directives.stderr}` } }), {
        status: 'PASSED', counts: { tests: 3, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 1 }
    }, `${directives.stdout}\n${directives.stderr}`);

    const todoFailureFixture = join(temp, 'todo-failure.test.mjs');
    await writeFile(todoFailureFixture, "import test from 'node:test';\ntest('pass sibling',()=>{});\ntest('pending failure',{todo:'pending fix'},()=>{throw Error('expected pending failure')});\n");
    const todoFailure = spawnSync(process.execPath, ['--test', '--test-reporter=tap', todoFailureFixture], { encoding: 'utf8', env: childEnv });
    assert.equal(todoFailure.status, 0, todoFailure.stderr);
    assert.deepEqual(evaluateTestRun({ discoveredFiles: ['tests/todo-failure.test.mjs'], result: { ...todoFailure, output: `${todoFailure.stdout}${todoFailure.stderr}` } }), {
        status: 'PASSED', counts: { tests: 2, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 1 }
    }, `${todoFailure.stdout}\n${todoFailure.stderr}`);
});

test('TAP verification rejects unknown, zero, malformed and ambiguous discovery or reports', () => {
    assert.equal(evaluateTestRun({ discoveredFiles: null, result: { status: 0, output: validTap() } }).reason, 'unknown_discovery');
    assert.equal(evaluateTestRun({ discoveredFiles: [], result: { status: 0, output: validTap() } }).reason, 'zero_discovered_files');
    assert.equal(evaluateTestRun({ discoveredFiles: ['tests/a.test.mjs', 'tests/a.test.mjs'], result: { status: 0, output: validTap() } }).reason, 'ambiguous_discovery');
    assert.equal(evaluateTestRun({ discoveredFiles: ['tests/a.test.mjs'], discoveryError: Error('read failed'), result: { status: 0, output: validTap() } }).reason, 'discovery_error');
    assert.equal(parseTapReport(validTap({ tests: 0, passed: 0 }), 1).reason, 'zero_tests');
    assert.equal(parseTapReport(validTap().replace('TAP version 13', 'TAP version unknown'), 1).reason, 'missing_or_unknown_tap_version');
    assert.equal(parseTapReport(validTap().replace('1..1', ''), 1).reason, 'missing_or_ambiguous_plan');
    assert.equal(parseTapReport(validTap().replace('# tests 1', '# tests one'), 1).reason, 'malformed_summary');
    assert.equal(parseTapReport(validTap().replace('# tests 1', '# tests 1\n# tests 1'), 1).reason, 'ambiguous_summary');
    assert.equal(parseTapReport(validTap().replace('ok 1 - case 1', 'not a TAP result'), 1).reason, 'malformed_or_ambiguous_results');
    assert.equal(parseTapReport(validTap({ tests: 2, passed: 1 }), 1).reason, 'inconsistent_counts');
    assert.equal(parseTapReport(validTap().replace('1..1', '1..2'), 1).reason, 'malformed_or_ambiguous_results');
    assert.equal(parseTapReport(validTap().replace('ok 1 - case 1', 'not ok 1 - case 1'), 1).reason, 'result_summary_mismatch');
});

test('TAP verification fails test exits, failures, cancellations, spawn errors, and signals', () => {
    const files = ['tests/a.test.mjs'];
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: 7, output: validTap() } }).reason, 'nonzero_test_exit');
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: 0, output: validTap({ tests: 1, passed: 0, failed: 1 }) } }).reason, 'test_failures');
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: 0, output: validTap({ tests: 1, passed: 0, cancelled: 1 }) } }).reason, 'test_cancellations');
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: null, error: Error('spawn') } }).reason, 'spawn_error');
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: null, signal: 'SIGTERM' } }).reason, 'terminated_by_signal');
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: null } }).reason, 'unknown_exit_status');
    assert.equal(evaluateTestRun({ discoveredFiles: files, result: { status: 0, output: validTap({ tests: 1, passed: 0, skipped: 1 }) } }).reason, 'no_completed_passing_tests');
});

test('build failure reports tests as NOT_RUN and claims only current passing evidence', () => {
    const failedBuild = makeVerificationReport({ buildResult: { status: 2 }, testResult: { status: 0, output: validTap() }, discoveredFiles: ['tests/a.test.mjs'], sourceFingerprint: 'a'.repeat(64) });
    assert.equal(failedBuild.checks.tests.status, 'NOT_RUN');
    assert.equal(failedBuild.checks.tests.counts, null);
    assert.deepEqual(failedBuild.currentRunEvidence.claims, []);

    const failedTests = makeVerificationReport({ buildResult: { status: 0 }, testResult: { status: 1, output: validTap({ tests: 1, passed: 0, failed: 1 }) }, discoveredFiles: ['tests/a.test.mjs'], sourceFingerprint: 'a'.repeat(64) });
    assert.equal(failedTests.status, 'FAILED');
    assert.equal(failedTests.currentRunEvidence.claims.length, 1);
    assert.match(failedTests.currentRunEvidence.claims[0], /build completed/);

    const passed = makeVerificationReport({ buildResult: { status: 0 }, testResult: { status: 0, output: validTap() }, discoveredFiles: ['tests/a.test.mjs'], sourceFingerprint: 'a'.repeat(64) });
    assert.equal(passed.status, 'PASSED_FOR_LOCAL_FRAMEWORK_SCOPE');
    assert.equal(passed.currentRunEvidence.claims.length, 2);
    assert.equal(makeVerificationReport({ buildResult: { status: 0 }, testResult: { status: 0, output: validTap() }, discoveredFiles: ['tests/a.test.mjs'], sourceFingerprint: null }).status, 'FAILED');
});

function cmdQuote(path) { return `"${path}"`; }
function runLauncher(cwd, launcher, env, timeout = 15000) {
    const command = `"${cmdQuote(launcher)}"`;
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], { cwd, env, encoding: 'utf8', timeout, windowsHide: true, windowsVerbatimArguments: true });
}

test('START_FULL_STUDIO.cmd handles foreign-cwd success and exact build/start failures', { skip: process.platform !== 'win32' }, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'qb-launcher-stubs-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const stubs = join(temp, 'stubs'), foreign = join(temp, 'foreign'), log = join(temp, 'calls.txt');
    await mkdir(stubs, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await writeFile(join(stubs, 'npm.cmd'), '@echo off\r\n>>"%QB_LAUNCH_LOG%" echo npm^|%CD%^|%*\r\nexit /b %QB_NPM_EXIT%\r\n');
    await writeFile(join(stubs, 'node.cmd'), '@echo off\r\n>>"%QB_LAUNCH_LOG%" echo node^|%CD%^|%*\r\nexit /b %QB_NODE_EXIT%\r\n');
    const env = (npmExit, nodeExit) => ({ ...process.env, PATH: `${stubs};${process.env.PATH}`, QB_LAUNCH_LOG: log, QB_NPM_EXIT: String(npmExit), QB_NODE_EXIT: String(nodeExit) });
    const launcher = resolve(ROOT, 'START_FULL_STUDIO.cmd');

    let result = runLauncher(foreign, launcher, env(0, 0));
    assert.equal(result.status, 0, result.stderr);
    let calls = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
    const normalizedRoot = ROOT.replace(/[\\/]$/, '').toLowerCase();
    assert.deepEqual(calls.map(line => line.split('|').slice(0, 2).map(value => value.replace(/[\\/]$/, '').toLowerCase())), [['npm', normalizedRoot], ['node', normalizedRoot]]);
    assert.match(calls[0], /run build/);
    assert.match(calls[1], /apps[\\/]control-plane[\\/]dist[\\/]main\.js/);

    await writeFile(log, '');
    result = runLauncher(foreign, launcher, env(23, 0));
    assert.equal(result.status, 23, result.stderr);
    calls = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^npm\|/);

    await writeFile(log, '');
    result = runLauncher(foreign, launcher, env(0, 47));
    assert.equal(result.status, 47, result.stderr);
    calls = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
    assert.equal(calls.length, 2);
});

async function freeLoopbackPort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
    const { port } = server.address();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    return port;
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    await Promise.race([
        new Promise(resolveExit => child.once('exit', resolveExit)),
        new Promise(resolveTimeout => setTimeout(resolveTimeout, 5000))
    ]);
    if (child.exitCode === null) child.kill();
}

test('START_FULL_STUDIO.cmd reaches the actual bounded loopback health response', { skip: process.platform !== 'win32' }, async t => {
    const copied = await copyPortableFixture(t, ROOT, { prefix: 'qb-studio-health-' });
    const { temp, root } = copied;
    const foreign = join(temp, 'foreign');
    await mkdir(foreign);
    const port = await freeLoopbackPort();
    const database = join(temp, 'control-plane.sqlite');
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `"${cmdQuote(resolve(root, 'START_FULL_STUDIO.cmd'))}"`], {
        cwd: foreign,
        env: { ...process.env, QB_STUDIO_PORT: String(port), QB_CONTROL_PLANE_DB: database },
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true
    });
    copied.registerCleanup(() => stopProcessTree(child));

    const deadline = Date.now() + 90000;
    let response;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`launcher exited before health response (${child.exitCode})`);
        try {
            response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
            if (response.status === 200) break;
        } catch { /* The server may still be building or starting. */ }
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    assert.ok(response && response.status === 200, 'bounded /healthz probe did not become healthy');
    const health = await response.json();
    assert.deepEqual(health, { status: 'ok' });
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Quadbridge|Studio/i);
    t.diagnostic(JSON.stringify({ fixture: 'portable source copy', cwd: 'foreign directory', health: { path: '/healthz', status: response.status, body: health }, page: { path: '/', status: page.status } }));
});
