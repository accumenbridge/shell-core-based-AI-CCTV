import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PlatformError, object, text, id, type Actor, type Mode } from '@quadbridge/contracts';
import { ApplicationHost } from './index.js';
export interface HttpAccess {
    login(name: string, password: string): {
        token: string;
        actor: Actor;
    };
    authenticate(session?: string, bearer?: string): Actor;
    logout(token: string): void;
    setMode(actor: Actor, tenant: string, module: string, mode: Mode): void;
}
export interface Asset {
    bytes: Uint8Array | string;
    type: string;
}
export interface HttpOptions {
    host: ApplicationHost;
    access: HttpAccess;
    port: number;
    hostName?: '127.0.0.1';
    asset(path: string): Asset | undefined;
    index(nonce: string): string;
    log?: (event: Record<string, unknown>) => void;
}
const status: Record<string, number> = { INVALID: 400, UNAUTHENTICATED: 401, DENIED: 403, DISABLED: 409, NOT_FOUND: 404, CONFLICT: 409, UNAVAILABLE: 503, INCOMPATIBLE: 409, EXHAUSTED: 429 };
async function jsonBody(req: IncomingMessage): Promise<unknown> {
    if (!req.headers['content-type']?.split(';')[0]?.includes('application/json'))
        throw new PlatformError('INVALID', 'application/json required');
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of req) {
        bytes += part.length;
        if (bytes > 131072)
            throw new PlatformError('INVALID', 'Request body too large');
        parts.push(Buffer.from(part));
    }
    try {
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
    catch {
        throw new PlatformError('INVALID', 'Malformed JSON');
    }
}
function respond(res: ServerResponse, code: number, value: unknown) { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
/** Thin adapter over Node's HTTP server. Local developer profile only; not a production identity gateway. */
export async function listen(options: HttpOptions): Promise<{
    server: Server;
    url: string;
    close: () => Promise<void>;
}> {
    if (process.env.NODE_ENV === 'production')
        throw new PlatformError('INCOMPATIBLE', 'Local profile refuses production startup. Supply a reviewed production host/access adapter.');
    const { host, access } = options;
    let actualPort = options.port;
    const cookie = `qb_${host.instanceId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const attempts = new Map<string, {
        n: number;
        until: number;
    }>();
    const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
        const requestId = randomUUID(), started = Date.now();
        res.setHeader('X-Request-Id', requestId);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        const controller = new AbortController();
        let recheckOriginalAuth: (() => void) | undefined;
        req.on('aborted', () => controller.abort());
        res.on('close', () => {
            if (!res.writableEnded)
                controller.abort();
        });
        try {
            const hostname = req.headers.host ?? '';
            if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(hostname))
                throw new PlatformError('DENIED', 'Unexpected host');
            if ((req.url?.length ?? 0) > 4096)
                throw new PlatformError('INVALID', 'URL too long');
            const origin = `http://${hostname}`;
            const url = new URL(req.url ?? '/', origin);
            const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
            if (req.method !== 'GET' && req.method !== 'POST')
                throw new PlatformError('NOT_FOUND', 'Unsupported method');
            if (req.method === 'POST' && !bearer && req.headers.origin !== origin)
                throw new PlatformError('DENIED', 'Same-origin mutation required');
            const cookies = (req.headers.cookie ?? '').split(';').map(x => x.trim().split('='));
            const token = cookies.find(([k]) => k === cookie)?.[1];
            if (req.method === 'GET' && url.pathname === '/') {
                const nonce = randomBytes(18).toString('base64url');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'`);
                res.end(options.index(nonce));
                return;
            }
            if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
                const asset = options.asset(url.pathname);
                if (!asset)
                    throw new PlatformError('NOT_FOUND', 'Asset not in selected composition');
                res.setHeader('Content-Type', asset.type);
                if (asset.type === 'image/svg+xml')
                    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
                res.end(asset.bytes);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/health') {
                respond(res, 200, host.health());
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/session') {
                const ip = req.socket.remoteAddress ?? 'local', now = Date.now();
                let bucket = attempts.get(ip);
                if (!bucket || bucket.until < now) {
                    bucket = { n: 0, until: now + 60000 };
                    if (attempts.size > 1000)
                        attempts.clear();
                    attempts.set(ip, bucket);
                }
                if (++bucket.n > 10)
                    throw new PlatformError('EXHAUSTED', 'Sign-in rate limit; try again later');
                const body = object(await jsonBody(req), ['username', 'password']);
                const login = access.login(text(body.username, 'username', 128), text(body.password, 'password', 1024));
                if (token)
                    access.logout(token);
                res.setHeader('Set-Cookie', `${cookie}=${login.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
                respond(res, 200, { actor: login.actor });
                return;
            }
            const actor = access.authenticate(token, bearer);
            const originalActor = Object.freeze({ id: actor.id, kind: actor.kind });
            recheckOriginalAuth = () => {
                if (controller.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Request cancelled');
                const current = access.authenticate(token, bearer);
                if (current.id !== originalActor.id || current.kind !== originalActor.kind)
                    throw new PlatformError('UNAUTHENTICATED', 'Original request session changed');
            };
            // An explicit cross-product binding must match before any target operation runs.
            const expectedInstance = req.headers['x-qb-destination-instance'];
            const expectedProduct = req.headers['x-qb-destination-product'];
            const expectedPrincipal = req.headers['x-qb-destination-principal'];
            if ((expectedInstance !== undefined && expectedInstance !== host.instanceId) || (expectedProduct !== undefined && expectedProduct !== host.plan.product.id) || (expectedPrincipal !== undefined && (expectedPrincipal !== actor.id || actor.kind !== 'service')))
                throw new PlatformError('INCOMPATIBLE', 'Destination identity differs from the binding');
            if (req.method === 'POST' && url.pathname === '/api/logout') {
                if (token)
                    access.logout(token);
                res.setHeader('Set-Cookie', `${cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
                respond(res, 200, { signedOut: true });
                return;
            }
            const tenantHeader = req.headers['x-qb-tenant'];
            const tenant = typeof tenantHeader === 'string' ? id(tenantHeader) : undefined;
            if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
                respond(res, 200, host.bootstrap(actor, tenant));
                return;
            }
            if (!tenant)
                throw new PlatformError('INVALID', 'X-QB-Tenant is a selector and is required');
            if (req.method === 'POST' && url.pathname === '/api/modules/mode') {
                const body = object(await jsonBody(req), ['moduleId', 'mode']);
                recheckOriginalAuth();
                const moduleId = id(body.moduleId);
                const mode = body.mode as Mode;
                if (!host.plan.modules.some(m => m.id === moduleId) || !['enabled', 'read-only', 'off'].includes(mode))
                    throw new PlatformError('INVALID', 'Invalid module state');
                access.setMode(actor, tenant, moduleId, mode);
                respond(res, 200, { moduleId, mode });
                return;
            }
            const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
            const input = req.method === 'POST' ? await jsonBody(req) : undefined;
            recheckOriginalAuth();
            const result = await host.execute(req.method!, url.pathname, actor, tenant, input, url.searchParams, key, controller.signal, requestId, recheckOriginalAuth);
            recheckOriginalAuth();
            respond(res, 200, result);
        }
        catch (error) {
            let effective = error;
            try { recheckOriginalAuth?.(); } catch (authError) { effective = authError; }
            const e = effective instanceof PlatformError ? effective : new PlatformError('UNAVAILABLE', 'Operation could not be completed');
            if (!res.headersSent)
                respond(res, status[e.code] ?? 500, { error: { code: e.code, message: e.message, requestId } });
            else
                res.end();
        }
        finally {
            options.log?.({ kind: 'http', requestId, method: req.method, status: res.statusCode, durationMs: Date.now() - started });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.hostName ?? '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    actualPort = (server.address() as {
        port: number;
    }).port;
    return { server, url: `http://127.0.0.1:${actualPort}`, close: () => new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); }) };
}
