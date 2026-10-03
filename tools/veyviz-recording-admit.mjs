import { copyFile, mkdir, lstat, readFile, writeFile, realpath, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export async function admitRecording({ file, tenantId, id, name, captureStartUtc = null, clockUncertaintyMs = null, directory = join(root, '.local', 'veyviz-intelligence') }) {
  if (![tenantId, id].every(x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(x)) || typeof name !== 'string' || !name.trim() || name.length > 160) throw Error('Supply bounded tenant/id/name');
  if ((captureStartUtc === null) !== (clockUncertaintyMs === null) || (captureStartUtc !== null && (!/^\d{4}-\d\d-\d\dT.*Z$/.test(captureStartUtc) || !Number.isFinite(Date.parse(captureStartUtc)) || !Number.isInteger(clockUncertaintyMs) || clockUncertaintyMs < 0 || clockUncertaintyMs > 86400000))) throw Error('Supply an explicit UTC first-frame time and clock uncertainty, or neither');
  const original = resolve(file), stat = await lstat(original);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024 * 1024 || !/\.mp4$/i.test(original)) throw Error('First profile admits regular MP4 files up to128MiB');
  const home = resolve(directory), assets = join(home, 'assets'); await mkdir(assets, { recursive: true });
  const catalogPath = join(home, 'catalog.json');
  const lock = await open(catalogPath + '.lock', 'wx', 0o600);
  try {
  let catalog = { schema: 'veyviz.recording-catalog.v1', recordings: [] };
  try { catalog = JSON.parse(await readFile(catalogPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (catalog.schema !== 'veyviz.recording-catalog.v1' || !Array.isArray(catalog.recordings) || catalog.recordings.length >= 100 || catalog.recordings.some(r => r.id === id && r.tenantId === tenantId)) throw Error('Catalog is invalid/full or identity already admitted; use a new identity');
  const digest = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
  const sha256 = await digest(original), destination = join(assets, `${sha256}.mp4`);
  try { await copyFile(original, destination, 1); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await digest(destination) !== sha256 || await digest(original) !== sha256) throw Error('Recording changed during immutable admission');
  const recording = { id, tenantId, name: name.trim(), path: await realpath(destination), sha256, bytes: stat.size, captureStartUtc, clockUncertaintyMs };
  catalog.recordings.push(recording);
  // An exclusive temporary file avoids overwriting another writer's pending operation.
  const { rename } = await import('node:fs/promises'); const temporary = catalogPath + '.new';
  await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, catalogPath);
  return { catalogPath, id, sha256, bytes: stat.size };
  } finally { await lock.close(); await unlink(catalogPath + '.lock'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}, keys = { '--file': 'file', '--tenant': 'tenantId', '--id': 'id', '--name': 'name', '--capture-start-utc': 'captureStartUtc', '--clock-uncertainty-ms': 'clockUncertaintyMs', '--directory': 'directory' };
  for (let i = 2; i < process.argv.length; i++) { const key = keys[process.argv[i]]; if (!key || !process.argv[i + 1]) throw Error('Use --file MP4 --tenant ID --id ID --name NAME [--capture-start-utc UTC --clock-uncertainty-ms N]'); options[key] = key === 'clockUncertaintyMs' ? Number(process.argv[++i]) : process.argv[++i]; }
  console.log(JSON.stringify(await admitRecording(options), null, 2));
}
