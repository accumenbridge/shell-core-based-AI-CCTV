# CONSTRUCTION-RELIABILITY-001 — bounded proposal

Status: proposal for coordinator adoption, not delivery acceptance. Reviewer /root/repo_brain_architect (Sol/high); sole implementation owner /root/repo_brain_validation (Luna/xhigh). Inspected clean published HEAD22f5b214b63ffabcd7122c9e1e709d525686a27b, checkpoint91 Entity ACCEPTED, atlas42. No application tests or package installations were run. Root must reconcile the new task/focus and source pins, validate/preflight, then admit the writer. Preserve previous acceptance/failure/blocked history.

## Outcome and boundaries

Both normal source generators refuse package/host-route-invalid modules before creating a destination; generated optional values retain absence/false/default semantics and exact command retries; generated Studio declarations describe actual emitted source. A separately recorded clean-copy installation proves committed generated workspaces plus explicitly reconciled lockfile build without inherited dependencies. Current architecture/version documentation accurately names existing local capability/family/UI/mobile/entity behavior and remaining upgrade/provider/production limits.

No product upgrade, data adoption, grant changes, ABI redesign, generation staging/atomic rename, relationships, query framework, evidence archival, production adapter or global setting changes. Preserve exclusive writes and incomplete-generation inspection. Documentation is not a new acceptance claim.

## Exact 25 maintained edit owners

1. packages/contracts/src/index.ts
2. packages/composition/src/studio.ts
3. packages/composition/src/workspace-closure.ts
4. tools/workspace-identities.mjs (new)
5. tools/generation-preflight.mjs (new)
6. tools/link-workspaces.mjs
7. tools/factory.mjs
8. tools/entity-builder.mjs
9. templates/entity-ui.ts.txt
10. tools/studio-catalogue.mjs
11. apps/control-plane/src/build-inputs.ts
12. tools/construction-clean-install.mjs (new)
13. tests/construction-reliability.test.mjs (new)
14. tests/entity-builder.test.mjs
15. tests/entity-builder-ui.test.mjs
16. tests/studio-integration.test.mjs
17. README.md
18. docs/ENTITY_BUILDER.md
19. PLATFORM_ARCHITECTURE.md
20. IMPLEMENTATION_STATUS_0.3.md
21. FOLDER_STRUCTURE.md
22. FULL_PLATFORM_BUILD_MAP.md
23. docs/STATUS.md
24. OPEN_PLATFORM.html (normal build-derived)
25. visual/data.json (normal build-derived)

Four new paths; coordinator unions these with existing reviewed241 candidate paths (expected245 physical paths after creation). Do not edit package/lock/module/product versions or current accepted product definitions. New fixture modules/locks live only inside owned ignored temporary copies. If a genuinely necessary owner is missing, report it before editing; do not silently expand.

## Interfaces and implementation decisions

**Same source identities:** export a small pure validSourceDirectoryId(value) predicate from contracts/index: lowercase leading letter, lowercase digits/hyphens, total2–48. Use it for generator module IDs and factory product/module IDs and the existing composition product/workspace-package envelope. Preserve validProductId public API as a wrapper. Do not apply it to field/command/workspace/operation identifiers, whose distinct syntax is intentional. Do not rewrite historical snapshots. Offline browserCore must export/inject this exact compiled predicate wherever the composition wrappers now import it; no handwritten browser validator.

**Workspace uniqueness/link ownership:** new built-ins-only workspace-identities scans fixed packages/modules/apps physical child package manifests, identifies actual declared package names/paths and rejects duplicate package names before linking any workspace. Expose inspectWorkspaceIdentities(root) and assertWorkspaceNameAvailable(index, proposedName). Refuse malformed identities rather than silently ignoring malformed existing package manifests. Both generators call the same helper before destination writes. Uniqueness is package-name based, not a static list of reserved module names. Linker verifies each existing link resolves to the exact declared workspace; an unrelated file, directory, broken link or wrong target fails without replacing it. No unlink/repair-on-behalf-of-user behavior. The helper has no compiled imports, so fresh build and compiler-free assembled setup remain usable.

**Canonical manifest preflight:** new generation-preflight imports existing compiled canonical composition resolve and Studio validateStudioModule, builds a minimal one-module product for these two dependency-free generators and returns the validated manifest. The existing resolver remains the only host-route/collision policy; no copied reserved-route list. Validate rich metadata and actual operation/UI declarations through existing validators. Both create-module and generateEntity construct all manifest/output data, check source package identities and preflight BEFORE destination mkdir/write. Resolve only inert reviewed declarations; never import a generated executable or grant permissions.

Bootstrap choice is explicit: canonical preflight requires a fresh base framework build before first generation (npm ci, npm run build, then generation). Current pristine entity generation without dist becomes a clear before-effects prerequisite refusal, documented as a deliberate narrower workflow; no auto-install/auto-build or fallback policy. Later clean-copy proof establishes this exact sequence. Root must acknowledge this choice on adoption; it is not an implicit compatibility promise. Existing documented generated modules are reviewed source, not runtime metadata.

Factory create-module should obtain actual neutral dependency package versions from the same source manifests instead of its old hardcoded0.2.0 values, so normal creation remains coherent after package version evolution; no package version changes here.

**Copy/export integration:** add the three new exact tool leaf names to build-inputs TOOL_FILES, with unchanged credential/data/link/path rejection. Factory assemble must copy workspace-identities.mjs with link-workspaces.mjs. It must not copy generator/install authority into a running browser. verify-core already includes ordinary tools/test source paths, so no verifier filter amendment is necessary. A compiled-only assembled runtime's setup must work without compiler/source dependencies. Existing closure reads captured bytes; do not compare old snapshots to current source.

**Optional controls:** optional boolean uses a tri-state Not set/Yes/No control; required boolean remains checkbox with false valid. Optional enum includes an empty Not set choice. Defaults initialize controls; absent optional/no-default values are omitted from payload, and edit of an absent value must remain absent. A field with a default remains subject to existing backend default normalization; no null convention or domain validator change. Explicit false and explicit enum values survive create/edit/read. Preserve selection generations, original scoped signal, captured payload plus commandId and exact retry, conflict reload, viewer/tenant safeguards. Changing a draft while an earlier result is ambiguous must not reinterpret its saved intent.

**Generated Studio metadata:** derive existing supported studio shape from generated source: ui/backend/data layers; emitted workspace route/label; one module-owned relational store and schema generation; one HTTP process declaration. No fictitious provided service, worker, AI capability, running/production flag, grant or resource commitment. Validate through existing studio-model. Existing summarizePlan may project those declarations; reporting is declaration-based, not live qualification. No new Studio schema or independent catalogue.

**Explicit clean installation:** tools/construction-clean-install.mjs is a finite acceptance driver, not called by generators or ordinary npm test. Use two exclusively owned temporary roots: A copies reviewed source without dependencies/dist/state, npm ci then npm run build, generates both reviewed entity blueprints and the normal checklist source module, creates ordinary independently versioned products, then explicitly runs npm install --package-lock-only --ignore-scripts. Capture the resulting package manifests/lockfile and generated source hashes. B receives only that source+reconciled lockfile, with NO node_modules/compiler junctions/dist/state, performs ordinary npm ci and npm run build, and checks exact generated identities/source hashes and normal selected product outputs/omission. Setup linker twice in B must be idempotent. Record actual command exits, Node/npm/platform, lockfile before/after hashes, source/input/output identities and bounded logs; assert npm ci/build did not mutate the reconciled source lock. No credentials/registry changes, automatic repair/retry or generator lock mutation. Required dependency downloads use the existing ordinary npm configuration; network failure is BLOCKED/FAILED, never replaced by copied installed dependencies. Keep uncertain owned process/material for review, cleanup only after original child close.

## Small meaningful qualification

Build before edited-source tests. Focused command:
node --test --test-concurrency=1 --test-reporter=tap tests/construction-reliability.test.mjs tests/entity-builder.test.mjs tests/entity-builder-ui.test.mjs tests/studio-integration.test.mjs

Cover both generators rejecting actual package-name collisions and session host route before destination creation; linker duplicate/wrong-target refusal and correct-target idempotence;48accepted/49refused same source IDs; generated rich metadata validates and summary derives its declared store/routes; optional boolean/enum absence, false, default and enum selection in compiled real generated UI plus real owner HTTP/operation projection; one ambiguous result exact retry keeps the original omitted-value payload/key after draft edits. Keep existing real persistence/receipt/source-removal assertions. Use a small table, not a new fault matrix.

After stable focus, run the explicit clean-install driver once as its own required acceptance recipe, with original child closes/source context captured. Keep it separate from full npm test to avoid repeating dependency installation in every suite. Run ordinary Chrome against one normal assembled source-free optional-field product on the actual createRuntime HTTP host: Not set values remain absent after create and untouched edit; explicit No remains false; selected enum/defaults persist; edit back to Not set removes optional/no-default values, with read/reopen confirming the owner projection. Preserve exact scope/command/read-only/logout checks. Capture DOM/owner rows, exact exported inventory and original owned console/runtime close. Do not repeat the unchanged paired build/register/promote/native recovery journey; this scoped browser proof does not requalify those mechanisms. Any actual browser permission/policy block remains blocked and cannot qualify this real UI journey through VM simulation.

After all maintained source/docs/generated bytes freeze, root runs required npm test once serially, captures original outer close and before/after candidate. Require exit0 and zero failures/cancellations/TODO; record any exact justified EPERM coverage skip as unqualified. Independent Sol final review binds current source, contract, build/focus/clean-install/browser/full artifacts. Portable/Windows/hosted/provider/production coverage stays separately stated. Existing CI workflow need not change for this local proof.

## Bounded documentation and future sequence

Update the five historical-looking guides plus README/STATUS/entity guide with a concise current architecture map/links and named version dimensions: repository package release0.2.0, Studio program scope0.3, module ABI, module/product semvers, operation versions, family/entity/UI schemas and artifact format. Preserve historical migration/status context instead of silently retelling it as current. State actual local Entity/FAMILY/UI/CAPABILITY acceptance with existing immutable result references, and limits: same-artifact restart/recovery exists, cross-artifact upgrade not implemented, deterministic extractive provider is not model inference, mobile is not native qualification, metadata is requirements not grants/proof. Do not invent final test counts before they exist. Avoid a broad prose rewrite.

Next after exact construction acceptance: bounded retained-data product upgrade, then select a supported production target in a separate decision. Evidence storage migration, atomic source staging, pagination/index/relations and global refactors remain deferred with these triggers; no production provider selection is inferred from this task.

Qualification integration clarification: generation API unit fixtures must supply the actual built canonical preflight dependencies from the reviewed compiler output; minimal fixtures that formerly omitted these prerequisites must be adjusted within tests/entity-builder.test.mjs. Do not mock or copy the host reserved-route list. Pure validateEntitySpec remains usable independently of compiled preflight. Record preparation installs/builds separately from generator side effects. Compact evidence: one frozen full manifest, per-run actual log/execution plus before/after candidate+contract digest, existing canonical records; no evidence Brain rewrite or redundant full manifest payloads required.
