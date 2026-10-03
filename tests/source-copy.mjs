import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { shouldIncludeMaintainedPath } from '../tools/verify-core.mjs';

const dependencies = [
    ['typescript', 'typescript'],
    ['esbuild', 'esbuild'],
    [`@esbuild/${process.platform}-${process.arch}`, `@esbuild/${process.platform}-${process.arch}`],
    ['@types/node', '@types/node'],
    ['undici-types', 'undici-types']
];

const mobileVendorPackages = [
    { name: '@capacitor/core', version: '8.5.2', relativePath: join('@capacitor', 'core') },
    { name: '@capacitor/app', version: '8.1.1', relativePath: join('@capacitor', 'app') }
];

async function physicalManifest(path, expectedName, expectedVersion) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`Pinned mobile vendor manifest is not a regular file: ${path}`);
    const bytes = await readFile(path);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.name !== expectedName || manifest.version !== expectedVersion)
        throw new Error(`Pinned mobile vendor identity mismatch: ${expectedName}@${expectedVersion}`);
    return { manifest, bytes };
}

async function physicalDirectory(path, label) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Pinned mobile vendor directory is not physical: ${label}`);
}

async function copyPhysicalVendor(source, destination, packageName) {
    await physicalDirectory(source, packageName);
    try {
        await lstat(destination);
        throw new Error(`Pinned mobile vendor destination already exists: ${packageName}`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await cp(source, destination, {
        recursive: true,
        filter: async entry => {
            const info = await lstat(entry);
            if (info.isSymbolicLink())
                throw new Error(`Pinned mobile vendor contains a symbolic link: ${packageName}`);
            if (!info.isDirectory() && !info.isFile())
                throw new Error(`Pinned mobile vendor contains a non-regular entry: ${packageName}`);
            return true;
        }
    });
}

async function copyPinnedMobileVendors(sourceRoot, fixtureRoot) {
    const packagesRoot = join(sourceRoot, 'packages');
    let packagesInfo;
    try { packagesInfo = await lstat(packagesRoot); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (packagesInfo.isSymbolicLink() || !packagesInfo.isDirectory())
        throw new Error('Mobile source packages directory must be a physical directory');

    const mobileRoot = join(packagesRoot, 'mobile-shell');
    let mobileInfo;
    try { mobileInfo = await lstat(mobileRoot); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (mobileInfo.isSymbolicLink() || !mobileInfo.isDirectory())
        throw new Error('Mobile shell source must be a physical directory');

    const mobileManifestPath = join(mobileRoot, 'package.json');
    let mobileManifestInfo;
    try { mobileManifestInfo = await lstat(mobileManifestPath); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (mobileManifestInfo.isSymbolicLink() || !mobileManifestInfo.isFile())
        throw new Error('Mobile shell package manifest must be a regular file');
    const mobileManifest = JSON.parse((await readFile(mobileManifestPath)).toString('utf8'));
    for (const entry of mobileVendorPackages) {
        if (mobileManifest.dependencies?.[entry.name] !== entry.version)
            throw new Error(`Mobile shell does not declare the reviewed ${entry.name}@${entry.version}`);
        await physicalDirectory(join(sourceRoot, 'node_modules'), 'node_modules');
        await physicalDirectory(join(sourceRoot, 'node_modules', '@capacitor'), '@capacitor namespace');
        const sourcePackage = join(sourceRoot, 'node_modules', entry.relativePath);
        await physicalDirectory(sourcePackage, entry.name);
        const sourceManifest = await physicalManifest(join(sourcePackage, 'package.json'), entry.name, entry.version);
        const destinationPackage = join(fixtureRoot, 'node_modules', entry.relativePath);
        await copyPhysicalVendor(sourcePackage, destinationPackage, entry.name);
        const copiedManifest = await physicalManifest(join(destinationPackage, 'package.json'), entry.name, entry.version);
        if (!sourceManifest.bytes.equals(copiedManifest.bytes))
            throw new Error(`Copied mobile vendor manifest changed: ${entry.name}`);
    }
}

export async function copyPortableFixture(t, sourceRoot, { prefix = 'qb-source-', afterSetup, physicalDependencies = false } = {}) {
    const temp = await mkdtemp(join(tmpdir(), prefix));
    const root = join(temp, 'source');
    const ownedCleanups = [];
    let cleaned = false;
    let cleanupFailure;
    const cleanup = async () => {
        if (cleaned) {
            if (cleanupFailure) throw cleanupFailure;
            return;
        }
        cleaned = true;
        const failures = [];
        for (const close of ownedCleanups.reverse()) {
            try { await close(); } catch (error) { failures.push(error); }
        }
        try { await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
        catch (error) { failures.push(error); }
        if (failures.length) {
            cleanupFailure = new AggregateError(failures, `Failed to clean portable fixture ${temp}`);
            throw cleanupFailure;
        }
    };
    t?.after(cleanup);
    try {
        await cp(sourceRoot, root, {
            recursive: true,
            filter: async source => {
                const rel = relative(sourceRoot, source).replaceAll('\\', '/');
                if (rel && !shouldIncludeMaintainedPath(rel)) return false;
                try { if ((await lstat(source)).isSymbolicLink()) return false; }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                return true;
            }
        });
        await mkdir(join(root, 'node_modules', '@types'), { recursive: true });
        for (const [name, targetName] of dependencies) {
            const target = join(sourceRoot, 'node_modules', targetName);
            const destination = join(root, 'node_modules', name);
            await mkdir(dirname(destination), { recursive: true });
            // Product build qualification hashes physical dependency bytes.
            if (physicalDependencies) await cp(target, destination, { recursive: true, dereference: true });
            else await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
        }
        await mkdir(join(root, 'node_modules', '@capacitor'), { recursive: true });
        await copyPinnedMobileVendors(sourceRoot, root);
        if (afterSetup) await afterSetup({ root, temp });
        return { root, temp, cleanup, registerCleanup(close) { ownedCleanups.push(close); } };
    } catch (error) {
        try { await cleanup(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Source copy setup and cleanup both failed'); }
        throw error;
    }
}

export { shouldIncludeMaintainedPath };
