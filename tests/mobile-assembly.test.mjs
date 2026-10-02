import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleMobile, buildMobileBundle, validateMobilePlanIdentity } from '../tools/mobile/assemble.mjs';

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
  for (const productId of ['neutral', 'service-desk', 'combined']) {
    const { outputDir, manifest } = await assembleMobile({ productId, outputBase });
    assert.equal(manifest.status, 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION');
    assert.equal(manifest.clientOnly, true);
    assert.deepEqual(manifest.connection, { state: 'NOT_CONFIGURED', authenticationAdapter: null, apiProfile: null, performsRequests: false });
    assert.equal(manifest.nativeTemplate.capacitor, '8.5.2');
    assert.equal(manifest.nativeTemplate.remoteServerUrl, null);
    const actual = (await listFiles(outputDir)).filter(path => path !== 'mobile-manifest.json');
    assert.deepEqual(actual, Object.keys(manifest.outputFiles).sort());
    for (const path of actual) {
      const expected = manifest.outputFiles[path];
      const bytes = await readFile(join(outputDir, ...path.split('/')));
      const { createHash } = await import('node:crypto');
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
    assert.equal(config.server, undefined);
    const template = JSON.parse(await readFile(join(outputDir, 'package.json'), 'utf8'));
    assert.equal(template.dependencies['@capacitor/core'], '8.5.2');
    assert.equal(template.dependencies['@capacitor/android'], '8.5.2');
    assert.equal(template.devDependencies['@capacitor/cli'], '8.5.2');
    assert.equal(template.dependencies['@capacitor/ios'], '8.5.2');
    assert.ok(actual.some(path => path.startsWith('www/assets/mobile-preview/assets/')));
    assert.ok(actual.every(path => !/node_modules|backend-host|worker-host|local-profile|modules\/[^/]+\/dist\/index\.js/u.test(path)));
    const texts = await Promise.all(actual.filter(path => /\.(?:js|html|json)$/u.test(path)).map(path => readFile(join(outputDir, ...path.split('/'),), 'utf8').catch(() => '')));
    assert.ok(texts.every(text => !/serviceToken|DatabaseSync|node:sqlite/u.test(text)), `${productId} contains no server store or credential implementation`);
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
