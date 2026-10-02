import { PlatformError, type CompositionPlan, type ModuleManifest, type Scope } from './index.js';

export const UI_CONTRIBUTION_SLOTS = ['workspace.aside', 'workspace.footer'] as const;
export type UiContributionSlot = typeof UI_CONTRIBUTION_SLOTS[number];

export interface UiContributionDescriptor {
  /** Module-qualified identity, for example `knowledge.referenceSearch`. */
  id: string;
  permission: string;
  /** Exact named export from the statically selected module UI loader. */
  export: string;
  label: string;
}

export interface UiContributionMappingEntry {
  workspaceId: string;
  slot: UiContributionSlot;
  contributionId: string;
  optional?: boolean;
}

export interface UiContributionBinding extends Omit<UiContributionMappingEntry, 'optional'> {}
export interface UiContributionMapping {
  schema: 'quadbridge.ui-slots.v1';
  bindings: UiContributionMappingEntry[];
}
export interface UiContributionOmission {
  workspaceId: string;
  slot: UiContributionSlot;
  contributionId: string;
  reason: 'WORKSPACE_MODULE_NOT_SELECTED' | 'CONTRIBUTION_MODULE_NOT_SELECTED';
}
export interface UiContributionResolution {
  bindings: readonly UiContributionBinding[];
  omitted: readonly UiContributionOmission[];
}

export interface UiContributionContext {
  root: HTMLElement;
  scope: Scope;
  actor: { id: string; kind: string };
  signal: AbortSignal;
  locale: string;
  permissions: readonly string[];
  api: { get(path: string, signal?: AbortSignal): Promise<unknown> };
  notice(message: string): void;
}
export interface UiContribution {
  mount(context: UiContributionContext): (() => void) | void;
}

function fail(message: string): never { throw new PlatformError('INVALID', message); }
const identifier = /^[a-z][a-z0-9.-]{1,127}$/;
const qualifiedIdentity = /^[a-z][A-Za-z0-9.-]{1,127}$/;
const permissionName = /^[a-z][a-z0-9_.-]{2,127}$/;
const exportName = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
function closedRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`Invalid ${label}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) fail(`Unknown ${label} field`);
  return record;
}

/** Validates the small closed descriptor shape at every source/catalogue/host boundary. */
export function validateUiContributionDescriptors(module: Pick<ModuleManifest, 'id' | 'permissions' | 'uiContributions'>): readonly UiContributionDescriptor[] {
  const entries = module.uiContributions;
  if (entries === undefined) return Object.freeze([]);
  if (!Array.isArray(entries) || entries.length > 16 || typeof module.id !== 'string' || !identifier.test(module.id) ||
      !Array.isArray(module.permissions) || module.permissions.some(permission => typeof permission !== 'string'))
    fail('Invalid module UI contributions');
  const ids = new Set<string>(), exports = new Set<string>();
  const result: UiContributionDescriptor[] = [];
  for (const raw of entries) {
    const value = closedRecord(raw, ['id', 'permission', 'export', 'label'], 'UI contribution descriptor');
    const { id, permission, export: exportNameValue, label } = value;
    if (typeof id !== 'string' || !qualifiedIdentity.test(id) || !id.startsWith(`${module.id}.`) ||
        typeof permission !== 'string' || !permissionName.test(permission) || !module.permissions.includes(permission) ||
        typeof exportNameValue !== 'string' || !exportName.test(exportNameValue) || exportNameValue === 'default' ||
        typeof label !== 'string' || !label.trim() || label.length > 120 || label.includes('\0')) fail('Invalid UI contribution descriptor');
    if (ids.has(id) || exports.has(exportNameValue)) fail('Duplicate UI contribution identity or export');
    ids.add(id); exports.add(exportNameValue);
    result.push(Object.freeze({ id, permission, export: exportNameValue, label }));
  }
  return Object.freeze(result);
}

/** Resolves only the two reviewed slots against selected workspaces and owner declarations. */
export function resolveUiContributionBindings(plan: CompositionPlan, input: unknown, sourceModules: readonly ModuleManifest[] = plan.modules): UiContributionResolution {
  const mapping = closedRecord(input, ['schema', 'bindings'], 'UI contribution mapping');
  const entries = mapping.bindings;
  if (mapping.schema !== 'quadbridge.ui-slots.v1' || !Array.isArray(entries) || entries.length > 32)
    fail('Invalid UI contribution mapping');
  const modules = new Map(plan.modules.map(module => [module.id, module]));
  const sourceById = new Map(sourceModules.map(module => [module.id, module]));
  if (sourceById.size !== sourceModules.length) fail('Duplicate source module for UI contribution mapping');
  const workspaces = new Map<string, string>();
  for (const module of plan.modules) for (const workspace of module.workspaces) {
    if (workspaces.has(workspace.id)) fail(`Duplicate selected workspace ${workspace.id}`);
    workspaces.set(workspace.id, module.id);
  }
  const sourceWorkspaces = new Map<string, string>();
  for (const module of sourceModules) for (const workspace of module.workspaces) {
    if (sourceWorkspaces.has(workspace.id)) fail(`Duplicate source workspace ${workspace.id}`);
    sourceWorkspaces.set(workspace.id, module.id);
  }
  const descriptors = new Map<string, { moduleId: string; descriptor: UiContributionDescriptor }>();
  for (const module of sourceModules) for (const descriptor of validateUiContributionDescriptors(module)) {
    if (descriptors.has(descriptor.id)) fail(`Duplicate source UI contribution ${descriptor.id}`);
    descriptors.set(descriptor.id, { moduleId: module.id, descriptor });
  }

  const identities = new Set<string>(), counts = new Map<string, number>();
  const bindings: UiContributionBinding[] = [], omitted: UiContributionOmission[] = [];
  for (const raw of entries) {
    const value = closedRecord(raw, ['workspaceId', 'slot', 'contributionId', 'optional'], 'UI contribution binding');
    const { workspaceId, slot, contributionId, optional } = value;
    if (typeof workspaceId !== 'string' || !identifier.test(workspaceId) ||
        typeof slot !== 'string' || !(UI_CONTRIBUTION_SLOTS as readonly string[]).includes(slot) ||
        typeof contributionId !== 'string' || !qualifiedIdentity.test(contributionId) ||
        (optional !== undefined && typeof optional !== 'boolean')) fail('Invalid UI contribution binding');
    const entry = { workspaceId, slot: slot as UiContributionSlot, contributionId };
    const identity = `${workspaceId}\0${slot}\0${contributionId}`;
    if (identities.has(identity)) fail('Duplicate UI contribution binding');
    identities.add(identity);
    const workspaceModuleId = sourceWorkspaces.get(workspaceId);
    const target = descriptors.get(contributionId);
    // Ownership comes from the declaring module, never from parsing either id.
    // Workspace ids are product-neutral and may be namespaced independently of
    // their owning module (for example service-desk owns `desk.requests`).
    if (!workspaceModuleId || !target) fail('UI contribution mapping names an unknown source declaration');
    const contributionOwner = target.moduleId;
    const workspaceModule = modules.get(workspaceModuleId);
    const ownerModule = modules.get(contributionOwner);
    if (!workspaceModule) {
      if (optional === true) { omitted.push({ ...entry, reason: 'WORKSPACE_MODULE_NOT_SELECTED' }); continue; }
      fail(`UI contribution workspace module ${workspaceModuleId} is not selected`);
    }
    if (!ownerModule) {
      if (optional === true) { omitted.push({ ...entry, reason: 'CONTRIBUTION_MODULE_NOT_SELECTED' }); continue; }
      fail(`UI contribution owner ${contributionOwner} is not selected`);
    }
    if (!workspaces.has(workspaceId)) fail(`UI contribution workspace ${workspaceId} is not declared by the selected plan`);
    const selectedDescriptor = validateUiContributionDescriptors(ownerModule).find(item => item.id === contributionId);
    if (target.moduleId !== contributionOwner || !selectedDescriptor ||
        selectedDescriptor.permission !== target.descriptor.permission ||
        selectedDescriptor.export !== target.descriptor.export ||
        selectedDescriptor.label !== target.descriptor.label)
      fail(`UI contribution ${contributionId} is not declared by its selected owner`);
    const count = (counts.get(workspaceId) ?? 0) + 1;
    if (count > 8) fail(`Too many UI contributions for workspace ${workspaceId}`);
    counts.set(workspaceId, count);
    bindings.push(Object.freeze(entry));
  }
  return Object.freeze({ bindings: Object.freeze(bindings), omitted: Object.freeze(omitted.map(item => Object.freeze(item))) });
}
