# Current checkpoint

Status: ADOPTION-001 complete; BASELINE-001 accepted. No implementation is active.
Checkpoint: BASELINE-001-ACCEPTED.
Baseline diff base: Git index tree `1f8e0726d07f3a43e18affe231d59f64070aad6d`
(an immutable tree object, not a commit). No baseline application code had changed
when this base was captured. Sol owns planning/review; Luna owns implementation;
the root coordinator owns dispatch, integration and shared records.

## Active work

Canonical task record: `.brain/tasks/BASELINE-001.md` (ACCEPTED, completed).
Authorization: user's 2026-09-30 “ok proceed,” limited to local setup and this bounded
baseline. Budget: unknown; no numeric limit was supplied.

## Adoption result

The original source ZIP SHA-256 is
`7669f93c4e6f40574cbb9bcd5c15f6f351342ebc25f433fd6258f42157136b8f`. Its sole
`Quadbridge_Product_Studio/` prefix was removed on import. All 318 file entries
(2,401,008 bytes) were written beneath this root; all imported bytes matched their
decompressed archive-entry SHA-256. No unsafe path, case-insensitive collision,
preexisting target, or symlink was found. Full per-file provenance is in
`.brain/evidence/adoption-source.json`.

The original root `AGENTS.md` guidance was preserved and a compact Brain pointer was
appended. Project paths, check recipes, policy, and local profiles are bound. The
archive's historical `BUNDLE_SHA256.json` remains historical evidence.

## Checkpoint and next action

Checkpoint ADOPTION-001-REVIEWED: coordinator and Sol independently verified JSON,
TOML, canonical paths, ignore behavior, preserved source guidance, and source provenance.
A fresh read-only Codex Sol/high session read the root instructions and mapped records
and correctly identified the approved scope, next task, and open gates (see
`.brain/evidence/fresh-session.txt`). Its observation occurred before this checkpoint.
No application build or test ran during adoption. No Git identity is configured, so
there is no fabricated commit or global identity change. The coordinator captured
the audited Git index tree above and dispatched Luna under BASELINE-001.

Browser qualification remains BLOCKED because the required Chromium executable is
absent; no browser assertions or current navigation-policy claim exist. Do not
download a browser for this bounded task.

## Baseline evidence and next eligible action

The scoped launcher, fixture and verifier changes rebuilt successfully. The targeted
set passed 34/34; `npm test` and `npm run verify` each passed 153/153 with zero failed,
cancelled, skipped or TODO tests on Node 24.19.0/npm 12.1.0/TypeScript 5.8.3.
That tested candidate has source fingerprint
`d1ee7e379d8e569b7a49d3c8d6ffc5190b91411a1d5dcad607854b521aa2ef74`.
Logs live in `.brain/evidence/`; the first Windows ENOTEMPTY failure is recorded in
`npm-test-initial-failure.txt` and was repaired by closing fixture-owned processes
before runtime shutdown/removal, with bounded retries and propagated failures.

The real launcher test uses an isolated source copy, a foreign cwd, a temporary DB,
and pinned tools. It observed HTTP 200 at `/platform-api/overview` (version 0.3.0)
and `/`, then removed its owned processes and fixture. This is HTTP startup evidence.

Sol's review found reporting false failures for actual nested and failing-TODO Node
output. Luna repaired them and added actual reporter fixtures, then refreshed every
bound check. Sol accepted the final exact diff with no blocking findings and
independently matched the source fingerprint; the coordinator matched it too.
Commands, logs, candidate and history are in `.brain/evidence/baseline-result.json`.
Next eligible action: answer or route a new user request. No future implementation
contract is selected. Do not reexecute this completed task or start the proposed
roadmap without a new directed scope. Browser qualification and Node 22 execution
remain separate open gates; the local reliability acceptance above is complete.

The current managed sandbox protects `.git` and `.codex` as read-only. No further
Git/profile mutation is needed for closure; use the adoption tree, read-only
diff and tested source fingerprint. Named profile selection is unavailable in this
runtime; explicit model/effort dispatch remains the documented working route.

A fresh-context Sol/high resume probe independently found the completed checkpoint,
correct routes and next eligible action, without executing code. It identified old
adoption wording, which was clarified as historical. Structural closure checks found
five valid Brain JSON files and no missing canonical bindings. Original archives and
prior analysis reports retain their hashes; the final maintained fingerprint still
matches the tested candidate after these record-only updates.
