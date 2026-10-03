import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintainedFiles } from '../../tools/verify-core.mjs';

const evidenceDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const productRoot = resolve(process.argv[2]);
const baseRoot = resolve(process.argv[3]);
const baseCandidateIdentity = '2437aeb7d7627763afc3cba0081f33a2de4cac2c7ceacc31010fef1d518937a9';
const baseDigest = '48f2ae2618c23967146c1c8d6eb4f46425c678695506cd1d89bf4137ebe3389f';
const baseEvidence = resolve(productRoot, '.local/product-paging-evidence/snapshot-overlay-2437aeb7d7627763/overlay-manifest.json');
const ownerPlan = JSON.parse(await readFile(resolve(productRoot, '.brain/plans/veyviz-startup-close-work-order.json'), 'utf8'));
const ownerPaths = ['tests/veyviz-lifecycle.test.mjs', 'tools/veyviz-start.mjs'].sort();
const readonlyPaths = ['tools/veyviz-runtime.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const list = async root => {
  const files = [];
  for (const file of await maintainedFiles(root)) {
    const bytes = await readFile(file.fullPath);
    files.push({ path: file.relativePath, bytes: bytes.length, sha256: digest(bytes) });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const serial = files.map(row => `${row.path}\0${row.bytes}\0${row.sha256}`).join('\n');
  return { count: files.length, digest: digest(Buffer.from(serial)), files };
};
const baseManifest = JSON.parse(await readFile(baseEvidence, 'utf8'));
if (baseManifest.candidateIdentity !== baseCandidateIdentity || baseManifest.overlaidInventory.digest !== baseDigest || baseManifest.overlaidInventory.count !== 917) {
  throw new Error('The admitted paging snapshot identity or source inventory changed');
}
const baseInventory = await list(baseRoot);
if (baseInventory.digest !== baseDigest || baseInventory.count !== 917 || JSON.stringify(baseInventory.files) !== JSON.stringify(baseManifest.overlaidInventory.files)) {
  throw new Error('The verified paging snapshot bytes do not match its captured inventory');
}
const baseProfile = baseInventory.files.find(row => row.path === 'profiles/local-developer.json');
if (baseProfile?.sha256 !== '7278cc2167b302b326d0c4412474e75c03d75f7268d71594948069d9af8cd9a1') {
  throw new Error('The captured public local developer profile is missing or changed');
}
const baseByPath = new Map(baseInventory.files.map(row => [row.path, row]));
const overrides = new Map();
for (const path of [...ownerPaths, ...readonlyPaths]) {
  const expected = ownerPlan.source[path];
  const bytes = await readFile(join(productRoot, ...path.split('/')));
  const actual = { path, bytes: bytes.length, sha256: digest(bytes) };
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    if (ownerPaths.includes(path) && expected.sha256 !== baseByPath.get(path)?.sha256) throw new Error(`An owner baseline differs between the plan and captured source: ${path}`);
    if (readonlyPaths.includes(path)) throw new Error(`Read-only launcher dependency changed: ${path}`);
  }
  if (!baseByPath.has(path)) throw new Error(`Overlay path is absent from the reviewed base snapshot: ${path}`);
  if (ownerPaths.includes(path)) {
    if (actual.sha256 === baseByPath.get(path).sha256) throw new Error(`Expected owner repair bytes did not change: ${path}`);
    overrides.set(path, { base: baseByPath.get(path), current: actual, content: bytes });
  }
}
const expectedFiles = baseInventory.files.map(row => {
  const item = overrides.get(row.path);
  return item ? item.current : row;
});
const sourceDigest = digest(Buffer.from(expectedFiles.map(row => `${row.path}\0${row.bytes}\0${row.sha256}`).join('\n')));
const candidateIdentity = digest(Buffer.from(JSON.stringify({ schema: 'veyviz.startup-close-overlay.v1', baseCandidateIdentity, sourceDigest, paths: expectedFiles.length })));
const evidencePrefix = evidenceDir.toLowerCase().endsWith(sep) ? evidenceDir.toLowerCase() : evidenceDir.toLowerCase() + sep;
const snapshotParent = resolve(evidenceDir, `snapshot-overlay-${candidateIdentity.slice(0, 16)}`);
if (!snapshotParent.toLowerCase().startsWith(evidencePrefix)) throw new Error('Startup-close overlay destination escaped the evidence directory');
const snapshotRoot = join(snapshotParent, 'source');
await mkdir(snapshotParent);
for (const row of baseInventory.files) {
  const destination = join(snapshotRoot, ...row.path.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  const item = overrides.get(row.path);
  await (item ? writeFile(destination, item.content) : copyFile(join(baseRoot, ...row.path.split('/')), destination));
}
const dependencies = [
  ['typescript', 'typescript'], ['esbuild', 'esbuild'], [`@esbuild/${process.platform}-${process.arch}`, `@esbuild/${process.platform}-${process.arch}`], ['@types/node', '@types/node'], ['undici-types', 'undici-types']
];
await mkdir(join(snapshotRoot, 'node_modules', '@types'), { recursive: true });
for (const [name, targetName] of dependencies) {
  const link = join(snapshotRoot, 'node_modules', ...name.split('/'));
  await mkdir(dirname(link), { recursive: true });
  await symlink(join(productRoot, 'node_modules', ...targetName.split('/')), link, process.platform === 'win32' ? 'junction' : 'dir');
}
const copied = await list(snapshotRoot);
if (copied.count !== expectedFiles.length || JSON.stringify(copied.files) !== JSON.stringify(expectedFiles)) throw new Error('Startup-close overlay inventory does not match its exact two-path delta');
const profile = copied.files.find(row => row.path === 'profiles/local-developer.json');
if (profile?.sha256 !== baseProfile.sha256) throw new Error('The captured public profile was not preserved byte-for-byte');
const dependencyLinks = [];
for (const [name, targetName] of dependencies) {
  const link = join(snapshotRoot, 'node_modules', ...name.split('/'));
  dependencyLinks.push({ name, target: await realpath(link), expectedTarget: await realpath(join(productRoot, 'node_modules', ...targetName.split('/'))) });
}
if (dependencyLinks.some(row => row.target !== row.expectedTarget)) throw new Error('A build-tool link does not point to the existing workspace dependency');
const manifest = {
  schema: 'veyviz.startup-close-overlay.v1',
  capturedUtc: new Date().toISOString(),
  sourceRoot: productRoot,
  baseSnapshotRoot: baseRoot,
  baseCandidateIdentity,
  baseMaintainedSourceDigest: baseDigest,
  candidateIdentity,
  snapshotRoot,
  changedPaths: [...overrides.values()].map(row => ({ path: row.current.path, beforeSha256: row.base.sha256, afterSha256: row.current.sha256, beforeBytes: row.base.bytes, afterBytes: row.current.bytes })),
  readonlyDependencies: readonlyPaths.map(path => ({ path, sha256: baseByPath.get(path)?.sha256, bytes: baseByPath.get(path)?.bytes })),
  publicProfile: profile,
  maintainedSource: copied,
  dependencyLinks
};
await writeFile(join(snapshotParent, 'overlay-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: 'OVERLAY_READY', candidateIdentity, snapshotRoot, maintainedFiles: copied.count, sourceDigest: copied.digest, changedPaths: manifest.changedPaths.map(row => row.path), publicProfileSha256: profile.sha256 }) + '\n');
