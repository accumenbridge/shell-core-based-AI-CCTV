import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '@quadbridge/contracts';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Local product enrollment only. Grants come from the exact selected plan. */
export async function prepareProduct({ root = ROOT, product = 'veyviz-review', dataRoot = join(root, '.local', 'veyviz'), profilePath = join(root, '.local', 'veyviz-ai', 'profile.json') } = {}) {
  if (!['veyviz-review', 'veyviz-catalog'].includes(product)) throw Error('Select a reviewed Veyviz product.');
  if (process.env.NODE_ENV === 'production') throw Error('This launcher supports the local developer profile only.');
  root = resolve(root); dataRoot = resolve(dataRoot); profilePath = resolve(profilePath);
  const releaseBytes = await readFile(join(root, '.artifacts', product, 'release.json'));
  const release = JSON.parse(releaseBytes.toString('utf8'));
  const plan = JSON.parse(await readFile(join(root, '.artifacts', product, 'plan.json'), 'utf8'));
  if (release.product !== product || plan.product.id !== product || hash(canonical(plan)) !== release.planDigest) throw Error('Product plan identity or release digest mismatch.');
  const needsAI = plan.modules.some(m => m.provides.includes('veyviz.recorded-analysis.run.v1'));
  let companion = null;
  if (needsAI) {
    const bytes = await readFile(profilePath);
    const profile = JSON.parse(bytes.toString('utf8'));
    if (profile.schema !== 'veyviz.recorded-profile.v1') throw Error('Unsupported AI profile. Run the reviewed companion setup.');
    companion = { profileSha256: hash(bytes), inventorySha256: hash(await readFile(profile.inventoryPath)) };
  }
  const launcher = { start: hash(await readFile(join(ROOT, 'tools/veyviz-start.mjs'))), runtime: hash(await readFile(join(ROOT, 'tools/veyviz-runtime.mjs'))) };
  const fingerprint = hash(JSON.stringify({ release: hash(releaseBytes), companion, launcher }));
  const productHome = join(dataRoot, product);
  const generations = join(productHome, 'generations');
  const credentialsPath = join(productHome, 'developer-credentials.json');
  await mkdir(productHome, { recursive: true, mode: 0o700 });
  let credentials;
  try { credentials = JSON.parse(await readFile(credentialsPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (existsSync(generations) && (await readdir(generations)).length) throw Error('Existing enrollment has lost its credentials file; repair explicitly.');
    credentials = { admin: randomBytes(24).toString('base64url'), viewer: randomBytes(24).toString('base64url') };
    await writeFile(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (typeof credentials.admin !== 'string' || credentials.admin.length < 12 || typeof credentials.viewer !== 'string' || credentials.viewer.length < 12) throw Error('Invalid local credentials file.');
  const generation = join(generations, fingerprint);
  const dataDirectory = join(generation, 'data');
  const enrollmentPath = join(generation, 'enrollment.json');
  const ownerPath = join(generation, 'owner.json');
  const existingGeneration = existsSync(generation);
  if (existingGeneration) {
    let enrolled;
    try { enrolled = JSON.parse(await readFile(enrollmentPath, 'utf8')); }
    catch { throw Error('Existing generation has incomplete enrollment; explicit repair is required.'); }
    if (enrolled.schema !== 'veyviz.enrollment.v1' || enrolled.fingerprint !== fingerprint || enrolled.status !== 'COMPLETE' || !existsSync(join(dataDirectory, 'access.sqlite')))
      throw Error('Existing generation enrollment or access owner is incomplete; refusing to reseed identities.');
    let priorOwner;
    try { priorOwner = JSON.parse(await readFile(ownerPath, 'utf8')); }
    catch { throw Error('Existing generation has no verified prior owner closure; explicit repair is required.'); }
    if (priorOwner.schema !== 'veyviz.owner.v1' || priorOwner.fingerprint !== fingerprint || priorOwner.state !== 'CLOSED')
      throw Error('The prior generation owner is active or cleanup is unconfirmed; refusing to relaunch.');
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  if (!existingGeneration) await writeFile(enrollmentPath, JSON.stringify({ schema: 'veyviz.enrollment.v1', fingerprint, status: 'PENDING' }) + '\n', { flag: 'wx', mode: 0o600 });
  const all = ['platform.shell.read', 'platform.modules.manage', ...plan.permissions];
  const read = ['platform.shell.read', ...new Set(plan.modules.flatMap(m => m.routes.filter(r => r.kind === 'read').map(r => r.permission)))];
  const principals = existsSync(join(dataDirectory, 'access.sqlite')) ? [] : [
    { id: 'admin', password: credentials.admin, grants: ['alpha', 'beta'].map(tenantId => ({ tenantId, permissions: all })) },
    { id: 'viewer', password: credentials.viewer, grants: [{ tenantId: 'alpha', permissions: read }] }
  ];
  const configPath = join(generation, 'runtime.json');
  const config = { instanceId: `${product}-local`, dataDirectory, principals };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(generation, 'generation.json'), JSON.stringify({ schema: 'veyviz.local-generation.v1', product, fingerprint, releaseSha256: hash(releaseBytes), companion, launcher }, null, 2) + '\n');
  return { root, product, profilePath: needsAI ? profilePath : null, fingerprint, generation, configPath, credentialsPath, dataDirectory, enrollmentPath, ownerPath };
}

/** Own a live child handle; request graceful cleanup over IPC and observe close. */
export async function startProduct(options = {}) {
  const port = options.port ?? 4480;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('Invalid port.');
  const prepared = await prepareProduct(options);
  const ownerToken = randomUUID();
  // Exclusive claim survives parent/child interruption. Never infer closure from age or PID.
  const claimPath = prepared.ownerPath + '.claim';
  await writeFile(claimPath, ownerToken, { flag: 'wx', mode: 0o600 });
  const ownerRecord = { schema: 'veyviz.owner.v1', fingerprint: prepared.fingerprint, token: ownerToken, state: 'ACTIVE' };
  await writeFile(prepared.ownerPath, JSON.stringify(ownerRecord) + '\n', { mode: 0o600 });
  const child = fork(join(ROOT, 'tools', 'veyviz-runtime.mjs'), [prepared.root, prepared.product, prepared.configPath, String(port)], {
    cwd: prepared.root, silent: true, windowsHide: true,
    env: { ...process.env, ...(prepared.profilePath ? { VEYVIZ_AI_PROFILE: prepared.profilePath } : {}), NODE_ENV: 'development' }
  });
  let diagnostics = '', closed = false, cleanup = false, stopRequested = false;
  const capture = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); };
  child.stderr.on('data', capture); child.stdout.on('data', capture);
  child.on('message', message => { if (message?.type === 'stopped' && message.cleanup === true) cleanup = true; });
  const completion = new Promise((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      closed = true;
      try {
        const record = JSON.parse(await readFile(prepared.ownerPath, 'utf8'));
        if (record.token !== ownerToken) throw Error('Owned generation marker changed; closure cannot be published.');
        const state = cleanup && code === 0 && signal === null ? 'CLOSED' : 'UNKNOWN';
        const temporary = prepared.ownerPath + '.' + ownerToken;
        await writeFile(temporary, JSON.stringify({ ...record, state }) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, prepared.ownerPath);
        if (state === 'CLOSED') {
          // Retain the claim as provenance under a unique name; no recursive deletion.
          await rename(claimPath, claimPath + '.' + ownerToken + '.closed');
        }
        resolveClose({ code, signal, cleanup });
      } catch (error) { reject(error); }
    });
  });
  // Keep the rejection observed even if startup fails first.
  completion.catch(() => {});
  const stop = async () => {
    if (!stopRequested && !closed && child.connected) { child.send({ type: 'stop' }); stopRequested = true; }
    let timer;
    try {
      const result = await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Cleanup not observed within 120 seconds; owned child retained, no PID-based recovery attempted.')), 120_000); })]);
      if (result.code !== 0 || !result.cleanup) throw Error(`Product closure was not proven (exit ${result.code}); ${diagnostics}`);
      return result;
    } finally { clearTimeout(timer); }
  };
  const owner = { ...prepared, child, completion, stop, get diagnostics() { return diagnostics; } };
  try {
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { tidy(); reject(Error('Product startup did not become ready within 120 seconds.')); }, 120_000);
      const message = m => { if (m?.type === 'ready') { tidy(); resolveReady(m); } else if (m?.type === 'failed') { tidy(); reject(Error(m.message)); } };
      const close = () => { tidy(); reject(Error(`Product stopped during startup. ${diagnostics}`)); };
      const error = e => { tidy(); reject(e); };
      const tidy = () => { clearTimeout(timer); child.off('message', message); child.off('close', close); child.off('error', error); };
      child.on('message', message); child.once('close', close); child.once('error', error);
    });
    return { ...owner, url: ready.url, get diagnostics() { return diagnostics; } };
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      const failure = new AggregateError([error, cleanupError], 'Startup and cleanup failed; the original owner remains available on error.owner.');
      failure.owner = owner;
      throw failure;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('npm run veyviz -- [--product veyviz-review|veyviz-catalog] [--port 4480] [--data-root PATH] [--profile PATH]\nBuild first. AI review also requires python services/veyviz-ai/setup.py. Ctrl+C requests graceful shutdown.');
  } else {
    const options = {};
    const fields = { '--product': 'product', '--port': 'port', '--data-root': 'dataRoot', '--profile': 'profilePath' };
    for (let i = 0; i < args.length; i++) {
      if (!fields[args[i]] || !args[i + 1]) throw Error('Unknown or incomplete launcher option. Use --help.');
      const field = fields[args[i++]]; options[field] = field === 'port' ? Number(args[i]) : args[i];
    }
    const app = await startProduct(options);
    console.log(`Veyviz ready: ${app.url}\nProduct: ${app.product}\nGeneration: ${app.fingerprint}\nPrivate local sign-in credentials: ${app.credentialsPath}\nCtrl+C stops owned work. Results remain in this generation.`);
    let ending = false;
    const stop = async () => { if (ending) return; ending = true; try { await app.stop(); } catch (error) { console.error(error.message); process.exitCode = 1; } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const result = await app.completion;
    if (!ending || result.code !== 0 || !result.cleanup) process.exitCode = 1;
  }
}
