import { PlatformError, canonical, id, integer, object } from '@quadbridge/contracts';
import { MODEL_SHA256 } from '@quadbridge/veyviz-rfdetr/protocol';
import { RUNNER_SHA256 } from './runner-hash.js';
import { vector } from './features.js';
import { RESULT_SCHEMA, type Geometry, type TemporalRequest, type TemporalResult } from './protocol.js';
export function geometry(value: unknown): Geometry {
  const data = object(value, ['version', 'zones']);
  if (!Array.isArray(data.zones) || data.zones.length > 8) throw new PlatformError('INVALID', 'At most eight zones are supported');
  const ids = new Set<string>();
  const zones = data.zones.map(raw => {
    const zone = object(raw, ['id', 'points']); const zoneId = id(zone.id);
    if (ids.has(zoneId) || !Array.isArray(zone.points) || zone.points.length < 3 || zone.points.length > 16) throw new PlatformError('INVALID', 'Invalid zone polygon');
    ids.add(zoneId);
    const points = zone.points.map((point: unknown) => {
      if (!Array.isArray(point) || point.length !== 2 || point.some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1)) throw new PlatformError('INVALID', 'Normalized polygon points are required');
      return [point[0], point[1]] as [number, number];
    });
    if (new Set(points.map(p => canonical(p))).size !== points.length) throw new PlatformError('INVALID', 'Zone corners must be distinct');
    const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const on = (a: [number, number], b: [number, number], p: [number, number]) => Math.abs(cross(a, b, p)) < 1e-10 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[j]!, d = points[(j + 1) % points.length]!;
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) throw new PlatformError('INVALID', 'Zone polygon intersects itself');
    }
    let area = 0;
    for (let i = 0; i < points.length; i++) { const a = points[i]!, b = points[(i + 1) % points.length]!; area += a[0] * b[1] - b[0] * a[1]; }
    if (Math.abs(area) < .0001) throw new PlatformError('INVALID', 'Zone polygon has no usable area');
    return { id: zoneId, points };
  });
  return { version: integer(data.version, 1, 1000000), zones };
}
export function validateTemporalResult(value: unknown, request: TemporalRequest): TemporalResult {
  const fail = (): never => { throw new PlatformError('INCOMPATIBLE', 'Temporal result violates the admitted contract'); };
  const result = object(value, ['schema', 'status', 'request', 'sourceSha256', 'modelSha256', 'pipelineSha256', 'originPtsMs', 'decodedFrames', 'coverage', 'appearances', 'events', 'visits', 'cleanup', 'processingEvidence']) as unknown as TemporalResult;
  if (Buffer.byteLength(canonical(result)) > 4 * 1024 * 1024 || result.schema !== RESULT_SCHEMA || result.status !== 'SUCCEEDED' || canonical(result.request) !== canonical(request) || result.sourceSha256 !== request.sourceSha256 || result.modelSha256 !== MODEL_SHA256 || canonical(result.cleanup) !== canonical({ sourceClosed: true, inferenceClosed: true, retainedBytes: 0, outstandingLeases: 0 })) fail();
  if (!Number.isFinite(result.originPtsMs) || !Number.isSafeInteger(result.decodedFrames) || result.decodedFrames < 1 || result.decodedFrames > 20000) fail();
  if (result.pipelineSha256 !== request.pipelineSha256 || request.pipelineSha256 !== RUNNER_SHA256) fail();
  object(result.coverage, ['policy', 'observedMs', 'endReason']);
  if (result.coverage.policy !== 'SAMPLED_UNCOMMISSIONED' || !['WINDOW_END', 'RECORDING_END'].includes(result.coverage.endReason) || !Array.isArray(result.coverage.observedMs) || result.coverage.observedMs.length < 1 || result.coverage.observedMs.length > 240) fail();
  const time = (x: number) => Number.isFinite(x) && x >= request.startMs && x < request.endMs;
  if (result.coverage.observedMs.some((x, i, all) => !time(x) || (i > 0 && x <= all[i - 1]!))) fail();
  if (request.processing) {
    const evidence = result.processingEvidence ?? fail();
    object(evidence, ['runtimeSha256', 'execution', 'consideredMs', 'motionSkippedMs', 'featureModels']);
    if (evidence.runtimeSha256 !== request.processing.runtimeSha256 || evidence.execution !== request.processing.execution || !Array.isArray(evidence.consideredMs) || evidence.consideredMs.length > 240 || !Array.isArray(evidence.motionSkippedMs) || typeof evidence.featureModels !== 'object' || !evidence.featureModels || Object.values(evidence.featureModels).some(x => typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x))) fail();
    if (evidence.consideredMs.some((x, i, all) => !time(x) || (i > 0 && x <= all[i - 1]!)) || evidence.motionSkippedMs.some((x, i, all) => !evidence.consideredMs.includes(x) || result.coverage.observedMs.includes(x) || (i > 0 && x <= all[i - 1]!))) fail();
    const measured = new Set([...result.coverage.observedMs, ...evidence.motionSkippedMs]);
    if (measured.size !== evidence.consideredMs.length || evidence.consideredMs.some(x => !measured.has(x)) || (!request.processing.motion.enabled && evidence.motionSkippedMs.length)) fail();
  } else if (result.processingEvidence !== undefined) fail();
  if (!Array.isArray(result.appearances) || result.appearances.length > 32 || !Array.isArray(result.events) || result.events.length > 512 || !Array.isArray(result.visits) || result.visits.length > 256) fail();
  const appearances = new Set<string>(), eventIds = new Set<string>(), visitIds = new Set<string>(), zones = new Set(request.geometry.zones.map(z => z.id));
  const byId = new Map<string, TemporalResult['appearances'][number]>();
  for (const a of result.appearances) {
    object(a, ['id', 'category', 'firstMs', 'lastMs', 'observations', 'confidence', 'description', 'thumbnailJpegBase64', 'label', 'visualVector', 'faceVector', 'plateCandidates']);
    if (appearances.has(id(a.id)) || !(request.processing?.categories ?? ['person']).includes(a.category) || !time(a.firstMs) || !time(a.lastMs) || a.lastMs < a.firstMs || !Number.isInteger(a.observations) || a.observations < 1 || a.observations > result.coverage.observedMs.length || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 || typeof a.description !== 'string' || a.description.length > 200 || (a.thumbnailJpegBase64 !== undefined && (typeof a.thumbnailJpegBase64 !== 'string' || a.thumbnailJpegBase64.length > 131072 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.thumbnailJpegBase64)))) fail();
    if (a.label !== undefined && (typeof a.label !== 'string' || a.label.length > 32)) fail();
    if (a.visualVector !== undefined && (!request.processing?.visual || vector(a.visualVector).model !== result.processingEvidence?.featureModels.visualSpace)) fail();
    if (a.faceVector !== undefined && (a.category !== 'person' || !request.processing?.face || vector(a.faceVector).model !== result.processingEvidence?.featureModels.face)) fail();
    if (a.plateCandidates !== undefined && (a.category !== 'vehicle' || !request.processing?.plate || !Array.isArray(a.plateCandidates) || a.plateCandidates.length > 4 || a.plateCandidates.some(candidate => { object(candidate, ['text', 'confidence']); return typeof candidate.text !== 'string' || !/^[A-Z0-9]{6,16}$/.test(candidate.text) || !Number.isFinite(candidate.confidence) || candidate.confidence < .6 || candidate.confidence > 1; }))) fail();
    appearances.add(a.id);
    if (!result.coverage.observedMs.includes(a.firstMs) || !result.coverage.observedMs.includes(a.lastMs)) fail();
    if (a.thumbnailJpegBase64 !== undefined) validateJpeg(a.thumbnailJpegBase64);
    byId.set(a.id, a);
  }
  for (const e of result.events) {
    object(e, ['id', 'appearanceId', 'category', 'type', 'positionMs', 'zoneId']);
    if (eventIds.has(id(e.id)) || !appearances.has(e.appearanceId) || e.category !== byId.get(e.appearanceId)?.category || !['presence', 'zone_entered', 'zone_exited'].includes(e.type) || !time(e.positionMs) || !result.coverage.observedMs.includes(e.positionMs) || (e.type === 'presence' ? e.zoneId !== null : !zones.has(e.zoneId!))) fail();
    eventIds.add(e.id);
    const appearance = byId.get(e.appearanceId)!;
    if (e.positionMs < appearance.firstMs || e.positionMs > appearance.lastMs || (e.type === 'presence' && e.positionMs !== appearance.firstMs)) fail();
  }
  for (const v of result.visits) {
    object(v, ['id', 'appearanceId', 'zoneId', 'enteredMs', 'lastMs', 'exitedMs', 'state']);
    if (visitIds.has(id(v.id)) || !appearances.has(v.appearanceId) || !zones.has(v.zoneId) || !time(v.lastMs) || (v.enteredMs !== null && (!time(v.enteredMs) || v.enteredMs > v.lastMs)) || (v.exitedMs !== null && (!time(v.exitedMs) || v.exitedMs < v.lastMs)) || !['OPEN', 'CLOSED', 'UNCERTAIN'].includes(v.state) || (v.state === 'CLOSED') !== (v.exitedMs !== null)) fail();
    visitIds.add(v.id);
    const appearance = byId.get(v.appearanceId)!;
    if (v.lastMs < appearance.firstMs || v.lastMs > appearance.lastMs || !result.coverage.observedMs.includes(v.lastMs) || (v.enteredMs !== null && (v.enteredMs < appearance.firstMs || !result.coverage.observedMs.includes(v.enteredMs))) || (v.exitedMs !== null && (v.exitedMs > appearance.lastMs || !result.coverage.observedMs.includes(v.exitedMs)))) fail();
  }
  return result;
}

function validateJpeg(encoded: string) {
  const fail = (): never => { throw new PlatformError('INCOMPATIBLE', 'Invalid bounded JPEG evidence'); };
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 12 || bytes.length > 96 * 1024 || bytes.toString('base64') !== encoded || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) fail();
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) fail();
    const marker = bytes[offset + 1]!, size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > bytes.length) fail();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) fail(); const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
      if (height < 1 || width < 1 || height > 640 || width > 640) fail(); return;
    }
    offset += 2 + size;
  }
  fail();
}
