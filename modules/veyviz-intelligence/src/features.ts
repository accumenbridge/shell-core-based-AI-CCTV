import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { PlatformError, object, canonical } from '@quadbridge/contracts';
import type { Category, FeatureVector, Processing } from './protocol.js';

export function runtimeProfile() {
  const path = process.env.VEYVIZ_INTELLIGENCE_PROFILE;
  if (!path) throw new PlatformError('UNAVAILABLE', 'Install and select the private intelligence runtime profile');
  const bytes = readFileSync(path);
  if (bytes.length > 4 * 1024 * 1024) throw new PlatformError('INCOMPATIBLE', 'Runtime profile exceeds its bound');
  const profile = JSON.parse(bytes.toString());
  if (profile.schema !== 'veyviz.intelligence-runtime.v1' || typeof profile.pythonExecutable !== 'string' || typeof profile.workerPath !== 'string') throw new PlatformError('INCOMPATIBLE', 'Runtime profile changed');
  return { path, profile, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function processing(value: unknown): Processing {
  const raw = object(value, ['categories', 'execution', 'motion', 'visual', 'face', 'plate']);
  const categories = raw.categories;
  if (!Array.isArray(categories) || !categories.length || categories.length > 3 || new Set(categories).size !== categories.length || categories.some(x => !['person', 'vehicle', 'animal'].includes(x))) throw new PlatformError('INVALID', 'Select supported categories');
  if (!['CPU', 'CUDA'].includes(raw.execution as string) || ['visual', 'face', 'plate'].some(key => typeof raw[key] !== 'boolean')) throw new PlatformError('INVALID', 'Select explicit execution and feature switches');
  const motion = object(raw.motion, ['enabled', 'threshold', 'heartbeatMs']);
  if (typeof motion.enabled !== 'boolean' || typeof motion.threshold !== 'number' || !Number.isFinite(motion.threshold) || motion.threshold < .0001 || motion.threshold > .5 || !Number.isSafeInteger(motion.heartbeatMs) || (motion.heartbeatMs as number) < 500 || (motion.heartbeatMs as number) > 5000) throw new PlatformError('INVALID', 'Invalid motion policy');
  return { categories: categories as Category[], execution: raw.execution as 'CPU' | 'CUDA', motion: motion as Processing['motion'], visual: raw.visual as boolean, face: raw.face as boolean, plate: raw.plate as boolean, runtimeSha256: runtimeProfile().sha256 };
}
export function vector(value: unknown): FeatureVector {
  const raw = object(value, ['model', 'values']);
  if (typeof raw.model !== 'string' || !/^[a-f0-9]{64}$/.test(raw.model) || !Array.isArray(raw.values) || raw.values.length < 1 || raw.values.length > 2048 || raw.values.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new PlatformError('INCOMPATIBLE', 'Invalid model-bound feature vector');
  const norm = Math.sqrt(raw.values.reduce((sum: number, x: number) => sum + x * x, 0));
  if (Math.abs(norm - 1) > .002) throw new PlatformError('INCOMPATIBLE', 'Feature vector must be normalized');
  return raw as unknown as FeatureVector;
}
export function cosine(a: FeatureVector, b: FeatureVector): number | null {
  if (a.model !== b.model || a.values.length !== b.values.length) return null;
  return Math.max(-1, Math.min(1, a.values.reduce((sum, x, i) => sum + x * b.values[i]!, 0)));
}
export function createFeatureBridge(markerPath?: string) {
  let closed = false, uncertain = false, busy = false;
  const running = new Set<Promise<FeatureVector>>(), closers = new Set<() => void>();
  const marker = (state: string, id: string) => { if (!markerPath) return; const temporary = markerPath + '.new'; writeFileSync(temporary, JSON.stringify({ state, id }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, markerPath); };
  return { async query(operation: 'text' | 'image' | 'face', input: string, assertCurrent: () => void, intent: Record<string, unknown> = {}) {
    assertCurrent();
    if (closed || uncertain || (markerPath && existsSync(markerPath) && JSON.parse(readFileSync(markerPath, 'utf8')).state !== 'CLOSED')) throw new PlatformError('UNAVAILABLE', 'Feature worker cleanup is unconfirmed or closed');
    if (busy) throw new PlatformError('EXHAUSTED', 'Another feature query is running');
    if ((operation === 'text' && (!input.trim() || input.length > 512)) || (operation !== 'text' && (input.length > 131072 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)))) throw new PlatformError('INVALID', 'Reference query exceeds its bound');
    const admitted = runtimeProfile(), identity = randomUUID(); busy = true; marker('ACTIVE', identity);
    const work = new Promise<FeatureVector>((resolve, reject) => {
      const child = spawn(admitted.profile.pythonExecutable, ['-I', admitted.profile.workerPath, '--profile', admitted.path, '--sha256', admitted.sha256], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffered = '', bytes = 0, result: FeatureVector | undefined, error: unknown, nativeClosed = false, sentClose = false, force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (!sentClose && !child.stdin.destroyed) { sentClose = true; child.stdin.write('{"operation":"close"}\n'); force = setTimeout(() => child.kill(), 15000); } };
      closers.add(stop);
      const deadline = setTimeout(() => { error = new PlatformError('UNAVAILABLE', 'Feature query deadline exceeded'); stop(); }, 120000);
      const monitor = setInterval(() => { try { assertCurrent(); } catch (e) { error = e; stop(); } }, 1000);
      child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
      child.on('error', e => { error = e; });
      child.stdout.on('data', chunk => {
        bytes += chunk.length; if (bytes > 256 * 1024) { error = new PlatformError('INCOMPATIBLE', 'Feature response exceeds its bound'); stop(); return; }
        buffered += chunk.toString();
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (response.status === 'READY') { assertCurrent(); if (!error && !closed) child.stdin.write(JSON.stringify({ operation, intent, ...(operation === 'text' ? { text: input } : { image: input }) }) + '\n'); else stop(); }
            else if (response.status === 'RESULT') { if (canonical(response.intent) !== canonical(intent)) throw new PlatformError('INCOMPATIBLE', 'Feature query original intent changed'); result = vector(response.vector); const expected = operation === 'face' ? admitted.profile.models.face.sha256 : createHash('sha256').update(JSON.stringify(['siglip2-pooled-l2-v1', ...['vision', 'text', 'tokenizer', 'tokenizerConfig', 'preprocessor'].map(k => admitted.profile.models[k].sha256)])).digest('hex'); if (result.model !== expected) throw new PlatformError('INCOMPATIBLE', 'Feature query embedding space changed'); stop(); }
            else if (response.status === 'CLOSED') nativeClosed = true;
            else { error = new PlatformError('UNAVAILABLE', response.error === 'Reference image must contain exactly one detectable face' ? response.error : 'Reference feature extraction failed'); stop(); }
          } catch (e) { error = e; stop(); }
        }
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline); clearInterval(monitor); closers.delete(stop);
        if (force) clearTimeout(force);
        try {
          if (!nativeClosed || code !== 0 || signal !== null || buffered.trim()) { uncertain = true; marker('UNKNOWN', identity); throw new PlatformError('UNAVAILABLE', 'Feature native cleanup is unconfirmed'); }
          marker('CLOSED', identity); assertCurrent();
          if (error) throw error; if (!result || closed) throw new PlatformError('UNAVAILABLE', 'Feature query did not complete'); resolve(result);
        } catch (e) { reject(e); }
      });
    });
    running.add(work); try { return await work; } finally { busy = false; running.delete(work); }
  }, async close() { closed = true; for (const stop of closers) stop(); await Promise.allSettled([...running]); if (uncertain) throw new PlatformError('UNAVAILABLE', 'Feature worker cleanup remains unconfirmed'); } };
}
