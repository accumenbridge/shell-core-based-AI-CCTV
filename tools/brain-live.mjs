import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from './brain-control.mjs';
import { inspectAtlas, renderAtlas } from './brain-atlas.mjs';
import { CodexProposalAdapter } from './brain-app-server.mjs';
import { html, css, js } from './brain-live-ui.mjs';

export async function startLive({ root, storeRoot, adapter = null, port = 0 }) {
  const controller = await createController({ root, storeRoot, adapter });
  const token = randomBytes(32).toString('hex');
  let origin;
  const authorized = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, type, content) => { response.writeHead(status, { 'Content-Type': type }); response.end(content); };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    try {
      if (request.headers.host !== new URL(origin).host) return json(403, { error: { message: 'Unexpected local host.' } });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && ['/', '/style.css', '/client.js'].includes(url.pathname)) {
        const asset = url.pathname === '/' ? ['text/html', html] : url.pathname === '/style.css' ? ['text/css', css] : ['text/javascript', js];
        return send(200, `${asset[0]}; charset=utf-8`, asset[1]);
      }
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : null;
      if (request.method === 'GET' && ['/preview', '/atlas'].includes(url.pathname)) {
        const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('brain_session='))?.slice(14);
        if (!authorized(cookie)) return json(401, { error: { message: 'Connect before opening a preview.' } });
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts");
        if (url.pathname === '/atlas') {
          const [inspection, snapshot] = await Promise.all([inspectAtlas(root), controller.snapshot()]);
          return send(200, 'text/html; charset=utf-8', renderAtlas(inspection.profile, inspection, snapshot.canonicalProjection));
        }
        const snapshot = await controller.snapshot();
        if (url.searchParams.get('order') !== snapshot.controller.order?.id) return json(409, { error: { message: 'Preview order changed.' } });
        return send(200, 'text/html; charset=utf-8', await controller.preview());
      }
      if (!authorized(bearer)) return json(401, { error: { message: 'Local access token required.' } });
      if (request.method === 'GET' && url.pathname === '/api/state') {
        response.setHeader('Set-Cookie', `brain_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(200, await controller.snapshot());
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0] !== 'application/json') return json(403, { error: { message: 'Decision must originate in this local console.' } });
        let body = '';
        for await (const chunk of request) { body += chunk.toString(); if (body.length > 12000) return json(413, { error: { message: 'Decision exceeds the supported size.' } }); }
        return json(200, await controller.action(JSON.parse(body)));
      }
      return json(404, { error: { message: 'Unknown fixed operation.' } });
    } catch (error) { return json(error.code === 'ENOENT' ? 404 : 409, { error: { code: error.code ?? 'REQUEST_ERROR', message: error.message } }); }
  });
  try {
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); });
  } catch (error) { await controller.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, url: `${origin}/#token=${token}`, controller,
    close: async () => { server.closeIdleConnections(); await new Promise(done => server.close(done)); await controller.close(); } };
}

async function main() {
  const args = process.argv.slice(2); const options = { root: process.cwd(), port: 0 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') { process.stdout.write('node tools/brain-live.mjs --root <project> --store <private-controller-store> [--port 4399] [--codex <executable>] [--model <available-model>]\nWithout --codex the console is observation-only. Managed execution requires a reviewed .brain/control/<TASK>.json profile.\n'); return; }
    if (!['--root', '--store', '--port', '--codex', '--model'].includes(key) || !args[i + 1]) throw new Error(`Invalid option ${key}`);
    options[key.slice(2)] = args[++i];
  }
  if (!options.store) throw new Error('Supply an explicit --store path for controller-owned records.');
  const port = Number(options.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const adapter = options.codex ? new CodexProposalAdapter({ executable: options.codex, model: options.model }) : null;
  const live = await startLive({ root: resolve(options.root), storeRoot: resolve(options.store), adapter, port });
  process.stdout.write(`Brain local console: ${live.url}\nKeep this local access URL private. Stop with Ctrl+C.\n`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await live.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`); process.exitCode = 1; });
