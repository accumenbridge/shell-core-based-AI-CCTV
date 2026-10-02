# Bounded native heartbeat fixture budget correction

Read-only owning-source diagnosis, 2026-10-01. Planning evidence only; no edit, build, native launch or test rerun by the reviewer. Sole writer remains frozen until root admits the correction after the current suite closes.

## Established source defect

`tests/build-worker-process.test.mjs:90` overrides the fixture's existing 15000 ms execution timeout with 6000 ms for the cancellation/timeout case. Its prerequisite `waitForMarker()` at lines57–62 allows 10000 ms for the real descendant to start. `apps/control-plane/src/build-worker.ts:395` starts the execution clock immediately after launching the Windows helper; line422 applies that deadline while helper compilation, job assignment and descendant startup may still be pending. A legitimate startup within the test's observation allowance can therefore be stopped by the fixture before that observation allowance expires. The cancellation half also needs an active heartbeat before it requests cancellation.

This is a concrete inconsistency between the fixture's startup observation and execution budgets. It does not establish the failure code, exact startup phase or termination facts of an already removed historical attempt.

## Actual observation and limits

The current `.local/brain-005-full-suite.log` records this case FAIL at approximately 19119 ms while its neighboring shutdown (15000 ms timeout) and lease-loss (20000 ms timeout) cases pass. At the review read, the running spec log contains the failure headline but not this invocation's detailed stack or durable attempt state. Earlier CP7 first-marker failures remain preserved. Do not claim the current attempt or previous exact attempt recorded `BUILD_TIMEOUT` without its own data. Whole test duration includes setup and teardown and is not measured helper startup time.

The same current log also records a failed actual saved-definition build case at approximately 31224 ms; it is separate and its final failure detail must be read and retained. This fixture repair cannot resolve or conceal an unrelated core build failure.

## Smallest permitted repair

Change only the first test's fixture call in `tests/build-worker-process.test.mjs` to omit `timeoutMs:6000`, using its existing default of 15000 ms. Do not change application defaults, helper policy/process ownership, marker observation timeout, cancellation semantics, retries, global test concurrency or production code.

Preserve every existing assertion: the descendant's advancing heartbeat before cancellation; CANCELLED plus CLEAN; actual descendant exit; attempt-directory absence only after job proof; the separate timeout attempt reaching FAILED with `failureCode: BUILD_TIMEOUT`; its CLEAN state, descendant exit and directory removal. Timeout remains genuinely exercised with a finite budget; it is not disabled or converted into a skip.

After root's one-line admission and writer freeze, use a fresh build and the existing named test to verify the correction, capture its exact hash and actual raw result, and retain failed history. The final shared required suite runs at the coordinated frozen core boundary without an overlapping realtime native browser fixture. No native stress sweep or new edge/fault matrix is requested. Final acceptance still needs the actual continuous core journey and matching suite evidence; this source-grounded budget correction is not a retrospective causal diagnosis or a pass.

Reviewed source hashes: test `62c0c9be3eb650ecf8d964fdf75e8c9bfd729fb6610f24d362d3d36f1b36bc46`; worker `42ed7a0731d330284d48377d2ca8f7042b0ed2758ef18f35d9ba0d85c1a084cc`.
