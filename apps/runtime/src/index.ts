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
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export interface RuntimeConfig {
    instanceId: string;
    dataDirectory: string;
    principals: PrincipalSeed[];
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
export async function createRuntime(productId: string, config: RuntimeConfig, root = ROOT) {
    if (process.env.NODE_ENV === 'production')
        throw new PlatformError('INCOMPATIBLE', 'This release implements the local developer profile, not a production deployment profile');
    if (!/^[a-z][a-z0-9-]*$/.test(productId) || !/^[a-z][a-z0-9-]*$/.test(config.instanceId))
        throw new PlatformError('INVALID', 'Invalid product/instance');
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
    const access = new LocalAccess(join(config.dataDirectory, 'access.sqlite'), { productId, instanceId: config.instanceId });
    access.seed(config.principals);
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
            modules.push(executable.register({ manifest, dataPath: join(config.dataDirectory, 'modules', `${manifest.id}.sqlite`), bindings: Object.freeze(bindings) }));
        }
        host = new ApplicationHost(plan, config.instanceId, modules, access);
        await host.start();
    }
    catch (e) {
        for (const m of [...modules].reverse())
            try {
                await m.close();
            }
            catch { }
        access.close();
        throw e;
    }
    async function worker(): Promise<WorkerHost> {
        const { WorkerHost } = await import('@quadbridge/worker-host');
        return new WorkerHost(modules.filter(m => m.queue && m.handlers).map(m => ({ moduleId: m.manifest.id, queue: m.queue!, handlers: m.handlers!,
            enabled: (j: Job) => access.mode(j.tenant, m.manifest.id) === 'enabled', authorize: (j: Job) => access.assertModule({ id: j.actor_id, kind: j.actor_kind }, j.tenant, m.manifest.id, j.permission, 'write') })));
    }
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    async function http(port: number) {
        verifyFiles(release.web);
        const browserPlan = JSON.parse(readFileSync(join(root, '.artifacts', productId, 'web.json'), 'utf8')) as {
            imports: Record<string, string>;
            files: Record<string, string>;
            styles: string[];
        };
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
            index(nonce) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(plan.product.title)}</title>${browserPlan.styles.map(path => `<link rel="stylesheet" href="${escape(path)}">`).join('')}<script type="importmap" nonce="${nonce}">${JSON.stringify({ imports: browserPlan.imports }).replace(/</g, '\\u003c')}</script></head><body><div id="app"></div><script type="module" src="/assets/composition.js"></script></body></html>`; },
            log: event => {
                if (process.env.QB_LOG_REQUESTS === '1')
                    console.log(JSON.stringify(event));
            }
        });
    }
    return { plan, host, access, modules, worker, http, async close() { await host.stop(); access.close(); } };
}
