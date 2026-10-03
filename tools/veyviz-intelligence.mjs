import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { startProduct } from './veyviz-start.mjs';

/** A fixed loopback facade, never an arbitrary URL proxy. Preserves host CSP. */
export async function createFacade({ productUrl, mediaPort, port = 0 }) {
  const target = new URL(productUrl);
  if (target.hostname !== '127.0.0.1' || !Number.isInteger(mediaPort) || mediaPort < 1 || mediaPort > 65535) throw Error('Fixed local targets required');
  let actualPort = port;
  const server = createServer((req, res) => {
    const hostname = req.headers.host;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(hostname ?? '') || (req.url?.length ?? 0) > 4096) { res.writeHead(403).end(); return; }
    const media = /^\/media\/[a-zA-Z0-9_-]{43}$/.test(req.url ?? '');
    if ((req.url ?? '').startsWith('/media/') && !media) { res.writeHead(404).end(); return; }
    if (media && !['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${hostname}`) { res.writeHead(403).end(); return; }
    if (req.method === 'POST' && req.headers.origin !== `http://${hostname}` && !req.headers.authorization?.startsWith('Bearer ')) { res.writeHead(403).end(); return; }
    const headers = { ...req.headers, host: media ? `127.0.0.1:${mediaPort}` : target.host };
    if (req.headers.origin) headers.origin = media ? `http://127.0.0.1:${mediaPort}` : target.origin;
    const upstream = request({ hostname: '127.0.0.1', port: media ? mediaPort : Number(target.port), method: req.method, path: req.url, headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); response.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady); });
  actualPort = server.address().port;
  return { url: `http://127.0.0.1:${actualPort}`, async close() { server.closeAllConnections(); await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fields = { '--port': 'port', '--media-port': 'mediaPort', '--catalog': 'catalog', '--data-root': 'dataRoot', '--profile': 'profilePath', '--intelligence-profile': 'intelligenceProfile' }, options = { port: 4490, mediaPort: 4492 };
  for (let i = 2; i < process.argv.length; i++) { const field = fields[process.argv[i]]; if (!field || !process.argv[i + 1]) throw Error('Use --catalog PATH [--port4490 --media-port4492 --data-root PATH --profile PATH]'); options[field] = ['port', 'mediaPort'].includes(field) ? Number(process.argv[++i]) : resolve(process.argv[++i]); }
  if (!options.catalog) throw Error('Select an admitted recording catalog with --catalog');
  process.env.VEYVIZ_RECORDINGS_CATALOG = options.catalog; process.env.VEYVIZ_MEDIA_PORT = String(options.mediaPort);
  if (options.intelligenceProfile) process.env.VEYVIZ_INTELLIGENCE_PROFILE = options.intelligenceProfile;
  const product = await startProduct({ port: 0, ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}), ...(options.profilePath ? { profilePath: options.profilePath } : {}) });
  let facade;
  try { facade = await createFacade({ productUrl: product.url, mediaPort: options.mediaPort, port: options.port }); }
  catch (error) { await product.stop(); throw error; }
  console.log(`Recording intelligence: ${facade.url}/#/intelligence\nLocal credentials: ${product.credentialsPath}`);
  let stopping = false;
  const input = createInterface({ input: process.stdin });
  const stop = async () => { if (stopping) return; stopping = true; input.close(); await facade.close(); await product.stop(); };
  input.on('line', line => { if (line.trim() === 'stop') void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  await product.completion; input.close(); if (!stopping) await facade.close();
}
