import { PLATFORM_ABI, PlatformError, canonical, validateProductExperience, type Binding, type CompositionPlan, type ModuleManifest, type ProductDefinition } from '@quadbridge/contracts';
import { validateModuleManifest } from '@quadbridge/contracts/module-manifest';
import { validateOperationDescriptor } from '@quadbridge/contracts/operations';
import { validateUiContributionDescriptors } from '@quadbridge/contracts/ui-contributions';
const fail = (s: string): never => { throw new PlatformError('INCOMPATIBLE', s); };
const unique = (xs: string[], label: string) => {
    if (new Set(xs).size !== xs.length)
        fail(`Duplicate ${label}`);
};
/** Pure resolver. Exact version support is deliberate; it does not pretend to implement SemVer ranges. */
export function resolve(product: ProductDefinition, catalog: readonly ModuleManifest[]): CompositionPlan {
    if (product.platformAbi !== PLATFORM_ABI)
        fail('Unsupported platform ABI');
    const validatedCatalog = catalog.map(module => validateModuleManifest(module));
    unique(validatedCatalog.map(m => m.id), 'catalog module');
    unique(product.modules.map(m => m.id), 'selection');
    const all = new Map(validatedCatalog.map(m => [m.id, m]));
    const selected = new Map<string, ModuleManifest>();
    for (const ref of product.modules) {
        const m = all.get(ref.id);
        if (!m || m.version !== ref.version || m.abi !== PLATFORM_ABI)
            fail(`Unsupported module ${ref.id}@${ref.version}`);
        selected.set(ref.id, m!);
    }
    const ordered: ModuleManifest[] = [];
    const active = new Set<string>();
    const done = new Set<string>();
    function visit(key: string) {
        if (done.has(key))
            return;
        if (active.has(key))
            fail(`Dependency cycle: ${key}`);
        active.add(key);
        const m = selected.get(key)!;
        for (const dep of [...m.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
            const d = selected.get(dep.id);
            if (!d) {
                if (dep.optional)
                    continue;
                fail(`Missing dependency ${dep.id}`);
            }
            if (d!.version !== dep.version)
                fail(`Dependency version ${dep.id}`);
            visit(dep.id);
        }
        // An eager local port is a construction dependency even without a duplicate declaration.
        for (const binding of [...product.bindings].filter(b => b.consumer === key && b.mode === 'local').sort((a, b) => a.implementation.localeCompare(b.implementation))) {
            const provider = selected.get(binding.implementation);
            if (!provider || !provider.provides.includes(binding.contract))
                fail(`Missing local provider ${binding.contract}`);
            visit(binding.implementation);
        }
        active.delete(key);
        done.add(key);
        ordered.push(m);
    }
    for (const key of [...selected.keys()].sort())
        visit(key);
    unique(ordered.flatMap(m => m.routes.map(r => `${r.method} ${r.path}`)), 'route');
    const operationIds = new Set<string>();
    for (const module of ordered) for (const operation of module.operations ?? []) {
        const descriptor = validateOperationDescriptor(operation, module.id, module.permissions);
        const identity = `${descriptor.id}@${descriptor.version}`;
        if (operationIds.has(identity)) fail(`Duplicate operation ${identity}`);
        operationIds.add(identity);
    }
    unique(ordered.flatMap(m => m.workspaces.map(w => w.id)), 'workspace');
    unique(ordered.flatMap(m => m.workspaces.map(w => w.path)), 'workspace path');
    unique(ordered.flatMap(m => m.permissions), 'permission owner');
    for (const m of ordered) {
        validateUiContributionDescriptors(m);
        for (const r of m.routes) {
            if (['/api/session', '/api/logout', '/api/bootstrap', '/api/health', '/api/modules/mode'].includes(r.path))
                fail('Route collides with host-owned operation');
            if (!m.permissions.includes(r.permission) || !/^\/api\/[a-z0-9/-]+$/.test(r.path))
                fail(`Undeclared/unsafe route ${r.path}`);
        }
        for (const w of m.workspaces) {
            if (!m.permissions.includes(w.permission) || !/^\/[a-z0-9/-]+$/.test(w.path) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(w.export))
                fail(`Invalid workspace ${w.id}`);
        }
        if (m.schema.current < m.schema.readMin || m.schema.current > m.schema.readMax)
            fail(`Invalid reader envelope ${m.id}`);
    }
    unique(product.bindings.map(b => `${b.consumer}:${b.contract}`), 'consumer binding');
    const instances = new Map<string, string>();
    for (const b of product.bindings) {
        if (!['local', 'http'].includes(b.mode) || !['application', 'module', 'request'].includes(b.scope))
            fail('Unsupported binding mode or lifetime');
        if (!selected.has(b.consumer))
            fail(`Binding to absent consumer ${b.consumer}`);
        if (!selected.get(b.consumer)!.requires.includes(b.contract))
            fail(`Undeclared requirement ${b.contract}`);
        if (b.mode === 'local' && !ordered.some(m => m.id === b.implementation && m.provides.includes(b.contract)))
            fail(`Missing local provider ${b.contract}`);
        const shape = canonical({ implementation: b.implementation, contract: b.contract, scope: b.scope, mode: b.mode });
        const before = instances.get(b.instanceId);
        if (before && before !== shape)
            fail(`Inconsistent instance ${b.instanceId}`);
        instances.set(b.instanceId, shape);
    }
    for (const m of ordered)
        for (const c of m.requires)
            if (!product.bindings.some(b => b.consumer === m.id && b.contract === c))
                fail(`Unbound required port ${m.id}:${c}`);
    const experience = product.experience === undefined ? undefined : validateProductExperience(product.experience, {
        workspaceIds: ordered.flatMap(module => module.workspaces.map(workspace => workspace.id))
    });
    const normalizedProduct = { ...product, ...(experience ? { experience } : {}), modules: [...product.modules].sort((a, b) => a.id.localeCompare(b.id)), bindings: [...product.bindings].sort((a, b) => `${a.consumer}:${a.contract}`.localeCompare(`${b.consumer}:${b.contract}`)) };
    return { product: normalizedProduct, modules: ordered, bindings: [...product.bindings].sort((a, b) => `${a.consumer}:${a.contract}`.localeCompare(`${b.consumer}:${b.contract}`)), permissions: ordered.flatMap(m => m.permissions).sort(), requiresWorker: ordered.some(m => m.background) };
}
/** Instance lifetime is separate from business data scope. Factories receive no request in longer scopes. */
export class ScopedBindings {
    private app = new Map<string, unknown>();
    private modules = new Map<string, Map<string, unknown>>();
    private requests = new WeakMap<object, Map<string, unknown>>();
    constructor(private readonly factories: Readonly<Record<string, () => unknown>>) { }
    get(binding: Binding, request?: object): unknown {
        let cache: Map<string, unknown>;
        if (binding.scope === 'request') {
            if (!request)
                fail('Request scope required');
            cache = this.requests.get(request!) ?? new Map();
            this.requests.set(request!, cache);
        }
        else if (binding.scope === 'module') {
            cache = this.modules.get(binding.consumer) ?? new Map();
            this.modules.set(binding.consumer, cache);
        }
        else
            cache = this.app;
        if (!cache.has(binding.instanceId)) {
            const factory = this.factories[binding.implementation];
            if (!factory)
                fail(`Missing factory ${binding.implementation}`);
            cache.set(binding.instanceId, factory!());
        }
        return cache.get(binding.instanceId);
    }
}
export function assessRemoval(plan: CompositionPlan, moduleId: string, retainedRecords: number, pendingJobs: number) {
    const dependents = plan.modules.filter(m => m.dependencies.some(d => d.id === moduleId && !d.optional) || plan.bindings.some(b => b.consumer === m.id && b.mode === 'local' && b.implementation === moduleId)).map(m => m.id);
    return { allowed: !dependents.length && retainedRecords === 0 && pendingJobs === 0, dependents, retainedRecords, pendingJobs, action: retainedRecords > 0 ? 'KEEP_COMPATIBLE_READER_OR_APPROVE_MIGRATION' : 'REVIEW_NEW_COMPOSITION' };
}
