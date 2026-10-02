import { resolve } from '../packages/composition/dist/index.js';
import { validateStudioModule } from '../packages/studio-model/dist/index.js';
import { PLATFORM_ABI } from '../packages/contracts/dist/index.js';

/** Apply the existing composed-product route/manifest rules before a generator writes. */
export function preflightGeneratedModule(manifest) {
  validateStudioModule(manifest);
  const plan = resolve({
    id: manifest.id,
    version: manifest.version,
    platformAbi: PLATFORM_ABI,
    title: manifest.studio?.label ?? manifest.id,
    description: 'Generated module preflight only.',
    layout: 'sidebar',
    modules: [{ id: manifest.id, version: manifest.version }],
    bindings: []
  }, [manifest]);
  return plan.modules[0];
}
