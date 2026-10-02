# SAFE-UPGRADE-001 repaired pre-native source clearance02

Reviewer `/root/repo_brain_architect` (Sol/high), independent of maintained implementer `/root/repo_brain_validation`. Read-only source/evidence review. No builds, tests, native/runtime/browser operations or maintained/shared Brain changes were performed. This note preserves final-source-review01 and its exact discovery05 findings as historical.

## Exact current binding

Candidate `1a0163b412a09070fbb2a90a6cdb401d2ce87df20060129077e8b0dbf49fd361`,251files; raw contract `3dcb39e18df060243ec6b10af6bd27289e30a796c1a82c5d98ecf3b074606716`. Inspected `.local/safe-upgrade-001/build-bootstrap-06-candidate.json` and focused-bootstrap-01-candidate.json. All251 physical hashes match before and after inspection, zero mismatches. Independent aggregate sorted-path/hash recomputation matches candidate; raw current contract hash matches. Exactly five paths differ from discovery05; the other246 hashes are unchanged:

| Changed file | Current SHA256 |
|---|---|
| apps/control-plane/src/operator-server.ts | 39b3af5ab77f7063d7b4e77a57d0838c2900731f39b21a10f22459e7cee9fb71 |
| apps/control-plane/src/runtime-upgrade.ts | de5e3f78a9e0e8acd88701a57397465db9f9c2bb075a2d20bae922d50954b48d |
| apps/studio-web/src/main.ts | 4bde905053ef7b2ccbeb46af6dd7d688ba6c7515c718235230cf0f2f46fd2730 |
| tests/runtime-upgrade.test.mjs | 8498598365b6a8c7780069cbfda73a2306bceef8b8cffe6fe60394285ff1f250 |
| tests/studio-runtime-ui.test.mjs | ad69c1f229b9a9ab673a5f6688e283da5f53740cbe58246f26f57e70c84dba6f |

Unchanged core pins: runtime-manager `2a4236cc997ea79c19e0375ab0503a0b0e259257cfa4156f8350ebfb62cb3563`; runtime-recovery `9b0e75ef120e3d25bdc02572c07e2d2fab2ec96a4b9126ec2e5ecbab9665e0a8`; upgrade driver `216c516f525d95c6c17b5c77d7a6d7e578358c3e51fa329d5763fc120d709825`; recovery driver `050cd8aaceee85709f9f8e0def5d5256ca00e94af70083aed820a29443f72be4`; publisher `edfc065d234885678d252e9bd13ebd2bef9814353335671fac662b243cddf57f`. Their eight-repair component review03 remains applicable; the current upgrade manager only changes eager native capture to effect-time capture for this refinement.

## Three source01 findings repaired

1. **Ordinary bootstrap remains available without selected native readiness.** Upgrade constructor still reads bounded physical fixed tool bytes and rejects mismatched driver/publisher pins; it no longer captures the Windows host eagerly. Read-only generation/history remains attached. New effect admission captures and validates the actual recovery native host before beginManagedRuntimeUpgrade, then revalidates helper/tool pins and selected host before native dispatch and publication. No generic unavailable catch silently converts source corruption into readiness. The new focused test constructs the real upgrade manager with a recovery host accessor that would throw and proves history remains available; it is a component test, not an actual Linux deployment/full bootstrap execution.
2. **Actual flat-list/detail integration is used.** runtimeDetailMatches now includes ID, currentAttempt, artifact, version and state. runtimeEvidenceInstance supplies only absent activeGenerationId/attempts from that matched inspected detail, preserving contradictory present summary facts. View generation selection, UPGRADE_READY proof, generation display and Upgrade click/current-source guard use this evidence. Real summary/history request identities remain separately fenced. The revised controlled compiled-UI regression explicitly removes activeGenerationId/attempts from source and target overview rows, resolves source and target detail separately, verifies exact backup/confirmation, and proves separate explicit target Restart. It no longer treats detail as the list DTO. Original session/navigation/request sequence checks and clear-on-session behavior remain intact.
3. **START and upgrade DTOs have their correct routes.** Ordinary START now sends its original runtime command result directly. Plural upgrade POST, generation/history GET and operation GET retain private-field stripping and actual0/1-to-boolean conversion. Singular alias remains404. Strict confirmation and current-source/backup/target selection checks remain; no boolean proof was weakened to truthiness in the UI.

**PRE_NATIVE_SOURCE_AND_FOCUSED_CLEAR** for this exact251 candidate. No remaining concrete core blocker was found within this bounded complete-source/wiring re-review. This clears the source checkpoint for root's explicit reconciliation/freeze and the adopted actual retained-fixture journey. It is not final task acceptance or native execution qualification.

## Actual saved compilation/focused evidence

- build-bootstrap-06-execution.json SHA256 `19215df99f241be5efbf86e13687966ae97e524b8942af2c8e13e87f4e69fa93`: original npm run build observed exit0/null signal,19:06:23.115Z–19:06:25.669Z, candidate/contract before and after equal current tuple. Raw build log SHA256 `00af2a7e9e6323044f8f2986b1cb9bc7f72d7b02db3faa4c8eab5260dfb97c83`. The raw log has ordinary build output; exit is recorded by the saved observer metadata rather than a fabricated raw exit marker.
- focused-bootstrap-01-execution.json SHA256 `b9324e44f36b9d4a12aa955e779a2777e1d71fee20fe9f955550d5e0258151dd`: original fixed nine-file Node test invocation observed exit0/null signal,19:06:31.600Z–19:06:43.758Z, current tuple unchanged. Complete TAP summary64tests/64pass/0fail/0cancel/0skip/0TODO; raw log SHA256 `65b433ad5e1079d56a881de9285d04a9d398182b275e87cc0d00733094afe309`.

These are independently inspected saved original invocation records, not execution by the reviewer. Focused scope includes real SQLite store transitions/backfill and paired HTTP transport with manager doubles, real upgrade-manager construction with a host double, and controlled compiled UI. It does not include an actual target migration Job, fixed no-replace publisher, restored target worker or ordinary Chrome journey.

## Preserved whole-source boundaries

Earlier review01's unchanged source assessments remain valid: main observes upgrade/runtime close before HTTP drain and retains dependencies on unresolved owners; initializationOnly closes constructed canonical owners while refusing startup hooks/HTTP/worker/business dispatch, with default startup behavior preserved; schema6 immutable generations and historical attempt/recovery/backup lineage use reciprocal slots; Desk1 SQL is unchanged and owner-local migration2 plus explicit public projections preserve current receipt shape. Desk0.2.2/Combined0.2.4, runtime dependency and lock agree; Knowledge/Handoff0.2.3 and neutral versions are preserved. Exact operational helper exclusions/private fixed copies retain source authority and offline privilege limits. Documentation distinguishes explicit migration/cutover from separate Restart, retained source material, no auto rollback and local-only coverage.

Root operational helper migrated-observer-preparation-review03 binds HTTP booleans and exact separate build/upgrade actor lineage at helper SHA256 `521adf08485f2a8476ed97ebe687113523aecf1975a3528acaf60e18644e3762`; raw SQL proof remains numeric1. Other prior ignored-helper preparation reviews remain conditional on their own exact bytes. None supplies a fabricated execution fact.

Actual native/browser/source-owner retention/pending-job continuity/target recovery and completed ordinary npm test remain pending. Historical failed focused runs and prior source findings remain retained. No provider, hosted, customer production, device or general migration/rollback qualification is claimed.
