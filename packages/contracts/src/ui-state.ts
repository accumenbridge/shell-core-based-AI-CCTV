import type { Actor, FailureCode, Scope } from './index.js';

export const COMMAND_OUTCOME_SCHEMA = 'quadbridge.command-outcome.v1' as const;
export const COMMAND_REJECTION_RECEIPT = 'quadbridge.owner-rejection.v1' as const;

export interface CommandFieldError {
  readonly path: string;
  readonly code: 'INVALID' | 'CONFLICT';
  readonly message: string;
}

export interface CommandOutcome {
  readonly schema: typeof COMMAND_OUTCOME_SCHEMA;
  readonly state: 'REJECTED_NO_BUSINESS_EFFECTS';
  readonly scope: 'ORIGINAL_COMMAND';
  readonly terminal: true;
  readonly command: {
    readonly id: string;
    readonly operation: string;
    readonly productId: string;
    readonly instanceId: string;
    readonly tenantId: string;
    readonly actor: Actor;
    readonly submittedPayloadDigest: string;
  };
}

export interface TrustedCommandErrorDetails {
  readonly commandOutcome: CommandOutcome;
  readonly fieldErrors: readonly CommandFieldError[];
}

const trustedCommandErrors = new WeakMap<object, TrustedCommandErrorDetails>();
const safeValidationFields = new WeakMap<object, readonly CommandFieldError[]>();
const commandCodes = new Set<FailureCode>(['INVALID', 'CONFLICT', 'NOT_FOUND']);
const identifier = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);

function safeFields(value: unknown): CommandFieldError[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const result: CommandFieldError[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some(key => !['path', 'code', 'message'].includes(key))) return undefined;
    const path = record.path;
    const code = record.code;
    const message = record.message;
    if (typeof path !== 'string' || path.length > 96 || !/^(?:fields\.[a-z][A-Za-z0-9_]{0,31}|id|expectedVersion)$/.test(path) ||
        (code !== 'INVALID' && code !== 'CONFLICT') || typeof message !== 'string' || !message.trim() || message.length > 256 || message.includes('\0')) return undefined;
    result.push(Object.freeze({ path, code, message }));
  }
  return result;
}

export function validateCommandOutcome(value: unknown): CommandOutcome | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const outer = value as Record<string, unknown>;
  if (Object.keys(outer).sort().join(',') !== 'command,schema,scope,state,terminal' ||
      outer.schema !== COMMAND_OUTCOME_SCHEMA || outer.state !== 'REJECTED_NO_BUSINESS_EFFECTS' ||
      outer.scope !== 'ORIGINAL_COMMAND' || outer.terminal !== true || outer.command === null ||
      typeof outer.command !== 'object' || Array.isArray(outer.command)) return undefined;
  const command = outer.command as Record<string, unknown>;
  if (Object.keys(command).sort().join(',') !== 'actor,id,instanceId,operation,productId,submittedPayloadDigest,tenantId') return undefined;
  const actor = command.actor;
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) return undefined;
  const principal = actor as Record<string, unknown>;
  if (Object.keys(principal).sort().join(',') !== 'id,kind' || !identifier(principal.id) ||
      (principal.kind !== 'user' && principal.kind !== 'service') || !identifier(command.id) ||
      !identifier(command.operation, 192) || !identifier(command.productId) || !identifier(command.instanceId) ||
      !identifier(command.tenantId) || typeof command.submittedPayloadDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(command.submittedPayloadDigest)) return undefined;
  return Object.freeze({
    schema: COMMAND_OUTCOME_SCHEMA,
    state: 'REJECTED_NO_BUSINESS_EFFECTS',
    scope: 'ORIGINAL_COMMAND',
    terminal: true,
    command: Object.freeze({
      id: command.id,
      operation: command.operation,
      productId: command.productId,
      instanceId: command.instanceId,
      tenantId: command.tenantId,
      actor: Object.freeze({ id: principal.id, kind: principal.kind }) as Actor,
      submittedPayloadDigest: command.submittedPayloadDigest
    })
  });
}

/** Used by the reviewed owner boundary and by the shared transport parser only. */
export function markTrustedCommandError(
  error: unknown,
  outcome: unknown,
  fieldErrors?: unknown
): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const commandOutcome = validateCommandOutcome(outcome);
  const fields = safeFields(fieldErrors);
  if (!commandOutcome || !fields) return false;
  trustedCommandErrors.set(error as object, Object.freeze({ commandOutcome, fieldErrors: Object.freeze(fields) }));
  return true;
}

export function trustedCommandErrorDetails(error: unknown): TrustedCommandErrorDetails | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? trustedCommandErrors.get(error as object)
    : undefined;
}

export function markSafeCommandFieldErrors(error: unknown, fieldErrors: unknown): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const fields = safeFields(fieldErrors);
  if (!fields || fields.length === 0) return false;
  safeValidationFields.set(error as object, Object.freeze(fields));
  return true;
}

export function safeCommandFieldErrors(error: unknown): readonly CommandFieldError[] | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? safeValidationFields.get(error as object)
    : undefined;
}

/** Safe field errors are orthogonal to the terminal outcome and never certify it alone. */
export function validateCommandFieldErrors(value: unknown): readonly CommandFieldError[] | undefined {
  const fields = safeFields(value);
  return fields === undefined ? undefined : Object.freeze(fields);
}

export type CommandScope = Pick<Scope, 'productId' | 'instanceId' | 'tenantId'>;
