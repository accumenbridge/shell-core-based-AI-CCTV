# KERNEL-CI-001 — repeatable kernel checks and continuous integration

Authorization: user 2026-10-01 “ok proceed” after the source-grounded verdict review
recommended diagnosing the existing failure, establishing GitHub CI, consolidating
current status and then selecting one production operating profile. This increment
delivers the first reliability/CI step. It does not qualify customer production.

Sol/high plans and independently reviews; /root/repo_brain_validation is the sole
Luna/xhigh implementation writer; /root owns shared Brain records. Follow the
source-grounded plan in .brain/evidence/kernel-ci-001-plan-01.md.

Initial maintained writer scope: tests/build-worker-process.test.mjs,
tests/runtime-protocol.test.mjs, package.json, .nvmrc, tools/verify.mjs if scheduling
needs alignment, README.md and docs/STATUS.md. New bounded files:
.github/workflows/kernel-ci.yml, .github/workflows/kernel-native.yml,
tools/ci-build-host.mjs and docs/CI.md.
The initial candidate uses existing files. Root appends these new files to the
final exact contract before qualifying checks; preserve the initial checkpoint.
No runtime implementation owner is eligible without a concrete diagnosis and an
explicit named scope amendment.

Preserve 15-second fixture execution and 10-second marker limits initially, every
heartbeat/timeout/cancellation/descendant-exit/CLEAN/removal assertion, ordinary
host policy, reviewed helper hash, identities, grants, transactions and snapshots.
Add bounded pre-cleanup attempt-state diagnostics. Set a one-test-file-at-a-time
baseline to bound resource contention without changing test selection or concurrency
inside tests. A passing new run does not explain the historical failure.

Configure read-only, pinned automatic portable CI and a separate manual native
Windows qualification workflow on Node24.19.0. Official hosted image source sets
LocalMachine Unrestricted, so do not make every PR repeat that known incompatibility.
Portable CI explicitly reports Windows native coverage NOT_QUALIFIED. The Windows
job creates an ignored private profile from actual selected
binary identities only after unchanged ordinary policy preflight passes. No policy
override, system configuration, hidden platform skip, credentials or deployment.
Replace historical machine-specific Node/PowerShell assertions in protocol tests
with verified run-local identities; keep the reviewed helper pin and matrix intact.

Build before focused native checks. Freeze final candidate before ordinary npm test.
For this task a passing full suite is required, with exact blocked/skipped scopes
reported separately. Obtain independent exact review. Hosted workflow runs, browser,
model/provider and production qualification are separate results; configured YAML
does not establish hosted success. Do not copy credentials or databases into logs.

Later production-profile selection, adapter breadth and additional screens are
deferred until the reliability baseline is qualified. Preserve all older results.

## Actual hosted failure and bounded test repair

Hosted Ubuntu run36906870497 at head86e1b09 (merge tree identical to that head)
completed305 tests:270pass,1fail,34platformskips,exit1. The sole failure in
tests/runtime-manager-preparation.test.mjs expected its occupied-slot double to be
reached on Linux, but the correct Windows-only host guard rejected before artifact
verification or admission. Sol independently diagnosed this exact ordering.

Add tests/runtime-manager-preparation.test.mjs to sole Luna ownership. Rename the
existing case for profile/admission rejection. POSIX asserts typed RUNTIME_UNAVAILABLE
and zero artifact verification, admission or settlement plus no captured owner.
Windows retains the occupied-slot error and every existing no-data/no-execution/
no-settlement assertion. Preserve the application guard; no bypass, new adapter or
platform skip. Fresh build and current native/preparation checks precede full suite
and another actual Ubuntu CI run. Prior failed and interrupted evidence stays intact.
