import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PlatformError } from '@quadbridge/contracts';
import { recordingBytes } from './catalog.js';
import type { Recording } from './protocol.js';

export function byteRange(header: string | undefined, length: number): [number, number] | null {
  if (header === undefined) return [0, length - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return null; start = Math.max(0, length - suffix); end = length - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : length - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= length || end < start) return null;
  return [start, Math.min(end, length - 1)];
}
/** Local-only binary delivery. The owned facade supplies the browser's same origin. */
export class MediaGateway {
  private server?: Server;
  private starting?: Promise<void>;
  private reservations = 0;
  private reservedBytes = 0;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private grants = new Map<string, { bytes: Buffer; expires: number; authorize(): void }>();
  private expiry = setInterval(() => { for (const [key, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(key); }, 10000).unref();
  port = 0;
  private async start() {
    if (this.server) return;
    return this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        try {
          if (!['GET', 'HEAD'].includes(req.method ?? '') || ![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host ?? '')) throw new PlatformError('DENIED', 'Invalid media request');
          const match = /^\/media\/([a-zA-Z0-9_-]{43})$/.exec(req.url ?? '');
          const grant = match ? this.grants.get(match[1]!) : undefined;
          if (!grant || grant.expires <= Date.now()) { if (match) this.grants.delete(match[1]!); res.writeHead(404).end(); return; }
          grant.authorize();
          const range = byteRange(req.headers.range, grant.bytes.length);
          res.setHeader('Accept-Ranges', 'bytes');
          if (!range) { res.setHeader('Content-Range', `bytes */${grant.bytes.length}`); res.writeHead(416).end(); return; }
          const [start, end] = range;
          res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', end - start + 1);
          if (req.headers.range) res.setHeader('Content-Range', `bytes ${start}-${end}/${grant.bytes.length}`);
          res.writeHead(req.headers.range ? 206 : 200);
          res.end(req.method === 'HEAD' ? undefined : grant.bytes.subarray(start, end + 1));
        } catch { res.writeHead(403).end(); }
      });
      server.once('error', reject);
      server.listen(Number(process.env.VEYVIZ_MEDIA_PORT ?? 0), '127.0.0.1', () => { this.server = server; this.port = (server.address() as { port: number }).port; resolve(); });
    });
  }
  async issue(recording: Recording, authorize: () => void, lifetimeMs = 120000) {
    if (this.closed) throw new PlatformError('UNAVAILABLE', 'Media gateway is closed');
    authorize();
    for (const [key, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(key);
    const retained = [...this.grants.values()].reduce((sum, grant) => sum + grant.bytes.length, 0);
    if (this.grants.size + this.reservations >= 8 || retained + this.reservedBytes + recording.bytes > 256 * 1024 * 1024) throw new PlatformError('EXHAUSTED', 'Playback session budget exhausted');
    this.reservations++; this.reservedBytes += recording.bytes;
    const work = (async () => {
      const bytes = await recordingBytes(recording); authorize(); await this.start(); authorize();
      if (this.closed) throw new PlatformError('UNAVAILABLE', 'Media gateway is closing');
      const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + lifetimeMs;
      this.grants.set(token, { bytes, expires: expiresAt, authorize });
      return { path: `/media/${token}`, expiresAt };
    })();
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); this.reservations--; this.reservedBytes -= recording.bytes; }
  }
  close(): Promise<void> { return this.closing ??= (async () => { this.closed = true; clearInterval(this.expiry); await Promise.allSettled([...this.pending]); this.grants.clear(); await this.starting?.catch(() => {}); if (this.server) { this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve())); } })(); }
}
