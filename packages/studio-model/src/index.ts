import { PlatformError, type CompositionPlan, type ModuleManifest } from '@quadbridge/contracts';
import { validateModuleManifest } from '@quadbridge/contracts/module-manifest';
import { validateOperationDescriptor } from '@quadbridge/contracts/operations';
import { validateUiContributionDescriptors } from '@quadbridge/contracts/ui-contributions';

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
const capabilityName = /^[a-z][a-z0-9_.-]{2,127}$/;
type RecordValue = Record<string, any>;
function invalid(label: string): never { throw new PlatformError('INVALID', `Invalid Studio ${label}`); }
function record(value: unknown, label: string, allowed: readonly string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label} object`);
  const result = value as RecordValue;
  if (Object.keys(result).some(key => !allowed.includes(key))) invalid(`${label} fields`);
  return result;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) invalid(label);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!safeId.test(result)) invalid(label);
  return result;
}
function capability(value: unknown, label: string): string {
  const result = string(value, label);
  if (!capabilityName.test(result)) invalid(label);
  return result;
}
function enumeration(value: unknown, label: string, choices: readonly string[]): string {
  const result = string(value, label);
  if (!choices.includes(result)) invalid(label);
  return result;
}
function optionalText(object: RecordValue, key: string, label: string): void {
  if (object[key] !== undefined) string(object[key], label);
}
function optionalArray(object: RecordValue, key: string, label: string, validate: (item: unknown) => void): void {
  if (object[key] === undefined) return;
  if (!Array.isArray(object[key])) invalid(`${label} array`);
  for (const item of object[key]) validate(item);
}
function itemRecord(value: unknown, label: string, keys: readonly string[], required: readonly string[]): RecordValue {
  const item = record(value, label, keys);
  for (const key of required) if (item[key] === undefined) invalid(`${label} ${key}`);
  return item;
}
function validateStudioMetadata(value: unknown): void {
  const metadata = record(value, 'metadata', ['label','summary','category','layers','ui','backend','ai','data','deployment']);
  optionalText(metadata, 'label', 'label');
  optionalText(metadata, 'summary', 'summary');
  optionalText(metadata, 'category', 'category');
  optionalArray(metadata, 'layers', 'layers', value => enumeration(value, 'layer', ['ui','backend','ai','data','worker','integration','deployment']));

  if (metadata.ui !== undefined) {
    const ui = record(metadata.ui, 'UI contribution', ['routes','extensionPoints']);
    optionalArray(ui, 'routes', 'UI routes', value => {
      const route = itemRecord(value, 'UI route', ['path','workspace','label','nav','extensionPoint'], ['path','workspace','label']);
      string(route.path, 'UI route path'); identifier(route.workspace, 'UI workspace'); string(route.label, 'UI route label');
      optionalText(route, 'nav', 'UI navigation label');
      if (route.extensionPoint !== undefined) capability(route.extensionPoint, 'UI extension point');
    });
    optionalArray(ui, 'extensionPoints', 'UI extension points', value => capability(value, 'UI extension point'));
  }
  if (metadata.backend !== undefined) {
    const backend = record(metadata.backend, 'backend contribution', ['services','events','jobs']);
    optionalArray(backend, 'services', 'backend services', value => {
      const item = itemRecord(value, 'backend service', ['id','contract','visibility'], ['id','contract','visibility']);
      identifier(item.id, 'backend service id'); capability(item.contract, 'backend service contract');
      enumeration(item.visibility, 'backend service visibility', ['module','product']);
    });
    optionalArray(backend, 'events', 'backend events', value => {
      const item = itemRecord(value, 'backend event', ['id','direction','schema'], ['id','direction','schema']);
      identifier(item.id, 'backend event id'); enumeration(item.direction, 'backend event direction', ['publish','subscribe']);
      capability(item.schema, 'backend event schema');
    });
    optionalArray(backend, 'jobs', 'backend jobs', value => {
      const item = itemRecord(value, 'backend job', ['kind','permission'], ['kind','permission']);
      capability(item.kind, 'backend job kind'); capability(item.permission, 'backend job permission');
    });
  }
  if (metadata.ai !== undefined) {
    const ai = record(metadata.ai, 'AI contribution', ['pipelines','models','tools']);
    optionalArray(ai, 'pipelines', 'AI pipelines', value => {
      const item = itemRecord(value, 'AI pipeline', ['id','label','input','output'], ['id','label','input','output']);
      identifier(item.id, 'AI pipeline id'); string(item.label, 'AI pipeline label'); string(item.input, 'AI pipeline input'); string(item.output, 'AI pipeline output');
    });
    optionalArray(ai, 'models', 'AI models', value => {
      const item = itemRecord(value, 'AI model requirement', ['capability','modality','placement','minContext','accelerator'], ['capability','modality','placement']);
      capability(item.capability, 'AI model capability');
      enumeration(item.modality, 'AI model modality', ['text','vision','audio','embedding','rerank','custom']);
      enumeration(item.placement, 'AI model placement', ['cloud','edge','either']);
      if (item.minContext !== undefined && (!Number.isSafeInteger(item.minContext) || item.minContext <= 0)) invalid('AI minimum context');
      if (item.accelerator !== undefined) enumeration(item.accelerator, 'AI accelerator', ['cpu','gpu','npu','either']);
    });
    optionalArray(ai, 'tools', 'AI tools', value => {
      const item = itemRecord(value, 'AI tool', ['id','contract','permission'], ['id','contract','permission']);
      identifier(item.id, 'AI tool id'); capability(item.contract, 'AI tool contract'); capability(item.permission, 'AI tool permission');
    });
  }
  if (metadata.data !== undefined) {
    const data = record(metadata.data, 'data contribution', ['stores','schemas']);
    optionalArray(data, 'stores', 'data stores', value => {
      const item = itemRecord(value, 'data store', ['id','kind','ownership'], ['id','kind','ownership']);
      identifier(item.id, 'data store id'); enumeration(item.kind, 'data store kind', ['relational','object','vector','graph','cache','timeseries']);
      enumeration(item.ownership, 'data store ownership', ['module','product']);
    });
    optionalArray(data, 'schemas', 'data schemas', value => {
      const item = itemRecord(value, 'data schema', ['id','version'], ['id','version']);
      identifier(item.id, 'data schema id');
      if (!Number.isSafeInteger(item.version) || item.version < 0) invalid('data schema version');
    });
  }
  if (metadata.deployment !== undefined) {
    const deployment = record(metadata.deployment, 'deployment contribution', ['processes','resources','secrets','ports']);
    optionalArray(deployment, 'processes', 'deployment processes', value => {
      const item = itemRecord(value, 'deployment process', ['id','kind','replicas'], ['id','kind']);
      identifier(item.id, 'deployment process id'); enumeration(item.kind, 'deployment process kind', ['http','worker','model-server','scheduler']);
      if (item.replicas !== undefined && (!Number.isSafeInteger(item.replicas) || item.replicas < 1)) invalid('deployment replicas');
    });
    optionalArray(deployment, 'resources', 'deployment resources', value => {
      const item = itemRecord(value, 'deployment resource', ['process','cpu','memory','gpu','npu'], ['process']);
      identifier(item.process, 'deployment resource process');
      for (const key of ['cpu','memory','gpu','npu']) optionalText(item, key, `deployment resource ${key}`);
    });
    optionalArray(deployment, 'secrets', 'deployment secrets', value => {
      const symbol = string(value, 'deployment secret reference');
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(symbol)) invalid('deployment secret reference');
    });
    optionalArray(deployment, 'ports', 'deployment ports', value => {
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) invalid('deployment port');
    });
  }
}

export function validateStudioModule(manifest: StudioModuleManifest): StudioModuleManifest {
  validateModuleManifest(manifest);
  for (const operation of manifest.operations ?? []) validateOperationDescriptor(operation, manifest.id, manifest.permissions);
  validateUiContributionDescriptors(manifest);
  const source = record(manifest, 'module manifest', ['id','version','abi','dependencies','provides','requires','permissions','routes','workspaces','uiContributions','schema','background','browserAssets','operations','studio']);
  if (source.studio !== undefined) validateStudioMetadata(source.studio);
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
