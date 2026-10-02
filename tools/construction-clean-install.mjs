import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyReviewedBuildInputs, reviewedBuildFingerprint } from '../apps/control-plane/dist/build-inputs.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_CAPTURE = 1024 * 1024;
const MAX_GENERATION_SPEC = 256 * 1024;
const NPM_TIMEOUT = 15 * 60_000;
const BUILD_TIMEOUT = 5 * 60_000;
const sha = value => createHash('sha256').update(value).digest('hex');
async function physicalWorkspace(label) { return mkdtemp(join(tmpdir(), `qb-construction-${label}-`)); }

async function npmInvocation() {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .filter(value => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return { command: process.execPath, prefix: [candidate] };
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  throw new Error('The installed npm CLI could not be resolved for direct child ownership');
}

async function assertOwnedWorkspace(path, role) {
  const resolved = resolve(path), actual = await realpath(resolved), tempRoot = await realpath(tmpdir());
  const rel = relative(tempRoot, actual);
  const relativeParts = rel.split(sep);
  const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || relativeParts.length !== 1 || !samePath(resolve(tempRoot, rel), actual) || !basename(actual).startsWith(`qb-construction-${role}-`))
    throw new Error(`The owned ${role} source root failed containment checks`);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(actual, resolved))
    throw new Error(`The owned ${role} source root is not a physical directory`);
  return actual;
}

async function copyGenerationSpecs(sourceRoot, report) {
  const sourceDirectory = join(ROOT, 'examples', 'entities');
  const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  for (const directory of [ROOT, join(ROOT, 'examples'), sourceDirectory]) {
    const info = await lstat(directory);
    const physical = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(directory), physical))
      throw new Error('Reviewed generation-spec source is not a physical directory');
  }

  const specs = [
    { name: 'asset-register.json', source: 'examples/entities/asset-register.json', moduleId: 'asset-register' },
    { name: 'room-inspection.json', source: 'examples/entities/room-inspection.json', moduleId: 'room-inspection' }
  ];
  const localDirectory = join(sourceRoot, '.local');
  const specDirectory = join(localDirectory, 'construction-specs');
  await mkdir(localDirectory, { mode: 0o700 });
  await mkdir(specDirectory, { mode: 0o700 });
  for (const directory of [localDirectory, specDirectory]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private construction spec directory is not physical');
  }

  report.generationSpecs = {};
  for (const spec of specs) {
    const sourcePath = join(ROOT, ...spec.source.split('/'));
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_GENERATION_SPEC)
      throw new Error(`Reviewed generation spec is not a bounded physical file: ${spec.source}`);
    const bytes = await readFile(sourcePath);
    if (bytes.length !== info.size || bytes.length > MAX_GENERATION_SPEC) throw new Error(`Reviewed generation spec changed while reading: ${spec.source}`);
    JSON.parse(bytes.toString('utf8'));
    const destinationPath = join(specDirectory, spec.name);
    await writeFile(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
    const copiedInfo = await lstat(destinationPath), copiedBytes = await readFile(destinationPath);
    if (!copiedInfo.isFile() || copiedInfo.isSymbolicLink() || copiedBytes.length !== bytes.length || sha(copiedBytes) !== sha(bytes))
      throw new Error(`Private generation spec copy differs from its reviewed source: ${spec.source}`);
    report.generationSpecs[spec.moduleId] = {
      sourcePath: spec.source, sourceByteCount: bytes.length, sourceSha256: sha(bytes),
      copiedPath: `.local/construction-specs/${spec.name}`, copiedByteCount: copiedBytes.length, copiedSha256: sha(copiedBytes)
    };
  }
  return specs;
}

async function run(command, args, cwd, timeoutMs) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const startedAt = Date.now();
  const hash = createHash('sha256');
  let stdoutBytes = 0, stderrBytes = 0, capturedBytes = 0, timedOut = false, spawnError;
  const captured = [];
  const consume = (stream, chunk) => {
    const bytes = Buffer.from(chunk);
    if (stream === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length;
    hash.update(stream); hash.update(bytes);
    const remaining = MAX_CAPTURE - capturedBytes;
    if (remaining > 0) { const part = bytes.subarray(0, remaining); captured.push(Buffer.from(part)); capturedBytes += part.length; }
  };
  child.stdout.on('data', chunk => consume('stdout', chunk));
  child.stderr.on('data', chunk => consume('stderr', chunk));
  child.on('error', error => { spawnError = error; });
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* keep the original close observation */ } }, timeoutMs);
  const [exitCode, signal] = await new Promise(resolve => child.once('close', (code, closeSignal) => resolve([code, closeSignal])));
  clearTimeout(timer);
  return {
    command: basename(command), args,
    exitCode, signal: signal ?? null, timedOut, spawnErrorCode: typeof spawnError?.code === 'string' ? spawnError.code : null,
    closeObserved: true, elapsedMs: Date.now() - startedAt,
    stdoutBytes, stderrBytes, capturedBytes, truncated: stdoutBytes + stderrBytes > capturedBytes,
    outputSha256: hash.digest('hex'), captured: Buffer.concat(captured)
  };
}

async function exists(path) { try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function hashFile(path) { return sha(await readFile(path)); }
async function runStep(report, label, command, args, cwd, timeout, logDirectory) {
  const result = await run(command, args, cwd, timeout);
  const logName = `${String(report.steps.length + 1).padStart(2, '0')}-${label}.log`;
  await writeFile(join(logDirectory, logName), result.captured, { flag: 'wx', mode: 0o600 });
  delete result.captured;
  Object.assign(result, { label, logName });
  report.steps.push(result);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || !result.closeObserved || result.spawnErrorCode !== null)
    throw new Error(`Construction proof step failed: ${label}`);
  return result;
}

async function runNpm(report, label, args, cwd, logs, timeout = NPM_TIMEOUT) {
  const invocation = await npmInvocation();
  const result = await runStep(report, label, invocation.command, [...invocation.prefix, ...args], cwd, timeout, logs);
  result.command = 'npm';
  result.args = args;
  return result;
}

async function factory(report, label, cwd, logs, ...args) {
  return runStep(report, label, process.execPath, ['tools/factory.mjs', ...args], cwd, 120_000, logs);
}

async function assertProducts(sourceRoot) {
  const expected = new Map([
    ['construction-assets', ['asset-register']],
    ['construction-rooms', ['room-inspection']],
    ['construction-suite', ['asset-register', 'room-inspection']],
    ['construction-checklist', ['checklist']]
  ]);
  const products = {};
  for (const [productId, moduleIds] of expected) {
    const artifactRoot = join(sourceRoot, '.artifacts', productId);
    const plan = JSON.parse(await readFile(join(artifactRoot, 'plan.json'), 'utf8'));
    const actualIds = plan.modules.map(module => module.id).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify([...moduleIds].sort())) throw new Error(`Selected product closure mismatch: ${productId}`);
    const web = JSON.parse(await readFile(join(artifactRoot, 'web.json'), 'utf8'));
    const webFiles = Object.values(web.files ?? {});
    for (const selected of moduleIds) if (!webFiles.some(path => path.includes(`modules/${selected}/dist/ui`)))
      throw new Error(`Selected product output is missing ${selected}: ${productId}`);
    for (const omitted of ['asset-register', 'room-inspection', 'checklist'].filter(id => !moduleIds.includes(id)))
      if (webFiles.some(path => path.includes(`modules/${omitted}/`))) throw new Error(`Unselected module leaked into product output: ${productId}`);
    products[productId] = { moduleIds: actualIds, webFileCount: webFiles.length, planSha256: await hashFile(join(artifactRoot, 'plan.json')), webSha256: await hashFile(join(artifactRoot, 'web.json')) };
  }
  return products;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('This acceptance driver takes no arguments');
  const evidenceRoot = join(ROOT, '.local', 'construction-reliability-001');
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const evidenceId = randomUUID();
  const logs = join(evidenceRoot, evidenceId);
  await mkdir(logs, { mode: 0o700 });
  const sourceA = await physicalWorkspace('source-a-');
  const sourceB = await physicalWorkspace('source-b-');
  const report = {
    schema: 'quadbridge.construction-clean-install.v1', evidenceId, status: 'RUNNING',
    node: process.version, npmCommand: 'npm', platform: process.platform, architecture: process.arch,
    sourceCopies: [{ role: 'A', rootName: basename(sourceA) }, { role: 'B', rootName: basename(sourceB) }],
    steps: [], generated: {}, products: {}, lock: {}, retainedOnFailure: true
  };
  let workComplete = false, complete = false;
  try {
    const originalFingerprint = reviewedBuildFingerprint(ROOT);
    await copyReviewedBuildInputs(ROOT, sourceA);
    report.sourceFingerprintBeforeA = originalFingerprint;
    report.sourceFingerprintCopiedA = reviewedBuildFingerprint(sourceA);
    if (report.sourceFingerprintCopiedA !== originalFingerprint) throw new Error('Source A does not match the reviewed input identity');
    await runNpm(report, 'a-npm-ci', ['ci'], sourceA, logs);
    await runNpm(report, 'a-base-build', ['run', 'build'], sourceA, logs, BUILD_TIMEOUT);

    const generationSpecs = await copyGenerationSpecs(sourceA, report);
    for (const spec of generationSpecs)
      await factory(report, `a-generate-${spec.moduleId}`, sourceA, logs, 'generate-entity', `.local/construction-specs/${spec.name}`);
    await factory(report, 'a-create-checklist', sourceA, logs, 'create-module', 'checklist');
    for (const [product, modules, version] of [
      ['construction-assets', 'asset-register', '1.0.0'],
      ['construction-rooms', 'room-inspection', '2.1.0'],
      ['construction-suite', 'asset-register,room-inspection', '1.0.0'],
      ['construction-checklist', 'checklist', '1.2.0']
    ]) await factory(report, `a-create-${product}`, sourceA, logs, 'create-product', product, '--modules', modules, '--version', version);

    const lockPathA = join(sourceA, 'package-lock.json');
    const beforeReconcile = await hashFile(lockPathA);
    await runNpm(report, 'a-reconcile-lock', ['install', '--package-lock-only', '--ignore-scripts'], sourceA, logs, 180_000);
    const reconciledLock = await hashFile(lockPathA);
    report.lock.changedByExplicitReconcile = beforeReconcile !== reconciledLock;
    if (!report.lock.changedByExplicitReconcile) throw new Error('Explicit lock reconciliation did not add the generated workspaces');
    await runNpm(report, 'a-generated-build', ['run', 'build'], sourceA, logs, BUILD_TIMEOUT);
    const lockAfterBuildA = await hashFile(lockPathA);
    if (lockAfterBuildA !== reconciledLock) throw new Error('Build changed the explicitly reconciled lockfile');
    report.sourceFingerprintA = reviewedBuildFingerprint(sourceA);
    report.generated = {};
    for (const moduleId of ['asset-register', 'room-inspection', 'checklist']) {
      const manifestPath = join(sourceA, 'modules', moduleId, 'module.json');
      const packagePath = join(sourceA, 'modules', moduleId, 'package.json');
      report.generated[moduleId] = {
        manifestSha256: await hashFile(manifestPath), packageSha256: await hashFile(packagePath),
        workspaceId: JSON.parse(await readFile(manifestPath, 'utf8')).id
      };
    }
    report.products = await assertProducts(sourceA);

    await copyReviewedBuildInputs(sourceA, sourceB);
    report.sourceFingerprintCopiedB = reviewedBuildFingerprint(sourceB);
    if (report.sourceFingerprintCopiedB !== report.sourceFingerprintA) throw new Error('Source B does not match the reconciled source identity');
    if (await exists(join(sourceB, 'node_modules')) || await exists(join(sourceB, 'packages', 'contracts', 'dist')) || await exists(join(sourceB, '.artifacts')))
      throw new Error('Source B inherited dependencies, compiled outputs or prior artifacts');
    if (await exists(join(sourceB, '.local', 'construction-specs')))
      throw new Error('Source B inherited temporary generation-spec inputs');
    const lockPathB = join(sourceB, 'package-lock.json'), lockBeforeCiB = await hashFile(lockPathB);
    if (lockBeforeCiB !== reconciledLock) throw new Error('Source B did not receive the reconciled lockfile bytes');
    await runNpm(report, 'b-npm-ci', ['ci'], sourceB, logs);
    await runNpm(report, 'b-build', ['run', 'build'], sourceB, logs, BUILD_TIMEOUT);
    report.sourceFingerprintAfterBBuild = reviewedBuildFingerprint(sourceB);
    if (report.sourceFingerprintAfterBBuild !== report.sourceFingerprintCopiedB)
      throw new Error('Fresh install or build changed the reviewed source identity');
    await runStep(report, 'b-link-idempotence-1', process.execPath, ['tools/link-workspaces.mjs'], sourceB, 120_000, logs);
    await runStep(report, 'b-link-idempotence-2', process.execPath, ['tools/link-workspaces.mjs'], sourceB, 120_000, logs);
    const lockAfterCiBuildB = await hashFile(lockPathB);
    if (lockAfterCiBuildB !== lockBeforeCiB) throw new Error('Fresh install or build mutated the reconciled source lockfile');
    report.productsB = await assertProducts(sourceB);
    for (const productId of Object.keys(report.products)) {
      if (JSON.stringify(report.products[productId].moduleIds) !== JSON.stringify(report.productsB[productId].moduleIds))
        throw new Error(`Fresh product output changed selected modules: ${productId}`);
    }
    for (const moduleId of Object.keys(report.generated)) {
      const manifestPath = join(sourceB, 'modules', moduleId, 'module.json'), packagePath = join(sourceB, 'modules', moduleId, 'package.json');
      if (await hashFile(manifestPath) !== report.generated[moduleId].manifestSha256 || await hashFile(packagePath) !== report.generated[moduleId].packageSha256)
        throw new Error(`Fresh installation changed generated source identity: ${moduleId}`);
    }
    report.lock = { ...report.lock, sha256: reconciledLock, afterBuildASha256: lockAfterBuildA, copiedToBSha256: lockBeforeCiB, afterCiBuildBSha256: lockAfterCiBuildB };
    workComplete = true;
  } catch (error) {
    report.status = 'FAILED';
    report.failure = error instanceof Error ? error.message.slice(0, 240) : 'Construction proof failed';
  }

  if (workComplete) {
    try {
      await assertOwnedWorkspace(sourceB, 'source-b');
      await assertOwnedWorkspace(sourceA, 'source-a');
      await rm(sourceB, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
      await rm(sourceA, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
      complete = true;
      report.status = 'PASSED';
      report.retainedOnFailure = false;
    } catch (error) {
      report.status = 'FAILED';
      report.failure = `Owned source cleanup was not proven complete: ${error instanceof Error ? error.message.slice(0, 180) : 'unknown error'}`;
    }
  }
  report.finishedAt = new Date().toISOString();
  const reportPath = join(logs, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ schema: report.schema, evidenceId, status: report.status, steps: report.steps.length,
    closedChildren: report.steps.filter(step => step.closeObserved).length,
    failedStep: report.steps.find(step => step.exitCode !== 0 || step.signal || step.timedOut)?.label ?? null }));
  if (!complete) process.exitCode = 1;
}

await main();
