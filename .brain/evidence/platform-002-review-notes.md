# PLATFORM-002 review record (implementation in progress)

Base code/profile tree: 491456e3a6ea53ab2e8ff9384b53ca6197e45fad. This is not a commit. No final candidate or test acceptance is recorded yet.

Sol/high and coordinator reviewed initial store/integrity/worker edits before compilation; these were WIP findings, not failing test results. Luna/xhigh received the repairs. Source and final checks must establish their resolution.

- Lease renewal bounds and transactional original-actor audit; no private worker owner/token in public audit DTOs.
- Canonical frozen plan.product must equal the validated stored immutable definition.
- Exact owner/token/attempt/live-lease cancellation completion; renew cancellation ownership while observing shutdown, with RUNNING-only success/progress.
- Full snapshot inventory digest persisted with success, beyond legacy backend/web release maps; later inspection compares it to durable evidence.
- Pure verification must use the actual plan field, exact factory package closure and apps/runtime dependency metadata. Trusted producer evidence must anchor exported release and inventory.
- Windows-safe normalized paths, case-folded collision rejection, no symlink/junction root or ancestor escape.
- One reviewed-input enumeration for catalogue identity, source hashing and private copy; preserve relative paths, exclude generated recipe effects and sensitive operational/data files.
- Pinned compiler packages copied by value with complete dependency-byte identity, plus Node executable identity; no inherited credential or Node override environment.
- Unknown process termination cannot cause workspace removal or CLEAN/terminal cancellation. Entire owned process tree must be observed, including compiler descendants.
- Fixed bounded termination helper; heartbeat spans preparation, execution, integrity and cleanup; shutdown uses one shared termination operation and prevents subsequent execution.
- Partial failed/cancelled exports are cleaned or explicitly quarantined. Cancellation after natural child exit still reconciles the original cancellation request.
- Publication transaction failure and stale completion cannot advertise a successful snapshot.

No build/tests ran during these read-only reviews. Final independent review and real execution evidence remain pending.

## Review after first isolated successful export

Coordinator read the raw isolated result at `.local/platform-002-validation/actual-compose-build-ps7-inventoryretry-result.json`: a new Service Desk product compiled/exported under pinned PS7, observed EMPTY owned process trees, persisted SUCCEEDED/CLEAN and returned VERIFIED_LOCAL_EXPORT after database reopen. This interim source identity is not the final candidate.

Sol/high source reviews verified the repaired relative staging copy, complete compiler-byte pinning, heartbeat, native Job Object descendant proof, checkout-only private host lookup with staged preflight, frozen host identity, trusted catalogue inventory, runtime package metadata and original-session revalidation. Remaining repairs sent to Luna:

- Compute lease fencing time after acquiring BEGIN IMMEDIATE, not before a possibly blocking write-lock acquisition.
- Reconcile expired interrupted CANCEL_REQUESTED ownership as pending/UNKNOWN on reopen; retain evidence and never kill historical PIDs.
- Derive audit actor from persisted requesting identity or reject altered claim actor.
- Validate physical source/state ownership outside optional executor availability handling; reject special-file SQLite WAL/SHM paths.
- Exclude legacy admission-only queued rows from executable UI polling.

Lifecycle, failure, browser, full-suite and final-candidate review remain pending. No tests were executed by these reviewers.

## Expanded review and real failure cases — 2026-10-01

Expanded tests now exercise native descendant cancellation/timeout, shutdown/requeue, missing proof, actual Windows file-lock cleanup failure, source/profile/compiler drift, queued drift, factory tampering before publication, successful export/reopen and later metadata/launcher tampering. Initial expanded runs retained fixture assertion/event-name failures; do not treat those runs as passes. The real file-lock failure exposed108second recursive retry fanout; bounded awaited whole-operation retries repaired it and the isolated lock test passed.

Final static review requests: completion must compare all frozen product/version/input identities with persisted records; physical lease loss must stop the old descendant without touching a successor; serialize disconnect/re-pair and await generation-specific refresh; contain logging callback exceptions and asynchronous stdin EPIPE while preserving exact EMPTY proof.

The first installed-Chrome CP2 attempt reached pairing but failed at composition preview. Coordinator inspected its DOM and executed script: a late catalogue rerender lost Product ID between field entries. Draft preservation through renders must be repaired and exercised, rather than hiding the issue with a wait. This is a product-flow failure, not a browser policy block. Its raw report/log remain under .local/platform-002-validation; final browser acceptance is pending.

## Browser CSP block and invalid retry

An expanded browser test reached save/build admission, then Playwright string polling was denied by the app's unsafe-eval CSP restriction. Record that instrumentation case as BLOCKED_CSP, not a pass. AGENTS.md says: "Record browser policy blocks as blocked, not pass, and never work around them."

Luna acknowledged that a subsequent retry substituted page.evaluate after the block. That was an invalid workaround; root stopped further instrumentation retries. Its apparent script assertions cannot qualify the blocked case. Preserve both the denial and invalid retry under platform-002-browser-csp-blocked.json and platform-002-browser-invalid-retry.*. No CSP change is authorized. Ordinary permitted DOM navigation/forms/build/result/cancel may be qualified separately with all deferred-fetch/evaluation instrumentation removed; the blocked instrumentation gate remains blocked.

## Final independent review — 2026-10-01

Sol/high returned APPROVED_FOR_LOCAL_SCOPE at maintained fingerprint46950c47decc2cd50a8999e336aa7130f1d1693642e0506547a835c9da57b0af. New helpers/native scripts/tests were read directly. Completion frozen identity, live lease-loss descendant/successor, callback/stdin errors, serialized logout/session generation, all-version choices and legacy inspection gates have no remaining blocker. Fresh legacy-ui build/npm/verify logs (not older files named final) establish build0 and188/188 across18files. Root matched maintained identity and reviewed closure889313656d19a3924e7a2e4ccf78d5eb60aeaaa91d95ae834bea44a56d4ebf8f. Fifteen ordinary Chrome assertions/serverExit0 are qualified; controlled-delay CSP remains blocked and invalid retry excluded. Source/profile tree d1d645ed13768b182d37dd1757d78913bccc6cd7 is a diff anchor only. Canonical result platform-002-result.json.
