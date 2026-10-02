import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, PLATFORM_ABI } from '@quadbridge/contracts';
import { deriveRuntimeWorkspaceClosure } from './workspace-closure.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validatePortablePath(path: string) {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))
        throw new Error('Unsafe artifact path');
}

function safeFile(root: string, path: string): string {
    validatePortablePath(path);
    if (lstatSync(root).isSymbolicLink()) throw new Error('Artifact root cannot be a symbolic link');
    const base = realpathSync(root), full = resolve(base, ...path.split('/'));
    const rel = relative(base, full);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Unsafe artifact path');
    let current = base;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        current = join(current, part);
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error('Artifact symlinks are not accepted');
        if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Artifact path contains a non-directory component');
    }
    if (!lstatSync(full).isFile()) throw new Error('Artifact path is not a regular file');
    return full;
}

type ArtifactBytesReader = (path: string) => Buffer;
const diskArtifactBytes = (root: string): ArtifactBytesReader => path => readFileSync(safeFile(root,path));

function digestMap(root: string, value: unknown, readBytes: ArtifactBytesReader = diskArtifactBytes(root)): void {
    if (!record(value) || Object.keys(value).length < 1) throw new Error('Artifact digest map is missing');
    for (const [path, expected] of Object.entries(value)) {
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Malformed artifact digest');
        const actual = hash(readBytes(path));
        if (actual !== expected) throw new Error(`Artifact drift: ${path}`);
    }
}

function assertExactMapKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!record(value)) throw new Error(`Malformed ${label} file map`);
    const actual = Object.keys(value).sort(), wanted = [...new Set(expected)].sort();
    const folded = actual.map(path => path.toLowerCase());
    if (new Set(folded).size !== folded.length) throw new Error(`${label} file map has case-folded collisions`);
    for (const path of actual) validatePortablePath(path);
    if (canonical(actual) !== canonical(wanted)) throw new Error(`${label} file map does not match the product closure`);
}

function expectedBackendFiles(root: string, productId: string, plan: Record<string, any>, readBytes: ArtifactBytesReader, inventory?: readonly string[]): string[] {
    const files = [`.artifacts/${productId}/web.json`, `.artifacts/${productId}/backend-catalog.mjs`, `.artifacts/${productId}/solution.mjs`];
    const collect = (directory: string) => {
        if (inventory) {
            const matches=inventory.filter(path=>path.startsWith(`${directory}/`)&&path.endsWith('.js'));
            if (!matches.length) throw new Error('Artifact backend package closure is missing');
            files.push(...matches);
            return;
        }
        const full = safeDirectory(root, directory);
        for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const rel = `${directory}/${entry.name}`, absolute = join(full, entry.name), info = lstatSync(absolute);
            if (info.isSymbolicLink()) throw new Error('Artifact symlinks are not accepted');
            if (info.isDirectory()) collect(rel);
            else if (info.isFile() && entry.name.endsWith('.js')) files.push(rel);
            else if (!info.isFile()) throw new Error('Artifact contains a non-regular file');
        }
    };
    const closure = deriveRuntimeWorkspaceClosure(plan as any, path => JSON.parse(readBytes(path).toString('utf8')));
    for (const item of closure.roots) if (item.path !== 'packages/web-shell') collect(`${item.path}/dist`);
    collect('apps/runtime/dist');
    if (typeof plan.product?.wiring === 'string') files.push(`solutions/${plan.product.wiring}/wiring.mjs`);
    return files;
}

function safeDirectory(root: string, path: string): string {
    validatePortablePath(path);
    if (lstatSync(root).isSymbolicLink()) throw new Error('Artifact root cannot be a symbolic link');
    let current = realpathSync(root);
    for (const part of path.split('/')) {
        current = join(current, part);
        const info = lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Artifact directory is missing or unsafe');
    }
    return current;
}

export interface VerifiedRelease {
    productId: string;
    version: string;
    planDigest: string;
    releaseDigest: string;
    plan: Record<string, any>;
    release: Record<string, any>;
}

/** Verify a fixed locally assembled release without constructing or starting its runtime. */
function verifyReleaseArtifactsUsing(root: string, productId: string, version: string, readBytes: ArtifactBytesReader, inventory?: readonly string[]): VerifiedRelease {
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(productId) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid expected release identity');
    const releasePath = `.artifacts/${productId}/release.json`;
    const planPath = `.artifacts/${productId}/plan.json`;
    const releaseBytes = readBytes(releasePath);
    const release = JSON.parse(releaseBytes.toString('utf8')) as unknown;
    const plan = JSON.parse(readBytes(planPath).toString('utf8')) as unknown;
    if (!record(release) || !record(plan) || !record(plan.product)) throw new Error('Malformed release metadata');
    if (release.product !== productId || release.version !== version || release.abi !== PLATFORM_ABI || release.status !== 'LOCAL_BUILD_NOT_PRODUCTION_ACCEPTANCE')
        throw new Error('Release metadata identity mismatch');
    if (plan.product.id !== productId || plan.product.version !== version || plan.product.platformAbi !== release.abi)
        throw new Error('Composition plan identity mismatch');
    if (typeof release.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(release.planDigest) || hash(canonical(plan)) !== release.planDigest)
        throw new Error('Composition plan digest mismatch');
    if (!(typeof release.backend === 'object' && release.backend !== null && !Array.isArray(release.backend)) ||
        !(typeof release.web === 'object' && release.web !== null && !Array.isArray(release.web))) throw new Error('Malformed release file maps');
    const backend = release.backend as Record<string, unknown>, web = release.web as Record<string, unknown>;
    assertExactMapKeys(backend, expectedBackendFiles(root, productId, plan,readBytes,inventory), 'Backend');
    const webFile = JSON.parse(readBytes(`${planPath.replace('plan.json', 'web.json')}`).toString('utf8')) as unknown;
    if (!record(webFile) || !record(webFile.files) || Object.values(webFile.files).some(path => typeof path !== 'string')) throw new Error('Malformed web file closure');
    assertExactMapKeys(web, [...Object.values(webFile.files) as string[], `.artifacts/${productId}/composition.js`], 'Web');
    digestMap(root, backend,readBytes);
    digestMap(root, web,readBytes);
    return { productId, version, planDigest: release.planDigest, releaseDigest: hash(releaseBytes), plan, release };
}

export function verifyReleaseArtifacts(root: string, productId: string, version: string): VerifiedRelease {
    return verifyReleaseArtifactsUsing(root,productId,version,diskArtifactBytes(root));
}

export interface SnapshotIdentity {
    buildId: string;
    productId: string;
    version: string;
    inputDigest: string;
    sourceFingerprint: string;
    toolchainDigest: string;
    recipeVersion: string;
    releaseDigest: string;
}
export interface SnapshotManifest extends SnapshotIdentity { schema: 'quadbridge.local-snapshot.v1'; files: Record<string, string>; }

function listFiles(root: string): string[] {
    if (lstatSync(root).isSymbolicLink()) throw new Error('Snapshot root cannot be a symbolic link');
    const base = realpathSync(root), paths: string[] = [];
    const visit = (directory: string, prefix: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(directory, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name;
            validatePortablePath(path);
            const info = lstatSync(full);
            if (info.isSymbolicLink()) throw new Error('Snapshot symlinks are not accepted');
            if (info.isDirectory()) {
                if (['node_modules', '.git', '.local', '.brain', '.codex'].includes(entry.name.toLowerCase())) throw new Error('Snapshot contains excluded operational state');
                visit(full, path);
            } else if (info.isFile() && path !== 'QUADBRIDGE-SNAPSHOT.json') paths.push(path);
            else if (!info.isFile()) throw new Error('Snapshot contains a non-regular file');
        }
    };
    visit(base, '');
    const folded = paths.map(path => path.toLowerCase());
    if (new Set(folded).size !== folded.length) throw new Error('Snapshot inventory has case-folded path collisions');
    return paths.sort();
}

/** Compute the exact bytes the fixed factory recipe is expected to copy/write. */
export function expectedFactoryInventory(sourceRoot: string, planValue: unknown): Record<string,string> {
    if (!record(planValue) || !record(planValue.product) || !Array.isArray(planValue.modules) || !Array.isArray(planValue.bindings)) throw new Error('Malformed admitted factory plan');
    const plan = planValue as Record<string,any>, product = plan.product;
    if (typeof product.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(product.id) || typeof product.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(product.version)) throw new Error('Malformed admitted factory product');
    const expected: Record<string,string> = {};
    const add = (target: string, bytes: Uint8Array | string) => {
        validatePortablePath(target);
        if (Object.hasOwn(expected,target)) throw new Error('Factory output path collision');
        expected[target] = hash(bytes);
    };
    const copyTree = (sourceRelative: string, targetRelative: string, factoryFilter = false, skip: readonly string[] = []) => {
        validatePortablePath(sourceRelative); validatePortablePath(targetRelative);
        const source = safeDirectory(sourceRoot,sourceRelative);
        const visit = (directory: string, sourcePrefix: string, targetPrefix: string) => {
            for (const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
                const sourcePath = `${sourcePrefix}/${entry.name}`, targetPath = `${targetPrefix}/${entry.name}`;
                validatePortablePath(sourcePath); validatePortablePath(targetPath);
                const full = join(directory,entry.name), info = lstatSync(full);
                if (info.isSymbolicLink()) throw new Error('Factory source contains a symbolic link');
                if (skip.includes(sourcePath)) continue;
                if (factoryFilter && (sourcePath.includes('node_modules') || sourcePath.includes('.tsbuildinfo'))) continue;
                if (info.isDirectory()) visit(full,sourcePath,targetPath);
                else if (info.isFile()) add(targetPath,readFileSync(full));
                else throw new Error('Factory source contains a non-regular file');
            }
        };
        visit(source,sourceRelative,targetRelative);
    };
    const workspace = deriveRuntimeWorkspaceClosure(plan as any, path => JSON.parse(readFileSync(safeFile(sourceRoot,path),'utf8')));
    for (const item of workspace.roots) copyTree(item.path,item.path,true);
    copyTree('apps/runtime','apps/runtime',true,['apps/runtime/package.json']);
    const runtimePackage = JSON.parse(readFileSync(safeFile(sourceRoot,'apps/runtime/package.json'),'utf8')) as Record<string,any>;
    const dependencies = workspace.dependencies;
    runtimePackage.dependencies = dependencies;
    add('apps/runtime/package.json',JSON.stringify(runtimePackage,null,2)+'\n');
    copyTree(`products/${product.id}`,`products/${product.id}`);
    copyTree(`.artifacts/${product.id}`,`.artifacts/${product.id}`);
    if (typeof product.wiring === 'string') copyTree(`solutions/${product.wiring}`,`solutions/${product.wiring}`);
    copyTree('profiles','profiles');
    for (const file of ['tools/link-workspaces.mjs','tools/workspace-identities.mjs','tools/demo.mjs','tools/local-profile.mjs']) add(file,readFileSync(safeFile(sourceRoot,file)));
    const selectedModules = plan.modules.map((module: Record<string,unknown>) => {
        const id = module.id;
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error('Malformed admitted module closure');
        const manifest = JSON.parse(readFileSync(safeFile(sourceRoot,`modules/${id}/module.json`),'utf8')) as Record<string,any>;
        if (manifest.id !== id || canonical(manifest) !== canonical(module)) throw new Error('Admitted module manifest differs from reviewed source');
        return { id, manifest };
    });
    // Match the fixed factory's product-scoped generated catalogue byte for byte.
    add(`generated/catalog.mjs`,`export const catalog=[${selectedModules.map((module: { id: string; manifest: Record<string,any> })=>`{manifest:${JSON.stringify(module.manifest)},load:()=>import('../modules/${module.id}/dist/index.js')}`).join(',')}];\n`);
    const solutionId = product.wiring;
    if (solutionId !== undefined && (typeof solutionId !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(solutionId))) throw new Error('Malformed admitted solution reference');
    add(`generated/solution-catalog.mjs`,`export const solutions={${solutionId ? `${JSON.stringify(solutionId)}:()=>import('../solutions/${solutionId}/wiring.mjs')` : ''}};\n`);
    add('package.json',JSON.stringify({name:`${product.id}-assembled-runtime`,private:true,type:'module',version:product.version,engines:{node:'>=22.16.0'},scripts:{setup:'node tools/link-workspaces.mjs',start:`node tools/demo.mjs --product ${product.id} --port 4350`}},null,2)+'\n');
    add('README.md',`# ${product.title} — assembled local product\n\nNode 22.16+; tested on 22.16.0.\n\nRun \`npm run setup\`, then \`npm start\`.\n\nCompiled runtime and selected modules are included. Startup requires no dependency download. Local accounts/configuration are generated. This is a loopback developer profile, not production. Remote bindings need their configured destination running.\n`);
    const folded = Object.keys(expected).map(path=>path.toLowerCase());
    if (new Set(folded).size !== folded.length) throw new Error('Expected factory inventory has case-folded collisions');
    return Object.fromEntries(Object.entries(expected).sort(([a],[b])=>a.localeCompare(b)));
}

export function assertExpectedFactoryInventory(snapshotRoot: string, expected: Record<string,string>): void {
    const actualPaths = listFiles(snapshotRoot);
    const expectedPaths = Object.keys(expected).sort();
    if (canonical(actualPaths) !== canonical(expectedPaths)) throw new Error('Factory snapshot inventory differs from the reviewed private recipe inputs');
    for (const path of expectedPaths) if (hash(readFileSync(safeFile(snapshotRoot,path))) !== expected[path]) throw new Error(`Factory output differs from its trusted input: ${path}`);
}

/** Create a complete local-export manifest, including package/profile/launch metadata omitted by release.json. */
export function createSnapshotManifest(root: string, identity: SnapshotIdentity): SnapshotManifest {
    for (const key of ['buildId'] as const) if (!/^[0-9a-f-]{36}$/i.test(identity[key])) throw new Error('Invalid snapshot build identity');
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(identity.productId) || !/^\d+\.\d+\.\d+$/.test(identity.version)) throw new Error('Invalid snapshot product identity');
    for (const key of ['inputDigest', 'sourceFingerprint', 'toolchainDigest', 'releaseDigest'] as const) if (!/^[a-f0-9]{64}$/.test(identity[key])) throw new Error(`Invalid snapshot ${key}`);
    if (!/^[a-zA-Z0-9._-]{1,48}$/.test(identity.recipeVersion)) throw new Error('Invalid snapshot recipe');
    const files: Record<string, string> = {};
    for (const path of listFiles(root)) files[path] = hash(readFileSync(safeFile(root, path)));
    return { schema: 'quadbridge.local-snapshot.v1', ...identity, files };
}

function verifySnapshotManifestUsing(root: string, manifest: unknown, expected: Partial<SnapshotIdentity> | undefined,
    readBytes: ArtifactBytesReader, actualPaths: string[]) {
    if (!record(manifest) || manifest.schema !== 'quadbridge.local-snapshot.v1' || !record(manifest.files)) throw new Error('Malformed local snapshot manifest');
    for (const key of ['buildId','productId','version','inputDigest','sourceFingerprint','toolchainDigest','recipeVersion','releaseDigest'] as const)
        if (expected?.[key] !== undefined && manifest[key] !== expected[key]) throw new Error(`Snapshot ${key} mismatch`);
    const id = manifest as unknown as SnapshotManifest;
    const verified = verifyReleaseArtifactsUsing(root, id.productId, id.version,readBytes,actualPaths);
    if (verified.releaseDigest !== id.releaseDigest) throw new Error('Snapshot release digest mismatch');
    const manifestPaths = Object.keys(id.files).sort();
    if (canonical(manifestPaths) !== canonical(actualPaths)) throw new Error('Snapshot file inventory mismatch');
    digestMap(root, id.files,readBytes);
    const packageJson = JSON.parse(readBytes('package.json').toString('utf8')) as Record<string, any>;
    const plan = verified.plan as Record<string, any>;
    const workspace = deriveRuntimeWorkspaceClosure(plan as any, path => JSON.parse(readBytes(path).toString('utf8')));
    const dependencies = workspace.dependencies;
    if (packageJson.name !== `${id.productId}-assembled-runtime` || packageJson.version !== id.version || packageJson.engines?.node !== '>=22.16.0' ||
        packageJson.scripts?.start !== `node tools/demo.mjs --product ${id.productId} --port 4350` || packageJson.scripts?.setup !== 'node tools/link-workspaces.mjs' ||
        Object.hasOwn(packageJson,'dependencies')) throw new Error('Snapshot launcher metadata mismatch');
    const runtimePackage = JSON.parse(readBytes('apps/runtime/package.json').toString('utf8')) as Record<string,any>;
    if (canonical(runtimePackage.dependencies) !== canonical(dependencies)) throw new Error('Snapshot runtime dependency metadata mismatch');
    if (!['profiles/local-developer.json','tools/demo.mjs','tools/link-workspaces.mjs','tools/local-profile.mjs','apps/runtime/dist/main.js','README.md'].every(path => Object.hasOwn(id.files, path)))
        throw new Error('Snapshot is missing required local runtime metadata');
    return { snapshotDigest: hash(canonical(id)), release: verified };
}

export function verifySnapshotManifest(root: string, manifest: unknown, expected?: Partial<SnapshotIdentity>) {
    return verifySnapshotManifestUsing(root,manifest,expected,diskArtifactBytes(root),listFiles(root));
}

/** Verify against a caller's bounded inventory and captured bytes without a second file-content read. */
export function verifySnapshotManifestFromBytes(root: string, manifest: unknown, expected: Partial<SnapshotIdentity> | undefined,
    files: ReadonlyMap<string,Uint8Array>, actualPaths: string[]) {
    const readBytes: ArtifactBytesReader = path => {
        safeFile(root,path);
        const bytes=files.get(path);
        if (!bytes) throw new Error(`Captured snapshot file is missing: ${path}`);
        return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    };
    return verifySnapshotManifestUsing(root,manifest,expected,readBytes,actualPaths);
}
