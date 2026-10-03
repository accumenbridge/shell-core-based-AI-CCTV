import { PlatformError, canonical, type Json } from '@quadbridge/contracts';
import { createHash } from 'node:crypto';

export type AiNodeKind = 'input' | 'model' | 'embedding' | 'retriever' | 'reranker' | 'prompt' | 'tool' | 'rule' | 'transform' | 'output';
export interface AiNode {
  id: string;
  kind: AiNodeKind;
  capability?: string;
  config?: Record<string, Json>;
  permission?: string;
}
export interface AiEdge { from: string; to: string }
export interface AiPipeline {
  schema: 'quadbridge.ai-pipeline.v1';
  id: string;
  version: string;
  label: string;
  nodes: AiNode[];
  edges: AiEdge[];
  policy: { timeoutMs: number; maxParallel: number; dataClass: 'public' | 'internal' | 'confidential' | 'restricted'; placement: 'cloud' | 'edge' | 'hybrid' };
}
export interface AiExecutionPlan { pipeline: AiPipeline; digest: string; stages: string[][]; requiredCapabilities: string[]; requiredPermissions: string[] }

const idPattern = /^[a-z][a-z0-9.-]{1,95}$/;
const nodeKinds = new Set<AiNodeKind>(['input', 'model', 'embedding', 'retriever', 'reranker', 'prompt', 'tool', 'rule', 'transform', 'output']);
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
function record(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new PlatformError('INVALID', `Invalid ${label}`);
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !allowed.has(key)))
    throw new PlatformError('INVALID', `Invalid ${label} fields`);
  return object;
}
function jsonValue(value: unknown, depth = 0, seen = new Set<object>()): value is import('@quadbridge/contracts').Json {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4096 && !value.includes('\0');
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 12 || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) valid = value.length <= 256 && value.every(item => jsonValue(item, depth + 1, seen));
  else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    const keys = Object.keys(value);
    valid = keys.length <= 128 && keys.every(key => key.length <= 128 && !key.includes('\0') && jsonValue((value as Record<string, unknown>)[key], depth + 1, seen));
  } else valid = false;
  seen.delete(value);
  return valid;
}
function validatePipelineShape(value: AiPipeline): void {
  const pipeline = record(value, ['schema', 'id', 'version', 'label', 'nodes', 'edges', 'policy'], [], 'AI pipeline');
  if (typeof pipeline.label !== 'string' || !pipeline.label.trim() || pipeline.label.length > 160 || pipeline.label.includes('\0'))
    throw new PlatformError('INVALID', 'Invalid AI pipeline label');
  if (!Array.isArray(pipeline.nodes) || pipeline.nodes.length < 2 || pipeline.nodes.length > 256 || !Array.isArray(pipeline.edges) || pipeline.edges.length > 1024)
    throw new PlatformError('INVALID', 'Invalid AI pipeline graph size');
  for (const value of pipeline.nodes) {
    const node = record(value, ['id', 'kind'], ['capability', 'config', 'permission'], 'AI node');
    if (typeof node.id !== 'string' || !idPattern.test(node.id) || typeof node.kind !== 'string' || !nodeKinds.has(node.kind as AiNodeKind))
      throw new PlatformError('INVALID', 'Invalid AI node identity or kind');
    if (node.capability !== undefined && (typeof node.capability !== 'string' || !capabilityPattern.test(node.capability)))
      throw new PlatformError('INVALID', 'Invalid AI capability');
    if (node.permission !== undefined && (typeof node.permission !== 'string' || !capabilityPattern.test(node.permission)))
      throw new PlatformError('INVALID', 'Invalid AI permission');
    if (node.config !== undefined) {
      if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config))
        throw new PlatformError('INVALID', 'AI node config must be an object');
      const config = record(node.config, [], Object.keys(node.config as object), 'AI node config');
      if (!jsonValue(config)) throw new PlatformError('INVALID', 'AI node config must contain bounded JSON values');
    }
  }
  for (const value of pipeline.edges) {
    const edge = record(value, ['from', 'to'], [], 'AI edge');
    if (typeof edge.from !== 'string' || !idPattern.test(edge.from) || typeof edge.to !== 'string' || !idPattern.test(edge.to))
      throw new PlatformError('INVALID', 'Invalid AI edge identity');
  }
  const policy = record(pipeline.policy, ['timeoutMs', 'maxParallel', 'dataClass', 'placement'], [], 'AI policy');
  if (!Number.isSafeInteger(policy.timeoutMs) || !Number.isSafeInteger(policy.maxParallel))
    throw new PlatformError('INVALID', 'Invalid AI policy bounds');
  if (typeof policy.dataClass !== 'string' || !['public', 'internal', 'confidential', 'restricted'].includes(policy.dataClass) || typeof policy.placement !== 'string' || !['cloud', 'edge', 'hybrid'].includes(policy.placement))
    throw new PlatformError('INVALID', 'Invalid AI policy classification or placement');
}
export function planAiPipeline(pipeline: AiPipeline): AiExecutionPlan {
  validatePipelineShape(pipeline);
  if (pipeline.schema !== 'quadbridge.ai-pipeline.v1' || typeof pipeline.id !== 'string' || !idPattern.test(pipeline.id) || typeof pipeline.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pipeline.version)) throw new PlatformError('INVALID', 'Invalid AI pipeline identity');
  if (!Number.isInteger(pipeline.policy.timeoutMs) || pipeline.policy.timeoutMs < 100 || pipeline.policy.timeoutMs > 600000) throw new PlatformError('INVALID', 'Invalid AI timeout');
  if (!Number.isInteger(pipeline.policy.maxParallel) || pipeline.policy.maxParallel < 1 || pipeline.policy.maxParallel > 64) throw new PlatformError('INVALID', 'Invalid AI concurrency');
  const nodes = new Map<string,AiNode>();
  for (const node of pipeline.nodes) {
    if (!idPattern.test(node.id) || nodes.has(node.id)) throw new PlatformError('INVALID', `Invalid or duplicate AI node ${node.id}`);
    nodes.set(node.id,node);
  }
  if (!pipeline.nodes.some(n=>n.kind==='input') || !pipeline.nodes.some(n=>n.kind==='output')) throw new PlatformError('INVALID', 'AI pipeline needs input and output nodes');
  const incoming = new Map([...nodes.keys()].map(k=>[k,0]));
  const outgoing = new Map([...nodes.keys()].map(k=>[k,[] as string[]]));
  const edgeSet = new Set<string>();
  for (const edge of pipeline.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from===edge.to) throw new PlatformError('INVALID', 'Invalid AI edge');
    const edgeKey = `${edge.from}\0${edge.to}`;
    if (edgeSet.has(edgeKey)) throw new PlatformError('INVALID', 'Duplicate AI edge');
    edgeSet.add(edgeKey);
    outgoing.get(edge.from)!.push(edge.to); incoming.set(edge.to,incoming.get(edge.to)!+1);
  }
  let frontier=[...incoming].filter(([,n])=>n===0).map(([id])=>id).sort();
  const stages:string[][]=[]; let visited=0;
  while(frontier.length){stages.push(frontier);const next:string[]=[];for(const id of frontier){visited++;for(const target of outgoing.get(id)!){const left=incoming.get(target)!-1;incoming.set(target,left);if(left===0)next.push(target);}}frontier=[...new Set(next)].sort();}
  if(visited!==nodes.size)throw new PlatformError('INVALID','AI pipeline contains a cycle');
  return { pipeline, digest:createHash('sha256').update(canonical(pipeline)).digest('hex'), stages,
    requiredCapabilities:[...new Set(pipeline.nodes.map(n=>n.capability).filter((v):v is string=>!!v))].sort(),
    requiredPermissions:[...new Set(pipeline.nodes.map(n=>n.permission).filter((v):v is string=>!!v))].sort() };
}

export interface ModelCandidate { id:string; capabilities:string[]; placement:'cloud'|'edge'; available:boolean; priority:number }
export function chooseModel(capability:string, placement:'cloud'|'edge'|'either', candidates:readonly ModelCandidate[]):ModelCandidate {
  const matched=candidates.filter(c=>c.available&&c.capabilities.includes(capability)&&(placement==='either'||c.placement===placement)).sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  if(!matched[0])throw new PlatformError('UNAVAILABLE',`No model provides ${capability} at ${placement}`);
  return matched[0];
}

/** Opaque, already-authorized bounded evidence passed across the neutral provider seam. */
export interface EvidenceChunk { id: string; text: string }
export interface EvidenceAnswerInput { question: string; evidence: readonly EvidenceChunk[] }
export interface EvidenceAnswerSelection { evidenceIds: readonly string[] }
export type EvidenceProvider = (input: EvidenceAnswerInput, options: ProviderCallOptions) => Promise<EvidenceAnswerSelection>;
export interface GeneratedAnswerSegment { text: string; evidenceIds: readonly string[] }
export interface GeneratedEvidenceAnswer { segments: readonly GeneratedAnswerSegment[] }
export interface ModelAnswerIdentity { adapter: 'ollama'; model: 'qwen3:4b'; label: 'Ollama · qwen3:4b' }
/** A fixed, server-created capability. Business requests never select its endpoint or model. */
export interface ModelAnswerCapability {
  readonly contract: 'quadbridge.model-answer.v1';
  readonly profile: 'local-ollama-qwen3-4b';
  readonly identity: ModelAnswerIdentity;
  readonly answer: GeneratedEvidenceProvider;
}
export type GeneratedEvidenceProvider = (input: EvidenceAnswerInput, options: ProviderCallOptions) => Promise<GeneratedEvidenceAnswer>;
export function lexicalTerms(question: string): string[] {
  const stop = new Set(['a','an','and','are','as','at','be','been','being','by','can','could','did','do','does','for','from','had','has','have','how','i','in','is','it','may','might','of','on','or','should','the','to','was','were','what','when','where','which','who','why','will','with','would']);
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter(term => !stop.has(term)).slice(0, 32);
}
export interface ProviderCallOptions { signal: AbortSignal }
/** Bounds actual provider promises; cancellation returns promptly but keeps its slot until settlement. */
export class BoundedProviderExecutor {
  private active = 0;
  readonly maxInFlight: number;
  readonly defaultTimeoutMs: number;
  constructor(readonly profile: 'extractive' | 'local-inference' = 'extractive') {
    if (profile !== 'extractive' && profile !== 'local-inference') throw new PlatformError('INVALID', 'Invalid bounded provider profile');
    this.maxInFlight = profile === 'extractive' ? 4 : 1;
    this.defaultTimeoutMs = profile === 'extractive' ? 5000 : 60000;
  }
  get inFlight(): number { return this.active; }
  async run<T>(provider: (options: ProviderCallOptions) => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.active >= this.maxInFlight) throw new PlatformError('EXHAUSTED', 'Provider concurrency limit reached');
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.defaultTimeoutMs) throw new PlatformError('INVALID', 'Provider timeout exceeds local bound');
    if (options.signal?.aborted) throw new PlatformError('UNAVAILABLE', 'Provider request cancelled');
    this.active++;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(new PlatformError('UNAVAILABLE', 'Provider request cancelled')); };
    const onCallerAbort = () => abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    timeout = setTimeout(() => { controller.abort(); rejectAbort(new PlatformError('UNAVAILABLE', 'Provider deadline exceeded')); }, timeoutMs);
    const actual = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Provider request cancelled');
      return provider({ signal: controller.signal });
    });
    void actual.finally(() => {
      this.active--;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }).catch(() => {});
    try { return await Promise.race([actual, interrupted]); }
    finally {
      if (!controller.signal.aborted) { if (timeout) clearTimeout(timeout); options.signal?.removeEventListener('abort', onCallerAbort); }
    }
  }
}
