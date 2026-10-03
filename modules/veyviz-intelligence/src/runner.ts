import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { PlatformError, canonical } from '@quadbridge/contracts';
import { verifyProfile } from '@quadbridge/veyviz-rfdetr/bridge';
import { validateTemporalResult } from './validation.js';
import { recordingBytes } from './catalog.js';
import type { TemporalRunner } from './protocol.js';
import { RUNNER_SHA256, BRIDGE_SHA256 } from './runner-hash.js';
import { runtimeProfile } from './features.js';

export function createTemporalRunner(markerPath?: string): TemporalRunner {
  const running = new Set<Promise<unknown>>(), controllers = new Set<AbortController>(); let closed = false, uncertain = false, reserved = false;
  const marker = (state: string, jobId: string) => {
    if (!markerPath) return;
    const temporary = markerPath + '.new';
    writeFileSync(temporary, JSON.stringify({ schema: 'veyviz.temporal-native-owner.v1', state, jobId }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, markerPath);
  };
  return { async run(request, recording, options) {
    if (closed || uncertain) throw new PlatformError('UNAVAILABLE', 'Temporal runner is closed or native cleanup is unconfirmed');
    if (reserved) throw new PlatformError('EXHAUSTED', 'Only one temporal native execution is admitted at a time');
    reserved = true;
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort();
    const work = (async () => {
      if (markerPath && existsSync(markerPath) && JSON.parse(readFileSync(markerPath, 'utf8')).state !== 'CLOSED') throw new PlatformError('UNAVAILABLE', 'Previous native owner has no confirmed cleanup; explicit recovery required');
      const profilePath = process.env.VEYVIZ_AI_PROFILE;
      if (!profilePath) throw new PlatformError('UNAVAILABLE', 'Install and select the reviewed local AI companion');
      await verifyProfile(profilePath); await recordingBytes(recording); await options.assertCurrent();
      if (controller.signal.aborted || closed) throw new PlatformError('UNAVAILABLE', 'Analysis cancelled before dispatch');
      const profile = JSON.parse(await readFile(profilePath, 'utf8'));
      const script = resolve(profile.runnerPath, '..', 'temporal.py');
      if (request.pipelineSha256 !== RUNNER_SHA256 || createHash('sha256').update(await readFile(script)).digest('hex') !== RUNNER_SHA256) throw new PlatformError('INCOMPATIBLE', 'Temporal runner source drift');
      if (request.processing && (runtimeProfile().sha256 !== request.processing.runtimeSha256 || createHash('sha256').update(await readFile(resolve(script, '..', 'runtime_bridge.py'))).digest('hex') !== BRIDGE_SHA256)) throw new PlatformError('INCOMPATIBLE', 'Advanced runtime or bridge changed');
      marker('ACTIVE', request.jobId);
      return new Promise<ReturnType<typeof validateTemporalResult>>((resolveResult, reject) => {
        const child = spawn(profile.pythonExecutable, ['-I', script, '--profile', profilePath, '--recording', recording.path], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: '', PYTHONHOME: '', VEYVIZ_RUNTIME_BRIDGE_SHA256: BRIDGE_SHA256 } });
        const chunks: Buffer[] = []; let bytes = 0, failure: Error | undefined, errorOutput = '', cleanupConfirmed = false;
        const cancel = () => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'cancel', jobId: request.jobId }) + '\n'); };
        const timeout = setTimeout(() => { failure = new PlatformError('UNAVAILABLE', 'Temporal execution deadline exceeded'); cancel(); }, 20 * 60 * 1000);
        controller.signal.addEventListener('abort', cancel, { once: true });
        let checking = false;
        const monitor = setInterval(() => { if (checking) return; checking = true; Promise.resolve().then(() => options.assertCurrent()).catch(error => { failure ??= error instanceof Error ? error : new PlatformError('DENIED', 'Original execution authority changed'); cancel(); }).finally(() => { checking = false; }); }, 1000);
        child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { failure ??= new PlatformError('INCOMPATIBLE', 'Temporal result budget exceeded'); cancel(); } else chunks.push(chunk); });
        child.stderr.on('data', (chunk: Buffer) => { errorOutput = (errorOutput + chunk.toString()).slice(-512); });
        child.stdin.on('error', () => {});
        child.once('error', error => { failure = error; });
        child.once('close', (code, signal) => {
          clearTimeout(timeout); clearInterval(monitor); controller.signal.removeEventListener('abort', cancel);
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.trim().split('\n').length !== 1) throw new PlatformError('INCOMPATIBLE', 'Invalid temporal response framing');
            const response = JSON.parse(raw);
            const cleanupKnown = signal === null && canonical(response.request) === canonical(request) && canonical(response.cleanup) === canonical({ sourceClosed: true, inferenceClosed: true, retainedBytes: 0, outstandingLeases: 0 });
            if (!cleanupKnown) throw new PlatformError('UNAVAILABLE', 'Native cleanup is unconfirmed');
            cleanupConfirmed = true;
            marker('CLOSED', request.jobId);
            if (failure) throw failure;
            if (code !== 0 || controller.signal.aborted) throw new PlatformError('UNAVAILABLE', `Temporal execution did not complete (${code ?? 'signal'}); ${errorOutput.includes('Cancelled') ? 'cancelled' : 'inspect local profile'}`);
            resolveResult(validateTemporalResult(response, request));
          } catch (error) {
            const known = cleanupConfirmed;
            if (!known) { uncertain = true; try { marker('UNKNOWN', request.jobId); } catch { /* ACTIVE marker already fences recovery. */ } }
            reject(error);
          }
        });
        child.stdin.write(JSON.stringify(request) + '\n');
        if (controller.signal.aborted) cancel();
      });
    })();
    running.add(work); try { return await work; } finally { running.delete(work); reserved = false; controllers.delete(controller); options.signal.removeEventListener('abort', abort); }
  }, async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...running]); if (uncertain) throw new PlatformError('UNAVAILABLE', 'Temporal native cleanup remains unconfirmed'); } };
}
