import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve as resolveProduct } from '@quadbridge/composition';
import type { CompositionPlan } from '@quadbridge/contracts';
import { planAiPipeline, type AiPipeline } from '@quadbridge/ai-core';
import { summarizePlan, validateStudioModule, type StudioModuleManifest } from '@quadbridge/studio-model';
import type { ProductDefinition } from '@quadbridge/contracts';
import type { ControlPlaneStore } from '@quadbridge/control-plane';
import { reviewedBuildFingerprint } from './build-inputs.js';

export interface SourceSnapshot {
  modules: StudioModuleManifest[];
  solutions: { id: string; studio?: { consumer: string; label: string; ports: unknown[] } }[];
  sourcePlans: CompositionPlan[];
  sourceFingerprint: string;
}

export const maintainedSourceFingerprint = reviewedBuildFingerprint;

const sourceActor = 'system:source-import';
const sampleKnowledgePipeline: AiPipeline = {
  schema: 'quadbridge.ai-pipeline.v1', id: 'knowledge-rag', version: '0.1.0', label: 'Knowledge retrieval and answer',
  nodes: [
    { id: 'input', kind: 'input' },
    { id: 'embed', kind: 'embedding', capability: 'text.embedding' },
    { id: 'retrieve', kind: 'retriever' },
    { id: 'answer', kind: 'model', capability: 'text.generate', permission: 'knowledge.read' },
    { id: 'output', kind: 'output' }
  ],
  edges: [
    { from: 'input', to: 'embed' }, { from: 'embed', to: 'retrieve' },
    { from: 'retrieve', to: 'answer' }, { from: 'answer', to: 'output' }
  ],
  policy: { timeoutMs: 30000, maxParallel: 4, dataClass: 'internal', placement: 'hybrid' }
};

const sampleExtractivePipeline: AiPipeline = {
  schema: 'quadbridge.ai-pipeline.v1', id: 'knowledge-extractive-answer', version: '1.0.0', label: 'Local extractive answer',
  nodes: [
    { id: 'question', kind: 'input' },
    { id: 'indexed-evidence', kind: 'retriever' },
    { id: 'cited-excerpts', kind: 'output' }
  ],
  edges: [{ from: 'question', to: 'indexed-evidence' }, { from: 'indexed-evidence', to: 'cited-excerpts' }],
  policy: { timeoutMs: 5000, maxParallel: 4, dataClass: 'internal', placement: 'edge' }
};

export function loadSourceSnapshot(root: string): SourceSnapshot {
  const sourceFingerprint = maintainedSourceFingerprint(root);
  const moduleRoot = join(root, 'modules');
  const productRoot = join(root, 'products');
  if (!existsSync(moduleRoot) || !existsSync(productRoot)) throw new Error('Source catalogue directories are missing');
  const modules = readdirSync(moduleRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(entry.name)) throw new Error(`Unsafe module directory ${entry.name}`);
      const manifest = validateStudioModule(JSON.parse(readFileSync(join(moduleRoot, entry.name, 'module.json'), 'utf8')) as StudioModuleManifest);
      if (manifest.id !== entry.name) throw new Error(`Module directory identity mismatch: ${entry.name}`);
      return manifest;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const products = readdirSync(productRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(entry.name)) throw new Error(`Unsafe product directory ${entry.name}`);
      const product = JSON.parse(readFileSync(join(productRoot, entry.name, 'product.json'), 'utf8')) as ProductDefinition;
      if (product.id !== entry.name) throw new Error(`Product directory identity mismatch: ${entry.name}`);
      return product;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const sourcePlans = products.map(product => resolveProduct(product, modules));
  const solutionRoot = join(root, 'solutions');
  const solutions = existsSync(solutionRoot) ? readdirSync(solutionRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(entry.name)) throw new Error(`Unsafe solution directory ${entry.name}`);
      const solution = JSON.parse(readFileSync(join(solutionRoot, entry.name, 'solution.json'), 'utf8')) as { id?: unknown; studio?: unknown };
      if (solution.id !== entry.name) throw new Error(`Solution directory identity mismatch: ${entry.name}`);
      return solution as SourceSnapshot['solutions'][number];
    }).sort((a,b) => a.id.localeCompare(b.id)) : [];
  if (maintainedSourceFingerprint(root) !== sourceFingerprint) throw new Error('Maintained source changed while the startup catalogue was loading');
  return { modules, sourcePlans, solutions, sourceFingerprint };
}

export function importSourceSnapshot(store: ControlPlaneStore, snapshot: SourceSnapshot): void {
  for (const plan of snapshot.sourcePlans) store.putProduct(plan.product, sourceActor);
  if (!store.environments().length) {
    store.putEnvironment({ id: 'local-dev', label: 'Local development', kind: 'development', target: 'local' }, sourceActor);
    store.putEnvironment({ id: 'staging', label: 'Staging', kind: 'staging', target: 'cloud' }, sourceActor);
    store.putEnvironment({ id: 'production', label: 'Production', kind: 'production', target: 'cloud' }, sourceActor);
  }
  if (!store.aiPipelines().length) store.putAiPipeline(sampleKnowledgePipeline, sourceActor);
  if (!store.aiPipelines().some(row => row.id === sampleExtractivePipeline.id)) store.putAiPipeline(sampleExtractivePipeline, sourceActor);
}

export function storedOverview(store: ControlPlaneStore, snapshot: SourceSnapshot, workerAttached = false,
  artifactCapability?: {status:'ready'|'unavailable';detail:string}, runtimeAttached = false) {
  const plans = store.products().flatMap((row: any) => {
    try {
      const definition = store.product(String(row.id), String(row.version));
      return definition ? [resolveProduct(definition, snapshot.modules)] : [];
    } catch { return []; }
  });
  const widest = plans.length ? plans.reduce((best, plan) => plan.modules.length > best.modules.length ? plan : best) : undefined;
  const aiPipelines = store.aiPipelines().map(row => {
    const plan = planAiPipeline(row.spec);
    return { id: row.id, version: row.version, digest: row.digest, stages: plan.stages.length, capabilities: plan.requiredCapabilities.join(', ') || '—' };
  });
  return {
    platform: { version: '0.3.0', mode: 'paired local control plane' },
    modules: snapshot.modules.map(m => ({
      id: m.id, version: m.version, workspaces: m.workspaces.length, routes: m.routes.length,
      provides: m.provides.length, requires: m.requires.length, layers: m.studio?.layers ?? [],
      aiPipelines: m.studio?.ai?.pipelines?.length ?? 0, dataStores: m.studio?.data?.stores?.length ?? 0, schema: m.schema.current
    })),
    products: plans.map(plan => ({ id: plan.product.id, title: plan.product.title, version: plan.product.version, modules: plan.modules.length })),
    productVersions: store.productVersions(),
    coverage: widest ? summarizePlan(widest) : [],
    builds: store.builds(), environments: store.environments(), deployments: store.deployments(), aiPipelines,
    audit: store.auditLog(100),
    capabilities: [
      { id: 'product-composition', status: 'attached', detail: 'Stored product versions are checked by the canonical exact-version resolver.' },
      { id: 'application-runtime', status: runtimeAttached ? 'attached' : 'existing-core-only', detail: runtimeAttached
        ? 'A paired local manager owns only process trees started in this process; stored runtimes are not recovered by PID.'
        : 'The existing runtime and worker hosts remain available; this control plane does not start or manage an application instance.' },
      { id: 'build-executor', status: workerAttached ? 'attached' : 'not-attached', detail: workerAttached ? 'A fixed local compiler and factory worker produces verified exports in the local snapshot store.' : 'Build requests cannot be executed by this control plane.' },
      { id: 'artifact-registry', status: artifactCapability ? 'attached' : 'not-attached', detail: artifactCapability ? 'Immutable artifact and release metadata are stored locally and remain readable without a compiler or deployment service.' : 'No local artifact registry adapter is attached.' },
      { id: 'artifact-publication', status: artifactCapability?.status ?? 'unavailable', detail: artifactCapability?.detail ?? 'The local no-overwrite publication adapter is not attached.' },
      { id: 'deployment-controller', status: 'not-attached', detail: 'Deployment requests are admitted as REQUESTED records only.' },
      { id: 'model-serving', status: 'not-attached', detail: 'AI pipelines are validated plans; no model provider is invoked.' }
    ]
  };
}
