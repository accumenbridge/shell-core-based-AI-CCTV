# PLATFORM-003 — immutable local artifact registry and release promotion

Status: ACCEPTED_FOR_ACCESSIBLE_LOCAL_SCOPE; qualification PARTIAL_WITH_BLOCKED_FIXTURE_GATES. Exact maintained fingerprint f24b79b931ccc61d9e86124df26e1f6f1064859530deb422f9e0bc466911eca4/175 files; source/profile Git tree358e13d27c5d307cde21e0fc10ed606320cf827c (not commit/Brain snapshot), baseCP2 tree d1d645ed13768b182d37dd1757d78913bccc6cd7. Fresh build0, targeted13/11pass/2skip, full/verifier195/193pass/2skip, zero fail/cancel/TODO. Ordinary Chrome11 assertions/server0/closed observed. Sol/high independently approved static and matching execution evidence; root matched exact source before and after browser. Native helper deadline BLOCKED_COMMAND_POLICY/NOT_RUN, file-symlink EPERM BLOCKED_ENV and historical controlled-delay CSP remain separate. Actual result: .brain/evidence/platform-003-result.json; failures preserved in review notes. Root owns Brain; Luna/xhigh sole application writer. PLATFORM-004 bounded contract is next under existing local authorization.

## Journey and owners

Select a successful verified build → register its exact snapshot → retrieve verified artifact metadata/files → promote that artifact as an immutable product release. Promotion does not execute a runtime or alter deployment state.

Owners: packages/control-plane store and package-local helpers; apps/control-plane artifact-store adapter/operator server; apps/studio-web; existing composition integrity helper; relevant tests and status documents. Preserve packages/domain/product boundaries. Root alone writes shared Brain records; Luna/xhigh implements, Sol/high reviews.

## Identity and migration

Additive transactional schema3; preserve all legacy values, CP2 UUID snapshots/build references and domain databases. No implicit import, fabricated records or authority reseeding. Reject future schemas before changes.

Artifact key is the existing full snapshotDigest, which includes build provenance. It is exact snapshot identity, not payload-only cross-build deduplication. Immutable records bind originating build, product/version, frozen input/release digests, relative storage reference, bounded size/file count and original actor. API excludes absolute paths and worker secrets.

Registration accepts build ID only. Require SUCCEEDED with frozen inputs and a physical owned snapshot whose complete inventory verifies against durable digest evidence. No legacy successful row becomes qualified through admission alone.

## Publication and recovery

One local adapter owns fixed .local/platform-artifacts/objects/<digest> and private operation staging. Reject linked/special-file ancestors, unsafe normalized names and case collisions. Copy by value to unique owned staging, verify the copy, then atomically publish without overwrite. Existing destination must verify exactly; disagreement is corruption/conflict.

After full verification, commit registration/build link/audit synchronously with original identity. Filesystem and SQLite are separate effects: interrupted publication or transaction failure may leave unadvertised objects. Retain them; subsequent explicit registration may adopt only after complete verification. Never delete a published object as compensation for a failed database write because another registration may reference it.

## Promotion, retrieval and retention

ProductId@version identifies one immutable promoted release. Exact repeated artifact returns the original without duplicate audit; another digest conflicts. Verify before promotion and recheck original session after every awaited preparation immediately before mutation.

Fixed authenticated routes return metadata/manifest/verified inventory-file bytes. Inputs cannot supply filesystem paths, executable URLs, commands or environment settings. Downloads use attachment and nosniff; exported HTML/JS never runs in operator origin. Reverify against durable identity before retrieval and reject tampering.

First local profile retains registered artifacts/promoted releases indefinitely. No purge or mutable channel pointer. Explicit capacity limits must be checked before publication and failures reported. Clean only known completed unpublished operation staging; uncertain material remains quarantined.

## Required evidence

- Real CP2 snapshot registration, database reopen, exact-byte retrieval and immutable promotion.
- Equal repetition without duplicate audit; conflicting release identity without mutation.
- Failed/legacy build, mismatched identity, tampering, missing files, links and unsafe names denied.
- Concurrent registration/interrupted publication/database failure cannot overwrite or falsely advertise success.
- Logout/expiry during preparation cannot commit registration/promotion; all legacy-table values preserved.
- Fresh build, relevant targeted tests, npm test, verifier, installed-browser journey and independent exact-candidate review.

Local registry qualification does not establish runtime, hosted identity, provider or production acceptance. No external repositories, credentials, global configuration, spending or deployment is authorized by this increment.

## Accepted implementation refinements

Sol/high review refined publication to a fixed reviewed Windows helper using MoveFileExW without REPLACE_EXISTING/COPY_ALLOWED/DELAY_UNTIL_REBOOT (flags0). Same-volume owned staging only; fail unavailable instead of a fallback. Existing empty/nonempty directory, file or link is never replaced. Use the explicitly selected private PS7 host through normal -File preflight; registry reads/verification do not require compiler availability. Microsoft API semantics checked at https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw; no power-loss durability guarantee is inferred.

Capture originating build actor, registering actor and promoting actor separately. Every operation uses its initiating session, checked after each awaited preparation and inside the final synchronous transaction after BEGIN acquires its lock. No awaited callback, replacement actor or admission-only legacy proof.

Persist unique operation intent, expected frozen identity, staging reference and original owner token before physical mutation. A registry-only durable singleton physical-operation slot serializes copying/publication across operator processes; it is not an expiring lease or general job system. Unknown/interrupted ownership retains its full reservation and blocks new physical preparation. Restart/time/PID existence never proves old activity ended. A fresh explicit metadata-only adoption of an existing completely verified orphan may proceed without freeing an uncertain prior slot/reservation. Preserve intent history and all published objects. Only positively observed current-owner completion permits physical slot reconciliation. Closing waits owned operations/helper or truthfully retains UNKNOWN. Registration/audit/session failure after publication never deletes the published object.

Fixed local limits:8MiB per file;64MiB per artifact including manifest;4096 files including manifest;2MiB manifest;128MiB staging;512MiB total registry physical bytes;256 object directories. Count registered/unregistered/quarantined material and unresolved full reservations conservatively. Bound traversal/metadata buffers before hashing/JSON parse; enforce admission/reservation transactionally, fail closed on unsafe/unknown filesystem entries. Browser input cannot change limits. Lower trusted test limits may exercise capacity behavior without allocating excessive fixtures.

Sol/high refined the bounded local scan profile:16384 total metadata entries (files and directories, including empty directories), depth32, incremental directory buffers32 and2000ms monotonic scan budget. Close handles in finally; count existing staging in aggregate bytes. These independent profile limits may reject combinations below the other size/count maxima and must be disclosed. A budget check cannot preempt one stalled synchronous OS call; no hard responsiveness guarantee follows. Obtain fresh physical observation after BEGIN, reject async/thenable observers and recheck the original session again after scanning immediately before reservation/adoption writes. Full content hashing remains outside SQLite transactions.

Download selectors are opaque deterministic inventory-entry identities derived from registered manifest; no request-supplied filesystem path. Send exact rehashed bounded bytes as application/octet-stream with Content-Disposition attachment, nosniff and no-store; recheck session immediately before response. Registry registration/retrieval/promote reads persisted CP2 evidence through pure integrity and safe snapshot lookup, independent of LocalBuildWorker.create and compiler readiness. Deployment stays admission-only.

Meaningful tests include real CP2 export/register/reopen/download/promote; exact duplicate and release conflict; changed/failed/legacy/tampered builds; links/path/case hazards; true no-overwrite empty/nonempty/file destinations; concurrent same/different requests and capacity reservation; interruption immediately before/after publication; final transaction/audit/logout failure retains object; restart classification and explicit verified adoption; session expiry during preparation and real SQLite lock wait; HTML/JS remains attachment; unavailable compiler with existing verified artifacts. Browser ordinary permitted journey only; existing CSP gate remains blocked, no evaluation retry.

Sol/high fact refinement adopted during source review: record MOVE_OBSERVED synchronously immediately after the fixed publisher proves MOVED and closes, before destination verification. Monotonic destination_verified/staging_clean facts start0; set only after full bounded identity verification and positively observed owned staging cleanup after helper close. UNKNOWN preserves known move/facts. Physical reservation settlement and final registration require exact original owner/token and both positive facts; move proof alone cannot free a reservation or advertise an artifact. Preserve all existing development schema3 rows through additive migration if these columns were not present. Fact audit uses the persisted initiating/registering actor. Tests must separate moved-but-unverified, verified-but-cleanup-unknown and verified-clean cases.

## Final Sol/high seams and fixed routes

Schema3 owns artifact_operations (initiating/originating actors, captured expected identity, publication recipe/host identity, private owner token, staging reference, reservation/state/observed facts), artifact_registry_state singleton, immutable artifacts, artifact_build_links and releases(productId,version) with promoting actor. Never expose private ownership/absolute paths. No schema change in another domain database.

App-local artifact-store.ts owns storage; a narrow shared snapshot lookup helper reuses persisted CP2 and pure integrity without constructing a compiler worker. Fixed tools/registry-publish.ps1 is explicitly excluded from the build/export reviewed input closure, since it is registry operational authority. Its reviewed publication identity remains pinned in registry operations. No exported framework source authority is changed.

Routes: GET /platform-api/artifacts; POST /platform-api/artifacts/register {confirm:true,buildId}; GET /platform-api/artifacts/<digest>; GET .../<digest>/manifest; GET .../<digest>/entries/<opaqueEntryId>; GET /platform-api/releases; POST /platform-api/releases {confirm:true,productId,version,artifactDigest}. All existing paired Host/Origin/session/body/security rules apply. UI shows exact identity, capacity and pending/UNKNOWN records with precise registration/promotion confirmation, inspection and bounded download; no runtime/purge/channel control.

Idempotence clarification from Sol/high: equal repetition applies to external registration/promotion. The original publication owner can reconcile a matching artifact adopted by another actor once, preserving the adopter's immutable attribution/audit and clearing only its own reservation. Repeating a low-level terminal completion is not an exposed operation or promised recovery mechanism. Qualification should exercise the single original reconciliation plus subsequent explicit external repetition.

## Validation exception — command policy and filesystem permission

Sol/high approves a narrow test-only safe exclusion for this environment. The standalone file-lock helper verification command was denied generically by automatic command policy, recorded in platform-003-helper-command-policy-blocked.json; no reason component and no override. Do not reroute it through Node. Extract only that native lock-cleanup case into a named default-enabled test. A process-local test sentinel QB_TEST_CP3_NATIVE_LOCK=blocked-policy skips before fixture/helper launch, with explicit BLOCKED_POLICY reason. Default unset retains the real case. This does not alter registry/security/API/host/verifier behavior. The bounded20s helper deadline remains NOT_RUN/BLOCKED. Earlier candidate04 actual cleanup proof is historical support only, never proof of the new deadline; unchanged application/publisher identity must be established before attributing it to later source.

Extract file-symlink permission failure into a separately named BLOCKED_ENV/TAP skip for observed EPERM/unsupported creation; no host privilege/developer-mode change and no catch-error-as-pass. A junction success would be separate physical coverage, never convert file-link permission denial into pass.

CP3 acceptance is ACCEPTED_FOR_ACCESSIBLE_LOCAL_SCOPE / PARTIAL_WITH_BLOCKED_FIXTURE_GATES after fresh unchanged-candidate build/npm test/verifier, ordinary permitted Chrome and independent exact-candidate review, with actual passed/skipped counts and zero failed/cancelled/TODO. Verifier semantics are unchanged; complete native failure qualification and production remain unqualified. Accessible checks exclude the denied helper, rather than executing it through another route. Historical candidate04 native cleanup supports unchanged publication source only; it never qualifies the new deadline helper.
