import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '@quadbridge/contracts';
import {
  createRuntimeExecution,
  inspectCompanion,
  prepareVerifiedSnapshot,
  removeOwnedRuntimeExecution,
  verifyPreparedSnapshot,
  verifyRuntimeExecutionLinks
} from './veyviz-snapshot.mjs';

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
  const selected = await prepareVerifiedSnapshot({ root, product });
  const companion = await inspectCompanion(root, product, profilePath);
  const launcher = {
    schema: 'veyviz.launch-identity.v1',
    snapshotDigest: selected.snapshotDigest,
    snapshotIdentity: selected.identity,
    releaseDigest: selected.release.releaseDigest,
    factoryInputDigest: selected.identity.inputDigest,
    qualificationDigest: selected.qualificationDigest,
    sourceFingerprint: selected.identity.sourceFingerprint,
    toolchainDigest: selected.identity.toolchainDigest,
    recipeVersion: selected.identity.recipeVersion,
    runtimeWrapperSha256: selected.runtimeDigest,
    startSha256: selected.recipe.files['tools/veyviz-start.mjs'],
    snapshotHelperSha256: selected.recipe.files['tools/veyviz-snapshot.mjs'],
    companion: companion.companion
  };
  const fingerprint = hash(canonical(launcher));
  const productHome = join(dataRoot, product);
  const generations = join(productHome, 'generations');
  const credentialsPath = join(productHome, 'developer-credentials.json');
  await mkdir(productHome, { recursive: true, mode: 0o700 });
  let credentials;
  try { credentials = JSON.parse(await readFile(credentialsPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (existsSync(generations) && (await readdir(generations)).length) throw Error('Existing enrollment has lost its credentials file; repair explicitly.');
    credentials = null;
  }
  if (credentials && (typeof credentials.admin !== 'string' || credentials.admin.length < 12 || typeof credentials.viewer !== 'string' || credentials.viewer.length < 12)) throw Error('Invalid local credentials file.');
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
  const runtimeExecution = createRuntimeExecution({ root, snapshot: selected, product });
  try {
    const current = await verifyPreparedSnapshot({ root, product, snapshotDigest: selected.snapshotDigest });
    const currentCompanion = await inspectCompanion(root, product, profilePath);
    if (canonical(companion) !== canonical(currentCompanion))
      throw Error('Veyviz companion profile or inventory changed while preparing the fixed runtime.');
    if (current.snapshot.releaseDigest !== selected.release.releaseDigest)
      throw Error('Veyviz selected release changed while preparing the fixed runtime.');
    if (!credentials) {
      credentials = { admin: randomBytes(24).toString('base64url'), viewer: randomBytes(24).toString('base64url') };
      await writeFile(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (!existingGeneration) await writeFile(enrollmentPath, JSON.stringify({ schema: 'veyviz.enrollment.v1', fingerprint, status: 'PENDING' }) + '\n', { flag: 'wx', mode: 0o600 });
    const all = ['platform.shell.read', 'platform.modules.manage', ...selected.plan.permissions];
    const read = ['platform.shell.read', ...new Set(selected.plan.modules.flatMap(m => m.routes.filter(r => r.kind === 'read').map(r => r.permission)))];
    const principals = existsSync(join(dataDirectory, 'access.sqlite')) ? [] : [
      { id: 'admin', password: credentials.admin, grants: ['alpha', 'beta'].map(tenantId => ({ tenantId, permissions: all })) },
      { id: 'viewer', password: credentials.viewer, grants: [{ tenantId: 'alpha', permissions: read }] }
    ];
    const configPath = join(generation, 'runtime.json');
    const config = { instanceId: `${product}-local`, dataDirectory, principals };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(generation, 'generation.json'), JSON.stringify({
      schema: 'veyviz.local-generation.v1', product, fingerprint,
      producerRoot: root, runtimeRoot: runtimeExecution.runtimeRoot,
      releaseSha256: selected.release.releaseDigest, snapshotDigest: selected.snapshotDigest,
      companion: companion.companion, launcher
    }, null, 2) + '\n');
    return {
      root, producerRoot: root, runtimeRoot: runtimeExecution.runtimeRoot,
      runtimeLinks: runtimeExecution.runtimeLinks, runtimeWrapperPath: runtimeExecution.runtimeWrapperPath,
      snapshotRoot: selected.snapshotRoot, snapshotDigest: selected.snapshotDigest,
      product, profilePath: needsAI ? companion.profilePath : null, companion: companion.companion,
      fingerprint, generation, configPath, credentialsPath, dataDirectory, enrollmentPath, ownerPath
    };
  } catch (error) {
    error.runtimePreparation = { runtimeRoot: runtimeExecution.runtimeRoot, snapshotDigest: selected.snapshotDigest };
    throw error;
  }
}

/** Own a live child handle; request graceful cleanup over IPC and observe close. */
export async function startProduct(options = {}) {
  const port = options.port ?? 4480;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('Invalid port.');
  const prepared = await prepareProduct(options);
  try { verifyRuntimeExecutionLinks(prepared.runtimeRoot, prepared.runtimeLinks); }
  catch (error) {
    error.runtimePreparation = { runtimeRoot: prepared.runtimeRoot, snapshotDigest: prepared.snapshotDigest };
    throw error;
  }
  const ownerToken = randomUUID();
  // Exclusive claim survives parent/child interruption. Never infer closure from age or PID.
  const claimPath = prepared.ownerPath + '.claim';
  await writeFile(claimPath, ownerToken, { flag: 'wx', mode: 0o600 });
  const ownerRecord = { schema: 'veyviz.owner.v1', fingerprint: prepared.fingerprint, token: ownerToken, state: 'ACTIVE' };
  await writeFile(prepared.ownerPath, JSON.stringify({ ...ownerRecord, producerRoot: prepared.producerRoot, runtimeRoot: prepared.runtimeRoot, snapshotDigest: prepared.snapshotDigest }) + '\n', { mode: 0o600 });
  let child;
  try {
    verifyRuntimeExecutionLinks(prepared.runtimeRoot, prepared.runtimeLinks);
    child = fork(prepared.runtimeWrapperPath, [prepared.runtimeRoot, prepared.product, prepared.configPath, String(port)], {
      cwd: prepared.runtimeRoot, silent: true, windowsHide: true,
      env: { ...process.env, ...(prepared.profilePath ? { VEYVIZ_AI_PROFILE: prepared.profilePath } : {}), NODE_ENV: 'development' }
    });
  } catch (error) {
    try {
      const current = JSON.parse(await readFile(prepared.ownerPath, 'utf8'));
      if (current.token === ownerToken) {
        const temporary = prepared.ownerPath + '.' + ownerToken + '.unknown';
        await writeFile(temporary, JSON.stringify({ ...current, state: 'UNKNOWN', forkError: error.code ?? error.name }) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, prepared.ownerPath);
      }
    } catch (recordError) { error.ownerRecordError = recordError.message; }
    error.runtimePreparation = { runtimeRoot: prepared.runtimeRoot, snapshotDigest: prepared.snapshotDigest, claimPath };
    throw error;
  }
  let diagnostics = '', closed = false, cleanup = false, stopRequested = false;
  const appendDiagnostic = message => { diagnostics = (diagnostics + message).slice(-8192); };
  const capture = chunk => appendDiagnostic(chunk.toString());
  const describeError = error => error instanceof Error ? `${error.code ? `${error.code}: ` : ''}${error.message}` : String(error);
  child.stderr.on('data', capture); child.stdout.on('data', capture);
  child.on('message', message => { if (message?.type === 'stopped' && message.cleanup === true) cleanup = true; });
  // A child/control error is diagnostic only; its original close event owns completion.
  child.on('error', error => appendDiagnostic(`Owned child error: ${describeError(error)}\n`));
  const completion = new Promise((resolveClose, reject) => {
    child.once('close', async (code, signal) => {
      closed = true;
      try {
        const record = JSON.parse(await readFile(prepared.ownerPath, 'utf8'));
        if (record.token !== ownerToken) throw Error('Owned generation marker changed; closure cannot be published.');
        const state = cleanup && code === 0 && signal === null ? 'CLOSED' : 'UNKNOWN';
        let runtimeCopyCleanup = 'RETAINED_UNKNOWN';
        if (state === 'CLOSED') {
          try {
            removeOwnedRuntimeExecution(prepared.runtimeRoot, prepared.runtimeLinks);
            runtimeCopyCleanup = 'REMOVED';
          } catch (cleanupError) {
            runtimeCopyCleanup = 'RETAINED_AFTER_CLEANUP_ERROR';
            appendDiagnostic(`Runtime copy retained after verified process close: ${cleanupError.message}\n`);
          }
        }
        const temporary = prepared.ownerPath + '.' + ownerToken;
        await writeFile(temporary, JSON.stringify({ ...record, state, runtimeCopyCleanup }) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, prepared.ownerPath);
        if (state === 'CLOSED') {
          // Retain the claim as provenance under a unique name; no recursive deletion.
          await rename(claimPath, claimPath + '.' + ownerToken + '.closed');
        }
        resolveClose({ code, signal, cleanup, runtimeCopyCleanup });
      } catch (error) { reject(error); }
    });
  });
  // Keep the rejection observed even if startup fails first.
  completion.catch(() => {});
  const stop = async () => {
    if (!stopRequested && !closed) {
      stopRequested = true;
      if (child.connected) {
        try {
          child.send({ type: 'stop' }, error => {
            if (error) appendDiagnostic(`Stop IPC send failed: ${describeError(error)}\n`);
          });
        } catch (error) { appendDiagnostic(`Stop IPC send threw: ${describeError(error)}\n`); }
      } else appendDiagnostic('Stop IPC not sent: child was already disconnected.\n');
    }
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
