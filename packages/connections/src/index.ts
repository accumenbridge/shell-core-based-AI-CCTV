import { PlatformError, canonical, object, id, integer, type CommittedReceipt, type ReceiptCommand, type ConnectionCall, type Scope, type Actor } from '@quadbridge/contracts';
export interface ConnectionBinding {
    id: string;
    revision: string;
    sourceProduct: string;
    destinationProduct: string;
    destinationInstance: string;
    serviceActor: string;
    contract: string;
    mode: 'local' | 'http';
    tenantMap: Readonly<Record<string, string>>;
    baseUrl?: string;
    path: string;
    serviceToken?: string;
}
/** A provider-owned protocol opts in; ordinary endpoints are not inferred to return receipts. */
export interface ReceiptProtocol {
    contract: string;
    resourceType: string;
    receiptPath: string;
}
export function validateReceipt(value: unknown, protocol: ReceiptProtocol, target: Scope, commandId: string, expectedActor?: Actor): CommittedReceipt {
    try {
        const r = object(value, ['schema', 'contract', 'outcome', 'commandId', 'destination', 'actor', 'resource']);
        const d = object(r.destination, ['productId', 'instanceId', 'tenantId']);
        const a = object(r.actor, ['id', 'kind']);
        if (!['user', 'service'].includes(String(a.kind)) || (expectedActor && (a.id !== expectedActor.id || a.kind !== expectedActor.kind)))
            throw Error('Receipt principal mismatch');
        const resource = object(r.resource, ['type', 'id', 'version']);
        if (r.schema !== 'quadbridge.command-receipt.v1' || r.contract !== protocol.contract || r.outcome !== 'COMMITTED' || r.commandId !== commandId ||
            d.productId !== target.productId || d.instanceId !== target.instanceId || d.tenantId !== target.tenantId || resource.type !== protocol.resourceType)
            throw new Error('Receipt correlation mismatch');
        return { schema: 'quadbridge.command-receipt.v1', contract: protocol.contract, outcome: 'COMMITTED', commandId: id(commandId),
            destination: { productId: id(d.productId), instanceId: id(d.instanceId), tenantId: id(d.tenantId) }, actor: { id: id(a.id), kind: a.kind as 'user' | 'service' }, resource: { type: id(resource.type), id: id(resource.id), version: integer(resource.version, 1) } };
    }
    catch {
        throw new PlatformError('INCOMPATIBLE', 'Destination did not provide a compatible committed receipt; acceptance remains unresolved');
    }
}
function targetResolver(binding: ConnectionBinding) {
    const productId = id(binding.destinationProduct), instanceId = id(binding.destinationInstance);
    const map = Object.freeze({ ...binding.tenantMap });
    return (sourceTenant: string): Scope => {
        const tenantId = Object.hasOwn(map, sourceTenant) ? map[sourceTenant] : undefined;
        if (!tenantId)
            throw new PlatformError('DENIED', 'No approved tenant relationship');
        return Object.freeze({ productId, instanceId, tenantId: id(tenantId) });
    };
}
async function readJson(response: Response): Promise<unknown> {
    if (Number(response.headers.get('content-length') ?? 0) > 65536) {
        await response.body?.cancel();
        throw new PlatformError('INCOMPATIBLE', 'Response exceeds budget');
    }
    const reader = response.body?.getReader();
    if (!reader)
        throw new PlatformError('INCOMPATIBLE', 'Empty response');
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.length;
            if (size > 65536) {
                await reader.cancel();
                throw new PlatformError('INCOMPATIBLE', 'Response exceeds budget');
            }
            parts.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        throw new PlatformError('INCOMPATIBLE', 'Invalid destination response');
    }
}
function responseStatus(response: Response) {
    if (response.status === 401 || response.status === 403)
        throw new PlatformError('DENIED', 'Destination refused the configured service identity');
    if (response.status === 404)
        throw new PlatformError('NOT_FOUND', 'Receipt or operation is not available');
    if (response.status === 409)
        throw new PlatformError('CONFLICT', 'Destination identity or command conflicts');
    if (response.status === 400)
        throw new PlatformError('INVALID', 'Destination rejected the input');
    if (!response.ok)
        throw new PlatformError('UNAVAILABLE', 'Destination acceptance is unresolved');
    if (response.status !== 200)
        throw new PlatformError('INCOMPATIBLE', 'This protocol requires a committed 200 receipt, not queued acceptance');
}
/** Fixed endpoint, destination-authenticated identity, destination-owned result validation. */
export function httpCommand(inputBinding: ConnectionBinding, protocol: ReceiptProtocol, fetcher: typeof fetch = fetch): ReceiptCommand {
    const binding = Object.freeze({ ...inputBinding, tenantMap: Object.freeze({ ...inputBinding.tenantMap }) });
    if (binding.mode !== 'http' || !binding.baseUrl || !binding.serviceToken)
        throw new PlatformError('INCOMPATIBLE', 'Missing HTTP binding');
    const base = new URL(binding.baseUrl);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/')
        throw new PlatformError('INCOMPATIBLE', 'Origin-only destination required');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))
        throw new PlatformError('INCOMPATIBLE', 'Remote binding requires HTTPS');
    if (!protocol || binding.contract !== protocol.contract || !/^\/api\/[a-z0-9/-]+$/.test(binding.path) || !/^\/api\/[a-z0-9/-]+$/.test(protocol.receiptPath))
        throw new PlatformError('INCOMPATIBLE', 'Unsupported fixed operation protocol');
    const target = targetResolver(binding);
    const actor: Actor = Object.freeze({ id: id(binding.serviceActor), kind: 'service' });
    const bindingKey = canonical({ id: binding.id, revision: binding.revision, contract: binding.contract, product: binding.destinationProduct, instance: binding.destinationInstance, actor, tenantMap: binding.tenantMap, mode: binding.mode, path: binding.path, origin: binding.baseUrl ?? null });
    async function execute(call: ConnectionCall, lookup: boolean): Promise<CommittedReceipt> {
        const scope = target(call.sourceTenant);
        id(call.commandId);
        const signal = AbortSignal.any([call.signal, AbortSignal.timeout(5000)]);
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.serviceToken}`, 'X-QB-Tenant': scope.tenantId,
            'X-QB-Destination-Instance': scope.instanceId, 'X-QB-Destination-Principal': actor.id, 'X-QB-Destination-Product': scope.productId, 'Idempotency-Key': call.commandId };
        try {
            // Preflight is not the only guard: the destination rechecks the expected identity on POST.
            const hello = await fetcher(new URL('/api/bootstrap', base), { method: 'GET', redirect: 'error', headers, signal });
            responseStatus(hello);
            const data = await readJson(hello) as {
                scope?: Scope;
                actor?: Actor;
            };
            if (data?.scope?.productId !== scope.productId || data?.scope?.instanceId !== scope.instanceId || data?.scope?.tenantId !== scope.tenantId || data.actor?.id !== actor.id || data.actor?.kind !== actor.kind)
                throw new PlatformError('INCOMPATIBLE', 'Destination does not match the selected product/instance/tenant');
            const path = new URL(lookup ? protocol.receiptPath : binding.path, base);
            if (lookup)
                path.searchParams.set('commandId', call.commandId);
            else {
                signal.throwIfAborted();
                await call.beforeDispatch?.();
            }
            const response = await fetcher(path, { method: lookup ? 'GET' : 'POST', redirect: 'error', headers, signal, ...(lookup ? {} : { body: JSON.stringify(call.input) }) });
            try {
                responseStatus(response);
            }
            catch (e) {
                await response.body?.cancel();
                throw e;
            }
            return validateReceipt(await readJson(response), protocol, scope, call.commandId, actor);
        }
        catch (e) {
            if (e instanceof PlatformError)
                throw e;
            throw new PlatformError('UNAVAILABLE', 'Remote acceptance is unknown; reconcile the original operation identity');
        }
    }
    return { bindingKey, target, call: call => execute(call, false), lookup: call => execute(call, true) };
}
export function localCommand(inputBinding: ConnectionBinding, protocol: ReceiptProtocol, provider: {
    identity(tenant: string): Scope;
    invoke(tenant: string, input: unknown, key: string, signal: AbortSignal): unknown | Promise<unknown>;
    lookup(tenant: string, key: string, signal: AbortSignal): unknown | Promise<unknown>;
}): ReceiptCommand {
    const binding = { ...inputBinding, tenantMap: { ...inputBinding.tenantMap } };
    if (binding.mode !== 'local' || binding.contract !== protocol.contract)
        throw new PlatformError('INCOMPATIBLE', 'Unsupported local binding');
    const target = targetResolver(binding);
    const actor: Actor = Object.freeze({ id: id(binding.serviceActor), kind: 'service' });
    const bindingKey = canonical({ id: binding.id, revision: binding.revision, contract: binding.contract, product: binding.destinationProduct, instance: binding.destinationInstance, actor, tenantMap: binding.tenantMap, mode: binding.mode, path: binding.path, origin: binding.baseUrl ?? null });
    async function execute(call: ConnectionCall, lookup: boolean) {
        const scope = target(call.sourceTenant), actual = provider.identity(scope.tenantId);
        if (actual.productId !== scope.productId || actual.instanceId !== scope.instanceId || actual.tenantId !== scope.tenantId)
            throw new PlatformError('INCOMPATIBLE', 'Local destination identity mismatch');
        call.signal.throwIfAborted();
        if (!lookup)
            await call.beforeDispatch?.();
        const result = lookup ? await provider.lookup(scope.tenantId, call.commandId, call.signal) : await provider.invoke(scope.tenantId, call.input, call.commandId, call.signal);
        return validateReceipt(result, protocol, scope, call.commandId, actor);
    }
    return { bindingKey, target, call: call => execute(call, false), lookup: call => execute(call, true) };
}
