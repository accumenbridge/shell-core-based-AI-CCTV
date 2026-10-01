import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical } from '@quadbridge/contracts';
import { verifySnapshotManifestFromBytes, type SnapshotIdentity } from './integrity.js';

export interface SnapshotAccessLimits {
  maxFileBytes: number;
  maxArtifactBytes: number;
  maxFiles: number;
  maxManifestBytes: number;
  maxMetadataEntries: number;
  maxMetadataScanMs: number;
  maxDirectoryDepth: number;
}

export interface SnapshotEntryBytes {
  id: string;
  path: string;
  digest: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface BoundedSnapshot {
  snapshotDigest: string;
  releaseDigest: string;
  manifest: Record<string, unknown>;
  manifestJson: string;
  manifestBytes: Buffer;
  entries: SnapshotEntryBytes[];
  entriesJson: string;
  sizeBytes: number;
  fileCount: number;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const entrySelector = (artifactDigest:string,path:string,fileDigest:string) => sha256(`quadbridge-artifact-entry\0${artifactDigest}\0${path}\0${fileDigest}`);
const portable = (path: string) => {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))
    throw new Error('Snapshot contains an unsafe Windows portable path');
};

function checkedRoot(root: string): string {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Snapshot root must be a physical directory');
  const physical = realpathSync(root);
  if (resolve(root).toLowerCase() !== physical.toLowerCase()) throw new Error('Snapshot root resolves through a link or alias');
  return physical;
}

function scan(root: string, limits: SnapshotAccessLimits): string[] {
  const base = checkedRoot(root), paths: string[] = [];
  let total = 0, nodes = 0;
  const started=performance.now();
  const visit = (directory: string, prefix: string, depth: number) => {
    if(depth>limits.maxDirectoryDepth)throw new Error('Snapshot exceeds the supported directory depth');
    const handle=opendirSync(directory,{bufferSize:32});
    try {
      while(true) {
        const entry=handle.readSync();
        if(!entry)break;
        if(++nodes>limits.maxMetadataEntries||performance.now()-started>limits.maxMetadataScanMs)throw new Error('Snapshot exceeds the bounded directory-entry scan');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      portable(path);
      if(Buffer.byteLength(path)>240)throw new Error('Snapshot path exceeds the supported Windows path bound');
      const full = join(directory, entry.name), info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error('Snapshot symlinks and junctions are not accepted');
      if (info.isDirectory()) {
        if (['node_modules', '.git', '.local', '.brain', '.codex'].includes(entry.name.toLowerCase())) throw new Error('Snapshot contains excluded operational state');
        visit(full, path,depth+1);
      } else if (info.isFile()) {
        if (info.size > limits.maxFileBytes) throw new Error('Snapshot file exceeds the per-file registry limit');
        if (path === 'QUADBRIDGE-SNAPSHOT.json' && info.size > limits.maxManifestBytes) throw new Error('Snapshot manifest exceeds its registry limit');
        total += info.size;
        if (total > limits.maxArtifactBytes) throw new Error('Snapshot exceeds the artifact byte limit');
        paths.push(path);
        if (paths.length > limits.maxFiles) throw new Error('Snapshot exceeds the artifact file limit');
      } else throw new Error('Snapshot contains a non-regular file');
      }
    } finally {
      handle.closeSync();
    }
  };
  visit(base, '',0);
  if(performance.now()-started>limits.maxMetadataScanMs)throw new Error('Snapshot exceeds the bounded directory-entry scan');
  const folded = paths.map(path => path.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new Error('Snapshot has case-folded path collisions');
  if (!paths.includes('QUADBRIDGE-SNAPSHOT.json')) throw new Error('Snapshot manifest is missing');
  return paths.sort();
}

function physicalFile(root: string, path: string): string {
  portable(path);
  const base = checkedRoot(root), full = resolve(base, ...path.split('/'));
  const rel = relative(base, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Snapshot entry escaped its root');
  let current = base;
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (index < path.split('/').length - 1 && !info.isDirectory())) throw new Error('Snapshot entry crosses a linked or non-directory path');
  }
  if (!lstatSync(full).isFile()) throw new Error('Snapshot entry is not a regular file');
  return full;
}

function readBoundedFile(full:string,before:Stats,limit:number):Buffer {
  if(!before.isFile()||before.size>limit)throw new Error('Snapshot file exceeds its read bound');
  const fd=openSync(full,'r');
  try {
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.size!==before.size||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('Snapshot file changed before its bounded read');
    const bytes=Buffer.alloc(before.size+1);
    let offset=0;
    while(offset<bytes.length) {
      const count=readSync(fd,bytes,offset,bytes.length-offset,offset);
      if(count===0)break;
      offset+=count;
    }
    const after=fstatSync(fd), pathInfo=lstatSync(full);
    if(offset!==before.size||after.size!==before.size||pathInfo.size!==before.size||!pathInfo.isFile()||pathInfo.isSymbolicLink()||pathInfo.dev!==before.dev||pathInfo.ino!==before.ino)
      throw new Error('Snapshot file changed during its bounded read');
    return bytes.subarray(0,before.size);
  } finally { closeSync(fd); }
}

/** Bound filesystem metadata before JSON parsing, then bind the returned bytes to the canonical CP2 snapshot proof. */
export function readBoundedSnapshot(root: string, expected: Partial<SnapshotIdentity> & { snapshotDigest: string }, limits: SnapshotAccessLimits): BoundedSnapshot {
  const paths = scan(root, limits);
  const buffers = new Map<string, Buffer>();
  const started=performance.now();
  let total = 0;
  for (const path of paths) {
    const full = physicalFile(root, path), before = lstatSync(full) as Stats;
    if (before.size > limits.maxFileBytes || (path === 'QUADBRIDGE-SNAPSHOT.json' && before.size > limits.maxManifestBytes)) throw new Error('Snapshot file exceeded its bound during inspection');
    const bytes = readBoundedFile(full,before,path==='QUADBRIDGE-SNAPSHOT.json'?limits.maxManifestBytes:limits.maxFileBytes);
    total += bytes.length;
    if (total > limits.maxArtifactBytes) throw new Error('Snapshot exceeded its total byte bound while reading');
    buffers.set(path, bytes);
    if(performance.now()-started>limits.maxMetadataScanMs)throw new Error('Snapshot exceeded the bounded capture time');
  }
  if(performance.now()-started>limits.maxMetadataScanMs)throw new Error('Snapshot exceeded the bounded capture time');
  const manifestBytes = buffers.get('QUADBRIDGE-SNAPSHOT.json')!;
  const manifestJson = manifestBytes.toString('utf8');
  let manifest: unknown;
  try { manifest = JSON.parse(manifestJson) as unknown; }
  catch { throw new Error('Snapshot manifest is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Snapshot manifest must be an object');
  if(sha256(canonical(manifest))!==expected.snapshotDigest)throw new Error('Snapshot manifest does not match durable CP2 build evidence');
  const fileMap=(manifest as Record<string,unknown>).files;
  if(!fileMap||typeof fileMap!=='object'||Array.isArray(fileMap))throw new Error('Snapshot manifest file inventory is malformed');
  const declaredPaths=Object.keys(fileMap).sort();
  if(canonical(declaredPaths)!==canonical(paths.filter(path=>path!=='QUADBRIDGE-SNAPSHOT.json')))throw new Error('Snapshot file inventory differs from its bounded physical entries');
  for(const path of declaredPaths) {
    const bytes=buffers.get(path),digest=(fileMap as Record<string,unknown>)[path];
    if(!bytes||typeof digest!=='string'||sha256(bytes)!==digest)throw new Error(`Snapshot bytes differ from their manifest entry: ${path}`);
  }
  const verified = verifySnapshotManifestFromBytes(root, manifest, expected,buffers,paths.filter(path=>path!=='QUADBRIDGE-SNAPSHOT.json'));
  if (verified.snapshotDigest !== expected.snapshotDigest) throw new Error('Snapshot digest does not match durable CP2 build evidence');
  const entries: SnapshotEntryBytes[] = [];
  for (const [path, digest] of Object.entries(fileMap)) {
    const bytes = buffers.get(path);
    if (!bytes || typeof digest !== 'string' || sha256(bytes) !== digest) throw new Error(`Snapshot bytes differ from their manifest entry: ${path}`);
    entries.push({ id: entrySelector(expected.snapshotDigest,path,digest), path, digest, sizeBytes: bytes.length, bytes });
  }
  const manifestDigest = sha256(manifestBytes);
  entries.push({ id: entrySelector(expected.snapshotDigest,'QUADBRIDGE-SNAPSHOT.json',manifestDigest), path: 'QUADBRIDGE-SNAPSHOT.json', digest: manifestDigest, sizeBytes: manifestBytes.length, bytes: manifestBytes });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length !== paths.length) throw new Error('Snapshot entry count differs from its bounded physical inventory');
  const entriesJson = JSON.stringify(entries.map(({ id, path, digest, sizeBytes }) => ({ id, path, digest, sizeBytes })));
  if (Buffer.byteLength(entriesJson) > limits.maxManifestBytes) throw new Error('Snapshot entry metadata exceeds its storage bound');
  return { snapshotDigest: verified.snapshotDigest, releaseDigest: verified.release.releaseDigest,
    manifest: manifest as Record<string, unknown>, manifestJson, manifestBytes, entries, entriesJson,
    sizeBytes: total, fileCount: paths.length };
}

export function verifyStoredEntryMetadata(entriesJson: string, artifactDigest:string): Array<Omit<SnapshotEntryBytes, 'bytes'>> {
  if (Buffer.byteLength(entriesJson) > 2 * 1024 * 1024) throw new Error('Stored artifact entry metadata is too large');
  const value: unknown = JSON.parse(entriesJson);
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) throw new Error('Stored artifact entry metadata is malformed');
  const seen = new Set<string>(), paths = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Stored artifact entry is malformed');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || typeof row.path !== 'string' || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || !Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 0)
      throw new Error('Stored artifact entry is malformed');
    portable(row.path);
    if (!/^[a-f0-9]{64}$/.test(artifactDigest)||row.id !== entrySelector(artifactDigest,row.path,row.digest) || seen.has(row.id) || paths.has(row.path.toLowerCase())) throw new Error('Stored artifact entry identity is duplicated or invalid');
    seen.add(row.id); paths.add(row.path.toLowerCase());
    return { id: row.id, path: row.path, digest: row.digest, sizeBytes: row.sizeBytes as number };
  });
}

export function canonicalManifestJson(value: unknown): string {
  return canonical(value);
}
