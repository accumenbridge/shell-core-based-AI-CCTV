import type { ProductExperience, WorkspaceNavigationInput, WorkspaceRouteContext, WorkspaceRouteKind, WorkspaceRouteQuery } from '@quadbridge/contracts';

export interface NavigationWorkspace { id: string; path: string }
const queryKeys = ['q', 'page', 'filter', 'sort'] as const;
const routeKey = /^[a-z][a-z0-9._:-]{0,95}$/;
const recordKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function freezeRoute(route: WorkspaceRouteContext): WorkspaceRouteContext {
  return Object.freeze({ ...route, params: Object.freeze({ ...route.params }), query: Object.freeze({ ...route.query }) });
}
function parseQuery(search: string): WorkspaceRouteQuery | undefined {
  if (search.length > 4096) return undefined;
  const params = new URLSearchParams(search), result: WorkspaceRouteQuery = {};
  for (const key of new Set(params.keys())) {
    if (!(queryKeys as readonly string[]).includes(key) || params.getAll(key).length !== 1) return undefined;
    const value = params.get(key)!;
    if (value.length > (key === 'q' ? 200 : key === 'page' ? 1024 : key === 'filter' ? 512 : 64) || value.includes('\0')) return undefined;
    if (key === 'page' && !/^(?:[1-9][0-9]{0,5}|[A-Za-z0-9_-]{1,1024})$/.test(value)) return undefined;
    if (key === 'sort' && !/^[A-Za-z0-9._:-]{1,64}$/.test(value)) return undefined;
    result[key as keyof WorkspaceRouteQuery] = value;
  }
  return result;
}
function rootRoute(experience: ProductExperience | undefined, workspace: NavigationWorkspace): { id: string; workspaceId: string } {
  const nav = experience?.navigation.find(item => item.workspaceId === workspace.id);
  const route = experience?.routes.find(item => item.workspaceId === workspace.id && item.kind === 'workspace');
  return { id: route?.id ?? nav?.id ?? workspace.id, workspaceId: workspace.id };
}
function routeForPath(hash: string, workspaces: readonly NavigationWorkspace[], experience?: ProductExperience): WorkspaceRouteContext | undefined {
  const available = experience ? workspaces.filter(workspace => experience.navigation.some(item => item.workspaceId === workspace.id)) : workspaces;
  if (hash === '' || hash === '#') {
    const preferred = experience?.navigation.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(item => item.workspaceId);
    const workspace = (preferred ?? []).map(id => available.find(item => item.id === id)).find((item): item is NavigationWorkspace => !!item) ?? (experience ? undefined : available[0]);
    if (!workspace) return undefined;
    const root = rootRoute(experience, workspace);
    return freezeRoute({ routeId: root.id, workspaceId: workspace.id, kind: 'workspace', params: {}, query: {} });
  }
  if (typeof hash !== 'string' || hash.length > 4096 || !hash.startsWith('#')) return undefined;
  const raw = hash.slice(1);
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  let url: URL;
  try { url = new URL(raw, 'https://quadbridge.invalid'); } catch { return undefined; }
  if (url.origin !== 'https://quadbridge.invalid') return undefined;
  const query = parseQuery(url.search);
  if (!query) return undefined;
  let decoded: string[];
  try { decoded = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part)); } catch { return undefined; }
  if (decoded.some(part => !part || part.includes('/') || part.includes('\\') || part.includes('\0'))) return undefined;
  const ordered = [...available].sort((a, b) => b.path.length - a.path.length);
  for (const workspace of ordered) {
    const base = workspace.path.split('/').filter(Boolean);
    if (base.some((part, index) => decoded[index] !== part)) continue;
    const tail = decoded.slice(base.length);
    const baseRoute = rootRoute(experience, workspace);
    if (!tail.length) return freezeRoute({ routeId: baseRoute.id, workspaceId: workspace.id, kind: 'workspace', params: {}, query });
    if (tail[0] !== '_route' || tail.length < 3) continue;
    const [marker, routeId, value, suffix, ...extra] = tail;
    if (marker !== '_route' || !routeId || !routeKey.test(routeId) || extra.length) continue;
    const route = experience?.routes.find(item => item.id === routeId && item.workspaceId === workspace.id && item.kind !== 'workspace');
    if (!route) continue;
    if (route.kind === 'create' && value === 'create' && suffix === undefined) return freezeRoute({ routeId, workspaceId: workspace.id, kind: 'create', params: {}, query });
    if ((route.kind === 'record' || route.kind === 'edit') && recordKey.test(value ?? '')) {
      if (route.kind === 'record' && suffix === undefined) return freezeRoute({ routeId, workspaceId: workspace.id, kind: 'record', params: { id: value }, query });
      if (route.kind === 'edit' && suffix === 'edit') return freezeRoute({ routeId, workspaceId: workspace.id, kind: 'edit', params: { id: value }, query });
    }
  }
  return undefined;
}

function formatRoute(routeId: string, input: WorkspaceNavigationInput | undefined, workspaces: readonly NavigationWorkspace[], experience?: ProductExperience): string | undefined {
  if (typeof routeId !== 'string' || !routeKey.test(routeId)) return undefined;
  const route = experience?.routes.find(item => item.id === routeId);
  let workspace: NavigationWorkspace | undefined;
  let kind: WorkspaceRouteKind = 'workspace';
  if (route) { workspace = workspaces.find(item => item.id === route.workspaceId); kind = route.kind; }
  else if (!experience) workspace = workspaces.find(item => item.id === routeId);
  if (!workspace) return undefined;
  const params = input?.params ?? {}, query = input?.query ?? {};
  if (Object.keys(params).some(key => key !== 'id') || Object.keys(query).some(key => !(queryKeys as readonly string[]).includes(key))) return undefined;
  let path = workspace.path;
  if (kind === 'create') {
    if (params.id !== undefined) return undefined;
    path += `/_route/${encodeURIComponent(routeId)}/create`;
  } else if (kind === 'record' || kind === 'edit') {
    if (typeof params.id !== 'string' || !recordKey.test(params.id)) return undefined;
    path += `/_route/${encodeURIComponent(routeId)}/${encodeURIComponent(params.id)}${kind === 'edit' ? '/edit' : ''}`;
  } else if (params.id !== undefined) return undefined;
  const pairs: string[] = [];
  for (const key of queryKeys) {
    const value = query[key];
    if (value === undefined) continue;
    const limit = key === 'q' ? 200 : key === 'page' ? 1024 : key === 'filter' ? 512 : 64;
    if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (key === 'page' && !/^(?:[1-9][0-9]{0,5}|[A-Za-z0-9_-]{1,1024})$/.test(value)) || (key === 'sort' && !/^[A-Za-z0-9._:-]{1,64}$/.test(value))) return undefined;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  const result = `#${path}${pairs.length ? `?${pairs.join('&')}` : ''}`;
  return result.length <= 4096 ? result : undefined;
}

export interface WorkspaceNavigationController {
  port: import('@quadbridge/contracts').WorkspaceNavigationPort;
  initialValid: boolean;
  dispose(): void;
}
export interface WorkspaceNavigationOptions {
  workspaces: readonly NavigationWorkspace[];
  experience?: ProductExperience;
  canNavigate?(): boolean;
  onRoute(route: WorkspaceRouteContext, previous: WorkspaceRouteContext): void | Promise<void>;
  onInvalidRoute(): void;
  onGuardError?(error: unknown): void;
}

function locationPort(): Location | undefined {
  return (globalThis as unknown as { window?: { location?: Location } }).window?.location ?? globalThis.location;
}
function historyPort(): History | undefined {
  return (globalThis as unknown as { window?: { history?: History } }).window?.history;
}
const historyStateKey = '__quadbridgeWorkspaceNavigation';
const historySession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
function currentHash() { return locationPort()?.hash ?? ''; }
function historyBase() { const location = locationPort(); return `${location?.pathname ?? '/'}${location?.search ?? ''}`; }
function historyTag(state: unknown): { session: string; index: number } | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const tag = (state as Record<string, unknown>)[historyStateKey];
  return tag && typeof tag === 'object' && (tag as Record<string, unknown>).session === historySession && Number.isSafeInteger((tag as Record<string, unknown>).index)
    ? tag as { session: string; index: number } : undefined;
}
function stateWithHistoryIndex(index: number) {
  const original = historyPort()?.state;
  const state: Record<string, unknown> = original && typeof original === 'object' && !Array.isArray(original) ? { ...(original as Record<string, unknown>) } : { __quadbridgePriorHistoryState: original };
  state[historyStateKey] = { session: historySession, index };
  return state;
}
function writeHistory(method: 'pushState' | 'replaceState', hash: string, index?: number) {
  const history = historyPort(), location = locationPort();
  if (history) history[method](index === undefined ? history.state : stateWithHistoryIndex(index), '', `${historyBase()}${hash}`);
  else if (location) location.hash = hash;
}

/** One shell-owned bounded hash/history router. It keeps route state out of credentials and drafts. */
export function createWorkspaceNavigation(options: WorkspaceNavigationOptions): WorkspaceNavigationController {
  const listeners = new Set<(route: WorkspaceRouteContext) => void>();
  const guards = new Set<(route: WorkspaceRouteContext) => boolean | Promise<boolean>>();
  const viewState = new Map<string, { x: number; y: number; focusId?: string }>();
  const parsedInitial = routeForPath(currentHash(), options.workspaces, options.experience);
  const initialValid = !currentHash() || !!parsedInitial;
  let current = parsedInitial ?? (() => {
    const preferred = options.experience?.navigation.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(item => item.workspaceId);
    const workspace = (preferred ?? []).map(id => options.workspaces.find(item => item.id === id)).find((item): item is NavigationWorkspace => !!item) ?? (options.experience ? undefined : options.workspaces[0]);
    if (!workspace) return freezeRoute({ routeId: 'home', workspaceId: '', kind: 'workspace', params: {}, query: {} });
    const root = rootRoute(options.experience, workspace);
    return freezeRoute({ routeId: root.id, workspaceId: root.workspaceId, kind: 'workspace', params: {}, query: {} });
  })();
  let attempt = 0, disposed = false, recovering = !initialValid;
  const navigationAvailable = () => !disposed && options.canNavigate?.() !== false;
  const initialTag = historyTag(historyPort()?.state);
  let currentHistoryIndex = initialTag?.index ?? 0;
  let handledHash = currentHash();
  if (historyPort() && !initialTag) writeHistory('replaceState', currentHash(), currentHistoryIndex);

  function routeKeyForState(route: WorkspaceRouteContext) { return serializeRoute(route, options.workspaces, options.experience); }
  function captureView(route: WorkspaceRouteContext) {
    const focused = (document as unknown as { activeElement?: { id?: unknown } }).activeElement;
    const focusId = typeof focused?.id === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(focused.id) ? focused.id : undefined;
    viewState.set(routeKeyForState(route), { x: Number.isFinite(window.scrollX) ? window.scrollX : 0, y: Number.isFinite(window.scrollY) ? window.scrollY : 0, ...(focusId ? { focusId } : {}) });
    while (viewState.size > 64) viewState.delete(viewState.keys().next().value!);
  }
  function restoreView(route: WorkspaceRouteContext, previous: WorkspaceRouteContext) {
    const state = viewState.get(routeKeyForState(route));
    const scrollTo = (window as unknown as { scrollTo?: (x: number, y: number) => void }).scrollTo;
    if (state) {
      scrollTo?.(state.x, state.y);
      if (state.focusId) {
        const target = (document as unknown as { getElementById?: (id: string) => { focus?: (options?: { preventScroll?: boolean }) => void } | null }).getElementById?.(state.focusId);
        try { target?.focus?.({ preventScroll: true }); } catch { /* a missing focus target must not block route restoration */ }
      }
    } else if (route.workspaceId !== previous.workspaceId) scrollTo?.(0, 0);
  }
  async function transition(next: WorkspaceRouteContext, push: boolean, restoreOnReject: boolean, capturePrevious = false, restoreTarget = false, returnDirection?: number): Promise<boolean> {
    if (!navigationAvailable()) return false;
    const ticket = ++attempt, previous = current;
    if (capturePrevious) captureView(previous);
    if (sameRoute(current, next)) {
      if (!push) currentHistoryIndex = historyTag(historyPort()?.state)?.index ?? currentHistoryIndex;
      const href = serializeRoute(next, options.workspaces, options.experience);
      if (recovering || currentHash() !== href) {
        recovering = false;
        writeHistory('replaceState', href, currentHistoryIndex);
        handledHash = href;
        await options.onRoute(next, previous);
        if (ticket !== attempt || disposed) return false;
        restoreView(next, previous);
        for (const listener of [...listeners]) { try { listener(next); } catch { /* provider listeners remain isolated */ } }
      }
      return true;
    }
    try {
      for (const guard of [...guards]) {
        if (!await guard(next)) {
          if (ticket === attempt && restoreOnReject) {
            const previousHash = serializeRoute(previous, options.workspaces, options.experience);
            handledHash = previousHash;
            if (historyPort()?.go && returnDirection !== undefined) historyPort()!.go(returnDirection);
            else writeHistory('replaceState', previousHash, currentHistoryIndex);
          }
          return false;
        }
        if (disposed || ticket !== attempt) return false;
        if (!navigationAvailable()) {
          if (restoreOnReject) {
            const previousHash = serializeRoute(previous, options.workspaces, options.experience);
            handledHash = previousHash;
            if (historyPort()?.go && returnDirection !== undefined) historyPort()!.go(returnDirection);
            else writeHistory('replaceState', previousHash, currentHistoryIndex);
          }
          return false;
        }
      }
    } catch (error) {
      if (disposed || ticket !== attempt) return false;
      options.onGuardError?.(error);
      if (ticket === attempt && restoreOnReject) {
        const previousHash = serializeRoute(previous, options.workspaces, options.experience);
        handledHash = previousHash;
        if (historyPort()?.go && returnDirection !== undefined) historyPort()!.go(returnDirection);
        else writeHistory('replaceState', previousHash, currentHistoryIndex);
      }
      return false;
    }
    if (disposed || ticket !== attempt) return false;
    if (!navigationAvailable()) {
      if (restoreOnReject) {
        const previousHash = serializeRoute(previous, options.workspaces, options.experience);
        handledHash = previousHash;
        if (historyPort()?.go && returnDirection !== undefined) historyPort()!.go(returnDirection);
        else writeHistory('replaceState', previousHash, currentHistoryIndex);
      }
      return false;
    }
    current = next;
    recovering = false;
    for (const listener of [...listeners]) { try { listener(next); } catch { /* one provider cannot block shell navigation */ } }
    const href = serializeRoute(next, options.workspaces, options.experience);
    if (href && (push || currentHash() !== href)) {
      const method = push ? 'pushState' : 'replaceState';
      const nextTag = !push ? historyTag(historyPort()?.state) : undefined;
      const nextIndex = push ? currentHistoryIndex + 1 : nextTag?.index ?? currentHistoryIndex;
      writeHistory(method, href, nextIndex);
      if (push || nextTag) currentHistoryIndex = nextIndex;
      handledHash = href;
    }
    if (href) handledHash = href;
    if (!push) currentHistoryIndex = historyTag(historyPort()?.state)?.index ?? currentHistoryIndex;
    await options.onRoute(next, previous);
    if (ticket !== attempt || disposed) return false;
    if (restoreTarget) restoreView(next, previous);
    return true;
  }
  let pendingLocationHash: string | undefined;
  function onLocationChange() {
    if (disposed) return;
    const hash = currentHash();
    if (hash === handledHash || hash === pendingLocationHash) {
      currentHistoryIndex = historyTag(historyPort()?.state)?.index ?? currentHistoryIndex;
      return;
    }
    if (!navigationAvailable()) {
      attempt++;
      const acceptedHash = serializeRoute(current, options.workspaces, options.experience);
      const tag = historyTag(historyPort()?.state);
      const returnBy = tag && tag.index !== currentHistoryIndex ? currentHistoryIndex - tag.index : undefined;
      handledHash = acceptedHash;
      if (returnBy !== undefined && historyPort()?.go) historyPort()!.go(returnBy);
      else writeHistory('replaceState', acceptedHash, currentHistoryIndex);
      return;
    }
    const next = routeForPath(hash, options.workspaces, options.experience);
    if (!next) { handledHash = hash; pendingLocationHash = hash; attempt++; recovering = true; options.onInvalidRoute(); queueMicrotask(() => { if (pendingLocationHash === hash) pendingLocationHash = undefined; }); return; }
    pendingLocationHash = hash;
    const tag = historyTag(historyPort()?.state);
    const direction = tag && tag.index !== currentHistoryIndex ? currentHistoryIndex - tag.index : undefined;
    void transition(next, false, true, true, true, direction).finally(() => { if (pendingLocationHash === hash) pendingLocationHash = undefined; });
  }
  const onHash = () => onLocationChange();
  const win = (globalThis as unknown as { window?: Window }).window;
  win?.addEventListener('hashchange', onHash);

  const port = Object.freeze({
    current: () => current,
    subscribe: (listener: (route: WorkspaceRouteContext) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    navigate: async (routeId: string, input?: WorkspaceNavigationInput) => {
      if (!navigationAvailable()) { attempt++; return false; }
      const hash = formatRoute(routeId, input, options.workspaces, options.experience);
      const next = hash ? routeForPath(hash, options.workspaces, options.experience) : undefined;
      if (!next) { attempt++; return false; }
      return transition(next, true, false, true);
    },
    registerUnsavedGuard: (guard: (route: WorkspaceRouteContext) => boolean | Promise<boolean>) => { guards.add(guard); return () => guards.delete(guard); }
  });
  return { port, initialValid, dispose() { disposed = true; attempt++; win?.removeEventListener('hashchange', onHash); listeners.clear(); guards.clear(); viewState.clear(); } };
}

function sameRoute(a: WorkspaceRouteContext, b: WorkspaceRouteContext): boolean {
  return a.routeId === b.routeId && a.workspaceId === b.workspaceId && a.kind === b.kind && JSON.stringify(a.params) === JSON.stringify(b.params) && JSON.stringify(a.query) === JSON.stringify(b.query);
}
function serializeRoute(route: WorkspaceRouteContext, workspaces: readonly NavigationWorkspace[], experience?: ProductExperience): string {
  return formatRoute(route.routeId, { params: route.params, query: route.query }, workspaces, experience) ?? '#/';
}

/** Pure parser exported for route contract tests and host-specific accessible recovery UI. */
export function parseWorkspaceRoute(hash: string, workspaces: readonly NavigationWorkspace[], experience?: ProductExperience): WorkspaceRouteContext | undefined {
  return routeForPath(hash, workspaces, experience);
}
