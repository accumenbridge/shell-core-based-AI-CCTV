import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManagedMobile, assembleMobile, buildMobileBundle, validateMobilePlanIdentity, verifyManagedClientDirectory } from '../tools/mobile/assemble.mjs';
import { verifyReleaseArtifacts } from '../packages/composition/dist/integrity.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = async path => JSON.parse(await readFile(join(ROOT, path), 'utf8'));
const listFiles = async root => {
  const files = [];
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await visit(path);
      else files.push(relative(root, path).split('\\').join('/'));
    }
  }
  await visit(root);
  return files.sort();
};

test('mobile packaging derives neutral, Desk and Combined client-only snapshots with exact inventories', async t => {
  const outputBase = await mkdtemp(join(tmpdir(), 'qb-mobile-assembly-'));
  t.after(() => rm(outputBase, { recursive: true, force: true }));
  const nativeSessionSource = await readFile(join(ROOT, 'templates/mobile/native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java'), 'utf8');
  assert.match(nativeSessionSource, /result\.put\("token",\s*JSONObject\.NULL\)/u, 'an absent encrypted token is returned as explicit JSON null');
  for (const productId of ['neutral', 'service-desk', 'combined']) {
    const { outputDir, manifest } = await assembleMobile({ productId, outputBase });
    const preview = await readJson(`.artifacts/${productId}/web.json`);
    assert.equal(manifest.status, 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION');
    assert.equal(manifest.clientOnly, true);
    assert.equal(manifest.connection.state, 'FIXED_LOCAL_NATIVE_PROFILE');
    assert.equal(manifest.connection.authenticationAdapter, 'QBUserSession');
    assert.equal(manifest.connection.apiProfile, 'local-native-forwarded-v1');
    assert.equal(manifest.connection.apiOrigin, 'http://127.0.0.1:4350');
    assert.equal(manifest.connection.expectedRuntime.productId, productId);
    assert.equal(manifest.connection.expectedRuntime.productVersion, manifest.productVersion);
    assert.deepEqual(manifest.uiBindings, preview.mobile.uiBindings ?? [], `${productId} packaged bindings match the compiled preview bindings`);
    assert.deepEqual(manifest.nativeTemplate.uiMapping, preview.mobile.uiMapping ?? null, `${productId} package records the same reviewed UI mapping identity`);
    if (productId === 'combined') assert.deepEqual(manifest.uiBindings.map(binding=>binding.slot),['workspace.aside','workspace.footer']);
    assert.equal(manifest.nativeTemplate.capacitor, '8.5.2');
    assert.equal(manifest.nativeTemplate.remoteServerUrl, null);
    const actual = (await listFiles(outputDir)).filter(path => path !== 'mobile-manifest.json');
    assert.deepEqual(actual, Object.keys(manifest.outputFiles).sort());
    for (const path of actual) {
      const expected = manifest.outputFiles[path];
      const bytes = await readFile(join(outputDir, ...path.split('/')));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${productId}:${path}`);
    }
    const html = await readFile(join(outputDir, 'www/index.html'), 'utf8');
    const entry = html.match(/<script type="module" src="([^"]+)"/u)?.[1];
    assert.ok(entry, `${productId} has a fixed local entry point`);
    assert.ok(manifest.outputFiles[`www${entry}`], `${productId} entry is inventoried`);
    assert.match(html, /<meta name="viewport"/u);
    assert.match(html, /mobile-preview\/assets\/raw\/[a-f0-9]{16}\.css/u);
    const config = JSON.parse(await readFile(join(outputDir, 'capacitor.config.json'), 'utf8'));
    assert.equal(config.webDir, 'www');
    assert.deepEqual(config.server, { hostname: 'localhost', androidScheme: 'http', iosScheme: 'capacitor' });
    assert.equal(config.loggingBehavior, 'none');
    assert.equal(config.server.url, undefined);
    const template = JSON.parse(await readFile(join(outputDir, 'package.json'), 'utf8'));
    assert.equal(template.dependencies['@capacitor/core'], '8.5.2');
    assert.equal(template.dependencies['@capacitor/android'], '8.5.2');
    assert.equal(template.devDependencies['@capacitor/cli'], '8.5.2');
    assert.equal(template.dependencies['@capacitor/ios'], '8.5.2');
    assert.equal(template.dependencies['@capacitor/app'], '8.1.1');
    assert.ok(actual.some(path => path.startsWith('www/assets/mobile-preview/assets/')));
    assert.ok(actual.every(path => !/node_modules|backend-host|worker-host|local-profile|modules\/[^/]+\/dist\/index\.js/u.test(path)));
    const texts = await Promise.all(actual.filter(path => /\.(?:js|html|json)$/u.test(path)).map(path => readFile(join(outputDir, ...path.split('/'),), 'utf8').catch(() => '')));
    assert.ok(texts.every(text => !/serviceToken|DatabaseSync|node:sqlite/u.test(text)), `${productId} contains no server store or credential implementation`);
  }
});

test('F11: mobile reuse verifies versioned source and output identities before returning an existing package', async t => {
  const outputBase = await mkdtemp(join(tmpdir(), 'qb-mobile-reuse-'));
  t.after(() => rm(outputBase, { recursive: true, force: true }));
  const first = await assembleMobile({ productId: 'service-desk', outputBase });
  assert.equal(first.manifest.outputFingerprintFormat, 'quadbridge.mobile-output-fingerprint.v2');
  assert.match(first.manifest.outputCandidate, /^[a-f0-9]{64}$/u);
  const reused = await assembleMobile({ productId: 'service-desk', outputBase });
  assert.equal(reused.reused, true);
  assert.equal(reused.manifest.outputCandidate, first.manifest.outputCandidate);

  const manifestPath = join(first.outputDir, 'mobile-manifest.json');
  const htmlPath = join(first.outputDir, 'www', 'index.html');
  const originalManifestBytes = await readFile(manifestPath);
  const originalManifest = JSON.parse(originalManifestBytes);
  const originalHtml = await readFile(htmlPath);
  const changedHtml = Buffer.from('<!doctype html><title>edited output</title>\n');
  await writeFile(htmlPath, changedHtml);
  const outputEdited = structuredClone(originalManifest);
  outputEdited.outputFiles['www/index.html'] = createHash('sha256').update(changedHtml).digest('hex');
  outputEdited.webInventory['www/index.html'] = outputEdited.outputFiles['www/index.html'];
  await writeFile(manifestPath, `${JSON.stringify(outputEdited, null, 2)}\n`);
  await assert.rejects(assembleMobile({ productId: 'service-desk', outputBase }), /output candidate fingerprint differs/u,
    'changing the HTML and its stored file hash cannot preserve the old output candidate');

  await writeFile(htmlPath, originalHtml);
  const sourceEdited = structuredClone(originalManifest);
  const sourcePath = Object.keys(sourceEdited.sourceFiles)[0];
  sourceEdited.sourceFiles[sourcePath] = '0'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(sourceEdited, null, 2)}\n`);
  await assert.rejects(assembleMobile({ productId: 'service-desk', outputBase }), /source identity differs at sourceFiles/u,
    'the manifest source inventory remains bound to the independently recomputed source candidate');

  await writeFile(manifestPath, originalManifestBytes);
  const legacy = structuredClone(originalManifest);
  delete legacy.outputFingerprintFormat;
  legacy.outputCandidate = createHash('sha256').update(JSON.stringify({ sourceCandidate: legacy.sourceCandidate, outputFiles: legacy.outputFiles })).digest('hex');
  await writeFile(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const verifiedLegacy = await assembleMobile({ productId: 'service-desk', outputBase });
  assert.equal(verifiedLegacy.reused, true, 'a legacy output is accepted only under its exact original digest algorithm');

  await rm(htmlPath);
  await assert.rejects(assembleMobile({ productId: 'service-desk', outputBase }), /output inventory differs/u,
    'a missing physical output cannot be hidden by a valid stored manifest');
});

test('release verification accepts the packaged seed entry independently of the preview entry', async () => {
  const [plan, web, seed] = await Promise.all([
    readJson('.artifacts/combined/plan.json'), readJson('.artifacts/combined/web.json'), readJson('.artifacts/combined/n/seed.json')
  ]);
  assert.notEqual(seed.entry, web.mobile.entry, 'preview and packaged entry bundles have mode-specific identities');
  assert.ok(seed.files[`www${seed.entry}`], 'the packaged entry is present in the seed-owned inventory');
  assert.ok(seed.files['www/index.html'], 'the packaged HTML entry is present in the seed-owned inventory');
  const verified = verifyReleaseArtifacts(ROOT, 'combined', plan.product.version);
  assert.equal(verified.planDigest, seed.planDigest);
});

test('managed Android client packages the captured seed for one exact canonical runtime generation', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'qb-managed-mobile-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const seedRoot = join(ROOT, '.artifacts', 'combined', 'n');
  const seedManifest = JSON.parse(await readFile(join(seedRoot, 'seed.json'), 'utf8'));
  const instanceId = `runtime-${randomUUID()}`;
  const identity = {
    productId: 'combined', productVersion: seedManifest.productVersion,
    instanceId, generationId: `generation:${instanceId}:1`,
    artifactDigest: 'a'.repeat(64), planDigest: seedManifest.planDigest,
    modules: seedManifest.modules, nativeApiProfile: 'local-native-forwarded-v1'
  };
  let authorizationChecks=0;
  const result = await assembleManagedMobile({ projectRoot, seedManifest, identity,
    readSeedFile: blob => readFile(join(seedRoot, ...blob.split('/'))), authorize: () => {authorizationChecks++;return true;} });
  assert.match(result.clientReference, /^managed-mobile-[a-f0-9]{20}$/u);
  assert.equal(result.manifest.identity.instanceId, identity.instanceId);
  assert.equal(result.manifest.identity.generationId, identity.generationId);
  const verified = await verifyManagedClientDirectory(result.outputDir, { clientReference: result.clientReference, identity: result.manifest.identity });
  assert.equal(verified.clientReference, result.clientReference);
  const actual = (await listFiles(result.outputDir)).sort();
  assert.deepEqual(actual, [...Object.keys(result.manifest.files), 'managed-client.json'].sort());
  const managedMobile = JSON.parse(await readFile(join(result.outputDir, 'mobile-manifest.json'), 'utf8'));
  assert.deepEqual(managedMobile.connection.expectedRuntime, {
    productId: identity.productId, productVersion: identity.productVersion, instanceId: identity.instanceId, modules: identity.modules
  });
  assert.equal(managedMobile.nativeTemplate.loggingBehavior, 'none');
  assert.equal(actual.some(path => path.startsWith('node_modules/')), false);

  await rm(result.outputDir,{recursive:true,force:false});
  let currentGeneration=identity.generationId,publicationChecks=0;
  await assert.rejects(assembleManagedMobile({projectRoot,seedManifest,identity,
    readSeedFile:blob=>readFile(join(seedRoot,...blob.split('/'))),
    authorize:()=>{
      publicationChecks++;
      if(publicationChecks===authorizationChecks-1)queueMicrotask(()=>{currentGeneration=`generation:${instanceId}:2`;});
      return currentGeneration===identity.generationId;
    }}),/Original paired session is no longer authorized/u,
  'a generation change during the final destination check blocks publication');
  assert.equal(publicationChecks,authorizationChecks,'the stale-generation refusal reaches the final atomic publication boundary');
  await assert.rejects(readdir(result.outputDir),{code:'ENOENT'},'the stale captured generation is not published');
  assert.deepEqual(await readdir(join(projectRoot,'.local','managed-mobile')),[],'the owned staging copy is cleaned after refusal');
});

test('native preparation verifies a generated app inventory and installs the exact Android debug overlay', async t => {
  const outputBase = await mkdtemp(join(tmpdir(), 'qb-mobile-prepare-'));
  t.after(() => rm(outputBase, { recursive: true, force: true }));
  const { outputDir, manifest } = await assembleMobile({ productId: 'combined', outputBase });
  const androidApp = join(outputDir, 'android', 'app');
  await mkdir(androidApp, { recursive: true });
  await writeFile(join(androidApp, 'build.gradle'), 'plugins { id "com.android.application" }\n', { flag: 'wx' });

  const prepared = spawnSync(process.execPath, [join(outputDir, 'tools', 'prepare-native.mjs'), 'android'], {
    cwd: outputDir, encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.ifError(prepared.error);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  assert.deepEqual(JSON.parse(prepared.stdout.trim()), {
    profile: 'local-native-forwarded-v1', androidOverlay: 'VERIFIED', instrumentation: 'STAGED_NOT_EXECUTED'
  });

  const gradle = await readFile(join(androidApp, 'build.gradle'), 'utf8');
  assert.equal(gradle.split('// QUADBRIDGE_NATIVE_QUALIFICATION_V1').length - 1, 1);
  assert.equal(gradle.split('apply from: "$rootDir/../qualification/android-test.gradle"').length - 1, 1);
  for (const [path, sourcePath] of [
    ['src/debug/AndroidManifest.xml', 'templates/mobile/android-debug/AndroidManifest.xml'],
    ['src/debug/res/xml/qb_native_loopback_debug_network_security_config.xml', 'templates/mobile/android-debug/network_security_config.xml'],
    ['src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java', 'templates/mobile/qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java']
  ]) {
    const copied = await readFile(join(androidApp, ...path.split('/')));
    assert.equal(createHash('sha256').update(copied).digest('hex'), manifest.templateInputs[sourcePath], sourcePath);
  }
});

test('compact mobile preview assets fit the managed runtime copy path geometry', async () => {
  const release = await readJson('.artifacts/service-desk/release.json');
  const checkoutRoot = String.raw`C:\Users\Lenovo\AppData\Local\Temp\q3-ABCDEF\checkout`;
  const runtimeId = 'runtime-11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  assert.equal(runtimeId.length, 44);
  assert.equal(operationId.length, 36);
  const snapshotRoot = win32.join(checkoutRoot, '.local', 'platform-runtime-executions', runtimeId, operationId, 'snapshot');
  assert.equal(snapshotRoot.length, 179, 'mirrors the q3 checkout and fixed runtime-/operation-UUID path shape');
  const mobilePaths = Object.keys(release.web).filter(path => path.startsWith('.artifacts/service-desk/m/'));
  assert.ok(mobilePaths.length > 0, 'the exported snapshot includes the compact mobile preview closure');
  const oversized = mobilePaths.map(path => win32.join(snapshotRoot, ...path.split('/'))).filter(path => path.length >= 240);
  assert.deepEqual(oversized, [], 'every selected mobile output stays below the unchanged private-copy path bound');
});

test('mobile assembler rejects a plan mutation against the frozen release identity', async () => {
  const plan = await readJson('.artifacts/service-desk/plan.json');
  const release = await readJson('.artifacts/service-desk/release.json');
  validateMobilePlanIdentity(plan, release);
  const changed = structuredClone(plan);
  changed.product.title += ' changed';
  assert.throws(() => validateMobilePlanIdentity(changed, release), /plan digest differs/u);
});

test('mobile bundler rebases nested new-URL assets into its reviewed raw asset tree', async t => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'qb-mobile-bundle-'));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const put = async (path, content) => {
    const target = join(sourceRoot, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  await put('packages/mobile-shell/dist/index.js', "import {el} from '@quadbridge/web-shell/dom'; export const startMobileShell=()=>el; export const startPackagedMobileShell=()=>el;");
  await put('packages/web-shell/dist/dom.js', 'export const el=1;');
  await put('modules/example/dist/ui.js', "export const icon=new URL('./assets/icons/marker.svg',import.meta.url);");
  await put('modules/example/dist/ui.css', `@import './theme.css' screen and (min-width: 1px);\n.icon{background-image:url('./assets/icons/marker.svg');mask-image:url(#mask);cursor:url(data:image/svg+xml;base64,PHN2Zz4=)}\n/* url('./missing.svg') @import './missing.css'; */`);
  await put('modules/example/dist/theme.css', `@import './nested.css' print;\n@font-face{src:url('./assets/fixture.woff2') format('woff2')}`);
  await put('modules/example/dist/nested.css', '.nested{background-image:url(./assets/icons/marker.svg)}');
  await put('modules/example/dist/assets/icons/marker.svg', '<svg><circle cx="4" cy="4" r="3"/></svg>');
  await put('modules/example/dist/assets/fixture.woff2', Buffer.from([0, 1, 2, 3]));
  const closure = {
    imports: {
      '@quadbridge/mobile-shell': '/assets/packages/mobile-shell/index.js',
      '@quadbridge/web-shell/dom': '/assets/packages/web-shell/dom.js',
      '@quadbridge/example/ui': '/assets/modules/example/ui.js'
    },
    files: {
      '/assets/packages/mobile-shell/index.js': 'packages/mobile-shell/dist/index.js',
      '/assets/packages/web-shell/dom.js': 'packages/web-shell/dist/dom.js',
      '/assets/modules/example/ui.js': 'modules/example/dist/ui.js',
      '/assets/modules/example/ui.css': 'modules/example/dist/ui.css',
      '/assets/modules/example/theme.css': 'modules/example/dist/theme.css',
      '/assets/modules/example/nested.css': 'modules/example/dist/nested.css',
      '/assets/modules/example/assets/icons/marker.svg': 'modules/example/dist/assets/icons/marker.svg',
      '/assets/modules/example/assets/fixture.woff2': 'modules/example/dist/assets/fixture.woff2'
    },
    mobileStyles: ['/assets/modules/example/ui.css']
  };
  const plan = { product: { title: 'Fixture' }, modules: [{ id: 'example', workspaces: [{}] }] };
  const bundle = await buildMobileBundle({ sourceRoot, plan, closure, bundleRoot: join(sourceRoot, 'bundle'), mode: 'packaged' });
  const entry = bundle.outputs.find(output => `/${output.path}` === bundle.entry);
  assert.ok(entry);
  const bundledText = bundle.outputs.map(output => Buffer.from(output.contents).toString('utf8')).join('\n');
  const marker = bundle.rawAssets.find(asset => asset.source === 'modules/example/dist/assets/icons/marker.svg');
  const font = bundle.rawAssets.find(asset => asset.source === 'modules/example/dist/assets/fixture.woff2');
  const rootCss = bundle.rawAssets.find(asset => asset.source === 'modules/example/dist/ui.css');
  const themeCss = bundle.rawAssets.find(asset => asset.source === 'modules/example/dist/theme.css');
  const nestedCss = bundle.rawAssets.find(asset => asset.source === 'modules/example/dist/nested.css');
  assert.ok(marker && font && rootCss && themeCss && nestedCss);
  const markerName = marker.path.split('/').at(-1);
  assert.match(bundledText, new RegExp(`new URL\\("\\.\\/raw\\/${markerName.replace('.', '\\.')}",\\s*import\\.meta\\.url\\)`, 'u'));
  const rootCssText = rootCss.contents.toString('utf8');
  const themeCssText = themeCss.contents.toString('utf8');
  const nestedCssText = nestedCss.contents.toString('utf8');
  assert.ok(rootCssText.includes(`@import './${themeCss.path.split('/').at(-1)}' screen and (min-width: 1px);`));
  assert.ok(rootCssText.includes(`url('./${markerName}')`));
  assert.ok(rootCssText.includes('url(#mask)'));
  assert.ok(rootCssText.includes('url(data:image/svg+xml;base64,PHN2Zz4=)'));
  assert.ok(rootCssText.includes("/* url('./missing.svg') @import './missing.css'; */"), 'comment text is preserved without becoming a dependency');
  assert.ok(themeCssText.includes(`@import './${nestedCss.path.split('/').at(-1)}' print;`));
  assert.ok(themeCssText.includes(`url('./${font.path.split('/').at(-1)}')`));
  assert.ok(nestedCssText.includes(`url(./${markerName})`));
  assert.ok(bundle.css.includes(rootCss.path));
  assert.ok(bundle.rawAssets.every(asset => /^assets\/raw\/[a-f0-9]{16}\.[a-z0-9]+$/u.test(asset.path)), 'asset basenames are compact and retain MIME extensions');
  assert.equal(bundle.outputs.some(output => output.path.endsWith('marker.svg')), false);
  assert.ok(closure.files['/assets/modules/example/assets/icons/marker.svg']);
});
