import { randomUUID } from 'node:crypto';
import { PlatformError, type JobHandler, type Job, type JobExecutionStore } from '@quadbridge/contracts';
export interface WorkerRegistration {
    moduleId: string;
    queue: JobExecutionStore;
    handlers: JobHandler[];
    authorize(job: Job): void;
    enabled(job: Job): boolean;
}
/** Round-robin across module stores. Tenant fairness is the store's declared policy. */
export class WorkerHost {
    readonly id = randomUUID();
    private stopping = false;
    private busy = false;
    private next = 0;
    private current: AbortController | undefined;
    constructor(private readonly registrations: readonly WorkerRegistration[], private readonly leaseMs = 10000) {
        if (!Number.isFinite(leaseMs) || leaseMs < 150)
            throw new PlatformError('INVALID', 'Lease must be at least 150ms');
    }
    async tick(): Promise<boolean> {
        if (this.stopping || this.busy)
            return false;
        this.busy = true;
        try {
            for (let offset = 0; offset < this.registrations.length; offset++) {
                const index = (this.next + offset) % this.registrations.length;
                const reg = this.registrations[index]!;
                const job = await reg.queue.claim(this.id, this.leaseMs, j => reg.enabled(j));
                if (!job)
                    continue;
                this.next = (index + 1) % this.registrations.length;
                const handler = reg.handlers.find(h => h.kind === job.kind);
                if (!handler) {
                    await reg.queue.fail(job, 'UNSUPPORTED_HANDLER', false);
                    return true;
                }
                const controller = new AbortController();
                this.current = controller;
                const assertCurrent = async () => {
                    if (this.stopping || controller.signal.aborted)
                        throw new PlatformError('STALE_ATTEMPT', 'Attempt interrupted');
                    await reg.queue.assertCurrent(job);
                    reg.authorize(job);
                    if (!reg.enabled(job))
                        throw new PlatformError('DISABLED', 'Module no longer accepts work');
                };
                let renewing = false;
                const timer = setInterval(() => {
                    if (renewing)
                        return;
                    renewing = true;
                    void Promise.resolve().then(() => reg.queue.renew(job, this.leaseMs)).then(ok => { if (!ok)
                        controller.abort(); }, () => controller.abort()).finally(() => { renewing = false; });
                }, Math.max(50, Math.floor(this.leaseMs / 3)));
                try {
                    await assertCurrent();
                    const prepared = await handler.prepare(JSON.parse(job.payload), { tenantId: job.tenant, signal: controller.signal, jobId: job.id, attempt: job.attempt, assertCurrent });
                    await assertCurrent();
                    await reg.queue.finish(job, prepared);
                }
                catch (e) {
                    const code = e instanceof PlatformError ? e.code : 'UNAVAILABLE';
                    await reg.queue.fail(job, code, !['DENIED', 'INVALID', 'INCOMPATIBLE', 'NOT_FOUND', 'CONFLICT'].includes(code));
                }
                finally {
                    clearInterval(timer);
                    this.current = undefined;
                }
                return true;
            }
            return false;
        }
        finally {
            this.busy = false;
        }
    }
    async run(pollMs = 250) {
        while (!this.stopping) {
            const worked = await this.tick();
            if (!worked)
                await new Promise(r => setTimeout(r, pollMs));
        }
    }
    stop() { this.stopping = true; this.current?.abort(); }
}
