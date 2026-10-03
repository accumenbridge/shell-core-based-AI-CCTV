import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const dataRoot = resolve(process.argv[3]);
const { startProduct } = await import(pathToFileURL(join(root, 'tools/veyviz-start.mjs')).href);
try {
  const app = await startProduct({ product: 'veyviz-catalog', dataRoot, port: 0 });
  process.stdout.write(JSON.stringify({ status: 'READY', product: app.product }) + '\n');
  const stopped = await app.stop();
  process.stdout.write(JSON.stringify({ status: 'STOPPED', ...stopped }) + '\n');
} catch (error) {
  const owner = error.owner;
  let completion;
  if (owner) {
    try { completion = await owner.completion; }
    catch (completionError) { completion = { error: String(completionError?.stack ?? completionError) }; }
  }
  process.stderr.write(JSON.stringify({
    status: 'START_FAILED',
    error: String(error?.stack ?? error),
    causes: error instanceof AggregateError ? [...error.errors].map(cause => String(cause?.stack ?? cause)) : [],
    diagnostics: owner?.diagnostics ?? null,
    childExited: owner ? owner.child.exitCode !== null : null,
    childSignal: owner?.child.signalCode ?? null,
    completion: completion ?? null
  }, null, 2) + '\n');
  process.exitCode = 1;
}
