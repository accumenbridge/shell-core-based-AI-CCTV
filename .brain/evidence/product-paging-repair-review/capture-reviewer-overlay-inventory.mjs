import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintainedFiles } from '../../tools/verify-core.mjs';

const evidenceDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(process.argv[2]);
const phase = process.argv[3];
if (!['before-fresh-build', 'after-focused-tests'].includes(phase)) throw new Error(`Unsupported inventory phase: ${phase}`);
const overlayManifest = JSON.parse(await readFile(join(dirname(root), 'overlay-manifest.json'), 'utf8'));
const baseManifest = JSON.parse(await readFile(join(evidenceDir, 'snapshot-manifest.json'), 'utf8'));
const ownerPaths = [
  'modules/veyviz-sources/src/index.ts', 'modules/veyviz-sources/src/bridge.ts', 'modules/veyviz-sources/src/protocol.ts', 'modules/veyviz-sources/module.json',
  'modules/veyviz-analysis/src/bridge.ts', 'modules/veyviz-analysis/src/protocol.ts', 'modules/veyviz-analysis/src/index.ts', 'modules/veyviz-analysis/module.json',
  'modules/veyviz-sources/src/ui.ts', 'modules/veyviz-sources/src/styles.css', 'modules/veyviz-analysis/src/ui.ts', 'modules/veyviz-analysis/src/styles.css',
  'products/veyviz-review/product.json', 'solutions/veyviz/solution.json', 'solutions/veyviz/wiring.mjs',
  'tests/veyviz-product.test.mjs', 'tests/veyviz-lifecycle.test.mjs'
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const file of await maintainedFiles(root)) {
  const bytes = await readFile(file.fullPath);
  files.push({ path: file.relativePath, bytes: bytes.length, sha256: hash(bytes) });
}
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const digest = hash(Buffer.from(files.map(row => `${row.path}\0${row.bytes}\0${row.sha256}`).join('\n')));
const current = new Map(files.map(row => [row.path, row]));
const base = new Map(baseManifest.evidenceCopiedByteInventory.files.map(row => [row.path, row]));
const changedFromBase = files.filter(row => {
  const old = base.get(row.path);
  return !old || old.bytes !== row.bytes || old.sha256 !== row.sha256;
}).map(row => row.path);
const missingFromBase = [...base.keys()].filter(path => !current.has(path));
const expectedChanges = overlayManifest.overlayPaths.map(row => row.path).sort();
if (JSON.stringify(changedFromBase) !== JSON.stringify(expectedChanges) || missingFromBase.length || files.length !== base.size) {
  throw new Error(`Overlay inventory drifted: changed=${JSON.stringify(changedFromBase)} missing=${JSON.stringify(missingFromBase)}`);
}
const ownerHashes = ownerPaths.map(path => {
  const row = current.get(path);
  if (!row) throw new Error(`Missing owner path: ${path}`);
  return row;
});
const output = {
  schema: 'veyviz.product-paging-reviewer-overlay-inventory.v1',
  capturedUtc: new Date().toISOString(),
  phase,
  candidateIdentity: overlayManifest.candidateIdentity,
  sourceSnapshotRoot: root,
  maintainedFileCount: files.length,
  maintainedDigest: digest,
  changedFromBase,
  missingFromBase,
  ownerPaths,
  ownerPathHashes: ownerHashes,
  profile: current.get('profiles/local-developer.json'),
  maintainedFiles: files
};
const outputPath = join(evidenceDir, `overlay-${phase}-inventory.json`);
await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
process.stdout.write(JSON.stringify({ candidateIdentity: output.candidateIdentity, phase, maintainedFileCount: files.length, maintainedDigest: digest, ownerPathCount: ownerPaths.length, changedFromBase, missingFromBase, outputPath }) + '\n');
