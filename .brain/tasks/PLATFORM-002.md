# PLATFORM-002 — durable local product/build journey

Status: ACCEPTED_FOR_LOCAL_BUILD_EXPORT_SCOPE. Luna/xhigh implemented; Sol/high independently approved the exact final candidate and root matched both fingerprint scopes. Full local program remains IN_PROGRESS. Budget unknown.
Base code/profile Git tree: 491456e3a6ea53ab2e8ff9384b53ca6197e45fad (not a commit or Brain snapshot).
Starting source fingerprint: 3fd1bf1055382e94943c2527d6d106ea13977050043a012ee2543cef3ea51f6a.

## Journey and ownership

Compose → save immutable version → request build → real compile/export → inspect durable result or cancel. No runtime deployment, remote registry, provider call, universal job system or edits to exported copies.

Allowed owners: packages/control-plane/src/index.ts and narrow package-local helpers; apps/control-plane main/operator-server/source-import plus app-local worker/staging/process helpers; apps/studio-web main and small static additions; relevant tests/status docs. Reuse canonical composition/studio, studio-catalogue/browserCore, tools/build and factory recipes. Narrow fixes including build workspace-link failure propagation allowed. A pure integrity helper may be extracted from runtime/index and reused while preserving runtime behavior; never start a runtime to verify artifacts. Root alone writes .brain.

## Composition and authority

Derive actual module/solution catalogue from source. The paired console preview calls a fixed authenticated server route using the maintained compiled canonical composer; server revalidates save/admission. No independent client algorithm is introduced. Offline browserCore remains unchanged. Bounded primitive data only, no executable URLs, paths, commands, environment overrides or invented adapters. Preserve exact versions, reviewed bindings, immutability and explicit confirmation.

Bind catalogue to startup source fingerprint. If source changes, reject new compose/save/admission until restart reloads catalogue; never combine stale catalogue with a new fingerprint. Preserve post-body original-session revalidation, including after any awaited preparation and immediately before mutation.

## Durable schema and identity

Transactional additive schema version 2; preserve legacy values and reject future versions before changes. Build/input/attempt records hold original requesting actor, bounded request key, canonical product/plan, product/plan/source/toolchain/recipe/input digests, state/attempt/owner/claim/lease, timestamps/cancel/failure, relative snapshot and release digest, bounded logs and cleanup status. No secret claim token or unrestricted filesystem path in API.

Legacy QUEUED rows without frozen input remain explicitly admission-only/non-executable. Never fabricate or execute them.
Same request key/input returns original build without duplicate audit; changed input conflicts. Preserve original requesting actor through retries/recovery. Record supported key scope explicitly.

## Lifecycle

QUEUED → RUNNING → SUCCEEDED|FAILED; cancellation adds CANCEL_REQUESTED/CANCELLED.
Synchronous BEGIN IMMEDIATE admission/claim/renew/cancel/complete transactions with audit. Never await in SQLite callback.

One local worker attempt at a time. Atomic unpredictable owner/claim tokens, incremented attempt, bounded lease. Every renewal/completion checks exact tokens/attempt/live lease/allowed state. Stale attempt cannot publish any terminal result or overwrite successor.
At most two attempts for abandoned computation; deterministic compiler/input/integrity failure terminal. Explicit rebuild uses new request key.
Queued cancel terminal immediately. Running cancel fences publication immediately, stops and observes owned compute before terminal cancellation. Logout does not cancel accepted work.
Cancellation ownership remains renewable for the exact original owner/token/attempt while state is CANCEL_REQUESTED. Poll cancellation separately from ownership loss. Successful cancellation completion requires that original identity and a live lease; success/progress remain RUNNING-only. Unknown termination stays pending/UNKNOWN.
Restart recovers expired executable claims into distinct attempt directories; no success inferred from abandoned files, no historical PID kill without proven ownership. Quarantine uncertain orphans. Interrupted cancellation with unknown termination remains pending/cleanup UNKNOWN, never false cleaned.

## Frozen inputs and fixed execution

Compare admitted source fingerprint at execution. Copy only reviewed maintained inputs to private attempt directory, exclude credentials/data/operational/generated/dependency state, analysis/Brain; reject source symlinks. Verify copied fingerprint and recheck source before product overlay. Distinguish reviewed-source identity from build-generated OPEN_PLATFORM/visual data effects.
Overlay exact admitted product at validated products/id/product.json only after copy verification; combined identity includes definition/plan.

Record toolchain separately since node_modules is excluded. Privately copy installed pinned TypeScript, @types/node, undici-types and hash/verify identity. Workspace links point only into staged tree; no mutable checkout dist/dependency links, automatic installs or inherited credentials.
Run only process.execPath tools/build.mjs, then process.execPath tools/factory.mjs assemble validated-id server-selected-new-dir. Async child execution, fixed timeout, bounded redacted logs and minimal child environment. Cancel/timeout/lease loss stop and observe owned tree including compiler descendants before removing work directory. Cleanup failure is reported.

Windows host profile decision: the initial hardcoded Windows PowerShell5.1 profile is BLOCKED by its effective Restricted policy. Preserve that evidence and UNKNOWN attempt; never edit policy, remove MOTW, inline the blocked script or silently fall back. Under the authorized local implementation scope, explicitly support the already configured Codex PowerShell7.6.5 host at C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe, whose normal effective policy is RemoteSigned. Select it through a private local profile, outside exports and browser inputs; pin executable identity and preflight version/policy before enabling the worker. Record and test this distinct supported host separately. No installation, global configuration or production qualification follows.

## Verified completion

Verify exported product/version/ABI, canonical plan digest, every backend/web digest using existing integrity rules. Reject traversal, symlink escape, missing files and tampering. Unique server-owned snapshot destination. Persist relative reference/release digest/verified result in fenced transaction before SUCCEEDED. Unreferenced publication after transaction failure is cleanup work, never advertised success. Verified local export only; deployment stays unattached.
The durable verified result also binds the complete snapshot inventory digest, including launch/profile/package metadata outside legacy release maps. Require normalized Windows-safe paths and reject case-folded collisions; verify against trusted private producer evidence, never solely against replaceable exported metadata.

## API and console

Fixed catalogue/compose/validate/save/admit/detail/log/result/cancel routes behind existing session/Host/Origin/body/confirmation rules. Show selected/resolved modules/bindings, saved version, actual state/failure and snapshot identity; bounded refresh while connected and expiry recovery. No arbitrary filesystem browsing. Build executor attached only when actual local worker profile is available.

## Evidence

- Real new composed product save, compiler/factory export/integrity and DB reopen.
- Equal/conflicting versions, duplicate/conflicting key, malformed refs, legacy exclusion.
- Actual compiler failure, export tampering, source drift before/during copy, toolchain mismatch.
- Competing claims, lease expiry/reclaim, stale completion, restart/bounded attempts.
- Queued/running cancel, timeout, observed tree exit, cleanup failure.
- Logout preserves admitted work; denied HTTP request no mutation; all legacy-table values preserved and existing consumers pass.
Fresh build before edited-source tests; targeted lifecycle/API/real-build regressions, npm test and verify with final fingerprint. Real installed-Chrome compose/save/build/result/cancel flow where available. Node22, legacy Studio, renderer, provider and production gates remain separate.

## Accepted checkpoint — 2026-10-01

Maintained fingerprint: 46950c47decc2cd50a8999e336aa7130f1d1693642e0506547a835c9da57b0af. Reviewed build-input fingerprint: 889313656d19a3924e7a2e4ccf78d5eb60aeaaa91d95ae834bea44a56d4ebf8f. Accepted source/profile Git tree: d1d645ed13768b182d37dd1757d78913bccc6cd7; local diff anchor, not commit or canonical Brain snapshot.

Fresh build exited0; npm test188/188 and verifier188/188 across18files, zero failures/cancellations/skips/TODO. Real compiler/factory/reopen, native descendants/cancel/timeout/lease-loss, cleanup uncertainty/file-lock, source/toolchain drift, during-copy mutation, export tampering, migration and HTTP original-session fences are covered. Intermediate62-test targeted pass is separately labeled; later changes are covered by final188 suite.

Installed Chrome ordinary journey:15 assertions, durable2versions and server exit0. Overall browser status PARTIAL_WITH_BLOCKED_CSP_GATE. Controlled-delay predicate instrumentation remains BLOCKED_CSP. An invalid evaluate retry after denial was stopped and excluded; both records are preserved. No CSP weakening occurred. PS5.1 policy denial remains BLOCKED; explicitly selected private PS7 profile qualified separately. Node22, legacy bundled Chromium, React, hosted/provider/runtime and production remain separate open gates.

Canonical result: .brain/evidence/platform-002-result.json. Independent final review: APPROVED_FOR_LOCAL_SCOPE. No remaining owned test/browser/build processes observed by executing agent. Next: PLATFORM-003 contract refinement and authorized local implementation.
