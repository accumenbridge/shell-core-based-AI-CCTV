import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SOURCE_ROOTS = ['packages', 'apps', 'modules', 'products', 'solutions', 'services/veyviz-ai', 'vendor/veyviz-ai', 'contracts/veyviz-product-ai', 'tools', 'tests', 'templates', 'profiles'];
const ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', '.nvmrc', 'AGENTS.md'];
const hash = value => createHash('sha256').update(value).digest('hex');
const skip = new Set(['dist', '__pycache__', 'node_modules', '.venv', '.git']);
async function paths(root) {
  const result = [];
  async function walk(path) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw Error(`Source inventory refuses links: ${path}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(join(root, path))).sort()) if (!skip.has(entry)) await walk(`${path}/${entry}`);
    } else if (info.isFile() && !path.endsWith('.pyc') && !path.endsWith('.tsbuildinfo')) result.push(path);
    else if (!info.isFile()) throw Error(`Unsupported inventory entry: ${path}`);
  }
  for (const path of SOURCE_ROOTS) await walk(path);
  return [...result, ...ROOT_FILES].sort();
}
export async function captureInventory(root = ROOT) {
  root = resolve(root);
  const files = [];
  for (const path of await paths(root)) {
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const generated = [];
  for (const product of ['veyviz-review', 'veyviz-catalog']) {
    const path = `.artifacts/${product}/release.json`;
    generated.push({ path, sha256: hash(await readFile(join(root, path))) });
  }
  const companion = [];
  for (const path of ['.local/veyviz-ai/profile.json', '.local/veyviz-ai/inventory.json']) companion.push({ path, sha256: hash(await readFile(join(root, path))) });
  return { schema: 'veyviz.release-inputs.v1', frameworkCommit: '3b666e9beedb2e5b336f4228091033b1377fae4d', files, generated, companion, digest: hash(JSON.stringify({ files, generated, companion })) };
}
export async function verifyInventory(file, root = ROOT) {
  const expected = JSON.parse(await readFile(file, 'utf8'));
  if (expected.schema !== 'veyviz.release-inputs.v1') throw Error('Unsupported release inventory.');
  const actual = await captureInventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Release inputs changed since capture. Inspect and qualify a new candidate.');
  return { status: 'MATCHED', digest: actual.digest, sourceFiles: actual.files.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, filename] = process.argv.slice(2);
  if (!['capture', 'verify'].includes(command) || !filename) throw Error('Use: node tools/veyviz-inventory.mjs capture|verify <repository-relative-file>');
  const full = resolve(ROOT, filename), rel = relative(ROOT, full);
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw Error('Inventory file must stay within this repository.');
  if (command === 'capture') {
    const value = await captureInventory();
    await writeFile(full, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: 'CAPTURED', digest: value.digest, sourceFiles: value.files.length }));
  } else console.log(JSON.stringify(await verifyInventory(full)));
}
