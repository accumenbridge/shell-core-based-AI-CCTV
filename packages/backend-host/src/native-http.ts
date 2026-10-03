import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, PlatformError, id, object, text, type Actor } from '@quadbridge/contracts';
import { trustedCommandErrorDetails } from '@quadbridge/contracts/ui-state';
import type { ApplicationHost } from './index.js';
import type { HttpAccess } from './http.js';

const PREFIX = '/native-api';
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const ORIGINS = new Set(['http://localhost', 'https://localhost', 'capacitor://localhost']);
const STATUS: Record<string, number> = { INVALID:400, UNAUTHENTICATED:401, DENIED:403, DISABLED:409, NOT_FOUND:404, CONFLICT:409, STALE_ATTEMPT:409, UNAVAILABLE:503, INCOMPATIBLE:409, EXHAUSTED:429 };

export interface NativeHttpOptions {
  host: ApplicationHost;
  access: HttpAccess;
  port: number;
}

async function body(req: import('node:http').IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new PlatformError('INVALID', 'application/json required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 131072) throw new PlatformError('INVALID', 'Request body too large');
    chunks.push(Buffer.from(part));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PlatformError('INVALID', 'Malformed JSON'); }
}

function json(res: import('node:http').ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function serializedError(error: PlatformError, requestId: string) {
  const body: Record<string, unknown> = { code: error.code, message: error.message, requestId };
  if (['INVALID', 'CONFLICT', 'NOT_FOUND'].includes(error.code)) {
    const details = trustedCommandErrorDetails(error);
    if (details) {
      body.commandOutcome = details.commandOutcome;
      if (details.fieldErrors.length) body.fieldErrors = details.fieldErrors;
    }
  }
  return { error: body };
}

/** Separate loopback adapter for the fixed packaged native client. Web cookies and CORS remain in http.ts. */
export async function listenNative(options: NativeHttpOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new PlatformError('INVALID', 'Invalid native API port');
  let port = options.port;
  const attempts = new Map<string, { count: number; until: number }>();
  const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    const requestId = randomUUID(), controller = new AbortController();
    let recheck: (() => void) | undefined;
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    try {
      const hostHeader = req.headers.host ?? '';
      if (![`${'127.0.0.1'}:${port}`, `localhost:${port}`].includes(hostHeader)) throw new PlatformError('DENIED', 'Unexpected native API host');
      if ((req.url?.length ?? 0) > 4096) throw new PlatformError('INVALID', 'URL too long');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== 'string' || !ORIGINS.has(origin)) throw new PlatformError('DENIED', 'Unexpected native app origin');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-QB-Tenant');
      }
      const url = new URL(req.url ?? '/', `http://${hostHeader}`);
      if (!url.pathname.startsWith(`${PREFIX}/`) || url.hash) throw new PlatformError('NOT_FOUND', 'Native route not found');
      if (req.method === 'OPTIONS') {
        if (!origin) throw new PlatformError('DENIED', 'Native preflight origin required');
        const method = req.headers['access-control-request-method'];
        if (method !== 'GET' && method !== 'POST') throw new PlatformError('DENIED', 'Native method is not allowed');
        const headers = (req.headers['access-control-request-headers'] ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (headers.some(value => !['authorization', 'content-type', 'idempotency-key', 'x-qb-tenant'].includes(value))) throw new PlatformError('DENIED', 'Native request header is not allowed');
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'POST') throw new PlatformError('NOT_FOUND', 'Unsupported native method');
      if (req.method === 'POST' && (!origin || !ORIGINS.has(origin))) throw new PlatformError('DENIED', 'Native app origin required');
      const nativePath = url.pathname.slice(PREFIX.length);
      if (req.method === 'POST' && nativePath === '/session') {
        const peer = req.socket.remoteAddress ?? 'loopback', now = Date.now();
        let bucket = attempts.get(peer);
        if (!bucket || bucket.until < now) { bucket = { count: 0, until: now + 60000 }; attempts.set(peer, bucket); }
        if (++bucket.count > 10) throw new PlatformError('EXHAUSTED', 'Sign-in rate limit; try again later');
        const input = object(await body(req), ['username', 'password']);
        const login = options.access.login(text(input.username, 'username', 128), text(input.password, 'password', 1024));
        json(res, 200, { token: login.token, actor: login.actor });
        return;
      }
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('QBUserSession ')) throw new PlatformError('UNAUTHENTICATED', 'Native user session required');
      const token = authorization.slice('QBUserSession '.length);
      if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new PlatformError('UNAUTHENTICATED', 'Native user session required');
      const actor = options.access.authenticate(token, undefined);
      const original = Object.freeze({ id: actor.id, kind: actor.kind });
      recheck = () => {
        if (controller.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Request cancelled');
        const current = options.access.authenticate(token, undefined);
        if (current.id !== original.id || current.kind !== original.kind) throw new PlatformError('UNAUTHENTICATED', 'Original native session changed');
      };
      if (req.method === 'POST' && nativePath === '/logout') {
        recheck();
        options.access.logout(token);
        json(res, 200, { signedOut: true });
        return;
      }
      const tenantHeader = req.headers['x-qb-tenant'];
      const tenant = typeof tenantHeader === 'string' ? id(tenantHeader) : undefined;
      if (req.method === 'GET' && nativePath === '/bootstrap') {
        recheck();
        const plan = options.host.plan;
        json(res, 200, {
          ...options.host.bootstrap(actor, tenant),
          nativeIdentity: {
            productId: plan.product.id,
            productVersion: plan.product.version,
            instanceId: options.host.instanceId,
            planDigest: digest(plan),
            modules: plan.modules.map(module => ({ id: module.id, version: module.version }))
          }
        });
        return;
      }
      if (!nativePath.startsWith('/api/') || nativePath.length > 2048) throw new PlatformError('NOT_FOUND', 'Native route not found');
      if (!tenant) throw new PlatformError('INVALID', 'X-QB-Tenant is required');
      const commandId = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      const input = req.method === 'POST' ? await body(req) : undefined;
      recheck();
      const result = await options.host.execute(req.method, nativePath, actor, tenant, input, url.searchParams, commandId, controller.signal, requestId, recheck);
      recheck();
      json(res, 200, result);
    } catch (error) {
      let effective = error;
      try { recheck?.(); } catch (authError) { effective = authError; }
      const e = effective instanceof PlatformError ? effective : new PlatformError('UNAVAILABLE', 'Native operation could not be completed');
      if (!res.headersSent) json(res, STATUS[e.code] ?? 500, serializedError(e, requestId));
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
