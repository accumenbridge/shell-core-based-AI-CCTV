import { cp, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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

export async function copyPortableFixture(t, sourceRoot, { prefix = 'qb-source-', afterSetup } = {}) {
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
            const type = process.platform === 'win32' ? 'junction' : 'dir';
            await mkdir(dirname(destination), { recursive: true });
            await symlink(target, destination, type);
        }
        if (afterSetup) await afterSetup({ root, temp });
        return { root, temp, cleanup, registerCleanup(close) { ownedCleanups.push(close); } };
    } catch (error) {
        try { await cleanup(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Source copy setup and cleanup both failed'); }
        throw error;
    }
}

export { shouldIncludeMaintainedPath };
