import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '@quadbridge/contracts';
import {
  assertExpectedFactoryInventory,
  createSnapshotManifest,
  expectedFactoryInventory,
  verifyReleaseArtifacts,
  verifySnapshotManifest
} from '@quadbridge/composition/integrity';
import { readBoundedSnapshot } from '@quadbridge/composition/snapshot-access';
import { ARTIFACT_REGISTRY_LIMITS } from '@quadbridge/control-plane';
import {
  copyVerifiedRuntimeSnapshot,
  linkCopiedRuntimeWorkspaces,
  runtimeSnapshotExpected,
  runtimePrivateRoot
} from '../apps/control-plane/dist/runtime-manager.js';
import { maintainedSourceFingerprint } from './verify-core.mjs';
import { verifyBuildQualification } from './veyviz-inventory.mjs';

const RECIPE_VERSION = 'veyviz-fixed-runtime-snapshot-v1';
const FIXED_RUNTIME_SHA256 = '7bf19c54a83ab16784083762c0c0555281ac44e903403825fa67d99ea12233ca';
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = async path => hash(await readFile(path));
const LIMIT = 235;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertPhysicalDirectory(path, { create = false, root } = {}) {
  const full = resolve(path);
  if (full.length >= LIMIT) throw Error('Veyviz private path exceeds the supported short-path bound.');
  if (root) {
    const base = resolve(root);
    const rel = relative(base, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== full)
      throw Error('Veyviz private path escaped its product-owned root.');
  }
  try {
    const info = lstatSync(full);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase())
      throw Error('Veyviz private state contains a link or non-directory component.');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    const parent = dirname(full);
    if (parent !== full) assertPhysicalDirectory(parent, { create: true, root });
    mkdirSync(full);
    assertPhysicalDirectory(full, { root });
  }
  return full;
}

function physicalFile(path) {
  const full = resolve(path), info = lstatSync(full);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(full).toLowerCase() !== full.toLowerCase())
    throw Error('Veyviz private file is not a physical regular file.');
  return full;
}

function uuidFromDigest(digest) {
  const bytes = Buffer.from(digest.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function collectInputs(root, product) {
  root = resolve(root);
  assertPhysicalDirectory(root);
  if (!['veyviz-catalog', 'veyviz-review'].includes(product)) throw Error('Select a reviewed Veyviz product.');
  const qualification = await verifyBuildQualification(root);
  const planPath = join(root, '.artifacts', product, 'plan.json');
  const planBytes = await readFile(planPath);
  const plan = JSON.parse(planBytes.toString('utf8'));
  const version = plan?.product?.version;
  const release = verifyReleaseArtifacts(root, product, version);
  const expected = expectedFactoryInventory(root, release.plan);
  const inputDigest = hash(canonical(expected));
  const sourceFingerprint = await maintainedSourceFingerprint(root);
  const runtimePath = join(root, 'tools', 'veyviz-runtime.mjs');
  const runtimeBytes = await readFile(runtimePath);
  const runtimeDigest = hash(runtimeBytes);
  if (runtimeDigest !== FIXED_RUNTIME_SHA256)
    throw Error('The fixed Veyviz runtime wrapper differs from the reviewed captured bytes.');
  const helperPath = fileURLToPath(import.meta.url);
  const toolFiles = [
    'package.json', 'package-lock.json', 'tools/factory.mjs', 'tools/build.mjs',
    'tools/verify-core.mjs', 'tools/workspace-identities.mjs', 'tools/link-workspaces.mjs',
    'tools/veyviz-start.mjs', 'tools/veyviz-snapshot.mjs', 'tools/veyviz-runtime.mjs',
    'tools/veyviz-build.mjs', 'tools/veyviz-inventory.mjs',
    'packages/composition/dist/integrity.js', 'packages/composition/dist/snapshot-access.js',
    'packages/composition/dist/workspace-closure.js', 'apps/control-plane/dist/runtime-manager.js'
  ];
  const files = {};
  for (const path of toolFiles) files[path] = await fileHash(join(root, path));
  // The executing helper must be the same byte sequence captured from the producer checkout.
  if (files['tools/veyviz-snapshot.mjs'] !== await fileHash(helperPath))
    throw Error('Snapshot helper bytes differ from the producer-side fixed recipe.');
  const recipe = {
    recipeVersion: RECIPE_VERSION,
    nodeVersion: process.version,
    nodeExecutable: resolve(process.execPath),
    qualificationDigest: qualification.digest,
    files
  };
  const toolchainDigest = hash(canonical(recipe));
  const identityBase = {
    productId: product,
    version,
    inputDigest,
    sourceFingerprint,
    toolchainDigest,
    recipeVersion: RECIPE_VERSION,
    releaseDigest: release.releaseDigest
  };
  const buildId = uuidFromDigest(hash(canonical(identityBase)));
  const identity = { buildId, ...identityBase };
  const qualificationDigest = qualification.digest;
  const candidateKey = hash(canonical({ ...identity, qualificationDigest }));
  return { root, product, version, plan: release.plan, expected, release, identity, qualificationDigest, candidateKey, runtimeBytes, runtimeDigest, recipe };
}

async function companionIdentity(root, product, profilePath) {
  if (product !== 'veyviz-review') return { profilePath: null, companion: null };
  const plan = JSON.parse(await readFile(join(root, '.artifacts', product, 'plan.json'), 'utf8'));
  if (!plan.modules.some(module => module.provides.includes('veyviz.recorded-analysis.run.v1')))
    return { profilePath: null, companion: null };
  const resolvedProfile = resolve(profilePath ?? join(root, '.local', 'veyviz-ai', 'profile.json'));
  const bytes = await readFile(resolvedProfile);
  const profile = JSON.parse(bytes.toString('utf8'));
  if (profile.schema !== 'veyviz.recorded-profile.v1' || typeof profile.inventoryPath !== 'string')
    throw Error('Unsupported AI profile. Run the reviewed companion setup.');
  const inventoryBytes = await readFile(profile.inventoryPath);
  return {
    profilePath: resolvedProfile,
    companion: { profileSha256: hash(bytes), inventorySha256: hash(inventoryBytes) }
  };
}

function snapshotPaths(root, product, candidateKey) {
  const local = assertPhysicalDirectory(join(root, '.local'), { create: true, root });
  const snapshots = assertPhysicalDirectory(join(local, 'veyviz-runtime-snapshots'), { create: true, root: local });
  const productHome = assertPhysicalDirectory(join(snapshots, product), { create: true, root: snapshots });
  const snapshotRoot = join(productHome, candidateKey);
  const receiptPath = join(productHome, `selection-${candidateKey}.json`);
  if (snapshotRoot.length >= LIMIT || receiptPath.length >= LIMIT) throw Error('Veyviz snapshot path exceeds the supported short-path bound.');
  return { productHome, snapshotRoot, receiptPath };
}

function receiptFor(inputs, snapshotDigest) {
  const base = {
    schema: 'veyviz.fixed-runtime-selection.v1',
    identity: inputs.identity,
    qualificationDigest: inputs.qualificationDigest,
    candidateKey: inputs.candidateKey,
    snapshotDigest,
    releaseDigest: inputs.release.releaseDigest,
    factoryInputDigest: inputs.identity.inputDigest,
    candidateRelative: `.${sep === '\\' ? '\\' : '/'}local${sep}veyviz-runtime-snapshots${sep}${inputs.product}${sep}${inputs.candidateKey}`
  };
  return { ...base, receiptDigest: hash(canonical(base)) };
}

function verifyReceipt(path, expectedReceipt) {
  try {
    const actual = JSON.parse(readFileSync(physicalFile(path), 'utf8'));
    if (!record(actual) || canonical(actual) !== canonical(expectedReceipt))
      throw Error('Veyviz snapshot selection receipt does not match the independently derived candidate identity.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
  return true;
}

function writeReceipt(path, receipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  const fd = requireOpen(temporary);
  try { fsync(fd); } finally { close(fd); }
  try { renameSync(temporary, path); }
  catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      rmSync(temporary, { force: true });
      if (!verifyReceipt(path, receipt)) throw error;
    } else throw error;
  }
}

// Kept as tiny indirections so the descriptor lifetime is explicit on all supported Node hosts.
function requireOpen(path) { return openSync(path, fsConstants.O_RDONLY); }
function fsync(fd) { return fsyncSync(fd); }
function close(fd) { return closeSync(fd); }

function boundedSnapshot(snapshotRoot, identity, snapshotDigest) {
  return readBoundedSnapshot(snapshotRoot, { ...identity, snapshotDigest }, ARTIFACT_REGISTRY_LIMITS);
}

function validateCanonicalSnapshot(snapshotRoot, inputs) {
  assertExpectedFactoryInventory(snapshotRoot, inputs.expected);
  const manifestPath = join(snapshotRoot, 'QUADBRIDGE-SNAPSHOT.json');
  const manifest = JSON.parse(readFileSync(physicalFile(manifestPath), 'utf8'));
  const verified = verifySnapshotManifest(snapshotRoot, manifest, inputs.identity);
  const snapshotDigest = hash(canonical(manifest));
  if (verified.snapshotDigest !== snapshotDigest || manifest.releaseDigest !== inputs.release.releaseDigest)
    throw Error('Canonical Veyviz export does not match its independently derived fixed identity.');
  const snapshot = boundedSnapshot(snapshotRoot, inputs.identity, snapshotDigest);
  if (snapshot.snapshotDigest !== snapshotDigest || snapshot.releaseDigest !== inputs.release.releaseDigest)
    throw Error('Canonical Veyviz export failed its bounded snapshot verification.');
  return snapshot;
}

async function runFactory(root, product, destination, evidenceRoot) {
  const attemptId = randomUUID();
  const argv = [join(root, 'tools', 'factory.mjs'), 'assemble', product, destination];
  let stdout = '', stderr = '', childError = null;
  const child = spawn(process.execPath, argv, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2_000_000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2_000_000); });
  child.on('error', error => { childError = { name: error.name, code: error.code, message: error.message }; });
  const close = await new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  const record = {
    schema: 'veyviz.factory-attempt.v1', attemptId, argv: [process.execPath, ...argv], cwd: root,
    exitCode: close.code, signal: close.signal, spawnError: childError,
    log: `factory-${attemptId}.log`
  };
  const logPath = join(evidenceRoot, record.log);
  await writeFile(logPath, `ARGV=${JSON.stringify(record.argv)}\nCWD=${root}\nEXIT=${close.code}\nSIGNAL=${close.signal ?? 'null'}\nSPAWN_ERROR=${JSON.stringify(childError)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(evidenceRoot, `factory-${attemptId}.json`), JSON.stringify({ ...record, logPath }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (childError || close.code !== 0 || close.signal !== null)
    throw Object.assign(Error(`Fixed Veyviz export factory did not close successfully; see ${logPath}.`), { attempt: record, logPath });
  return { attempt: record, logPath };
}

async function captureAttemptInputs(root, product) {
  const current = await collectInputs(root, product);
  return {
    product: current.product,
    version: current.version,
    releaseDigest: current.release.releaseDigest,
    sourceFingerprint: current.identity.sourceFingerprint,
    inputDigest: current.identity.inputDigest,
    toolchainDigest: current.identity.toolchainDigest,
    qualificationDigest: current.qualificationDigest,
    candidateKey: current.candidateKey
  };
}

function minimalInputsEqual(expected, actual) {
  return canonical(expected) === canonical(actual);
}

async function recordSelection(path, receipt) {
  if (verifyReceipt(path, receipt)) return;
  try { lstatSync(path); throw Error('Veyviz snapshot receipt exists but is not verifiable; explicit repair is required.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeReceipt(path, receipt);
  if (!verifyReceipt(path, receipt)) throw Error('Veyviz snapshot receipt was not durably selected.');
}

/** Verify or create the deterministic factory export. No credential or enrollment files are touched here. */
export async function prepareVerifiedSnapshot({ root, product }) {
  root = resolve(root);
  const inputs = await collectInputs(root, product);
  const { productHome, snapshotRoot, receiptPath } = snapshotPaths(root, product, inputs.candidateKey);
  try {
    lstatSync(snapshotRoot);
    if (!lstatSync(snapshotRoot).isDirectory() || lstatSync(snapshotRoot).isSymbolicLink())
      throw Error('Veyviz canonical snapshot path is not a physical directory.');
    const snapshot = validateCanonicalSnapshot(snapshotRoot, inputs);
    await recordSelection(receiptPath, receiptFor(inputs, snapshot.snapshotDigest));
    return { ...inputs, snapshotDigest: snapshot.snapshotDigest, snapshotRoot, snapshot, receiptPath, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // An orphan receipt is evidence of an interrupted or modified candidate, not permission to overwrite it.
  try { lstatSync(receiptPath); throw Error('Veyviz selection receipt has no canonical snapshot; explicit repair is required.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const local = join(root, '.local');
  const evidenceRoot = assertPhysicalDirectory(join(local, 'veyviz-runtime-evidence'), { create: true, root });
  const stagePath = join(productHome, `.stage-${randomUUID()}`);
  if (stagePath.length >= LIMIT) throw Error('Veyviz factory staging path exceeds the supported short-path bound.');
  const before = {
    product: inputs.product, version: inputs.version, releaseDigest: inputs.release.releaseDigest,
    sourceFingerprint: inputs.identity.sourceFingerprint, inputDigest: inputs.identity.inputDigest,
    toolchainDigest: inputs.identity.toolchainDigest, qualificationDigest: inputs.qualificationDigest,
    candidateKey: inputs.candidateKey
  };
  await runFactory(root, product, stagePath, evidenceRoot);
  const after = await captureAttemptInputs(root, product);
  if (!minimalInputsEqual(before, after)) throw Error('Veyviz source, release, factory inputs, or recipe changed during fixed export assembly.');
  assertExpectedFactoryInventory(stagePath, inputs.expected);
  const stagedRelease = verifyReleaseArtifacts(stagePath, product, inputs.version);
  if (stagedRelease.releaseDigest !== inputs.release.releaseDigest) throw Error('Fixed export release identity changed during assembly.');
  const manifest = createSnapshotManifest(stagePath, inputs.identity);
  writeFileSync(join(stagePath, 'QUADBRIDGE-SNAPSHOT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  validateCanonicalSnapshot(stagePath, inputs);
  try { await rename(stagePath, snapshotRoot); }
  catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY' && error.code !== 'EPERM') throw error;
    const winner = validateCanonicalSnapshot(snapshotRoot, inputs);
    rmSync(stagePath, { recursive: true, force: false });
    await recordSelection(receiptPath, receiptFor(inputs, winner.snapshotDigest));
    return { ...inputs, snapshotDigest: winner.snapshotDigest, snapshotRoot, snapshot: winner, receiptPath, created: false };
  }
  const snapshot = validateCanonicalSnapshot(snapshotRoot, inputs);
  await recordSelection(receiptPath, receiptFor(inputs, snapshot.snapshotDigest));
  return { ...inputs, snapshotDigest: snapshot.snapshotDigest, snapshotRoot, snapshot, receiptPath, created: true };
}

/** Recheck an already selected immutable snapshot without assembling a replacement. */
export async function verifyPreparedSnapshot({ root, product, snapshotDigest }) {
  root = resolve(root);
  const inputs = await collectInputs(root, product);
  const { snapshotRoot, receiptPath } = snapshotPaths(root, product, inputs.candidateKey);
  const snapshot = validateCanonicalSnapshot(snapshotRoot, inputs);
  if (snapshot.snapshotDigest !== snapshotDigest)
    throw Error('Veyviz selected snapshot digest changed after preparation; select the exact verified export explicitly.');
  if (!verifyReceipt(receiptPath, receiptFor(inputs, snapshotDigest)))
    throw Error('Veyviz selected snapshot has no durable identity receipt.');
  return { ...inputs, snapshotRoot, snapshot, receiptPath };
}

function assertRuntimeLinks(runtimeRoot, links) {
  const root = resolve(runtimeRoot);
  const scope = join(root, 'node_modules', '@quadbridge');
  const expectedLinks = [...links];
  if (expectedLinks.some(name => typeof name !== 'string' || !/^@quadbridge\/[a-z][a-z0-9-]{1,47}$/.test(name)) ||
      new Set(expectedLinks).size !== expectedLinks.length)
    throw Error('Verified Veyviz runtime returned an invalid workspace-link inventory.');
  const actualLinks = readdirSync(scope).map(name => `@quadbridge/${name}`).sort();
  if (actualLinks.join('\0') !== expectedLinks.slice().sort().join('\0'))
    throw Error('Veyviz execution copy contains unexpected or missing workspace links.');
  for (const name of expectedLinks) {
    const path = join(root, 'node_modules', ...name.split('/'));
    const info = lstatSync(path);
    if (!info.isSymbolicLink()) throw Error('Veyviz execution dependency is not an in-copy workspace link.');
    const target = realpathSync(path);
    const id = name.slice('@quadbridge/'.length);
    const permitted = ['packages', 'modules', 'apps'].map(group => join(root, group, id));
    if (!permitted.some(group => target.toLowerCase() === group.toLowerCase()) ||
        !target.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`) ||
        JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name !== name)
      throw Error('Veyviz execution dependency escaped its private runtime copy.');
  }
  return true;
}

/** A child receives only exact verified bytes, copied runtime dependencies and this captured fixed wrapper. */
export function createRuntimeExecution({ root, snapshot, product }) {
  root = resolve(root);
  const executionHome = resolve(runtimePrivateRoot(root));
  if (!executionHome.toLowerCase().startsWith(`${join(root, '.local').toLowerCase()}${sep}`))
    throw Error('Veyviz execution copy is outside the product-local private root.');
  const executionRoot = join(executionHome, `${product}-${snapshot.snapshotDigest.slice(0, 12)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  if (executionRoot.length >= LIMIT) throw Error('Veyviz runtime execution path exceeds the supported short-path bound.');
  const sidecarPath = join(executionHome, 'veyviz-runtime.mjs');
  try {
    const bytes = readFileSync(physicalFile(sidecarPath));
    if (!bytes.equals(snapshot.runtimeBytes) || hash(bytes) !== snapshot.runtimeDigest)
      throw Error('Fixed Veyviz runtime sidecar differs from its captured source bytes.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { writeFileSync(sidecarPath, snapshot.runtimeBytes, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    const bytes = readFileSync(physicalFile(sidecarPath));
    if (!bytes.equals(snapshot.runtimeBytes) || hash(bytes) !== snapshot.runtimeDigest)
      throw Error('Fixed Veyviz runtime sidecar could not be verified after capture.');
  }
  try {
    const copied = copyVerifiedRuntimeSnapshot(snapshot.snapshot, executionRoot, runtimeSnapshotExpected(snapshot.snapshot));
    if (copied.snapshotDigest !== snapshot.snapshotDigest || copied.releaseDigest !== snapshot.release.releaseDigest)
      throw Error('Veyviz execution copy differs from the selected verified snapshot.');
    const links = linkCopiedRuntimeWorkspaces(executionRoot);
    assertRuntimeLinks(executionRoot, links);
    return { runtimeRoot: executionRoot, runtimeLinks: links, runtimeWrapperPath: sidecarPath, copiedSnapshot: copied };
  } catch (error) {
    error.runtimePreparation = { runtimeRoot: executionRoot, snapshotDigest: snapshot.snapshotDigest };
    throw error;
  }
}

/** Remove one closed launch copy only when its package links still point into that exact copy. */
export function removeOwnedRuntimeExecution(runtimeRoot, links) {
  const root = resolve(runtimeRoot);
  const base = resolve(dirname(root));
  if (!root.toLowerCase().startsWith(`${base.toLowerCase()}${sep}`) || root.length >= LIMIT)
    throw Error('Veyviz execution cleanup path escaped its private owner.');
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase())
    throw Error('Veyviz execution cleanup root is not a physical directory.');
  assertRuntimeLinks(root, links);
  const inspect = (directory, prefix = '') => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), rel = prefix ? `${prefix}/${name}` : name, child = lstatSync(path);
      if (child.isSymbolicLink()) {
        if (!rel.startsWith('node_modules/@quadbridge/')) throw Error('Veyviz execution cleanup found an unexpected symbolic link.');
        continue;
      }
      if (child.isDirectory()) inspect(path, rel);
      else if (!child.isFile()) throw Error('Veyviz execution cleanup found a non-regular entry.');
    }
  };
  inspect(root);
  rmSync(root, { recursive: true, force: false });
}

export async function inspectCompanion(root, product, profilePath) {
  return companionIdentity(resolve(root), product, profilePath);
}

export function verifyRuntimeExecutionLinks(runtimeRoot, links) {
  return assertRuntimeLinks(runtimeRoot, links);
}
