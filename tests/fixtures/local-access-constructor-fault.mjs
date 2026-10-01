import { LocalAccess } from '../../packages/local-access/dist/index.js';

const [databasePath] = process.argv.slice(2);
try {
  const access = new LocalAccess(databasePath, { productId: 'service-desk', instanceId: 'runtime-123e4567-e89b-42d3-a456-426614174000' });
  access.close();
  process.stdout.write('UNEXPECTED_SUCCESS\n');
  process.exitCode = 2;
} catch {
  // The fixture deliberately makes the canonical constructor fail after opening
  // its SQLite owner; parent observes this process close before reopening SQLite.
  process.stdout.write('CONSTRUCTOR_FAILED\n');
}
