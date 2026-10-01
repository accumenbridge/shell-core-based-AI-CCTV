# Product-neutral construction architecture — Foundation 0.2

## 1. Decision and source precedence

Build a reusable construction framework with maintained application hosts, optional capability implementations, domain-owned modules, explicit instance bindings and controlled cross-product integration. The platform itself is the first engineering deliverable. The two small domain applications are acceptance consumers—not a requirement to finish Veyviz before the platform.

The supplied **Veyviz Platform Architecture Authority v1.6** describes a CCTV/AI product-family target, not this implemented neutral framework. Its small neutral foundation, public ownership boundaries, static reviewed contributions and separation of logical modules from deployed processes are retained as design inputs. The user's later platform-first direction governs this independent repository. This document does not revise Veyviz's authority, move its records, or replace its CapabilityPack catalogue.

`reference/Veyviz_Authority_v1.6.md` is preserved as source context only. Its Veyviz-specific job, source, topology, grant and release bindings are not copied into this platform's neutral contracts. In particular, earlier Forensics persistence language is not used to reclassify any current Veyviz records.

## 2. Governing structure

| Layer | Implementation here | Responsibility |
|---|---|---|
| Public neutral contracts | `packages/contracts` | Scope, actor, module ABI, route/workspace declarations and operation failure vocabulary |
| Composition | `packages/composition` | Deterministic exact-version selection, dependency/collision checks, explicit provider/instance binding and removal assessment |
| Backend host | `packages/backend-host` | Registered operations, lifecycle, authority integration and a thin Node HTTP adapter |
| Web shell | `packages/web-shell` | Session/tenant UI boundary, navigation, declared workspace loading, request scopes and cleanup |
| Worker host | `packages/worker-host` | Claim, lease renewal, handler execution, fenced commit and failure handling |
| Local profile adapters | `packages/sqlite`, `packages/local-access` | Real local persistence and a loopback-only authentication/authorization implementation |
| Cross-product transport | `packages/connections` | A bound command over local/HTTP transport, fixed destination, explicit tenant mapping and unchanged command identity |
| Business modules | `modules/*` | Domain records, rules, migrations, APIs, handlers and UI |
| Product definitions | `products/*/product.json` | Which modules and bindings form a product |
| Solution wiring | `solutions/knowledge-to-desk` | Explicit translation and service identity for one cross-domain operation |
| Composition executable | `apps/runtime` | Loads a selected built plan and wires its actual application instances |
| Factory tools | `tools` | Generate owned examples, build exact registrations and export selected assemblies |

A package is not automatically a service. The backend and Web-serving adapter share one process in this profile. The worker is another process only for products that select background work. Domains use separate owner databases on the same local filesystem; separate schemas do not imply a database server per module.

## 3. Three independent graphs

**Source dependencies:** neutral packages do not import reference-domain packages. Domain code consumes public framework interfaces. Solution-owned adapters consume the participating public capabilities. Products supply configuration; no `if customer` or camera context enters the core.

**Runtime collaboration:** a source domain can call a destination public operation locally or remotely. Requests/results can flow in both directions without introducing import cycles or shared writable business data.

**UI containment:** navigation hosts a domain workspace. A DOM/React parent does not become the owner of the displayed record. Closing that workspace cancels view reads but does not cancel an accepted durable job.

## 4. Mandatory mechanism versus selected adapter

Module composition and public boundaries are neutral mechanisms. An authenticated-app profile selects identity/access and persistence implementations. The supplied local profile uses one working implementation instead of many empty adapter classes.

No product is forced to select jobs, knowledge, Service Desk, AI, video, sensors, notifications or reporting. A headless worker uses the corresponding host contract and does not require browser assets to start. The neutral application has no domain workspaces and no worker process.

The Node HTTP adapter delegates protocol handling to Node's standard HTTP server. SQLite is an explicit local adapter, not a universal domain repository. Browser DOM APIs render the first reference modules; React is an optional renderer integration seam. Hosted Nest/React/PostgreSQL/OIDC adapters are future supported-profile work, not silently implemented by naming them.

## 5. Contract and provider ownership

A business module owns the meaning of its exported operation. A consumer can request a narrower port. A solution adapter makes the mapping explicit. The framework validates registration and lifecycle but never invents an operation's domain semantics.

The reference public capability family is:

- `knowledge.document.read.v1`: returns a permitted original document record from Knowledge.
- `desk.requests.create.v1`: retained original owned create operation for existing consumers.
- `desk.requests.create.v2`: opt-in cross-product operation returning a validated committed-resource receipt; original-receipt lookup is separately authorized.

Handoff selects the explicit v2 destination contract and depends on these meanings, not their repositories. Its adapter reconstructs a **destination-owned** context and enforces that provider's current module mode and grants. A source permission is not destination permission. A returned resource reference is not an access credential.

Contracts and module package versions are separate identities. The initial resolver deliberately supports exact versions and one module ABI; it does not claim arbitrary SemVer-range or binary compatibility.

## 6. Composition and instance scope

1. Product selection identifies exact module versions and required bindings.
2. Build creates `.artifacts/<product>/plan.json`, static frontend registration, selected backend registration and executable fingerprints.
3. Application startup verifies its selected executable files and plan, loads reviewed local factories, applies compatible owner migrations, and starts modules in dependency order.
4. Scope activation combines selected code with a real principal, tenant grants and module mode.
5. Each request/workspace/job has its own lifetime and records.

A binding distinguishes **contract, implementation, instance ID, consumer, lifetime and local/HTTP placement**. The scoped-binding utility demonstrates application-, module- and request-cache isolation. The supplied reference solution deliberately accepts only application-scoped, stateless ports; it rejects unsupported shorter-lived adapter declarations rather than pretending they are wired. Request-scoped resource-bearing adapters must integrate actual disposal with the host that owns them.

Eager local bindings add provider-before-consumer construction dependencies. Binding-only cycles fail resolution; remote providers do not become hidden local modules.

Commercial plans are not implemented here. Product manifests select software; `LocalAccess` independently supplies developer-scope grants. Veyviz's actual commercial catalogue remains untouched.

## 7. Ownership, persistence and writes

Each module receives its own data path and creates a concrete owner repository. The foundation does not own a universal Person/Asset/Document/Incident table.

`SqliteOwner.command()` checks authority, starts an owner-local transaction, reconciles the original command key and digest, runs the domain change, and commits the result receipt/audit. The same identity and normalized input return the original result; changed input conflicts. Permission is checked again before returning an old receipt.

Knowledge inserts its document and indexing job in the same owner transaction. Handoff inserts its relationship and delivery intent in its own transaction. Service Desk independently commits the destination request. No transaction spans these databases or a remote server.

This profile is deliberately bounded: short synchronous SQLite transactions, limited row sets, one local filesystem, no horizontally distributed database protocol. A production adapter must preserve the same selected invariants, not merely offer generic CRUD.

## 8. Background execution and external uncertainty

A job has a stable identity, actor/tenant/permission binding, deadline, attempt, lease token and due time. A worker claims it atomically, rechecks current permission and module mode, prepares work outside the transaction, and commits only while its lease still owns completion.

The worker consumes the neutral `JobExecutionStore` port from `packages/contracts`, not a concrete database queue. Store calls may be asynchronous; `finish()` is awaited. The selected adapter owns the atomic completion relationship. An independent ephemeral conformance adapter exercises the same host with SQLite absent; this does not qualify another production store.

The completion callback and final job status share the owner transaction in the SQLite adapter. A stale attempt cannot update domain state. Computation may happen more than once; the code does not promise exactly-once execution.

A cross-product timeout means destination acceptance is unknown. Retry uses the **same** remote command key. The receiving owner deduplicates inside its business transaction. Handoff separately owns a durable delivery-fact row, its technical job, and its business relationship. A validated receipt is retained before local business completion is attempted. Revocation, cancellation, lease loss or exhaustion may prevent business completion but cannot turn known external acceptance into nonacceptance.

A narrow fact-only recorder can retain the outcome of an already dispatched operation without granting new dispatch or business-write authority. Explicit `handoff.reconcile` performs a destination receipt lookup (never a resend), then the source owner validates current authority before adopting its relationship outcome. A failed/not-found lookup leaves acceptance uncertainty intact. No generic model agent or automatic new-identity retry is used.

Queued cancellation is immediately cancelled. Running cancellation is a request; the active attempt must settle or expire before its cancelled outcome is recorded. Lease expiry fences commits; it does not prove physical compute or an external action has stopped. The supplied handlers do not run native GPU tasks.

## 9. Cross-product modes

**Composed mode:** Combined selects the Service Desk, Knowledge and Handoff modules in one application. Each still owns its persistence. A local adapter invokes the real Service Desk operation under the configured service principal.

**Connected mode:** Knowledge runs separately and calls Service Desk's fixed HTTPS-capable command adapter. The local proof uses loopback HTTP. Its `org-a → customer-a` mapping is explicit; tenant IDs are not assumed equal. The reference service credential has `desk.create` and `desk.receipts.read`, not document-read or ordinary Service Desk list authority. Original-receipt reads are limited to that actor and tenant. A receipt-only grant can be used without create authority.

The destination preflight resolves actual authenticated product/instance/tenant/service-actor identity. Mutation also checks the expected destination headers before executing a command. The returned `quadbridge.command-receipt.v1` must match the explicit contract, original key, destination, actor and committed resource type/version. HTTP 202 or a bare ID never proves business commit. This is a declared opt-in receipt protocol, not a global semantic wrapper inferred from any successful HTTP response.

Only the fixed command and receipt paths and origin from trusted instance configuration are usable. Request data cannot choose a URL, credential or destination tenant. Redirects are refused. The source cannot impersonate its user at the target merely by forwarding an identifier.

## 10. Frontend and renderer contract

The shell owns authentication UX, product metadata, selected tenant, stable workspace paths, coarse failures and lifecycle. The domain workspace owns its content surface only.

A workspace receives `root`, immutable scope/permission views, `AbortSignal`, limited own-module API operations and a notification callback. It receives no session token, repository, framework-private store or mandatory site/floor/document fields. Dynamic imports come from build-generated static maps, never request data.

The same shell uses sidebar or top navigation according to the product definition. Domain views may use native DOM or a supplied React root adapter; the framework does not impose the reference form design on all products.

Requested tenant selection and accepted bootstrap are different states. Scope changes abort old work, clear old nodes and remove obsolete bootstrap immediately. Navigation cannot mount old metadata while a replacement is pending. Each workspace API captures the same immutable accepted scope as its displayed context, checks its generation before dispatch and after return, and cannot act on a different selected tenant. Background jobs remain owned by the server. Access refresh and workspace generation are fenced separately. Unchanged metadata preserves a valid current view, but successful recovery remounts one cleared by a failed refresh. The loader uses the exact declared own workspace export and validates its mount shape. Browser tests covering these behaviors are authored but environmental browser navigation was blocked in this session; no browser qualification is inferred from type checking.

### Selected frontend build profile

The product build creates the complete selected native-ESM dependency closure: static imports/exports, literal dynamic imports, literal URL assets and module `browserAssets`. Nested helpers and assets are served through the generated allowlist and included in release hashes; web metadata is itself hashed. Backend entrypoints and unselected domain assets remain unserved.

Unknown/server-only packages, escaping paths, symlinks and nonliteral dynamic imports are rejected. CSS/assets are declared separately rather than imported as native JavaScript. This is a deliberately narrow build adapter, not a general bundler or a qualified React profile. A real third-party renderer/bundler integration remains separate work.

### Local scheduling policy

Module queues use round-robin selection. The SQLite adapter rotates due tenant partitions and advances bounded per-tenant keyset scans, preserving cursors across restarts. Paused work cannot permanently pin the first candidate window. Technical stop reason is separate from the last execution error. A non-reentrant worker prevents overlapping ticks from claiming extra work.

Fair claiming does not preempt a long handler or guarantee a fixed wall-clock response time. The single local worker still requires short/cooperative preparation or a separate qualified compute adapter for heavy work.

## 11. Disablement, migration and upgrades

`enabled` permits authorized reads and writes. `read-only` retains permitted history but denies new commands and pauses new job claims. `off` denies the module's operations and removes its workspace. The code does not confuse those modes with package installation or data purge.

Migration history is hashed and ordered. Editing an applied migration or opening a newer unsupported generation is rejected. Reader/writer changes require owner-specific evolution. Removal assessment reports dependents, retained records and pending jobs; destructive uninstall, data purge, global rollback and historical-reader migration are **not implemented**.

Handoff migration 1 remains byte-identical; migration 2 preserves old protocol rows and adds delivery facts. Existing pending v1 commands are not automatically retried through v2, whose receipt namespace is different. They require original-protocol reconciliation. New permissions and bindings are explicit; existing seeded principals are not silently regranted.

Package versions and per-product build records support explicit adoption. Two actual 0.1/0.2 local neutral runtimes were exercised independently, with the older executable and reported version unchanged. This is narrower than published package adoption or shared-data rolling migration. This release does not claim a tested rolling upgrade between two independently published framework versions. Exported products contain fixed package versions; they are artifacts of the maintained source, not a recommendation to edit forked shell copies.

## 12. Verification and admission to broader use

Actual checks cover exact composition and provider ordering, owner transactions, migrations, role/tenant negatives, job restart and fencing, queue fairness, an independent worker process, local and HTTP cross-product commands, typed receipts and failure-state preservation, receipt-only reconciliation, multi-file asset closure, neutral export, a generated module without host edits, and a worker-store replacement with SQLite absent. Shell transitions run against actual compiled code using controlled document/event/request ports, not a real browser.

The next engineering work is to complete real browser/React acceptance, production identity/storage/runtime adapters, package publication/version adoption, resource limits for real workloads, operational lifecycle and a selected consumer adapter for existing Veyviz. Do not replace Veyviz's owners, grant model access, or declare production readiness from this developer-profile proof.

## 13. Remediation records

The R01–R10 implementation map, regression identities and limits are in `docs/REMEDIATION.md`. Source compatibility, legacy pending commands and new explicit permissions are described in `docs/UPGRADE_FROM_0_1.md`. These updates refine the same framework rather than introduce new business owners.


## Studio integration 1: optional development operator

`tools/studio.mjs` is an opt-in loopback development operator outside the Product application hosts. It uses current source catalogues, the same pure resolver, finite confirmed build/export/launch operations and immutable local runtime snapshots. The offline explorer has no such authority. Profiles/local-developer.json contains explicit fixture seeds, not commercial or module grant authority. See docs/STUDIO_INTEGRATION.md for exact limits. No camera or other domain concept was added to the neutral core.

The paired control plane separately owns immutable local artifact registration and a managed-runtime
slot. A runtime starts only from an exact promoted snapshot copied into private execution storage. The
canonical local profile prepares one-time access data; the fixed Windows supervisor starts web/backend
and, when the resolved plan requires it, a distinct worker process. Both role configurations use empty
principal seeds. Restart reuses bound data, including later principal or grant revocations. The native
owner must prove its process tree empty, close its helper and verify execution cleanup before `STOPPED`
or slot release. Uncertain ownership retains its slot and material; the operator does not infer exit or
recover a process by saved PID. This remains a local developer control plane, not deployment or
production runtime infrastructure.

For a positively stopped instance, the paired console also supports private same-instance backup and
restore. A backup is verified against the runtime's immutable artifact/configuration binding, enrollment
identity, owner databases and migration history. Restore is admitted only to the exact instance's wholly
absent data root; it preserves existing principal and grant state without reseeding. The user restarts
the restored runtime explicitly. This local recovery path does not provide remote retention, cross-artifact
migration or production disaster recovery.

## Bounded Knowledge answers

Knowledge owns tenant filtering, indexed-record selection, excerpt ranges, body digests and citation validation. Its answer route retrieves only `READY` indexed rows, then supplies at most five frozen excerpts totaling 16 KiB to a neutral ai-core provider interface. The current provider deterministically selects source excerpts; Knowledge rereads and verifies each source after the await and constructs the cited output. The user sees **Local extractive answer** and indexed-only coverage, never a model-inference claim. Handoff continues to consume only `knowledge.document.read.v1`.

The local limits are 1000 question characters, five evidence records, 16 KiB excerpts, 8 KiB answer text, a five-second provider deadline and four actual in-flight calls. Per-call cancellation is joined with the workspace lifetime; deadline/cancel suppresses late results while a provider that has not settled continues to occupy its slot. The same original request session and module read permission are checked around the asynchronous provider boundary. This does not add a general retrieval framework, answer store, model adapter or new Knowledge schema.

Build, factory assembly and immutable release verification share a pure closure computed from fixed host packages plus the selected module package manifests. The exact dependency versions are recorded in the exported runtime package metadata. `web-shell` remains part of the frontend copy closure while retaining its existing browser-only release-digest treatment. Captured snapshots verify their own package manifests rather than consulting a later maintained checkout.
