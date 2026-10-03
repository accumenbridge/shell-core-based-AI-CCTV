import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApplicationHost, type HostedModule, type ModuleEnvironment } from '@quadbridge/backend-host';
import { listen } from '@quadbridge/backend-host/http';
import { LocalAccess, type PrincipalSeed } from '@quadbridge/local-access';
import { PlatformError, canonical, type CompositionPlan, type ModuleManifest, type BoundCommand, type RequestContext } from '@quadbridge/contracts';
import { resolve as resolveProduct } from '@quadbridge/composition';
import type { JobExecutionStore, Job } from '@quadbridge/contracts';
import type { JobHandler } from '@quadbridge/contracts';
import type { WorkerHost } from '@quadbridge/worker-host';
import type { ModelAnswerCapability } from '@quadbridge/ai-core';
import { createOllamaQwen3Provider, OLLAMA_QWEN3_IDENTITY } from '@quadbridge/ai-core/ollama';
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export interface RuntimeConfig {
    instanceId: string;
    dataDirectory: string;
    principals: PrincipalSeed[];
    /** Explicit private developer opt-in. The endpoint and model remain fixed in the reviewed adapter. */
    modelAnswerProfile?: 'local-ollama-qwen3-4b';
    /** Captured only during explicit first enrollment; restarts consume the stored value. */
    nativeApiProfile?: 'local-native-forwarded-v1';
    connections?: Record<string, {
        revision: string;
        mode: 'local' | 'http';
        destinationProduct: string;
        destinationInstance: string;
        tenantMap: Record<string, string>;
        baseUrl?: string;
        serviceToken?: string;
        serviceActor: string;
    }>;
}
/** Existing runtime entry point; its startup, worker, HTTP, and close behavior remains unchanged. */
export async function createRuntime(productId: string, config: RuntimeConfig, root = ROOT, options: { initializationOnly?: boolean } = {}) {
    return constructRuntime(productId,config,root,options.initializationOnly === true);
}

/** Fixed v1 migration entry point. It never starts normal startup hooks or exposes runtime operations. */
export async function initializeRuntime(productId: string, config: RuntimeConfig, root = ROOT) {
    return constructRuntime(productId,config,root,true);
}

interface ExecutableModule extends HostedModule {
    queue?: JobExecutionStore;
    handlers?: JobHandler[];
}
interface CatalogItem {
    manifest: ModuleManifest;
    load: () => Promise<{
        register: (env: ModuleEnvironment) => ExecutableModule;
    }>;
}
async function constructRuntime(productId: string, config: RuntimeConfig, root: string, initializationOnly: boolean) {
    if (process.env.NODE_ENV === 'production')
        throw new PlatformError('INCOMPATIBLE', 'This release implements the local developer profile, not a production deployment profile');
    if (!/^[a-z][a-z0-9-]*$/.test(productId) || !/^[a-z][a-z0-9-]*$/.test(config.instanceId))
        throw new PlatformError('INVALID', 'Invalid product/instance');
    if (config.modelAnswerProfile !== undefined && config.modelAnswerProfile !== 'local-ollama-qwen3-4b')
        throw new PlatformError('INVALID', 'Unsupported local model answer profile');
    if (config.nativeApiProfile !== undefined && config.nativeApiProfile !== 'local-native-forwarded-v1')
        throw new PlatformError('INVALID', 'Unsupported local native API profile');
    if (initializationOnly && (!Array.isArray(config.principals) || config.principals.length !== 0))
        throw new PlatformError('INVALID', 'Initialization-only runtime construction cannot seed principals');
    const release = JSON.parse(readFileSync(join(root, '.artifacts', productId, 'release.json'), 'utf8')) as {
        planDigest: string;
        backend: Record<string, string>;
        web: Record<string, string>;
    };
    const verifyFiles = (files: Record<string, string>) => {
        for (const [file, digest] of Object.entries(files)) {
            const full = pathResolve(root, file);
            if (relative(pathResolve(root), full).startsWith('..') || isAbsolute(relative(pathResolve(root), full)))
                throw new PlatformError('INCOMPATIBLE', 'Unsafe artifact path');
            if (createHash('sha256').update(readFileSync(full)).digest('hex') !== digest)
                throw new PlatformError('INCOMPATIBLE', `Artifact drift: ${file}`);
        }
    };
    verifyFiles(release.backend);
    const catalogPath = join(root, '.artifacts', productId, 'backend-catalog.mjs');
    if (!existsSync(catalogPath))
        throw new PlatformError('INCOMPATIBLE', 'Run the product build first');
    const catalog = (await import(pathToFileURL(catalogPath).href)).catalog as CatalogItem[];
    const product = JSON.parse(readFileSync(join(root, 'products', productId, 'product.json'), 'utf8'));
    const plan = resolveProduct(product, catalog.map(c => c.manifest));
    if (createHash('sha256').update(canonical(plan)).digest('hex') !== release.planDigest)
        throw new PlatformError('INCOMPATIBLE', 'Composition differs from its built release');
    const wiringLoader = (await import(pathToFileURL(join(root, '.artifacts', productId, 'solution.mjs')).href)).load;
    const wiring = wiringLoader ? await wiringLoader() : undefined;
    if (plan.product.wiring && !wiring)
        throw new PlatformError('INCOMPATIBLE', 'Solution is not in this release');
    const access = new LocalAccess(join(config.dataDirectory, 'access.sqlite'), { productId, instanceId: config.instanceId }, Date.now, config.principals);
    const modelAnswer: ModelAnswerCapability | undefined = !initializationOnly && config.modelAnswerProfile === 'local-ollama-qwen3-4b'
        ? Object.freeze({ contract: 'quadbridge.model-answer.v1', profile: 'local-ollama-qwen3-4b',
            identity: OLLAMA_QWEN3_IDENTITY, answer: createOllamaQwen3Provider() })
        : undefined;
    const modules: ExecutableModule[] = [];
    let host: ApplicationHost;
    const publicService = (contract: string, implementation: string) => {
        const provider = modules.find(m => m.manifest.id === implementation && contract in m.services);
        if (!provider)
            throw new PlatformError('INCOMPATIBLE', 'Local public provider not constructed');
        return provider.services[contract];
    };
    try {
        for (const manifest of plan.modules) {
            const bindings: Record<string, unknown> = {};
            for (const binding of plan.bindings.filter(b => b.consumer === manifest.id)) {
                if (!wiring)
                    throw new PlatformError('INCOMPATIBLE', 'Required solution wiring not selected');
                bindings[binding.contract] = await wiring.bind({ binding, config, productId, publicService, context: (...args: Parameters<ApplicationHost['context']>) => host.context(...args) });
            }
            const definition = catalog.find(c => c.manifest.id === manifest.id)!;
            const executable = await definition.load();
            modules.push(executable.register({ manifest, dataPath: join(config.dataDirectory, 'modules', `${manifest.id}.sqlite`), bindings: Object.freeze(bindings), modelAnswer }));
        }
        host = new ApplicationHost(plan, config.instanceId, modules, access);
        if (!initializationOnly)
            await host.start();
    }
    catch (e) {
        const closeErrors: unknown[] = [];
        for (const m of [...modules].reverse())
            try {
                await m.close();
            } catch (error) { closeErrors.push(error); }
        try { access.close(); } catch (error) { closeErrors.push(error); }
        if (initializationOnly && closeErrors.length)
            throw new AggregateError([e, ...closeErrors], 'Initialization-only runtime construction failed and owner cleanup was incomplete');
        throw e;
    }
    async function worker(): Promise<WorkerHost> {
        if (initializationOnly)
            throw new PlatformError('UNAVAILABLE', 'Initialization-only runtime cannot start a worker');
        const { WorkerHost } = await import('@quadbridge/worker-host');
        return new WorkerHost(modules.filter(m => m.queue && m.handlers).map(m => ({ moduleId: m.manifest.id, queue: m.queue!, handlers: m.handlers!,
            enabled: (j: Job) => access.mode(j.tenant, m.manifest.id) === 'enabled', authorize: (j: Job) => access.assertModule({ id: j.actor_id, kind: j.actor_kind }, j.tenant, m.manifest.id, j.permission, 'write') })));
    }
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    async function http(port: number, options: { mobilePreview?: boolean } = {}) {
        if (initializationOnly)
            throw new PlatformError('UNAVAILABLE', 'Initialization-only runtime cannot expose HTTP');
        verifyFiles(release.web);
        const browserPlan = JSON.parse(readFileSync(join(root, '.artifacts', productId, 'web.json'), 'utf8')) as {
            imports: Record<string, string>;
            files: Record<string, string>;
            styles: string[];
            mobile?: { entry: string; styles: string[]; files: Record<string, string> };
        };
        if (options.mobilePreview && (!browserPlan.mobile || !browserPlan.files[browserPlan.mobile.entry] || browserPlan.mobile.styles.some(path => !browserPlan.files[path])))
            throw new PlatformError('INCOMPATIBLE', 'The selected build does not include the fixed mobile preview');
        return listen({ host, access, port,
            asset(path) {
                const filename = browserPlan.files[path];
                if (!filename)
                    return;
                const full = pathResolve(root, filename);
                if (relative(pathResolve(root), full).startsWith('..') || isAbsolute(relative(pathResolve(root), full)))
                    throw new PlatformError('DENIED', 'Asset outside release root');
                return { bytes: readFileSync(full), type: ({ css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', json: 'application/json', txt: 'text/plain; charset=utf-8', woff2: 'font/woff2' } as Record<string, string>)[path.split('.').at(-1)!] ?? 'application/octet-stream' };
            },
            index(nonce) {
                const styles = options.mobilePreview ? browserPlan.mobile!.styles : browserPlan.styles;
                const composition = options.mobilePreview ? browserPlan.mobile!.entry : '/assets/composition.js';
                const viewport = options.mobilePreview ? 'width=device-width,initial-scale=1,viewport-fit=cover' : 'width=device-width,initial-scale=1';
                return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="${viewport}"><title>${escape(plan.product.title)}</title>${styles.map(path => `<link rel="stylesheet" href="${escape(path)}">`).join('')}<script type="importmap" nonce="${nonce}">${JSON.stringify({ imports: browserPlan.imports }).replace(/</g, '\\u003c')}</script></head><body><div id="app"></div><script type="module" src="${composition}"></script></body></html>`;
            },
            log: event => {
                if (process.env.QB_LOG_REQUESTS === '1')
                    console.log(JSON.stringify(event));
            }
        });
    }
    const nativeListeners: { close: () => Promise<void> }[] = [];
    async function nativeHttp(port = 4350) {
        if (initializationOnly) throw new PlatformError('UNAVAILABLE', 'Initialization-only runtime cannot expose native HTTP');
        if (config.nativeApiProfile !== undefined && config.nativeApiProfile !== 'local-native-forwarded-v1')
            throw new PlatformError('UNAVAILABLE', 'This runtime contains an unsupported native API profile');
        const { listenNative } = await import('@quadbridge/backend-host/native-http');
        const listener = await listenNative({ host, access, port });
        nativeListeners.push(listener);
        return { url: listener.url };
    }
    return { plan, host, access, modules, worker, http, nativeHttp, async close() {
        if (!initializationOnly) {
            const failures: unknown[] = [];
            for (const listener of nativeListeners.splice(0).reverse()) try { await listener.close(); } catch (error) { failures.push(error); }
            try { await host.stop(); } catch (error) { failures.push(error); }
            try { access.close(); } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, 'Runtime and native API owners did not all close');
            return;
        }
        const failures: unknown[] = [];
        try { await host.stop(); } catch (error) { failures.push(error); }
        for (const module of [...modules].reverse()) try { await module.close(); } catch (error) { failures.push(error); }
        try { access.close(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Initialization-only runtime owner closure failed');
    } };
}
