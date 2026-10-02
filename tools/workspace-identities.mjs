import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GROUPS = ['packages', 'modules', 'apps'];
const ID = /^[a-z][a-z0-9-]{1,47}$/;
const packageName = value => typeof value === 'string' && /^@quadbridge\/[a-z][a-z0-9-]{1,47}$/.test(value);

async function physicalDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path))
    throw new Error(`${label} must be a physical directory`);
}

/** Inspect declared source workspaces without creating or following package links. */
export async function inspectWorkspaceIdentities(root) {
  const sourceRoot = resolve(root);
  await physicalDirectory(sourceRoot, 'Workspace source root');
  const byName = new Map(), entries = [];
  for (const group of GROUPS) {
    const groupPath = join(sourceRoot, group);
    try { await lstat(groupPath); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    await physicalDirectory(groupPath, `${group} workspace group`);
    const groupEntries = await readdir(groupPath, { withFileTypes: true });
    for (const child of groupEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(groupPath, child.name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Workspace source directories must not be symbolic links');
      if (!info.isDirectory()) continue;
      if (!ID.test(child.name)) throw new Error('Workspace directory has an invalid source identity');
      await physicalDirectory(path, 'Workspace source directory');
      const manifestPath = join(path, 'package.json'), manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || await realpath(manifestPath) !== resolve(manifestPath))
        throw new Error('Workspace package manifest must be a physical regular file');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !packageName(manifest.name))
        throw new Error(`Workspace package identity is invalid under ${group}/${child.name}`);
      if (group !== 'apps' && manifest.name !== `@quadbridge/${child.name}`)
        throw new Error(`Workspace package identity does not match ${group}/${child.name}`);
      if (byName.has(manifest.name)) throw new Error(`Duplicate workspace package identity: ${manifest.name}`);
      const item = Object.freeze({ name: manifest.name, id: manifest.name.slice('@quadbridge/'.length), directoryId: child.name, group, path, manifestPath });
      byName.set(item.name, item);
      entries.push(item);
    }
  }
  return Object.freeze({ root: sourceRoot, byName, entries: Object.freeze(entries) });
}

export function assertWorkspaceNameAvailable(index, proposedName) {
  if (!index || !(index.byName instanceof Map) || !packageName(proposedName))
    throw new Error('A checked workspace identity index and package name are required');
  if (index.byName.has(proposedName)) throw new Error(`Workspace package identity already exists: ${proposedName}`);
  return proposedName;
}
