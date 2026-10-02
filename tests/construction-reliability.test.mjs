import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPortableFixture } from './source-copy.mjs';
import { validSourceDirectoryId } from '../packages/contracts/dist/index.js';
import { validProductId } from '../packages/composition/dist/studio.js';
import { preflightGeneratedModule } from '../tools/generation-preflight.mjs';
import { assertWorkspaceNameAvailable, inspectWorkspaceIdentities } from '../tools/workspace-identities.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
const packageJson = (id, extra = {}) => ({ name: `@quadbridge/${id}`, version: '0.2.0', ...extra });
async function writeWorkspace(base, group, id, manifest = packageJson(id)) {
  const path = join(base, group, id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
  return path;
}

test('source-directory identity is shared and stays within the 2–48 character envelope', () => {
  assert.equal(validSourceDirectoryId('a1'), true);
  assert.equal(validSourceDirectoryId('a'.repeat(48)), true);
  assert.equal(validSourceDirectoryId('a'.repeat(49)), false);
  assert.equal(validSourceDirectoryId('A1'), false);
  assert.equal(validProductId('a'.repeat(48)), true);
  assert.equal(validProductId('a'.repeat(49)), false);
});

test('workspace identity scan rejects duplicate names and checks availability without linking', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'qb-workspace-identities-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  await mkdir(join(temp, 'packages')); await mkdir(join(temp, 'modules')); await mkdir(join(temp, 'apps'));
  await writeWorkspace(temp, 'packages', 'alpha');
  await writeWorkspace(temp, 'apps', 'control-plane', { ...packageJson('studio-control-plane'), name: '@quadbridge/studio-control-plane' });
  const scanned = await inspectWorkspaceIdentities(temp);
  assert.equal(scanned.byName.get('@quadbridge/alpha').group, 'packages');
  assert.equal(scanned.byName.get('@quadbridge/studio-control-plane').directoryId, 'control-plane');
  assert.equal(assertWorkspaceNameAvailable(scanned, '@quadbridge/beta'), '@quadbridge/beta');
  assert.throws(() => assertWorkspaceNameAvailable(scanned, '@quadbridge/alpha'), /already exists/);
  await writeWorkspace(temp, 'modules', 'alpha');
  await assert.rejects(inspectWorkspaceIdentities(temp), /Duplicate workspace package identity/);
});

test('workspace linker is idempotent for its exact link and refuses a different existing owner', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'qb-link-owner-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const source = join(temp, 'source');
  for (const group of ['packages', 'modules', 'apps', 'tools']) await mkdir(join(source, group), { recursive: true });
  const declared = await writeWorkspace(source, 'packages', 'owner');
  await copyFile(join(root, 'tools', 'link-workspaces.mjs'), join(source, 'tools', 'link-workspaces.mjs'));
  await copyFile(join(root, 'tools', 'workspace-identities.mjs'), join(source, 'tools', 'workspace-identities.mjs'));
  const linker = join(source, 'tools', 'link-workspaces.mjs');
  assert.equal(run(source, linker).status, 0);
  assert.equal(run(source, linker).status, 0);
  const link = join(source, 'node_modules', '@quadbridge', 'owner');
  assert.equal(await realpath(link), await realpath(declared));
  await rm(link, { force: false });
  const wrong = join(source, 'wrong-owner'); await mkdir(wrong);
  await symlink(process.platform === 'win32' ? wrong : relative(join(source, 'node_modules', '@quadbridge'), wrong), link, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = run(source, linker);
  assert.notEqual(refused.status, 0);
  assert.equal(await realpath(link), await realpath(wrong), 'the linker leaves the unrelated existing owner untouched');
});

test('canonical module preflight rejects the host session route before generation can write', async () => {
  const manifest = {
    id: 'preflight-sample', version: '1.0.0', abi: 'quadbridge.module.v1', dependencies: [], provides: [], requires: [],
    permissions: ['preflight-sample.read'],
    routes: [{ method: 'GET', path: '/api/session', permission: 'preflight-sample.read', kind: 'read' }],
    workspaces: [], schema: { current: 1, readMin: 1, readMax: 1 }, background: false
  };
  assert.throws(() => preflightGeneratedModule(manifest), /host-owned operation/);
});

test('both source generators reject package and host-route conflicts before destination creation', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'qb-generation-refusal-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const copied = await copyPortableFixture(t, root, { prefix: 'qb-generation-refusal-source-' });
  const source = copied.root;
  const built = run(source, 'tools/build.mjs');
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const packageCollision = run(source, 'tools/factory.mjs', 'create-module', 'contracts');
  assert.notEqual(packageCollision.status, 0);
  await assert.rejects(lstat(join(source, 'modules', 'contracts')), { code: 'ENOENT' });
  const entityRouteCollisionSpec = join(temp, 'session.json');
  await writeFile(entityRouteCollisionSpec, JSON.stringify({ schema: 'quadbridge.entity-spec.v1',
    module: { id: 'session', version: '1.0.0', label: 'Session' },
    entity: { id: 'entry', label: 'Entry', displayField: 'title' },
    fields: [{ id: 'title', label: 'Title', type: 'text', required: true, minLength: 1, maxLength: 80 }] }));
  const entityRouteCollision = run(source, 'tools/factory.mjs', 'generate-entity', entityRouteCollisionSpec);
  assert.notEqual(entityRouteCollision.status, 0);
  assert.match(`${entityRouteCollision.stdout}\n${entityRouteCollision.stderr}`, /host-owned operation/);
  const moduleCollisionSpec = join(temp, 'contracts.json');
  await writeFile(moduleCollisionSpec, JSON.stringify({ schema: 'quadbridge.entity-spec.v1',
    module: { id: 'contracts', version: '1.0.0', label: 'Collision' },
    entity: { id: 'entry', label: 'Entry', displayField: 'title' },
    fields: [{ id: 'title', label: 'Title', type: 'text', required: true, minLength: 1, maxLength: 80 }] }));
  const entityPackageCollision = run(source, 'tools/factory.mjs', 'generate-entity', moduleCollisionSpec);
  assert.notEqual(entityPackageCollision.status, 0);
  assert.match(`${entityPackageCollision.stdout}\n${entityPackageCollision.stderr}`, /already exists/);
  const moduleRouteCollision = run(source, 'tools/factory.mjs', 'create-module', 'session');
  assert.notEqual(moduleRouteCollision.status, 0);
  assert.match(`${moduleRouteCollision.stdout}\n${moduleRouteCollision.stderr}`, /host-owned operation/);
  for (const id of ['session', 'contracts']) {
    await assert.rejects(lstat(join(source, 'modules', id)), { code: 'ENOENT' });
  }
});
