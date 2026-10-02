import { validSourceDirectoryId, type CompositionPlan } from '@quadbridge/contracts';

export interface RuntimeWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  version: string;
  kind: 'host' | 'module';
}

export interface RuntimeWorkspaceClosure {
  roots: readonly RuntimeWorkspaceRoot[];
  dependencies: Readonly<Record<string, string>>;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const REVIEWED_HOST_ROOTS = ['contracts', 'composition', 'sqlite', 'local-access', 'backend-host', 'web-shell'] as const;
const REVIEWED_PACKAGES = new Set([...REVIEWED_HOST_ROOTS, 'worker-host', 'connections', 'ai-core', 'client-core']);

/** Resolve only packages reachable from the fixed host roots and selected module roots. */
export function deriveRuntimeWorkspaceClosure(
  plan: Pick<CompositionPlan, 'modules' | 'bindings' | 'requiresWorker'>,
  readManifest: (relativePath: string) => unknown
): RuntimeWorkspaceClosure {
  if (!plan || !Array.isArray(plan.modules) || !Array.isArray(plan.bindings) || typeof plan.requiresWorker !== 'boolean')
    throw new Error('Malformed runtime workspace plan');

  const selectedModules = new Map<string, string>();
  for (const module of plan.modules) {
    if (!module || !validSourceDirectoryId(module.id) || !EXACT_VERSION.test(module.version) || selectedModules.has(module.id))
      throw new Error('Malformed or duplicate selected module');
    selectedModules.set(module.id, module.version);
  }

  if ([...selectedModules.keys()].some(id => REVIEWED_PACKAGES.has(id))) throw new Error('Module and reviewed package identifiers collide');

  const roots = new Map<string, RuntimeWorkspaceRoot>();
  const active = new Set<string>();
  const visited = new Set<string>();
  const dependencies: Record<string, string> = {};

  const hostIds = [...REVIEWED_HOST_ROOTS, ...(plan.requiresWorker ? ['worker-host'] : []), ...(plan.bindings.length ? ['connections'] : [])];
  const requested: { id: string; kind: 'host' | 'module'; version?: string }[] = [
    ...hostIds.map(id => ({ id, kind: 'host' as const })),
    ...[...selectedModules].map(([id, version]) => ({ id, kind: 'module' as const, version }))
  ];

  function visit(id: string, kind: 'host' | 'module', expectedVersion?: string): void {
    const key = `${kind}:${id}`;
    if (active.has(key)) throw new Error('Runtime workspace dependency cycle');
    if (visited.has(key)) {
      if (expectedVersion !== undefined && roots.get(key)?.version !== expectedVersion) throw new Error('Workspace dependency version mismatch');
      return;
    }
    if (kind === 'host' && !REVIEWED_PACKAGES.has(id)) throw new Error('Unreviewed host workspace dependency');
    if (kind === 'module' && !selectedModules.has(id)) throw new Error('Unselected module workspace dependency');

    active.add(key);
    const path = `${kind === 'host' ? 'packages' : 'modules'}/${id}`;
    const value = readManifest(`${path}/package.json`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed workspace package manifest');
    const manifest = value as Record<string, unknown>;
    const version = manifest.version;
    if (manifest.name !== `@quadbridge/${id}` || typeof version !== 'string' || !EXACT_VERSION.test(version) ||
        (expectedVersion !== undefined && expectedVersion !== version))
      throw new Error('Workspace package identity or exact version mismatch');
    roots.set(key, { id, name: `@quadbridge/${id}`, path, version, kind });
    dependencies[`@quadbridge/${id}`] = version;

    const packageDependencies = manifest.dependencies;
    if (packageDependencies !== undefined && (!packageDependencies || typeof packageDependencies !== 'object' || Array.isArray(packageDependencies)))
      throw new Error('Malformed workspace dependency map');
    for (const [name, dependencyVersion] of Object.entries((packageDependencies ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const prefix = '@quadbridge/';
      const dependencyId = typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : '';
      if (!validSourceDirectoryId(dependencyId) || typeof dependencyVersion !== 'string' || !EXACT_VERSION.test(dependencyVersion))
        throw new Error('Runtime workspace dependencies must be exact reviewed local packages');
      const dependencyKind = selectedModules.has(dependencyId) ? 'module' : 'host';
      if (dependencyKind === 'host' && !REVIEWED_PACKAGES.has(dependencyId))
        throw new Error('Runtime workspace dependency is not selected or reviewed');
      const selectedVersion = dependencyKind === 'module' ? selectedModules.get(dependencyId) : undefined;
      if (selectedVersion !== undefined && dependencyVersion !== selectedVersion)
        throw new Error('Selected module dependency version mismatch');
      visit(dependencyId, dependencyKind, dependencyVersion);
    }
    active.delete(key);
    visited.add(key);
  }

  for (const root of requested) visit(root.id, root.kind, root.version);
  return {
    roots: [...roots.values()].sort((a, b) => a.path.localeCompare(b.path)),
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
  };
}
