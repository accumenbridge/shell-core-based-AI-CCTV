import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { PlatformError, id, integer, object, text } from '@quadbridge/contracts';
import type { Recording, RecordingView } from './protocol.js';

export const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
export function view({ path: _path, tenantId: _tenant, ...recording }: Recording): RecordingView { return recording; }
export async function catalog(): Promise<Recording[]> {
  const path = process.env.VEYVIZ_RECORDINGS_CATALOG;
  if (!path) return [];
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new PlatformError('INCOMPATIBLE', 'Recording catalog is not an admitted bounded file');
  return parseCatalog(JSON.parse(await readFile(path, 'utf8')));
}
export function catalogSync(): Recording[] {
  const path = process.env.VEYVIZ_RECORDINGS_CATALOG; if (!path) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new PlatformError('INCOMPATIBLE', 'Recording catalog changed');
  return parseCatalog(JSON.parse(readFileSync(path, 'utf8')));
}
function parseCatalog(raw: unknown): Recording[] {
  const data = object(raw, ['schema', 'recordings']);
  if (data.schema !== 'veyviz.recording-catalog.v1' || !Array.isArray(data.recordings) || data.recordings.length > 100) throw new PlatformError('INCOMPATIBLE', 'Unsupported recording catalog');
  const seen = new Set<string>();
  return data.recordings.map(value => {
    const item = object(value, ['id', 'tenantId', 'name', 'path', 'sha256', 'bytes', 'captureStartUtc', 'clockUncertaintyMs']);
    const recording: Recording = { id: id(item.id), tenantId: id(item.tenantId), name: text(item.name, 'name', 160), path: text(item.path, 'path', 4096), sha256: text(item.sha256, 'sha256', 64), bytes: integer(item.bytes, 1, MAX_RECORDING_BYTES), captureStartUtc: item.captureStartUtc as string | null, clockUncertaintyMs: item.clockUncertaintyMs === null ? null : integer(item.clockUncertaintyMs, 0, 86400000) };
    if (!isAbsolute(recording.path) || !/^[a-f0-9]{64}$/.test(recording.sha256) || (recording.captureStartUtc !== null && (typeof recording.captureStartUtc !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(recording.captureStartUtc) || !Number.isFinite(Date.parse(recording.captureStartUtc)))) || (recording.captureStartUtc === null) !== (recording.clockUncertaintyMs === null)) throw new PlatformError('INCOMPATIBLE', 'Invalid recording provenance');
    const key = `${recording.tenantId}/${recording.id}`;
    if (seen.has(key)) throw new PlatformError('INCOMPATIBLE', 'Duplicate recording admission');
    seen.add(key); return recording;
  });
}
export async function recordingBytes(recording: Recording): Promise<Buffer> {
  const stat = await lstat(recording.path);
  const actual = await realpath(recording.path);
  if (!stat.isFile() || stat.isSymbolicLink() || resolve(actual).toLowerCase() !== resolve(recording.path).toLowerCase() || stat.size !== recording.bytes || stat.size > MAX_RECORDING_BYTES) throw new PlatformError('INCOMPATIBLE', 'Admitted recording changed');
  const bytes = await readFile(recording.path);
  if (bytes.length !== recording.bytes || createHash('sha256').update(bytes).digest('hex') !== recording.sha256) throw new PlatformError('INCOMPATIBLE', 'Recording digest mismatch');
  return bytes;
}
