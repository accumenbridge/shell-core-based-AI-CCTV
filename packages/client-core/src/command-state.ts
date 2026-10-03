import { canonical, PlatformError, trustedCommandErrorDetails, type Actor, type Json, type Scope } from '@quadbridge/contracts';

export type CommandIntentState = 'PREPARED' | 'PENDING' | 'UNKNOWN' | 'COMMITTED' | 'REJECTED_NO_BUSINESS_EFFECTS';

export interface CapturedCommandIntent {
  readonly slot: string;
  readonly id: string;
  readonly operation: string;
  readonly scope: Readonly<Pick<Scope, 'productId' | 'instanceId' | 'tenantId'>>;
  readonly actor?: Readonly<Actor>;
  readonly payload: Json;
  readonly submittedPayloadDigest: string;
}

interface IntentRecord {
  readonly intent: CapturedCommandIntent;
  readonly canonicalPayload: string;
  state: CommandIntentState;
}

export interface CommandStateOptions {
  scope: Scope;
  actor?: Readonly<Actor>;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

function abortError(): DOMException { return new DOMException('Workspace command scope closed', 'AbortError'); }
function freezeParsedJson(value: Json): Json {
  if (Array.isArray(value)) for (const item of value) freezeParsedJson(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) freezeParsedJson(item);
  Object.freeze(value);
  return value;
}

async function digest(value: string): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class CommandState {
  private readonly scope: Readonly<Pick<Scope, 'productId' | 'instanceId' | 'tenantId'>>;
  private readonly actor?: Readonly<Actor>;
  private readonly records = new Map<string, IntentRecord>();
  private readonly captures = new Map<string, { operation: string; canonicalPayload: string; promise: Promise<CapturedCommandIntent> }>();
  private epoch = 0;
  private disposed = false;

  constructor(private readonly options: CommandStateOptions) {
    this.scope = Object.freeze({
      productId: options.scope.productId,
      instanceId: options.scope.instanceId,
      tenantId: options.scope.tenantId
    });
    this.actor = options.actor ? Object.freeze({ id: options.actor.id, kind: options.actor.kind }) : undefined;
    if (options.signal.aborted) this.dispose();
    else options.signal.addEventListener('abort', () => this.dispose(), { once: true });
  }

  private active() { return !this.disposed && !this.options.signal.aborted && this.options.isCurrent(); }

  state(intent: CapturedCommandIntent): CommandIntentState | undefined {
    return this.records.get(intent.slot)?.intent === intent ? this.records.get(intent.slot)?.state : undefined;
  }

  async capture(slot: string, operation: string, payload: unknown): Promise<CapturedCommandIntent> {
    if (!this.active()) throw abortError();
    if (typeof slot !== 'string' || !slot || slot.length > 192 || typeof operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(operation))
      throw new PlatformError('INVALID', 'Invalid command slot or operation');
    const serialized = canonical(payload);
    const prior = this.records.get(slot);
    if (prior && ['PREPARED', 'PENDING', 'UNKNOWN'].includes(prior.state)) {
      if (prior.intent.operation !== operation || prior.canonicalPayload !== serialized)
        throw new PlatformError('CONFLICT', 'The earlier command remains unresolved; retry its exact captured intent');
      return prior.intent;
    }
    const capture = this.captures.get(slot);
    if (capture) {
      if (capture.operation !== operation || capture.canonicalPayload !== serialized)
        throw new PlatformError('CONFLICT', 'A command identity is already being captured for this operation slot');
      return capture.promise;
    }
    const epoch = this.epoch;
    const pending = { operation, canonicalPayload: serialized, promise: Promise.resolve(undefined as unknown as CapturedCommandIntent) };
    const promise = (async () => {
      try {
        const submittedPayloadDigest = await digest(serialized);
        if (!this.active() || epoch !== this.epoch || this.captures.get(slot) !== pending) throw abortError();
        const raced = this.records.get(slot);
        if (raced && ['PREPARED', 'PENDING', 'UNKNOWN'].includes(raced.state)) {
          if (raced.intent.operation !== operation || raced.canonicalPayload !== serialized)
            throw new PlatformError('CONFLICT', 'The earlier command remains unresolved; retry its exact captured intent');
          return raced.intent;
        }
        const payloadValue = freezeParsedJson(JSON.parse(serialized) as Json);
        const intent: CapturedCommandIntent = Object.freeze({
          slot,
          id: crypto.randomUUID(),
          operation,
          scope: this.scope,
          ...(this.actor ? { actor: this.actor } : {}),
          payload: payloadValue,
          submittedPayloadDigest
        });
        this.records.set(slot, { intent, canonicalPayload: serialized, state: 'PREPARED' });
        return intent;
      } finally {
        if (this.captures.get(slot) === pending) this.captures.delete(slot);
      }
    })();
    pending.promise = promise;
    this.captures.set(slot, pending);
    return promise;
  }

  async send<T>(intent: CapturedCommandIntent, dispatch: (commandId: string, payload: Json) => Promise<T>): Promise<T> {
    const record = this.records.get(intent.slot);
    if (!this.active()) throw abortError();
    if (!record || record.intent !== intent || !['PREPARED', 'UNKNOWN'].includes(record.state))
      throw new PlatformError('CONFLICT', 'This command cannot be dispatched with a new identity');
    const epoch = this.epoch;
    record.state = 'PENDING';
    try {
      const result = await dispatch(intent.id, intent.payload);
      if (!this.active() || epoch !== this.epoch || this.records.get(intent.slot) !== record) throw abortError();
      record.state = 'COMMITTED';
      return result;
    } catch (error) {
      if (!this.active() || epoch !== this.epoch || this.records.get(intent.slot) !== record) throw abortError();
      record.state = this.matches(intent, error) ? 'REJECTED_NO_BUSINESS_EFFECTS' : 'UNKNOWN';
      throw error;
    }
  }

  retry<T>(intent: CapturedCommandIntent, dispatch: (commandId: string, payload: Json) => Promise<T>): Promise<T> {
    if (this.state(intent) !== 'UNKNOWN') throw new PlatformError('CONFLICT', 'Only an unresolved command can be retried');
    return this.send(intent, dispatch);
  }

  discardPrepared(intent: CapturedCommandIntent): boolean {
    const record = this.records.get(intent.slot);
    if (!record || record.intent !== intent || record.state !== 'PREPARED') return false;
    this.records.delete(intent.slot);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.records.clear();
    this.captures.clear();
  }

  private matches(intent: CapturedCommandIntent, error: unknown): boolean {
    if (!intent.actor) return false;
    const details = trustedCommandErrorDetails(error);
    if (!details) return false;
    const command = details.commandOutcome.command;
    const identityMatches = details.commandOutcome.terminal === true &&
      details.commandOutcome.scope === 'ORIGINAL_COMMAND' &&
      command.id === intent.id && command.operation === intent.operation &&
      command.productId === intent.scope.productId && command.instanceId === intent.scope.instanceId &&
      command.tenantId === intent.scope.tenantId && command.actor.id === intent.actor.id &&
      command.actor.kind === intent.actor.kind && command.submittedPayloadDigest === intent.submittedPayloadDigest;
    if (!identityMatches) return false;
    const submitted = intent.payload && typeof intent.payload === 'object' && !Array.isArray(intent.payload)
      ? intent.payload as Record<string, Json> : {};
    return details.fieldErrors.every(field => {
      if (field.path.startsWith('fields.')) {
        const name = field.path.slice('fields.'.length);
        const fields = submitted.fields;
        return !!fields && typeof fields === 'object' && !Array.isArray(fields) && Object.hasOwn(fields, name);
      }
      return Object.hasOwn(submitted, field.path);
    });
  }
}

export function createCommandState(options: CommandStateOptions): CommandState {
  return new CommandState(options);
}
