import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ConstructionCommandOwner } from '../tools/construction-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const profilePath = join(root, '.local', 'platform-build-host.json');
const windowsJobSkip = process.platform !== 'win32' ? 'the fixed PowerShell Job protocol is Windows-only' : !existsSync(profilePath) ? 'no selected local Windows Job host profile is available' : false;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function temporaryWorkspace(suffix = 'b-') {
  const workspace = await mkdtemp(join(tmpdir(), `qb-construction-source-${suffix}`));
  await mkdir(join(workspace, 'tools'));
  for (const group of ['packages', 'modules', 'apps']) await mkdir(join(workspace, group));
  await copyFile(join(root, 'tools', 'link-workspaces.mjs'), join(workspace, 'tools', 'link-workspaces.mjs'));
  await copyFile(join(root, 'tools', 'workspace-identities.mjs'), join(workspace, 'tools', 'workspace-identities.mjs'));
  return workspace;
}

function fixtureOwnerRoot() {
  return join(root, '.local', 'construction-reliability-001', 'f15-process-tests', randomUUID());
}

async function assertNoProcess(pid) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error?.code === 'ESRCH') return; throw error; }
    await delay(25);
  }
  assert.fail(`the owned descendant ${pid} did not close after its original parent was stopped`);
}

test('F15: fixed Windows Job recipe records positive close proof before deleting its owned fixture', { skip: windowsJobSkip }, async t => {
  const workspace = await temporaryWorkspace();
  const operationRootBase = fixtureOwnerRoot();
  const owner = new ConstructionCommandOwner({ projectRoot: root, operationRootBase });
  let result;
  t.after(async () => {
    if (result?.emptyObserved) {
      await owner.cleanup(result.ownerId).catch(() => {});
      await owner.cleanupWorkspace(workspace).catch(() => {});
      const baseInfo = await lstat(operationRootBase).catch(() => null);
      if (baseInfo?.isDirectory() && !baseInfo.isSymbolicLink() && await realpath(operationRootBase) === resolve(operationRootBase))
        await rm(operationRootBase, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  });

  result = await owner.run('b-link-idempotence-1', workspace, { timeoutMs: 15_000 });
  assert.equal(result.started, true);
  assert.equal(result.readyObserved, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.closeObserved, true);
  assert.equal(result.helperClosed, true);
  assert.equal(result.emptyObserved, true);
  assert.equal(result.physicalState, 'CLOSED');
  assert.equal(result.exitCode, 0);
  const captures = await owner.captureLogs(result.ownerId, operationRootBase, 'ordinary-command');
  assert.match((await readFile(join(operationRootBase, captures.stdout.logName), 'utf8')), /Local workspace links prepared/u);
  await owner.cleanup(result.ownerId);
  await owner.cleanupWorkspace(workspace);
  await assert.rejects(lstat(result.operationRoot), { code: 'ENOENT' });
  await assert.rejects(lstat(workspace), { code: 'ENOENT' });
});

test('F15: unresolved original close returns UNKNOWN with retained roots/logs and only that owner can clean after late close', async t => {
  const workspace = await temporaryWorkspace();
  const operationRootBase = fixtureOwnerRoot();
  const pidPath = join(workspace, 'descendant.pid');
  let output = '', currentChild, stopOwned, processClosed;
  const nativeJob = async input => {
    const startedAt = Date.now();
    const stdoutPath = join(input.operationRoot, 'stdout.log'), stderrPath = join(input.operationRoot, 'stderr.log');
    const stdoutFd = openSync(stdoutPath, 'wx', 0o600), stderrFd = openSync(stderrPath, 'wx', 0o600);
    const source = [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const pidPath=process.argv[1];",
      "const descendant=spawn(process.execPath,['--input-type=module','-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true});",
      "writeFileSync(pidPath,String(descendant.pid));",
      "process.stdout.write('OWNER_READY\\n');",
      "process.stdin.on('data',chunk=>{if(chunk.toString().includes('STOP')){descendant.once('close',()=>process.stdout.write('DESCENDANT_CLOSED\\n',()=>process.exit(0)));descendant.kill();}});",
      "setInterval(()=>{},1000);"
    ].join('\n');
    currentChild = spawn(process.execPath, ['--input-type=module', '-e', source, pidPath], { cwd: input.workspace,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let descendantClosed = false;
    currentChild.stdout.on('data', chunk => { const bytes = Buffer.from(chunk); output += bytes.toString('utf8'); writeSync(stdoutFd, bytes); if (output.includes('DESCENDANT_CLOSED')) descendantClosed = true; });
    currentChild.stderr.on('data', chunk => writeSync(stderrFd, Buffer.from(chunk)));
    processClosed = new Promise(resolveClose => currentChild.once('close', (code, signal) => {
      closeSync(stdoutFd); closeSync(stderrFd);
      resolveClose({ code, signal: signal ?? null });
    }));
    input.registerOwnedClosure(processClosed, close => ({ helperClosed: close.code === 0 && close.signal === null,
      emptyObserved: close.code === 0 && close.signal === null && descendantClosed && output.includes('DESCENDANT_CLOSED') }));
    stopOwned = () => new Promise((resolveWrite, rejectWrite) => currentChild.stdin.write('STOP\n', error => error ? rejectWrite(error) : resolveWrite()));
    input.setOwnedStop(stopOwned);
    input.setOwnedUnref(() => { currentChild.unref(); currentChild.stdin.unref(); currentChild.stdout.unref(); currentChild.stderr.unref(); });
    const deadline = Date.now() + 3000;
    while (!output.includes('OWNER_READY\n') && Date.now() < deadline) await delay(10);
    if (!output.includes('OWNER_READY\n')) throw new Error('fixture parent did not start its owned descendant');
    await delay(input.timeoutMs);
    await Promise.race([processClosed, delay(input.closeTimeoutMs)]);
    return { started: true, readyObserved: true, closeObserved: false, exitCode: null, signal: null, markerCode: null,
      helperClosed: false, emptyObserved: false, timedOut: true, physicalState: 'UNKNOWN', errorCode: 'EXECUTION_DEADLINE_EXPIRED',
      elapsedMs: Date.now() - startedAt, operationRoot: input.operationRoot, stdoutLogPath: stdoutPath, stderrLogPath: stderrPath };
  };
  const owner = new ConstructionCommandOwner({ projectRoot: root, operationRootBase, nativeJob, closeTimeoutMs: 100 });
  const otherOwner = new ConstructionCommandOwner({ projectRoot: root, operationRootBase, nativeJob });
  let result, descendantPid;
  t.after(async () => {
    if (result && !result.closeObserved) {
      await owner.requestStop(result.ownerId).catch(() => {});
      const close = await owner.waitForOriginalClose(result.ownerId, 5000);
      if (close.physicalState !== 'CLOSED') return;
    }
    if (result && owner) {
      await owner.cleanup(result.ownerId).catch(() => {});
      await owner.cleanupWorkspace(workspace).catch(() => {});
      const baseInfo = await lstat(operationRootBase).catch(() => null);
      if (baseInfo?.isDirectory() && !baseInfo.isSymbolicLink() && await realpath(operationRootBase) === resolve(operationRootBase))
        await rm(operationRootBase, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  });

  const startedAt = Date.now();
  result = await owner.run('b-link-idempotence-1', workspace, { timeoutMs: 100 });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs <= 1500, `the bounded execution and close request returned promptly (${elapsedMs} ms)`);
  assert.equal(result.timedOut, true);
  assert.equal(result.closeObserved, false);
  assert.equal(result.physicalState, 'UNKNOWN');
  assert.equal(await lstat(workspace).then(info => info.isDirectory()), true, 'the source root remains while the original child is open');
  assert.match(await readFile(join(result.operationRoot, 'stdout.log'), 'utf8'), /OWNER_READY/u, 'captured output remains available while close is unresolved');
  descendantPid = Number((await readFile(pidPath, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  process.kill(descendantPid, 0);
  await assert.rejects(owner.cleanup(result.ownerId), /requires original close and positive owned-tree closure proof/u);
  await assert.rejects(owner.cleanupWorkspace(workspace), /requires every original command owner/u);
  await assert.rejects(otherOwner.cleanup(result.ownerId), /not owned by this original owner/u);

  assert.equal(await owner.requestStop(result.ownerId), true, 'the original owner sends control to its exact retained process handle');
  const late = await owner.waitForOriginalClose(result.ownerId, 5000);
  assert.equal(late.closeObserved, true);
  assert.equal(late.physicalState, 'CLOSED');
  await assertNoProcess(descendantPid);
  const captures = await owner.captureLogs(result.ownerId, operationRootBase, 'late-closed-command');
  assert.match(await readFile(join(operationRootBase, captures.stdout.logName), 'utf8'), /DESCENDANT_CLOSED/u);
  await owner.cleanup(result.ownerId);
  await owner.cleanupWorkspace(workspace);
  await assert.rejects(lstat(result.operationRoot), { code: 'ENOENT' });
  await assert.rejects(lstat(workspace), { code: 'ENOENT' });
});
