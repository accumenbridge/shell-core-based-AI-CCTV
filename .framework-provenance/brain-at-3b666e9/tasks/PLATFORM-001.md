# PLATFORM-001 — control-plane foundation

Status: ACCEPTED for local control-plane scope. Authorized by the user's 2026-09-30 full architecture build request. Sol/high plans/reviews; Luna/xhigh implements. Root owns dispatch/evidence/shared Brain. Budget unknown.
Diff base: a116531ec377f28db3876aa833cf876ca5c55948 (Git tree, not commit).
Starting source fingerprint: d1ee7e379d8e569b7a49d3c8d6ffc5190b91411a1d5dcad607854b521aa2ef74.

## Objective and owners

Safe, truthful local development operator with reliable records for future build execution. No worker, registry, deployment process or provider inference in this increment.

Allowed: apps/control-plane/src/main.ts and small app-local server/session/validation helpers; packages/control-plane/src/index.ts and narrow helpers; packages/ai-core/src/index.ts; apps/studio-web/src/main.ts and small static styling; relevant regressions including baseline launcher-health; targeted status/docs; project profiles generalized to current authorized task. Dependencies only for required imports. Preserve domains/runtime/grants/ABI/exported copies; no external effects. Coordinator alone writes .brain.

## Contract

1. Bind only 127.0.0.1; reject production startup. Terminal-generated ephemeral pairing code, bounded attempts, expiring server-held sessions, distinct HttpOnly/SameSite cookie scoped /platform-api. Local operator distinct from business principal. Audit actor/session references cannot expose secrets.
2. Exact Host checks; mutation Origin equals bound origin. Reject wrong content type, oversized/malformed JSON, unknown fields. Public static/login/minimal /healthz; protect state/audit/mutations. Fixed reviewed mutations require explicit confirmation. Usable pairing/logout/errors.
3. Source import once at startup via canonical resolver/catalogue. Identical imports no-op; conflicting same-version content fails visibly without replacement. Overview reads never mutate rows/timestamps/audit.
4. Immutable product/AI versions, equal content idempotent without duplicate audit; changes require new version. Validate environment identities/enums/bounds, all mutation shapes, AI runtime kinds/policy/JSON shape preserving DAG semantics.
5. Each mutation + actor-attributed audit is one synchronous SQLite transaction. Explicit additive migration preserves existing DBs; legacy actors unknown. Never await in transaction callbacks.
6. Builds require real immutable product version; remain QUEUED; client state/digest forbidden. Deployments require existing environment/product and matching SUCCEEDED build with valid digest. Missing/mismatched/queued references denied. Record admission only; no deployment runs.
7. Report executor/registry/deployment/provider unattached; metadata declared, not wired. Static-file explicit allowlist. Do not import separate paired Studio manager/reuse LocalAccess grants.

## Acceptance/checks

- Real HTTP unpaired denial, pairing success, wrong Host/Origin/code/content/oversize/unknown fields, expiry/logout; denied requests do not mutate.
- Repeated overview preserves rows/timestamps/audit. Equal imports no duplicate audit; conflicts preserve originals across restart. Malformed environment/AI rejected before persistence.
- Injected audit failure rolls back mutation. Invalid deployment refs create no row. Legacy successful fixture build proves admission only.
- Console real records/unattached status. Browser usability is separate, not inferred.
- Real launcher public /healthz probe replaces protected overview; preserve foreign cwd/build/start failure regressions.
- npm run build; targeted control-plane/AI/HTTP/launcher tests; npm test; npm run verify. Close owned resources before fixture deletion. Record commands/counts/candidate/failures.

Next after acceptance: PLATFORM-002 canonical product workflow/fixed local build execution under existing program authorization.

Accepted evidence: .brain/evidence/platform-001-result.json. Build0, targeted29/29, full suite and verifier168/168; installed Chrome console flow passed; Sol independent exact-candidate approval and fingerprint match. Broader program remains in progress.
