import { randomUUID } from 'node:crypto';
import { PlatformError, type Actor, type CompositionPlan, type Mode, type ModuleManifest, type RequestContext, type RouteDefinition } from '@quadbridge/contracts';
export interface AccessPort {
    assertModule(actor: Actor, tenant: string, module: string, permission: string, kind: 'read' | 'write'): void;
    permissions(actor: Actor, tenant: string): string[];
    tenants(actor: Actor): string[];
    mode(tenant: string, module: string): Mode;
}
export interface ModuleEnvironment {
    manifest: ModuleManifest;
    dataPath: string;
    /** Only the selected, explicitly bound ports required by this module. */
    bindings: Readonly<Record<string, unknown>>;
}
export interface HostedModule {
    manifest: ModuleManifest;
    routes: RouteDefinition[];
    services: Readonly<Record<string, unknown>>;
    start?(): Promise<void>;
    close(): void | Promise<void>;
}
/** This host only knows module contribution/lifecycle contracts. It imports no domain implementations. */
export class ApplicationHost {
    private readonly routes = new Map<string, {
        module: HostedModule;
        route: RouteDefinition;
    }>();
    private started: HostedModule[] = [];
    private state: 'CREATED' | 'READY' | 'DRAINING' | 'STOPPED' = 'CREATED';
    constructor(readonly plan: CompositionPlan, readonly instanceId: string, readonly modules: HostedModule[], readonly access: AccessPort) {
        if (modules.length !== plan.modules.length)
            throw new PlatformError('INCOMPATIBLE', 'Composition and installed module count differ');
        for (const m of modules) {
            const declared = plan.modules.find(d => d.id === m.manifest.id);
            if (!declared || declared.version !== m.manifest.version)
                throw new PlatformError('INCOMPATIBLE', 'Unselected module registration');
            for (const r of m.routes) {
                const contract = declared.routes.find(d => d.method === r.method && d.path === r.path);
                if (!contract || contract.kind !== r.kind || contract.permission !== r.permission)
                    throw new PlatformError('INCOMPATIBLE', 'Route implementation differs from manifest');
                const key = `${r.method} ${r.path}`;
                if (this.routes.has(key))
                    throw new PlatformError('INCOMPATIBLE', 'Duplicate route');
                this.routes.set(key, { module: m, route: r });
            }
            if (m.routes.length !== declared.routes.length)
                throw new PlatformError('INCOMPATIBLE', 'Declared route lacks implementation');
            if (Object.keys(m.services).some(c => !declared.provides.includes(c)) || declared.provides.some(c => !(c in m.services)))
                throw new PlatformError('INCOMPATIBLE', 'Provider registration differs from manifest');
        }
    }
    async start() {
        try {
            for (const def of this.plan.modules) {
                const m = this.modules.find(m => m.manifest.id === def.id)!;
                this.started.push(m);
                await m.start?.();
            }
            this.state = 'READY';
        }
        catch (e) {
            await this.stop();
            throw e;
        }
    }
    async stop() {
        if (this.state === 'STOPPED')
            return;
        this.state = 'DRAINING';
        let first: unknown;
        for (const m of [...this.started].reverse()) {
            try {
                await m.close();
            }
            catch (e) {
                first ??= e;
            }
        }
        this.started = [];
        this.state = 'STOPPED';
        if (first)
            throw first;
    }
    health() { return { api: this.state, background: this.plan.requiresWorker ? 'SEPARATE_WORKER_REQUIRED' : 'NOT_REQUIRED' }; }
    context(actor: Actor, tenantId: string, moduleId: string, signal: AbortSignal, requestId: string = randomUUID(), assertOriginalAuth?: () => void): RequestContext {
        if (!this.plan.modules.some(m => m.id === moduleId))
            throw new PlatformError('NOT_FOUND', 'Module is not selected');
        const principal = Object.freeze({ ...actor });
        return Object.freeze({ productId: this.plan.product.id, instanceId: this.instanceId, tenantId, actor: principal, requestId, signal,
            assertOriginalAuth,
            assertAllowed: (permission: string, kind: 'read' | 'write') => { assertOriginalAuth?.(); if (signal.aborted) throw new PlatformError('UNAVAILABLE', 'Request cancelled'); this.access.assertModule(principal, tenantId, moduleId, permission, kind); } });
    }
    async execute(method: string, path: string, actor: Actor, tenantId: string, input: unknown, params = new URLSearchParams(), commandId?: string, signal = new AbortController().signal, requestId: string = randomUUID(), assertOriginalAuth?: () => void): Promise<unknown> {
        if (this.state !== 'READY')
            throw new PlatformError('UNAVAILABLE', 'Application is not accepting requests');
        const found = this.routes.get(`${method} ${path}`);
        if (!found)
            throw new PlatformError('NOT_FOUND', 'Operation not found');
        const ctx = this.context(actor, tenantId, found.module.manifest.id, signal, requestId, assertOriginalAuth);
        ctx.assertAllowed(found.route.permission, found.route.kind);
        try {
            const result = await found.route.handle(ctx, input, params, commandId);
            ctx.assertAllowed(found.route.permission, found.route.kind);
            return result;
        }
        catch (error) {
            // A revoked original HTTP session takes priority over a delayed handler error.
            assertOriginalAuth?.();
            throw error;
        }
    }
    bootstrap(actor: Actor, requestedTenant?: string) {
        const tenants = this.access.tenants(actor);
        const tenantId = requestedTenant ?? tenants[0];
        if (!tenantId || !tenants.includes(tenantId))
            throw new PlatformError('DENIED', 'No access to selected tenant');
        const grants = this.access.permissions(actor, tenantId);
        const modules = this.plan.modules.filter(m => this.access.mode(tenantId, m.id) !== 'off');
        const disallowed = new Set(this.plan.modules.flatMap(m => m.routes.filter(r => this.access.mode(tenantId, m.id) === 'off' || (this.access.mode(tenantId, m.id) === 'read-only' && r.kind === 'write')).map(r => r.permission)));
        const permissions = grants.filter(p => !disallowed.has(p));
        return { scope: { productId: this.plan.product.id, instanceId: this.instanceId, tenantId }, actor, tenants, permissions,
            product: { id: this.plan.product.id, title: this.plan.product.title, description: this.plan.product.description, layout: this.plan.product.layout, version: this.plan.product.version },
            modules: modules.map(m => ({ id: m.id, version: m.version, mode: this.access.mode(tenantId, m.id) })),
            workspaces: modules.flatMap(m => m.workspaces.filter(w => permissions.includes(w.permission)).map(w => ({ ...w, moduleId: m.id }))),
            operations: modules.flatMap(m => m.routes.map(r => ({ ...r, moduleId: m.id }))),
            abi: this.plan.product.platformAbi };
    }
}
