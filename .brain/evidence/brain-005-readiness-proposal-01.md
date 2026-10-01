# BRAIN-005: grounded managed readiness proposal

Planning only, from read-only source inspection on 2026-10-01. This document does not adopt a task, reconcile the atlas, authorize dispatch, or report implementation/testing.

## Concrete problem

`tools/brain-control.mjs:58` already inspects actual source and binds its inspection digest, but its snapshot omits the atlas's source-reference descriptors. `prepare()` rejects structural invalidity and missing authorization while permitting a structurally valid `sourceStatus: DEGRADED`. Profile validation links accepted plan nodes but does not require the selected focus to ground the canonical selected task. `tools/brain-live-ui.mjs:47` labels mere profile presence as reviewed and enables preparation on that basis. Existing binding checks protect later changes; they do not establish initial readiness.

## Finite source scope

- `tools/brain-control.mjs`: expose `plan.sourceRefs`; implement one shared, structured managed-readiness assessment; enforce it before preparation effects and through `verifyOrder()` before execution.
- `tools/brain-live-ui.mjs`: show that assessment and its reasons; disable Prepare when not ready and Start when the prepared order is stale or current readiness fails. Distinguish profile presence from validated readiness.
- `tests/brain-control.test.mjs`: align the existing generic fixture and add the small source/focus/task-link admission checks below.
- `tests/brain-live.test.mjs`: verify the actual state/action interface exposes and enforces readiness while observation remains available.
- `docs/brain/README.md`: document readiness and explicit reconciliation without implying the atlas grants permission or authenticates results.

No atlas schema or atlas-tool change is required. Root owns the actual canonical task/profile, atlas focus/source-reference/pin reconciliation and archived planning history. The separate core entry correction is limited to `README.md`: identify `npm run studio:full` / `START_FULL_STUDIO.cmd` as the paired full-platform console; retain the legacy `npm run studio` distinction.

## Generic readiness rule

Preserve existing valid authorized contract/profile checks and fixed-command/candidate boundaries. Add all of these requirements, using fresh `projectSnapshot()` inspection:

1. Atlas structural status and source status are both `VALID`.
2. `focusNodeId` identifies an accepted node with observable acceptance criteria.
3. The validated selected-task profile's `planNodeIds` includes that focus.
4. A source-reference ID in the focus resolves through `plan.sourceRefs` to the exact canonical `execution.contract.sourceTaskRef` path; its current inspection entry is `MATCHED`.

Do not infer linkage from titles, product names, repository-specific IDs, parent milestones or timestamps. Root can select an accepted MCORE node directly linked to the newly adopted canonical core task. Do not silently change pins or adopt plans. Unrelated optional planning gaps remain observations, not additional execution gates.

Return bounded, inspectable reasons in `managedReadiness` (for example missing profile, source not current, missing/unsupported focus, focus absent from profile, focus not linked to the canonical task). Missing or invalid readiness should leave the live observation view usable, with Prepare refused by the server before order/candidate/work activity is created. A malformed profile must not produce a misleading ready label. Existing order-binding/profile/input digests remain authoritative for later staleness; reuse the readiness rule from verification instead of maintaining a second UI-only rule.

## Minimal acceptance

- An aligned, source-pinned non-Quadbridge fixture prepares and preserves the existing managed candidate/check/review behavior.
- Actual pinned-source drift refuses preparation without creating a new order/candidate/work event. A structurally valid focus linked to another task is likewise refused.
- Explicitly reconciled pins and an accepted focus linked to the canonical current task permit preparation again. Changing that task/focus/source after preparation prevents execution through existing binding plus shared readiness verification.
- Actual live state exposes the readiness reasons and source refs; HTTP Prepare enforces them. Observation remains readable when execution is unavailable. The UI never equates profile existence with reviewed readiness.

Luna implements this small scope first, with the README entry correction. Root captures exact source, fresh build and focused existing Brain tests, then freezes the core-delivery source before the continuous actual Studio/domain/runtime/recovery journey and one justified required full suite. This proposal adds no portfolio scheduler, generic permissions framework, native stress campaign or new external adapter.
