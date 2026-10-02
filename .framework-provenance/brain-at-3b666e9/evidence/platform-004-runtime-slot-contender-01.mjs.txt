import { randomBytes, randomUUID } from 'node:crypto';
import { ControlPlaneStore } from '../../packages/control-plane/dist/index.js';

const [databasePath, encoded] = process.argv.slice(2);
let store;
try {
  if (typeof databasePath !== 'string' || typeof encoded !== 'string') throw new Error('invalid fixture arguments');
  const values = JSON.parse(encoded);
  store = new ControlPlaneStore(databasePath);
  const intent = {
    instanceId: `runtime-${randomUUID()}`,
    operationId: randomUUID(),
    ownerId: randomUUID(),
    ownerToken: randomBytes(32).toString('base64url'),
    actorId: 'system:cross-process-contender',
    originatingActorId: values.originatingActorId,
    requestKey: 'runtime-cross-process-slot-0001',
    productId: values.productId,
    version: values.version,
    artifactDigest: values.artifactDigest,
    profileDigest: values.profileDigest,
    configDigest: '0'.repeat(64),
    adapterDigest: '0'.repeat(64),
    toolchainDigest: '0'.repeat(64),
    recipeDigest: '0'.repeat(64),
    workerRequired: values.workerRequired,
    preparationComplete: false,
    executionBytes: 1024
  };
  try {
    store.beginManagedRuntimeStart(intent, () => undefined);
    process.stdout.write('ADMITTED\n');
    process.exitCode = 3;
  } catch (error) {
    if (error?.code === 'CONFLICT') process.stdout.write('CONFLICT\n');
    else {
      process.stdout.write('UNEXPECTED\n');
      process.exitCode = 2;
    }
  }
} catch {
  process.stdout.write('FIXTURE_ERROR\n');
  process.exitCode = 2;
} finally {
  try { store?.close(); }
  catch { process.exitCode = 2; }
}
