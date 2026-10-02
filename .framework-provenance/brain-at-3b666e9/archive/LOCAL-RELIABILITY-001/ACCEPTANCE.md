# Acceptance meaning

Status: BOUND to the approved local setup and bounded reliability baseline.
Outcome revision: `LOCAL-RELIABILITY-001`.
Result: ACCEPTED at checkpoint BASELINE-001-ACCEPTED on 2026-09-30.

| Criterion | Observable result | Proof and current status |
|---|---|---|
| ADO-1 Source provenance | Fresh import strips the single `Quadbridge_Product_Studio/` prefix, rejects unsafe/colliding paths, and records the original ZIP SHA-256 plus every imported file hash. | `.brain/evidence/adoption-source.json`; 318 imported files verified during ADOPTION-001. |
| ADO-2 Project entry point | Original `AGENTS.md` guidance is preserved and points to the mapped Brain; project records and local role profiles bind without changing global Codex configuration. | ADOPTION-001 file review and TOML/JSON parsing; completed. |
| BASE-1 Windows launcher | From a foreign current directory, the full Studio launcher calls the intended command in the correct directory and propagates build and start failures; success reaches a bounded live health probe. | PASSED: actual CMD stubs and isolated real launcher/API/page responses in targeted evidence. |
| BASE-2 Lifecycle cleanup | Factory and Studio integration junctions are recognized and owned cleanup runs on early success/failure paths without changing their domain or runtime semantics. | PASSED: early cleanup, junctions, owned shutdown ordering and propagated failures; original lifecycle assertions retained. |
| BASE-3 Portable source copy | Normalized copy excludes root `analysis/`, `.git/`, `.brain/`, `.codex/`, and generated state while preserving maintained source and trackable `profiles/`. | PASSED: copy and fingerprint fixtures; operational JSON edits leave the fingerprint unchanged, source edits change it. |
| BASE-4 Verification report | `tools/verify.mjs` emits explicit TAP, requires at least one discovered test file and a known test count greater than zero, and fails closed on unknown/zero/malformed/ambiguous discovery/results/counts, nonzero test exit, failures/cancellations, spawn errors, and signals. Build failure leaves tests NOT_RUN, not “0 passed”; current proof claims are conditional on valid current evidence. | PASSED: real Node nested/TODO output and negative fixtures; verifier reports 153/153 and a current matched fingerprint. |
| BASE-5 Project suite | Dependencies install from the lockfile with scripts disabled, source rebuilds, targeted tests pass, then `npm test` passes. | PASSED: install/build exit 0, targeted 34/34, full 153/153 with zero failures/cancellations/skips/TODO. |

Exact commands, candidate and logs: `.brain/evidence/baseline-result.json`.
Sol independently reviewed the final diff; coordinator and Sol matched its fingerprint.

Browser acceptance is a separate real-state gate. The required Chromium executable is
missing, so browser checks are BLOCKED and no browser assertions or current navigation
policy claim exist. The platform roadmap and production readiness are not accepted by
this slice. Passing a setup or template check does not imply a baseline or release pass.
