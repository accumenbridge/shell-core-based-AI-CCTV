import { PlatformError } from './index.js';

export const PRODUCT_EXPERIENCE_SCHEMA = 'quadbridge.product-experience.v1' as const;
export type WorkspaceRouteKind = 'workspace' | 'record' | 'create' | 'edit';
export type BrowserProfile = 'quadbridge.browser-profile.native-esm.v1';

export interface ProductExperience {
  schema: typeof PRODUCT_EXPERIENCE_SCHEMA;
  designSystem: { id: 'quadbridge.standard'; version: '0.1.0' };
  browserProfile: BrowserProfile;
  brand: { name: string; tagline?: string; logoAssetId?: string };
  theme: { surface: 'light' | 'dark'; text: 'standard' | 'high-contrast'; accent: 'blue' | 'teal' | 'amber'; status: 'semantic'; density: 'comfortable' | 'compact' };
  login: { title: string; description: string; help: string };
  navigation: { id: string; workspaceId: string; label: string; group?: string; order: number; mobilePriority: number }[];
  routes: { id: string; workspaceId: string; kind: WorkspaceRouteKind }[];
  layoutByWorkspace: { workspaceId: string; mode: 'reading' | 'operational' }[];
}

export interface ProductExperienceSources {
  workspaceIds: readonly string[];
}

export interface WorkspaceRouteParams { id?: string }
export interface WorkspaceRouteQuery { q?: string; page?: string; filter?: string; sort?: string }
export interface WorkspaceRouteContext {
  readonly routeId: string;
  readonly workspaceId: string;
  readonly kind: WorkspaceRouteKind;
  readonly params: Readonly<WorkspaceRouteParams>;
  readonly query: Readonly<WorkspaceRouteQuery>;
}
export interface WorkspaceNavigationInput { params?: WorkspaceRouteParams; query?: WorkspaceRouteQuery }
export interface WorkspaceNavigationPort {
  current(): WorkspaceRouteContext;
  subscribe(listener: (route: WorkspaceRouteContext) => void): () => void;
  navigate(routeId: string, input?: WorkspaceNavigationInput): Promise<boolean>;
  registerUnsavedGuard(guard: (next: WorkspaceRouteContext) => boolean | Promise<boolean>): () => void;
}

const fail = (message: string): never => { throw new PlatformError('INVALID', message); };
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Invalid product experience object');
  const item = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) return fail('Invalid product experience fields');
  return item;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) return fail(`Invalid ${label}`);
  return value.trim();
}
function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._:-]{0,95}$/.test(value)) return fail(`Invalid ${label}`);
  return value;
}
function boundedIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 9999) return fail(`Invalid ${label}`);
  return value as number;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Validate bounded presentation data. Composition supplies selected-source IDs for cross-reference checks. */
export function validateProductExperience(value: unknown, sources?: ProductExperienceSources): ProductExperience {
  const root = record(value, ['schema', 'designSystem', 'browserProfile', 'brand', 'theme', 'login', 'navigation', 'routes', 'layoutByWorkspace']);
  if (root.schema !== PRODUCT_EXPERIENCE_SCHEMA) return fail('Unsupported product experience schema');
  const design = record(root.designSystem, ['id', 'version']);
  if (design.id !== 'quadbridge.standard' || design.version !== '0.1.0') return fail('Unsupported product design system');
  if (root.browserProfile !== 'quadbridge.browser-profile.native-esm.v1') return fail('Unsupported browser profile');
  const brandInput = record(root.brand, ['name'], ['tagline', 'logoAssetId']);
  const brand: ProductExperience['brand'] = { name: text(brandInput.name, 'brand name', 80) };
  if (brandInput.tagline !== undefined) brand.tagline = text(brandInput.tagline, 'brand tagline', 160);
  if (brandInput.logoAssetId !== undefined) {
    return fail('This browser profile does not declare a supported logo asset adapter');
  }
  const themeInput = record(root.theme, ['surface', 'text', 'accent', 'status', 'density']);
  if (typeof themeInput.surface !== 'string' || !['light', 'dark'].includes(themeInput.surface) ||
      typeof themeInput.text !== 'string' || !['standard', 'high-contrast'].includes(themeInput.text) ||
      typeof themeInput.accent !== 'string' || !['blue', 'teal', 'amber'].includes(themeInput.accent) ||
      themeInput.status !== 'semantic' || typeof themeInput.density !== 'string' || !['comfortable', 'compact'].includes(themeInput.density)) return fail('Unsupported product theme tokens');
  const loginInput = record(root.login, ['title', 'description', 'help']);
  const login = { title: text(loginInput.title, 'login title', 120), description: text(loginInput.description, 'login description', 500), help: text(loginInput.help, 'login help', 500) };
  if (!Array.isArray(root.navigation) || root.navigation.length < 1 || root.navigation.length > 64 || !Array.isArray(root.routes) || root.routes.length < 1 || root.routes.length > 128 || !Array.isArray(root.layoutByWorkspace) || root.layoutByWorkspace.length > 64) return fail('Invalid product navigation or route list');
  const sourceIds = sources ? new Set(sources.workspaceIds) : undefined;
  const navigation = root.navigation.map(raw => {
    const item = record(raw, ['id', 'workspaceId', 'label', 'order', 'mobilePriority'], ['group']);
    const id = safeId(item.id, 'navigation ID'), workspaceId = safeId(item.workspaceId, 'navigation workspace');
    if (sourceIds && !sourceIds.has(workspaceId)) return fail(`Navigation references unselected workspace ${workspaceId}`);
    const result: ProductExperience['navigation'][number] = { id, workspaceId, label: text(item.label, 'navigation label', 80), order: boundedIndex(item.order, 'navigation order'), mobilePriority: boundedIndex(item.mobilePriority, 'mobile priority') };
    if (item.group !== undefined) result.group = text(item.group, 'navigation group', 60);
    return result;
  });
  const navigationIds = new Set(navigation.map(item => item.id)), navWorkspaces = new Set(navigation.map(item => item.workspaceId));
  if (new Set(navigation.map(item => item.id)).size !== navigation.length || new Set(navigation.map(item => item.workspaceId)).size !== navigation.length || new Set(navigation.map(item => item.order)).size !== navigation.length || new Set(navigation.map(item => item.mobilePriority)).size !== navigation.length) return fail('Duplicate product navigation identity or order');
  const routes = root.routes.map(raw => {
    const item = record(raw, ['id', 'workspaceId', 'kind']);
    const id = safeId(item.id, 'route ID'), workspaceId = safeId(item.workspaceId, 'route workspace');
    if (typeof item.kind !== 'string' || !['workspace', 'record', 'create', 'edit'].includes(item.kind)) return fail('Unsupported product route kind');
    if (sourceIds && !sourceIds.has(workspaceId)) return fail(`Route references unselected workspace ${workspaceId}`);
    if (!navWorkspaces.has(workspaceId)) return fail(`Route references workspace without product navigation ${workspaceId}`);
    if (item.kind === 'workspace' && (!navigationIds.has(id) || navigation.find(nav => nav.id === id)?.workspaceId !== workspaceId)) return fail('Workspace route must match its navigation identity');
    return { id, workspaceId, kind: item.kind as WorkspaceRouteKind };
  });
  if (new Set(routes.map(item => item.id)).size !== routes.length || navigation.some(nav => !routes.some(route => route.id === nav.id && route.workspaceId === nav.workspaceId && route.kind === 'workspace'))) return fail('Duplicate or missing product workspace route');
  const layoutByWorkspace = root.layoutByWorkspace.map(raw => {
    const item = record(raw, ['workspaceId', 'mode']);
    const workspaceId = safeId(item.workspaceId, 'layout workspace');
    if (sourceIds && !sourceIds.has(workspaceId)) return fail(`Layout references unselected workspace ${workspaceId}`);
    if (!navWorkspaces.has(workspaceId) || typeof item.mode !== 'string' || !['reading', 'operational'].includes(item.mode)) return fail('Unsupported workspace layout');
    return { workspaceId, mode: item.mode as 'reading' | 'operational' };
  });
  if (new Set(layoutByWorkspace.map(item => item.workspaceId)).size !== layoutByWorkspace.length) return fail('Duplicate workspace layout');
  const theme: ProductExperience['theme'] = { surface: themeInput.surface as 'light' | 'dark', text: themeInput.text as 'standard' | 'high-contrast', accent: themeInput.accent as 'blue' | 'teal' | 'amber', status: 'semantic', density: themeInput.density as 'comfortable' | 'compact' };
  return deepFreeze({ schema: PRODUCT_EXPERIENCE_SCHEMA, designSystem: { id: 'quadbridge.standard', version: '0.1.0' }, browserProfile: root.browserProfile as BrowserProfile, brand, theme, login, navigation, routes, layoutByWorkspace });
}
