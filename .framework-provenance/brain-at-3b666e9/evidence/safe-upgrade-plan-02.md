# SAFE-UPGRADE-001 — simplified proposal, revision02

Planning only, prepared by /root/repo_brain_architect (Sol/high). Preserve plan-01.md as the earlier proposal. This note replaces its two-phase prepare/activate flow, runtime initialization assertion and provisional owner list. Its remaining identity, original-owner, module-owned migration, source retention, grant/job/receipt and qualification constraints continue. CONSTRUCTION-RELIABILITY-001 remains IMPLEMENTING at canonical revision93/event9a9a7dd7-dbd0-4980-8ac5-fd99d35454b3. No adoption, application edits, build/test/runtime execution or native/profile changes occurred for this proposal.

## Smaller usable flow

One confirmed Upgrade action accepts an exact promoted target version/artifact for an existing positively stopped Combined instance. It prepares a new owned data generation from the verified stopped backup, invokes only the canonical target owner initialization/migrations, positively closes the original native owner, publishes the verified target into an absent destination, and commits the active-generation pointer with fresh original-session authorization. Existing Restart then launches the target and produces actual readiness/stop proofs. Remove the separate READY reservation, activate command/route, cancellation endpoint and user-held prepared state from plan01. Do not automatically start target roles during migration/cutover.

States for the single operation are PREPARING, MIGRATING, PUBLISHING, SUCCEEDED, FAILED, UNKNOWN. The instance after successful cutover is UPGRADE_READY, not falsely RUNNING or a target generation with invented STOPPED/EMPTY facts. Restart's exact eligibility is the successful cutover's target identity, verified complete enrollment/material and positive migration/helper/publication/cleanup facts, plus the original source's positive stop. Its real target attempt establishes later target runtime facts. Recovery on the target still requires a real target positively stopped attempt. No separate generalized deployment abstraction is needed.

Retain the small immutable generation table and attempt generation reference. Updating one runtime_instances identity row without captured generations mislabels prior attempts and backups; that is an actual identity defect, not optional architecture. Backfill historical generation/attempt references without changing old command/audit/receipt/stop facts. Recovery looks up the generation bound to its operation/backup, not today's active projection. Original/source/target build actors remain distinct. No generic lineage graph or multihop/retention engine: one upgrade, two retained generations, no deletion.

The non-expiring upgrade physical slot remains mutual with runtime and recovery admission inside BEGIN IMMEDIATE. Exact operation/token fences and positively observed original physical facts are necessary; no lease/PID/reopened-owner cleanup. Failed known preparation settles only after exclusively owned cleanup is observed; absent native dispatch is not EMPTY. Audit/auth failure after publication preserves the published target and its known facts. Without final authorized cutover the source generation remains active and no runtime launches target. No automatic orphan adoption/retry framework is required in this first increment; uncertain outcomes stay explicit UNKNOWN/repair-required with reservation and data retained. Safe same-key replay retrieves the original operation only.

## Necessary runtime API correction

Observed apps/runtime/src/index.ts SHA e50ab366caa2302be73257ea12500131f29ea5802928fb76c1f026331ad57136 unconditionally calls await host.start(). packages/backend-host/src/index.ts SHA e9cdcd0455fe1ae7af574bee7f9c378d368f983ca0cf7cdb0ed2f870f104c7fa invokes every selected module's optional start hook. createRuntime does not itself call http()/worker(), but it currently has NO migration-only option. background:false does not imply no startup effects.

Current exact Combined implementations inspected: Service Desk a013d0e6034fca24434e54b6096d748127fabfe6a414b822d91c8954afc2d69c, Knowledge3446c2a41abdcac89b22bb6481c7b48d3b72912636928b2da613e0e320722b34, Handoffc329c58b33ea8634543a1bdcf97d960765b3bc861f51dfaadacb234967b2d3c2 have no executable start hook; their registration initializes their own SQLite owner/queue. Wiring5c2def96393bb5f02c95d362624fec14637c83513daf8b266ce7ce547656bb9f constructs lazy local ports, with business/network work invoked later. These are exact inspected implementation facts, not a general initialization safety API guarantee.

Add one backward-compatible fourth createRuntime argument, e.g. options:{initializationOnly?:boolean} with default false. In initializationOnly mode:
- Perform existing artifact/plan/catalogue validation, canonical LocalAccess opening with principals:[], reviewed wiring construction and selected owner registration/migrations.
- Construct ApplicationHost but DO NOT call host.start(). It remains CREATED and existing execute/operation readiness gates reject business execution.
- Returned http() and worker() must refuse before listener/WorkerHost effects; the fixed upgrade driver never calls either or any service/route operation.
- close() closes every constructed module in reverse order (ApplicationHost.stop closes only its started list, so cannot be the sole close path here), attempts all module closures and always closes access, then surfaces the first closure error. Driver failure still requires original Job Object closure proof, never GC assumptions.
- Preserve normal default startup, separate-role execution, authentication, compiled fixed catalogues and normal HTTP/worker behavior.

No backend-host lifecycle rewrite is needed. This is trusted reviewed initialization, not a sandbox for arbitrary module registration/wiring: require the exact supported local Combined owner set and same local provider bindings; inspect changed target owner registration and migration behavior during source review. Registration/wiring themselves remain trusted executable code. Do not claim the option suppresses arbitrary plugin effects. Background-worker owners and their code/handlers stay unchanged in the first proof; only reviewed Desk migration changes. No jobs are claimed/run, routes invoked, new sessions created, readiness granted or commands fabricated by initialization.

The previous 'unchanged runtime compiled code' compatibility rule must explicitly allow this reviewed initialization-only runtime entry change. Other neutral packages, native helper, connection contracts and worker code remain unchanged. Capture source and target runtime bytes separately; the target's fixed driver imports its verified target runtime. Do not compare old snapshot bytes to current source or execute new framework code as old artifact authority. Do not patch exported copies. Existing old runtime restart remains its frozen normal runtime path.

## Preserve data safety without extra mechanisms

Keep the existing positively stopped/no active business sessions backup prerequisite and original current source generation/stop-attempt binding. Reuse canonical recovery backup/verification and owned destination normalization; do not reinterpret ordinary RESTORE as cross-artifact restore. Bind the source root's bounded physical inventory at admission and recheck before final cutover; target migration never opens source files writable. No ongoing source roles can coexist because admission uses the mutual slots and exact stop facts. The selected verified backup and source identity are displayed before confirmation. Any stale/current-generation mismatch denies cutover.

Retain old complete enrollment/private credentials and actual access rows; derive target config identity/path and hashed lineage without localConfiguration, seed regeneration or grant expansion. The new target directory and complete enrollment name the same logical product/instance and new artifact. Compare actual principal/credential/grant/mode/session and command/job/receipt facts before/after initialization. Same provider instance/actor/tenant mapping/binding revision and contract preserves old destination keys and receipt semantics. No generic domain copier or SQL migration list in the platform.

Use unchanged native Job Object ownership for migration and the fixed named-argument same-volume no-replace publisher for publication. Publisher result+original child closure remains distinct from native EMPTY. Existing capacity/path/metadata limits and retained unknown material accounting from plan01 stay; no policy, timeout, identity or permission relaxation. The old root/artifact/backup is retained unchanged. After target roles launch they may write, so no automated rollback or silent restoration of the old pointer. Before cutover source is still active; known clean failure permits ordinary source restart after original slot settlement. A target launch/write requires explicit later downgrade/export decisions, not data discard.

## Finite provisional32 owners (re-inspect after construction)

The flow removes prepare/activate API/UI breadth. Add the necessary runtime entry owner; remove four speculative version-test edit owners whose inspected source has no changing Desk-version expectation (composition/workspace-closure only assert unchanged Knowledge/Handoff versions, build-worker derives source version, control-plane's0.2.0 family claim is deliberate synthetic history). Existing tests still run unchanged. Any actual new dependency is reported before editing, not silently absorbed.

1. packages/control-plane/src/index.ts
2. apps/control-plane/src/runtime-manager.ts
3. apps/control-plane/src/runtime-recovery.ts
4. apps/control-plane/src/runtime-upgrade.ts (new)
5. apps/control-plane/src/operator-server.ts
6. apps/control-plane/src/main.ts
7. apps/control-plane/src/build-inputs.ts
8. apps/studio-web/src/main.ts
9. apps/runtime/src/index.ts
10. tools/runtime-upgrade.mjs (new)
11. tools/runtime-upgrade-publish.ps1 (new)
12. tools/runtime-recovery.mjs
13. modules/service-desk/src/index.ts
14. modules/service-desk/module.json
15. modules/service-desk/package.json
16. products/service-desk/product.json
17. products/combined/product.json
18. apps/runtime/package.json
19. package-lock.json
20. tests/runtime-upgrade-store.test.mjs (new)
21. tests/runtime-upgrade.test.mjs (new)
22. tests/control-plane-artifacts.test.mjs
23. tests/control-plane-http.test.mjs
24. tests/studio-runtime-ui.test.mjs
25. tests/shell-regressions.test.mjs
26. tests/factory-lifecycle.test.mjs
27. README.md
28. docs/STATUS.md
29. docs/SAFE_PRODUCT_UPGRADE.md (new)
30. PLATFORM_ARCHITECTURE.md
31. OPEN_PLATFORM.html (normal build-derived)
32. visual/data.json (normal build-derived)

Six new paths; after accepted construction's expected245 paths this is provisionally251. Full fingerprint/path adoption must use actual accepted source, not this estimate. Source/module/product version changes remain as plan01: Desk module/product0.2.2, Combined product0.2.4; unchanged Knowledge/Handoff0.2.3. Existing exact live composer expectation in control-plane-http must update; synthetic historical plans need not. Root re-inspects whether shell-regressions/factory-lifecycle actually need edited expectations/tests; omit unused owners rather than edit for accounting.

Fixed paired routes now only GET/POST /platform-api/runtime-instances/:id/upgrades and GET /platform-api/runtime-upgrades/:operationId. POST requires exact target version/artifact, verified source backup digest, request key and confirmation, with trusted original operator from the paired session. No /activate endpoint. Existing Restart is the separate actual launch decision; UI displays migration/cutover completion and the exact new target awaiting restart, no ready URL.

## Small meaningful acceptance

1. Pure/store/component checks for generation backfill/history, mutual admission, original-session final cutover, initialized-only host not READY with no startup hook/HTTP/worker effect and positive owner closure. Test initializationOnly against a controlled registered start hook without invoking it; same fixture normal mode still invokes it. Preserve normal exported/runtime tests. One incompatible target/unknown-source denial and one known migration failure are enough; no expanded interruption/stress table.
2. One actual captured old Combined artifact (capture BEFORE Desk source migration, never patch exported copies) creates persistent Desk/Knowledge/Handoff facts, command replay history and one queued Knowledge job, with revoked grant/removed principal/read-only mode. Log out, original positive STOP and consistent verified backup. Build/promote target normally; confirmed upgrade shows owner schema1→2 and exact preserved identities/access/receipts/jobs without business dispatch. Restart same instance, prove retained records/answer/Handoff receipt, denied revoked write, replay no duplicate and queued job normal completion. One new target write then positive STOP; target-generation backup/verify proves existing recovery integration. Old generation material remains unchanged. Existing same-artifact recovery proof need not be exhaustively repeated.
3. Actual ordinary paired browser upgrade→restart for the same existing instance, matching fixed recipes/frozen source, fresh build/focused and one complete npm test original close, then independent exact review. No source acceptance from mocked migration alone; blocked browser/native scope remains blocked. No new evidence engine or duplicate full platform campaign.

Implementation order: generation/store fences → initializationOnly/fixed upgrade owner and additive Desk migration → one paired API/UI action → actual staged/native/browser journey → final current docs/freeze/full/review. Construction must first qualify; this proposal does not alter its current contract or writer grant.