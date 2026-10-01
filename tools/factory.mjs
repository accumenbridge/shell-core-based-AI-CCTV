import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access, cp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [command, name, ...rest] = process.argv.slice(2);
const valid = s => typeof s === 'string' && /^[a-z][a-z0-9-]{1,48}$/.test(s);
const write = async (p, value) => { await mkdir(resolve(p, '..'), { recursive: true }); await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); };
const fresh = async (p) => {
    try {
        await access(p);
        throw new Error('Destination already exists');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
};
if (command === 'plan') {
    if (!valid(name))
        throw new Error('Invalid product');
    console.log(await readFile(join(root, '.artifacts', name, 'plan.json'), 'utf8'));
}
else if (command === 'create-product') {
    if (!valid(name))
        throw new Error('Invalid product');
    const idx = rest.indexOf('--modules');
    const selected = idx < 0 ? [] : (rest[idx + 1] ?? '').split(',').filter(Boolean);
    const linked = spawnSync(process.execPath,[join(root,'tools/link-workspaces.mjs')],{cwd:root,stdio:'inherit'}); if(linked.status!==0)throw Error('Workspace setup failed');
    const { readCatalogue, composeDraft } = await import('./studio-catalogue.mjs');
    const { importProduct } = await import('./product-source.mjs');
    const catalogue = await readCatalogue(root);
    const title = name.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
    const draft = composeDraft({id:name,title,selected},catalogue.modules,catalogue.solutions,catalogue.sourceVersion);
    await importProduct(root,draft.product);
    console.log(`Created products/${name}/product.json. Run npm run build, then npm run demo -- --product ${name} --port 4350.`);
}
else if (command === 'import-product') {
    if (!name) throw Error('Use: factory import-product <exported.product.json>');
    const raw = await readFile(resolve(name), 'utf8');
    if(raw.length > 131072) throw Error('Product definition exceeds budget');
    const linked=spawnSync(process.execPath,[join(root,'tools/link-workspaces.mjs')],{cwd:root,stdio:'inherit'});if(linked.status!==0)throw Error('Workspace setup failed');
    const { importProduct } = await import('./product-source.mjs');
    const result = await importProduct(root, JSON.parse(raw));
    console.log(`Saved ${result.path}. Run npm run build, then npm run demo -- --product ${result.product.id} --port 4350. No runtime or grants changed.`);
}
else if (command === 'create-module') {
    if (!valid(name))
        throw new Error('Invalid module');
    const dir = join(root, 'modules', name);
    await fresh(dir);
    const deps = ['contracts', 'sqlite', 'backend-host', 'web-shell'];
    await write(join(dir, 'package.json'), { name: `@quadbridge/${name}`, version: '0.2.0', private: true, type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './*': { types: './dist/*.d.ts', import: './dist/*.js' } }, dependencies: Object.fromEntries(deps.map(d => [`@quadbridge/${d}`, '0.2.0'])) });
    await write(join(dir, 'tsconfig.json'), { extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo' }, include: ['src/**/*.ts'], references: deps.map(d => ({ path: `../../packages/${d}` })) });
    await write(join(dir, 'module.json'), { id: name, version: '0.2.0', abi: 'quadbridge.module.v1', dependencies: [], provides: [], requires: [], permissions: [`${name}.read`, `${name}.write`], routes: [{ method: 'GET', path: `/api/${name}`, permission: `${name}.read`, kind: 'read' }, { method: 'POST', path: `/api/${name}`, permission: `${name}.write`, kind: 'write' }], workspaces: [{ id: `${name}.main`, label: name, path: `/${name}`, permission: `${name}.read`, export: 'workspace' }], schema: { current: 1, readMin: 1, readMax: 1 }, background: false });
    const source = await readFile(join(root, 'templates/module-backend.ts.txt'), 'utf8'), ui = await readFile(join(root, 'templates/module-ui.ts.txt'), 'utf8');
    await write(join(dir, 'src/index.ts'), source.replaceAll('__NAME__', name));
    await write(join(dir, 'src/ui.ts'), ui.replaceAll('__NAME__', name));
    await write(join(dir, 'README.md'), `# ${name}\n\nGenerated working item-list example, not an invented business model. Define real invariants, retention and acceptance before product use.\n`);
    console.log(`Created modules/${name}. Run npm run build; update and review package-lock.json before release.`);
}
else if (command === 'assemble') {
    if (!valid(name) || !rest[0])
        throw new Error('Use: factory assemble <product> <new-directory>');
    const out = resolve(rest[0]);
    await fresh(out);
    const plan = JSON.parse(await readFile(join(root, '.artifacts', name, 'plan.json'), 'utf8'));
    const { deriveRuntimeWorkspaceClosure } = await import('@quadbridge/composition/workspace-closure');
    const workspace = deriveRuntimeWorkspaceClosure(plan, relativePath => JSON.parse(readFileSync(join(root, relativePath), 'utf8')));
    const keepFile = path => !path.includes('node_modules') && !path.includes('.tsbuildinfo');
    for (const item of workspace.roots)
        await cp(join(root, item.path), join(out, item.path), { recursive: true, filter: keepFile });
    await mkdir(join(out, 'modules'), { recursive: true });
    await cp(join(root, 'apps/runtime'), join(out, 'apps/runtime'), { recursive: true, filter: keepFile });
    const app = JSON.parse(await readFile(join(out, 'apps/runtime/package.json'), 'utf8'));
    app.dependencies = workspace.dependencies;
    await writeFile(join(out, 'apps/runtime/package.json'), JSON.stringify(app, null, 2) + '\n');
    await cp(join(root, 'products', name), join(out, 'products', name), { recursive: true });
    await cp(join(root, '.artifacts', name), join(out, '.artifacts', name), { recursive: true });
    await write(join(out, 'generated/catalog.mjs'), `export const catalog=[${plan.modules.map(m => `{manifest:${JSON.stringify(m)},load:()=>import('../modules/${m.id}/dist/index.js')}`).join(',')}];\n`);
    if (plan.product.wiring)
        await cp(join(root, 'solutions', plan.product.wiring), join(out, 'solutions', plan.product.wiring), { recursive: true });
    await write(join(out, 'generated/solution-catalog.mjs'), `export const solutions={${plan.product.wiring ? `${JSON.stringify(plan.product.wiring)}:()=>import('../solutions/${plan.product.wiring}/wiring.mjs')` : ''}};\n`);
    for (const file of ['link-workspaces.mjs', 'demo.mjs', 'local-profile.mjs']) {
        await mkdir(join(out, 'tools'), { recursive: true });
        await cp(join(root, 'tools', file), join(out, 'tools', file));
    }
    await cp(join(root, 'profiles'), join(out, 'profiles'), { recursive: true });
    await write(join(out, 'package.json'), { name: `${name}-assembled-runtime`, private: true, type: 'module', version: plan.product.version, engines: { node: '>=22.16.0' }, scripts: { setup: 'node tools/link-workspaces.mjs', start: `node tools/demo.mjs --product ${name} --port 4350` } });
    await write(join(out, 'README.md'), `# ${plan.product.title} — assembled local product\n\nNode 22.16+; tested on 22.16.0.\n\nRun \`npm run setup\`, then \`npm start\`.\n\nCompiled runtime and selected modules are included. Startup requires no dependency download. Local accounts/configuration are generated. This is a loopback developer profile, not production. Remote bindings need their configured destination running.\n`);
    console.log(`Assembled ${name} at ${out}; no existing data or credentials copied.`);
}
else {
    console.log('factory import-product <file>\nfactory plan <product>\nfactory create-module <name>\nfactory create-product <name> --modules module-a,module-b\nfactory assemble <product> <new-directory>');
    if (command)
        process.exitCode = 2;
}
