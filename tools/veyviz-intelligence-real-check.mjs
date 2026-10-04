import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTemporalRunner } from '../modules/veyviz-intelligence/dist/runner.js';
import { RUNNER_SHA256 } from '../modules/veyviz-intelligence/dist/runner-hash.js';

const root = process.cwd();
process.env.VEYVIZ_AI_PROFILE = resolve(root, '.local/veyviz-ai/profile.json');
const recording = JSON.parse(await readFile(resolve(root, '.local/veyviz-intelligence/catalog.json'), 'utf8')).recordings[0];
const request = { schema: 'veyviz.temporal-recording.request.v1', jobId: 'real-recorded-check', runId: 'real-recorded-run', commandId: 'real-command', scope: { productId: 'veyviz-review', instanceId: 'real-check', tenantId: recording.tenantId, actorId: 'admin', actorKind: 'user' }, sourceId: 'real-source', sourceVersion: 1, recordingId: recording.id, sourceSha256: recording.sha256, pipelineSha256: RUNNER_SHA256, startMs: 0, endMs: 22000, sampleIntervalMs: 1000, geometry: { version: 1, zones: [] } };
const runner = createTemporalRunner(), started = Date.now();
try {
  const result = await runner.run(request, recording, { signal: new AbortController().signal, assertCurrent() {} });
  await writeFile(resolve(root, '.local/veyviz-intelligence-real-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, decodedFrames: result.decodedFrames, samples: result.coverage.observedMs.length, appearances: result.appearances.length, events: result.events.length, cleanup: result.cleanup }));
} finally { await runner.close(); }
