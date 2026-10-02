# Studio integration 1

## Kernel reliability and CI configuration

The repository's repeatable CI baseline is Node 24.19.0 (`.nvmrc`). `npm test` builds from source and
runs the complete discovered test-file set serially while preserving concurrency inside each file. The
native build-worker test reports bounded pre-cleanup attempt, marker and redacted-output facts if its
owned descendant heartbeat fails to appear. The earlier marker-wait failure remains undiagnosed; serial
file scheduling and diagnostics do not retroactively establish its cause.

The pinned automatic workflow runs the portable suite on Ubuntu. A separate manually dispatched Windows
workflow first selects PowerShell 7 and runs the unchanged ordinary `-File` policy preflight; an
unsupported profile fails visibly as `BLOCKED_HOST_PROFILE` before native tests. It does not override
policy. Portable summaries mark Windows native CI `NOT_QUALIFIED` and retain named skip counts. Only the
host/test summaries and test TAP are uploaded; the private build-host profile and executable path are
not workflow artifacts. Workflow configuration does not itself establish a hosted result. See [CI.md](CI.md).

## Platform-003 local artifact registry

The paired operator now has an immutable local artifact journey in addition to the Platform-002 build flow: a verified snapshot can be registered by its exact digest, inspected and downloaded as bounded attachment bytes, then promoted once for a product version. Publication uses a private same-volume staging directory and the fixed no-overwrite Windows publisher. A local registry reservation survives operator restart; interrupted or uncertain work remains visible and blocks another physical publication until positively observed original-owner completion. A separate metadata-only adoption can record a completely verified orphan while retaining the older uncertain reservation. Schema-3 migration adds registry facts without rewriting legacy product, build, environment, deployment, AI or audit values. Registry read and promotion remain available when the local compiler host is unavailable.

The selected Windows publication host is the ignored, machine-specific `.local/platform-build-host.json` (`quadbridge.local-build-host.v1`). It pins an executable path, SHA-256, version and observed policy. The executable is checked with the normal `-File` preflight; there is no policy override or fallback. Missing host/helper makes new physical publication unavailable while existing verified artifacts remain readable and promotable. The local registry is not a runtime, provider, deployment or production release system.

Registry limits are 8 MiB per file, 64 MiB per artifact, 4096 files, 2 MiB per manifest, 128 MiB for staging, 512 MiB total physical registry material and 256 object directories. The independent metadata scan limit is 16384 entries including empty directories, depth 32, directory read buffers of 32 and a 2000 ms monotonic budget. These bounds can reject combinations below the byte/file ceilings; a budget check cannot interrupt one stalled filesystem call. Unknown physical state is retained rather than inferred from age or process identifiers. Downloads are reverified against the registered inventory and served as `application/octet-stream` attachments with `nosniff` and `no-store`; the current canonical export contains no HTML entry.

Platform-003 provides the accepted local artifact-registry scope. Its limits and retained uncertainty behavior are described above; prior Platform-002 and Foundation-0.2 claims below remain historical.

## Platform-004 managed local runtime

The paired console has a separate runtime control plane after local artifact promotion. A start binds to one exact promoted product/version and full snapshot digest, creates private per-instance enrollment once, then supervises the immutable web role and any selected separate worker through the fixed Windows Job Object helper. API health, worker readiness and domain workflow are separate facts. A runtime is `STOPPED` only after nonce-bound native `EMPTY` proof, matching helper close and verified owned-execution cleanup. Missing proof retains an `UNKNOWN` owner, its non-expiring slot and files; a reopened console never uses saved PIDs to infer or control old processes. Data remains bound to the exact instance/artifact and completed stores are not reseeded, so principal deletion and grant revocation survive restart.

Runtime routes provide paired local controls for listing, inspection, bounded structured events, starting an exact promoted release, stopping, and restarting the same positively stopped identity. Every awaited authorization stage rechecks the original session and actor; logout denies later mutations while the original owner still performs permitted physical cleanup. The selected local profile starts web/backend first and a separate worker only when required. Incomplete enrollment is repair-required; uncertain physical ownership is not auto-repaired. Every derived Windows path must remain below 240 characters; the registered snapshot plus fixed helper/log overhead has a 128 MiB execution-area ceiling.

The current local evidence includes real Service Desk and Combined execution, a two-operator browser control journey, canonical enrollment interruption before its completion marker, and a new checkout build while an older registered Service Desk runtime remains live. These checks qualify this selected local profile only. Connected HTTP bindings, deployment execution, providers, hosted releases, production identity and fleet management remain out of scope. One earlier real restart response returned 503 and remains unexplained; a separate browser fixture also had a pre-publication registration abort that a later successful fixture did not diagnose. Candidate-specific raw evidence is kept with the Platform-004 task; those historical failures are not treated as repaired.

## Platform-005A private runtime recovery

The paired Runtime view can create a private backup from a positively stopped instance, verify its immutable identity and complete owner-database inventory, and restore it to the same instance only when the canonical data root is wholly absent. The fixed local driver uses SQLite's online backup API and normalizes only its newly owned backup copies; it does not migrate databases, open canonical owners, reseed users or grants, or modify the stopped source databases. Backup capture includes committed WAL data, and restore preserves the captured enrollment files and owner databases. The user starts the restored instance explicitly.

The native Service Desk journey exercised logout, a committed request written while a read-only observer held an older SQLite view, positive stop, post-stop grant revocation, backup, verification, restoration to an absent test-owned root, restart, and read/write authorization checks. The restored record remained readable while the revoked create permission remained denied. This is local recovery evidence for the selected profile; hosted backup, remote retention, cross-artifact migration, and production disaster recovery remain out of scope.

## Platform-006 bounded Knowledge answers

Knowledge exposes `knowledge.document.retrieve.v1` and `POST /api/documents/answer` over its existing owner database and read permission. It retrieves only indexed `READY` records in the request tenant, sends only bounded opaque excerpt IDs and text across the neutral ai-core provider seam, and constructs citations itself after rechecking exact document version, body digest and UTF-16 range. The Studio workspace labels output **Local extractive answer**, identifies indexed-only coverage and lets the user cancel an individual answer request. No model inference, answer database or durable answer job is attached. Question size is limited to 1000 characters, selection to five records, excerpts to 16 KiB, answer text to 8 KiB, provider time to five seconds and actual in-flight calls to four; cancellation retains a slot until its provider settles.

Knowledge and Handoff source package/product versions advance together to 0.2.1 while their existing schema generations remain unchanged. Handoff's required document-read contract is unchanged. Factory export and release verification derive exact local package closure from the selected package manifests, so selected Knowledge releases include ai-core 0.3.0 and older snapshots continue to be checked against their captured manifests. Provider, hosted retrieval, production inference and tenant-crossing results remain out of scope.

## Bounded entity source builder

The factory can generate a new module from `quadbridge.entity-spec.v1`. It emits ordinary owner source,
module metadata, a private table migration, four fixed receipt-aware operations/routes, and a complete
list/detail/create/edit workspace. The spec supports only bounded text, safe integers, booleans and enums;
generation is exclusive-create and records hashes for its inputs and outputs. The two maintained examples
are Asset Register and Room Inspection. Their products are composed and built through the normal
source-derived catalogue; generator output does not bypass artifact registration, promotion, or runtime
controls. Existing data is never reseeded, overwritten, or upgraded by this builder. See
[`ENTITY_BUILDER.md`](ENTITY_BUILDER.md) for the supported profile and deferred domain capabilities.

## Current local platform construction status

Platform-007 adds a complete ProductDefinition editor to the paired Products view and standalone offline
Studio. The full bounded JSON remains authoritative across import, saved-version load, edits, preview,
save and export; convenience fields update the same definition. Source-derived diagnostics preserve
unsupported text and block save/build. The paired operator reads and previews exact definitions without
mutation, then saves immutable `id@version` records under explicit confirmation. Offline import/preview/
export remains data-only and makes no network or source-tree changes. See `docs/STUDIO_INTEGRATION.md` for
the exact behavior and limits; candidate-specific checks and browser results belong in the canonical
Platform-007 evidence record.

Platform-002 adds an end-to-end paired local product journey: canonical preview, immutable save,
durable build admission, fixed compilation and factory assembly, complete local-export integrity
inspection, and bounded cancellation. The build executor is local-only and requires the ignored,
machine-specific `.local/platform-build-host.json` profile (`quadbridge.local-build-host.v1`) plus
the pinned compiler toolchain. A missing or unsupported host leaves the paired console available
while build admission reports unavailable. The previously attempted Windows PowerShell 5.1 host
is blocked by its effective policy; no policy override or fallback is used. Exports are verified
local artifacts, not deployed releases. Deployment requests remain admission-only.

V01/V02 and the local definition-to-build-to-launch workflow are implemented. Read STUDIO_INTEGRATION.md and the current evidence before using these developer tools. The following table retains the Foundation 0.2 scope; broader production/React/rolling-release limitations remain.

# Visual-edition status

The entry page is now a self-contained visual studio, not the documentation reader. It has seven interactive views. Composer definitions are real supported source configuration; screen records and handoff animations are explicitly sample-only. Actual application styles and presentation were updated separately without changing backend contracts or owners.

124 local automated tests passed after rebuilding. Browser navigation was blocked before any visual assertion. See `evidence/visual-preview.json`. This does not establish browser, React or production qualification.

---

# Implementation and acceptance — Foundation 0.2

**Local developer preview / framework stabilization.** This fixes R01–R10 without adding unrelated capability families or changing Veyviz. It is not a stable universal SDK or a production profile.

| Area | Actual status |
|---|---|
| Neutral backend/Web/worker construction | Implemented; original local startup/generator/export tests retained |
| Scope-bound Web requests, refresh recovery and named exports | Corrected; actual compiled shell through controlled document/event/request ports, not real browser |
| Multi-file frontend closure | Implemented native-ESM profile; helpers/lazy chunks/assets/hash checks and actual HTTP responses tested |
| Local/HTTP cross-product receipt protocol | Explicit v2 with destination product/instance/service actor/tenant/original-key validation; real local HTTP tested |
| External outcome versus job state | Durable separate facts; revocation/cancellation/lease expiry/restart/exhaustion cases tested |
| Explicit receipt reconciliation | Lookup only, separately authorized; source adoption passes normal owner command |
| Legacy Handoff data | Migration preserves v1 data; no automatic cross-version resend; manual original-protocol reconciliation remains |
| Scheduling | Module round-robin and bounded advancing tenant/job cursors tested; no wall-clock latency guarantee |
| Provider construction | Local binding dependencies/cycles checked |
| Storage replacement seam | Neutral worker execution port; independent ephemeral conformance store with SQLite physically absent; sync and async cases |
| SQLite/access runtime profile | Real local adapter remains; not a hosted production default |
| Four reference products | Neutral, Service Desk (two workspaces), Knowledge and Combined; small acceptance consumers |
| Framework version isolation | Actual 0.1/0.2 separate local neutral instances tested; not published-version rollout |
| Browser acceptance | Attempted; four APIs ready, Chromium navigation blocked, zero browser assertions executed |
| Actual React/ReactDOM and third-party UI bundler | Not implemented/qualified by this native-ESM closure; renderer adapter exists |
| Production OIDC/Nest/database/security/fleet | Not implemented or qualified |
| Notifications, object storage, AI/RAG/video | Optional future families, not implemented here |
| Foundation 0.2 backup/restore, signing, HA, destructive uninstall/purge | Not part of that historical profile; local same-instance runtime recovery is described under Platform-005A |
| Veyviz migration/tenant/camera/deployment changes | None |

The full suite reports 116 passes; compiled-only has 98 of those tests. Source fingerprint and logs are in `evidence/`. These counts are not a completion percentage. No inherited Veyviz acceptance criterion is promoted by these different reference applications.

## Next bounded work

Run the actual browser suite in a permitted environment and implement one real React/bundler consumer adapter. Then select one production identity/persistence/execution profile and prove independently adopted package versions. Do not add new domain concepts to neutral packages or build every provider in advance.
