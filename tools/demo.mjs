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
for (const product of selected) {
    if (!/^[a-z][a-z0-9-]*$/.test(product))
        throw new Error('Invalid product');
    const plan = JSON.parse(await readFile(join(root, '.artifacts', product, 'plan.json'), 'utf8'));
    const { config } = localConfiguration(plan, profile, { credentials, dataDirectory: join(data, product, 'data'), basePort, deskUrl: arg('--desk-url') });
    // Reusing a local store must not recreate a removed identity or widen existing grants.
    if (existsSync(join(config.dataDirectory, 'access.sqlite'))) config.principals = [];
    const configPath = join(data, `${product}.json`);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    const launch = flags => {
        const child = spawn(process.execPath, [join(root, 'apps/runtime/dist/main.js'), '--product', product, '--config', configPath, ...flags], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
        children.push(child);
        child.on('exit', code => {
            if (code && !ending) {
                console.error(`${product} exited (${code}). Stopping this local solution.`);
                void stop();
                process.exitCode = 1;
            }
        });
    };
    launch(['--port', String(portFor(product))]);
    if (plan.requiresWorker)
        launch(['--worker']);
    console.log(`${plan.product.title}: http://127.0.0.1:${portFor(product)}`);
}
console.log(`\nLOCAL ACCOUNTS (generated once; keep private)\nadmin: ${credentials.admin}\nviewer: ${credentials.viewer}\nCredentials: ${credentialsPath}\nCtrl+C stops the local processes; records remain on disk.\n`);
