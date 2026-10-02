import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { verifyProfile } = await import(pathToFileURL(join(root, 'modules/veyviz-rfdetr/dist/bridge.js')).href);
process.env.VEYVIZ_AI_PROFILE = resolve(process.env.VEYVIZ_AI_PROFILE ?? join(root, '.local/veyviz-ai/profile.json'));
await verifyProfile(process.env.VEYVIZ_AI_PROFILE);
for (const product of ['veyviz-review', 'veyviz-catalog']) {
  const release = JSON.parse(await readFile(join(root, '.artifacts', product, 'release.json'), 'utf8'));
  let files = 0;
  for (const group of [release.backend, release.web]) for (const [path, sha256] of Object.entries(group)) {
    const full = resolve(root, path);
    if (!full.startsWith(root + '/') && !full.startsWith(root + '\\')) throw Error('Unsafe release path.');
    if (hash(await readFile(full)) !== sha256) throw Error(`Release drift: ${path}`);
    files++;
  }
  console.log(JSON.stringify({ product, status: 'VERIFIED_FILES', files }));
}
console.log('AI companion file and asset verification passed. This command does not establish model accuracy or end-to-end behavior.');
