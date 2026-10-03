import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintainedFiles, shouldIncludeMaintainedPath } from '../../tools/verify-core.mjs';

const evidenceDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sourceRoot = resolve(process.argv[2]);
const baseRoot = resolve(process.argv[3]);
const overlayPaths = [
  'modules/veyviz-analysis/src/ui.ts',
  'modules/veyviz-sources/src/index.ts',
  'tests/veyviz-product.test.mjs'
].sort();
const baseManifest = JSON.parse(await readFile(join(evidenceDir, 'snapshot-manifest.json'), 'utf8'));
const baseCandidateIdentity = 'b6a3ed725d39ad1e2d77cf6f2e2aa4b07a78e72df53f0427b08f578975489663';
if (baseManifest.candidateIdentity !== baseCandidateIdentity) throw new Error('The reviewed base snapshot identity changed');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readInventory = async root => {
  const rows = [];
  for (const file of await maintainedFiles(root)) {
    const bytes = await readFile(file.fullPath);
    rows.push({ path: file.relativePath, bytes: bytes.length, sha256: hash(bytes) });
  }
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const serial = rows.map(row => `${row.path}\0${row.bytes}\0${row.sha256}`).join('\n');
  return { count: rows.length, digest: hash(Buffer.from(serial)), files: rows };
};
const baseInventory = await readInventory(baseRoot);
if (baseInventory.count !== baseManifest.evidenceCopiedByteInventory.count || baseInventory.digest !== baseManifest.evidenceCopiedByteInventory.digest) {
  throw new Error('The base snapshot source bytes no longer match their recorded inventory');
}
const baseByPath = new Map(baseInventory.files.map(row => [row.path, row]));
const overrides = new Map();
for (const path of overlayPaths) {
  if (!shouldIncludeMaintainedPath(path) || !baseByPath.has(path)) throw new Error(`Overlay path is not an existing maintained base path: ${path}`);
  const before = await readFile(join(baseRoot, ...path.split('/')));
  const after = await readFile(join(sourceRoot, ...path.split('/')));
  overrides.set(path, { beforeSha256: hash(before), afterSha256: hash(after), bytes: after });
}
const expectedFiles = baseInventory.files.map(row => {
  const override = overrides.get(row.path);
  return override ? { path: row.path, bytes: override.bytes.length, sha256: override.afterSha256 } : row;
});
const expectedSerial = expectedFiles.map(row => `${row.path}\0${row.bytes}\0${row.sha256}`).join('\n');
const sourceDigest = hash(Buffer.from(expectedSerial));
const candidateIdentity = hash(Buffer.from(JSON.stringify({ schema: 'veyviz.product-paging-reviewer-overlay.v1', baseCandidateIdentity, sourceDigest, paths: expectedFiles.length })));
const parentRoot = resolve(evidenceDir, `snapshot-overlay-${candidateIdentity.slice(0, 16)}`);
const evidencePrefix = evidenceDir.toLowerCase().endsWith(sep) ? evidenceDir.toLowerCase() : evidenceDir.toLowerCase() + sep;
if (!parentRoot.toLowerCase().startsWith(evidencePrefix)) throw new Error('Overlay destination escaped the evidence directory');
const destination = join(parentRoot, 'source');
await mkdir(parentRoot);
for (const row of baseInventory.files) {
  const output = join(destination, ...row.path.split('/'));
  await mkdir(dirname(output), { recursive: true });
  const override = overrides.get(row.path);
  if (override) await import('node:fs/promises').then(fs => fs.writeFile(output, override.bytes));
  else await copyFile(join(baseRoot, ...row.path.split('/')), output);
}
const dependencies = [
  ['typescript', 'typescript'], ['esbuild', 'esbuild'], [`@esbuild/${process.platform}-${process.arch}`, `@esbuild/${process.platform}-${process.arch}`], ['@types/node', '@types/node'], ['undici-types', 'undici-types']
];
await mkdir(join(destination, 'node_modules', '@types'), { recursive: true });
for (const [name, targetName] of dependencies) {
  const linkPath = join(destination, 'node_modules', ...name.split('/'));
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(join(sourceRoot, 'node_modules', ...targetName.split('/')), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}
const copiedInventory = await readInventory(destination);
if (copiedInventory.count !== expectedFiles.length || JSON.stringify(copiedInventory.files) !== JSON.stringify(expectedFiles)) {
  throw new Error('The reviewer overlay copy does not match its expected maintained-file inventory');
}
const profilePath = 'profiles/local-developer.json';
if (!copiedInventory.files.some(row => row.path === profilePath)) throw new Error('The reviewed public local developer profile is missing from the overlay');
const dependencyLinks = [];
for (const [name, targetName] of dependencies) {
  const linkPath = join(destination, 'node_modules', ...name.split('/'));
  dependencyLinks.push({ name, target: await realpath(linkPath), expectedTarget: await realpath(join(sourceRoot, 'node_modules', ...targetName.split('/'))) });
}
if (dependencyLinks.some(link => link.target !== link.expectedTarget)) throw new Error('An isolated dependency link resolves outside the configured immutable workspace tools');
const manifest = {
  schema: 'veyviz.product-paging-reviewer-overlay.v1',
  capturedUtc: new Date().toISOString(),
  sourceRoot,
  baseSnapshotRoot: baseRoot,
  baseCandidateIdentity,
  candidateIdentity,
  snapshotRoot: destination,
  overlayPaths: overlayPaths.map(path => ({ path, baseSha256: overrides.get(path).beforeSha256, overlaySha256: overrides.get(path).afterSha256 })),
  baseInventory: { count: baseInventory.count, digest: baseInventory.digest },
  overlaidInventory: { count: copiedInventory.count, digest: copiedInventory.digest, files: copiedInventory.files },
  dependencyLinks
};
await import('node:fs/promises').then(fs => fs.writeFile(join(parentRoot, 'overlay-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'));
process.stdout.write(JSON.stringify({ status: 'OVERLAY_READY', snapshotRoot: destination, candidateIdentity, sourceDigest: copiedInventory.digest, sourceFiles: copiedInventory.count, overlayPaths }) + '\n');
