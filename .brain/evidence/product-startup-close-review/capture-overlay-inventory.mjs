import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintainedFiles } from '../../tools/verify-core.mjs';

const evidenceDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(process.argv[2]);
const phase = process.argv[3];
if (!['before-fresh-build', 'after-focused-lifecycle-tests'].includes(phase)) throw new Error(`Unsupported capture phase: ${phase}`);
const manifest = JSON.parse(await readFile(join(dirname(root), 'overlay-manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const file of await maintainedFiles(root)) {
  const bytes = await readFile(file.fullPath);
  files.push({ path: file.relativePath, bytes: bytes.length, sha256: hash(bytes) });
}
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const digest = hash(Buffer.from(files.map(row => `${row.path}\0${row.bytes}\0${row.sha256}`).join('\n')));
if (files.length !== manifest.maintainedSource.count || digest !== manifest.maintainedSource.digest || JSON.stringify(files) !== JSON.stringify(manifest.maintainedSource.files)) {
  throw new Error('Maintained source bytes differ from the exact startup-close overlay manifest');
}
const byPath = new Map(files.map(row => [row.path, row]));
const ownerPaths = ['tools/veyviz-start.mjs', 'tests/veyviz-lifecycle.test.mjs'];
const readonlyPaths = ['tools/veyviz-runtime.mjs'];
const selected = [...ownerPaths, ...readonlyPaths].map(path => {
  const row = byPath.get(path);
  if (!row) throw new Error(`Captured owner path is missing: ${path}`);
  return row;
});
const output = {
  schema: 'veyviz.startup-close-overlay-inventory.v1',
  capturedUtc: new Date().toISOString(),
  phase,
  candidateIdentity: manifest.candidateIdentity,
  baseCandidateIdentity: manifest.baseCandidateIdentity,
  snapshotRoot: root,
  maintainedFileCount: files.length,
  maintainedDigest: digest,
  ownerPaths: selected,
  publicProfile: byPath.get('profiles/local-developer.json'),
  maintainedFiles: files
};
const outputPath = join(evidenceDir, `overlay-${phase}-inventory.json`);
await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
process.stdout.write(JSON.stringify({ candidateIdentity: output.candidateIdentity, phase, maintainedFileCount: files.length, maintainedDigest: digest, ownerPathCount: ownerPaths.length, readonlyPathCount: readonlyPaths.length, outputPath }) + '\n');
