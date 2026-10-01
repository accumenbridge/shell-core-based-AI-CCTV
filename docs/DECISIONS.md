# Selected decisions

**D01 — Platform first.** The reusable construction software is the deliverable. Reference applications test it; they do not redirect the programme toward completing a CCTV product first.

**D02 — One small neutral contract package.** Domain entities stay outside it. Actor, tenant/product/instance and lifetime are neutral; document/camera/source fields are domain-owned.

**D03 — Maintained hosts, not copied templates.** Frontend/backend/worker code lives in packages. Factory-generated module/product code is owned by that module/product. Export copies are versioned artifacts, not new source authorities.

**D04 — Concrete local profile.** Use standard Node HTTP and SQLite with a native-DOM reference renderer, avoiding external runtime dependencies in this first proof. Keep adapter boundaries explicit. This is not a decision to replace existing Nest/React or to deploy synchronous SQLite as universal SaaS persistence.

**D05 — Static reviewed composition.** Exact module versions and an explicit ABI are supported. Runtime data cannot create an import path. No untrusted plugin marketplace or arbitrary code loader.

**D06 — Instance is not implementation.** Bind consumer/contract/implementation/instance/lifetime separately. A scoped utility tests cache isolation. Reference solution ports are application-scoped and stateless; unsupported scoped resource semantics are rejected rather than inferred.

**D07 — Domain-owned transactions.** Use an owner-specific SQL repository and transaction helper, not a universal business repository. Cross-owner calls are separate commits.

**D08 — Technical jobs are not business completion.** Prepare outside a transaction, then fence a short owner commit. Native resource admission is not invented by this worker prototype.

**D09 — Explicit cross-product trust.** Use a fixed operation/origin, explicit tenant map and dedicated destination service principal. Common login does not grant destination access.

**D10 — Minimal supported profiles.** Four reference compositions exercise absence, ordinary business, background work, and combined domains. Do not promise all theoretical combinations or automatic model/provider selection.

**D11 — One version of source facts.** Generated per-product plans/catalogues/artifact records derive from reviewed manifests and build output. They do not become a second grant database. The existing Veyviz catalogue is not replaced.

**D12 — Honest acceptance.** Node/SQL/HTTP/process/generation results are recorded separately from blocked browser tests, unexecuted React integration and unimplemented production adapters. None promotes inherited Veyviz acceptance criteria.


## Stabilization decisions — 0.2

**D13 — Scope is accepted, not merely selected.** Each view and client shares one immutable accepted bootstrap generation. Pending selection cannot mount obsolete metadata. Cleared state requires remount even when the next valid metadata is equal.

**D14 — Explicit receipt protocol.** Preserve the v1 human create operation, add v2 for verified cross-product commit receipts, and use separately authorized original-receipt lookup. HTTP status/id shape alone cannot establish domain completion.

**D15 — Three separate outcome dimensions.** Delivery facts, technical attempts and source-domain outcome persist separately. A narrow recorder retains returned facts after local authority/lease changes; only an authorized owner operation adopts business state.

**D16 — Native ESM dependency closure.** Follow literal imports and declared public assets for selected modules. Fail unsupported packages/dynamic paths; never serve the entire repository to fix a missing helper. A real React/bundler adapter remains a separate implementation.

**D17 — Explicit bounded scheduling.** Rotate modules and tenant partitions and advance eligibility cursors. This is fair claim selection, not preemption or guaranteed latency.

**D18 — Neutral execution-store port.** Generic worker depends on the operations it needs, not SQLite's class identity. Atomic result/job completion remains an adapter responsibility. A second ephemeral implementation tests the seam without inventing production-database support.

**D19 — Bindings affect construction.** Eager local provider relationships contribute startup order and cycle checks; remote bindings do not require an accidental local provider.

**D20 — Preserve old external identities.** A possibly dispatched v1 operation cannot be transparently retried in the v2 namespace. Keep old records and require explicit original-protocol reconciliation.
