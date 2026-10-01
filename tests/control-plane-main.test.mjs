import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installShutdownHandlers, observeCloseOutcome } from '../apps/control-plane/dist/main.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('runtime close rejection is observed before a delayed HTTP drain settles', async () => {
  const pendingClose = deferred();
  const httpDrain = deferred();
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const observedClose = observeCloseOutcome(pendingClose.promise);
    pendingClose.reject(new Error('runtime close fixture failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    httpDrain.resolve();
    assert.equal((await httpDrain.promise), undefined);
    const result = await observedClose;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /runtime close fixture failure/);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('a failed signal shutdown can retry the same close owner on a later signal', async t => {
  const target = new EventEmitter();
  let calls = 0;
  const errors = [];
  const remove = installShutdownHandlers(async () => {
    calls += 1;
    if (calls === 1) throw new Error('first close attempt failed');
    return 'closed';
  }, error => errors.push(error), target);
  t.after(remove);

  target.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.match(errors[0].message, /first close attempt failed/);

  target.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
});
