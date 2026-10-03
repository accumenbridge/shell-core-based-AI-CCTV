import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PlatformError, canonical, id, type RequestContext, type PreparedJob, type Job, type JobState, type JobExecutionStore } from '@quadbridge/contracts';
import { COMMAND_REJECTION_RECEIPT, markTrustedCommandError, safeCommandFieldErrors, validateCommandFieldErrors, validateCommandOutcome, type CommandFieldError, type CommandOutcome } from '@quadbridge/contracts/ui-state';
export interface Migration {
    version: number;
    sql: string;
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export type CommandReceiptLookup<T> = { readonly found: false } | { readonly found: true; readonly result: T };
type TerminalRejection = { code: 'INVALID' | 'CONFLICT' | 'NOT_FOUND'; message: string; fieldErrors: readonly CommandFieldError[]; commandOutcome: CommandOutcome };
type OwnerCommandResult<T> = { readonly kind: 'committed'; readonly result: T } | { readonly kind: 'rejected'; readonly rejection: TerminalRejection };
const hasReservedRejectionTag = (serialized: string) => {
    try {
        const value = JSON.parse(serialized) as Record<string, unknown>;
        return !!value && typeof value === 'object' && value.$quadbridge === COMMAND_REJECTION_RECEIPT;
    } catch { return false; }
};
function readTerminalRejection(serialized: string): TerminalRejection | undefined {
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.$quadbridge !== COMMAND_REJECTION_RECEIPT || Object.keys(record).sort().join(',') !== '$quadbridge,code,commandOutcome,fieldErrors,message') return undefined;
    if (record.code !== 'INVALID' && record.code !== 'CONFLICT' && record.code !== 'NOT_FOUND') return undefined;
    if (typeof record.message !== 'string' || !record.message.trim() || record.message.length > 256 || record.message.includes('\0')) return undefined;
    const commandOutcome = validateCommandOutcome(record.commandOutcome);
    if (!commandOutcome) return undefined;
    const fieldErrors = validateCommandFieldErrors(record.fieldErrors);
    if (!fieldErrors) return undefined;
    return Object.freeze({ code: record.code, message: record.message, fieldErrors: Object.freeze(fieldErrors), commandOutcome });
}
/** A concrete local-profile adapter. The composition root supplies ONE owner-specific connection.
 * It is not an all-domain repository and is never given to browser contributions. */
export class SqliteOwner {
    readonly db: DatabaseSync;
    constructor(readonly path: string, readonly owner: string) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path, { timeout: 1000 });
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
        this.db.exec(`CREATE TABLE IF NOT EXISTS _owner(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS _migrations(version INTEGER PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS _receipts(tenant TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(tenant,actor,operation,command_id));
      CREATE TABLE IF NOT EXISTS _audit(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, command_id TEXT NOT NULL, at INTEGER NOT NULL);`);
        this.transaction(() => {
            const row = this.db.prepare('SELECT name FROM _owner').get() as {
                name: string;
            } | undefined;
            if (row && row.name !== owner)
                throw new PlatformError('INCOMPATIBLE', 'Database belongs to another owner');
            this.db.prepare('INSERT OR IGNORE INTO _owner(name) VALUES(?)').run(owner);
        });
    }
    transaction<T>(fn: () => T): T {
        if (this.db.isTransaction)
            throw new PlatformError('CONFLICT', 'Nested owner transaction is not supported');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            if (result && typeof (result as {
                then?: unknown;
            }).then === 'function')
                throw new PlatformError('INVALID', 'Do not await inside an owner transaction');
            this.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    migrate(migrations: readonly Migration[], envelope: {
        readMin: number;
        readMax: number;
        current: number;
    }): void {
        this.transaction(() => {
            const applied = this.db.prepare('SELECT version,digest FROM _migrations ORDER BY version').all() as unknown as {
                version: number;
                digest: string;
            }[];
            const current = applied.at(-1)?.version ?? 0;
            if (current > envelope.readMax || current > envelope.current)
                throw new PlatformError('INCOMPATIBLE', 'Writer cannot open newer data generation');
            for (const row of applied) {
                const m = migrations.find(m => m.version === row.version);
                if (!m || hash(m.sql) !== row.digest)
                    throw new PlatformError('INCOMPATIBLE', 'Migration history changed');
            }
            let next = current;
            for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
                if (migration.version <= current)
                    continue;
                if (migration.version !== next + 1)
                    throw new PlatformError('INCOMPATIBLE', 'Migration sequence gap');
                this.db.exec(migration.sql);
                this.db.prepare('INSERT INTO _migrations VALUES(?,?)').run(migration.version, hash(migration.sql));
                next = migration.version;
            }
            if (next !== envelope.current || next < envelope.readMin || next > envelope.readMax)
                throw new PlatformError('INCOMPATIBLE', 'Unsupported data generation');
        });
    }
    command<T>(ctx: RequestContext, operation: string, key: string | undefined, input: unknown, permission: string, fn: () => T): T {
        if (!key)
            throw new PlatformError('INVALID', 'Idempotency-Key is required');
        id(key);
        ctx.assertAllowed(permission, 'write');
        const actor = `${ctx.actor.kind}:${ctx.actor.id}`;
        const digest = hash(input);
        return this.transaction(() => {
            ctx.assertAllowed(permission, 'write');
            const old = this.db.prepare('SELECT digest,result FROM _receipts WHERE tenant=? AND actor=? AND operation=? AND command_id=?').get(ctx.tenantId, actor, operation, key) as {
                digest: string;
                result: string;
            } | undefined;
            if (old) {
                if (old.digest !== digest)
                    throw new PlatformError('CONFLICT', 'Command identity was reused with a different payload');
                if (hasReservedRejectionTag(old.result))
                    throw new PlatformError('CONFLICT', 'This command identity was terminally rejected by its owner');
                return JSON.parse(old.result) as T;
            }
            const result = fn();
            const json = canonical(result);
            this.db.prepare('INSERT INTO _receipts VALUES(?,?,?,?,?,?,?)').run(ctx.tenantId, actor, operation, key, digest, json, Date.now());
            this.db.prepare('INSERT INTO _audit(tenant,actor,operation,command_id,at) VALUES(?,?,?,?,?)').run(ctx.tenantId, actor, operation, key, Date.now());
            return result;
        });
    }
    /**
     * Explicit receipt-first path for generated entity create/edit operations whose complete
     * business effect is synchronous SQL in this owner. Other modules keep using command().
     */
    generatedEntityCommand<T, N>(ctx: RequestContext, operation: string, key: string | undefined, submittedInput: unknown,
        permission: string, normalize: () => N, execute: (normalized: N) => T): T {
        if (!key) throw new PlatformError('INVALID', 'Idempotency-Key is required');
        id(key);
        if (permission !== `${this.owner}.write` || !operation.startsWith(`${this.owner}.`) || !/\.(?:create|edit)$/.test(operation))
            throw new PlatformError('DENIED', 'Owner-atomic command is not a generated entity write');
        ctx.assertAllowed(permission, 'write');
        const rawDigest = hash(submittedInput);
        const actor = `${ctx.actor.kind}:${ctx.actor.id}`;
        const result = this.transaction<OwnerCommandResult<T>>(() => {
            ctx.assertAllowed(permission, 'write');
            const old = this.db.prepare('SELECT digest,result FROM _receipts WHERE tenant=? AND actor=? AND operation=? AND command_id=?').get(ctx.tenantId, actor, operation, key) as {
                digest: string;
                result: string;
            } | undefined;
            if (old) {
                if (hasReservedRejectionTag(old.result)) {
                    const rejection = readTerminalRejection(old.result);
                    if (!rejection || old.digest !== rawDigest || rejection.commandOutcome.command.submittedPayloadDigest !== rawDigest ||
                        rejection.commandOutcome.command.id !== key || rejection.commandOutcome.command.operation !== operation ||
                        rejection.commandOutcome.command.productId !== ctx.productId || rejection.commandOutcome.command.instanceId !== ctx.instanceId ||
                        rejection.commandOutcome.command.tenantId !== ctx.tenantId || rejection.commandOutcome.command.actor.id !== ctx.actor.id ||
                        rejection.commandOutcome.command.actor.kind !== ctx.actor.kind)
                        throw new PlatformError('CONFLICT', 'Command identity was reused with a different payload');
                    return { kind: 'rejected', rejection };
                }
                const normalized = normalize();
                if (normalized && typeof (normalized as { then?: unknown }).then === 'function')
                    throw new PlatformError('UNAVAILABLE', 'Owner normalization must be synchronous');
                if (old.digest !== hash(normalized))
                    throw new PlatformError('CONFLICT', 'Command identity was reused with a different payload');
                return { kind: 'committed', result: JSON.parse(old.result) as T };
            }

            this.db.exec('SAVEPOINT qb_generated_entity_command');
            let normalized: N;
            let value: T;
            try {
                normalized = normalize();
                if (normalized && typeof (normalized as { then?: unknown }).then === 'function')
                    throw new PlatformError('UNAVAILABLE', 'Owner normalization must be synchronous');
                value = execute(normalized);
                if (value && typeof (value as { then?: unknown }).then === 'function')
                    throw new PlatformError('UNAVAILABLE', 'Owner command must be synchronous');
            } catch (error) {
                if (!(error instanceof PlatformError) || (error.code !== 'INVALID' && error.code !== 'CONFLICT' && error.code !== 'NOT_FOUND') ||
                    !error.message.trim() || error.message.length > 256 || error.message.includes('\0')) throw error;
                this.db.exec('ROLLBACK TO SAVEPOINT qb_generated_entity_command');
                this.db.exec('RELEASE SAVEPOINT qb_generated_entity_command');
                ctx.assertAllowed(permission, 'write');
                const fieldErrors = safeCommandFieldErrors(error) ?? [];
                const commandOutcome: CommandOutcome = Object.freeze({
                    schema: 'quadbridge.command-outcome.v1',
                    state: 'REJECTED_NO_BUSINESS_EFFECTS',
                    scope: 'ORIGINAL_COMMAND',
                    terminal: true,
                    command: Object.freeze({
                        id: key,
                        operation,
                        productId: ctx.productId,
                        instanceId: ctx.instanceId,
                        tenantId: ctx.tenantId,
                        actor: Object.freeze({ id: ctx.actor.id, kind: ctx.actor.kind }),
                        submittedPayloadDigest: rawDigest
                    })
                });
                const saved: TerminalRejection = Object.freeze({ code: error.code, message: error.message, fieldErrors, commandOutcome });
                this.db.prepare('INSERT INTO _receipts VALUES(?,?,?,?,?,?,?)').run(ctx.tenantId, actor, operation, key, rawDigest,
                    canonical({ $quadbridge: COMMAND_REJECTION_RECEIPT, code: saved.code, message: saved.message, fieldErrors: saved.fieldErrors, commandOutcome }), Date.now());
                this.db.prepare('INSERT INTO _audit(tenant,actor,operation,command_id,at) VALUES(?,?,?,?,?)').run(ctx.tenantId, actor, operation, key, Date.now());
                return { kind: 'rejected', rejection: saved };
            }

            this.db.exec('RELEASE SAVEPOINT qb_generated_entity_command');
            const normalizedDigest = hash(normalized);
            const json = canonical(value);
            this.db.prepare('INSERT INTO _receipts VALUES(?,?,?,?,?,?,?)').run(ctx.tenantId, actor, operation, key, normalizedDigest, json, Date.now());
            this.db.prepare('INSERT INTO _audit(tenant,actor,operation,command_id,at) VALUES(?,?,?,?,?)').run(ctx.tenantId, actor, operation, key, Date.now());
            return { kind: 'committed', result: value };
        });
        if (result.kind === 'committed') return result.result;
        const error = new PlatformError(result.rejection.code, result.rejection.message);
        if (!markTrustedCommandError(error, result.rejection.commandOutcome, result.rejection.fieldErrors))
            throw new PlatformError('UNAVAILABLE', 'Owner command outcome could not be safely restored');
        throw error;
    }
    lookupCommand<T>(ctx: RequestContext, operation: string, key: string | undefined, input: unknown, permission: string): CommandReceiptLookup<T> {
        if (!key)
            throw new PlatformError('INVALID', 'Idempotency-Key is required');
        id(key);
        const actor = `${ctx.actor.kind}:${ctx.actor.id}`;
        const digest = hash(input);
        return this.transaction(() => {
            ctx.assertAllowed(permission, 'write');
            const old = this.db.prepare('SELECT digest,result FROM _receipts WHERE tenant=? AND actor=? AND operation=? AND command_id=?').get(ctx.tenantId, actor, operation, key) as {
                digest: string;
                result: string;
            } | undefined;
            if (!old)
                return { found: false } as const;
            if (old.digest !== digest)
                throw new PlatformError('CONFLICT', 'Command identity was reused with a different payload');
            if (hasReservedRejectionTag(old.result))
                throw new PlatformError('CONFLICT', 'This command identity was terminally rejected by its owner');
            return { found: true, result: JSON.parse(old.result) as T } as const;
        });
    }
    close() { this.db.close(); }
}
export type { Job, JobState } from '@quadbridge/contracts';
export class JobQueue implements JobExecutionStore {
    constructor(readonly store: SqliteOwner, private readonly clock: () => number = Date.now) {
        store.db.exec(`CREATE TABLE IF NOT EXISTS _jobs(
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, submission_key TEXT NOT NULL, digest TEXT NOT NULL,
      actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, permission TEXT NOT NULL,
      state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER, worker TEXT,
      run_at INTEGER NOT NULL, deadline INTEGER NOT NULL, max_attempts INTEGER NOT NULL, error TEXT, result TEXT, created INTEGER NOT NULL, stop_reason TEXT,
      UNIQUE(tenant,kind,submission_key)); CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs(state,run_at);
      CREATE INDEX IF NOT EXISTS _jobs_tenant_order ON _jobs(tenant,created,id);
      CREATE TABLE IF NOT EXISTS _job_schedule(slot INTEGER PRIMARY KEY CHECK(slot=1),last_tenant TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS _job_scan(tenant TEXT PRIMARY KEY,created INTEGER NOT NULL,id TEXT NOT NULL);`);
        store.transaction(() => {
            const columns = store.db.prepare('PRAGMA table_info(_jobs)').all() as unknown as {
                name: string;
            }[];
            if (!columns.some(c => c.name === 'stop_reason'))
                store.db.exec('ALTER TABLE _jobs ADD COLUMN stop_reason TEXT');
        });
    }
    enqueue(ctx: RequestContext, kind: string, key: string, payload: unknown, permission: string, ttlMs = 600000): Job {
        if (!this.store.db.isTransaction)
            throw new PlatformError('CONFLICT', 'Enqueue must share the initiating owner transaction');
        const digest = hash(payload);
        const old = this.store.db.prepare('SELECT * FROM _jobs WHERE tenant=? AND kind=? AND submission_key=?').get(ctx.tenantId, kind, key) as unknown as Job & {
            digest: string;
        } | undefined;
        if (old) {
            if (old.digest !== digest)
                throw new PlatformError('CONFLICT', 'Job identity conflict');
            return old;
        }
        const jobId = randomUUID(), now = this.clock();
        this.store.db.prepare(`INSERT INTO _jobs(id,tenant,kind,payload,submission_key,digest,actor_id,actor_kind,permission,state,run_at,deadline,max_attempts,created) VALUES(?,?,?,?,?,?,?,?,?,'QUEUED',?,?,3,?)`).run(jobId, ctx.tenantId, kind, canonical(payload), key, digest, ctx.actor.id, ctx.actor.kind, permission, now, now + ttlMs, now);
        return this.get(jobId)!;
    }
    get(jobId: string): Job | undefined { return this.store.db.prepare('SELECT * FROM _jobs WHERE id=?').get(jobId) as unknown as Job | undefined; }
    publicGet(ctx: RequestContext, jobId: string): unknown {
        const row = this.get(jobId);
        if (!row || row.tenant !== ctx.tenantId)
            throw new PlatformError('NOT_FOUND', 'Job not found');
        return { id: row.id, state: row.state, attempt: row.attempt, error: row.error, stopReason: row.stop_reason ?? null, result: row.result ? JSON.parse(row.result) : null };
    }
    claim(worker: string, leaseMs = 10000, canStart: (job: Job) => boolean = () => true): Job | undefined {
        const now = this.clock();
        return this.store.transaction(() => {
            this.store.db.prepare(`UPDATE _jobs SET state='CANCELLED',stop_reason='CANCELLED',lease_token=NULL,lease_until=NULL WHERE state='CANCEL_REQUESTED' AND lease_until<=?`).run(now);
            this.store.db.prepare(`UPDATE _jobs SET state='FAILED',error=COALESCE(error,'EXPIRED_OR_EXHAUSTED'),stop_reason='EXPIRED_OR_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE (state='QUEUED' OR (state='RUNNING' AND lease_until<=?)) AND (deadline<=? OR attempt>=max_attempts)`).run(now, now);
            const due = `deadline>? AND attempt<max_attempts AND ((state='QUEUED' AND run_at<=?) OR (state='RUNNING' AND lease_until<=?))`;
            const last = (this.store.db.prepare('SELECT last_tenant FROM _job_schedule WHERE slot=1').get() as {
                last_tenant: string;
            } | undefined)?.last_tenant ?? '';
            // Bounded rotating tenant scan; persisted cursor survives worker restarts.
            const tenants = this.store.db.prepare(`SELECT DISTINCT tenant FROM _jobs WHERE ${due} ORDER BY CASE WHEN tenant>? THEN 0 ELSE 1 END,tenant LIMIT 16`).all(now, now, now, last) as unknown as {
                tenant: string;
            }[];
            for (const { tenant } of tenants) {
                this.store.db.prepare('INSERT INTO _job_schedule VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET last_tenant=excluded.last_tenant').run(tenant);
                const cursor = this.store.db.prepare('SELECT created,id FROM _job_scan WHERE tenant=?').get(tenant) as {
                    created: number;
                    id: string;
                } | undefined;
                const query = (after: typeof cursor) => this.store.db.prepare(`SELECT * FROM _jobs WHERE tenant=? AND ${due} ${after ? 'AND (created>? OR (created=? AND id>?))' : ''} ORDER BY created,id LIMIT 100`).all(tenant, now, now, now, ...(after ? [after.created, after.created, after.id] : [])) as unknown as Job[];
                let candidates = query(cursor);
                if (!candidates.length && cursor)
                    candidates = query(undefined);
                const job = candidates.find(canStart), end = job ?? candidates.at(-1);
                if (end)
                    this.store.db.prepare('INSERT INTO _job_scan VALUES(?,?,?) ON CONFLICT(tenant) DO UPDATE SET created=excluded.created,id=excluded.id').run(tenant, end.created, end.id);
                if (!job)
                    continue;
                const token = randomUUID();
                this.store.db.prepare(`UPDATE _jobs SET state='RUNNING',attempt=attempt+1,worker=?,lease_token=?,lease_until=? WHERE id=?`).run(worker, token, now + leaseMs, job.id);
                return this.get(job.id);
            }
            return undefined;
        });
    }
    renew(job: Job, leaseMs = 10000): boolean { return Number(this.store.db.prepare(`UPDATE _jobs SET lease_until=? WHERE id=? AND lease_token=? AND state='RUNNING' AND lease_until>? AND deadline>?`).run(this.clock() + leaseMs, job.id, job.lease_token, this.clock(), this.clock()).changes) === 1; }
    finish(job: Job, prepared: PreparedJob): unknown {
        return this.store.transaction(() => {
            const row = this.get(job.id);
            this.assertCurrent(job);
            const result = prepared.commit();
            const json = canonical(result ?? null);
            this.store.db.prepare(`UPDATE _jobs SET state='SUCCEEDED',result=?,lease_token=NULL,lease_until=NULL,worker=NULL WHERE id=?`).run(json, job.id);
            return result;
        });
    }
    assertCurrent(job: Job) {
        const row = this.get(job.id);
        if (!row || row.state !== 'RUNNING' || row.lease_token !== job.lease_token || !row.lease_until || row.lease_until <= this.clock() || row.deadline <= this.clock())
            throw new PlatformError('STALE_ATTEMPT', 'Job attempt no longer owns completion');
    }
    fail(job: Job, error: string, retry = true): void {
        this.store.transaction(() => {
            const current = this.get(job.id);
            if (!current || current.lease_token !== job.lease_token)
                return;
            const state = current.state === 'CANCEL_REQUESTED' ? 'CANCELLED' : retry && current.attempt < current.max_attempts && current.deadline > this.clock() ? 'QUEUED' : 'FAILED';
            this.store.db.prepare(`UPDATE _jobs SET state=?,error=?,stop_reason=?,run_at=?,lease_token=NULL,lease_until=NULL,worker=NULL WHERE id=?`).run(state, error.slice(0, 128), state === 'QUEUED' ? null : error.slice(0, 128), this.clock() + Math.min(30000, 500 * 2 ** current.attempt), job.id);
        });
    }
    cancel(ctx: RequestContext, jobId: string): JobState {
        // Caller performs authorization and owns command receipt/transaction.
        const job = this.get(jobId);
        if (!job || job.tenant !== ctx.tenantId)
            throw new PlatformError('NOT_FOUND', 'Job not found');
        if (job.state === 'QUEUED')
            this.store.db.prepare(`UPDATE _jobs SET state='CANCELLED' WHERE id=?`).run(jobId);
        if (job.state === 'RUNNING')
            this.store.db.prepare(`UPDATE _jobs SET state='CANCEL_REQUESTED' WHERE id=?`).run(jobId);
        return this.get(jobId)!.state;
    }
    pending() {
        return Number((this.store.db.prepare(`SELECT count(*) AS n FROM _jobs WHERE state IN ('QUEUED','RUNNING','CANCEL_REQUESTED')`).get() as {
            n: number;
        }).n);
    }
}
