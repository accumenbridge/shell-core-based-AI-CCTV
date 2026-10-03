import { PLATFORM_ABI, PlatformError, type ModuleManifest } from '@quadbridge/contracts';
import { validateModuleManifest } from '@quadbridge/contracts/module-manifest';
import { validateStudioModule, type ModuleStudioMetadata, type StudioModuleManifest } from '@quadbridge/studio-model';

export type ModuleDefinition = Omit<ModuleManifest,'abi'> & { abi?: typeof PLATFORM_ABI; studio?: ModuleStudioMetadata };
export function defineModule(definition: ModuleDefinition): StudioModuleManifest {
  const detached = clonePlainData(definition) as ModuleDefinition;
  if (Object.hasOwn(detached, 'abi') && detached.abi !== PLATFORM_ABI)
    throw new PlatformError('INVALID', 'Unsupported module ABI');
  const manifest: StudioModuleManifest = { ...detached, abi: PLATFORM_ABI };
  validateModuleManifest(manifest);
  validateStudioModule(manifest);
  return deepFreeze(manifest);
}

const MAX_CLONE_NODES = 16_384;
const MAX_CLONE_DEPTH = 32;
const MAX_CLONE_ARRAY = 1024;
function clonePlainData(value: unknown): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  const clone = (item: unknown, depth: number): unknown => {
    if (++nodes > MAX_CLONE_NODES || depth > MAX_CLONE_DEPTH) throw new PlatformError('INVALID', 'Module definition is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object') throw new PlatformError('INVALID', 'Module definition must contain plain data');
    if (ancestors.has(item)) throw new PlatformError('INVALID', 'Module definition cannot contain cycles');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new PlatformError('INVALID', 'Module definition must use plain objects and arrays');
    ancestors.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (array) {
        const length = (item as unknown[]).length;
        if (length > MAX_CLONE_ARRAY || keys.some(key => typeof key !== 'string' ||
            (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length))))
          throw new PlatformError('INVALID', 'Module definition array is too large or has extra properties');
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            throw new PlatformError('INVALID', 'Module definition arrays must contain dense data values');
          result.push(clone(descriptor.value, depth + 1));
        }
        return result;
      }
      if (keys.length > 1024) throw new PlatformError('INVALID', 'Module definition object is too large');
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string') throw new PlatformError('INVALID', 'Module definition cannot contain symbol keys');
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new PlatformError('INVALID', 'Module definition cannot contain accessors or hidden properties');
        Object.defineProperty(result, key, { value: clone(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };
  return clone(value, 0);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
export function capability(contract:string){if(!/^[a-z][a-z0-9_.-]{2,127}$/.test(contract))throw new PlatformError('INVALID','Invalid capability contract');return contract;}
export function permission(name:string){if(!/^[a-z][a-z0-9_.-]{2,127}$/.test(name))throw new PlatformError('INVALID','Invalid permission');return name;}
