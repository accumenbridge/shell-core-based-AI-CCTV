import { PlatformError, markTrustedCommandError, validateCommandFieldErrors, validateCommandOutcome, type FailureCode, type WorkspaceContext } from '@quadbridge/contracts';

export { CommandState, createCommandState } from './command-state.js';
export type { CapturedCommandIntent, CommandIntentState, CommandStateOptions } from './command-state.js';
export { trustedCommandErrorDetails } from '@quadbridge/contracts';

const failureCodes = new Set<FailureCode>(['INVALID', 'UNAUTHENTICATED', 'DENIED', 'NOT_FOUND', 'CONFLICT', 'DISABLED', 'UNAVAILABLE', 'STALE_ATTEMPT', 'INCOMPATIBLE', 'EXHAUSTED']);

export interface RequestOptions {
  fetcher?: typeof fetch;
  origin?: () => string;
}

/** Optional fixed transport supplied by an active client profile; business scopes remain unchanged. */
export type RequestTransport = (path: string, init?: RequestInit, signal?: AbortSignal, tenantId?: string) => Promise<unknown>;

export async function requestJson(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  tenantId?: string,
  options: RequestOptions = {}
): Promise<unknown> {
  if (signal?.aborted) throw new DOMException('Scope closed', 'AbortError');
  const headers = new Headers(init.headers);
  if (tenantId) headers.set('X-QB-Tenant', tenantId);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json() as { error?: { code?: string; message?: string; commandOutcome?: unknown; fieldErrors?: unknown } };
  if (signal?.aborted) throw new DOMException('Scope closed', 'AbortError');
  if (!response.ok) {
    const reported = data.error?.code;
    const code: FailureCode = reported && failureCodes.has(reported as FailureCode) ? reported as FailureCode : 'UNAVAILABLE';
    const error = new PlatformError(code, data.error?.message ?? 'Operation unavailable');
    if (code === 'INVALID' || code === 'CONFLICT' || code === 'NOT_FOUND') {
      const outcome = validateCommandOutcome(data.error?.commandOutcome);
      if (outcome) {
        const fields = validateCommandFieldErrors(data.error?.fieldErrors);
        if (fields !== undefined) markTrustedCommandError(error, outcome, fields);
      }
    }
    throw error;
  }
  return data;
}

export interface ScopedWorkspaceApiOptions {
  operations: readonly { method: string; path: string; moduleId: string }[];
  moduleId: string;
  tenantId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  origin: () => string;
  onAccessFailure: (error: PlatformError) => void;
  request?: RequestTransport;
}

export function createScopedWorkspaceApi(options: ScopedWorkspaceApiOptions): WorkspaceContext['api'] {
  const permitted = (method: string, path: string) => {
    if (!options.isCurrent()) throw new DOMException('Scope closed', 'AbortError');
    if (!path.startsWith('/api/') || path.startsWith('//'))
      throw new PlatformError('DENIED', 'Only declared local operations are exposed');
    const url = new URL(path, options.origin());
    if (url.origin !== options.origin() || url.hash ||
        !options.operations.some(route => route.moduleId === options.moduleId && route.method === method && route.path === url.pathname))
      throw new PlatformError('DENIED', 'Operation is not exposed to this contribution');
  };

  const scopedRequest = async (method: 'GET' | 'POST', path: string, body?: unknown, commandId?: string, callSignal?: AbortSignal) => {
    permitted(method, path);
    if (callSignal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    const signal = callSignal ? AbortSignal.any([options.signal, callSignal]) : options.signal;
    try {
      const request = options.request ?? requestJson;
      const result = await request(path, method === 'GET' ? {} : {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': commandId ?? crypto.randomUUID() },
        body: JSON.stringify(body)
      }, signal, options.tenantId);
      if (!options.isCurrent() || callSignal?.aborted) throw new DOMException('Scope closed', 'AbortError');
      return result;
    } catch (error) {
      if (options.isCurrent() && error instanceof PlatformError && ['DENIED', 'DISABLED', 'UNAUTHENTICATED'].includes(error.code))
        options.onAccessFailure(error);
      throw error;
    }
  };
  return {
    get: (path, signal) => scopedRequest('GET', path, undefined, undefined, signal),
    post: (path, body, commandId, signal) => scopedRequest('POST', path, body, commandId, signal)
  };
}
