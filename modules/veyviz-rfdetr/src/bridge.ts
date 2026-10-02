import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, resolve, dirname } from 'node:path';
import { PlatformError, canonical, type ModuleManifest } from '@quadbridge/contracts';
import type { HostedModule, ModuleEnvironment } from '@quadbridge/backend-host';
import type { OperationDescriptor, OperationRegistration } from '@quadbridge/contracts/operations';
import { FIXTURE_ID, INVENTORY_SCHEMA, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MODEL_SHA256, PROFILE_ID, PROFILE_SCHEMA, RECORDING_SHA256, REQUEST_SCHEMA, RESULT_SCHEMA, type AnalysisRequest, type AnalysisResult, type Cleanup, type Profile, type Readiness } from './protocol.js';

const PROFILE_ENV = 'VEYVIZ_AI_PROFILE';
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_INVENTORY_FILES = 20000;
const MAX_STDERR_BYTES = 8192;
const operationDescriptor: OperationDescriptor = {
  id: 'veyviz-rfdetr.ai.readiness', version: 1, title: 'Read local inference readiness',
  description: 'Inspect bounded local model and companion integrity provenance without exposing private paths.', permission: 'veyviz.ai.read', kind: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {
    status: { type: 'string', enum: ['READY', 'UNAVAILABLE'] }, profileId: { type: 'string', enum: [PROFILE_ID] }, fixtureId: { type: 'string', enum: [FIXTURE_ID] }, modelId: { type: 'string', enum: [PROFILE_ID] },
    sourceSha256: { type: 'string', maxLength: 64 }, modelSha256: { type: 'string', maxLength: 64 }, inventorySha256: { type: 'string', maxLength: 64 },
    verifiedAt: { type: 'string', minLength: 0, maxLength: 40 }, message: { type: 'string', maxLength: 200 },
    versions: { type: 'array', maxItems: 50, items: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, version: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name', 'version'], additionalProperties: false } }
  }, required: ['status', 'profileId', 'fixtureId', 'modelId', 'sourceSha256', 'modelSha256', 'inventorySha256', 'verifiedAt', 'message', 'versions'], additionalProperties: false }
};

interface InventoryFile { path: string; sha256: string; bytes: number; kind: 'runner' | 'source' | 'wheel' | 'installed' | 'interpreter' }
interface Inventory { schema: string; createdAt: string; source: { head: string; dirty: boolean; provenancePath: string }; files: InventoryFile[]; versions: Record<string, string> }
interface CachedVerification { profile: Profile; readiness: Readiness }
const verificationCache = new Map<string, CachedVerification>();
const normalizePath = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const samePath = (left: string, right: string) => normalizePath(left) === normalizePath(right);
function closedObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)))
    throw new PlatformError('INCOMPATIBLE', `Invalid ${label} shape`);
  return value as Record<string, unknown>;
}
function closedObjectOptional(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new PlatformError('INCOMPATIBLE', `Invalid ${label} shape`);
  const keys = Object.keys(value);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key)))
    throw new PlatformError('INCOMPATIBLE', `Invalid ${label} shape`);
  return value as Record<string, unknown>;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new PlatformError('INCOMPATIBLE', `Invalid ${label}`);
  return value;
}
function boundedFilePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)) throw new PlatformError('INCOMPATIBLE', `Invalid ${label}`);
  return value;
}
async function regularFile(file: string, label: string) {
  let info;
  try { info = await lstat(file); } catch { throw new PlatformError('UNAVAILABLE', `${label} is unavailable`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new PlatformError('INCOMPATIBLE', `${label} must be a regular file`);
  const actual = await realpath(file);
  if (!samePath(actual, file)) throw new PlatformError('INCOMPATIBLE', `${label} path is not canonical`);
  return info.size;
}
async function digestFile(file: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  if (signal?.aborted) throw new PlatformError('UNAVAILABLE', 'Integrity verification was cancelled');
  const hash = createHash('sha256'); let bytes = 0;
  const stream = createReadStream(file);
  const abort = () => stream.destroy(new Error('verification cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
    if (signal?.aborted) throw new PlatformError('UNAVAILABLE', 'Integrity verification was cancelled');
    return { sha256: hash.digest('hex'), bytes };
  } catch (error) {
    if (signal?.aborted) throw new PlatformError('UNAVAILABLE', 'Integrity verification was cancelled');
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
}
async function readBoundedJson(file: string, max: number, label: string): Promise<{ value: unknown; bytes: Buffer }> {
  const size = await regularFile(file, label);
  if (size > max) throw new PlatformError('INCOMPATIBLE', `${label} exceeds its size budget`);
  const bytes = await readFile(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assertNoDuplicateKeys(text);
  try { return { value: JSON.parse(text), bytes }; } catch { throw new PlatformError('INCOMPATIBLE', `${label} is not valid JSON`); }
}

/** A tiny bounded JSON scanner rejects duplicate members before JSON.parse can erase them. */
function assertNoDuplicateKeys(text: string) {
  let at = 0, nodes = 0;
  const ws = () => { while (/\s/u.test(text[at] ?? '')) at++; };
  const fail = (): never => { throw new PlatformError('INCOMPATIBLE', 'Protocol JSON contains duplicate or invalid structure'); };
  const string = () => {
    if (text[at] !== '"') fail();
    const start = at++;
    while (at < text.length) {
      const c = text[at++]!;
      if (c === '"') { try { return JSON.parse(text.slice(start, at)) as string; } catch { return fail(); } }
      if (c === '\\') at++;
      else if (c.charCodeAt(0) < 32) fail();
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (++nodes > 50000 || depth > 20) fail();
    ws();
    if (text[at] === '{') {
      at++; ws(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      while (at < text.length) {
        ws(); const key = string(); if (keys.has(key)) fail(); keys.add(key); ws(); if (text[at++] !== ':') fail(); value(depth + 1); ws();
        if (text[at] === '}') { at++; return; } if (text[at++] !== ',') fail();
      }
      return fail();
    }
    if (text[at] === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      while (at < text.length) { value(depth + 1); ws(); if (text[at] === ']') { at++; return; } if (text[at++] !== ',') fail(); }
      return fail();
    }
    if (text[at] === '"') { string(); return; }
    const rest = text.slice(at), scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(rest)?.[0] ?? '';
    if (!scalar || scalar === '-' || scalar === 'NaN' || scalar === 'Infinity') fail();
    at += scalar.length;
  };
  value(0); ws(); if (at !== text.length) fail();
}

function profileValue(value: unknown): Profile {
  const p = closedObject(value, ['schema', 'profileId', 'fixtureId', 'modelPath', 'recordingPath', 'modelSha256', 'recordingSha256', 'pythonExecutable', 'runnerPath', 'inventoryPath'], 'profile');
  if (p.schema !== PROFILE_SCHEMA || p.profileId !== PROFILE_ID || p.fixtureId !== FIXTURE_ID || p.modelSha256 !== MODEL_SHA256 || p.recordingSha256 !== RECORDING_SHA256)
    throw new PlatformError('INCOMPATIBLE', 'Profile identity or asset digest is not admitted');
  return { schema: PROFILE_SCHEMA, profileId: PROFILE_ID, fixtureId: FIXTURE_ID,
    modelPath: boundedFilePath(p.modelPath, 'model path'), recordingPath: boundedFilePath(p.recordingPath, 'recording path'),
    modelSha256: MODEL_SHA256, recordingSha256: RECORDING_SHA256, pythonExecutable: boundedFilePath(p.pythonExecutable, 'Python executable'),
    runnerPath: boundedFilePath(p.runnerPath, 'runner path'), inventoryPath: boundedFilePath(p.inventoryPath, 'inventory path') };
}
function inventoryValue(value: unknown): Inventory {
  const i = closedObject(value, ['schema', 'createdAt', 'source', 'files', 'versions'], 'inventory');
  if (i.schema !== INVENTORY_SCHEMA || typeof i.createdAt !== 'string' || !Number.isFinite(Date.parse(i.createdAt)) || !Array.isArray(i.files) || i.files.length < 1 || i.files.length > MAX_INVENTORY_FILES)
    throw new PlatformError('INCOMPATIBLE', 'Companion inventory is invalid');
  const source = closedObject(i.source, ['head', 'dirty', 'provenancePath'], 'source provenance');
  if (typeof source.head !== 'string' || !/^[a-f0-9]{40}$/iu.test(source.head) || typeof source.dirty !== 'boolean') throw new PlatformError('INCOMPATIBLE', 'Source provenance is invalid');
  const provenancePath = boundedFilePath(source.provenancePath, 'provenance path');
  const versions = i.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions) || Object.keys(versions).length < 1 || Object.keys(versions).length > 50 ||
      Object.entries(versions).some(([name, version]) => !VERSION_NAME.test(name) || typeof version !== 'string' || !version || version.length > 80))
    throw new PlatformError('INCOMPATIBLE', 'Installed package versions are invalid');
  const files: InventoryFile[] = i.files.map(raw => {
    const f = closedObject(raw, ['path', 'sha256', 'bytes', 'kind'], 'inventory file');
    const path = boundedFilePath(f.path, 'inventory file path');
    if (typeof f.sha256 !== 'string' || !HASH.test(f.sha256) || !Number.isSafeInteger(f.bytes) || (f.bytes as number) < 0 || !['runner', 'source', 'wheel', 'installed', 'interpreter'].includes(String(f.kind)))
      throw new PlatformError('INCOMPATIBLE', 'Inventory file record is invalid');
    return { path, sha256: f.sha256, bytes: f.bytes as number, kind: f.kind as InventoryFile['kind'] };
  });
  const seen = new Set<string>();
  for (const file of files) { const key = normalizePath(file.path); if (seen.has(key)) throw new PlatformError('INCOMPATIBLE', 'Duplicate inventory path'); seen.add(key); }
  const provenance = files.find(file => samePath(file.path, provenancePath) && file.kind === 'source');
  if (!provenance) throw new PlatformError('INCOMPATIBLE', 'Captured source provenance is absent from the inventory');
  return { schema: INVENTORY_SCHEMA, createdAt: i.createdAt, source: { head: source.head, dirty: source.dirty, provenancePath }, files, versions: versions as Record<string, string> };
}

async function verifyProfileInternal(profilePath: string, signal?: AbortSignal): Promise<CachedVerification> {
  const configured = process.env[PROFILE_ENV];
  if (!configured || !isAbsolute(configured) || !samePath(configured, profilePath)) throw new PlatformError('INCOMPATIBLE', `${PROFILE_ENV} must select the trusted local profile`);
  const { value: rawProfile } = await readBoundedJson(profilePath, MAX_REQUEST_BYTES, 'Profile');
  const profile = profileValue(rawProfile);
  const { value: rawInventory, bytes: inventoryBytes } = await readBoundedJson(profile.inventoryPath, MAX_INVENTORY_BYTES, 'Companion inventory');
  const inventory = inventoryValue(rawInventory);
  const byPath = new Map(inventory.files.map(file => [normalizePath(file.path), file]));
  const runner = byPath.get(normalizePath(profile.runnerPath)), python = byPath.get(normalizePath(profile.pythonExecutable));
  if (!runner || runner.kind !== 'runner' || !python || python.kind !== 'interpreter') throw new PlatformError('INCOMPATIBLE', 'Runner and Python executable are not inventoried under their exact identities');
  let provenanceFound = false;
  for (const item of inventory.files) {
    if (signal?.aborted) throw new PlatformError('UNAVAILABLE', 'Integrity verification was cancelled');
    const size = await regularFile(item.path, 'Inventoried companion file');
    if (size !== item.bytes) throw new PlatformError('INCOMPATIBLE', 'Inventoried companion file size changed');
    const actual = await digestFile(item.path, signal);
    if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) throw new PlatformError('INCOMPATIBLE', 'Inventoried companion file digest changed');
    if (samePath(item.path, profile.runnerPath) && item.kind === 'runner') provenanceFound = true;
  }
  if (!provenanceFound) throw new PlatformError('INCOMPATIBLE', 'Selected runner source is not integrity verified');
  const model = await digestFile(profile.modelPath, signal), recording = await digestFile(profile.recordingPath, signal);
  if (model.sha256 !== profile.modelSha256 || recording.sha256 !== profile.recordingSha256) throw new PlatformError('INCOMPATIBLE', 'Selected media/model digest changed');
  const verifiedAt = new Date().toISOString();
  const readiness: Readiness = { status: 'READY', profileId: PROFILE_ID, fixtureId: FIXTURE_ID, modelId: PROFILE_ID,
    sourceSha256: profile.recordingSha256, modelSha256: profile.modelSha256, inventorySha256: createHash('sha256').update(inventoryBytes).digest('hex'),
    verifiedAt, message: `Verified local CPU profile from captured source ${inventory.source.head}${inventory.source.dirty ? ' (source had local changes)' : ''}.`, versions: inventory.versions };
  return { profile, readiness };
}

/** Verifies the trusted startup-selected profile and every inventory entry; no paths come from requests. */
export async function verifyProfile(profilePath: string): Promise<Readiness> {
  const result = await verifyProfileInternal(profilePath);
  verificationCache.set(normalizePath(profilePath), result);
  return result.readiness;
}

function exactRequest(value: unknown): AnalysisRequest {
  const request = closedObject(value, ['schema', 'jobId', 'commandId', 'scope', 'sourceId', 'sourceVersion', 'fixtureId', 'profileId', 'frameCount', 'sampleStride'], 'analysis request');
  if (request.schema !== REQUEST_SCHEMA || request.fixtureId !== FIXTURE_ID || request.profileId !== PROFILE_ID || !Number.isSafeInteger(request.sourceVersion) || (request.sourceVersion as number) < 1 ||
      !Number.isSafeInteger(request.frameCount) || (request.frameCount as number) < 1 || (request.frameCount as number) > 6 || !Number.isSafeInteger(request.sampleStride) || (request.sampleStride as number) < 1 || (request.sampleStride as number) > 30)
    throw new PlatformError('INVALID', 'Analysis request does not match the local protocol');
  for (const field of ['jobId', 'commandId', 'sourceId']) identifier(request[field], field);
  const scope = closedObject(request.scope, ['productId', 'instanceId', 'tenantId', 'actorId', 'actorKind'], 'analysis scope');
  for (const field of ['productId', 'instanceId', 'tenantId', 'actorId']) identifier(scope[field], field);
  if (scope.actorKind !== 'user' && scope.actorKind !== 'service') throw new PlatformError('INVALID', 'Invalid analysis actor kind');
  return request as unknown as AnalysisRequest;
}

function iso(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value)); }
function finite(value: unknown, low: number, high: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high; }

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    let marker = bytes[offset++]!; while (marker === 0xff && offset < bytes.length) marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return;
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
}

function validateCleanup(value: unknown): Cleanup {
  const cleanup = closedObject(value, ['sourceClosed', 'inferenceClosed', 'retainedBytes', 'outstandingLeases'], 'cleanup report');
  if (typeof cleanup.sourceClosed !== 'boolean' || typeof cleanup.inferenceClosed !== 'boolean' || !Number.isSafeInteger(cleanup.retainedBytes) || !Number.isSafeInteger(cleanup.outstandingLeases))
    throw new PlatformError('INCOMPATIBLE', 'Runner cleanup report is malformed');
  return { sourceClosed: cleanup.sourceClosed, inferenceClosed: cleanup.inferenceClosed, retainedBytes: cleanup.retainedBytes as number, outstandingLeases: cleanup.outstandingLeases as number };
}
export function validateResult(value: unknown, request: AnalysisRequest, readiness: Readiness): AnalysisResult {
  const result = closedObject(value, ['schema', 'status', 'request', 'sourceSha256', 'modelSha256', 'modelId', 'startedAt', 'completedAt', 'decodedFrames', 'samples', 'coverage', 'occupancy', 'cleanup', 'versions'], 'analysis result');
  if (result.schema !== RESULT_SCHEMA || result.status !== 'SUCCEEDED' || canonical(result.request) !== canonical(request) || result.sourceSha256 !== readiness.sourceSha256 || result.modelSha256 !== readiness.modelSha256 || result.modelId !== PROFILE_ID ||
      !iso(result.startedAt) || !iso(result.completedAt) || Date.parse(result.completedAt) < Date.parse(result.startedAt) || !Number.isSafeInteger(result.decodedFrames) || (result.decodedFrames as number) < 1 ||
      !Number.isSafeInteger(request.frameCount) || !Number.isSafeInteger(request.sampleStride) || !Array.isArray(result.samples) || result.samples.length !== request.frameCount ||
      result.decodedFrames !== (request.frameCount - 1) * request.sampleStride + 1 || result.coverage !== 'UNCOMMISSIONED_RECORDING' || result.occupancy !== 'UNKNOWN')
    throw new PlatformError('INCOMPATIBLE', 'Runner result does not match the admitted identity and profile');
  const cleanup = validateCleanup(result.cleanup);
  if (!cleanup.sourceClosed || !cleanup.inferenceClosed || cleanup.retainedBytes !== 0 || cleanup.outstandingLeases !== 0) throw new PlatformError('INCOMPATIBLE', 'Runner did not prove complete resource cleanup');
  if (!result.versions || typeof result.versions !== 'object' || Array.isArray(result.versions) || Object.keys(result.versions).length < 1 || Object.keys(result.versions).length > 50 ||
      Object.entries(result.versions).some(([name, version]) => !VERSION_NAME.test(name) || typeof version !== 'string' || !version || version.length > 80)) throw new PlatformError('INCOMPATIBLE', 'Runner version provenance is invalid');
  let detectionCount = 0;
  const samples = (result.samples as unknown[]).map((raw, index) => {
    const sample = closedObjectOptional(raw, ['frameIndex', 'positionMs', 'width', 'height', 'inferenceMs', 'detections'], ['thumbnailJpegBase64'], 'analysis sample');
    if (!Number.isSafeInteger(sample.frameIndex) || sample.frameIndex !== index * request.sampleStride || (sample.frameIndex as number) >= (result.decodedFrames as number) ||
        !finite(sample.positionMs, 0, 86_400_000) || !Number.isSafeInteger(sample.width) || (sample.width as number) < 1 || (sample.width as number) > 8192 ||
        !Number.isSafeInteger(sample.height) || (sample.height as number) < 1 || (sample.height as number) > 8192 || !finite(sample.inferenceMs, 0, 600_000) || !Array.isArray(sample.detections) || sample.detections.length > 100)
      throw new PlatformError('INCOMPATIBLE', 'Runner sample exceeds its bounds');
    detectionCount += sample.detections.length;
    const detections = sample.detections.map(rawDetection => {
      const detection = closedObject(rawDetection, ['confidence', 'x1', 'y1', 'x2', 'y2'], 'detection');
      if (!finite(detection.confidence, 0, 1) || !finite(detection.x1, 0, sample.width as number) || !finite(detection.x2, 0, sample.width as number) ||
          !finite(detection.y1, 0, sample.height as number) || !finite(detection.y2, 0, sample.height as number) || detection.x2 <= detection.x1 || detection.y2 <= detection.y1)
        throw new PlatformError('INCOMPATIBLE', 'Runner detection box is invalid');
      return detection as unknown as AnalysisResult['samples'][number]['detections'][number];
    });
    let thumbnailJpegBase64: string | undefined;
    if (sample.thumbnailJpegBase64 !== undefined) {
      if (typeof sample.thumbnailJpegBase64 !== 'string' || sample.thumbnailJpegBase64.length > 128 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(sample.thumbnailJpegBase64))
        throw new PlatformError('INCOMPATIBLE', 'Runner thumbnail encoding is invalid');
      const bytes = Buffer.from(sample.thumbnailJpegBase64, 'base64');
      const size = jpegSize(bytes);
      if (bytes.length > 96 * 1024 || bytes.toString('base64') !== sample.thumbnailJpegBase64 || !size || size.width < 1 || size.height < 1 || size.width > 640 || size.height > 640)
        throw new PlatformError('INCOMPATIBLE', 'Runner thumbnail does not meet the image bounds');
      thumbnailJpegBase64 = sample.thumbnailJpegBase64;
    }
    return { frameIndex: sample.frameIndex as number, positionMs: sample.positionMs as number, width: sample.width as number, height: sample.height as number,
      inferenceMs: sample.inferenceMs as number, detections, ...(thumbnailJpegBase64 ? { thumbnailJpegBase64 } : {}) };
  });
  if (detectionCount > 600) throw new PlatformError('INCOMPATIBLE', 'Runner emitted too many detections');
  return { schema: RESULT_SCHEMA, status: 'SUCCEEDED', request, sourceSha256: result.sourceSha256 as string, modelSha256: result.modelSha256 as string,
    modelId: PROFILE_ID, startedAt: result.startedAt as string, completedAt: result.completedAt as string, decodedFrames: result.decodedFrames as number,
    samples, coverage: 'UNCOMMISSIONED_RECORDING', occupancy: 'UNKNOWN', cleanup: { sourceClosed: true, inferenceClosed: true, retainedBytes: 0, outstandingLeases: 0 },
    versions: result.versions as Record<string, string> };
}

function validateFailure(value: unknown, request: AnalysisRequest): { status: 'FAILED' | 'CANCELLED'; cleanup: Cleanup; error: { code: string; message: string } } {
  const response = closedObject(value, ['schema', 'status', 'request', 'error', 'cleanup'], 'runner failure');
  if (response.schema !== RESULT_SCHEMA || (response.status !== 'FAILED' && response.status !== 'CANCELLED') || canonical(response.request) !== canonical(request))
    throw new PlatformError('INCOMPATIBLE', 'Runner failure identity is invalid');
  const error = closedObject(response.error, ['code', 'message'], 'runner error');
  if (typeof error.code !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(error.code) || typeof error.message !== 'string' || !error.message || error.message.length > 240 || /[\r\n\0]/u.test(error.message))
    throw new PlatformError('INCOMPATIBLE', 'Runner failure details are invalid');
  return { status: response.status, cleanup: validateCleanup(response.cleanup), error: { code: error.code, message: error.message } };
}

async function readinessFor(profilePath: string, signal?: AbortSignal): Promise<CachedVerification> {
  const verified = await verifyProfileInternal(profilePath, signal);
  verificationCache.set(normalizePath(profilePath), verified);
  return verified;
}

function environmentForPython() {
  const allowed = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.PYTHONNOUSERSITE = '1';
  return env;
}

async function runPipe(requestValue: unknown, options: { signal: AbortSignal; assertCurrent(): void | Promise<void> }, profilePath: string, getVerification: (signal?: AbortSignal) => Promise<CachedVerification>, markUncertain: () => void): Promise<AnalysisResult> {
  const request = exactRequest(requestValue);
  const control = new AbortController(); let authorityError: unknown;
  if (options.signal.aborted) control.abort();
  const abortControl = () => control.abort();
  options.signal.addEventListener('abort', abortControl, { once: true });
  let monitorBusy = false;
  const monitor = setInterval(() => {
    if (monitorBusy || control.signal.aborted) return;
    monitorBusy = true;
    void Promise.resolve().then(() => options.assertCurrent()).catch(error => { authorityError = error; control.abort(); }).finally(() => { monitorBusy = false; });
  }, 250);
  let childStarted = false, childClosed = false, cleanupProven = false;
  try {
    await options.assertCurrent();
    const verified = await getVerification(control.signal);
    if (control.signal.aborted) throw authorityError ?? new PlatformError('UNAVAILABLE', 'Analysis authorization or request was cancelled');
    await options.assertCurrent();
    const { profile, readiness } = verified;
    const requestBytes = Buffer.from(JSON.stringify(request), 'utf8');
    if (requestBytes.length > MAX_REQUEST_BYTES) throw new PlatformError('INVALID', 'Analysis request exceeds the protocol limit');
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(profile.pythonExecutable, ['-I', profile.runnerPath, '--profile', profilePath], { cwd: dirname(profile.runnerPath), shell: false, windowsHide: true, env: environmentForPython(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw new PlatformError('UNAVAILABLE', 'The verified local Python runner could not start'); }
    childStarted = child.pid !== undefined;
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, stderrStored = 0, overflow = false, cancellationSent = false, pipeError = false, startError = false;
    let resolveClose!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let rejectClose!: (error: unknown) => void;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosePromise, rejectClosePromise) => { resolveClose = resolveClosePromise; rejectClose = rejectClosePromise; });
    const requestCancel = () => {
      if (cancellationSent) return;
      cancellationSent = true;
      try { child.stdin.write(`${JSON.stringify({ type: 'cancel', jobId: request.jobId })}\n`); } catch { pipeError = true; }
      try { child.stdin.end(); } catch { pipeError = true; }
    };
    const childAbort = () => requestCancel();
    control.signal.addEventListener('abort', childAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_RESPONSE_BYTES + 1) stdout.push(Buffer.from(chunk)); else { overflow = true; requestCancel(); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrStored < MAX_STDERR_BYTES) { const part = Buffer.from(chunk).subarray(0, MAX_STDERR_BYTES - stderrStored); stderr.push(part); stderrStored += part.length; }
    });
    child.stdin.on('error', () => { pipeError = true; requestCancel(); });
    child.stdout.on('error', () => { pipeError = true; requestCancel(); });
    child.stderr.on('error', () => { pipeError = true; });
    child.once('error', () => { startError = true; if (!child.pid) resolveClose({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolveClose({ code, signal }));
    child.once('close', () => { childClosed = true; });
    control.signal.addEventListener('abort', requestCancel, { once: true });
    try { child.stdin.write(Buffer.concat([requestBytes, Buffer.from('\n')])); }
    catch { pipeError = true; requestCancel(); }
    if (control.signal.aborted) requestCancel();
    const closedResult = await closed;
    control.signal.removeEventListener('abort', childAbort);
    if (startError && !childStarted) { cleanupProven = true; throw new PlatformError('UNAVAILABLE', 'The verified local Python runner could not start'); }
    if (!childClosed) throw new PlatformError('UNAVAILABLE', 'Python process closure was not observed');
    if (overflow || stdoutBytes > MAX_RESPONSE_BYTES) throw new PlatformError('INCOMPATIBLE', 'Python response exceeded its byte limit');
    if (closedResult.signal !== null) throw new PlatformError('UNAVAILABLE', 'Python runner exited unexpectedly');
    const output = Buffer.concat(stdout);
    if (!output.length || output.at(-1) !== 0x0a || output.subarray(0, -1).includes(0x0a) || output.at(-2) === 0x0d) throw new PlatformError('INCOMPATIBLE', 'Python runner did not emit exactly one JSON line');
    let parsed: unknown;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, -1)); assertNoDuplicateKeys(text); parsed = JSON.parse(text); }
    catch { throw new PlatformError('INCOMPATIBLE', 'Python runner returned malformed JSON'); }
    const response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    if (response?.status === 'SUCCEEDED') {
      if (closedResult.code !== 0) throw new PlatformError('UNAVAILABLE', 'Python runner did not exit successfully');
      const result = validateResult(response, request, readiness);
      cleanupProven = true;
      if (pipeError) throw new PlatformError('UNAVAILABLE', 'Python pipe closed with an I/O error after reporting cleanup');
      if (authorityError) throw authorityError;
      if (options.signal.aborted || control.signal.aborted) throw new PlatformError('UNAVAILABLE', 'Analysis was cancelled; the Python child and native owners reported clean closure');
      return result;
    }
    if (response?.status === 'FAILED' || response?.status === 'CANCELLED') {
      const failure = validateFailure(response, request);
      const clean = failure.cleanup.sourceClosed && failure.cleanup.inferenceClosed && failure.cleanup.retainedBytes === 0 && failure.cleanup.outstandingLeases === 0;
      if (!clean) throw new PlatformError('INCOMPATIBLE', 'Python runner could not prove that all native resources closed');
      cleanupProven = true;
      if ((failure.status === 'CANCELLED' && closedResult.code !== 3) || (failure.status === 'FAILED' && (closedResult.code === 0 || closedResult.code === 3)) || pipeError)
        throw new PlatformError('INCOMPATIBLE', 'Python failure status, exit code or pipe closure disagrees');
      if (authorityError) throw authorityError;
      if (options.signal.aborted || control.signal.aborted || failure.status === 'CANCELLED') throw new PlatformError('UNAVAILABLE', 'Analysis was cancelled; the Python child and native owners reported clean closure');
      throw new PlatformError(failure.error.code === 'INVALID_PROTOCOL' ? 'INCOMPATIBLE' : 'UNAVAILABLE', failure.error.message);
    }
    throw new PlatformError('INCOMPATIBLE', 'Python runner returned an unrecognized result status');
  } catch (error) {
    if (childStarted && childClosed && !cleanupProven) markUncertain();
    throw error;
  } finally {
    clearInterval(monitor);
    options.signal.removeEventListener('abort', abortControl);
  }
}

export interface RunnerService {
  run(request: AnalysisRequest, options: { signal: AbortSignal; assertCurrent(): void | Promise<void> }): Promise<AnalysisResult>;
  readiness(): Promise<Readiness>;
  close(): Promise<void>;
}

export function createRunnerService(): RunnerService {
  const profilePath = process.env[PROFILE_ENV];
  const active = new Map<AbortController, Promise<AnalysisResult>>();
  let uncertain = false;
  return {
    run(request, options) {
      if (!profilePath) throw new PlatformError('UNAVAILABLE', 'No trusted local inference profile is configured');
      if (uncertain) throw new PlatformError('UNAVAILABLE', 'A previous Python execution has unconfirmed native cleanup');
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) controller.abort();
      const promise = runPipe(request, { ...options, signal: controller.signal }, profilePath, signal => readinesForDispatch(profilePath, signal), () => { uncertain = true; });
      active.set(controller, promise);
      void promise.finally(() => { options.signal.removeEventListener('abort', abort); active.delete(controller); }).catch(() => undefined);
      return promise;
    },
    async readiness() {
      if (uncertain) return unavailable('A previous Python execution has unconfirmed native cleanup.');
      if (!profilePath) return unavailable('No trusted local inference profile is configured');
      const cached = verificationCache.get(normalizePath(profilePath));
      if (cached) return cached.readiness;
      try { return (await verifyProfile(profilePath)); }
      catch (error) { return unavailable(error instanceof PlatformError ? error.message : 'Local inference profile could not be verified'); }
    },
    async close() {
      const owned = [...active.entries()];
      for (const [controller] of owned) controller.abort();
      // Each promise settles only after its actual child close event has been observed.
      await Promise.allSettled(owned.map(([, promise]) => promise));
      if (active.size) throw new PlatformError('UNAVAILABLE', 'A Python child remained owned after adapter closure');
      if (uncertain) throw new PlatformError('UNAVAILABLE', 'Native cleanup remains unconfirmed; preserve the product generation for explicit repair');
    }
  };
}

async function readinesForDispatch(profilePath: string, signal?: AbortSignal) { return readinessFor(profilePath, signal); }
function unavailable(message: string): Readiness { return { status: 'UNAVAILABLE', profileId: PROFILE_ID, fixtureId: FIXTURE_ID, modelId: PROFILE_ID, sourceSha256: '', modelSha256: '', inventorySha256: '', verifiedAt: '', message: message.slice(0, 200), versions: {} }; }

export function createRfdetr(manifest: ModuleManifest, runner: RunnerService): HostedModule {
  const operations: OperationRegistration[] = [{ descriptor: operationDescriptor, async handle(ctx) {
    ctx.assertAllowed('veyviz.ai.read', 'read');
    const state = await runner.readiness();
    ctx.assertAllowed('veyviz.ai.read', 'read');
    return { ...state, versions: Object.entries(state.versions).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version })) };
  } }];
  return { manifest, services: { 'veyviz.recorded-analysis.run.v1': runner }, operations, routes: [
    { method: 'GET', path: '/api/ai/readiness', permission: 'veyviz.ai.read', kind: 'read', async handle(ctx) { ctx.assertAllowed('veyviz.ai.read', 'read'); const state = await runner.readiness(); ctx.assertAllowed('veyviz.ai.read', 'read'); return state; } }
  ], start: async () => { if (process.env[PROFILE_ENV]) await verifyProfile(process.env[PROFILE_ENV]!); }, close: () => runner.close() };
}

export function register(env: ModuleEnvironment) { return createRfdetr(env.manifest, createRunnerService()); }
