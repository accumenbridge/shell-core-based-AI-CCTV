# Foundation 0.2 — review remediation R01–R10

**Scope:** correct the delivered product-neutral Foundation 0.1 source. No Veyviz code, repository branch, customer permission, camera, model or deployment is changed. Original archive is preserved. This is source implementation and local verification, not production qualification.

## Correction map

| Finding | Implemented change | Main code | Executable regression |
|---|---|---|---|
| R01: mixed tenant context | Separate requested/accepted scope; clear obsolete bootstrap; bind view API and late results to its immutable accepted generation. Logout clears old controls immediately. | `packages/web-shell/src/index.ts` | `tests/shell-regressions.test.mjs`: delayed tenant replacement, navigation, reads/writes, late failures and notices |
| R02: external commit lost behind job failure | Owner-local delivery facts with original binding/command, NOT_SENT/UNKNOWN/COMMITTED and retained receipt. Fact-only recording precedes fenced business completion; explicit read-only lookup reconciliation. | `modules/handoff/src/index.ts`, SQLite queue state | `tests/hardening.test.mjs`: revoke/cancel/lease loss/deadline/restart; lookup does not resend; legacy v1 replay blocked |
| R03: assumed instance | Preflight authenticates actual destination scope; mutation rechecks expected product/instance/service actor; received receipt must match destination, tenant and original command. | `packages/connections`, backend HTTP, solution wiring | Wrong product/instance/principal/tenant and post-preflight mutation checks |
| R04: 202 treated as commit | Opt-in committed receipt contract; exact supported status, contract, actor, scope, resource and command validation. A queued ID is not a business resource. | Service Desk v2 and connection receipt validator | Incompatible 202/malformed/incorrect receipt cases, normal local/HTTP v2 cases |
| R05: incomplete browser files | Build-selected literal ESM dependency closure, lazy helpers, URL assets and declared CSS/assets; safe boundaries; executable hash coverage includes web metadata and nested files. | `tools/frontend-closure.mjs`, build/runtime | `tests/frontend-assembly.test.mjs`: helper/CSS/asset HTTP, hashes, unsupported import rejection, private/unselected 404s |
| R06: ignored export | Load exactly the selected declared own export and validate mount shape. No silent default substitution. | Web shell; Service Desk overview workspace | Two named routes; missing/wrong export; selected lazy load |
| R07: queue starvation | Rotating module registration; bounded tenant partition rotation; persistent advancing eligibility cursor; non-reentrant worker tick. | Worker host and SQLite queue | Paused first 100; large enabled backlog; restart and competing queues; sync/async paths |
| R08: blank after recovered bootstrap | Cleared view invalidates cached render state. Same valid bootstrap remounts; unchanged polling preserves live scope identity. | Web shell | Transient failure/unchanged recovery and superseded refresh cases |
| R09: provider order | Local eager bindings add provider-before-consumer edges. Provider presence/contract and cycles checked. HTTP provider stays remote. | Composition resolver | Binding-only order and cycle tests |
| R10: SQLite-tied worker | Neutral `JobExecutionStore` and job/attempt contracts; sync/async port operations. Owning store supplies atomic completion. | Contracts and worker host | `tests/adapter-replacement.test.mjs` + independent in-memory adapter; SQLite package absent |

## Cross-product state is three-dimensional

1. **Delivery fact:** original destination/command, dispatch uncertainty, validated receipt.
2. **Technical job:** queued/running/failed/cancelled/expired/succeeded with attempts and stop reason.
3. **Source workflow:** the Handoff owner's adopted business state.

A destination receipt can be retained after local write authority or a worker lease is lost. Its fact-only recorder can update only that existing delivery's receipt; it cannot dispatch another request or mark business completion. The normal worker or explicit `handoff.reconcile` operation must still satisfy current owner authority before adopting the source outcome.

An UNKNOWN record remains UNKNOWN when retries expire. A read-only destination lookup uses the original actor/tenant/command key and requires `desk.receipts.read`. Lookup absence/error does not prove no prior commit. Receipt retrieval grants no ordinary destination record-list or document access.

Connection identity includes implementation/binding revision, actual product/instance, service actor, contract, tenant mapping and destination path/origin. Credential bytes are excluded from the binding identity: rotating a token for the same principal need not retarget an operation. Changing the principal or destination cannot silently replay an unresolved operation under a different receipt namespace.

## Scheduling bounds and their limits

The host rotates among ready module stores. The SQLite adapter rotates tenant partitions and scans at most 16 due tenant partitions and 100 candidate jobs per selected partition per claim. Cursor progress is persisted. These are local implementation defaults, not throughput/SLA guarantees.

Claim fairness does not preempt a long handler. A synchronous blocking handler can still delay a single-process worker; native/CPU-heavy work requires the separate execution profile already described in the architecture. Lease fencing is not proof of external-action reversal or physical compute termination.

## Frontend profile and replacement proof

The supported closure includes static imports/exports, literal `import()`, literal `new URL(..., import.meta.url)`, and `browserAssets` copied from the module's source tree. CSS dependencies are included. Absolute/unselected/server-only imports and nonliteral dynamic imports fail build. This is a bounded native-ESM profile, not a general-purpose replacement for Vite/Webpack or a complete React build adapter.

The second worker-store implementation is **ephemeral test/conformance code**. It proves the host's dependency boundary, rollback behavior and async compatibility without SQLite. It does not establish production persistence, distributed queue semantics or durability after process loss.

## Compatibility

Framework packages and product definitions select 0.2.0. Module ABI naming remains v1, but 0.1 framework package mixing is not promised. Public Service Desk v1 stays available; v2 is explicit for new integrations. Handoff schema migration 1 is unchanged; migration 2 preserves old data and blocks legacy v1 automatic resubmission. Read [UPGRADE_FROM_0_1.md](UPGRADE_FROM_0_1.md).

## Evidence

The complete build and suite: [last_run.json](../evidence/last_run.json).
Current scope: [VALIDATION.md](../evidence/VALIDATION.md).
Baseline check: [baseline_regressions.json](../evidence/baseline_regressions.json).
Actual browser result: [browser_run.json](../evidence/browser_run.json).
Local old/new-version isolation: [version_isolation.json](../evidence/version_isolation.json).

All ten findings have implemented corrections and local regressions. Real browser/React acceptance, published-package adoption, production identity/storage/recovery, native workloads and Veyviz integration remain separate.
