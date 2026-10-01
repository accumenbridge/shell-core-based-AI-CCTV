import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, copyFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { frontendClosure } from './frontend-closure.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const linked = spawnSync(process.execPath, [join(root, 'tools/link-workspaces.mjs')], { cwd: root, stdio: 'inherit' });
if (linked.error)
    throw new Error(`Workspace linking could not start: ${linked.error.message}`);
if (linked.status !== 0)
    process.exit(linked.status ?? 1);
const compiler = join(root, 'node_modules/typescript/bin/tsc');
const moduleNames = (await readdir(join(root, 'modules'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
const refs = (await readdir(join(root, 'packages'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => ({ path: `packages/${d.name}` }));
const appRefs = (await readdir(join(root, 'apps'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => ({ path: `apps/${d.name}` }));
await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [...refs, ...moduleNames.map(m => ({ path: `modules/${m}` })), ...appRefs] }, null, 2) + '\n');
const compilation = spawnSync(process.execPath, [compiler, '-b', '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
if (compilation.status !== 0)
    process.exit(compilation.status ?? 1);
await copyFile(join(root, 'packages/web-shell/src/shell.css'), join(root, 'packages/web-shell/dist/shell.css'));
const { resolve } = await import('../packages/composition/dist/index.js');
const { canonical } = await import('../packages/contracts/dist/index.js');
const { deriveRuntimeWorkspaceClosure } = await import('../packages/composition/dist/workspace-closure.js');
const catalog = [];
for (const name of moduleNames) {
    if (!/^[a-z][a-z0-9-]*$/.test(name))
        throw new Error('Unsafe module directory');
    const manifest = JSON.parse(await readFile(join(root, 'modules', name, 'module.json'), 'utf8'));
    if (manifest.id !== name)
        throw new Error('Module directory/identity mismatch');
    for (const asset of manifest.browserAssets ?? []) {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(css|svg|png|jpg|jpeg|webp|gif|json|txt|woff2)$/.test(asset) || asset.split('/').some(s => s === '..' || s === '.' || !s))
            throw Error('Unsafe declared browser asset');
        const declared = join(root, 'modules', name, 'src', asset);
        if (await realpath(declared) !== declared)
            throw Error('Declared browser assets must not follow symlinks');
        await mkdir(dirname(join(root, 'modules', name, 'dist', asset)), { recursive: true });
        await copyFile(join(root, 'modules', name, 'src', asset), join(root, 'modules', name, 'dist', asset));
    }
    catalog.push({ name, manifest });
}
await mkdir(join(root, 'generated'), { recursive: true });
await writeFile(join(root, 'generated/catalog.mjs'), `// Generated from reviewed local module manifests. No runtime URL imports.\nexport const catalog = [\n${catalog.map(c => `  {manifest:${JSON.stringify(c.manifest)}, load:()=>import('../modules/${c.name}/dist/index.js')}`).join(',\n')}\n];\n`);
const solutions = (await readdir(join(root, 'solutions'), { withFileTypes: true })).filter(s => s.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
await writeFile(join(root, 'generated/solution-catalog.mjs'), `// Product-owned, statically approved solution wiring.\nexport const solutions={${solutions.map(s => `${JSON.stringify(s.name)}:()=>import('../solutions/${s.name}/wiring.mjs')`).join(',')}};\n`);
for (const directory of await readdir(join(root, 'products'), { withFileTypes: true })) {
    if (!directory.isDirectory())
        continue;
    const name = directory.name;
    const product = JSON.parse(await readFile(join(root, 'products', name, 'product.json'), 'utf8'));
    if (name !== product.id)
        throw new Error('Product directory/identity mismatch');
    const plan = resolve(product, catalog.map(c => c.manifest));
    const workspace = deriveRuntimeWorkspaceClosure(plan, relativePath => JSON.parse(readFileSync(join(root, relativePath), 'utf8')));
    const out = join(root, '.artifacts', name);
    await mkdir(out, { recursive: true });
    const { files, imports, styles } = await frontendClosure(root, plan);
    files['/assets/composition.js'] = `.artifacts/${name}/composition.js`;
    const backendCatalog = `export const catalog=[${plan.modules.map(m => `{manifest:${JSON.stringify(m)},load:()=>import('../../modules/${m.id}/dist/index.js')}`).join(',')}];\n`;
    await writeFile(join(out, 'backend-catalog.mjs'), backendCatalog);
    await writeFile(join(out, 'solution.mjs'), plan.product.wiring ? `export const load=()=>import('../../solutions/${plan.product.wiring}/wiring.mjs');\n` : 'export const load=null;\n');
    const loaders = plan.modules.filter(m => m.workspaces.length).map(m => `${JSON.stringify(m.id)}:()=>import(${JSON.stringify(`@quadbridge/${m.id}/ui`)})`).join(',');
    const startup = `import {startShell} from '@quadbridge/web-shell';\nstartShell({root:document.getElementById('app'),title:${JSON.stringify(plan.product.title)},loaders:{${loaders}}});\n`;
    await writeFile(join(out, 'composition.js'), startup);
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    await writeFile(join(out, 'web.json'), JSON.stringify({ imports, files, styles }, null, 2) + '\n');
    const digests = {};
    for (const path of Object.values(files))
        digests[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
    const backendFiles = [`.artifacts/${name}/web.json`, `.artifacts/${name}/backend-catalog.mjs`, `.artifacts/${name}/solution.mjs`];
    async function collectJs(dir) {
        for (const f of await readdir(join(root, dir), { withFileTypes: true })) {
            if (f.isDirectory())
                await collectJs(`${dir}/${f.name}`);
            else if (f.isFile() && f.name.endsWith('.js'))
                backendFiles.push(`${dir}/${f.name}`);
        }
    }
    for (const dir of [...workspace.roots.filter(item => item.path !== 'packages/web-shell').map(item => `${item.path}/dist`), 'apps/runtime/dist'])
        await collectJs(dir);
    if (plan.product.wiring)
        backendFiles.push(`solutions/${plan.product.wiring}/wiring.mjs`);
    const backend = {};
    for (const file of backendFiles)
        backend[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
    await writeFile(join(out, 'release.json'), JSON.stringify({ product: name, version: product.version, abi: product.platformAbi, planDigest: createHash('sha256').update(canonical(plan)).digest('hex'), backend, web: digests, status: 'LOCAL_BUILD_NOT_PRODUCTION_ACCEPTANCE' }, null, 2) + '\n');
    console.log(`Assembled ${name}: ${plan.modules.length} modules, worker=${plan.requiresWorker}`);
}

// The opening interface is a standalone preview built from the selected source manifests.
await import('./build-visual.mjs');
