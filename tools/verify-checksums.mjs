import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'BUNDLE_SHA256.json'), 'utf8'));
let count = 0;
for (const [name, expected] of Object.entries(manifest.files)) {
    const full = resolve(root, name), rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Unsafe checksum path');
    const actual = createHash('sha256').update(await readFile(full)).digest('hex');
    if (actual !== expected)
        throw new Error(`Mismatch: ${name}`);
    count++;
}
console.log(`Verified ${count} packaged file hashes. This detects byte changes, not trusted-signature provenance.`);
