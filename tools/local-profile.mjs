/** Explicit local developer fixture policy. Not tenant provisioning or a grant resolver. */
export function localConfiguration(plan, profile, { credentials, dataDirectory, basePort = 4300, deskUrl } = {}) {
    if (profile.id !== 'quadbridge.local-developer.v1' || profile.profile !== 'loopback-developer-only') throw Error('Unsupported local profile');
    const remoteProfiles = plan.bindings.filter(b => b.mode === 'http').map(b => {
        const p = profile.connections.find(p => p.contract === b.contract);
        if (!p?.http) throw Error(`No reviewed local setup for ${b.consumer}:${b.contract}`);
        return p;
    });
    const tenantSets = remoteProfiles.map(p => JSON.stringify(p.http.sourceTenants));
    if (new Set(tenantSets).size > 1) throw Error('Conflicting local source-tenant profiles');
    const tenants = remoteProfiles[0]?.http.sourceTenants ?? profile.defaultTenants;
    const grants = tenants.map(tenantId => ({ tenantId, permissions: ['platform.shell.read', 'platform.modules.manage', ...plan.permissions] }));
    const readGrants = tenants.map(tenantId => ({ tenantId, permissions: ['platform.shell.read', ...new Set(plan.modules.flatMap(m => m.routes.filter(r => r.kind === 'read').map(r => r.permission)))] }));
    const principals = [{ id: 'admin', password: credentials.admin, grants }, { id: 'viewer', password: credentials.viewer, grants: readGrants }];
    // A reviewed developer seed is applicable by provided contract, NEVER product display name.
    for (const seed of profile.providerSeeds) {
        const provider = plan.modules.find(m => m.provides.includes(seed.contract));
        if (!provider) continue;
        if (!seed.permissions.every(p => provider.permissions.includes(p))) throw Error(`Local seed requests an undeclared provider permission for ${seed.contract}`);
        if (principals.some(p => p.id === seed.serviceActor)) throw Error('Local seed principal collision');
        principals.push({ id: seed.serviceActor, serviceToken: credentials.serviceToken, grants: tenants.map(tenantId => ({ tenantId, permissions: [...seed.permissions] })) });
    }
    const config = { instanceId: `${plan.product.id}-local`, dataDirectory, principals, connections: {} };
    for (const binding of plan.bindings) {
        const spec = profile.connections.find(p => p.contract === binding.contract);
        // Ports such as local document reads need no service principal/connection configuration.
        if (!spec && binding.mode === 'local') continue;
        if (!spec) throw Error('Unconfigured remote connection');
        if (binding.mode === 'local') {
            if (!principals.some(p => p.id === spec.serviceActor)) throw Error(`Local connection requires declared provider identity ${spec.serviceActor}`);
            config.connections[binding.instanceId] = { revision: spec.revision, mode: 'local', destinationProduct: plan.product.id, destinationInstance: config.instanceId,
                tenantMap: Object.fromEntries(tenants.map(t => [t, t])), serviceActor: spec.serviceActor };
        } else {
            const origin = deskUrl ?? `http://127.0.0.1:${basePort + spec.http.portOffset}`;
            const url = new URL(origin);
            if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.hash || url.search) throw Error('Demo remote destination must be an origin-only loopback HTTP address');
            config.connections[binding.instanceId] = { revision: spec.revision, mode: 'http', destinationProduct: spec.http.destinationProduct, destinationInstance: spec.http.destinationInstance,
                tenantMap: { ...spec.http.tenantMap }, baseUrl: url.origin, serviceActor: spec.serviceActor, serviceToken: credentials.serviceToken };
        }
    }
    return { config, tenants };
}
