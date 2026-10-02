/** Product-definition drafting over reviewed catalogues. Browser and CLI use this same code.
 * This chooses declared wiring, never invents adapter implementations, grants or endpoints.
 */
import { PLATFORM_ABI, PlatformError, object, validSourceDirectoryId, type Binding, type CompositionPlan, type ModuleManifest, type ProductDefinition } from '@quadbridge/contracts';
import { resolve } from './index.js';

export interface StudioChoice { id: string; label: string; binding: Omit<Binding, 'consumer' | 'contract'>; prerequisites?: string[] }
export interface StudioSolution { id: string; studio?: { consumer: string; label: string; ports: { contract: string; choices: StudioChoice[] }[] } }
export interface StudioInput { id: string; title: string; selected: string[]; layout?: 'top' | 'sidebar'; choices?: Record<string, string>; version?: string }
export const STUDIO_PRODUCT_TEXT_LIMIT = 64 * 1024;
export interface StudioProductGraph {
    nodes: { id: string; version: string; external: boolean }[];
    edges: { from: string; to: string; kind: 'dependency' | 'binding'; label: string; mode?: string; scope?: string; instanceId?: string }[];
}
export interface StudioProductInspection {
    valid: boolean;
    diagnostics: string[];
    product?: ProductDefinition;
    plan?: CompositionPlan;
    graph?: StudioProductGraph;
}
const fail = (message: string): never => { throw new PlatformError('INCOMPATIBLE', message); };
export const validProductId = (value: unknown): value is string => validSourceDirectoryId(value);
export function composeDraft(input: StudioInput, catalog: readonly ModuleManifest[], solutions: readonly StudioSolution[], version = '0.2.0') {
    object(input, ['id', 'title', 'selected', 'layout', 'choices', 'version']);
    if (!validProductId(input.id)) fail('Use a product ID of 2–48 lowercase letters, digits or hyphens, starting with a letter.');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80) fail('Provide a product title of 1–80 characters.');
    if (!Array.isArray(input.selected) || input.selected.length > 100 || input.selected.some(id => typeof id !== 'string')) fail('Select a bounded module list.');
    if (input.layout !== undefined && !['top', 'sidebar'].includes(input.layout)) fail('Unsupported navigation layout.');
    if (input.choices !== undefined && (!input.choices || typeof input.choices !== 'object' || Array.isArray(input.choices))) fail('Binding choices must be an object.');
    if (!/^\d+\.\d+\.\d+$/.test(input.version ?? version)) fail('Use an exact product version.');
    const byId = new Map(catalog.map(m => [m.id, m]));
    if (byId.size !== catalog.length) fail('Duplicate module in catalogue.');
    const selected = new Set<string>(), queue: string[] = [], bindings: Binding[] = [], usedSolutions = new Set<string>();
    const explanation: { moduleId: string; reason: string; requested: boolean }[] = [];
    const requirements: { consumer: string; contract: string; choice: string; label: string; mode: string; prerequisites: string[] }[] = [];
    const consumedChoices = new Set<string>();
    function add(moduleId: string, reason: string, requested = false) {
        if (!byId.has(moduleId)) fail(`Module ${moduleId} is not registered in this catalogue.`);
        if (selected.has(moduleId)) return;
        selected.add(moduleId); queue.push(moduleId); explanation.push({ moduleId, reason, requested });
    }
    for (const moduleId of [...new Set(input.selected)].sort()) add(moduleId, 'Selected by you', true);
    while (queue.length) {
        const module = byId.get(queue.shift()!)!;
        for (const dep of module.dependencies) if (!dep.optional) {
            if (byId.get(dep.id)?.version !== dep.version) fail(`Missing compatible dependency ${dep.id}@${dep.version}.`);
            add(dep.id, `Required by ${module.id}`);
        }
        if (!module.requires.length) continue;
        const candidates = solutions.filter(s => s.studio?.consumer === module.id);
        if (candidates.length !== 1) fail(`Module ${module.id} needs one reviewed Studio wiring profile; found ${candidates.length}. No adapter was invented.`);
        const solution = candidates[0]!;
        usedSolutions.add(solution.id);
        for (const contract of module.requires) {
            const ports = solution.studio!.ports.filter(p => p.contract === contract);
            if (ports.length !== 1 || ports[0]!.choices.length === 0) fail(`No reviewed binding choice for ${module.id}:${contract}.`);
            const port = ports[0]!, key = `${module.id}:${contract}`;
            consumedChoices.add(key);
            const choice = port.choices.find(c => c.id === (input.choices?.[key] ?? port.choices[0]!.id));
            if (!choice) fail(`Unsupported binding choice for ${key}.`);
            const picked = choice!;
            if (picked.binding.mode === 'local') add(picked.binding.implementation, `Provider of ${contract} for ${module.id}`);
            bindings.push({ ...picked.binding, consumer: module.id, contract });
            requirements.push({ consumer: module.id, contract, choice: picked.id, label: picked.label, mode: picked.binding.mode, prerequisites: picked.prerequisites ?? [] });
        }
    }
    if (usedSolutions.size > 1) fail('This profile supports one reviewed solution wiring root per product. Provide a reviewed combined wiring before composing these modules.');
    for (const key of Object.keys(input.choices ?? {})) if (!consumedChoices.has(key)) fail(`Unused binding choice ${key}.`);
    const product: ProductDefinition = {
        id: input.id, title: input.title.trim(), description: 'Product-owned composition created by the Quadbridge Studio.',
        version: input.version ?? version, platformAbi: PLATFORM_ABI, layout: input.layout ?? 'sidebar',
        modules: [...selected].sort().map(id => ({ id, version: byId.get(id)!.version })), bindings,
        ...(usedSolutions.size ? { wiring: [...usedSolutions][0]! } : {})
    };
    const plan = resolve(product, catalog);
    return { product: plan.product, plan, explanation, requirements, status: 'VALIDATED_DEFINITION_NOT_RUNNING' as const };
}

/** Imported definitions must remain bounded data; trusted catalogues supply executable identities. */
export function validateProduct(value: unknown, catalog: readonly ModuleManifest[], solutions: readonly StudioSolution[]): ProductDefinition {
    const p = object(value, ['id', 'title', 'description', 'version', 'platformAbi', 'layout', 'modules', 'bindings', 'wiring']);
    if (!validProductId(p.id) || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 80 || typeof p.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(p.version) || p.platformAbi !== PLATFORM_ABI || !['top', 'sidebar'].includes(String(p.layout))) fail('Invalid product identity, version or layout.');
    if (typeof p.description !== 'string' || p.description.length > 2000 || p.description.includes('\0')) fail('Invalid product description.');
    if (!Array.isArray(p.modules) || p.modules.length > 100 || !Array.isArray(p.bindings) || p.bindings.length > 300) fail('Invalid module/binding list.');
    for (const m of p.modules as unknown[]) { const ref = object(m, ['id', 'version']); if (typeof ref.id !== 'string' || typeof ref.version !== 'string') fail('Invalid module reference.'); }
    const solution = solutions.find(s => s.id === p.wiring);
    if (p.wiring !== undefined && !solution) fail('Wiring is not in the reviewed solution catalogue.');
    for (const v of p.bindings as unknown[]) {
        const b = object(v, ['contract', 'instanceId', 'implementation', 'scope', 'consumer', 'mode']);
        if (Object.values(b).some(x => typeof x !== 'string') || !/^[a-z][a-z0-9-]{1,63}$/.test(String(b.instanceId))) fail('Invalid binding.');
        const port = solution?.studio?.ports.find(p => p.contract === b.contract);
        if (solution?.studio?.consumer !== b.consumer || !port?.choices.some(c => c.binding.mode === b.mode && c.binding.implementation === b.implementation && c.binding.scope === b.scope)) fail('Binding has no reviewed Studio adapter.');
    }
    return resolve(p as unknown as ProductDefinition, catalog).product;
}

function productGraph(plan: CompositionPlan): StudioProductGraph {
    const nodes = new Map<string, { id: string; version: string; external: boolean }>();
    for (const module of plan.modules) nodes.set(module.id, { id: module.id, version: module.version, external: false });
    const edges: StudioProductGraph['edges'] = [];
    for (const module of plan.modules) for (const dependency of module.dependencies) {
        if (plan.modules.some(candidate => candidate.id === dependency.id && candidate.version === dependency.version)) {
            edges.push({ from: module.id, to: dependency.id, kind: 'dependency', label: `requires ${dependency.id}@${dependency.version}` });
        }
    }
    for (const binding of plan.bindings) {
        if (!nodes.has(binding.implementation)) nodes.set(binding.implementation, { id: binding.implementation, version: 'reviewed external adapter', external: true });
        edges.push({ from: binding.consumer, to: binding.implementation, kind: 'binding', label: binding.contract,
            mode: binding.mode, scope: binding.scope, instanceId: binding.instanceId });
    }
    return { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
        edges: edges.sort((a, b) => `${a.from}:${a.kind}:${a.label}`.localeCompare(`${b.from}:${b.kind}:${b.label}`)) };
}

/** Inspect an untrusted complete definition without replacing the user's source text. */
export function inspectProductDefinition(value: unknown, catalog: readonly ModuleManifest[], solutions: readonly StudioSolution[]): StudioProductInspection {
    try {
        const product = validateProduct(value, catalog, solutions);
        const plan = resolve(product, catalog);
        return { valid: true, diagnostics: [], product: plan.product, plan, graph: productGraph(plan) };
    } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 240) : 'Product definition is unsupported.';
        return { valid: false, diagnostics: [message] };
    }
}

export function parseProductDefinition(source: unknown, catalog: readonly ModuleManifest[], solutions: readonly StudioSolution[]): StudioProductInspection {
    if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > STUDIO_PRODUCT_TEXT_LIMIT)
        return { valid: false, diagnostics: [`Product JSON must be at most ${STUDIO_PRODUCT_TEXT_LIMIT} UTF-8 bytes.`] };
    let value: unknown;
    try { value = JSON.parse(source) as unknown; }
    catch { return { valid: false, diagnostics: ['Product definition is not valid JSON.'] }; }
    return inspectProductDefinition(value, catalog, solutions);
}

/** Read-only composition preview; it never changes the submitted definition or source tree. */
export function previewProductDefinition(value: unknown, catalog: readonly ModuleManifest[], solutions: readonly StudioSolution[]) {
    const result = inspectProductDefinition(value, catalog, solutions);
    if (!result.valid || !result.product || !result.plan || !result.graph)
        throw new PlatformError('INCOMPATIBLE', result.diagnostics[0] ?? 'Product definition is unsupported.');
    return { product: result.product, plan: result.plan, graph: result.graph, status: 'VALIDATED_DEFINITION_NOT_RUNNING' as const };
}

export function serializeProductDefinition(value: unknown, catalog: readonly ModuleManifest[], solutions: readonly StudioSolution[]): string {
    return `${JSON.stringify(previewProductDefinition(value, catalog, solutions).product, null, 2)}\n`;
}
