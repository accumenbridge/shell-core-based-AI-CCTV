import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { COPYFILE_EXCL } from 'node:constants';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { canonical } from '@quadbridge/contracts';
import { frontendClosure } from '../frontend-closure.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const portable = value => value.split(sep).join('/');
const SAFE_PRODUCT = /^[a-z][a-z0-9-]{1,47}$/;
const ASSET_EXTENSIONS = new Set(['.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.json', '.txt', '.woff2']);

function validateProductId(value) {
  if (typeof value !== 'string' || !SAFE_PRODUCT.test(value)) throw new Error('Provide a valid selected product id with --product.');
  return value;
}

export function validateMobilePlanIdentity(plan, release) {
  if (!plan || !release || plan.product?.id !== release.product || release.status !== 'LOCAL_BUILD_NOT_PRODUCTION_ACCEPTANCE')
    throw new Error('The selected product build identity is not a verified local release. Run the fresh platform build first.');
  if (typeof release.planDigest !== 'string' || digest(canonical(plan)) !== release.planDigest)
    throw new Error('Composition plan digest differs from the selected product release.');
}

async function shaFile(path) { return digest(await readFile(path)); }
async function isPresent(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function listRegularFiles(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(directory, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error(`Generated mobile output contains a symbolic link: ${relativePath}`);
    if (info.isDirectory()) output.push(...await listRegularFiles(fullPath, relativePath));
    else if (info.isFile()) output.push(relativePath);
    else throw new Error(`Generated mobile output contains a non-regular file: ${relativePath}`);
  }
  return output.sort();
}

function mobileEntry(plan, mode) {
  const loaders = plan.modules
    .filter(module => module.workspaces.length > 0)
    .map(module => {
      if (!SAFE_PRODUCT.test(module.id)) throw new Error('Selected module identity is not safe for a static mobile registration.');
      return `${JSON.stringify(module.id)}:()=>import(${JSON.stringify(`@quadbridge/${module.id}/ui`)})`;
    }).join(',');
  if (mode === 'preview')
    return `import {startMobileShell} from '@quadbridge/mobile-shell';\nstartMobileShell({root:document.getElementById('app'),title:${JSON.stringify(plan.product.title)},loaders:{${loaders}}});\n`;
  return `import {startPackagedMobileShell} from '@quadbridge/mobile-shell';\nstartPackagedMobileShell({root:document.getElementById('app'),title:${JSON.stringify(plan.product.title)}});\n` +
    `// Fixed selected UI registrations are bundled for the next reviewed connection adapter.\n` +
    `export const selectedWorkspaceLoaders={${loaders}};\n`;
}

export async function buildMobileBundle({ sourceRoot = root, plan, closure, bundleRoot, mode = 'packaged' }) {
  const allowed = new Set();
  const sourceByUrl = new Map(Object.entries(closure.files));
  for (const source of new Set(Object.values(closure.files))) {
    const absolute = resolve(sourceRoot, source);
    const real = await realpath(absolute);
    const rel = relative(sourceRoot, real);
    if (rel.startsWith('..') || isAbsolute(rel) || real !== absolute) throw new Error(`Unsafe frontend closure source: ${source}`);
    allowed.add(real);
  }
  const sourcePaths = new Set(Object.values(closure.files));
  const rawPathBySource = new Map();
  const rawSourceByPath = new Map();
  for (const source of [...sourcePaths].filter(path => extname(path).toLowerCase() !== '.js').sort()) {
    const extension = extname(source);
    if (!ASSET_EXTENSIONS.has(extension.toLowerCase())) throw new Error(`Unsupported mobile asset type in the checked closure: ${source}`);
    const outputPath = `assets/raw/${digest(source).slice(0, 16)}${extension}`;
    const folded = outputPath.toLowerCase();
    const prior = rawSourceByPath.get(folded);
    if (prior && prior !== source) throw new Error(`Mobile asset path digest collision: ${prior} and ${source}`);
    rawPathBySource.set(source, outputPath);
    rawSourceByPath.set(folded, source);
  }
  const imports = new Map(Object.entries(closure.imports).map(([name, url]) => {
    const source = sourceByUrl.get(url);
    if (!source) throw new Error(`Static registration is not in the checked frontend closure: ${name}`);
    return [name, resolve(sourceRoot, source)];
  }));
  const moduleEntries = plan.modules.filter(module => module.workspaces.length > 0).map(module => `@quadbridge/${module.id}/ui`);
  if (moduleEntries.some(name => !imports.has(name))) throw new Error('A selected workspace loader is absent from the checked frontend import map.');
  if (!['preview', 'packaged'].includes(mode)) throw new Error('Unsupported fixed mobile entry mode.');
  const entry = mobileEntry(plan, mode);
  const sourceByAbsolutePath = new Map([...sourcePaths].map(source => [resolve(sourceRoot, source), source]));
  const compactReference = (source, spec, label) => {
    if (/^data:/i.test(spec) || spec.startsWith('#')) return undefined;
    if (!spec || /[?#\\]/.test(spec) || spec.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(spec))
      throw new Error(`Unsupported ${label} reference in the checked mobile closure: ${source} -> ${spec}`);
    const relativeSpec = spec.startsWith('./') || spec.startsWith('../') ? spec : `./${spec}`;
    const targetSource = posix.normalize(posix.join(posix.dirname(source), relativeSpec));
    if (targetSource === '..' || targetSource.startsWith('../'))
      throw new Error(`${label} reference leaves its selected source: ${source} -> ${spec}`);
    if (!sourceByAbsolutePath.has(resolve(sourceRoot, targetSource)))
      throw new Error(`${label} reference is outside the checked frontend closure: ${source} -> ${spec}`);
    const mapped = rawPathBySource.get(targetSource);
    if (!mapped) throw new Error(`${label} reference is not a copied client asset: ${source} -> ${spec}`);
    return `./${posix.basename(mapped)}`;
  };
  const cssReference = /\/\*[\s\S]*?\*\/|(?<importPrefix>@import\s+)(?<importQuote>["'])(?<importPath>[^"']+)\k<importQuote>|(?<urlPrefix>\burl\s*\(\s*)(?:(?<urlQuote>["'])(?<quotedPath>[^"']*)\k<urlQuote>|(?<barePath>[^)'"\s]+))(?<urlSuffix>\s*\))/giu;
  const rewriteCss = (source, contents) => {
    const withoutComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
    const expectedUrls = [...withoutComments.matchAll(/\burl\s*\(/giu)].length;
    const expectedImports = [...withoutComments.matchAll(/@import\s+["']/giu)].length;
    let seenUrls = 0, seenImports = 0;
    const rewritten = contents.replace(cssReference, (match, ...args) => {
      if (match.startsWith('/*')) return match;
      const groups = args.at(-1);
      if (groups.importPath !== undefined) {
        seenImports++;
        const mapped = compactReference(source, groups.importPath, 'CSS import');
        return mapped === undefined ? match : `${groups.importPrefix}${groups.importQuote}${mapped}${groups.importQuote}`;
      }
      if (groups.urlPrefix !== undefined) {
        seenUrls++;
        const spec = groups.quotedPath ?? groups.barePath;
        const mapped = compactReference(source, spec, 'CSS URL');
        return mapped === undefined ? match : `${groups.urlPrefix}${groups.urlQuote ?? ''}${mapped}${groups.urlQuote ?? ''}${groups.urlSuffix}`;
      }
      return match;
    });
    const declaredImports = [...withoutComments.matchAll(/@import\s+/giu)].length;
    const supportedUrlImports = [...withoutComments.matchAll(/@import\s+url\s*\(/giu)].length;
    if (seenUrls !== expectedUrls || seenImports + supportedUrlImports !== declaredImports)
      throw new Error(`Unsupported or ambiguous CSS reference syntax in the checked mobile closure: ${source}`);
    return rewritten;
  };
  const rewriteAssetUrls = (file, contents) => {
    const sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits = [];
    function visit(node) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' &&
          node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1].getText(sourceFile) === 'import.meta.url') {
        const spec = node.arguments[0].text;
        if (spec.startsWith('./') || spec.startsWith('../')) {
          if (/[?#\\]/.test(spec)) throw new Error(`Unsupported mobile asset URL: ${spec}`);
          const target = resolve(file, '..', spec);
          if (!allowed.has(target)) throw new Error(`Mobile asset URL leaves the checked frontend closure: ${spec}`);
          const targetPath = portable(relative(sourceRoot, target));
          if (targetPath.startsWith('../') || targetPath === '..' || isAbsolute(targetPath)) throw new Error(`Mobile asset URL escapes the project root: ${spec}`);
          const mapped = rawPathBySource.get(targetPath);
          if (!mapped) throw new Error(`Mobile URL does not target a copied client asset: ${spec}`);
          edits.push({ start: node.arguments[0].getStart(sourceFile), end: node.arguments[0].getEnd(), replacement: JSON.stringify(`./raw/${posix.basename(mapped)}`) });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    for (const edit of edits.sort((a, b) => b.start - a.start))
      contents = `${contents.slice(0, edit.start)}${edit.replacement}${contents.slice(edit.end)}`;
    return contents;
  };
  const result = await build({
    absWorkingDir: sourceRoot,
    stdin: { contents: entry, sourcefile: 'mobile-entry.mjs', resolveDir: sourceRoot, loader: 'js' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    outdir: bundleRoot,
    metafile: true,
    write: false,
    entryNames: 'assets/app-[hash]',
    chunkNames: 'assets/chunk-[hash]',
    assetNames: 'assets/asset-[name]-[hash]',
    loader: Object.fromEntries([...ASSET_EXTENSIONS].filter(extension => extension !== '.css').map(extension => [extension, 'file'])),
    logLevel: 'silent',
    plugins: [{
      name: 'reviewed-mobile-closure',
      setup(context) {
        context.onResolve({ filter: /.*/ }, async args => {
          if (args.kind === 'entry-point' && args.path === 'mobile-entry.mjs')
            return { path: 'mobile-entry.mjs', namespace: 'mobile-entry' };
          let candidate;
          if (imports.has(args.path)) candidate = imports.get(args.path);
          else if (args.path.startsWith('./') || args.path.startsWith('../')) {
            if (/[?#\\]/.test(args.path) || !args.importer) return { errors: [{ text: `Unsupported mobile dependency path: ${args.path}` }] };
            candidate = resolve(args.importer, '..', args.path);
          } else return { errors: [{ text: `Dependency is outside the selected client registration: ${args.path}` }] };
          try { candidate = await realpath(candidate); }
          catch { return { errors: [{ text: `Selected client dependency is missing: ${args.path}` }] }; }
          if (!allowed.has(candidate)) return { errors: [{ text: `Dependency is outside the checked frontend closure: ${args.path}` }] };
          return { path: candidate };
        });
        context.onLoad({ filter: /\.js$/, namespace: 'file' }, async args => ({
          contents: rewriteAssetUrls(args.path, await readFile(args.path, 'utf8')),
          loader: 'js'
        }));
        context.onLoad({ filter: /.*/, namespace: 'mobile-entry' }, () => ({ contents: entry, loader: 'js', resolveDir: sourceRoot }));
      }
    }]
  });

  for (const input of Object.keys(result.metafile.inputs)) {
    if (input === 'mobile-entry.mjs') continue;
    const absolute = resolve(sourceRoot, input);
    const real = await realpath(absolute);
    if (!allowed.has(real)) throw new Error(`Bundler used a source outside the checked frontend closure: ${input}`);
  }
  const entryOutput = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint === 'mobile-entry.mjs')?.[0];
  if (!entryOutput) throw new Error('Bundler did not emit one fixed mobile startup entry.');
  const entryRelative = portable(relative(bundleRoot, resolve(sourceRoot, entryOutput)));
  if (!result.outputFiles.some(file => portable(relative(bundleRoot, file.path)) === entryRelative))
    throw new Error('Bundler startup output is missing from its inventory.');
  const css = [...new Set(closure.mobileStyles)].map(url => {
    const source = sourceByUrl.get(url);
    const outputPath = source && rawPathBySource.get(source);
    if (!outputPath || !outputPath.endsWith('.css')) throw new Error(`Packaged stylesheet is not in the checked frontend closure: ${url}`);
    return outputPath;
  });
  const rawAssets = [];
  for (const source of [...rawPathBySource.keys()].sort()) {
    const bytes = await readFile(join(sourceRoot, source));
    const contents = source.toLowerCase().endsWith('.css') ? Buffer.from(rewriteCss(source, bytes.toString('utf8'))) : bytes;
    rawAssets.push({ source, path: rawPathBySource.get(source), contents });
  }
  return {
    entry: `/${entryRelative}`,
    css,
    rawAssets,
    inputs: result.metafile.inputs,
    outputs: result.outputFiles.map(file => ({ path: portable(relative(bundleRoot, file.path)), contents: file.contents }))
  };
}

function renderIndex(title, entry, styles) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><title>${escape(title)}</title>${styles.map(path => `<link rel="stylesheet" href="${escape(path)}">`).join('')}</head><body><div id="app"></div><script type="module" src="${escape(entry)}"></script></body></html>\n`;
}

async function verifyExisting(outputDir, expectedCandidate) {
  const manifestPath = join(outputDir, 'mobile-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.sourceCandidate !== expectedCandidate || !manifest.outputFiles || typeof manifest.outputFiles !== 'object')
    throw new Error(`Existing output is not the same immutable mobile candidate: ${outputDir}`);
  const files = await listRegularFiles(outputDir);
  const wanted = Object.keys(manifest.outputFiles).sort();
  if (JSON.stringify(files.filter(path => path !== 'mobile-manifest.json')) !== JSON.stringify(wanted))
    throw new Error('Existing mobile output inventory differs from its manifest.');
  for (const path of wanted) if (await shaFile(join(outputDir, ...path.split('/'))) !== manifest.outputFiles[path])
    throw new Error(`Existing mobile output digest mismatch: ${path}`);
  return manifest;
}

export async function assembleMobile({ sourceRoot = root, productId, outputBase = join(sourceRoot, '.local/mobile-001/generated') }) {
  validateProductId(productId);
  const planPath = join(sourceRoot, '.artifacts', productId, 'plan.json');
  const webPath = join(sourceRoot, '.artifacts', productId, 'web.json');
  const releasePath = join(sourceRoot, '.artifacts', productId, 'release.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const web = JSON.parse(await readFile(webPath, 'utf8'));
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  validateMobilePlanIdentity(plan, release);
  if (plan.product.id !== productId) throw new Error('Selected product differs from its release plan.');
  if (!web.mobile || !Array.isArray(web.mobile.styles) || !web.files || !web.mobile.sourceFiles || !release.web)
    throw new Error('The selected product build has no fixed mobile closure. Run npm run build first.');
  const closure = await frontendClosure(sourceRoot, plan, { includeMobile: true });
  for (const source of new Set(Object.values(closure.files))) {
    const expected = web.mobile.sourceFiles[source];
    if (typeof expected !== 'string' || await shaFile(join(sourceRoot, source)) !== expected)
      throw new Error(`Selected frontend source differs from the mobile build manifest: ${source}`);
  }
  for (const [name, url] of Object.entries(closure.imports)) if (web.mobile.imports[name] !== url)
    throw new Error(`Build and mobile assembly import registrations differ at ${name}.`);
  if (JSON.stringify(closure.mobileStyles) !== JSON.stringify(web.mobile.sourceStyles)) throw new Error('Build and mobile assembly styles differ.');
  for (const path of ['tools/mobile/assemble.mjs', 'tools/frontend-closure.mjs', 'tools/build.mjs', 'package.json', 'package-lock.json']) {
    if (web.mobile.builderInputs?.[path] !== digest(await readFile(join(sourceRoot, path))))
      throw new Error(`Mobile builder input differs from the selected build: ${path}`);
  }
  for (const url of [web.mobile.entry, ...web.mobile.styles, ...Object.keys(web.mobile.files ?? {})]) {
    const path = web.mobile.files?.[url] ?? web.files[url];
    if (typeof path !== 'string' || typeof release.web[path] !== 'string' || await shaFile(join(sourceRoot, path)) !== release.web[path])
      throw new Error(`Mobile preview output is absent from the immutable release inventory: ${url}`);
  }

  const bundle = await buildMobileBundle({ sourceRoot, plan, closure, bundleRoot: resolve(sourceRoot, '.local/mobile-001/bundle-layout'), mode: 'packaged' });
  const usedSources = new Set();
  for (const input of Object.keys(bundle.inputs)) {
    if (input === 'mobile-entry.mjs') continue;
    usedSources.add(input);
  }
  const sourceInputs = {};
  for (const path of [...usedSources].sort()) {
    const absolute = resolve(sourceRoot, path);
    const rel = relative(sourceRoot, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Bundle input escaped the project root: ${path}`);
    sourceInputs[portable(rel)] = digest(await readFile(absolute));
  }
  for (const source of new Set(Object.values(closure.files)))
    sourceInputs[portable(source)] = digest(await readFile(join(sourceRoot, source)));
  const assemblyInputs = {};
  for (const path of ['tools/mobile/assemble.mjs', 'tools/frontend-closure.mjs', 'tools/build.mjs', 'package.json', 'package-lock.json'])
    assemblyInputs[path] = digest(await readFile(join(sourceRoot, path)));
  const templateInputs = {};
  for (const path of ['package.json', 'package-lock.json', 'README.md'])
    templateInputs[`templates/mobile/${path}`] = digest(await readFile(join(sourceRoot, 'templates/mobile', path)));
  const sourceCandidate = digest(JSON.stringify({ productId, planDigest: release.planDigest, sourceInputs, assemblyInputs, templateInputs, esbuildVersion }));
  const destination = resolve(outputBase, productId, sourceCandidate.slice(0, 20));
  if (await isPresent(destination)) return { outputDir: destination, manifest: await verifyExisting(destination, sourceCandidate), reused: true };
  await mkdir(destination, { recursive: true });
  const packageFiles = ['package.json', 'package-lock.json', 'README.md'];
  for (const path of packageFiles) await copyFile(join(sourceRoot, 'templates/mobile', path), join(destination, path), COPYFILE_EXCL);
  const appId = `com.quadbridge.products.${productId.replace(/-/g, '_')}`;
  const config = { appId, appName: plan.product.title, webDir: 'www', bundledWebRuntime: false };
  await writeFile(join(destination, 'capacitor.config.json'), json(config), { flag: 'wx' });
  const publicDir = join(destination, 'www');
  await mkdir(publicDir, { recursive: true });
  const packagedPrefix = 'assets/mobile-preview';
  for (const output of bundle.outputs) {
    const outputPath = join(publicDir, packagedPrefix, ...output.path.split('/'));
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, output.contents, { flag: 'wx' });
  }
  for (const asset of bundle.rawAssets) {
    const outputPath = join(publicDir, packagedPrefix, ...asset.path.split('/'));
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, asset.contents, { flag: 'wx' });
  }
  const packagedEntry = `/${packagedPrefix}/${bundle.entry.replace(/^\/+/, '')}`;
  const packagedStyles = bundle.css.map(path => `${packagedPrefix}/${path}`);
  await writeFile(join(publicDir, 'index.html'), renderIndex(plan.product.title, packagedEntry, packagedStyles), { flag: 'wx' });

  const outputFiles = {};
  for (const path of await listRegularFiles(destination)) {
    if (path !== 'mobile-manifest.json') outputFiles[path] = await shaFile(join(destination, ...path.split('/')));
  }
  const outputCandidate = digest(JSON.stringify({ sourceCandidate, outputFiles }));
  const manifest = {
    schema: 'quadbridge.mobile-client.v1',
    status: 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION',
    productId,
    productVersion: plan.product.version,
    planDigest: release.planDigest,
    sourceCandidate,
    outputCandidate,
    generatedAt: new Date().toISOString(),
    clientOnly: true,
    connection: { state: 'NOT_CONFIGURED', authenticationAdapter: null, apiProfile: null, performsRequests: false },
    nativeTemplate: { capacitor: '8.5.2', appId, webDir: 'www', remoteServerUrl: null },
    sourceFiles: sourceInputs,
    assemblyInputs,
    templateInputs,
    toolchain: { esbuild: esbuildVersion },
    bundleInputs: Object.keys(bundle.inputs).filter(path => path !== 'mobile-entry.mjs').sort().map(portable),
    webInventory: Object.fromEntries(Object.entries(outputFiles).filter(([path]) => path.startsWith('www/'))),
    outputFiles
  };
  await writeFile(join(destination, 'mobile-manifest.json'), json(manifest), { flag: 'wx' });
  return { outputDir: destination, manifest, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const productIndex = args.indexOf('--product');
  if (productIndex < 0 || !args[productIndex + 1]) throw new Error('Usage: npm run mobile:assemble -- --product <selected-product-id>');
  const result = await assembleMobile({ productId: args[productIndex + 1] });
  console.log(JSON.stringify({ outputDir: result.outputDir, productId: result.manifest.productId, sourceCandidate: result.manifest.sourceCandidate, outputCandidate: result.manifest.outputCandidate, reused: result.reused }, null, 2));
}
