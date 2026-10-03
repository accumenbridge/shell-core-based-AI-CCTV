import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { COPYFILE_EXCL } from 'node:constants';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '@quadbridge/contracts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const portable = value => value.split(sep).join('/');
const SAFE_PRODUCT = /^[a-z][a-z0-9-]{1,47}$/;
const OUTPUT_FINGERPRINT_FORMAT = 'quadbridge.mobile-output-fingerprint.v2';
function hasCanonicalGenerationId(value, instanceId) {
  const prefix = `generation:${instanceId}:`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const generation = value.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(generation) && Number.isSafeInteger(Number(generation)) && String(Number(generation)) === generation;
}
const ASSET_EXTENSIONS = new Set(['.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.json', '.txt', '.woff2']);
const CLIENT_TEMPLATE_FILES = [
  ['p', 'templates/mobile/package.json', 'package.json'],
  ['l', 'templates/mobile/package-lock.json', 'package-lock.json'],
  ['r', 'templates/mobile/README.md', 'README.md'],
  ['n', 'templates/mobile/native-session/package.json', 'native-session/package.json'],
  ['g', 'templates/mobile/native-session/android/build.gradle', 'native-session/android/build.gradle'],
  ['m', 'templates/mobile/native-session/android/src/main/AndroidManifest.xml', 'native-session/android/src/main/AndroidManifest.xml'],
  ['j', 'templates/mobile/native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java', 'native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java'],
  ['w', 'templates/mobile/native-session/Package.swift', 'native-session/Package.swift'],
  ['s', 'templates/mobile/native-session/ios/Sources/NativeSessionPlugin/NativeSessionPlugin.swift', 'native-session/ios/Sources/NativeSessionPlugin/NativeSessionPlugin.swift'],
  ['d', 'templates/mobile/android-debug/AndroidManifest.xml', 'android-debug/AndroidManifest.xml'],
  ['c', 'templates/mobile/android-debug/network_security_config.xml', 'android-debug/network_security_config.xml'],
  ['q', 'templates/mobile/qualification/android-test.gradle', 'qualification/android-test.gradle'],
  ['k', 'templates/mobile/qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java', 'qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java'],
  ['x', 'tools/mobile/prepare-native.mjs', 'tools/prepare-native.mjs']
];
const NATIVE_TEMPLATE_FILES = [
  'templates/mobile/native-session/package.json',
  'templates/mobile/native-session/android/build.gradle',
  'templates/mobile/native-session/android/src/main/AndroidManifest.xml',
  'templates/mobile/native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java',
  'templates/mobile/native-session/Package.swift',
  'templates/mobile/native-session/ios/Sources/NativeSessionPlugin/NativeSessionPlugin.swift',
  'templates/mobile/android-debug/AndroidManifest.xml',
  'templates/mobile/android-debug/network_security_config.xml',
  'templates/mobile/qualification/android-test.gradle',
  'templates/mobile/qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java',
  'tools/mobile/prepare-native.mjs'
];

async function resolveSourceUiBindings(sourceRoot, plan) {
  const wiring = plan.product.wiring;
  if (wiring === undefined) return { bindings: [], mapping: null };
  if (typeof wiring !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(wiring)) throw new Error('Selected solution identity is invalid.');
  const mappingPath = `solutions/${wiring}/ui.json`;
  const absolute = join(sourceRoot, ...mappingPath.split('/'));
  let info;
  try { info = await lstat(absolute); }
  catch (error) { if (error?.code === 'ENOENT') return { bindings: [], mapping: null }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error('Selected UI mapping is not a physical source file.');
  const bytes = await readFile(absolute);
  if (bytes.length > 131072) throw new Error('Selected UI mapping exceeds its source bound.');
  const sourceManifests = [];
  for (const entry of (await readdir(join(sourceRoot, 'modules'), { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = join(sourceRoot, 'modules', entry.name, 'module.json');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || await realpath(manifestPath) !== manifestPath) throw new Error(`Module source manifest is not physical: ${entry.name}`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.id !== entry.name) throw new Error(`Module source identity mismatch: ${entry.name}`);
    sourceManifests.push(manifest);
  }
  const { resolveUiContributionBindings } = await import('@quadbridge/contracts/ui-contributions');
  const resolved = resolveUiContributionBindings(plan, JSON.parse(bytes.toString('utf8')), sourceManifests);
  return { bindings: resolved.bindings, mapping: { path: mappingPath, sha256: digest(bytes) } };
}

async function copyNativeTemplateInputs(sourceRoot, destination) {
  for (const path of NATIVE_TEMPLATE_FILES) {
    const source = join(sourceRoot, ...path.split('/'));
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(source) !== source) throw new Error(`Native template input is not a physical file: ${path}`);
    const relativePath = path.startsWith('tools/mobile/')
      ? `tools/${path.slice('tools/mobile/'.length)}`
      : path.slice('templates/mobile/'.length);
    const target = join(destination, ...relativePath.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await copyFile(source, target, COPYFILE_EXCL);
  }
}

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

function mobileEntry(plan, mode, uiBindings = [], verifiedPlanDigest = digest(canonical(plan))) {
  const identity = {
    productId: plan.product.id,
    productVersion: plan.product.version,
    instanceId: `${plan.product.id}-local`,
    planDigest: verifiedPlanDigest,
    modules: plan.modules.map(module => ({ id: module.id, version: module.version }))
  };
  const loaders = plan.modules
    .filter(module => module.workspaces.length > 0 || module.uiContributions?.length > 0)
    .map(module => {
      if (!SAFE_PRODUCT.test(module.id)) throw new Error('Selected module identity is not safe for a static mobile registration.');
      return `${JSON.stringify(module.id)}:()=>import(${JSON.stringify(`@quadbridge/${module.id}/ui`)})`;
    }).join(',');
  const experience = plan.product.experience ? `experience:${JSON.stringify(plan.product.experience)},` : '';
  if (mode === 'preview')
    return `import {startMobileShell} from '@quadbridge/mobile-shell';\nstartMobileShell({root:document.getElementById('app'),title:${JSON.stringify(plan.product.title)},${experience}loaders:{${loaders}},uiBindings:${JSON.stringify(uiBindings)}});\n`;
  return `import {startPackagedMobileShell} from '@quadbridge/mobile-shell';\nconst root=document.getElementById('app');\nvoid fetch('/qb-runtime-identity.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw new Error('The captured runtime identity is missing');return response.json();}).then(identity=>startPackagedMobileShell({root,title:${JSON.stringify(plan.product.title)},${experience}loaders:{${loaders}},uiBindings:${JSON.stringify(uiBindings)},identity})).catch(()=>{root.replaceChildren(Object.assign(document.createElement('p'),{textContent:'This Android client is not bound to a verified managed runtime.'}));});\n`;
}

export async function buildMobileBundle({ sourceRoot = root, plan, closure, bundleRoot, mode = 'packaged', uiBindings = [], planDigest }) {
  const [{ build, version: esbuildVersion }, typeScript] = await Promise.all([import('esbuild'), import('typescript')]);
  const ts = typeScript.default;
  const allowed = new Set();
  const sourceByUrl = new Map(Object.entries(closure.files));
  const nativeVendorRoots = [
    resolve(sourceRoot, 'node_modules/@capacitor/core/dist'),
    resolve(sourceRoot, 'node_modules/@capacitor/app/dist/esm')
  ];
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
  const entry = mobileEntry(plan, mode, uiBindings, planDigest ?? digest(canonical(plan)));
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
          if (!extname(candidate) && nativeVendorRoots.some(vendorRoot => candidate.startsWith(vendorRoot + sep)) && allowed.has(`${candidate}.js`))
            candidate += '.js';
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
    esbuildVersion,
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

/** Capture the fixed client bundle and native templates as immutable short-path seed leaves. */
export async function buildManagedClientSeed({ sourceRoot = root, plan, closure, uiBindings = [], planDigest = digest(canonical(plan)) }) {
  if (!plan?.product || !SAFE_PRODUCT.test(plan.product.id) || typeof plan.product.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(plan.product.version) ||
      digest(canonical(plan)) !== planDigest) throw new Error('Managed client seed requires the exact selected product plan.');
  const bundle = await buildMobileBundle({ sourceRoot, plan, closure, bundleRoot: resolve(sourceRoot, '.local/mobile-001/managed-seed-layout'), mode: 'packaged', uiBindings });
  const payloads = new Map();
  const files = {};
  let next = 0;
  const add = (target, contents, template, fixedBlob) => {
    if (Object.hasOwn(files, target)) throw new Error(`Managed client seed path collision: ${target}`);
    const blob = fixedBlob ?? `f/${String(next++).padStart(3, '0')}`;
    const bytes = Buffer.from(contents);
    payloads.set(blob, bytes);
    files[target] = { blob, sha256: digest(bytes), sizeBytes: bytes.length, ...(template ? { template } : {}) };
  };
  for (const [leaf, source, target] of CLIENT_TEMPLATE_FILES) {
    const bytes = await readFile(join(sourceRoot, ...source.split('/')));
    // Fixed short leaves keep the verified snapshot and later generated Java
    // source below the Windows path ceiling.
    add(target, bytes, source, `t/${leaf}`);
  }
  for (const output of bundle.outputs) add(`www/assets/mobile-preview/${output.path}`, output.contents);
  for (const asset of bundle.rawAssets) add(`www/assets/mobile-preview/${asset.path}`, asset.contents);
  const entry = `/${'assets/mobile-preview/'}${bundle.entry.replace(/^\/+/, '')}`;
  const styles = bundle.css.map(path => `assets/mobile-preview/${path}`);
  add('www/index.html', renderIndex(plan.product.title, entry, styles));
  const templateInputs = {};
  for (const [, source] of CLIENT_TEMPLATE_FILES) {
    if (source.startsWith('templates/mobile/'))
      templateInputs[source] = digest(await readFile(join(sourceRoot, ...source.split('/'))));
  }
  const assemblyInputs = {};
  for(const path of ['tools/mobile/assemble.mjs','tools/mobile/prepare-native.mjs'])
    assemblyInputs[path] = digest(await readFile(join(sourceRoot, ...path.split('/'))));
  const manifest = {
    schema: 'quadbridge.managed-mobile-seed.v1',
    productId: plan.product.id,
    productVersion: plan.product.version,
    planDigest,
    title: plan.product.title,
    modules: plan.modules.map(module => ({ id: module.id, version: module.version })),
    uiBindings,
    entry,
    styles,
    templateInputs,
    assemblyInputs,
    toolchain: { esbuild: bundle.esbuildVersion },
    bundleInputs: Object.keys(bundle.inputs).filter(path => path !== 'mobile-entry.mjs').sort().map(portable),
    files
  };
  return { manifest, manifestBytes: Buffer.from(json(manifest)), payloads };
}

function validateSeedRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:]/.test(part)))
    throw new Error('Managed mobile seed contains an unsafe package path.');
}

async function ensurePhysicalDirectory(path) {
  try { await mkdir(path); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('Managed mobile output contains a link or non-directory.');
}

export async function verifyManagedClientDirectory(directory, expected) {
  const manifestPath = join(directory, 'managed-client.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema !== 'quadbridge.managed-mobile-client.v1' || manifest.clientReference !== expected.clientReference ||
      canonical(manifest.identity) !== canonical(expected.identity) || !manifest.files || typeof manifest.files !== 'object')
    throw new Error('Existing managed Android client differs from its exact runtime generation.');
  const actual = await listRegularFiles(directory);
  const wanted = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual.filter(path => path !== 'managed-client.json')) !== JSON.stringify(wanted)) throw new Error('Existing managed Android client inventory changed.');
  for (const path of wanted) if (await shaFile(join(directory, ...path.split('/'))) !== manifest.files[path]) throw new Error(`Existing managed Android client changed: ${path}`);
  const mobile = JSON.parse(await readFile(join(directory,'mobile-manifest.json'),'utf8'));
  const expectedRuntime={productId:expected.identity.productId,productVersion:expected.identity.productVersion,instanceId:expected.identity.instanceId,modules:expected.identity.modules};
  if(mobile.schema!=='quadbridge.mobile-client.v1'||mobile.productId!==expected.identity.productId||mobile.productVersion!==expected.identity.productVersion||
      mobile.planDigest!==expected.identity.planDigest||mobile.connection?.apiProfile!=='local-native-forwarded-v1'||
      canonical(mobile.connection?.expectedRuntime)!==canonical(expectedRuntime)||canonical(mobile.managedIdentity)!==canonical(expected.identity)||!mobile.outputFiles||
      digest(Buffer.from(json(mobile)))!==manifest.files['mobile-manifest.json'])throw new Error('Existing managed Android standard manifest differs from its exact runtime identity.');
  return manifest;
}

/** Copy only captured snapshot seed bytes; this path does not load the source closure or native compiler. */
export async function assembleManagedMobile({ projectRoot, seedManifest, readSeedFile, identity, authorize }) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || typeof readSeedFile !== 'function' ||
      typeof authorize!=='function'||authorize.constructor.name==='AsyncFunction'||
      !identity || typeof identity !== 'object' || Array.isArray(identity) ||
      !SAFE_PRODUCT.test(identity.productId) || !/^\d+\.\d+\.\d+$/.test(identity.productVersion) ||
      !/^runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.instanceId) ||
      !hasCanonicalGenerationId(identity.generationId, identity.instanceId) ||
      !/^[a-f0-9]{64}$/.test(identity.artifactDigest) || !/^[a-f0-9]{64}$/.test(identity.planDigest) ||
      identity.nativeApiProfile !== 'local-native-forwarded-v1') throw new Error('Managed mobile package identity is invalid.');
  const checkAuthorization=()=>{const value=authorize();if(value===false||(value!==null&&(typeof value==='object'||typeof value==='function')&&typeof value.then==='function'))throw new Error('Original paired session is no longer authorized.');};
  checkAuthorization();
  const modules = identity.modules;
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 64 || modules.some(module => !module || typeof module.id !== 'string' || !SAFE_PRODUCT.test(module.id) || typeof module.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(module.version)) ||
      new Set(modules.map(module => module.id)).size !== modules.length) throw new Error('Managed mobile package module identity is invalid.');
  if (!seedManifest || seedManifest.schema !== 'quadbridge.managed-mobile-seed.v1' || seedManifest.productId !== identity.productId ||
      seedManifest.productVersion !== identity.productVersion || seedManifest.planDigest !== identity.planDigest ||
      canonical(seedManifest.modules) !== canonical(modules) || typeof seedManifest.title !== 'string' || !seedManifest.files || typeof seedManifest.files !== 'object' || Array.isArray(seedManifest.files))
    throw new Error('Captured client seed does not match this registered runtime generation.');
  const targets = Object.keys(seedManifest.files).sort();
  const expectedTemplates = CLIENT_TEMPLATE_FILES.map(([, , target]) => target).sort();
  const templateTargets = targets.filter(target => seedManifest.files[target]?.template !== undefined).sort();
  if (canonical(templateTargets) !== canonical(expectedTemplates) || targets.length > 1024) throw new Error('Captured client seed template closure changed.');
  for (const [blob, source, target] of CLIENT_TEMPLATE_FILES) {
    const entry = seedManifest.files[target];
    if (entry?.template !== source || entry.blob !== `t/${blob}`) throw new Error('Captured native template mapping changed.');
  }
  if (seedManifest.files['www/index.html']?.template !== undefined || !targets.includes('www/index.html') ||
      targets.some(target => !new Set(expectedTemplates).has(target) && target !== 'www/index.html' && !target.startsWith('www/assets/mobile-preview/')))
    throw new Error('Captured web bundle closure is invalid.');
  const expectedIdentity = { productId: identity.productId, productVersion: identity.productVersion, instanceId: identity.instanceId,
    generationId:identity.generationId,artifactDigest:identity.artifactDigest,planDigest: identity.planDigest,modules,nativeApiProfile:identity.nativeApiProfile };
  if(!seedManifest.toolchain||typeof seedManifest.toolchain.esbuild!=='string'||!/^\d+\.\d+\.\d+$/.test(seedManifest.toolchain.esbuild))throw new Error('Captured mobile bundler identity is missing.');
  const clientReference = `managed-mobile-${digest(canonical({ seedDigest: digest(canonical(seedManifest)), identity: { ...identity, modules } })).slice(0,20)}`;
  const base = resolve(projectRoot), local = join(base, '.local'), managed = join(local, 'managed-mobile'), destination = join(managed, clientReference);
  if (destination.length >= 240) throw new Error('Managed Android client output exceeds the supported path bound.');
  const baseInfo=await lstat(base);
  checkAuthorization();
  const baseRealPath=await realpath(base);
  checkAuthorization();
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || baseRealPath!==base)
    throw new Error('Managed Android client project root is not physical.');
  await ensurePhysicalDirectory(local);
  checkAuthorization();
  await ensurePhysicalDirectory(managed);
  checkAuthorization();
  const destinationExists=await isPresent(destination);
  checkAuthorization();
  if (destinationExists) {
    const info = await lstat(destination);
    checkAuthorization();
    const destinationRealPath=await realpath(destination);
    checkAuthorization();
    if (!info.isDirectory() || info.isSymbolicLink() || destinationRealPath !== destination) throw new Error('Managed Android client destination is not physical.');
    const manifest = await verifyManagedClientDirectory(destination, { clientReference, identity: expectedIdentity });
    checkAuthorization();
    return { clientReference, outputDir: destination, manifest, reused: true };
  }
  const staging=join(managed,`.stage-${randomUUID()}`);
  await mkdir(staging);
  checkAuthorization();
  const info = await lstat(staging);
  checkAuthorization();
  const stagingRealPath=await realpath(staging);
  checkAuthorization();
  if (!info.isDirectory() || info.isSymbolicLink() || stagingRealPath !== staging) throw new Error('Managed Android client staging directory changed during creation.');
  const outputFiles = {};
  let totalBytes = 0;
  try {
    for (const target of targets) {
      checkAuthorization();
      validateSeedRelativePath(target);
      const entry = seedManifest.files[target];
      if (!entry || typeof entry.blob !== 'string' || !/^t\/[a-z]$|^f\/[0-9]{3}$/.test(entry.blob) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > 8 * 1024 * 1024)
        throw new Error('Captured managed mobile seed entry is malformed.');
      const bytes = Buffer.from(await readSeedFile(entry.blob));
      checkAuthorization();
      if (bytes.length !== entry.sizeBytes || digest(bytes) !== entry.sha256) throw new Error(`Captured managed mobile seed changed: ${target}`);
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('Captured managed mobile seed exceeds its fixed size bound.');
      const output = join(staging, ...target.split('/'));
      const outputRelative = relative(staging, output);
      if (!outputRelative || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative) || output.length >= 240) throw new Error('Managed Android client file exceeds its physical path bound.');
      await mkdir(resolve(output, '..'), { recursive: true });
      checkAuthorization();
      await writeFile(output, bytes, { flag: 'wx' });
      checkAuthorization();
      outputFiles[target] = digest(bytes);
    }
    const identityBytes = Buffer.from(json(expectedIdentity));
    await writeFile(join(staging, 'www', 'qb-runtime-identity.json'), identityBytes, { flag: 'wx' });
    checkAuthorization();
    outputFiles['www/qb-runtime-identity.json'] = digest(identityBytes);
    const appId = `com.quadbridge.products.${identity.productId.replace(/-/g, '_')}`;
    const capacitorConfig = { appId, appName: seedManifest.title, webDir: 'www', bundledWebRuntime: false,
      server: { hostname: 'localhost', androidScheme: 'http', iosScheme: 'capacitor' }, loggingBehavior: 'none' };
    const configBytes = Buffer.from(json(capacitorConfig));
    await writeFile(join(staging, 'capacitor.config.json'), configBytes, { flag: 'wx' });
    checkAuthorization();
    outputFiles['capacitor.config.json'] = digest(configBytes);
    const templateInputs = seedManifest.templateInputs;
    if (!templateInputs || typeof templateInputs !== 'object' || Array.isArray(templateInputs) ||
        !seedManifest.assemblyInputs || typeof seedManifest.assemblyInputs !== 'object' || Array.isArray(seedManifest.assemblyInputs))
      throw new Error('Captured native preparation identities are missing.');
    const expectedRuntime = { productId: identity.productId, productVersion: identity.productVersion, instanceId: identity.instanceId, modules: identity.modules };
    const templateApp = JSON.parse(Buffer.from(await readSeedFile('t/p')).toString('utf8'));
    checkAuthorization();
    const standardManifest = {
      schema: 'quadbridge.mobile-client.v1', status: 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION',
      productId: identity.productId, productVersion: identity.productVersion, planDigest: identity.planDigest,
      sourceCandidate: clientReference, outputCandidate: digest(canonical(outputFiles)), clientOnly: true,
      connection: { state: 'FIXED_LOCAL_NATIVE_PROFILE', authenticationAdapter: 'QBUserSession', apiProfile: identity.nativeApiProfile,
        apiOrigin: 'http://127.0.0.1:4350', expectedRuntime },
      nativeTemplate: { capacitor: '8.5.2', app: '8.1.1', appId, webDir: 'www', server: capacitorConfig.server,
        remoteServerUrl: null, loggingBehavior: 'none', nativeSession: '@quadbridge/native-session@0.1.0' },
      uiBindings: seedManifest.uiBindings, assemblyInputs: seedManifest.assemblyInputs, templateInputs,
      toolchain: seedManifest.toolchain, bundleInputs: seedManifest.bundleInputs,
      webInventory: Object.fromEntries(Object.entries(outputFiles).filter(([path]) => path.startsWith('www/'))),
      managedIdentity: expectedIdentity,clientReference,
      generatedAt: new Date().toISOString(), sourceFiles: {},
      nativePackage: templateApp.dependencies?.['@quadbridge/native-session'] ?? 'file:./native-session',
      seedDigest: digest(canonical(seedManifest)), outputFiles
    };
    const mobileManifestBytes=Buffer.from(json(standardManifest));
    await writeFile(join(staging,'mobile-manifest.json'),mobileManifestBytes,{flag:'wx'});
    checkAuthorization();
    outputFiles['mobile-manifest.json']=digest(mobileManifestBytes);
    const managedManifest={schema:'quadbridge.managed-mobile-client.v1',clientReference,identity:expectedIdentity,files:outputFiles};
    await writeFile(join(staging,'managed-client.json'),json(managedManifest),{flag:'wx'});
    checkAuthorization();
    await verifyManagedClientDirectory(staging,{clientReference,identity:expectedIdentity});
    checkAuthorization();
    const destinationOccupied=await isPresent(destination);
    checkAuthorization();
    if(destinationOccupied)throw new Error('Managed Android client destination was occupied before publication.');
    renameSync(staging,destination);
    return { clientReference, outputDir: destination, manifest: managedManifest, reused: false };
  } catch(error) {
    try { await rm(staging,{recursive:true,force:false,maxRetries:10,retryDelay:100}); } catch { /* retain an uncertain owned staging tree */ }
    throw error;
  }
}

async function verifyExisting(outputDir, expected) {
  const manifestPath = join(outputDir, 'mobile-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schema !== 'quadbridge.mobile-client.v1' || manifest.status !== 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION' ||
      manifest.clientOnly !== true || manifest.sourceCandidate !== expected.sourceCandidate ||
      !manifest.outputFiles || typeof manifest.outputFiles !== 'object' || Array.isArray(manifest.outputFiles))
    throw new Error(`Existing output is not the same immutable mobile candidate: ${outputDir}`);
  const commonKeys = Object.keys(expected);
  const newFingerprint = manifest.outputFingerprintFormat !== undefined;
  if (newFingerprint && manifest.outputFingerprintFormat !== OUTPUT_FINGERPRINT_FORMAT)
    throw new Error('Existing mobile output uses an unsupported fingerprint format.');
  const expectedKeys = [...commonKeys, 'generatedAt', 'outputCandidate', 'webInventory', 'outputFiles', ...(newFingerprint ? ['outputFingerprintFormat'] : [])].sort();
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys))
    throw new Error('Existing mobile manifest fields differ from the reviewed assembly identity.');
  for (const key of commonKeys) if (canonical(manifest[key]) !== canonical(expected[key]))
    throw new Error(`Existing mobile source identity differs at ${key}.`);
  if (typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt)) ||
      new Date(manifest.generatedAt).toISOString() !== manifest.generatedAt)
    throw new Error('Existing mobile manifest timestamp is invalid.');
  const wanted = Object.keys(manifest.outputFiles).sort();
  if (JSON.stringify(Object.keys(manifest.outputFiles)) !== JSON.stringify(wanted) ||
      wanted.some(path => typeof path !== 'string' || path.length > 1024 || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
        path.split('/').some(part => !part || part === '.' || part === '..')) ||
      Object.values(manifest.outputFiles).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
    throw new Error('Existing mobile output inventory is invalid or noncanonical.');
  const files = await listRegularFiles(outputDir);
  if (JSON.stringify(files.filter(path => path !== 'mobile-manifest.json')) !== JSON.stringify(wanted))
    throw new Error('Existing mobile output inventory differs from its manifest.');
  for (const path of wanted) if (await shaFile(join(outputDir, ...path.split('/'))) !== manifest.outputFiles[path])
    throw new Error(`Existing mobile output digest mismatch: ${path}`);
  const webInventory = Object.fromEntries(wanted.filter(path => path.startsWith('www/')).map(path => [path, manifest.outputFiles[path]]));
  if (!manifest.webInventory || typeof manifest.webInventory !== 'object' || Array.isArray(manifest.webInventory) ||
      canonical(manifest.webInventory) !== canonical(webInventory))
    throw new Error('Existing mobile web inventory differs from the complete output inventory.');
  const computedOutputCandidate = newFingerprint
    ? digest(canonical({ format: OUTPUT_FINGERPRINT_FORMAT, sourceCandidate: manifest.sourceCandidate, outputFiles: manifest.outputFiles }))
    : digest(JSON.stringify({ sourceCandidate: manifest.sourceCandidate, outputFiles: manifest.outputFiles }));
  if (manifest.outputCandidate !== computedOutputCandidate)
    throw new Error('Existing mobile output candidate fingerprint differs from its output inventory.');
  return manifest;
}

export async function assembleMobile({ sourceRoot = root, productId, outputBase = join(sourceRoot, '.local/mobile-001/generated') }) {
  const { version: esbuildVersion } = await import('esbuild');
  validateProductId(productId);
  const planPath = join(sourceRoot, '.artifacts', productId, 'plan.json');
  const webPath = join(sourceRoot, '.artifacts', productId, 'web.json');
  const releasePath = join(sourceRoot, '.artifacts', productId, 'release.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const web = JSON.parse(await readFile(webPath, 'utf8'));
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  validateMobilePlanIdentity(plan, release);
  if (plan.product.id !== productId) throw new Error('Selected product differs from its release plan.');
  const selectedUi = await resolveSourceUiBindings(sourceRoot, plan);
  if (!web.mobile || !Array.isArray(web.mobile.styles) || !web.files || !web.mobile.sourceFiles || !release.web)
    throw new Error('The selected product build has no fixed mobile closure. Run npm run build first.');
  if (canonical(web.mobile.uiBindings ?? []) !== canonical(selectedUi.bindings) ||
      canonical(web.mobile.uiMapping ?? null) !== canonical(selectedUi.mapping))
    throw new Error('Selected UI contribution bindings differ from the reviewed source mapping.');
  const { frontendClosure } = await import('../frontend-closure.mjs');
  const closure = await frontendClosure(sourceRoot, plan, { includeMobile: true });
  for (const source of new Set(Object.values(closure.files))) {
    const expected = web.mobile.sourceFiles[source];
    if (typeof expected !== 'string' || await shaFile(join(sourceRoot, source)) !== expected)
      throw new Error(`Selected frontend source differs from the mobile build manifest: ${source}`);
  }
  for (const [name, url] of Object.entries(closure.imports)) if (web.mobile.imports[name] !== url)
    throw new Error(`Build and mobile assembly import registrations differ at ${name}.`);
  if (JSON.stringify(closure.mobileStyles) !== JSON.stringify(web.mobile.sourceStyles)) throw new Error('Build and mobile assembly styles differ.');
  for (const path of ['tools/mobile/assemble.mjs', 'tools/mobile/prepare-native.mjs', 'tools/frontend-closure.mjs', 'tools/build.mjs', 'package.json', 'package-lock.json']) {
    if (web.mobile.builderInputs?.[path] !== digest(await readFile(join(sourceRoot, path))))
      throw new Error(`Mobile builder input differs from the selected build: ${path}`);
  }
  for (const url of [web.mobile.entry, ...web.mobile.styles, ...Object.keys(web.mobile.files ?? {})]) {
    const path = web.mobile.files?.[url] ?? web.files[url];
    if (typeof path !== 'string' || typeof release.web[path] !== 'string' || await shaFile(join(sourceRoot, path)) !== release.web[path])
      throw new Error(`Mobile preview output is absent from the immutable release inventory: ${url}`);
  }

  const bundle = await buildMobileBundle({ sourceRoot, plan, closure, bundleRoot: resolve(sourceRoot, '.local/mobile-001/bundle-layout'), mode: 'packaged', uiBindings: selectedUi.bindings, planDigest: release.planDigest });
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
  if (selectedUi.mapping) sourceInputs[selectedUi.mapping.path] = selectedUi.mapping.sha256;
  const assemblyInputs = {};
  for (const path of ['tools/mobile/assemble.mjs', 'tools/mobile/prepare-native.mjs', 'tools/frontend-closure.mjs', 'tools/build.mjs', 'package.json', 'package-lock.json'])
    assemblyInputs[path] = digest(await readFile(join(sourceRoot, path)));
  const templateInputs = {};
  for (const path of ['package.json', 'package-lock.json', 'README.md'])
    templateInputs[`templates/mobile/${path}`] = digest(await readFile(join(sourceRoot, 'templates/mobile', path)));
  for (const path of NATIVE_TEMPLATE_FILES) {
    if (path.startsWith('templates/mobile/')) templateInputs[path] = digest(await readFile(join(sourceRoot, ...path.split('/'))));
  }
  const sourceCandidate = digest(JSON.stringify({ productId, planDigest: release.planDigest, sourceInputs, assemblyInputs, templateInputs, uiMapping: selectedUi.mapping, esbuildVersion }));
  const appId = `com.quadbridge.products.${productId.replace(/-/g, '_')}`;
  const config = { appId, appName: plan.product.title, webDir: 'www', bundledWebRuntime: false,
    server: { hostname: 'localhost', androidScheme: 'http', iosScheme: 'capacitor' }, loggingBehavior: 'none' };
  const bundleInputs = Object.keys(bundle.inputs).filter(path => path !== 'mobile-entry.mjs').sort().map(portable);
  const connection = { state: 'FIXED_LOCAL_NATIVE_PROFILE', authenticationAdapter: 'QBUserSession', apiProfile: 'local-native-forwarded-v1', apiOrigin: 'http://127.0.0.1:4350',
    expectedRuntime: { productId: plan.product.id, productVersion: plan.product.version, instanceId: `${plan.product.id}-local`, modules: plan.modules.map(module => ({ id: module.id, version: module.version })) } };
  const nativeTemplate = { capacitor: '8.5.2', app: '8.1.1', appId, webDir: 'www', server: config.server, remoteServerUrl: null, loggingBehavior: 'none', nativeSession: '@quadbridge/native-session@0.1.0', uiMapping: selectedUi.mapping };
  const expectedManifest = {
    schema: 'quadbridge.mobile-client.v1', status: 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION', productId,
    productVersion: plan.product.version, planDigest: release.planDigest, sourceCandidate, clientOnly: true,
    connection, nativeTemplate, uiBindings: selectedUi.bindings, sourceFiles: sourceInputs, assemblyInputs,
    templateInputs, toolchain: { esbuild: esbuildVersion }, bundleInputs
  };
  const destination = resolve(outputBase, productId, sourceCandidate.slice(0, 20));
  if (await isPresent(destination)) return { outputDir: destination, manifest: await verifyExisting(destination, expectedManifest), reused: true };
  await mkdir(destination, { recursive: true });
  const packageFiles = ['package.json', 'package-lock.json', 'README.md'];
  for (const path of packageFiles) await copyFile(join(sourceRoot, 'templates/mobile', path), join(destination, path), COPYFILE_EXCL);
  await copyNativeTemplateInputs(sourceRoot, destination);
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
  await writeFile(join(publicDir, 'qb-runtime-identity.json'), json({ productId: plan.product.id, productVersion: plan.product.version,
    instanceId: `${plan.product.id}-local`, planDigest: release.planDigest,
    modules: plan.modules.map(module => ({ id: module.id, version: module.version })) }), { flag: 'wx' });

  const outputFiles = {};
  for (const path of await listRegularFiles(destination)) {
    if (path !== 'mobile-manifest.json') outputFiles[path] = await shaFile(join(destination, ...path.split('/')));
  }
  const outputCandidate = digest(canonical({ format: OUTPUT_FINGERPRINT_FORMAT, sourceCandidate, outputFiles }));
  const manifest = {
    ...expectedManifest,
    outputFingerprintFormat: OUTPUT_FINGERPRINT_FORMAT,
    outputCandidate,
    generatedAt: new Date().toISOString(),
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
