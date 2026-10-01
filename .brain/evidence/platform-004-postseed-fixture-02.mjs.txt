import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [artifactRoot, dataDirectory, markerPath] = process.argv.slice(2);
if (![artifactRoot, dataDirectory, markerPath].every(value => typeof value === 'string' && value.length > 0)) {
  process.exitCode = 81;
} else {
  const databasePath = join(dataDirectory, 'access.sqlite');
  let reservation;
  let access;
  let stage = 'read-private-inputs';
  try {
    const intent = JSON.parse(readFileSync(join(dataDirectory, 'enrollment-intent.json'), 'utf8'));
    const config = JSON.parse(readFileSync(join(dataDirectory, 'runtime-config.json'), 'utf8'));
    const seeds = JSON.parse(readFileSync(join(dataDirectory, 'enrollment-private.json'), 'utf8')).principals;
    const localAccessPath = join(artifactRoot, 'packages', 'local-access', 'dist', 'index.js');
    stage = 'import-canonical-local-access';
    const implementation = await import(pathToFileURL(localAccessPath).href);
    if (typeof implementation.LocalAccess !== 'function' || !Array.isArray(seeds) || !seeds.length || !Array.isArray(config.principals) ||
        config.principals.length !== 0 || intent.instanceId !== config.instanceId || !intent.productId || intent.dataDirectory !== dataDirectory) {
      process.exitCode = 82;
    } else {
      stage = 'reserve-access-database';
      reservation = openSync(databasePath, 'wx');
      stage = 'construct-canonical-local-access';
      access = new implementation.LocalAccess(databasePath, { productId: intent.productId, instanceId: intent.instanceId });
      stage = 'seed-canonical-local-access';
      access.seed(seeds);
      stage = 'close-canonical-local-access';
      access.close();
      access = undefined;
      closeSync(reservation);
      reservation = undefined;
      // This fixed fixture models a process interruption after canonical seed
      // commit and close, before the manager can publish enrollment COMPLETE.
      stage = 'write-postseed-marker';
      writeFileSync(markerPath, 'SEED_CLOSED\n', { flag: 'wx' });
      process.exitCode = 73;
    }
  } catch {
    try { process.stdout.write(`NATIVE_FAILURE:${stage}\n`); } catch {}
    process.exitCode = 83;
  } finally {
    try { access?.close(); } catch {}
    try { if (reservation !== undefined) closeSync(reservation); } catch {}
  }
}
