import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProduct, ROOT } from '../../.local/product-paging-evidence/snapshot-overlay-2437aeb7d7627763/source/tools/veyviz-start.mjs';

test('diagnose owned startup from the Node test runner', async () => {
  try {
    const app = await startProduct({ product: 'veyviz-catalog', dataRoot: join(tmpdir(), `veyviz-diagnostic-${randomUUID()}`), port: 0 });
    await app.stop();
  } catch (error) {
    const owner = error.owner;
    const causes = error instanceof AggregateError ? [...error.errors].map(cause => String(cause?.stack ?? cause)) : [];
    process.stderr.write(JSON.stringify({
      root: ROOT,
      error: String(error?.stack ?? error),
      causes,
      diagnostics: owner?.diagnostics ?? null,
      childExited: owner ? owner.child.exitCode !== null : null,
      childSignal: owner?.child.signalCode ?? null
    }, null, 2) + '\n');
    throw error;
  }
});
