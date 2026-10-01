# BASELINE-001 — bounded launcher and verifier reliability

Status: ACCEPTED. Checkpoint BASELINE-001-ACCEPTED; adoption checkpoint is complete.
Diff base: Git index tree `1f8e0726d07f3a43e18affe231d59f64070aad6d` (not a commit).
Implementation: Luna/xhigh. Architecture and exact-diff review: Sol/high.
Authorization: user's 2026-09-30 “ok proceed,” limited to this local reliability
baseline. Budget is unknown; do not invent a token, attempt, or spend limit.

## Scope

Only these owners and behaviors are in scope:

1. `START_FULL_STUDIO.cmd`: correct working directory, call chain, and propagation of
   build/start failure. Exercise success, build failure, and start failure from a
   foreign current directory. Use `npm.cmd`/`node.cmd` executable stubs under a
   controlled PATH for deterministic failure cases, plus a bounded real startup and
   health probe for success.
2. Factory lifecycle and Studio integration dependency junctions, including cleanup
   on early failure/success paths. Preserve ownership and remove only junctions
   created by the operation.
3. Normalized portable source copy. Exclude root `analysis/`, `.git/`, `.brain/`,
   `.codex/`, and generated state. Keep maintained source and `profiles/` trackable.
   A source fingerprint must ignore operational JSON edits and change for maintained
   source edits.
4. `tools/verify.mjs`: explicit TAP reporting; require at least one discovered test
   file and a known test count greater than zero. Fail closed for unknown, zero,
   malformed, or ambiguous discovery/results/counts, nonzero test exit,
   failures/cancellations, spawn errors, and signals. Report build failure as NOT_RUN
   for tests, not as zero tests passed. Make current proof claims conditional on valid
   current evidence. Reconcile pass/fail/build failure/malformed/discovery-negative
   reports and account for TODO/skipped counts.
5. Add only narrow shared fixture/report helpers and meaningful regression cases
   needed for the behaviors above.

Coordinator scope clarification after the first full run: `tests/helpers.mjs` is
also an allowed existing fixture owner for bounded Windows cleanup retries and
resource ordering. The full run reached 153 tests with 152 passes and one ENOTEMPTY
removal failure in the real separate-worker fixture. Preserve that recorded failure;
do not suppress shutdown/removal errors or change runtime behavior.

## Acceptance and check sequence

- Use the bound recipes in `.brain/checks.json`: `npm.cmd ci --ignore-scripts`, build,
  targeted `factory-lifecycle`/`studio-integration` regressions, `npm.cmd test`, and
  `npm.cmd run verify`. Record exact Node/npm versions, outputs, exit codes, and
  candidate identity.
- The real startup probe must be bounded and must reach the actual Studio health
  response; bind its exact health request after locating the source-defined endpoint.
  Stubs establish controlled launcher error propagation only.
- Tests must prove foreign-cwd execution, success, build failure, start failure,
  early cleanup, exclusion/fingerprint behavior, explicit TAP, at least one discovered
  file and test, unknown, zero, malformed, and ambiguous discovery failures, nonzero
  test exits, failures/cancellations, spawn errors/signals, count consistency, and
  conditional proof claims. A build failure leaves test status NOT_RUN rather than
  reporting zero passes.
- Register any newly created regression test path in the targeted catalog recipe
  after implementation; the existing factory/Studio test files do not establish
  launcher or verifier coverage by themselves.
- Browser acceptance is an independent gate. Chromium is currently missing; do not
  download it or claim browser/navigation-policy results in this task.
- Preserve all ABI, domain, access, runtime, and deployment semantics. No dependency
  or version changes, global settings, credentials, external systems, or roadmap work.

## Checkpoint fields

Record changed files, current source fingerprint and staged-tree base, exact commands,
environment, exit/result counts, test TODO/skipped accounting, real health response,
fixture versus live evidence, cleanup, failures/repairs, remaining browser blocker,
and next action. Keep shared `PROGRESS.md` and task status under the root coordinator.

## Accepted result

Sol independently reviewed the final diff and evidence and found no blocking defect.
Coordinator and Sol recomputed the current source fingerprint and matched
`d1ee7e379d8e569b7a49d3c8d6ffc5190b91411a1d5dcad607854b521aa2ef74`.
Build passed; targeted tests passed 34/34; full suite and verifier each passed 153/153
with zero failures, cancellations, skips or TODOs. The actual isolated launcher
reached HTTP 200 at `/platform-api/overview` (version 0.3.0) and `/`.
Actual Node nested, skipped and failing-TODO fixtures cover reporting corrections;
negative fixtures cover missing/malformed/contradictory evidence and failed execution.

Changes: launcher; verifier plus verify-core helper; factory/Studio integration
fixtures; existing shared fixture helper; source-copy helper; reliability regressions.
No ABI, domain, production, security or dependency changes were made. Browser and
Node 22 qualification remain separate open gates. No commit, remote or deployment.
See `.brain/evidence/baseline-result.json` for commands, candidate, logs and history.
This task is complete; select any future implementation through a new authorized
contract rather than reopening this task or executing the proposed roadmap.
