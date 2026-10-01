import { DatabaseSync } from 'node:sqlite';
import { ControlPlaneStore } from '../../packages/control-plane/dist/index.js';
import { LocalArtifactStore } from '../../apps/control-plane/dist/artifact-store.js';

const [root, dbPath, buildId, mode, extra] = process.argv.slice(2);
let store;
let artifacts;

function waitForGo(timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      process.stdin.unref();
      reject(new Error('owner fixture did not receive GO before its deadline'));
    }, timeoutMs);
    const onData = chunk => {
      input += chunk.toString('utf8');
      if (input.includes('\n')) {
        clearTimeout(timer);
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
        process.stdin.pause();
        process.stdin.unref();
        resolve();
      }
    };
    const onEnd = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.pause();
      process.stdin.unref();
      reject(new Error('owner fixture control pipe closed before GO'));
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

async function main() {
  if (mode === 'hold-lock') {
    const db = new DatabaseSync(dbPath, { timeout: 2_000 });
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('LOCKED\n');
    await new Promise(resolve => setTimeout(resolve, Number(extra)));
    db.exec('COMMIT');
    db.close();
    process.stdout.write('RELEASED\n');
    return;
  }

  store = new ControlPlaneStore(dbPath);
  artifacts = await LocalArtifactStore.create(root, store);
  const originalRunPublisher = artifacts.runPublisher.bind(artifacts);
  if (mode === 'pause-before' || mode === 'pause-after') {
    artifacts.runPublisher = async (...args) => {
      if (mode === 'pause-before') {
        process.stdout.write('READY_BEFORE\n');
        await waitForGo();
      }
      const result = await originalRunPublisher(...args);
      if (mode === 'pause-after' && result === 'MOVED') {
        process.stdout.write('READY_AFTER\n');
        await waitForGo();
      }
      return result;
    };
  }

  try {
    const result = await artifacts.register(buildId, 'system:artifact-process-test', () => undefined);
    process.stdout.write(`REGISTERED:${JSON.stringify({ digest: result.digest })}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'ERROR';
    process.stdout.write(`REGISTER_ERROR:${JSON.stringify({ code, message: String(error?.message ?? error) })}\n`);
    if (mode !== 'try-conflict' || code !== 'CONFLICT') process.exitCode = 2;
  } finally {
    await artifacts?.close();
    store?.close();
  }
  process.stdout.write('CLEAN_CLOSED\n');
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
