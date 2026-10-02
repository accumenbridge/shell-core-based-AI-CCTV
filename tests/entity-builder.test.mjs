import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateEntity, validateEntitySpec } from '../tools/entity-builder.mjs';
import { ROOT } from '../apps/runtime/dist/index.js';

const hash = value => createHash('sha256').update(value).digest('hex');

test('entity specifications are closed, bounded inputs with explicit field defaults and types', async () => {
  const asset = JSON.parse(await readFile(join(ROOT, 'examples/entities/asset-register.json'), 'utf8'));
  const room = JSON.parse(await readFile(join(ROOT, 'examples/entities/room-inspection.json'), 'utf8'));
  assert.equal(validateEntitySpec(asset).fields.find(field => field.id === 'active').default, true);
  assert.equal(validateEntitySpec(room).fields.find(field => field.id === 'passed').default, false);
  for (const mutate of [
    spec => { spec.extra = true; },
    spec => { spec.fields[1].type = 'currency'; },
    spec => { spec.fields[1].default = 121; },
    spec => { spec.fields[1].id = 'assetcode'; },
    spec => { spec.fields[0].id = 'tenant'; }
  ]) {
    const invalid = structuredClone(asset);
    mutate(invalid);
    assert.throws(() => validateEntitySpec(invalid));
  }
});

test('generator reserves a new owner, records exact output hashes, and treats inserted labels literally', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'qb-entity-spec-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const root = join(temp, 'source');
  await mkdir(join(root, 'templates'), { recursive: true });
  await mkdir(join(root, 'modules'));
  for (const name of ['contracts', 'sqlite', 'backend-host', 'web-shell']) {
    await mkdir(join(root, 'packages', name), { recursive: true });
    await copyFile(join(ROOT, 'packages', name, 'package.json'), join(root, 'packages', name, 'package.json'));
  }
  for (const name of ['entity-backend.ts.txt', 'entity-ui.ts.txt', 'entity.css.txt'])
    await copyFile(join(ROOT, 'templates', name), join(root, 'templates', name));
  const specPath = join(temp, 'literal.json');
  await writeFile(specPath, JSON.stringify({
    schema: 'quadbridge.entity-spec.v1',
    module: { id: 'literal-entity', version: '1.0.0', label: 'Literal entity' },
    entity: { id: 'item', label: 'Item $& __MODULE__', displayField: 'code' },
    fields: [{ id: 'code', label: 'Code $& __WRITE_PERMISSION__', type: 'text', required: true, minLength: 1, maxLength: 40 }]
  }));
  const generated = await generateEntity(root, specPath);
  assert.equal(generated.moduleId, 'literal-entity');
  const backend = await readFile(join(root, 'modules/literal-entity/src/index.ts'), 'utf8');
  const ui = await readFile(join(root, 'modules/literal-entity/src/ui.ts'), 'utf8');
  const manifest = JSON.parse(await readFile(join(root, 'modules/literal-entity/module.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(root, 'modules/literal-entity/generation.json'), 'utf8'));
  assert.ok(backend.includes('"Invalid Code $& __WRITE_PERMISSION__"'));
  assert.ok(backend.includes('const table = "\\\"item_records\\\"";'));
  assert.ok(ui.includes('const recordLabel = "Item $& __MODULE__";'));
  assert.deepEqual(manifest.operations.map(item => item.id), [
    'literal-entity.item.list', 'literal-entity.item.get', 'literal-entity.item.create', 'literal-entity.item.edit'
  ]);
  for (const [relative, expected] of Object.entries(receipt.outputSha256))
    assert.equal(hash(await readFile(join(root, 'modules/literal-entity', ...relative.split('/')))), expected, relative);
  assert.equal(receipt.specSha256, generated.specSha256);
  await assert.rejects(generateEntity(root, specPath), /destination already exists/);
});
