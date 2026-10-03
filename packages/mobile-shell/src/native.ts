import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { PlatformError } from '@quadbridge/contracts';
import { requestJson, type RequestTransport } from '@quadbridge/client-core';
import type { NativeLogoutOutcome, ShellLifecyclePort } from '@quadbridge/web-shell';

export const NATIVE_API_PORT = 4350;
const API_ORIGIN = `http://127.0.0.1:${NATIVE_API_PORT}`;

export interface NativeSessionStore {
  read(): Promise<{ token: string | null }>;
  save(options: { token: string }): Promise<void>;
  clear(): Promise<void>;
}

export interface NativeRuntimeIdentity {
  productId: string;
  productVersion: string;
  instanceId: string;
  planDigest: string;
  modules: readonly { id: string; version: string }[];
}

/** Verify the server bootstrap against the exact product selected for this APK. */
export function validateNativeBootstrapIdentity(value: unknown, expected: NativeRuntimeIdentity): unknown {
  if (!expected || typeof expected.productId !== 'string' || typeof expected.productVersion !== 'string' ||
      typeof expected.instanceId !== 'string' || typeof expected.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expected.planDigest) || !Array.isArray(expected.modules) ||
      expected.modules.some(module => !module || typeof module.id !== 'string' || typeof module.version !== 'string'))
    throw new PlatformError('INCOMPATIBLE', 'Packaged native identity is invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PlatformError('INCOMPATIBLE', 'Native bootstrap identity is invalid');
  const snapshot = value as {
    product?: { id?: unknown; version?: unknown };
    scope?: { instanceId?: unknown };
    modules?: unknown;
    nativeIdentity?: { productId?: unknown; productVersion?: unknown; instanceId?: unknown; planDigest?: unknown; modules?: unknown };
  };
  if (snapshot.product?.id !== expected.productId || snapshot.product?.version !== expected.productVersion ||
      snapshot.scope?.instanceId !== expected.instanceId || !Array.isArray(snapshot.modules))
    throw new PlatformError('INCOMPATIBLE', 'The selected native product or instance does not match this app');
  const captured = snapshot.nativeIdentity;
  if (captured?.productId !== expected.productId || captured.productVersion !== expected.productVersion ||
      captured.instanceId !== expected.instanceId || captured.planDigest !== expected.planDigest ||
      !Array.isArray(captured.modules) || captured.modules.length !== expected.modules.length)
    throw new PlatformError('INCOMPATIBLE', 'The selected native runtime plan does not match this app');
  for (let index = 0; index < expected.modules.length; index++) {
    const wanted = expected.modules[index]!;
    const capturedModule = captured.modules[index] as { id?: unknown; version?: unknown } | undefined;
    if (!capturedModule || capturedModule.id !== wanted.id || capturedModule.version !== wanted.version)
      throw new PlatformError('INCOMPATIBLE', 'The selected native runtime modules do not match this app');
  }
  const expectedModules = new Map(expected.modules.map(module => [module.id, module.version]));
  const visible = new Set<string>();
  for (const raw of snapshot.modules) {
    const module = raw as { id?: unknown; version?: unknown; mode?: unknown };
    if (typeof module.id !== 'string' || typeof module.version !== 'string' || visible.has(module.id) ||
        expectedModules.get(module.id) !== module.version || !['enabled', 'read-only'].includes(String(module.mode)))
      throw new PlatformError('INCOMPATIBLE', 'Visible native modules do not match the selected runtime');
    visible.add(module.id);
  }
  return value;
}

interface NativeSessionPlugin extends NativeSessionStore {}
const NativeSession = registerPlugin<NativeSessionPlugin>('NativeSession');

/** Fixed transport for the reviewed local-forward profile; callers cannot select an endpoint. */
export function createNativeRequestTransport(store: NativeSessionStore = NativeSession, fetcher: typeof fetch = fetch): RequestTransport {
  let token: string | null | undefined;
  let reading: Promise<string | null> | undefined;
  let logoutRecovery: NativeLogoutOutcome['remoteRevocation'] | undefined;
  const clear = async () => { token = null; reading = undefined; await store.clear(); };
  const logoutOutcome = (remoteRevocation: NativeLogoutOutcome['remoteRevocation'], localCredentials: NativeLogoutOutcome['localCredentials']): NativeLogoutOutcome => ({
    kind: 'quadbridge.native-logout.v1', remoteRevocation, localCredentials,
    recovery: localCredentials === 'removed' ? 'return-to-sign-in' : 'retry-local-cleanup'
  });
  const currentToken = async () => {
    if (token !== undefined) return token;
    if (!reading) reading = store.read().then(value => {
      if (!value || (value.token !== null && (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(value.token))))
        throw new PlatformError('INCOMPATIBLE', 'Secure native session store returned an invalid value');
      token = value.token;
      return token;
    });
    return reading;
  };
  return async (path, init = {}, signal, tenantId) => {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//') || path.includes('#'))
      throw new PlatformError('DENIED', 'Only the fixed native API routes are available');
    const parsed = new URL(path, 'http://localhost');
    if (parsed.origin !== 'http://localhost' || !parsed.pathname.startsWith('/api/'))
      throw new PlatformError('DENIED', 'Only the fixed native API routes are available');
    const method = (init.method ?? 'GET').toUpperCase();
    const isLogin = parsed.pathname === '/api/session' && method === 'POST';
    const isLogout = parsed.pathname === '/api/logout' && method === 'POST';
    const isBootstrap = parsed.pathname === '/api/bootstrap' && method === 'GET';
    const route = isLogin
      ? '/native-api/session'
      : isLogout
        ? '/native-api/logout'
        : isBootstrap
        ? `/native-api/bootstrap${parsed.search}`
        : `/native-api${parsed.pathname}${parsed.search}`;
    if (isLogout) {
      if (logoutRecovery) {
        const remoteRevocation = logoutRecovery;
        try {
          await clear();
          logoutRecovery = undefined;
          return logoutOutcome(remoteRevocation, 'removed');
        } catch {
          return logoutOutcome(remoteRevocation, 'unresolved');
        }
      }
      let activeToken: string | null = null;
      try { activeToken = await currentToken(); }
      catch { /* An invalid local value cannot authorize remote revocation. */ }
      const clearing = clear().then(() => true, () => false);
      let remoteRevocation: NativeLogoutOutcome['remoteRevocation'] = 'unknown';
      let confirmedResponse: unknown;
      if (activeToken) {
        try {
          const headers = new Headers(init.headers);
          headers.set('Authorization', `QBUserSession ${activeToken}`);
          const result = await requestJson(`${API_ORIGIN}${route}`, {
            ...init, method, headers
          }, signal, tenantId, { fetcher });
          if (result && typeof result === 'object' && (result as { signedOut?: unknown }).signedOut === true) {
            remoteRevocation = 'confirmed';
            confirmedResponse = result;
          }
        } catch { /* Network, HTTP, and generic authentication failures leave revocation unknown. */ }
      }
      activeToken = null;
      if (await clearing) {
        logoutRecovery = undefined;
        return remoteRevocation === 'confirmed' ? confirmedResponse : logoutOutcome('unknown', 'removed');
      }
      logoutRecovery = remoteRevocation;
      return logoutOutcome(remoteRevocation, 'unresolved');
    }
    let activeToken: string | null = null;
    if (!isLogin) {
      activeToken = await currentToken();
      if (!activeToken) throw new PlatformError('UNAUTHENTICATED', 'Sign in to continue');
    }
    const headers = new Headers(init.headers);
    if (activeToken) headers.set('Authorization', `QBUserSession ${activeToken}`);
    const requestInit: RequestInit = { ...init, method, headers };
    try {
      const result = await requestJson(`${API_ORIGIN}${route}`, requestInit, signal, tenantId, { fetcher });
      if (isLogin) {
        const response = result as { token?: unknown; actor?: unknown };
        if (typeof response.token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(response.token) || !response.actor || typeof response.actor !== 'object')
          throw new PlatformError('INCOMPATIBLE', 'Native sign-in returned an invalid session');
        try { await store.save({ token: response.token }); }
        catch (error) {
          token = response.token;
          try { await requestJson(`${API_ORIGIN}/native-api/logout`, { method: 'POST', headers: { Authorization: `QBUserSession ${response.token}` } }, undefined, undefined, { fetcher }); }
          finally { token = null; }
          throw error;
        }
        token = response.token;
        reading = undefined;
        return { actor: response.actor };
      }
      if (isLogout) await clear();
      return result;
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'UNAUTHENTICATED') {
        await clear();
      } else if (isLogout) {
        // User intent to sign out must not leave a reusable local secret on this device.
        await clear();
      }
      throw error;
    }
  };
}

export const nativeAppLifecycle: ShellLifecyclePort = {
  bind(handlers) {
    let removed = false;
    let listener: { remove(): Promise<void> } | undefined;
    if (Capacitor.isNativePlatform()) {
      void App.addListener('appStateChange', state => state.isActive ? handlers.resume() : handlers.suspend()).then(handle => {
        if (removed) void handle.remove();
        else listener = handle;
      }).catch(() => handlers.suspend());
    }
    return () => { removed = true; void listener?.remove(); };
  }
};
