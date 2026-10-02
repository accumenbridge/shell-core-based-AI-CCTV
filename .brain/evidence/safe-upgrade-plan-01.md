# SAFE-UPGRADE-001 — read-only architecture proposal

Proposal only; no task adoption, source changes, tests, installations or runtime launches. Prepared by /root/repo_brain_architect (Sol/high), after read-only inspection of published22f5b21 and current accepted runtime/recovery owners. CONSTRUCTION-RELIABILITY-001 remains the current sole-writer increment. Root must re-inspect after its acceptance, capture the actual old promoted Combined artifact before changing domain source, reconcile the new task/atlas and preflight before dispatching Luna. The user's approved sequence authorizes this local outcome; it does not select a production provider.

## One useful outcome

Upgrade an existing positively stopped Combined instance from its exact accepted artifact to a distinct promoted new Combined artifact, through one additive Service Desk owner migration. Retain logical product/instance/tenant/actor identity, credentials and actual grants/modes, command receipts/audit, documents/indexes, Handoff delivery facts and queued job identities. Preserve old artifact/data/backup untouched. New code must never reopen the old data root for migration. No rolling deployment, owner addition/removal, changed provider target, automatic grant expansion, arbitrary migration SQL, exported-copy patching or automatic rollback.

## Grounded seams and gaps

runtime-manager.ts currently derives data root as .local/platform-runtime-data/<instanceId>/<artifactDigest>; RESTART takes the existing exact version/digest and completed enrollment/config/profile/toolchain/recipe. ControlPlaneStore schema5 has one runtime_instances artifact identity; old attempts are joined to it and lack independent generation identity. Blindly updating this row would make historical attempt/recovery DTOs describe the wrong release. Recovery validates exact positively stopped attempt and immutable backup identity, restores only absent same-identity roots, and refuses unexpired access sessions. SqliteOwner already applies owner migrations transactionally with old SQL digest validation. Handoff refuses changed binding revisions/targets and retains UNKNOWN receipt facts. These mechanisms must remain authority, not be bypassed by a new generic database copier.

Inspected hashes: runtime-manager.ts99208fc042aa334caf54eca526a09adaf338ab6e6b3d6783a084f9194943067f; runtime-recovery.ts02f9fdb51c5cbfac1a12d92ae19e861fdc3ee03626a462979b8a31bea90e3f1d; control-plane/index.ts2fd5a03c68e128bada529c6a43f8ec5baf444ed4631903eefbf4d62ce4a093be; runtime-recovery.mjs8fd0981ee90b31673e4487a2de72b4dd6918d8b16abab1dea8131885a364cf35; service-desk/index.tsa013d0e6034fca24434e54b6096d748127fabfe6a414b822d91c8954afc2d69c; solution wiring5c2def96393bb5f02c95d362624fec14637c83513daf8b266ce7ce547656bb9f. These are planning observations, not future candidate pins.

## Minimal generational model

Add schema6 immutable runtime_generations records with generationId, instanceId, generationNo, exact product/version/artifact/config/profile/adapter/toolchain/recipe, artifact build-origin actor, enrollment digest, creation actor and upgrade operation link. runtime_instances keeps its stable id and an active_generation pointer; existing identity columns remain current projection for compatible callers. Backfill one generation for each existing instance and generation_id on each existing attempt. Do not alter old receipts, commands, stop facts or timestamps. All historical attempt/recovery lookup joins use the captured generation; no silent projection from today's active artifact. Future schema versions still fail closed.

Add runtime_upgrade_operations and one non-expiring physical upgrade slot, mutual with runtime and recovery slots inside BEGIN IMMEDIATE. States PREPARING, MIGRATING, PUBLISHING, READY, SUCCEEDED, FAILED, UNKNOWN; immutable original operator/request-key/input digest, source generation/stop attempt/backup, target promoted artifact/generation and actual migration/publisher/cleanup facts. Request replay is same actor+key+payload; it returns original intent, not a new owner token. Every fact API fences operation/token; original-only facts remain monotonic after auth loss. No lease/PID/age reclamation. Source/target build actors and initiating operator remain separate.

Prepare and activate are separate explicit operations. READY retains the prepared reservation/material until that original operation is activated or its positively closed original owner cancels it; source instance remains stopped on the old generation. On successful activation, commit a new active-generation pointer and audited lineage in one fresh-authorized transaction; instance state is UPGRADE_READY (not falsely STOPPED/RUNNING). This means no target runtime has launched. RESTART may admit UPGRADE_READY only when the exact successful upgrade proves target material verified, migration Job EMPTY/helper closed, publication closed and operation staging clean, with the original source runtime positively stopped. It creates a real next runtime attempt pinned to the target generation. Recovery remains refused until that target has an actual positively stopped runtime attempt. Source history and stop facts stay historical, not fabricated target EMPTY proof.

## Fixed preparation pipeline

Require source STOPPED+EMPTY+helperClosed+executionClean, empty runtime/recovery/upgrade slots, verified consistent stopped backup with no active business sessions, current original paired operator, exact promoted target same product id and distinct product version/artifact. Verify both snapshots and derive their canonical plans. First profile permits unchanged module IDs, provided/required contract identities, bindings/lifetimes/modes/tenant maps/service actors/revisions, unchanged runtime host package versions/compiled code and unchanged worker-bearing module bytes. Changed owner must be background=false and forward-compatible; no new permissions are automatically granted. Source and target helpers/Node/PS normal profile remain the reviewed supported host. Unsupported change fails before data effects.

In this proof only Service Desk changes schema; Knowledge/Handoff code, job kinds and provider wiring remain exact. No target plan is matched by product display name. Compatibility rules compare the actual two captured plans and configurations. A backup must match the source generation and exact current stop attempt; pending job rows are not reset to look fresh. Lease/deadline/attempt/cancellation semantics continue normally after restart.

Reserve capacity under the same synchronous after-BEGIN original-session/capacity checks as recovery. Use existing32MiB/database,128MiB/data payload,64files,1MiBmanifest,192MiBstaging limits and512MiB aggregate physical budget including old/target/staging retained material. Use bounded16384-entry monotonic traversal and unchanged Windows240-path/native execution bounds. Count unknown operations/material conservatively. Bound this first increment to one successful upgrade per instance (two generations); retention/pruning/multi-hop policy is a later explicit outcome.

A fixed upgrade driver executes under the unchanged reviewed Windows Job Object helper. It verifies source backup bytes and captured migration/owner descriptors, copies only verified files to a new exclusive stage and retains source backup/data. Normalize only the owned copied SQLite destinations using the existing standalone backup normalization. Construct target config by retaining the old credentials/seeds metadata and exact connection identities, changing only the target artifact/profile/private data path and explicit lineage. Do not rerun localConfiguration or seed/principal/grant insertion.

Run the exact copied target apps/runtime createRuntime with principals:[] against staged data to invoke actual owner initialization/migrations. Do not listen HTTP, start a worker or execute business commands. This initialization is limited to the verified local unchanged-provider plan; no arbitrary executable/migration/URL input. Close the canonical host/access/module owners; fixed driver exit plus nonce-bound Job EMPTY and helper close is required before considering migration complete. Constructor failure is closed by owned process termination, not GC or guessed database closure. Migration SQL remains entirely in its module; no platform-written ALTER TABLE list.

Post-migration verify access binding and principal credential/grant/mode rows unchanged, no sessions created, old migration prefix digests preserved and target owner schema generations valid. Preserve receipt/audit/job identity and payload/attempt/deadline/cancellation rows; target migrations may only make their explicitly reviewed owner data changes. Materialize the new complete enrollment records in this exclusively owned clone using target canonical identity, old private credentials/seed metadata, principals:[] config and a separate hashed lineage receipt. Completion means verified existing access, never a claim that revoked identities match the original seed grant list.

Publish only into absent .local/platform-runtime-data/<sameInstance>/<targetDigest> using a fixed named-argument no-overwrite same-volume MoveFileEx helper; no untrusted request paths, fallback replacement or policy changes. Distinguish publisher MOVED+matching child close from Job EMPTY. Verify the entire destination inventory/digests and metadata after move. A moved object survives final audit/logout/verification uncertainty; UNKNOWN retains reservation and known facts. Metadata-only reconciliation of a fully verified orphan may be designed only if needed, and cannot fabricate original physical closure. Cutover must recheck original session after awaits and inside final BEGIN with exact source generation/stop identity still current.

## One additive owner change and coherent versions

After construction acceptance, planned Service Desk migration2 adds owner-local origin_kind TEXT NOT NULL DEFAULT 'manual' constrained to manual/handoff, backfills from existing source provenance, and uses explicit insert columns so new handoff commands set the value correctly. Keep migration1 SQL byte-for-byte and every existing record id/business version, receipt namespace/input normalization and public desk create.v1/v2 semantics unchanged. This field gives a visible inspectable schema transition without inventing an arbitrary customer attribute. No new permission needed.

Advance Service Desk module/package0.2.1→0.2.2, source Service Desk product0.2.1→0.2.2 and Combined0.2.3→0.2.4; update exact source module selection, runtime workspace dependency and root lock entry. Knowledge/Handoff0.2.3 and their public contracts remain unchanged; Knowledge product is unaffected. Old captured0.2.3 Combined/0.2.1 Desk artifact remains valid from its own bytes. Do not compare it with the new source catalogue. Inspect exact live-source expectations at adoption and amend only those, preserving explicit historical live-rebuild fixtures and old snapshot proofs.

## Finite provisional35 owners, re-inspect after construction

packages/control-plane/src/index.ts
apps/control-plane/src/runtime-manager.ts
apps/control-plane/src/runtime-recovery.ts
apps/control-plane/src/runtime-upgrade.ts (new)
apps/control-plane/src/operator-server.ts
apps/control-plane/src/main.ts
apps/control-plane/src/build-inputs.ts
apps/studio-web/src/main.ts
tools/runtime-upgrade.mjs (new)
tools/runtime-upgrade-publish.ps1 (new)
tools/runtime-recovery.mjs
modules/service-desk/src/index.ts
modules/service-desk/module.json
modules/service-desk/package.json
products/service-desk/product.json
products/combined/product.json
apps/runtime/package.json
package-lock.json
tests/runtime-upgrade-store.test.mjs (new)
tests/runtime-upgrade.test.mjs (new)
tests/control-plane-artifacts.test.mjs
tests/control-plane-http.test.mjs
tests/studio-runtime-ui.test.mjs
tests/composition.test.mjs
tests/workspace-closure.test.mjs
tests/shell-regressions.test.mjs
tests/factory-lifecycle.test.mjs
tests/build-worker-process.test.mjs
tests/control-plane.test.mjs
README.md
docs/STATUS.md
docs/SAFE_PRODUCT_UPGRADE.md (new)
PLATFORM_ARCHITECTURE.md
OPEN_PLATFORM.html (normal build-derived)
visual/data.json (normal build-derived)

Existing recovery driver exposes/reuses its reviewed read-only backup identity/database verification and copied-destination normalization; do not widen RESTORE semantics to accept another artifact. Runtime manager exposes narrowly reusable verified-copy/fixed-native-launch primitives rather than copying another Job parser. Fixed new helper leaves enter build-inputs and normal full source fingerprint. No native helper/LocalAccess/SqliteOwner/worker/connection/solution/runtime host ABI edits expected. Source pin/version tests listed are upper bounded owners: omit unused owners at adoption rather than bulk-replacing old identities. Any new actual dependency is reported before editing.

## User flow and essential acceptance

Fixed paired routes: GET /platform-api/runtime-instances/:id/upgrades; POST same path with targetProductVersion, targetArtifactDigest, sourceBackupDigest, requestKey and confirmed:true; GET /platform-api/runtime-upgrades/:operationId; POST /platform-api/runtime-upgrades/:operationId/activate with fresh confirmation/key. Optional original-owner cancel only while no native uncertainty; not a cleanup permission for a reopened process. DTOs show source/target exact versions/artifact prefixes, phase/facts, old-generation retention and no automatic rollback; no private paths/tokens/credentials/database downloads. Studio controls use exact detail/generation, clear on edit/navigation/logout and never advertise URL before actual ready native runtime. Existing Start/Restart/Stop/Recovery are unchanged for ordinary instances.

Build first; focus store/migration/HTTP/UI + one actual native staged upgrade. Core proof begins with the actual captured old Combined artifact, not a patched exported copy. Root should capture/import that verified artifact before source migration implementation and record complete captured inventory/source provenance. Component tests can construct schema1 data through the unchanged module-owned migration descriptor; this does not qualify old code execution. Actual browser/native journey must run old code from captured bytes.

Old journey creates Desk request/committed receipt, Knowledge indexed document and accepted Handoff; one additional queued Knowledge index job is retained without processing during preparation. Revoke one human write grant, retain read-only mode and remove another principal. Logout active business sessions, positively stop, backup and verify. Build/register/promote target normally; prepare shows schema1→2 source/target identity and preserved grant/receipt/job facts. Refuse incompatible target or unknown source without source mutation. Activate, explicitly restart same instance on target; prove retained records/index/citations, revoked write still denied, removed principal absent, original command replay produces no duplicate, queued job retains its original id/payload and completes under normal authority, Handoff old target/receipt still exact. Make one new target-version business write, positively stop and create target-generation backup; same-generation restart/recovery still works. Inspect old source artifact/data/backup unchanged by preparation. One known target migration failure before cutover leaves old source restartable; no wide fault campaign.

Freeze candidate; fresh build/focused, actual ordinary Chrome flow, complete npm test with original close and unchanged hashes, independent Sol review. Name justified EPERM skips and blocked browser/native/provider/production scopes. One archived full manifest plus bounded logs/execution/operation facts suffice; no new evidence system. Do not duplicate the earlier full builder/Entity/extension campaigns.

## Rollback and choices

Before activation the source remains active metadata and its untouched data can restart only after the original preparation owner has positively closed/cleanly settled its reservation. After activation, old directory retained is not a user-visible automatic rollback feature. Once target roles launch, target may write even before the first human command; therefore this increment never automatically flips back. New-version writes are never merged into old data or silently discarded. Explicit downgrade/export/rollback and multi-hop upgrades are later contracts. Failure with missing native/publication proof remains UNKNOWN; independent reopen cannot manufacture release.

No human clarification blocks this narrow local proposal: additive reviewed Desk migration, no new grants, logout-all prerequisite, same provider target, one upgrade and no automatic rollback are conservative choices within authorized core scope. A requested changed business schema, binding/owner change, downtime guarantee, automatic post-write rollback or production environment would require a new explicit outcome decision. Re-inspect and refine the provisional paths/versions against accepted construction; do not adopt during its ongoing source work.