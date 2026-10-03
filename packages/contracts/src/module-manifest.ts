import { PLATFORM_ABI, PlatformError, type ModuleManifest } from './index.js';

// Keep the historical descriptor grammar (including one-character IDs and dotted names);
// source-directory generators apply their own narrower path policy.
const MODULE_ID = /^[a-z][a-z0-9.-]{0,95}$/;
/** The platform supports exact stable versions only; ranges and prereleases are not runtime identities. */
export const EXACT_MODULE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CAPABILITY = /^[a-z][a-z0-9_.-]{2,127}$/;
const IDENTIFIER = /^[a-z][a-z0-9.-]{1,127}$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_NODES = 16_384;
const MAX_ARRAY_ITEMS = 1024;
const MAX_OBJECT_PROPERTIES = 1024;
const MAX_DEPTH = 32;

function invalid(message: string): never {
  throw new PlatformError('INVALID', message);
}

/** Inspect data descriptors only, so validating a declaration never calls user getters. */
function assertPlainData(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid('Module manifest is too complex');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object') invalid('Module manifest must contain plain data');
    if (ancestors.has(current)) invalid('Module manifest cannot contain cycles');
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      invalid('Module manifest must use plain objects and arrays');
    ancestors.add(current);
    try {
      const keys = Reflect.ownKeys(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (array) {
        const length = (current as unknown[]).length;
        if (length > MAX_ARRAY_ITEMS || keys.some(key => typeof key !== 'string' ||
            (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length))))
          invalid('Module manifest array is too large or has extra properties');
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            invalid('Module manifest arrays must contain dense data values');
          visit(descriptor.value, depth + 1);
        }
      } else {
        if (keys.length > MAX_OBJECT_PROPERTIES) invalid('Module manifest object is too large');
        for (const key of keys) {
          if (typeof key !== 'string') invalid('Module manifest cannot contain symbol keys');
          const descriptor = descriptors[key];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            invalid('Module manifest cannot contain accessors or hidden properties');
          visit(descriptor.value, depth + 1);
        }
      }
    } finally {
      ancestors.delete(current);
    }
  };
  visit(value, 0);
}

function record(value: unknown, label: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid module ${label}`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key)))
    invalid(`Invalid module ${label} fields`);
  return result;
}

function text(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid(`Invalid module ${label}`);
}

function stringList(value: unknown, label: string, predicate: RegExp): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || value.some(item => typeof item !== 'string' || !predicate.test(item)))
    invalid(`Invalid module ${label}`);
  if (new Set(value).size !== value.length) invalid(`Duplicate module ${label}`);
}

/** Validate the shared base declaration. Cross-module resolution remains the composition resolver's job. */
export function validateModuleManifest(value: unknown): ModuleManifest {
  assertPlainData(value);
  const manifest = record(value, 'manifest', [
    'id', 'version', 'abi', 'dependencies', 'provides', 'requires', 'permissions', 'routes', 'workspaces',
    'uiContributions', 'schema', 'background', 'operations', 'browserAssets', 'studio'
  ], ['id', 'version', 'abi', 'dependencies', 'provides', 'requires', 'permissions', 'routes', 'workspaces', 'schema', 'background']);

  if (typeof manifest.id !== 'string' || !MODULE_ID.test(manifest.id)) invalid('Invalid module id');
  if (typeof manifest.version !== 'string' || manifest.version.length > 128 || !EXACT_MODULE_VERSION.test(manifest.version))
    invalid('Module version must be an exact supported SemVer');
  if (manifest.abi !== PLATFORM_ABI) invalid('Unsupported module ABI');

  const dependencies = manifest.dependencies;
  if (!Array.isArray(dependencies) || dependencies.length > MAX_ARRAY_ITEMS) invalid('Invalid module dependencies');
  const dependencyIds = new Set<string>();
  for (const raw of dependencies) {
    const dependency = record(raw, 'dependency', ['id', 'version', 'optional'], ['id', 'version']);
    if (typeof dependency.id !== 'string' || !MODULE_ID.test(dependency.id) || dependencyIds.has(dependency.id) ||
        typeof dependency.version !== 'string' || !EXACT_MODULE_VERSION.test(dependency.version) ||
        (dependency.optional !== undefined && typeof dependency.optional !== 'boolean')) invalid('Invalid module dependency');
    dependencyIds.add(dependency.id);
  }

  stringList(manifest.provides, 'provided contracts', CAPABILITY);
  stringList(manifest.requires, 'required contracts', CAPABILITY);
  stringList(manifest.permissions, 'permissions', CAPABILITY);

  if (!Array.isArray(manifest.routes) || manifest.routes.length > MAX_ARRAY_ITEMS) invalid('Invalid module routes');
  const routeIds = new Set<string>();
  for (const raw of manifest.routes) {
    const route = record(raw, 'route', ['method', 'path', 'permission', 'kind'], ['method', 'path', 'permission', 'kind']);
    text(route.path, 'route path', 256);
    text(route.permission, 'route permission', 128);
    if (!['GET', 'POST'].includes(String(route.method)) || !/^\/api\/[a-z0-9/-]+$/.test(route.path) ||
        !CAPABILITY.test(route.permission) || !['read', 'write'].includes(String(route.kind)))
      invalid('Invalid module route');
    if (!(manifest.permissions as string[]).includes(route.permission)) invalid('Undeclared route permission');
    const identity = `${route.method} ${route.path}`;
    if (routeIds.has(identity)) invalid('Duplicate route');
    routeIds.add(identity);
  }

  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.length > MAX_ARRAY_ITEMS) invalid('Invalid module workspaces');
  const workspaceIds = new Set<string>(), workspacePaths = new Set<string>();
  for (const raw of manifest.workspaces) {
    const workspace = record(raw, 'workspace', ['id', 'label', 'path', 'permission', 'export'], ['id', 'label', 'path', 'permission', 'export']);
    text(workspace.id, 'workspace id', 128);
    text(workspace.label, 'workspace label', 120);
    text(workspace.path, 'workspace path', 256);
    text(workspace.permission, 'workspace permission', 128);
    text(workspace.export, 'workspace export', 128);
    if (!IDENTIFIER.test(workspace.id) || !/^\/[a-z0-9/-]+$/.test(workspace.path) ||
        !CAPABILITY.test(workspace.permission) || !EXPORT_NAME.test(workspace.export))
      invalid('Invalid module workspace');
    if (!(manifest.permissions as string[]).includes(workspace.permission)) invalid('Undeclared workspace permission');
    if (workspaceIds.has(workspace.id)) invalid('Duplicate workspace id');
    if (workspacePaths.has(workspace.path)) invalid('Duplicate workspace path');
    workspaceIds.add(workspace.id);
    workspacePaths.add(workspace.path);
  }

  const schema = record(manifest.schema, 'schema', ['current', 'readMin', 'readMax'], ['current', 'readMin', 'readMax']);
  if (![schema.current, schema.readMin, schema.readMax].every(item => Number.isSafeInteger(item) && (item as number) >= 0) ||
      (schema.readMin as number) > (schema.current as number) || (schema.current as number) > (schema.readMax as number))
    invalid('Invalid module schema reader envelope');
  if (typeof manifest.background !== 'boolean') invalid('Invalid module background declaration');

  if (manifest.uiContributions !== undefined && !Array.isArray(manifest.uiContributions)) invalid('Invalid module UI contributions');
  if (manifest.operations !== undefined && !Array.isArray(manifest.operations)) invalid('Invalid module operations');
  if (manifest.browserAssets !== undefined) {
    if (!Array.isArray(manifest.browserAssets) || manifest.browserAssets.length > MAX_ARRAY_ITEMS || manifest.browserAssets.some(asset =>
        typeof asset !== 'string' || !asset || asset.startsWith('/') || asset.includes('\\') || asset.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))))
      invalid('Invalid module browser assets');
    if (new Set(manifest.browserAssets).size !== manifest.browserAssets.length) invalid('Duplicate module browser asset');
  }
  if (manifest.studio !== undefined && (!manifest.studio || typeof manifest.studio !== 'object' || Array.isArray(manifest.studio)))
    invalid('Invalid module Studio metadata');
  return value as ModuleManifest;
}
