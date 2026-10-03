import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const evidenceDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(process.argv[2]);
const phase = process.argv[3];
if (!phase || !/^[a-z0-9-]+$/.test(phase)) throw new Error('A lowercase phase name is required');
const paths = [
  'tools/veyviz-start.mjs',
  'tests/veyviz-lifecycle.test.mjs',
  'tools/veyviz-runtime.mjs'
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const path of paths) {
  const bytes = await readFile(join(root, ...path.split('/')));
  files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
const output = { schema: 'veyviz.startup-close-owner-file-capture.v1', capturedUtc: new Date().toISOString(), phase, root, files };
const outputPath = join(evidenceDir, `${phase}-owner-capture.json`);
await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
process.stdout.write(JSON.stringify({ phase, root, files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), outputPath }) + '\n');
