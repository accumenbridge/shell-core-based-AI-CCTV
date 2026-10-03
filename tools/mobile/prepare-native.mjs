import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const mode = process.argv[2];
if (mode !== 'android' && mode !== 'ios') throw new Error('Usage: node tools/prepare-native.mjs <android|ios>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRelative = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
  !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f:]/.test(part));
const PACKAGE_TEMPLATE_FILES = ['package.json', 'package-lock.json', 'README.md'];
const NATIVE_TEMPLATE_FILES = [
  'native-session/package.json',
  'native-session/android/build.gradle',
  'native-session/android/src/main/AndroidManifest.xml',
  'native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java',
  'native-session/Package.swift',
  'native-session/ios/Sources/NativeSessionPlugin/NativeSessionPlugin.swift',
  'android-debug/AndroidManifest.xml',
  'android-debug/network_security_config.xml',
  'qualification/android-test.gradle',
  'qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java'
];

async function physical(path, expected = 'file') {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (expected === 'file' ? !info.isFile() : !info.isDirectory()) || await realpath(path) !== path)
    throw new Error('Native preparation found a non-physical generated input.');
  return info;
}

async function checkedFile(relativePath, expectedDigest, maximum = 16 * 1024 * 1024) {
  if (!safeRelative(relativePath) || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest))
    throw new Error('Native preparation manifest contains an invalid file identity.');
  const full = join(root, ...relativePath.split('/'));
  const fromRoot = relative(root, full);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Native preparation path escaped its generated app.');
  await physical(full);
  const bytes = await readFile(full);
  if (bytes.length > maximum || sha(bytes) !== expectedDigest) throw new Error('Generated native input differs from its immutable assembly.');
  return bytes;
}

await physical(root, 'directory');
const manifestBytes = await checkedFile('mobile-manifest.json', (await readFile(join(root, 'mobile-manifest.json'))).length ? sha(await readFile(join(root, 'mobile-manifest.json'))) : '');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest?.schema !== 'quadbridge.mobile-client.v1' || manifest.status !== 'LOCAL_CLIENT_PACKAGE_NOT_NATIVE_QUALIFICATION' ||
    manifest.connection?.state !== 'FIXED_LOCAL_NATIVE_PROFILE' || manifest.connection?.authenticationAdapter !== 'QBUserSession' ||
    manifest.connection?.apiProfile !== 'local-native-forwarded-v1' || manifest.connection?.apiOrigin !== 'http://127.0.0.1:4350' ||
    manifest.nativeTemplate?.capacitor !== '8.5.2' || manifest.nativeTemplate?.nativeSession !== '@quadbridge/native-session@0.1.0')
  throw new Error('This generated app does not match the fixed native profile.');
if (!manifest.outputFiles || typeof manifest.outputFiles !== 'object' || Array.isArray(manifest.outputFiles))
  throw new Error('Generated mobile output inventory is missing.');
for (const [path, expected] of Object.entries(manifest.outputFiles)) await checkedFile(path, expected);
const appPackage = JSON.parse((await checkedFile('package.json', manifest.outputFiles['package.json'])).toString('utf8'));
if (appPackage.dependencies?.['@capacitor/core'] !== '8.5.2' || appPackage.dependencies?.['@capacitor/android'] !== '8.5.2' ||
    appPackage.dependencies?.['@capacitor/ios'] !== '8.5.2' || appPackage.dependencies?.['@capacitor/app'] !== '8.1.1' ||
    appPackage.dependencies?.['@quadbridge/native-session'] !== 'file:./native-session' || appPackage.devDependencies?.['@capacitor/cli'] !== '8.5.2')
  throw new Error('Generated mobile package dependencies differ from the reviewed profile.');
const config = JSON.parse((await checkedFile('capacitor.config.json', manifest.outputFiles['capacitor.config.json'])).toString('utf8'));
if (config.appId !== manifest.nativeTemplate.appId || config.webDir !== 'www' || config.loggingBehavior !== 'none' ||
    config.server?.hostname !== 'localhost' || config.server?.androidScheme !== 'http' || config.server?.iosScheme !== 'capacitor' ||
    config.server?.url !== undefined || config.server?.allowNavigation !== undefined || config.allowNavigation !== undefined)
  throw new Error('Generated Capacitor config is not the fixed private local profile.');

const templateInputs = manifest.templateInputs;
if (!templateInputs || typeof templateInputs !== 'object' || Array.isArray(templateInputs))
  throw new Error('The fixed native template inventory is missing.');
for (const path of PACKAGE_TEMPLATE_FILES) {
  const sourcePath = `templates/mobile/${path}`;
  const expected = templateInputs[sourcePath];
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || manifest.outputFiles[path] !== expected)
    throw new Error('The packaged mobile template identity differs from its immutable output.');
}
const actualNativePaths = Object.keys(templateInputs)
  .filter(path => path.startsWith('templates/mobile/') && !PACKAGE_TEMPLATE_FILES.some(file => path === `templates/mobile/${file}`))
  .sort();
const expectedNativePaths = NATIVE_TEMPLATE_FILES.map(path => `templates/mobile/${path}`).sort();
if (JSON.stringify(actualNativePaths) !== JSON.stringify(expectedNativePaths))
  throw new Error('The fixed native source inventory is incomplete or contains an unreviewed input.');
for (const path of NATIVE_TEMPLATE_FILES) {
  const sourcePath = `templates/mobile/${path}`;
  const expected = templateInputs[sourcePath];
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || manifest.outputFiles[path] !== expected)
    throw new Error('A fixed native template identity differs from its immutable output.');
  const generatedPath = path;
  await checkedFile(generatedPath, expected);
}
const prepareDigest = manifest.assemblyInputs?.['tools/mobile/prepare-native.mjs'];
await checkedFile('tools/prepare-native.mjs', prepareDigest);
const lockBytes = await checkedFile('package-lock.json', manifest.outputFiles['package-lock.json']);
const lock = JSON.parse(lockBytes.toString('utf8'));
if (lock.packages?.['']?.dependencies?.['@capacitor/core'] !== '8.5.2' ||
    lock.packages?.['']?.dependencies?.['@capacitor/app'] !== '8.1.1' ||
    lock.packages?.['']?.dependencies?.['@quadbridge/native-session'] !== 'file:./native-session')
  throw new Error('Generated dependency lock does not match the fixed native profile.');

if (mode === 'ios') {
  console.log(JSON.stringify({ profile: 'local-native-forwarded-v1', source: 'verified', binaryBuild: 'NOT_RUN_REQUIRES_MACOS' }));
  process.exit(0);
}

const androidRoot = join(root, 'android');
await physical(androidRoot, 'directory');
const androidApp = join(androidRoot, 'app');
await physical(androidApp, 'directory');
const appBuild = join(androidApp, 'build.gradle');
await physical(appBuild);
const marker = '// QUADBRIDGE_NATIVE_QUALIFICATION_V1';
const applyLine = 'apply from: "$rootDir/../qualification/android-test.gradle"';
let buildText = await readFile(appBuild, 'utf8');
const markerCount = buildText.split(marker).length - 1;
const applyCount = buildText.split(applyLine).length - 1;
if (markerCount === 0 && applyCount === 0) {
  buildText += `${buildText.endsWith('\n') ? '' : '\n'}\n${marker}\n${applyLine}\n`;
  await writeFile(appBuild, buildText, { flag: 'w' });
} else if (markerCount !== 1 || applyCount !== 1 || !buildText.includes(`${marker}\n${applyLine}`)) {
  throw new Error('Generated Android app has a conflicting qualification build overlay.');
}

async function copyExact(sourceRelative, destinationRelative) {
  const source = join(root, ...sourceRelative.split('/'));
  const expected = manifest.templateInputs?.[`templates/mobile/${sourceRelative}`];
  if (!expected) throw new Error('Native overlay is absent from the selected immutable template inventory.');
  const bytes = await checkedFile(sourceRelative, expected);
  const target = join(androidRoot, ...destinationRelative.split('/'));
  const targetRelative = relative(androidRoot, target);
  if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) throw new Error('Android overlay escaped the generated project.');
  let cursor = androidRoot;
  for (const part of targetRelative.split(/[\\/]/).slice(0, -1)) {
    cursor = join(cursor, part);
    try { await physical(cursor, 'directory'); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(cursor);
      await physical(cursor, 'directory');
    }
  }
  try {
    await physical(target);
    const existing = await readFile(target);
    if (sha(existing) !== expected) throw new Error('Generated Android overlay conflicts with its reviewed input.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(target, bytes, { flag: 'wx' });
  }
}

await copyExact('android-debug/AndroidManifest.xml', 'app/src/debug/AndroidManifest.xml');
await copyExact('android-debug/network_security_config.xml', 'app/src/debug/res/xml/qb_native_loopback_debug_network_security_config.xml');
await copyExact('qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java', 'app/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java');
console.log(JSON.stringify({ profile: 'local-native-forwarded-v1', androidOverlay: 'VERIFIED', instrumentation: 'STAGED_NOT_EXECUTED' }));
