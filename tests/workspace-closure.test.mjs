import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '@quadbridge/composition';
import { deriveRuntimeWorkspaceClosure } from '@quadbridge/composition/workspace-closure';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const catalog = ['knowledge', 'service-desk', 'handoff'].map(id => read(`modules/${id}/module.json`));
const product = id => read(`products/${id}/product.json`);
const derive = plan => deriveRuntimeWorkspaceClosure(plan, path => read(path));

test('workspace export closure follows selected Knowledge package manifests and actual ai-core version', () => {
  const combined = derive(resolve(product('combined'), catalog));
  const paths = combined.roots.map(root => root.path);
  assert.ok(paths.includes('packages/ai-core'));
  assert.ok(paths.includes('packages/client-core'));
  assert.equal(paths.includes('packages/mobile-shell'), false);
  assert.ok(paths.includes('modules/knowledge'));
  assert.ok(paths.includes('modules/handoff'));
  assert.equal(combined.dependencies['@quadbridge/ai-core'], '0.3.0');
  assert.equal(combined.dependencies['@quadbridge/knowledge'], '0.2.3');
  assert.equal(combined.dependencies['@quadbridge/handoff'], '0.2.3');

  const desk = derive(resolve(product('service-desk'), catalog));
  assert.ok(desk.roots.some(root => root.path === 'packages/client-core'));
  assert.equal(desk.roots.some(root => root.path === 'packages/mobile-shell'), false);
  assert.equal(desk.roots.some(root => root.id === 'ai-core' || root.id === 'knowledge' || root.id === 'handoff'), false);
});

test('workspace closure rejects stale repeated package versions, unselected packages and identifier collisions', () => {
  const plan = resolve(product('combined'), catalog);
  assert.throws(() => deriveRuntimeWorkspaceClosure(plan, path => {
    const value = read(path);
    if (path === 'modules/handoff/package.json') value.dependencies['@quadbridge/contracts'] = '0.0.0';
    return value;
  }), /version mismatch/);
  assert.throws(() => deriveRuntimeWorkspaceClosure(plan, path => {
    const value = read(path);
    if (path === 'modules/handoff/package.json') value.dependencies['@quadbridge/unreviewed-package'] = '1.0.0';
    return value;
  }), /reviewed|selected/);
  const collision = structuredClone(plan);
  collision.modules[0].id = 'ai-core';
  assert.throws(() => deriveRuntimeWorkspaceClosure(collision, path => read(path)), /collide/);
});
