# BRAIN-001 — repository Brain tooling

Status: ACCEPTED for the scoped repository-tooling contract at workflow revision 4. The repository-wide suite remains FAILED with one unresolved publisher-proof failure and two blocked skips. Authorized by the user in this chat on 2026-10-01: "ok proceed and implement it", following the proposed file-backed Brain design.

## Deliverable

Provide a dependency-free local CLI for validation, focused context, immutable run/review records, and checked checkpoint updates. Structured task contracts and immutable checkpoint events back one current pointer and a generated readable current summary. Keep command definitions separate from execution results. Existing human/tool approvals remain authoritative; stored records do not authenticate approval or independently prove reported execution.

## Ownership and scope

The root coordinator owns Brain adoption, shared configuration and documentation. A selected Brawn/Luna agent owns the new development tools, tests and npm entry point. Brain/Sol agents plan and independently review. Preserve concurrent platform work and all legacy evidence. Existing platform task records are imported only as reported state, with provenance and their existing qualification limits. Do not continue or alter application/runtime implementation as part of this task.

Use a new generated `.brain/CURRENT.md` rather than overwriting the evolving legacy `.brain/PROGRESS.md`. The project map will identify the new canonical view after verified adoption. Preserve the existing platform task mapping at handoff; BRAIN-001 has its own evidence and completion record.

The structured contract's `allowedPaths` defines the exact candidate source-file manifest for freshness and review. It is not a sandbox or the complete coordinator write scope. Root additionally owns this task, structured contracts, immutable workflow events/runs/artifacts, the current pointer and generated view. Those evolving operational records are intentionally outside the candidate manifest. Imported/proposal contracts cannot gain fresh ACCEPTED status. Full-suite invocation is a required observation; unrelated blocked profile gates remain separately unqualified rather than being converted into an all-suite pass.

## Acceptance

1. `validate`, `context`, `record` and `checkpoint` work through the local CLI with actionable errors and documented input formats. No automatic command execution or agent dispatch.
2. Structured contracts identify scope, source files, acceptance checks and required review. Candidate-bound run/review records cannot be silently replaced; record files and copied evidence are integrity checked.
3. Checkpoint publication uses an expected revision and a participating-writer lock. Stale updates and concurrent publication are rejected. Complete immutable material precedes the current pointer; the readable summary is derived and repairable. No expiry-based lock reclamation or security-boundary claim.
4. Acceptance requires the contract's recorded qualifying evidence for the relevant candidate. Failed, skipped, blocked, deferred, unknown or stale evidence never becomes a pass. Claimed independent review remains explicitly attributed reported evidence.
5. Existing Brain records and live platform source are preserved. Current context can be read without loading all historical logs. Project-local records remain excluded from runtime snapshots.
6. Build before focused meaningful regressions, run `npm test`, and obtain independent exact-scope review. Record real commands, source identity, outcomes and any blocked or unrelated failures. No browser/provider qualification is inferred.

## Exclusions

No daemon, SQLite migration, dashboard, automatic scheduling, external service, credential change, deployment, global configuration, blanket filesystem/security enforcement or invented budget. Keep the implementation proportional to core delivery.

## Initial checkpoint

Repository instructions and the mapped platform task were refreshed before implementation. Platform work is changing in another session; Brain adoption must reread it before publishing. Planning and integration exploration are read-only. No build/test result is claimed yet.

## Initial source review

The first read-only Brain review of the new core requires repairs before approval: follow the committed pointer's predecessor chain while retaining orphan events; keep historical records readable after source/contract/recipe evolution; validate selected record/artifact integrity in context; bind qualifying runs to current recipe digests; and keep imported/proposed tasks explicitly unqualified. Root also identified recipe validation incorrectly crossing every contract and required the documented state transitions. These are work-in-progress findings, not failures of an accepted candidate. Build/focused/full results remain pending at this checkpoint.

## Concurrent platform progress

The existing platform coordinator accepted CP4's local core and advanced the actual project mapping to PLATFORM-005A while tooling was being implemented. Root observed the active platform chat and refreshed its mapped task. Preserve that update; never restore the earlier PLATFORM-004 mapping. The new imported PLATFORM-005A contract is context-only. Brain source changes remain confined to the assigned tools/test/npm entry and coordinator records. Full regression validation will use a frozen portable source copy to avoid interfering with concurrent platform builds; its exact source and environment must be reported. No global source lock or synchronization with the other chat is claimed.

## Source readiness and test handoff

Independent Brain review found no remaining material source blocker at core `ab41dcd35d2459e231a2f34e5971cdb4bd4e00de8fa181b72a1d6278e53d775b` and CLI `5941315d34338ccf07318bcf5b1a96bc18f78072bd87de59689301c19a543b7e`, with both pins stable across review. This is source readiness only, not execution acceptance. Root interrupted the initial implementation agent after those files and npm entry were complete, then explicitly transferred sole Brain source-write ownership to `/root/brain_tests` for the bounded test file. Root will run the build and actual tests on the frozen copy. No final acceptance is claimed yet.

## Actual initial validation

Root captured a coherent portable maintained-source copy at `02c6cde1b90cd7961b888dd33f92cd8f704043bbca26a92e2f453a8e49ef232b`, with Brain candidate `15957c3e789c6a54f0c289920ee6bb2d92b35a0fd13a08577a82a90104b151ed`. Fresh build exited 0. Focused execution then exited 1: 10 tests, 6 passed, 4 failed, no skips/cancellations/TODO. Raw output remains `.local/brain-001/focused.tap.txt`. Failures were test fixture mistakes: JSON versus human output, assuming rejected publication advanced revision, parsing validation failure from the wrong output stream, and failing to adopt the fixture map before its second publication. The sole test writer was assigned these narrow corrections. Core and CLI source remained unchanged. A new exact candidate and fresh build are required before the repaired focused run and full suite.

## Corrected candidate and actual adoption

The corrected Brain candidate is `798ad1dc674657f87c4da66fdd55f919ad518929d67609240eef9eaa5846f1d5`; the frozen maintained source is `3c6a0f636d8534476186c3607315a322cc8c39470a1d5b3956116d12449a951f`. Fresh build exited 0, followed by focused 10/10, zero other counters, exit 0. Root adopted the actual PLATFORM-005A mapping, preserved legacy documents byte-for-byte as reported imports, and switched only canonical progress and recipes to the new workflow. Actual validation at revision 2 exited 0. Independent Brain review matched every live/saved candidate file and the aggregate digest, read the passing focused/build/adoption logs, and found no material scope blocker. Full-suite review remains pending.

The initial full suite exited 1: 255 tests, 233 passed, 21 failed, 1 blocked-policy skip, no cancellations/TODO. Every listed failure was the platform's private-toolchain setup refusal of the TypeScript junction created by the existing portable-copy helper. Root retained that result in immutable run `88086a4b-b04f-4312-a685-848b58f5dced`, then replaced only the temporary copy's three dependency junctions with hash-matched normal files from the same installed pinned dependencies. Source dependencies, source controls and machine policy were unchanged. Independent review accepted this harness correction. The required full-suite rerun is underway; it preserves process-local `QB_TEST_CP3_NATIVE_LOCK=blocked-policy` for the previously denied fixture and makes no new browser/provider/production claim.

## Complete full-suite observation

The rerun completed with actual process exit 1: 255 tests, 252 passed, 1 failed, 2 skipped, zero cancelled/TODO, 546.616 seconds. All 10 Brain tests passed. The sole failure was the Combined runtime fixture during artifact publication: `The fixed registry publisher did not provide one valid physical result proof` (`artifact-store.js:543`). It remains unresolved; no platform publisher repair or full-suite pass is claimed. File-symlink EPERM and the previously denied native staging-lock fixture remain the two named blocked skips. No new browser/provider/production validation was attempted.

Root verified every scoped live/frozen file and the full frozen maintained-source fingerprint after completion; all still match. Immutable run `.brain/workflow/runs/ad15304e-8094-4c5e-b7a5-e0494b6dc35d.json` records the actual FAILED full-suite result and copied evidence. Revision 3 moved BRAIN-001 to REVIEW with `repository-suite=FAILED`, retaining the platform task as reported imported context. Final independent scope acceptance remains pending at this checkpoint.

## Final scoped acceptance

Independent `/root/brain_state_review` accepted exact candidate `798ad1dc674657f87c4da66fdd55f919ad518929d67609240eef9eaa5846f1d5` after independently matching all eight live/captured files, recomputing its digest, and checking the selected records, bindings and copied evidence. Its attributed read-only review is immutable record `.brain/workflow/runs/07f14a58-ea61-4c2a-b037-83476dac9bef.json`, including the reviewed source copies. The reviewer ran no builds/tests and did not establish the publisher failure's cause.

Root published BRAIN-001 ACCEPTED at revision 4, retaining `repository-suite=FAILED`, both named blocked gates and PLATFORM-005A's imported state/mapping. Actual final `validate` returned VALID with 9 records, 4 committed events and no reported errors or warnings. Actual focused `context` returned QUALIFYING_REPORTED_EVIDENCE for BRAIN-001. This is completion of development-only Brain tooling; it grants no platform/browser/provider/production qualification and does not resolve the unrelated publisher-proof observation. Legacy progress/check records were preserved, application code was not changed by this task, and no commit, deployment, credentials or policy changes were made.
