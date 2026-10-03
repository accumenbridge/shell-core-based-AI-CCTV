/** Deterministic native-ESM build profile. Literal dependencies only; unknown packages fail build. */
import ts from 'typescript';
import { readFile, stat, realpath } from 'node:fs/promises';
import { posix, join, relative, resolve, isAbsolute } from 'node:path';
const ASSET = /\.(css|svg|png|jpe?g|webp|gif|json|txt|woff2)$/i;
export async function frontendClosure(root, plan, { includeMobile = false } = {}) {
    const files = {}, imports = {
        '@quadbridge/contracts': '/assets/packages/contracts/index.js',
        '@quadbridge/contracts/ui-contributions': '/assets/packages/contracts/ui-contributions.js',
        '@quadbridge/client-core': '/assets/packages/client-core/index.js',
        '@quadbridge/ui': '/assets/packages/ui/index.js',
        '@quadbridge/ui/components': '/assets/packages/ui/components.js',
        '@quadbridge/web-shell': '/assets/packages/web-shell/index.js',
        '@quadbridge/web-shell/dom': '/assets/packages/web-shell/dom.js',
        '@quadbridge/web-shell/react-adapter': '/assets/packages/web-shell/react-adapter.js'
    }, styles = ['/assets/packages/ui/tokens.css', '/assets/packages/ui/ui.css', '/assets/shell.css'];
    const modules = new Map(plan.modules.map(m => [m.id, m]));
    const absoluteRoot = await realpath(root);
    if (includeMobile) {
        const workspace = JSON.parse(await readFile(join(root, 'packages/mobile-shell/package.json'), 'utf8'));
        const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
        for (const [name, version] of [['@capacitor/core', '8.5.2'], ['@capacitor/app', '8.1.1']]) {
            const packageRoot = join(root, 'node_modules', ...name.split('/'));
            const manifestPath = join(packageRoot, 'package.json');
            if (await realpath(manifestPath) !== resolve(manifestPath))
                throw Error(`Selected native vendor manifest is not physical: ${name}`);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            const lockPath = `node_modules/${name}`;
            if (workspace.dependencies?.[name] !== version || lock.packages?.['packages/mobile-shell']?.dependencies?.[name] !== version ||
                manifest.name !== name || manifest.version !== version || lock.packages?.[lockPath]?.version !== version)
                throw Error(`Selected native vendor ${name} does not match its fixed package and lock identity`);
        }
    }
    const nativeVendorRoots = includeMobile ? new Map([
        ['node_modules/@capacitor/core/dist', 'core'],
        ['node_modules/@capacitor/app/dist/esm', 'app']
    ]) : new Map();
    const roots = [...['contracts', 'client-core', 'ui', 'web-shell', ...(includeMobile ? ['mobile-shell'] : [])].map(p => `packages/${p}/dist`), ...plan.modules.map(m => `modules/${m.id}/dist`), ...nativeVendorRoots.keys()];
    if (includeMobile) {
        imports['@quadbridge/mobile-shell'] = '/assets/packages/mobile-shell/index.js';
        imports['@capacitor/core'] = '/assets/vendor/capacitor/core/index.js';
        imports['@capacitor/app'] = '/assets/vendor/capacitor/app/index.js';
    }
    function owner(file) { return roots.find(r => file.startsWith(r + '/')); }
    function url(file) { const r = owner(file); if (!r)
        throw Error(`Unselected browser source ${file}`);
        const vendor = nativeVendorRoots.get(r);
        return vendor ? `/assets/vendor/capacitor/${vendor}/${file.slice(r.length + 1)}` : '/assets/' + r.replace('/dist', '') + '/' + file.slice(r.length + 1); }
    for (const m of plan.modules)
        if (m.workspaces.length || m.uiContributions?.length)
            imports[`@quadbridge/${m.id}/ui`] = url(`modules/${m.id}/dist/ui.js`);
    const toFile = url => {
        const vendor = /^\/assets\/vendor\/capacitor\/(core|app)\/(.+)$/.exec(url);
        if (vendor) return vendor[1] === 'core'
            ? `node_modules/@capacitor/core/dist/${vendor[2]}`
            : `node_modules/@capacitor/app/dist/esm/${vendor[2]}`;
        const match = /^\/assets\/(packages|modules)\/([^/]+)\/(.+)$/.exec(url);
        if (!match)
            throw Error(`No browser file for ${url}`);
        return `${match[1]}/${match[2]}/dist/${match[3]}`;
    };
    const visited = new Set();
    async function visit(file) {
        if (visited.has(file))
            return;
        const boundary = owner(file);
        if (!boundary)
            throw Error(`Browser dependency outside selected closure: ${file}`);
        const real = await realpath(join(root, file));
        const rel = relative(absoluteRoot, real);
        if (rel.startsWith('..') || isAbsolute(rel) || real !== resolve(root, file))
            throw Error(`Unsafe/symlink browser asset ${file}`);
        if (!(await stat(real)).isFile())
            throw Error(`Browser dependency is not a file: ${file}`);
        visited.add(file);
        files[url(file)] = file;
        const code = await readFile(real, 'utf8');
        async function dependency(spec, moduleImport = false) {
            let target;
            let extensionlessVendorUrl;
            if (spec.startsWith('./') || spec.startsWith('../')) {
                if (/[?#\\]/.test(spec))
                    throw Error(`Unsupported dependency URL ${spec}`);
                target = posix.normalize(posix.join(posix.dirname(file), spec));
                if (!target.startsWith(boundary + '/'))
                    throw Error(`Relative browser import leaves its owner: ${file} -> ${spec}`);
                // The two pinned Capacitor browser entrypoints use standard extensionless
                // relative ESM imports. Resolve only those imports to their adjacent .js file
                // and retain the exact extensionless URL alias needed by the unchanged preview
                // import. All other selected sources must declare an explicit JavaScript extension.
                if (moduleImport && !target.endsWith('.js') &&
                    [...nativeVendorRoots.keys()].some(vendorRoot => target.startsWith(vendorRoot + '/'))) {
                    extensionlessVendorUrl = url(target);
                    target += '.js';
                }
            }
            else {
                if (!Object.hasOwn(imports, spec))
                    throw Error(`Unsupported browser import ${spec}; select a supported browser build adapter rather than exposing server code`);
                target = toFile(imports[spec]);
                const consumer = /^modules\/([^/]+)\//.exec(file)?.[1], provider = /^modules\/([^/]+)\//.exec(target)?.[1];
                if (provider && consumer !== provider && !modules.get(consumer)?.dependencies.some(d => d.id === provider))
                    throw Error(`Undeclared UI dependency ${consumer} -> ${provider}`);
            }
            if (moduleImport && !target.endsWith('.js'))
                throw Error(`Native ESM imports require JavaScript; declare styles/assets separately: ${target}`);
            if (!target.endsWith('.js') && !ASSET.test(target))
                throw Error(`Unsupported browser file ${target}`);
            if (extensionlessVendorUrl) {
                const previous = files[extensionlessVendorUrl];
                if (previous && previous !== target)
                    throw Error(`Pinned native vendor extensionless URL is ambiguous: ${extensionlessVendorUrl}`);
                files[extensionlessVendorUrl] = target;
            }
            await visit(target);
        }
        if (file.endsWith('.js')) {
            const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), deps = [];
            function walk(node) {
                if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
                    if (!ts.isStringLiteral(node.moduleSpecifier))
                        throw Error(`Nonliteral browser import in ${file}`);
                    deps.push({ spec: node.moduleSpecifier.text, moduleImport: true });
                }
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const arg = node.arguments[0];
                    if (!arg || !ts.isStringLiteralLike(arg))
                        throw Error(`Dynamic browser import must be a build-time literal: ${file}`);
                    deps.push({ spec: arg.text, moduleImport: true });
                }
                if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.getText(ast) === 'import.meta.url') {
                    const arg = node.arguments[0];
                    if (!arg || !ts.isStringLiteralLike(arg))
                        throw Error(`Asset URL must be a build-time literal: ${file}`);
                    deps.push({ spec: arg.text, moduleImport: false });
                }
                ts.forEachChild(node, walk);
            }
            walk(ast);
            for (const dep of deps.sort((a, b) => a.spec.localeCompare(b.spec)))
                await dependency(dep.spec, dep.moduleImport);
        }
        else if (file.endsWith('.css')) {
            const deps = [];
            for (const m of code.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g))
                deps.push(m[2]);
            for (const m of code.matchAll(/@import\s+['"]([^'"]+)['"]/g))
                deps.push(m[1]);
            for (let dep of [...new Set(deps)].sort()) {
                if (dep.startsWith('data:') || dep.startsWith('#'))
                    continue;
                if (!dep.startsWith('.'))
                    dep = './' + dep;
                await dependency(dep);
            }
        }
    }
    await visit('packages/web-shell/dist/index.js');
    // This supported shell-owned renderer seam is statically selectable, not a React dependency.
    await visit('packages/web-shell/dist/react-adapter.js');
    if (includeMobile) {
        await visit('packages/mobile-shell/dist/index.js');
        await visit('packages/mobile-shell/dist/mobile.css');
    }
    for (const m of plan.modules) {
        if (m.workspaces.length || m.uiContributions?.length)
            await visit(`modules/${m.id}/dist/ui.js`);
        for (const asset of m.browserAssets ?? []) {
            const file = `modules/${m.id}/dist/${asset}`;
            await visit(file);
            if (asset.endsWith('.css'))
                styles.push(url(file));
        }
    }
    files['/assets/shell.css'] = 'packages/web-shell/dist/shell.css';
    files['/assets/packages/ui/tokens.css'] = 'packages/ui/dist/tokens.css';
    files['/assets/packages/ui/ui.css'] = 'packages/ui/dist/ui.css';
    const mobileStyles = includeMobile ? [...styles.slice(0, 3), '/assets/mobile.css', ...styles.slice(3)] : undefined;
    if (includeMobile) files['/assets/mobile.css'] = 'packages/mobile-shell/dist/mobile.css';
    return { files, imports, styles, ...(mobileStyles ? { mobileStyles } : {}) };
}
