import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineModule } from '../packages/module-sdk/dist/index.js';
import { validateStudioModule } from '../packages/studio-model/dist/index.js';

const moduleRoot = resolve('modules');
const manifests = readdirSync(moduleRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(moduleRoot, entry.name, 'module.json'))
  .filter(path => {
    try { readFileSync(path); return true; } catch { return false; }
  })
  .map(path => ({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) }));

test('Studio metadata validation accepts maintained source manifests through the module SDK', () => {
  assert.ok(manifests.length > 0, 'the maintained module catalogue is present');
  for (const { path, manifest } of manifests) {
    assert.equal(validateStudioModule(manifest), manifest, `${path} is a valid source declaration`);
    const { abi, ...definition } = manifest;
    assert.equal(defineModule(definition).abi, abi, `${path} remains valid through the SDK authority`);
  }
});

test('Studio metadata validation rejects malformed nested shapes, enums, identifiers and numeric bounds', () => {
  const base = JSON.parse(readFileSync(join(moduleRoot, 'service-desk', 'module.json'), 'utf8'));
  const invalid = [
    ['metadata must be a plain object', value => { value.studio = []; }],
    ['layers must be an enum array', value => { value.studio.layers = ['database']; }],
    ['routes require their declared fields', value => { value.studio.ui.routes = [{ path: '/x', workspace: 'desk.requests' }]; }],
    ['extension points use the shared capability syntax', value => { value.studio.ui.extensionPoints = ['x']; }],
    ['backend visibility is bounded', value => { value.studio.backend.services[0].visibility = 'global'; }],
    ['event direction is bounded', value => { value.studio.backend.events = [{ id: 'desk.changed', direction: 'emit', schema: 'desk.changed.v1' }]; }],
    ['AI minimum context is positive', value => { value.studio.ai = { models: [{ capability: 'text.generate', modality: 'text', placement: 'either', minContext: 0 }] }; }],
    ['data store kind is bounded', value => { value.studio.data.stores[0].kind = 'universal'; }],
    ['schema version is a nonnegative safe integer', value => { value.studio.data.schemas[0].version = -1; }],
    ['deployment replicas are positive', value => { value.studio.deployment.processes[0].replicas = 0; }],
    ['deployment ports are valid TCP ports', value => { value.studio.deployment.ports = [65536]; }],
    ['secret references are nonempty symbolic names', value => { value.studio.deployment.secrets = ['']; }]
  ];
  for (const [label, mutate] of invalid) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.throws(() => validateStudioModule(candidate), error => error?.code === 'INVALID', label);
  }

  const sdkCandidate = structuredClone(base);
  sdkCandidate.studio.backend.services[0].contract = 'Bad Contract';
  const { abi, ...definition } = sdkCandidate;
  assert.throws(() => defineModule(definition), error => error?.code === 'INVALID', 'the SDK cannot bypass capability syntax validation');
});
