import { PlatformError, type CompositionPlan, type ModuleManifest } from '@quadbridge/contracts';

export type StudioLayer = 'ui' | 'backend' | 'ai' | 'data' | 'worker' | 'integration' | 'deployment';
export interface UiContribution {
  routes?: { path: string; workspace: string; label: string; nav?: string; extensionPoint?: string }[];
  extensionPoints?: string[];
}
export interface BackendContribution {
  services?: { id: string; contract: string; visibility: 'module' | 'product' }[];
  events?: { id: string; direction: 'publish' | 'subscribe'; schema: string }[];
  jobs?: { kind: string; permission: string }[];
}
export interface AiModelRequirement {
  capability: string;
  modality: 'text' | 'vision' | 'audio' | 'embedding' | 'rerank' | 'custom';
  placement: 'cloud' | 'edge' | 'either';
  minContext?: number;
  accelerator?: 'cpu' | 'gpu' | 'npu' | 'either';
}
export interface AiContribution {
  pipelines?: { id: string; label: string; input: string; output: string }[];
  models?: AiModelRequirement[];
  tools?: { id: string; contract: string; permission: string }[];
}
export interface DataContribution {
  stores?: { id: string; kind: 'relational' | 'object' | 'vector' | 'graph' | 'cache' | 'timeseries'; ownership: 'module' | 'product' }[];
  schemas?: { id: string; version: number }[];
}
export interface DeploymentContribution {
  processes?: { id: string; kind: 'http' | 'worker' | 'model-server' | 'scheduler'; replicas?: number }[];
  resources?: { process: string; cpu?: string; memory?: string; gpu?: string; npu?: string }[];
  secrets?: string[];
  ports?: number[];
}
export interface ModuleStudioMetadata {
  label?: string;
  summary?: string;
  category?: string;
  layers?: StudioLayer[];
  ui?: UiContribution;
  backend?: BackendContribution;
  ai?: AiContribution;
  data?: DataContribution;
  deployment?: DeploymentContribution;
}
export type StudioModuleManifest = ModuleManifest & { studio?: ModuleStudioMetadata };

const safeId = /^[a-z][a-z0-9.-]{1,95}$/;
export function validateStudioModule(manifest: StudioModuleManifest): StudioModuleManifest {
  if (!safeId.test(manifest.id)) throw new PlatformError('INVALID', 'Invalid module id');
  const metadata = manifest.studio;
  if (!metadata) return manifest;
  for (const layer of metadata.layers ?? []) {
    if (!['ui','backend','ai','data','worker','integration','deployment'].includes(layer)) throw new PlatformError('INVALID', `Unknown Studio layer ${layer}`);
  }
  for (const pipeline of metadata.ai?.pipelines ?? []) if (!safeId.test(pipeline.id)) throw new PlatformError('INVALID', 'Invalid AI pipeline id');
  for (const store of metadata.data?.stores ?? []) if (!safeId.test(store.id)) throw new PlatformError('INVALID', 'Invalid data store id');
  for (const process of metadata.deployment?.processes ?? []) if (!safeId.test(process.id)) throw new PlatformError('INVALID', 'Invalid deployment process id');
  return manifest;
}

export interface LayerCoverage { layer: StudioLayer; modules: string[]; implemented: boolean; detail: string }
export function summarizePlan(plan: CompositionPlan): LayerCoverage[] {
  const modules = plan.modules as StudioModuleManifest[];
  const has = (layer: StudioLayer) => modules.filter(m => m.studio?.layers?.includes(layer)).map(m => m.id);
  return [
    { layer: 'ui', modules: has('ui'), implemented: modules.some(m => m.workspaces.length > 0), detail: `${modules.reduce((n,m)=>n+m.workspaces.length,0)} declared workspaces` },
    { layer: 'backend', modules: has('backend'), implemented: modules.some(m => m.routes.length > 0), detail: `${modules.reduce((n,m)=>n+m.routes.length,0)} declared HTTP operations` },
    { layer: 'worker', modules: has('worker'), implemented: plan.requiresWorker, detail: plan.requiresWorker ? 'Worker runtime required by composition' : 'No worker required' },
    { layer: 'integration', modules: has('integration'), implemented: plan.bindings.length > 0, detail: `${plan.bindings.length} resolved bindings` },
    { layer: 'ai', modules: has('ai'), implemented: has('ai').length > 0, detail: `${modules.reduce((n,m)=>n+(m.studio?.ai?.pipelines?.length ?? 0),0)} declared AI pipelines` },
    { layer: 'data', modules: has('data'), implemented: has('data').length > 0, detail: `${modules.reduce((n,m)=>n+(m.studio?.data?.stores?.length ?? 0),0)} declared data stores` },
    { layer: 'deployment', modules: has('deployment'), implemented: false, detail: 'Deployment contracts declared; production orchestrator not yet attached' }
  ];
}
