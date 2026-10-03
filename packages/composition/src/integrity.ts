import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, PLATFORM_ABI } from '@quadbridge/contracts';
import { deriveRuntimeWorkspaceClosure } from './workspace-closure.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const RUNTIME_INITIALIZER_CAPABILITY_SCHEMA = 'quadbridge.runtime-initializer.v1' as const;
export const RUNTIME_INITIALIZER_ENTRY_PATH = 'apps/runtime/dist/index.js' as const;
export const RUNTIME_INITIALIZER_EXPORT_NAME = 'initializeRuntime' as const;
export interface RuntimeInitializerCapability {
    schema: typeof RUNTIME_INITIALIZER_CAPABILITY_SCHEMA;
    entryPath: typeof RUNTIME_INITIALIZER_ENTRY_PATH;
    exportName: typeof RUNTIME_INITIALIZER_EXPORT_NAME;
    sha256: string;
}

/** Validates the optional upgrade capability against its fixed compiled entry bytes; absence preserves legacy verification. */
export function verifyRuntimeInitializerCapability(release: unknown, entryBytes: Uint8Array): RuntimeInitializerCapability | undefined {
    if (!record(release)) throw new Error('Malformed release metadata');
    if (!Object.hasOwn(release,'runtimeInitializerCapability')) return undefined;
    const capability = release.runtimeInitializerCapability;
    if (!record(capability) || Object.keys(capability).sort().join('\0') !== ['entryPath','exportName','schema','sha256'].sort().join('\0') ||
        capability.schema !== RUNTIME_INITIALIZER_CAPABILITY_SCHEMA || capability.entryPath !== RUNTIME_INITIALIZER_ENTRY_PATH ||
        capability.exportName !== RUNTIME_INITIALIZER_EXPORT_NAME || typeof capability.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(capability.sha256) ||
        !record(release.backend) || release.backend[RUNTIME_INITIALIZER_ENTRY_PATH] !== capability.sha256 || hash(entryBytes) !== capability.sha256)
        throw new Error('Runtime initializer capability does not match its fixed verified release entry');
    return { schema: RUNTIME_INITIALIZER_CAPABILITY_SCHEMA, entryPath: RUNTIME_INITIALIZER_ENTRY_PATH,
        exportName: RUNTIME_INITIALIZER_EXPORT_NAME, sha256: capability.sha256 };
}
const managedClientTemplates: readonly [string,string,string][] = [
    ['p','templates/mobile/package.json','package.json'],['l','templates/mobile/package-lock.json','package-lock.json'],
    ['r','templates/mobile/README.md','README.md'],['n','templates/mobile/native-session/package.json','native-session/package.json'],
    ['g','templates/mobile/native-session/android/build.gradle','native-session/android/build.gradle'],
    ['m','templates/mobile/native-session/android/src/main/AndroidManifest.xml','native-session/android/src/main/AndroidManifest.xml'],
    ['j','templates/mobile/native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java','native-session/android/src/main/java/com/quadbridge/nativesession/NativeSessionPlugin.java'],
    ['w','templates/mobile/native-session/Package.swift','native-session/Package.swift'],
    ['s','templates/mobile/native-session/ios/Sources/NativeSessionPlugin/NativeSessionPlugin.swift','native-session/ios/Sources/NativeSessionPlugin/NativeSessionPlugin.swift'],
    ['d','templates/mobile/android-debug/AndroidManifest.xml','android-debug/AndroidManifest.xml'],
    ['c','templates/mobile/android-debug/network_security_config.xml','android-debug/network_security_config.xml'],
    ['q','templates/mobile/qualification/android-test.gradle','qualification/android-test.gradle'],
    ['k','templates/mobile/qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java','qualification/src/androidTest/java/com/quadbridge/qualification/NativeCoreJourneyTest.java'],
    ['x','tools/mobile/prepare-native.mjs','tools/prepare-native.mjs']
];
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

function physicalFilesBelow(root: string, prefix: string): string[] {
    const directory=safeDirectory(root,prefix),files:string[]=[];
    const walk=(current:string,relativePath:string)=>{
        for(const entry of readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
            const full=join(current,entry.name),path=`${relativePath}/${entry.name}`,info=lstatSync(full);
            if(info.isSymbolicLink())throw new Error('Managed client seed contains a symbolic link');
            if(info.isDirectory())walk(full,path);
            else if(info.isFile())files.push(path);
            else throw new Error('Managed client seed contains a non-regular file');
        }
    };
    walk(directory,prefix);
    return files.sort();
}

function verifyManagedClientSeed(root:string,productId:string,version:string,planDigest:string,plan:Record<string,any>,web:Record<string,any>,
    release:Record<string,any>,readBytes:ArtifactBytesReader,inventory?:readonly string[]):void{
    const ref=release.mobileSeed;
    if(!record(ref)||ref.schema!=='quadbridge.managed-mobile-seed-reference.v1'||ref.path!==`.artifacts/${productId}/n/seed.json`||
        typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)||!record(ref.files))throw new Error('Malformed managed mobile seed reference');
    const bytes=readBytes(ref.path);
    if(hash(bytes)!==ref.sha256)throw new Error('Managed mobile seed manifest digest mismatch');
    let seed:unknown;try{seed=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Malformed managed mobile seed manifest');}
    if(!record(seed)||seed.schema!=='quadbridge.managed-mobile-seed.v1'||seed.productId!==productId||seed.productVersion!==version||
        seed.planDigest!==planDigest||seed.title!==plan.product.title||!Array.isArray(seed.modules)||!record(seed.files)||!Array.isArray(seed.uiBindings)||
        !Array.isArray(seed.styles)||typeof seed.entry!=='string')throw new Error('Managed mobile seed identity mismatch');
    const modules=plan.modules.map((item:any)=>({id:item.id,version:item.version}));
    if(canonical(seed.modules)!==canonical(modules)||canonical(seed.uiBindings)!==canonical(web.mobile?.uiBindings??[])||
        canonical(seed.styles.map((path:string)=>`/${path}`))!==canonical(web.mobile?.styles??[])||
        !/^\/assets\/mobile-preview\/assets\/app-[A-Za-z0-9]{8}\.js$/.test(seed.entry)||
        seed.styles.some((path:unknown)=>typeof path!=='string'||!/^assets\/mobile-preview\/assets\/raw\/[a-f0-9]{16}\.css$/.test(path)))
        throw new Error('Managed mobile seed client identity differs from the selected plan');
    const entries=Object.entries(seed.files as Record<string,unknown>);
    if(entries.length<managedClientTemplates.length+2||entries.length>1024)throw new Error('Managed mobile seed inventory exceeds its fixed bounds');
    const templates:Array<[string,string,string]>=[];
    for(const [target,entry] of entries){
        if(record(entry)&&entry.template!==undefined){
            if(typeof entry.blob!=='string'||typeof entry.template!=='string')throw new Error('Malformed managed mobile template entry');
            templates.push([entry.blob,entry.template,target]);
        }
    }
    templates.sort((a,b)=>a[2].localeCompare(b[2]));
    const wanted:Array<[string,string,string]>=managedClientTemplates.map(([blob,source,target])=>[`t/${blob}`,source,target]);
    wanted.sort((a,b)=>a[2].localeCompare(b[2]));
    if(canonical(templates)!==canonical(wanted))throw new Error('Managed mobile native template closure differs from the reviewed fixed inputs');
    if(!record(seed.templateInputs)||!record(seed.assemblyInputs)||!Array.isArray(seed.bundleInputs)||!record(seed.toolchain)||
        typeof seed.toolchain.esbuild!=='string'||!/^\d+\.\d+\.\d+$/.test(seed.toolchain.esbuild))
        throw new Error('Managed mobile captured preparation metadata is malformed');
    const expectedTemplateInputs=[...new Set(managedClientTemplates.map(([,source])=>source).filter(source=>source.startsWith('templates/mobile/')))].sort();
    if(canonical(Object.keys(seed.templateInputs).sort())!==canonical(expectedTemplateInputs)||
        canonical(Object.keys(seed.assemblyInputs).sort())!==canonical(['tools/mobile/assemble.mjs','tools/mobile/prepare-native.mjs']))
        throw new Error('Managed mobile captured preparation identity maps differ from fixed inputs');
    for(const [blob,source,target] of managedClientTemplates){
        const item=seed.files[target] as Record<string,unknown>;
        const declared=source.startsWith('templates/mobile/')?(seed.templateInputs as Record<string,unknown>)[source]:(seed.assemblyInputs as Record<string,unknown>)[source];
        if(declared!==item.sha256||canonical(Object.keys(item).sort())!==canonical(['blob','sha256','sizeBytes','template']))
            throw new Error('Managed mobile template bytes differ from their captured source identity');
        if(item.blob!==`t/${blob}`)throw new Error('Managed mobile template blob identity changed');
    }
    const templateTargets=new Set(managedClientTemplates.map(([, ,target])=>target));
    const expectedFiles:Record<string,string>={};let total=0;
    for(const [target,raw] of entries){
        validatePortablePath(target);
        if(!templateTargets.has(target)&&target!=='www/index.html'&&!target.startsWith('www/assets/mobile-preview/'))
            throw new Error('Managed mobile seed contains an unreviewed output path');
        if(!record(raw)||typeof raw.blob!=='string'||!/^(?:t\/[a-z]|f\/[0-9]{3})$/.test(raw.blob)||typeof raw.sha256!=='string'||
            !/^[a-f0-9]{64}$/.test(raw.sha256)||!Number.isSafeInteger(raw.sizeBytes)||Number(raw.sizeBytes)<0||Number(raw.sizeBytes)>8*1024*1024)
            throw new Error('Malformed managed mobile seed file entry');
        total+=Number(raw.sizeBytes);if(total>64*1024*1024)throw new Error('Managed mobile seed exceeds its fixed byte bound');
        const path=`.artifacts/${productId}/n/${raw.blob}`;
        if(Object.hasOwn(expectedFiles,path))throw new Error('Managed mobile seed has duplicate payload paths');
        expectedFiles[path]=raw.sha256;
        const payload=readBytes(path);
        if(payload.length!==raw.sizeBytes||hash(payload)!==raw.sha256)throw new Error(`Managed mobile seed payload changed: ${target}`);
    }
    const seedFiles=seed.files as Record<string,unknown>;
    if(!Object.hasOwn(seedFiles,'www/index.html')||!Object.hasOwn(seedFiles,`www${seed.entry}`)||
        seed.styles.some((style:unknown)=>typeof style!=='string'||!Object.hasOwn(seedFiles,`www/${style}`)))throw new Error('Managed mobile seed entry or styles are missing');
    if(canonical(ref.files)!==canonical(expectedFiles))throw new Error('Managed mobile seed digest map differs from its fixed manifest');
    const actual=inventory?inventory.filter(path=>path.startsWith(`.artifacts/${productId}/n/`)):physicalFilesBelow(root,`.artifacts/${productId}/n`);
    const expected=[ref.path,...Object.keys(expectedFiles)].sort();
    if(canonical(actual.sort())!==canonical(expected))throw new Error('Managed mobile seed subtree contains missing or unreviewed files');
}

export interface VerifiedRelease {
    productId: string;
    version: string;
    planDigest: string;
    releaseDigest: string;
    plan: Record<string, any>;
    release: Record<string, any>;
    runtimeInitializerCapability?: RuntimeInitializerCapability;
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
    const runtimeInitializerCapability=verifyRuntimeInitializerCapability(release,readBytes(RUNTIME_INITIALIZER_ENTRY_PATH));
    if(Object.hasOwn(release,'mobileSeed'))verifyManagedClientSeed(root,productId,version,release.planDigest,plan,webFile as Record<string,any>,release,readBytes,inventory);
    return { productId, version, planDigest: release.planDigest, releaseDigest: hash(releaseBytes), plan, release,
        ...(runtimeInitializerCapability?{runtimeInitializerCapability}:{}) };
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
