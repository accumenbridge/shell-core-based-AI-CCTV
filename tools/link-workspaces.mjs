import { readdir, readFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const group of ['packages', 'modules', 'apps'])
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const dir = join(root, group, entry.name);
        let pkg;
        try {
            pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        }
        catch {
            continue;
        }
        if (!pkg.name.startsWith('@quadbridge/'))
            throw new Error('Unapproved workspace scope');
        const link = join(root, 'node_modules', pkg.name);
        await mkdir(resolve(link, '..'), { recursive: true });
        try {
            await lstat(link);
        }
        catch {
            await symlink(process.platform === 'win32' ? dir : relative(resolve(link, '..'), dir), link, process.platform === 'win32' ? 'junction' : 'dir');
        }
    }
console.log('Local workspace links prepared. No third-party packages were downloaded.');
