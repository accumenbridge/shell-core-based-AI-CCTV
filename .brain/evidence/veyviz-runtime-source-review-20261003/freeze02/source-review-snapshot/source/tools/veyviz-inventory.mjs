import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SOURCE_ROOTS = ['packages', 'apps', 'modules', 'products', 'solutions', 'services/veyviz-ai', 'vendor/veyviz-ai', 'contracts/veyviz-product-ai', 'tools', 'tests', 'templates', 'profiles'];
const ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', '.nvmrc', 'AGENTS.md'];
const BUILD_EXTRA_FILES = ['visual/studio.js', 'visual/studio.css'];
const V1_SKIP = new Set(['dist', '__pycache__', 'node_modules', '.venv', '.git']);
const BUILD_SKIP = new Set([...V1_SKIP, '.local', '.artifacts', 'generated']);
const hash = value => createHash('sha256').update(value).digest('hex');
const QUALIFICATION_ROOT = '.local/veyviz-build-qualification';
const QUALIFICATION_SCHEMA = 'veyviz.build-qualification.v1';
const INPUT_SCHEMA = 'veyviz.authored-build-inputs.v1';
const TOOLCHAIN_SCHEMA = 'veyviz.build-toolchain.v1';
const OUTPUT_SCHEMA = 'veyviz.build-outputs.v1';
const MAX_INPUT_FILES = 30_000;
const MAX_SOURCE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_TOOL_FILES = 30_000;
const MAX_TOOL_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOOL_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_TOOLCHAIN_FILES = 60_000;
const MAX_TOOLCHAIN_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_NODE_BYTES = 512 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const PRODUCTS = ['veyviz-catalog', 'veyviz-review'];

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw Error('Value is not canonical JSON.');
}

function normalizePath(path) { return path.replaceAll('\\', '/'); }

function excludedAuthoredFile(path) {
  const normalized = normalizePath(path).toLowerCase();
  return normalized === 'open_platform.html' || normalized === 'visual/data.json' ||
    normalized.endsWith('.pyc') || normalized.endsWith('.tsbuildinfo');
}

async function paths(root, profile = 'release-v1') {
  const authored = profile === 'authored-build';
  const skip = authored ? BUILD_SKIP : V1_SKIP;
  const result = [];
  async function walk(path) {
    const full = join(root, path);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw Error(`Source inventory refuses links: ${path}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(full)).sort()) {
        if (!skip.has(authored ? entry.toLowerCase() : entry)) await walk(`${path}/${entry}`);
      }
    } else if (info.isFile()) {
      const excluded = authored ? excludedAuthoredFile(path) : (path.endsWith('.pyc') || path.endsWith('.tsbuildinfo'));
      if (!excluded) result.push(normalizePath(path));
    } else throw Error(`Unsupported inventory entry: ${path}`);
  }
  for (const path of SOURCE_ROOTS) await walk(path);
  const rootFiles = authored ? ROOT_FILES.filter(path => path !== 'tsconfig.json') : ROOT_FILES;
  const extraFiles = authored ? BUILD_EXTRA_FILES : [];
  const extras = [...rootFiles, ...extraFiles];
  for (const path of extras) {
    const full = join(root, path);
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isFile()) throw Error(`Source inventory requires a physical regular file: ${path}`);
    result.push(normalizePath(path));
  }
  const sorted = result.sort();
  if (authored) {
    if (new Set(sorted).size !== sorted.length) throw Error('Source inventory found duplicate paths.');
    if (sorted.length > MAX_INPUT_FILES) throw Error('Authored source inventory exceeds its file-count bound.');
    if (sorted.some(path => path.length > MAX_PATH_CHARS || path.startsWith('/') || path.split('/').includes('..')))
      throw Error('Source inventory contains a non-portable path.');
  }
  return sorted;
}

async function assertPhysicalRoot(root) {
  const full = resolve(root);
  const info = await lstat(full);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(full)).toLowerCase() !== full.toLowerCase())
    throw Error('Build qualification root must be a physical directory.');
  return full;
}

async function physicalEntry(root, path) {
  let current = root;
  const parts = normalizePath(path).split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Error(`Build qualification refuses linked path: ${path}`);
    if (i < parts.length - 1 && !info.isDirectory()) throw Error(`Build qualification path parent is not a directory: ${path}`);
    if (i === parts.length - 1 && !info.isFile()) throw Error(`Build qualification path is not a regular file: ${path}`);
  }
  return current;
}

async function hashFile(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw Error(`Build qualification refuses a non-regular file: ${path}`);
  if (before.size > maxBytes) throw Error(`Build qualification file exceeds its per-file bound: ${path}`);
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Error(`Build qualification file grew beyond its per-file bound: ${path}`);
    digest.update(chunk);
  }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || bytes !== before.size)
    throw Error(`Build qualification file changed during capture: ${path}`);
  return { bytes, sha256: digest.digest('hex') };
}

async function capturePathInventory(root, filePaths, { maxFiles, maxFileBytes, maxTotalBytes, label }) {
  if (filePaths.length > maxFiles) throw Error(`${label} inventory exceeds its file-count bound.`);
  let totalBytes = 0;
  const files = [];
  for (const path of filePaths) {
    const normalized = normalizePath(path);
    const full = await physicalEntry(root, normalized);
    const identity = await hashFile(full, maxFileBytes);
    totalBytes += identity.bytes;
    if (totalBytes > maxTotalBytes) throw Error(`${label} inventory exceeds its total-byte bound.`);
    files.push({ path: normalized, bytes: identity.bytes, sha256: identity.sha256 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Existing v1 release-inventory capture remains byte-for-byte compatible. */
export async function captureInventory(root = ROOT) {
  root = resolve(root);
  const files = [];
  for (const path of await paths(root)) {
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const generated = [];
  for (const product of PRODUCTS) {
    const path = `.artifacts/${product}/release.json`;
    generated.push({ path, sha256: hash(await readFile(join(root, path))) });
  }
  const companion = [];
  for (const path of ['.local/veyviz-ai/profile.json', '.local/veyviz-ai/inventory.json']) companion.push({ path, sha256: hash(await readFile(join(root, path))) });
  return { schema: 'veyviz.release-inputs.v1', frameworkCommit: '3b666e9beedb2e5b336f4228091033b1377fae4d', files, generated, companion, digest: hash(JSON.stringify({ files, generated, companion })) };
}

export async function verifyInventory(file, root = ROOT) {
  const expected = JSON.parse(await readFile(file, 'utf8'));
  if (expected.schema !== 'veyviz.release-inputs.v1') throw Error('Unsupported release inventory.');
  const actual = await captureInventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Release inputs changed since capture. Inspect and qualify a new candidate.');
  return { status: 'MATCHED', digest: actual.digest, sourceFiles: actual.files.length };
}

export async function captureAuthoredBuildInputs(root = ROOT) {
  root = await assertPhysicalRoot(root);
  const files = await capturePathInventory(root, await paths(root, 'authored-build'), {
    maxFiles: MAX_INPUT_FILES, maxFileBytes: MAX_SOURCE_FILE_BYTES,
    maxTotalBytes: MAX_SOURCE_TOTAL_BYTES, label: 'Authored source'
  });
  const base = { schema: INPUT_SCHEMA, files };
  if (Buffer.byteLength(canonical(base)) > MAX_RECEIPT_BYTES) throw Error('Authored source inventory exceeds its serialized bound.');
  return { ...base, digest: hash(canonical(base)) };
}

async function packagePaths(root, packagePath, maxFiles) {
  const result = [];
  async function walk(relativePath) {
    const full = join(root, relativePath);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw Error(`Toolchain inventory refuses links: ${relativePath}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(full)).sort()) await walk(`${relativePath}/${entry}`);
    } else if (info.isFile()) {
      result.push(normalizePath(relativePath));
      if (result.length > maxFiles) throw Error(`Toolchain inventory exceeds its ${maxFiles}-file package bound: ${packagePath}`);
    }
    else throw Error(`Toolchain inventory refuses an unsupported entry: ${relativePath}`);
  }
  await walk(packagePath);
  result.sort();
  return result;
}

async function captureToolPackage(root, name, declaredVersion, lockedVersion, { maxFiles = MAX_TOOL_FILES, maxBytes = MAX_TOOL_TOTAL_BYTES } = {}) {
  const packagePath = `node_modules/${name}`;
  const manifest = await readPhysicalJson(root, `${packagePath}/package.json`, MAX_PACKAGE_METADATA_BYTES);
  if (manifest.name !== name || typeof manifest.version !== 'string' || manifest.version !== declaredVersion || manifest.version !== lockedVersion)
    throw Error(`Installed ${name} version does not match its declared package and lockfile identity.`);
  const filePaths = await packagePaths(root, packagePath, maxFiles);
  const files = await capturePathInventory(root, filePaths, {
    maxFiles, maxFileBytes: MAX_TOOL_FILE_BYTES, maxTotalBytes: maxBytes, label: `${name} toolchain`
  });
  const base = { name, version: manifest.version, files };
  return { ...base, digest: hash(canonical(base)) };
}

export async function captureBuildToolchain(root = ROOT) {
  root = await assertPhysicalRoot(root);
  const packageJson = await readPhysicalJson(root, 'package.json', MAX_PACKAGE_METADATA_BYTES);
  const lock = await readPhysicalJson(root, 'package-lock.json', MAX_RECEIPT_BYTES);
  const declarations = packageJson.devDependencies ?? {};
  const lockPackages = lock.packages ?? {};
  const toolPackages = [];
  for (const name of ['typescript', 'esbuild']) {
    const declared = declarations[name];
    const locked = lockPackages[`node_modules/${name}`]?.version;
    if (typeof declared !== 'string' || typeof locked !== 'string' || declared !== locked)
      throw Error(`Build tool ${name} is not pinned consistently in package.json and package-lock.json.`);
    toolPackages.push(await captureToolPackage(root, name, declared, locked));
  }
  const platformName = `@esbuild/${process.platform}-${process.arch}`;
  const esbuildManifest = JSON.parse(await readFile(await physicalEntry(root, 'node_modules/esbuild/package.json'), 'utf8'));
  const platformDeclared = esbuildManifest.optionalDependencies?.[platformName];
  const platformLocked = lockPackages[`node_modules/${platformName}`]?.version;
  if (typeof platformDeclared !== 'string' || typeof platformLocked !== 'string' || platformDeclared !== platformLocked)
    throw Error(`Installed esbuild does not have its pinned platform binary package: ${platformName}.`);
  toolPackages.push(await captureToolPackage(root, platformName, platformDeclared, platformLocked));

  const toolFileCount = toolPackages.reduce((sum, entry) => sum + entry.files.length, 0);
  const toolBytes = toolPackages.reduce((sum, entry) => sum + entry.files.reduce((fileSum, file) => fileSum + file.bytes, 0), 0);
  if (toolFileCount > MAX_TOOLCHAIN_FILES || toolBytes > MAX_TOOLCHAIN_TOTAL_BYTES)
    throw Error('Installed build toolchain exceeds its combined file-count or byte bound.');

  const nodePath = resolve(process.execPath);
  const nodeInfo = await lstat(nodePath);
  if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink() || nodeInfo.size > MAX_NODE_BYTES)
    throw Error('The executing Node binary is not a bounded physical regular file.');
  const node = { path: nodePath, ...await hashFile(nodePath, MAX_NODE_BYTES), version: process.version, platform: process.platform, arch: process.arch, abi: process.versions.modules };
  const base = { schema: TOOLCHAIN_SCHEMA, node, packages: toolPackages };
  if (Buffer.byteLength(canonical(base)) > MAX_RECEIPT_BYTES) throw Error('Build toolchain inventory exceeds its serialized bound.');
  return { ...base, digest: hash(canonical(base)) };
}

export async function captureBuildOutputs(root = ROOT) {
  root = await assertPhysicalRoot(root);
  const { assertExpectedFactoryInventory, expectedFactoryInventory, verifyReleaseArtifacts } = await import('@quadbridge/composition/integrity');
  const products = [];
  for (const product of PRODUCTS) {
    const plan = await readPhysicalJson(root, `.artifacts/${product}/plan.json`, MAX_RECEIPT_BYTES);
    const version = plan?.product?.version;
    if (typeof version !== 'string') throw Error(`Built release plan is missing its version: ${product}`);
    const verified = verifyReleaseArtifacts(root, product, version);
    const expected = expectedFactoryInventory(root, verified.plan);
    assertExpectedFactoryInventory(root, expected);
    products.push({
      product,
      version,
      releaseDigest: verified.releaseDigest,
      expectedFactoryDigest: hash(canonical(expected))
    });
  }
  const tsconfigPath = await physicalEntry(root, 'tsconfig.json');
  const tsconfigOutput = await hashFile(tsconfigPath, MAX_SOURCE_FILE_BYTES);
  const base = { schema: OUTPUT_SCHEMA, products, tsconfigOutput };
  return { ...base, digest: hash(canonical(base)) };
}

function statePaths(root) {
  return {
    current: join(root, ...`${QUALIFICATION_ROOT}/current.json`.split('/'))
  };
}

async function readPhysicalJson(root, rel, maxBytes = MAX_RECEIPT_BYTES) {
  const full = await physicalEntry(root, rel);
  const stat = await lstat(full);
  if (stat.size > maxBytes) throw Error(`Build qualification record exceeds its byte bound: ${rel}`);
  const bytes = await readFile(full);
  const after = await lstat(full);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || bytes.length !== stat.size)
    throw Error(`Build qualification record changed during read: ${rel}`);
  return JSON.parse(bytes.toString('utf8'));
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical(keys.slice().sort());
}

async function verifyAttemptEvidence(root, receipt) {
  const { attempt, attemptRecord } = receipt;
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) throw Error('Build qualification attempt is malformed.');
  const id = attempt.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Error('Build qualification attempt identity is malformed.');
  const base = `${QUALIFICATION_ROOT}/attempts/${id}`;
  if (!hasExactKeys(attempt, ['schema', 'id', 'startedAt', 'finishedAt', 'stage', 'command', 'original', 'stdout', 'stderr', 'captureError', 'qualificationError', 'retiredReceipt']) ||
      attempt.schema !== 'veyviz.build-attempt.v1')
    throw Error('Build qualification attempt contains unknown or missing fields.');
  if (!hasExactKeys(attempt.command, ['exe', 'argv', 'cwd', 'shell', 'windowsHide']) || !Array.isArray(attempt.command.argv) ||
      attempt.command.exe !== resolve(process.execPath) || attempt.command.argv.length !== 1 ||
      attempt.command.argv[0] !== join(root, 'tools', 'build.mjs') || attempt.command.cwd !== root ||
      attempt.command.shell !== false || attempt.command.windowsHide !== true)
    throw Error('Build qualification attempt does not identify the fixed builder command.');
  if (!hasExactKeys(attempt.original, ['closeObserved', 'code', 'signal', 'spawnError']) ||
      attempt.original.closeObserved !== true || attempt.original.code !== 0 || attempt.original.signal !== null || attempt.original.spawnError !== null ||
      attempt.stage !== 'verified' || attempt.qualificationError !== null || attempt.captureError !== null ||
      (attempt.retiredReceipt !== null && (typeof attempt.retiredReceipt !== 'string' || !new RegExp(`^${QUALIFICATION_ROOT}/history/current-[0-9]+-${id}\\.json$`).test(attempt.retiredReceipt))))
    throw Error('Build qualification has no successful original builder close.');
  for (const stream of ['stdout', 'stderr']) {
    const entry = attempt[stream];
    if (!hasExactKeys(entry, ['path', 'bytes', 'sha256', 'receivedBytes', 'truncatedBytes', 'captureError']) ||
        entry.path !== `${base}/${stream}.bin` || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_OUTPUT_BYTES ||
        entry.receivedBytes !== entry.bytes || entry.truncatedBytes !== 0 || entry.captureError !== null || !/^[0-9a-f]{64}$/.test(entry.sha256))
      throw Error('Build qualification raw output reference is malformed.');
    const full = await physicalEntry(root, entry.path);
    const identity = await hashFile(full, 128 * 1024 * 1024);
    if (identity.bytes !== entry.bytes || identity.sha256 !== entry.sha256) throw Error(`Build qualification raw ${stream} bytes changed.`);
  }
  if (!hasExactKeys(attemptRecord, ['path', 'bytes', 'sha256']) || attemptRecord.path !== `${base}/attempt.json` ||
      !Number.isSafeInteger(attemptRecord.bytes) || attemptRecord.bytes < 0 || attemptRecord.bytes > MAX_RECEIPT_BYTES || !/^[0-9a-f]{64}$/.test(attemptRecord.sha256))
    throw Error('Build qualification attempt record reference is malformed.');
  const fullRecord = await physicalEntry(root, attemptRecord.path);
  const recordInfo = await lstat(fullRecord);
  if (recordInfo.size > MAX_RECEIPT_BYTES) throw Error('Build qualification attempt record exceeds its byte bound.');
  const recordBytes = await readFile(fullRecord);
  const recordAfter = await lstat(fullRecord);
  if (!recordAfter.isFile() || recordAfter.isSymbolicLink() || recordAfter.size !== recordInfo.size || recordBytes.length !== attemptRecord.bytes || hash(recordBytes) !== attemptRecord.sha256 || canonical(JSON.parse(recordBytes.toString('utf8'))) !== canonical(attempt))
    throw Error('Build qualification attempt provenance does not match its retained record.');
  const startedAt = Date.parse(attempt.startedAt), finishedAt = Date.parse(attempt.finishedAt);
  if (typeof attempt.startedAt !== 'string' || !Number.isFinite(startedAt) || typeof attempt.finishedAt !== 'string' || !Number.isFinite(finishedAt) || finishedAt < startedAt)
    throw Error('Build qualification attempt timestamps are malformed.');
}

/**
 * Verify the current locally reported successful build, including exact current inputs,
 * actual installed tools, both generated exports and original close/output evidence.
 */
export async function verifyBuildQualification(root = ROOT) {
  root = await assertPhysicalRoot(root);
  const { current } = statePaths(root);
  const currentRel = normalizePath(relative(root, current));
  const receipt = await readPhysicalJson(root, currentRel);
  if (!hasExactKeys(receipt, ['schema', 'stable', 'stableDigest', 'attempt', 'attemptRecord']) || receipt.schema !== QUALIFICATION_SCHEMA)
    throw Error('Missing, unsupported or malformed current Veyviz build qualification. Run npm run build explicitly.');
  if (!hasExactKeys(receipt.stable, ['schema', 'authoredInputs', 'recipeFiles', 'toolchain', 'outputs', 'buildOutcome']) ||
      receipt.stable.schema !== QUALIFICATION_SCHEMA || !/^[0-9a-f]{64}$/.test(receipt.stableDigest) ||
      hash(canonical(receipt.stable)) !== receipt.stableDigest ||
      canonical(receipt.stable.buildOutcome) !== canonical({ exitCode: 0, signal: null, spawnError: null }))
    throw Error('Current Veyviz build qualification identity or build outcome is invalid.');
  await verifyAttemptEvidence(root, receipt);
  const authoredInputs = await captureAuthoredBuildInputs(root);
  const toolchain = await captureBuildToolchain(root);
  const outputs = await captureBuildOutputs(root);
  const authoredEntries = new Map(authoredInputs.files.map(entry => [entry.path, entry]));
  const actualStable = {
    schema: QUALIFICATION_SCHEMA,
    authoredInputs,
    recipeFiles: ['tools/veyviz-build.mjs', 'tools/veyviz-inventory.mjs', 'tools/build.mjs'].map(path => {
      const entry = authoredEntries.get(path);
      if (!entry) throw Error(`Fixed build recipe file is missing from authored inputs: ${path}`);
      return { path, bytes: entry.bytes, sha256: entry.sha256 };
    }),
    toolchain,
    outputs,
    buildOutcome: { exitCode: 0, signal: null, spawnError: null }
  };
  if (canonical(actualStable) !== canonical(receipt.stable))
    throw Error('Veyviz source, toolchain, release, export or generated tsconfig changed since the qualified build. Run npm run build explicitly.');
  return { status: 'MATCHED', digest: receipt.stableDigest, outputs: outputs.products };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, filename] = process.argv.slice(2);
  if (!['capture', 'verify'].includes(command) || !filename) throw Error('Use: node tools/veyviz-inventory.mjs capture|verify <repository-relative-file>');
  const full = resolve(ROOT, filename), rel = relative(ROOT, full);
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw Error('Inventory file must stay within this repository.');
  if (command === 'capture') {
    const value = await captureInventory();
    await writeFile(full, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: 'CAPTURED', digest: value.digest, sourceFiles: value.files.length }));
  } else console.log(JSON.stringify(await verifyInventory(full)));
}
