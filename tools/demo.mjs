import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { localConfiguration } from './local-profile.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const single = arg('--product'), basePort = Number(arg('--base-port', '4300'));
const nativeApiEnabled = args.includes('--native-api');
const modelAnswerProfile = arg('--model-profile');
if (nativeApiEnabled && !single) throw new Error('--native-api requires exactly one selected --product.');
if (nativeApiEnabled && Number(arg('--port', String(basePort))) === 4350) throw new Error('The selected web port must differ from the fixed native API port 4350.');
if (args.includes('--model-profile') && modelAnswerProfile !== 'ollama-qwen3-4b')
    throw new Error('Unsupported local model profile');
const data = resolve(arg('--data-root', join(root, '.local')));
if (!Number.isSafeInteger(basePort) || basePort < 1024 || basePort > 65500)
    throw new Error('Invalid base port');
spawnSync(process.execPath, [join(root, 'tools/link-workspaces.mjs')], { stdio: 'inherit' });
await mkdir(data, { recursive: true, mode: 0o700 });
const credentialsPath = join(data, 'developer-credentials.json');
let credentials;
try {
    credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
    credentials = { admin: randomBytes(15).toString('base64url'), viewer: randomBytes(15).toString('base64url'), serviceToken: randomBytes(32).toString('base64url') };
    await writeFile(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const profile = JSON.parse(await readFile(join(root, 'profiles/local-developer.json'), 'utf8'));
const selected = single ? [single] : ['neutral', 'service-desk', 'knowledge', 'combined'];
const portFor = p => single ? Number(arg('--port', String(basePort))) : basePort + ({ 'neutral': 0, 'service-desk': 10, 'knowledge': 20, 'combined': 30 }[p] ?? 0);
for (const p of selected) { const port=portFor(p); if (!Number.isSafeInteger(port) || port<1024 || port>65535) throw Error('Invalid local port'); }
const children = [];
let ending = false;
async function stop() {
    if (ending)
        return;
    ending = true;
    for (const child of children)
        child.kill('SIGTERM');
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForWebReady(state, product, port) {
    const deadline = performance.now() + 15_000;
    const url = `http://127.0.0.1:${port}/api/health`;
    while (true) {
        if (ending || state.spawnError || state.exitObserved)
            throw new Error(`${product} web process stopped before API readiness`);
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            throw new Error(`${product} API did not become ready within 15 seconds`);
        try {
            const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(500, Math.ceil(remaining)))) });
            if (response.ok && (await response.json()).api === 'READY')
                return;
        }
        catch {
            // The web listener may not have bound yet. Retry only within the existing startup window.
        }
        const delay = Math.min(100, deadline - performance.now());
        if (delay > 0)
            await sleep(delay);
    }
}
for (const product of selected) {
    if (ending)
        throw new Error('Local startup stopped');
    if (!/^[a-z][a-z0-9-]*$/.test(product))
        throw new Error('Invalid product');
    const plan = JSON.parse(await readFile(join(root, '.artifacts', product, 'plan.json'), 'utf8'));
    const { config } = localConfiguration(plan, profile, { credentials, dataDirectory: join(data, product, 'data'), basePort, deskUrl: arg('--desk-url') });
    if (modelAnswerProfile === 'ollama-qwen3-4b') config.modelAnswerProfile = 'local-ollama-qwen3-4b';
    // Reusing a local store must not recreate a removed identity or widen existing grants.
    if (existsSync(join(config.dataDirectory, 'access.sqlite'))) config.principals = [];
    const configPath = join(data, `${product}.json`);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    const launch = (flags, role, roleConfigPath = configPath) => {
        const child = spawn(process.execPath, [join(root, 'apps/runtime/dist/main.js'), '--product', product, '--config', roleConfigPath, ...flags], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
        const state = { child, role, spawnError: null, exitObserved: false, exitCode: null };
        children.push(child);
        child.once('error', error => {
            state.spawnError = error;
            if (!ending) {
                void stop();
                process.exitCode = 1;
            }
        });
        child.on('exit', code => {
            state.exitObserved = true;
            state.exitCode = code;
            if (code && !ending) {
                console.error(`${product} exited (${code}). Stopping this local solution.`);
                void stop();
                process.exitCode = 1;
            }
        });
        return state;
    };
    try {
        const webFlags = ['--port', String(portFor(product))];
        if (args.includes('--mobile-preview')) webFlags.push('--mobile-preview');
        if (nativeApiEnabled) webFlags.push('--native-api');
        const web = launch(webFlags, 'web-backend');
        await waitForWebReady(web, product, portFor(product));
        if (plan.requiresWorker) {
            if (ending || web.spawnError || web.exitObserved)
                throw new Error(`${product} web process stopped before worker startup`);
            const workerConfig = { ...config, principals: [] };
            const workerConfigPath = join(data, `${product}.worker.json`);
            await writeFile(workerConfigPath, JSON.stringify(workerConfig, null, 2) + '\n', { mode: 0o600 });
            if (ending || web.spawnError || web.exitObserved)
                throw new Error(`${product} web process stopped before worker startup`);
            launch(['--worker'], 'worker', workerConfigPath);
        }
    }
    catch (error) {
        await stop();
        throw error;
    }
    console.log(`${plan.product.title}: http://127.0.0.1:${portFor(product)}`);
}
if (nativeApiEnabled) {
    console.log(`\nNative local profile: http://127.0.0.1:4350\nCredentials are stored in the private file ${credentialsPath}.\nCtrl+C stops the local processes; records remain on disk.\n`);
} else {
    console.log(`\nLOCAL ACCOUNTS (generated once; keep private)\nadmin: ${credentials.admin}\nviewer: ${credentials.viewer}\nCredentials: ${credentialsPath}\nCtrl+C stops the local processes; records remain on disk.\n`);
}
