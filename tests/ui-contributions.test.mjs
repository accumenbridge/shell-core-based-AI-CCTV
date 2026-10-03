import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../generated/catalog.mjs';
import { copyReviewedBuildInputs, reviewedBuildFiles, reviewedBuildFingerprint } from '../apps/control-plane/dist/build-inputs.js';
import { resolve } from '../packages/composition/dist/index.js';
import { resolveUiContributionBindings } from '../packages/contracts/dist/ui-contributions.js';
import { canonical } from '../packages/contracts/dist/index.js';
import { ControlPlaneStore } from '../packages/control-plane/dist/index.js';
import { importSourceSnapshot, loadSourceSnapshot } from '../apps/control-plane/dist/source-import.js';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const modules = catalog.map(item => item.manifest);
const mapping = readJson('../solutions/knowledge-to-desk/ui.json');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('reviewed UI slots resolve actual module ownership for desk.requests', () => {
  const plan = resolve(readJson('../products/combined/product.json'), modules);
  const result = resolveUiContributionBindings(plan, mapping, modules);
  assert.deepEqual(result.bindings, [
    { workspaceId: 'desk.requests', slot: 'workspace.aside', contributionId: 'knowledge.referenceSearch' },
    { workspaceId: 'knowledge.library', slot: 'workspace.footer', contributionId: 'service-desk.recentRequests' }
  ]);
  assert.deepEqual(result.omitted, []);
});

test('optional UI slots explain omission from source workspace ownership and contribution owner', () => {
  const deskOnly = resolveUiContributionBindings({ modules: modules.filter(module => module.id === 'service-desk') }, mapping, modules);
  assert.deepEqual(deskOnly.omitted, [
    { workspaceId: 'desk.requests', slot: 'workspace.aside', contributionId: 'knowledge.referenceSearch', reason: 'CONTRIBUTION_MODULE_NOT_SELECTED' },
    { workspaceId: 'knowledge.library', slot: 'workspace.footer', contributionId: 'service-desk.recentRequests', reason: 'WORKSPACE_MODULE_NOT_SELECTED' }
  ]);
});

test('a selected owner must carry the same source-declared contribution', () => {
  const selected = modules.filter(module => module.id === 'service-desk' || module.id === 'knowledge');
  const driftedPlan = { modules: selected.map(module => module.id === 'knowledge' ? { ...module, uiContributions: [] } : module) };
  assert.throws(() => resolveUiContributionBindings(driftedPlan, mapping, modules), /not declared by its selected owner/);
});

test('the reviewed source closure admits the exact solution UI mapping leaf', () => {
  const paths = new Set(reviewedBuildFiles(ROOT).map(item => item.relativePath));
  assert.equal(paths.has('solutions/knowledge-to-desk/ui.json'), true);
  assert.equal(paths.has('solutions/knowledge-to-desk/unreviewed.json'), false);
});

test('the reviewed UI mapping is copied byte-for-byte and contributes to the source fingerprint', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'qb-ui-mapping-copy-'));
  const copiedRoot = join(temp, 'source');
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  await copyReviewedBuildInputs(ROOT, copiedRoot);
  const mappingPath = 'solutions/knowledge-to-desk/ui.json';
  const copiedMapping = join(copiedRoot, ...mappingPath.split('/'));
  assert.deepEqual(await readFile(copiedMapping), await readFile(join(ROOT, ...mappingPath.split('/'))));
  const before = reviewedBuildFingerprint(copiedRoot);
  await writeFile(copiedMapping, `${await readFile(copiedMapping, 'utf8')}\n`);
  assert.notEqual(reviewedBuildFingerprint(copiedRoot), before, 'the reviewed mapping bytes bind the copied source fingerprint');
  const unreviewed = join(copiedRoot, 'solutions', 'knowledge-to-desk', 'unreviewed.json');
  await writeFile(unreviewed, '{}\n');
  assert.throws(() => reviewedBuildFiles(copiedRoot), /Unreviewed build input path|not allowed/u);
});

test('current source import preserves the captured old product identity and is idempotent', () => {
  const store = new ControlPlaneStore(':memory:');
  const priorDesk = {
    id: 'service-desk', version: '0.2.0', platformAbi: 'quadbridge.module.v1', title: 'Service Desk',
    description: 'A small non-AI business product.', layout: 'sidebar',
    modules: [{ id: 'service-desk', version: '0.2.0' }], bindings: []
  };
  try {
    store.putProduct(priorDesk, 'system:ui-source-upgrade-fixture');
    const oldBefore = canonical(store.product('service-desk', '0.2.0'));
    const current = loadSourceSnapshot(ROOT);
    importSourceSnapshot(store, current);
    const currentDesk = current.sourcePlans.find(plan => plan.product.id === 'service-desk')?.product;
    assert.ok(currentDesk);
    assert.equal(currentDesk.version, '0.2.3');
    assert.equal(canonical(store.product('service-desk', '0.2.0')), oldBefore,
      'importing changed module behavior does not rewrite the captured immutable product');
    assert.equal(canonical(store.product('service-desk', currentDesk.version)), canonical(currentDesk));
    const countAfterFirstImport = store.productVersions().length;
    importSourceSnapshot(store, current);
    assert.equal(store.productVersions().length, countAfterFirstImport, 'reimport adds no duplicate source version');
    assert.equal(canonical(store.product('service-desk', '0.2.0')), oldBefore);
    assert.equal(canonical(store.product('service-desk', currentDesk.version)), canonical(currentDesk));
  } finally {
    store.close();
  }
});
