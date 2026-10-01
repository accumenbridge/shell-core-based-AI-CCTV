import { PLATFORM_ABI, PlatformError, type ModuleManifest } from '@quadbridge/contracts';
import { validateStudioModule, type ModuleStudioMetadata, type StudioModuleManifest } from '@quadbridge/studio-model';

export type ModuleDefinition = Omit<ModuleManifest,'abi'> & { abi?: typeof PLATFORM_ABI; studio?: ModuleStudioMetadata };
export function defineModule(definition: ModuleDefinition): StudioModuleManifest {
  const manifest: StudioModuleManifest = { ...definition, abi: PLATFORM_ABI };
  return Object.freeze(validateStudioModule(manifest));
}
export function capability(contract:string){if(!/^[a-z][a-z0-9_.-]{2,127}$/.test(contract))throw new PlatformError('INVALID','Invalid capability contract');return contract;}
export function permission(name:string){if(!/^[a-z][a-z0-9_.-]{2,127}$/.test(name))throw new PlatformError('INVALID','Invalid permission');return name;}
