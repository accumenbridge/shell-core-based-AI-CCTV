/** Product-neutral public contracts. No Camera, Document, Work or other domain entity. */
import type { OperationDescriptor } from './operations.js';
export const PLATFORM_ABI = 'quadbridge.module.v1' as const;
/** Shared lowercase source/package identity envelope used by generators and composition. */
export const validSourceDirectoryId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z][a-z0-9-]{1,47}$/.test(value);
export type Mode = 'enabled' | 'read-only' | 'off';
export interface Actor {
    readonly id: string;
    readonly kind: 'user' | 'service';
}
export interface Scope {
    readonly productId: string;
    readonly instanceId: string;
    readonly tenantId: string;
}
export interface RequestContext extends Scope {
    readonly actor: Actor;
    readonly requestId: string;
    readonly signal: AbortSignal;
    /** Called at consequential decision points; not a global distributed transaction. */
    assertAllowed(permission: string, kind: 'read' | 'write'): void;
    /** Optional HTTP adapter recheck for the same credentials that opened this request. */
    assertOriginalAuth?(): void;
}
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type FailureCode = 'INVALID' | 'UNAUTHENTICATED' | 'DENIED' | 'NOT_FOUND' | 'CONFLICT' | 'DISABLED' | 'UNAVAILABLE' | 'STALE_ATTEMPT' | 'INCOMPATIBLE' | 'EXHAUSTED';
export class PlatformError extends Error {
    constructor(public readonly code: FailureCode, message: string) { super(message); this.name = 'PlatformError'; }
}
export function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition)
        throw new PlatformError('INVALID', message);
}
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
    const record = value as Record<string, unknown>;
    requireValue(Object.keys(record).every(k => allowed.includes(k)), 'Unexpected input field');
    return record;
}
export function text(value: unknown, label: string, max = 256): string {
    requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), `Invalid ${label}`);
    return value.trim();
}
export function id(value: unknown): string {
    requireValue(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value), 'Invalid identifier');
    return value;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    requireValue(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, 'Invalid integer');
    return value as number;
}
export function canonical(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value)
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
    throw new PlatformError('INVALID', 'Value is not canonical JSON');
}
export interface ModuleManifest {
    id: string;
    version: string;
    abi: typeof PLATFORM_ABI;
    dependencies: {
        id: string;
        version: string;
        optional?: boolean;
    }[];
    provides: string[];
    requires: string[];
    permissions: string[];
    routes: {
        method: 'GET' | 'POST';
        path: string;
        permission: string;
        kind: 'read' | 'write';
    }[];
    workspaces: {
        id: string;
        label: string;
        path: string;
        permission: string;
        export: string;
    }[];
    /** Optional fixed, owner-scoped read-only UI contributions. Declarations are not grants. */
    uiContributions?: import('./ui-contributions.js').UiContributionDescriptor[];
    schema: {
        current: number;
        readMin: number;
        readMax: number;
    };
    background: boolean;
    /** Optional fixed executable capabilities contributed by this module. */
    operations?: OperationDescriptor[];
    /** Relative src assets copied to dist; explicitly public for selected products. */
    browserAssets?: string[];
}
export interface Binding {
    contract: string;
    instanceId: string;
    implementation: string;
    scope: 'application' | 'module' | 'request';
    consumer: string;
    mode: 'local' | 'http';
}
export interface ProductDefinition {
    id: string;
    version: string;
    platformAbi: typeof PLATFORM_ABI;
    title: string;
    description: string;
    layout: 'sidebar' | 'top';
    wiring?: string;
    experience?: import('./experience.js').ProductExperience;
    modules: {
        id: string;
        version: string;
    }[];
    bindings: Binding[];
}
export interface CompositionPlan {
    product: ProductDefinition;
    modules: ModuleManifest[];
    bindings: Binding[];
    permissions: string[];
    requiresWorker: boolean;
}
export interface RouteDefinition {
    method: 'GET' | 'POST';
    path: string;
    permission: string;
    kind: 'read' | 'write';
    handle(context: RequestContext, input: unknown, params: URLSearchParams, commandId?: string): unknown | Promise<unknown>;
}
export interface ConnectionCall {
    sourceTenant: string;
    commandId: string;
    input: unknown;
    signal: AbortSignal;
    /** Source owner's final lease/authority check and durable dispatch marker. */
    beforeDispatch?(): void | Promise<void>;
}
/** Opt-in transport correlation; a domain must explicitly declare that its operation commits. */
export interface CommittedReceipt {
    schema: 'quadbridge.command-receipt.v1';
    contract: string;
    outcome: 'COMMITTED';
    commandId: string;
    destination: Scope;
    actor: Actor;
    resource: {
        type: string;
        id: string;
        version: number;
    };
}
export interface BoundCommand {
    call(call: ConnectionCall): Promise<unknown>;
}
export interface ReceiptCommand extends BoundCommand {
    /** Stable non-secret binding material, including the destination service principal. */
    readonly bindingKey: string;
    target(sourceTenant: string): Scope;
    /** Read only: never re-executes the business command. */
    lookup(call: ConnectionCall): Promise<CommittedReceipt>;
    call(call: ConnectionCall): Promise<CommittedReceipt>;
}
export interface PreparedJob {
    commit(): unknown;
}
/** Neutral execution record. Storage adapters may retain additional private fields. */
export type JobState = 'QUEUED' | 'RUNNING' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
export interface Job {
    id: string;
    tenant: string;
    kind: string;
    payload: string;
    actor_id: string;
    actor_kind: 'user' | 'service';
    permission: string;
    state: JobState;
    attempt: number;
    lease_token: string | null;
    lease_until: number | null;
    deadline: number;
    max_attempts: number;
    error: string | null;
    result: string | null;
    run_at: number;
    created: number;
    stop_reason?: string | null;
}
/** The adapter owns the atomic relationship between commit() and final job state. */
export interface JobExecutionStore {
    claim(worker: string, leaseMs: number, canStart: (job: Job) => boolean): Job | undefined | Promise<Job | undefined>;
    renew(job: Job, leaseMs: number): boolean | Promise<boolean>;
    assertCurrent(job: Job): void | Promise<void>;
    finish(job: Job, prepared: PreparedJob): unknown;
    fail(job: Job, error: string, retry: boolean): void | Promise<void>;
}
export interface JobExecutionContext {
    tenantId: string;
    signal: AbortSignal;
    jobId: string;
    attempt: number;
    /** Check immediately before a new effect. Does not authorize late business completion. */
    assertCurrent(): void | Promise<void>;
}
export interface JobHandler {
    kind: string;
    prepare(payload: unknown, context: JobExecutionContext): Promise<PreparedJob>;
}
export interface WorkspaceContext {
    root: HTMLElement;
    scope: Scope;
    /** Original authenticated workspace actor. Omitted only by legacy embedders. */
    actor?: Readonly<Actor>;
    /** Optional route and navigation ports for providers hosted by the maintained shell. */
    route?: import('./experience.js').WorkspaceRouteContext;
    navigation?: import('./experience.js').WorkspaceNavigationPort;
    signal: AbortSignal;
    locale: string;
    permissions: readonly string[];
    api: {
        get(path: string, signal?: AbortSignal): Promise<unknown>;
        post(path: string, body: unknown, commandId?: string, signal?: AbortSignal): Promise<unknown>;
    };
    notice(message: string): void;
}
export * from './ui-state.js';
export * from './experience.js';
export interface Workspace {
    mount(context: WorkspaceContext): (() => void) | void;
}
