import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformError } from '@quadbridge/contracts';
import { ControlPlaneStore, type EnvironmentSpec } from '@quadbridge/control-plane';
import { type AiPipeline } from '@quadbridge/ai-core';
import { resolve } from '@quadbridge/composition';
import { composeDraft, inspectProductDefinition, validateProduct } from '@quadbridge/composition/studio';
import type { LocalBuildWorker } from './build-worker.js';
import { importSourceSnapshot, loadSourceSnapshot, storedOverview, type SourceSnapshot } from './source-import.js';
import { maintainedSourceFingerprint } from './source-import.js';
import { ArtifactStoreUnavailable, type LocalArtifactStore } from './artifact-store.js';
import { RuntimePreparationError, type ManagedRuntimeManager } from './runtime-manager.js';
import { RuntimeRecoveryError, type RuntimeRecoveryManager } from './runtime-recovery.js';

const COOKIE = 'qb_platform_session';
const BODY_LIMIT = 64 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PAIR_WINDOW_MS = 60 * 1000;
const MAX_PAIR_ATTEMPTS = 10;
const MAX_SESSIONS = 8;

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
type Session = { id: string; expiresAt: number };
type AuthenticatedSession = Session & { token: string };
type ServerOptions = {
  root: string;
  store: ControlPlaneStore;
  worker?: LocalBuildWorker;
  artifactStore?: LocalArtifactStore;
  runtimeManager?: ManagedRuntimeManager;
  recoveryManager?: RuntimeRecoveryManager;
  snapshot?: SourceSnapshot;
  port?: number;
  pairingCode?: string;
  now?: () => number;
  sessionTtlMs?: number;
  pairWindowMs?: number;
  maxPairAttempts?: number;
  onProtectedBodyRead?: () => void;
};
export interface OperatorServer {
  url: string;
  pairingCode: string;
  server: Server;
  close(): Promise<void>;
}

function responseHeaders(res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
function sendJson(res: ServerResponse, status: number, value: unknown) {
  responseHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function sendArtifactBytes(res:ServerResponse,bytes:Buffer,filename:string) {
  responseHeaders(res);
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('Content-Disposition',`attachment; filename="artifact.bin"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.writeHead(200);
  res.end(bytes);
}
function artifactDto(value:unknown,entries?:unknown[]) {
  if(!value||typeof value!=='object')throw new Error('Artifact metadata is malformed');
  const row=value as Record<string,unknown>;
  return {digest:row.digest,buildId:row.buildId,snapshotId:row.snapshotId,productId:row.productId,version:row.version,inputDigest:row.inputDigest,
    releaseDigest:row.releaseDigest,snapshotDigest:row.snapshotDigest,sizeBytes:row.sizeBytes,fileCount:row.fileCount,
    originatingActorId:row.originatingActorId,registeringActorId:row.registeringActorId,registeredAt:row.registeredAt,
    ...(entries?{entries}: {})};
}
function recoveryOperationDto(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Recovery metadata is malformed');
  const {ownerToken:_ownerToken,ownerId:_ownerId,requestKey:_requestKey,payloadDigest:_payloadDigest,...safe}=value as Record<string,unknown>;
  return safe;
}
function recoveryListDto(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Recovery list is malformed');
  const row=value as Record<string,unknown>;
  return {...row,operations:Array.isArray(row.operations)?row.operations.map(recoveryOperationDto):[]};
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObject(value)) throw new HttpFailure(400, 'INVALID_INPUT', 'Expected a JSON object');
  const accepted = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !accepted.has(key)))
    throw new HttpFailure(400, 'INVALID_INPUT', 'Request has missing or unknown fields');
  return value;
}
function checkedStudioDraft(value: unknown): { id: string; title: string; selected: string[]; layout?: 'top'|'sidebar'; choices?: Record<string,string>; version?: string } {
  const draft = exact(value,['id','title','selected'],['layout','choices','version']);
  if (typeof draft.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(draft.id) || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 80 ||
      !Array.isArray(draft.selected) || draft.selected.length > 100 || draft.selected.some(item=>typeof item!=='string'||item.length>48))
    throw new HttpFailure(400,'INVALID_INPUT','Draft identity, title and selected modules must be bounded text');
  if (draft.layout !== undefined && draft.layout !== 'top' && draft.layout !== 'sidebar') throw new HttpFailure(400,'INVALID_INPUT','Unsupported navigation layout');
  if (draft.version !== undefined && (typeof draft.version!=='string'||!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(draft.version))) throw new HttpFailure(400,'INVALID_INPUT','Draft version must be exact text');
  let choices: Record<string,string>|undefined;
  if (draft.choices !== undefined) {
    if (!isObject(draft.choices) || Object.keys(draft.choices).length>100) throw new HttpFailure(400,'INVALID_INPUT','Binding choices must be a bounded object of text');
    choices = {};
    for (const [key,value] of Object.entries(draft.choices)) {
      if (!/^[a-z][a-z0-9-]{1,47}:[a-z][a-z0-9.-]{0,63}$/.test(key) || typeof value!=='string' || value.length>64) throw new HttpFailure(400,'INVALID_INPUT','Binding choice keys and values must be bounded text');
      choices[key]=value;
    }
  }
  return {id:draft.id,title:draft.title,selected:draft.selected as string[],...(draft.layout?{layout:draft.layout as 'top'|'sidebar'}:{}),...(choices?{choices}:{}),...(draft.version?{version:draft.version as string}:{})};
}
function checkedProduct(value: unknown) {
  const product = exact(value,['id','title','version','platformAbi','layout','modules','bindings'],['description','wiring']);
  if (typeof product.id!=='string'||typeof product.title!=='string'||typeof product.version!=='string'||typeof product.platformAbi!=='string'||typeof product.layout!=='string'||
      (product.description!==undefined&&typeof product.description!=='string')||(product.wiring!==undefined&&typeof product.wiring!=='string'))
    throw new HttpFailure(400,'INVALID_INPUT','Product fields must use their declared primitive types');
  if (!Array.isArray(product.modules)||!Array.isArray(product.bindings)||product.modules.length>100||product.bindings.length>300) throw new HttpFailure(400,'INVALID_INPUT','Product module and binding lists must be bounded arrays');
  for(const item of product.modules) { const ref=exact(item,['id','version']); if(typeof ref.id!=='string'||typeof ref.version!=='string')throw new HttpFailure(400,'INVALID_INPUT','Module references must contain text identity fields'); }
  for(const item of product.bindings) { const binding=exact(item,['contract','instanceId','implementation','scope','consumer','mode']); if(Object.values(binding).some(field=>typeof field!=='string'))throw new HttpFailure(400,'INVALID_INPUT','Binding fields must be text'); }
  return product;
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new HttpFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { oversized = true; chunks.length = 0; return; }
      if (!oversized) chunks.push(Buffer.from(chunk));
    });
    req.once('aborted', () => reject(new HttpFailure(400, 'INCOMPLETE_BODY', 'Request body ended before completion')));
    req.once('error', reject);
    req.once('end', () => {
      if (oversized) { reject(new HttpFailure(413, 'BODY_TOO_LARGE', 'Request body exceeds the local operator limit')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch { reject(new HttpFailure(400, 'INVALID_JSON', 'Request body is not valid JSON')); }
    });
  });
}
function actorFor(req: IncomingMessage, sessions: Map<string, Session>, now: () => number): AuthenticatedSession | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const cookie = values[0];
  if (!cookie) return undefined;
  const token = cookie.slice(COOKIE.length + 1);
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= now()) { sessions.delete(token); return undefined; }
  return { ...session, token };
}
function recheckSession(req: IncomingMessage, sessions: Map<string, Session>, original: AuthenticatedSession, now: () => number): AuthenticatedSession {
  const current = actorFor(req, sessions, now);
  if (!current || current.token !== original.token || current.id !== original.id)
    throw new HttpFailure(401, 'UNAUTHENTICATED', 'The local operator session expired or was disconnected');
  return current;
}
function statusFor(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpFailure) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ArtifactStoreUnavailable) return {status:503,code:'ARTIFACT_REGISTRY_UNAVAILABLE',message:error.message};
  if (error instanceof RuntimePreparationError) {
    const responses:Record<RuntimePreparationError['code'],{status:number;message:string}>={
      RUNTIME_UNAVAILABLE:{status:503,message:'The selected local runtime profile is unavailable or shutting down.'},
      RUNTIME_REPAIR_REQUIRED:{status:409,message:'This managed runtime needs local repair before another operation can proceed.'},
      RUNTIME_SOURCE_INVALID:{status:409,message:'The verified runtime source or process protocol changed.'},
      RUNTIME_IDENTITY_CHANGED:{status:409,message:'The selected immutable runtime identity changed during preparation.'}
    };
    const response=responses[error.code];return {status:response.status,code:error.code,message:response.message};
  }
  if(error instanceof RuntimeRecoveryError){
    const responses:Record<RuntimeRecoveryError['code'],{status:number;message:string}>={
      RUNTIME_UNAVAILABLE:{status:503,message:'The selected local recovery profile is unavailable or shutting down.'},
      RUNTIME_REPAIR_REQUIRED:{status:409,message:'This local runtime needs repair before recovery can proceed.'},
      RUNTIME_BACKUP_INVALID:{status:409,message:'The selected local backup or runtime identity could not be verified.'},
      RUNTIME_RECOVERY_UNKNOWN:{status:503,message:'Recovery ownership is unresolved; its private reservation has been retained.'}
    };
    const response=responses[error.code];return {status:response.status,code:error.code,message:response.message};
  }
  if (error instanceof PlatformError) {
    const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'DENIED' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof SyntaxError) return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Local operator request failed' };
}

/** Creates the paired loopback operator. Source is imported once before any request can be served. */
export async function createOperatorServer(options: ServerOptions): Promise<OperatorServer> {
  if (process.env.NODE_ENV === 'production') throw new Error('The local platform operator cannot run in production mode');
  const port = options.port ?? 4480;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Studio port');
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? SESSION_TTL_MS;
  const pairWindow = options.pairWindowMs ?? PAIR_WINDOW_MS;
  const maxAttempts = options.maxPairAttempts ?? MAX_PAIR_ATTEMPTS;
  const pairingCode = options.pairingCode ?? randomBytes(24).toString('base64url');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pairingCode)) throw new Error('Invalid test pairing code');

  let snapshot = options.snapshot;
  if (!snapshot) {
    snapshot = loadSourceSnapshot(options.root);
    importSourceSnapshot(options.store, snapshot);
  }
  storedOverview(options.store, snapshot, Boolean(options.worker),options.artifactStore?.capability,Boolean(options.runtimeManager));
  const sessions = new Map<string, Session>();
  let pairAttempts = 0;
  let pairResetAt = now() + pairWindow;
  let origin = '';
  const sendStatic = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    const paths: Record<string, { file: string; type: string }> = {
      '/': { file: 'apps/studio-web/static/index.html', type: 'text/html; charset=utf-8' },
      '/main.js': { file: 'apps/studio-web/dist/main.js', type: 'text/javascript; charset=utf-8' },
      '/studio.css': { file: 'apps/studio-web/static/studio.css', type: 'text/css; charset=utf-8' }
    };
    const entry = paths[pathname];
    if (!entry) throw new HttpFailure(404, 'NOT_FOUND', 'No such operator resource');
    const body = readFileSync(join(options.root, entry.file));
    responseHeaders(res);
    if (pathname === '/') res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(body);
  };
  const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    try {
      responseHeaders(res);
      const expectedHost = new URL(origin).host;
      if (req.headers.host !== expectedHost) throw new HttpFailure(403, 'INVALID_HOST', 'Unexpected Host header');
      const url = new URL(req.url ?? '/', origin);
      if (url.search || url.hash) throw new HttpFailure(400, 'INVALID_URL', 'Query and fragment components are not accepted');
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpFailure(403, 'INVALID_ORIGIN', 'Origin must match the paired local operator');
      const method = req.method ?? '';
      if (!['GET', 'POST'].includes(method)) throw new HttpFailure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      if (method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
      if (method === 'GET' && ['/', '/main.js', '/studio.css'].includes(url.pathname)) return sendStatic(req, res, url.pathname);
      if (url.pathname === '/platform-api/session' && method === 'POST') {
        if (req.headers.origin !== origin) throw new HttpFailure(403, 'INVALID_ORIGIN', 'Origin must match the paired local operator');
        if (now() >= pairResetAt) { pairResetAt = now() + pairWindow; pairAttempts = 0; }
        if (++pairAttempts > maxAttempts) throw new HttpFailure(429, 'PAIR_RATE_LIMITED', 'Too many pairing attempts; wait before trying again');
        const body = exact(await readJson(req), ['code']);
        if (typeof body.code !== 'string') throw new HttpFailure(400, 'INVALID_INPUT', 'Pairing code must be text');
        const supplied = Buffer.from(body.code);
        const expected = Buffer.from(pairingCode);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpFailure(401, 'UNAUTHENTICATED', 'Invalid pairing code');
        for (const [token, session] of sessions) if (session.expiresAt <= now()) sessions.delete(token);
        if (sessions.size >= MAX_SESSIONS) throw new HttpFailure(429, 'SESSION_LIMIT', 'The local operator already has its maximum number of paired sessions');
        const token = randomBytes(32).toString('base64url');
        const session = { id: randomUUID(), expiresAt: now() + ttl };
        sessions.set(token, session);
        responseHeaders(res);
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/platform-api; Max-Age=${Math.floor(ttl / 1000)}`);
        return sendJson(res, 200, { connected: true, expiresAt: session.expiresAt });
      }
      if (!url.pathname.startsWith('/platform-api/')) throw new HttpFailure(404, 'NOT_FOUND', 'No such operator route');
      const session = actorFor(req, sessions, now);
      if (!session) throw new HttpFailure(401, 'UNAUTHENTICATED', 'Pair this browser using the code printed in the terminal');
      const awaitOriginalSession = async <T>(work: Promise<T>): Promise<T> => {
        try {
          const value = await work;
          recheckSession(req, sessions, session, now);
          return value;
        } catch (error) {
          // Preserve the original authorization failure even when awaited work also rejects.
          recheckSession(req, sessions, session, now);
          throw error;
        }
      };
      if (method === 'GET' && url.pathname === '/platform-api/session') return sendJson(res, 200, { connected: true, expiresAt: session.expiresAt });
      const savedProduct=/^\/platform-api\/products\/([a-z][a-z0-9-]{1,47})\/(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(url.pathname);
      if(method==='GET'&&savedProduct){
        recheckSession(req,sessions,session,now);
        const product=options.store.product(savedProduct[1]!,savedProduct[2]!);
        if(!product)throw new HttpFailure(404,'NOT_FOUND','Saved product version not found');
        return sendJson(res,200,{product});
      }
      if (method === 'GET' && url.pathname === '/platform-api/overview') return sendJson(res, 200, storedOverview(options.store, snapshot!, Boolean(options.worker),options.artifactStore?.capability,Boolean(options.runtimeManager)));
      if (method === 'GET' && url.pathname === '/platform-api/audit') return sendJson(res, 200, options.store.auditLog(100));
      if (method === 'GET' && url.pathname === '/platform-api/catalogue') return sendJson(res, 200, { modules: snapshot!.modules, solutions: snapshot!.solutions, products: options.store.products() });
      if (method === 'GET' && url.pathname === '/platform-api/builds') return sendJson(res, 200, options.store.builds());
      if(method==='GET'&&url.pathname==='/platform-api/artifacts'){
        if(!options.artifactStore)throw new HttpFailure(503,'ARTIFACT_REGISTRY_UNAVAILABLE','The local artifact registry is not attached');
        const value=await awaitOriginalSession(options.artifactStore.list());
        return sendJson(res,200,value);
      }
      if(method==='GET'&&url.pathname==='/platform-api/releases'){
        if(!options.artifactStore)throw new HttpFailure(503,'ARTIFACT_REGISTRY_UNAVAILABLE','The local artifact registry is not attached');
        const value=await awaitOriginalSession(options.artifactStore.releases());
        return sendJson(res,200,value);
      }
      if(method==='GET'&&url.pathname==='/platform-api/runtime-instances'){
        if(!options.runtimeManager)throw new HttpFailure(503,'RUNTIME_UNAVAILABLE','Managed local runtime control is not attached');
        const value=options.runtimeManager.list();recheckSession(req,sessions,session,now);return sendJson(res,200,value);
      }
      const runtimeRead=/^\/platform-api\/runtime-instances\/(runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(log))?$/i.exec(url.pathname);
      if(method==='GET'&&runtimeRead){
        if(!options.runtimeManager)throw new HttpFailure(503,'RUNTIME_UNAVAILABLE','Managed local runtime control is not attached');
        const value=options.runtimeManager.detail(runtimeRead[1]!) as Record<string,any>|undefined;recheckSession(req,sessions,session,now);
        if(!value)throw new HttpFailure(404,'NOT_FOUND','Managed runtime instance not found');
        return sendJson(res,200,runtimeRead[2]?{instanceId:value.id,events:value.events}:value);
      }
      const backupList=/^\/platform-api\/runtime-instances\/(runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/backups$/i.exec(url.pathname);
      if(method==='GET'&&backupList){
        if(!options.recoveryManager)throw new HttpFailure(503,'RUNTIME_RECOVERY_UNAVAILABLE','Private local recovery is not attached');
        const value=recoveryListDto(options.recoveryManager.list(backupList[1]!));recheckSession(req,sessions,session,now);return sendJson(res,200,value);
      }
      const backupRead=/^\/platform-api\/runtime-backups\/([a-f0-9]{64})$/.exec(url.pathname);
      if(method==='GET'&&backupRead){
        if(!options.recoveryManager)throw new HttpFailure(503,'RUNTIME_RECOVERY_UNAVAILABLE','Private local recovery is not attached');
        const value=await awaitOriginalSession(options.recoveryManager.verifyBackup(backupRead[1]!));return sendJson(res,200,value);
      }
      const artifactRead=/^\/platform-api\/artifacts\/([a-f0-9]{64})(?:\/(manifest|entries\/([a-f0-9]{64})))?$/.exec(url.pathname);
      if(method==='GET'&&artifactRead){
        if(!options.artifactStore)throw new HttpFailure(503,'ARTIFACT_REGISTRY_UNAVAILABLE','The local artifact registry is not attached');
        const digest=artifactRead[1]!,suffix=artifactRead[2];
        if(suffix?.startsWith('entries/')){
          const result=await awaitOriginalSession(options.artifactStore.entry(digest,artifactRead[3]!));
          return sendArtifactBytes(res,result.bytes,result.entry.path.split('/').at(-1)??'artifact.bin');
        }
        const value=await awaitOriginalSession(options.artifactStore.verifyArtifact(digest));
        return sendJson(res,200,suffix==='manifest'?value.snapshot.manifest:artifactDto(value.artifact,
          value.snapshot.entries.map(({id,path,digest:entryDigest,sizeBytes})=>({id,path,digest:entryDigest,sizeBytes}))));
      }
      const buildRead = /^\/platform-api\/builds\/([0-9a-f-]{36})(?:\/(log|result))?$/i.exec(url.pathname);
      const buildCancel = /^\/platform-api\/builds\/([0-9a-f-]{36})\/cancel$/i.exec(url.pathname);
      if (method === 'GET' && buildRead) {
        const id = buildRead[1]!, suffix = buildRead[2], build = options.store.build(id);
        if (!build) throw new HttpFailure(404,'NOT_FOUND','Build not found');
        if (suffix === 'log') return sendJson(res,200,{ buildId:id, log:options.store.buildLog(id) });
        if (suffix === 'result') {
          if (!options.worker) throw new HttpFailure(503,'BUILD_EXECUTOR_UNAVAILABLE','No local build worker is attached');
          let result: unknown, inspectionFailed = false;
          try { result = await options.worker.inspect(id); }
          catch { inspectionFailed = true; }
          recheckSession(req,sessions,session,now);
          if (inspectionFailed) throw new HttpFailure(409,'RESULT_NOT_VERIFIED','No currently verified local snapshot is available');
          return sendJson(res,200,result);
        }
        return sendJson(res,200,build);
      }
      if (method !== 'POST') throw new HttpFailure(404, 'NOT_FOUND', 'No such operator route');
      if (req.headers.origin !== origin) throw new HttpFailure(403, 'INVALID_ORIGIN', 'Origin must match the paired local operator');
      const actorId = `operator:${session.id}`;
      if (url.pathname === '/platform-api/logout') {
        options.onProtectedBodyRead?.();
        const body = await readJson(req);
        exact(body, [], []);
        recheckSession(req, sessions, session, now);
        sessions.delete(session.token);
        responseHeaders(res);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/platform-api; Max-Age=0`);
        return sendJson(res, 200, { connected: false });
      }
      options.onProtectedBodyRead?.();
      const body = await readJson(req);
      if(url.pathname==='/platform-api/products/preview'){
        const request=exact(body,['product']);
        recheckSession(req,sessions,session,now);
        if(maintainedSourceFingerprint(options.root)!==snapshot!.sourceFingerprint)throw new HttpFailure(409,'SOURCE_DRIFT','Maintained source changed; restart Studio to reload the catalogue');
        const inspected=inspectProductDefinition(checkedProduct(request.product),snapshot!.modules,snapshot!.solutions as any);
        return sendJson(res,200,inspected.valid?{...inspected,status:'VALIDATED_DEFINITION_NOT_RUNNING'}:inspected);
      }
      if (url.pathname === '/platform-api/products/compose') {
        const request = exact(body,['draft']);
        recheckSession(req,sessions,session,now);
        if (maintainedSourceFingerprint(options.root) !== snapshot!.sourceFingerprint) throw new HttpFailure(409,'SOURCE_DRIFT','Maintained source changed; restart Studio to reload the catalogue');
        const version = (JSON.parse(readFileSync(join(options.root,'package.json'),'utf8')) as {version:string}).version;
        const draft = composeDraft(checkedStudioDraft(request.draft),snapshot!.modules,snapshot!.solutions as any,version);
        return sendJson(res,200,draft);
      }
      if(url.pathname==='/platform-api/artifacts/register'){
        const request=exact(body,['confirm','buildId']);
        if(request.confirm!==true)throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit registration confirmation is required');
        if(typeof request.buildId!=='string')throw new HttpFailure(400,'INVALID_INPUT','Build identity must be text');
        if(!options.artifactStore)throw new HttpFailure(503,'ARTIFACT_REGISTRY_UNAVAILABLE','The local artifact registry is not attached');
        recheckSession(req,sessions,session,now);
        const value=await awaitOriginalSession(options.artifactStore.register(request.buildId,actorId,()=>recheckSession(req,sessions,session,now)));
        return sendJson(res,201,{artifact:artifactDto(value),status:'REGISTERED_VERIFIED_LOCAL_ARTIFACT'});
      }
      if(url.pathname==='/platform-api/releases'){
        const request=exact(body,['confirm','productId','version','artifactDigest']);
        if(request.confirm!==true)throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit promotion confirmation is required');
        if([request.productId,request.version,request.artifactDigest].some(value=>typeof value!=='string'))throw new HttpFailure(400,'INVALID_INPUT','Release identity fields must be text');
        if(!options.artifactStore)throw new HttpFailure(503,'ARTIFACT_REGISTRY_UNAVAILABLE','The local artifact registry is not attached');
        recheckSession(req,sessions,session,now);
        const value=await awaitOriginalSession(options.artifactStore.promote(request.productId as string,request.version as string,request.artifactDigest as string,actorId,()=>recheckSession(req,sessions,session,now)));
        return sendJson(res,201,value);
      }
      if(url.pathname==='/platform-api/runtime-instances'){
        const request=exact(body,['confirm','productId','version','requestKey']);
        if(request.confirm!==true)throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit local runtime start confirmation is required');
        if(typeof request.productId!=='string'||typeof request.version!=='string'||typeof request.requestKey!=='string')
          throw new HttpFailure(400,'INVALID_INPUT','Product version and request key must be text');
        if(!options.runtimeManager)throw new HttpFailure(503,'RUNTIME_UNAVAILABLE','Managed local runtime control is not attached');
        recheckSession(req,sessions,session,now);
        const value=await awaitOriginalSession(options.runtimeManager.start({productId:request.productId,version:request.version,requestKey:request.requestKey},actorId,
          ()=>recheckSession(req,sessions,session,now)));
        return sendJson(res,202,value);
      }
      const runtimeAction=/^\/platform-api\/runtime-instances\/(runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(stop|restart)$/.exec(url.pathname);
      if(runtimeAction){
        const request=exact(body,['confirm','requestKey']);
        if(request.confirm!==true)throw new HttpFailure(400,'CONFIRMATION_REQUIRED',`Explicit local runtime ${runtimeAction[2]} confirmation is required`);
        if(typeof request.requestKey!=='string')throw new HttpFailure(400,'INVALID_INPUT','Runtime request key must be text');
        if(!options.runtimeManager)throw new HttpFailure(503,'RUNTIME_UNAVAILABLE','Managed local runtime control is not attached');
        recheckSession(req,sessions,session,now);
        const operation=runtimeAction[2]==='stop'
          ?options.runtimeManager.stop({instanceId:runtimeAction[1]!,requestKey:request.requestKey},actorId,()=>recheckSession(req,sessions,session,now))
          :options.runtimeManager.restart({instanceId:runtimeAction[1]!,requestKey:request.requestKey},actorId,()=>recheckSession(req,sessions,session,now));
        const value=await awaitOriginalSession(operation);return sendJson(res,202,value);
      }
      const backupCreate=/^\/platform-api\/runtime-instances\/(runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/backups$/i.exec(url.pathname);
      if(backupCreate){
        const request=exact(body,['confirm','requestKey']);
        if(request.confirm!==true)throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit local backup confirmation is required');
        if(typeof request.requestKey!=='string')throw new HttpFailure(400,'INVALID_INPUT','Recovery request key must be text');
        if(!options.recoveryManager)throw new HttpFailure(503,'RUNTIME_RECOVERY_UNAVAILABLE','Private local recovery is not attached');
        recheckSession(req,sessions,session,now);
        const value=await awaitOriginalSession(options.recoveryManager.backup({instanceId:backupCreate[1]!,requestKey:request.requestKey},actorId,
          ()=>recheckSession(req,sessions,session,now)));
        return sendJson(res,201,recoveryOperationDto(value));
      }
      const restore=/^\/platform-api\/runtime-instances\/(runtime-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/restore$/i.exec(url.pathname);
      if(restore){
        const request=exact(body,['confirm','backupDigest','requestKey']);
        if(request.confirm!==true)throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit local restore confirmation is required');
        if(typeof request.backupDigest!=='string'||typeof request.requestKey!=='string')throw new HttpFailure(400,'INVALID_INPUT','Backup reference and recovery request key must be text');
        if(!options.recoveryManager)throw new HttpFailure(503,'RUNTIME_RECOVERY_UNAVAILABLE','Private local recovery is not attached');
        recheckSession(req,sessions,session,now);
        const value=await awaitOriginalSession(options.recoveryManager.restore({instanceId:restore[1]!,backupDigest:request.backupDigest,requestKey:request.requestKey},actorId,
          ()=>recheckSession(req,sessions,session,now)));
        return sendJson(res,200,recoveryOperationDto(value));
      }
      if (url.pathname === '/platform-api/products') {
        const request = exact(body,['confirm','product']);
        if (request.confirm !== true) throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit confirmation is required');
        recheckSession(req,sessions,session,now);
        if (maintainedSourceFingerprint(options.root) !== snapshot!.sourceFingerprint) throw new HttpFailure(409,'SOURCE_DRIFT','Maintained source changed; restart Studio to reload the catalogue');
        const product = validateProduct(checkedProduct(request.product),snapshot!.modules,snapshot!.solutions as any);
        recheckSession(req,sessions,session,now);
        const saved = options.store.putProduct(product,actorId,()=>recheckSession(req,sessions,session,now));
        return sendJson(res,201,{product:saved,status:'SAVED_IMMUTABLE_VERSION'});
      }
      if (url.pathname === '/platform-api/builds') {
        const request = exact(body,['confirm','productId','version','requestKey']);
        if (request.confirm !== true) throw new HttpFailure(400, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
        if (typeof request.productId !== 'string' || typeof request.version !== 'string' || typeof request.requestKey !== 'string') throw new HttpFailure(400, 'INVALID_INPUT', 'Product, version and request key must be text');
        if (!options.worker) throw new HttpFailure(503,'BUILD_EXECUTOR_UNAVAILABLE','No local build worker is attached');
        const product = options.store.product(request.productId,request.version);
        if (!product) throw new HttpFailure(404,'NOT_FOUND','Product version not found');
        const plan = resolve(product,snapshot!.modules);
        let build: unknown;
        try { build = await options.worker.admit(plan.product,plan,request.requestKey,actorId,()=>recheckSession(req,sessions,session,now)); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/changed|restart Studio|fingerprint|toolchain/i.test(message)) throw new HttpFailure(409,'BUILD_INPUTS_CHANGED','The reviewed local build inputs changed; restart Studio before requesting work');
          throw error;
        }
        return sendJson(res,202,build);
      }
      if (buildCancel) {
        const request = exact(body,['confirm']);
        if (request.confirm !== true) throw new HttpFailure(400,'CONFIRMATION_REQUIRED','Explicit confirmation is required');
        recheckSession(req,sessions,session,now);
        const cancelled = options.store.cancelBuild(buildCancel[1]!,actorId);
        const { claimToken:_claimToken,...safe } = cancelled;
        return sendJson(res,202,safe);
      }
      if (url.pathname === '/platform-api/ai/pipelines') {
        const request = exact(body, ['confirm', 'pipeline']);
        if (request.confirm !== true) throw new HttpFailure(400, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
        recheckSession(req, sessions, session, now);
        return sendJson(res, 200, options.store.putAiPipeline(request.pipeline as AiPipeline, actorId));
      }
      if (url.pathname === '/platform-api/environments') {
        const request = exact(body, ['confirm', 'environment']);
        if (request.confirm !== true) throw new HttpFailure(400, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
        recheckSession(req, sessions, session, now);
        return sendJson(res, 200, options.store.putEnvironment(request.environment as EnvironmentSpec, actorId));
      }
      if (url.pathname === '/platform-api/deployments') {
        const request = exact(body, ['confirm', 'environmentId', 'productId', 'version', 'buildId']);
        if (request.confirm !== true) throw new HttpFailure(400, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
        if (['environmentId', 'productId', 'version', 'buildId'].some(key => typeof request[key] !== 'string')) throw new HttpFailure(400, 'INVALID_INPUT', 'Deployment references must be text');
        recheckSession(req, sessions, session, now);
        return sendJson(res, 202, options.store.requestDeployment(request.environmentId as string, request.productId as string, request.version as string, request.buildId as string, actorId));
      }
      throw new HttpFailure(404, 'NOT_FOUND', 'No such operator route');
    } catch (error) {
      const result = statusFor(error);
      sendJson(res, result.status, { error: result.message, code: result.code });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('Could not determine the loopback operator address');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    pairingCode,
    server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      sessions.clear();
    }
  };
}
