import { mkdir, lstat, realpath, symlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWorkspaceIdentities } from './workspace-identities.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const index = await inspectWorkspaceIdentities(root);
for (const item of index.entries) {
  const link = resolve(root, 'node_modules', ...item.name.split('/'));
  await mkdir(dirname(link), { recursive: true });
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) throw new Error(`Workspace link path is already owned by a non-link: ${item.name}`);
    let target;
    try { target = await realpath(link); }
    catch { throw new Error(`Workspace link is broken: ${item.name}`); }
    if (target !== await realpath(item.path)) throw new Error(`Workspace link points to a different package: ${item.name}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(process.platform === 'win32' ? item.path : relative(dirname(link), item.path), link,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
}
console.log('Local workspace links prepared. No third-party packages were downloaded.');
