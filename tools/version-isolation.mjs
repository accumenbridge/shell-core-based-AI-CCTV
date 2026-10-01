/** Optional acceptance against an actual older extracted release. No package publication is implied. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2), i = args.indexOf('--older-root');
if (i < 0 || !args[i + 1])
    throw Error('Supply --older-root <extracted Foundation 0.1 source>');
const older = resolve(args[i + 1]), temp = await mkdtemp(join(tmpdir(), 'qb-versions-')), children = [];
const report = { status: 'NOT_RUN', scope: 'Two actual local release snapshots and HTTP runtimes; NOT published package upgrades, shared-data rolling migration, browser or production qualification', at: new Date().toISOString() };
try {
    const setup = spawnSync(process.execPath, [join(older, 'tools/link-workspaces.mjs')], { cwd: older, encoding: 'utf8' });
    if (setup.status !== 0)
        throw Error(setup.stderr);
    const fingerprint = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
    const oldCode = join(older, 'packages/web-shell/dist/index.js'), before = await fingerprint(oldCode);
    const password = randomBytes(20).toString('base64url');
    async function start(source, name) {
        const config = join(temp, name + '.json');
        await writeFile(config, JSON.stringify({ instanceId: name, dataDirectory: join(temp, name), principals: [{ id: 'probe', password, grants: [{ tenantId: 'tenant-a', permissions: ['platform.shell.read'] }] }] }), { mode: 0o600 });
        const child = spawn(process.execPath, [join(source, 'apps/runtime/dist/main.js'), '--product', 'neutral', '--config', config, '--port', '0'], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        return await new Promise((ok, bad) => { let buffer = '', errors = ''; const timer = setTimeout(() => bad(Error('Runtime readiness timeout')), 10000); child.stderr.on('data', d => errors += d); child.stdout.on('data', d => { buffer += d; for (const line of buffer.split('\n')) {
            try {
                const r = JSON.parse(line);
                if (r.url) {
                    clearTimeout(timer);
                    ok(r.url);
                    return;
                }
            }
            catch { }
        } }); child.once('exit', c => { clearTimeout(timer); bad(Error('Runtime exited ' + c + ' ' + errors)); }); });
    }
    async function bootstrap(url) { const login = await fetch(url + '/api/session', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'probe', password }) }); if (login.status !== 200)
        throw Error('Login failed'); const r = await fetch(url + '/api/bootstrap', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } }); if (r.status !== 200)
        throw Error('Bootstrap failed'); return r.json(); }
    const oldUrl = await start(older, 'neutral-old'), first = await bootstrap(oldUrl);
    const newUrl = await start(root, 'neutral-new'), next = await bootstrap(newUrl), still = await bootstrap(oldUrl);
    if (first.product.version !== '0.1.0' || next.product.version !== '0.2.0' || still.product.version !== '0.1.0' || before !== await fingerprint(oldCode))
        throw Error('Release isolation mismatch');
    Object.assign(report, { status: 'PASSED_LOCAL_VERSION_ISOLATION', olderVersion: first.product.version, newerVersion: next.product.version, olderAfterNewStartup: still.product.version, oldExecutableUnchanged: true });
}
catch (e) {
    report.status = 'FAILED';
    report.error = e.message;
    process.exitCode = 1;
}
finally {
    await Promise.all(children.map(c => new Promise(r => { if (c.exitCode !== null)
        return r(); c.once('exit', r); c.kill('SIGTERM'); })));
    await rm(temp, { recursive: true, force: true });
    await mkdir(join(root, 'evidence'), { recursive: true });
    await writeFile(join(root, 'evidence/version_isolation.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
