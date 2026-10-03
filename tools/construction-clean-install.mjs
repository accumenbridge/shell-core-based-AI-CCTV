import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyReviewedBuildInputs, reviewedBuildFingerprint } from '../apps/control-plane/dist/build-inputs.js';
import { ConstructionCommandOwner } from './construction-command.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_GENERATION_SPEC = 256 * 1024;
const NPM_TIMEOUT = 15 * 60_000;
const BUILD_TIMEOUT = 5 * 60_000;
const sha = value => createHash('sha256').update(value).digest('hex');
async function physicalWorkspace(label) { return mkdtemp(join(tmpdir(), `qb-construction-${label}-`)); }

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

async function exists(path) { try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function hashFile(path) { return sha(await readFile(path)); }
async function runStep(report, label, cwd, timeout, logDirectory, commandOwner) {
  const result = await commandOwner.run(label, cwd, { timeoutMs: timeout, label });
  const stepNumber = report.steps.length + 1;
  const outputCaptures = result.closeObserved
    ? await commandOwner.captureLogs(result.ownerId, logDirectory, `${String(stepNumber).padStart(2, '0')}-${label}`)
    : {};
  Object.assign(result, { stepNumber });
  const output = { stdout: outputCaptures.stdout?.logName ?? null, stderr: outputCaptures.stderr?.logName ?? null };
  if (!result.closeObserved) {
    output.retainedOperationRoot = relative(ROOT, result.operationRoot).replaceAll('\\', '/');
    output.stdoutPath = result.stdoutLogPath ? relative(ROOT, result.stdoutLogPath).replaceAll('\\', '/') : null;
    output.stderrPath = result.stderrLogPath ? relative(ROOT, result.stderrLogPath).replaceAll('\\', '/') : null;
  }
  const step = {
    command: result.commandKind, args: result.commandArgs, recipe: label, exitCode: result.exitCode, signal: result.signal ?? null,
    timedOut: result.timedOut === true, spawnErrorCode: result.spawnErrorCode ?? null, closeObserved: result.closeObserved === true,
    helperClosed: result.helperClosed === true, emptyObserved: result.emptyObserved === true,
    errorCode: result.errorCode ?? null, controlFailed: result.controlFailed === true,
    physicalState: result.physicalState, elapsedMs: result.elapsedMs, outputCaptures: output, retainedOnFailure: !result.emptyObserved
  };
  report.steps.push(step);
  if (result.emptyObserved) await commandOwner.cleanup(result.ownerId);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || !result.closeObserved || !result.helperClosed || !result.emptyObserved ||
      result.spawnErrorCode !== null || result.errorCode !== null || result.controlFailed)
    throw new Error(`Construction proof step failed: ${label}`);
  return step;
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
  const commandOwner = new ConstructionCommandOwner({ projectRoot: ROOT, operationRootBase: join(logs, 'owned-commands') });
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
    await runStep(report, 'a-npm-ci', sourceA, NPM_TIMEOUT, logs, commandOwner);
    await runStep(report, 'a-base-build', sourceA, BUILD_TIMEOUT, logs, commandOwner);

    const generationSpecs = await copyGenerationSpecs(sourceA, report);
    for (const spec of generationSpecs)
      await runStep(report, `a-generate-${spec.moduleId}`, sourceA, 120_000, logs, commandOwner);
    await runStep(report, 'a-create-checklist', sourceA, 120_000, logs, commandOwner);
    for (const [product, modules, version] of [
      ['construction-assets', 'asset-register', '1.0.0'],
      ['construction-rooms', 'room-inspection', '2.1.0'],
      ['construction-suite', 'asset-register,room-inspection', '1.0.0'],
      ['construction-checklist', 'checklist', '1.2.0']
    ]) await runStep(report, `a-create-${product}`, sourceA, 120_000, logs, commandOwner);

    const lockPathA = join(sourceA, 'package-lock.json');
    const beforeReconcile = await hashFile(lockPathA);
    await runStep(report, 'a-reconcile-lock', sourceA, 180_000, logs, commandOwner);
    const reconciledLock = await hashFile(lockPathA);
    report.lock.changedByExplicitReconcile = beforeReconcile !== reconciledLock;
    if (!report.lock.changedByExplicitReconcile) throw new Error('Explicit lock reconciliation did not add the generated workspaces');
    await runStep(report, 'a-generated-build', sourceA, BUILD_TIMEOUT, logs, commandOwner);
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
    await runStep(report, 'b-npm-ci', sourceB, NPM_TIMEOUT, logs, commandOwner);
    await runStep(report, 'b-build', sourceB, BUILD_TIMEOUT, logs, commandOwner);
    report.sourceFingerprintAfterBBuild = reviewedBuildFingerprint(sourceB);
    if (report.sourceFingerprintAfterBBuild !== report.sourceFingerprintCopiedB)
      throw new Error('Fresh install or build changed the reviewed source identity');
    await runStep(report, 'b-link-idempotence-1', sourceB, 120_000, logs, commandOwner);
    await runStep(report, 'b-link-idempotence-2', sourceB, 120_000, logs, commandOwner);
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
      await commandOwner.cleanupWorkspace(sourceB);
      await commandOwner.cleanupWorkspace(sourceA);
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
