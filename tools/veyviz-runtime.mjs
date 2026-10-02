import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// This fixed launcher wrapper owns one runtime and its worker. It is product
// tooling, not a change to the maintained host or a privileged network service.
const [root, product, configPath, portText] = process.argv.slice(2);
let runtime, web, worker, workerRun, initialization, stopping, stopRequested = false;
const send = message => { if (process.connected) process.send(message); };
const stop = () => {
  stopRequested = true;
  return stopping ??= (async () => {
    const errors = [];
    // A stop during async startup still owns every resource startup creates.
    try { await initialization; } catch { /* startup reports its own failure */ }
    worker?.stop();
    try { if (web) await web.close(); } catch (error) { errors.push(error); }
    try { if (workerRun) await workerRun; } catch (error) { errors.push(error); }
    try { if (runtime) await runtime.close(); } catch (error) { errors.push(error); }
    if (errors.length) { send({ type: 'failed', message: 'Product cleanup failed; inspect retained local diagnostics.' }); process.exitCode = 1; }
    else send({ type: 'stopped', cleanup: true });
    if (process.connected) process.disconnect();
  })();
};
process.on('message', message => { if (message?.type === 'stop') void stop(); });
process.on('disconnect', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
initialization = (async () => {
  const { createRuntime } = await import(pathToFileURL(join(root, 'apps/runtime/dist/index.js')).href);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (product === 'veyviz-review' && !stopRequested) {
    const { verifyProfile } = await import(pathToFileURL(join(root, 'modules/veyviz-rfdetr/dist/bridge.js')).href);
    await verifyProfile(process.env.VEYVIZ_AI_PROFILE);
  }
  if (!stopRequested) runtime = await createRuntime(product, config, root);
  if (!stopRequested) {
    const enrollmentPath = join(dirname(configPath), 'enrollment.json');
    const enrollment = JSON.parse(await readFile(enrollmentPath, 'utf8'));
    if (enrollment.status === 'PENDING') {
      const temporary = enrollmentPath + '.ready';
      await writeFile(temporary, JSON.stringify({ ...enrollment, status: 'COMPLETE' }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, enrollmentPath);
    }
    web = await runtime.http(Number(portText));
    if (runtime.plan.requiresWorker && !stopRequested) {
      worker = await runtime.worker();
      workerRun = worker.run();
      workerRun.catch(error => { console.error('Worker failed:', error.message); process.exitCode = 1; void stop(); });
    }
    if (!stopRequested) send({ type: 'ready', url: web.url });
  }
})();
try { await initialization; }
catch (error) {
  console.error('Product startup failed:', error.message);
  send({ type: 'failed', message: 'Product startup failed. Check the build and reviewed AI profile.' });
  process.exitCode = 1;
  await stop();
}
