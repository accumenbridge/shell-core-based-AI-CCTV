# Studio integration 1 — V01/V02 and the new-product journey

## Status

Implemented on the supplied Visual Edition / Foundation 0.2. The local developer scope is retained.
Framework/module versions remain 0.2.0; this is a separately identified Studio source increment, not a
new published ABI compatibility promise. Exact built files remain covered by the release fingerprints.
The previous archive is unchanged.

## What changed and why

| Review area | Actual implementation |
|---|---|
| V01 custom names could not complete handoffs | `profiles/local-developer.json` declares the reviewed local fixtures. `tools/local-profile.mjs` applies provider seeds by their supplied public contracts and builds local/HTTP bindings without product-name branches. `demo.mjs` reuses existing access stores without reseeding rights. |
| V02 fixed visual catalogue | `tools/studio-catalogue.mjs` reads actual manifests/products/solutions. `packages/composition/src/studio.ts` expands selected declared dependencies and binding choices, then calls the existing canonical resolver. The browser embeds that compiled code, not a second resolver implementation. |
| Definition-to-running-application gap | The paired operator saves and builds a reviewed product, registers its exact verified snapshot, and promotes an immutable product-version release. The separate Runtime view starts only that promoted snapshot under the fixed local supervisor; the older demo launcher remains a separate adapter. |
| Unclear dependency consequences | Composer lists explicitly chosen and automatically required modules, their exact versions, selected local/connected bindings and prerequisites. Missing/ambiguous wiring is rejected. |
| Manual document IDs and raw state presentation | Handoff options use a Knowledge-owned public metadata query and solution-owned prerequisite inspection. Runtime displays readable acceptance, execution and workflow separately. No private cross-store read or replacement business service. |
| Generic architecture page | Product selector reads the same resolved plan to show its module construction order, public bindings and optional worker requirement. This is not measured runtime tracing. |
| Small essential text | Form labels, status/error text and core instructions are enlarged while retaining the visual design. Keyboard/viewport acceptance remains separately identified. |

The offline examples and the actual product workspaces remain distinct adapters/experiences. Sample data
is still explicitly labelled; full presentation-component convergence is not claimed in this increment.

## What the local Studio can and cannot do

It may write one validated `product.json` to a NEW product directory, run the fixed compiler/build/export
commands, register and promote an exact verified local snapshot, then start that promoted snapshot and
stop its owned process tree. The runtime binds product/version, complete artifact digest, local profile,
configuration and instance identity before dispatch. It accepts no client executable, argument, path,
port, environment or secret. It never overwrites a product source, edits a module, installs a dependency,
modifies customer grants or exposes arbitrary filesystem reads.

The developer must review source modules before building/launching them. These are trusted local
modules, not an untrusted plugin sandbox. A local build executes maintained tool code and a launched
module executes reviewed application code under the developer's OS account. The pairing code is a
privilege boundary for browser access; it is not production identity or OS-level isolation.

Authentication is an ephemeral terminal pairing code with a bounded login rate, expiring HttpOnly
SameSite session and exact Origin/Host enforcement. Each awaited runtime authorization stage rechecks
the original paired session; logout prevents later admission, enrollment, launch and readiness claims.
No wildcard CORS or remotely bound listener is provided. The environment's ordinary browser controls
must remain enabled. Secrets are generated under `.local`; browser catalogue, runtime status and event
responses contain neither credential values nor private filesystem paths.

One Studio process owns the source editor and compiler worker for a checkout. Registry publication and
managed-runtime execution use separate durable SQLite reservations across operator processes, so an
uncertain physical publisher or runtime keeps its slot until its original owner proves completion.
Managed applications run copied, verified snapshots and can remain running while a later checkout
version is built; that build does not replace or promote the running instance.

## Lifecycle meanings

| State | What it proves |
|---|---|
| Validated definition | Known manifests, versions and reviewed wiring resolve. No source/runtime change. |
| Source saved | A new product definition exists. No application is running. |
| Building | The fixed source build is executing; partial output is not launch acceptance. |
| Built | The command completed and an exported runtime snapshot exists. No workflow qualification. |
| Starting | A durable operation owns the single runtime slot and a suspended native supervisor. Enrollment and launch each require a fresh decision from the captured session. |
| Running / API ready | The fixed supervisor verified the loopback health response, the web process remains owned, and a selected worker has separately reported ready. Domain workflow still needs its own proof. |
| Stopped | The exact owner observed the nonce-matched native `EMPTY` proof and helper close, then verified its execution cleanup. Bound data remains in place. |
| Unknown | Process-tree exit or cleanup was not fully proven. The durable slot and uncertain files remain reserved; reopening the operator does not infer exit or act on a stored PID. |
| Repair required | Enrollment/configuration is partial or inconsistent. It is not reseeded automatically and no role is launched. |

The same promoted artifact and instance use the same bound local data root on restart. A different
artifact gets a different data root; a stopped instance cannot be silently rebound to a new release.
Canonical local enrollment runs once before either role launches. Later restarts reuse the existing
access and module databases, so removal of a principal or grant revocation persists; the initial seed
set is not reapplied. Private generated credentials remain under `.local/platform-runtime-data/` and are
not returned in Studio API responses. `STOPPED` requires nonce-bound native `EMPTY`, matching helper
close and verified execution cleanup. If ownership or cleanup is uncertain, the durable slot and runtime
files remain reserved as `UNKNOWN`; reopening Studio does not infer process exit or act on saved PIDs.
For a positively stopped runtime, the paired console can create a private backup, verify its exact
instance/artifact binding and owner-database inventory, and restore only to the same instance when its
canonical data root is wholly absent. Backup uses SQLite's online backup API to include committed WAL
contents, then verifies owner identities and contiguous migration history. Recovery does not construct
canonical owners, migrate schemas, or reseed principals/grants. The restored instance still requires an
explicit restart; recovery metadata is paired and local, while database bytes, credentials and private
paths remain undisclosed. This is same-instance local recovery, not cross-artifact migration, remote
backup retention or a fleet release procedure. Build and runtime command records are saved locally.
Closing Studio signals only process trees owned by that process.
Every derived Windows path must remain below 240 characters; the registered snapshot plus fixed
helper/log overhead is limited to 128 MiB in the runtime execution area.

## Complete product definitions

The Products view edits the complete ProductDefinition as bounded data. It can import a `product.json`,
load an exact saved version, edit its identity/description/version/layout/modules/bindings/wiring, preview
the resolved source graph and export the exact validated definition. A composition starter is only a
starting point; it does not silently become a saved product. The shared composition helper checks exact
manifest versions and reviewed adapter choices while retaining product-owned binding instance IDs.
Unsupported or malformed declarations remain visible in the editor and block preview/save/build. A valid
HTTP binding describes a product definition; it does not make that product locally launchable.

The paired operator exposes an exact version read and a read-only preview. Saving requires confirmation
for the exact `id@version`; identical content is idempotent, conflicting content at an existing version is
rejected, and another version is a deliberate choice. The subsequent local build consumes the stored
definition through the same canonical resolver. The offline visual editor uses those same pure parsing,
validation and serialization helpers for bounded file import, edit, preview and download. Its preview
does not contact a server or write source files.

## Connected-mode limit

The visual definition supports the reference solution's reviewed local/connected bindings. It does not
invent a credential, select an arbitrary destination or give one product rights in another. The managed
launcher reports `CONNECTED_SETUP_REQUIRED` for HTTP bindings rather than starting a misleading partial
solution. The existing connected `npm run demo` path remains available; its reviewed local destination
and explicit tenant mapping must be present. A general remote connection editor/provisioner is not part
of this release.

## Permission and source ownership

The local fixture profile is not the module manifest's grant authority. Only fresh developer stores are
seeded. Missing rights in existing stores stay missing. Prerequisite reads do not authorize later writes;
source commands and destination operations still recheck their current authority. Handoff adds only its
own options route and consumes the Knowledge owner's bounded metadata query. No schema migration or new
permission key is added. Existing records/receipts and v1/v2 compatibility protections remain intact.

## Acceptance actually targeted

Generate Checklist source → catalogue displays it without UI edits → create `facility-new` with reviewed
Handoff wiring → paired API saves definition → real build/export → launch snapshot → create a persistent
Checklist record and Knowledge document → complete the owner-to-owner handoff → inspect the exact receipt
→ pause destination → restart → preserve records and committed receipt while new actions remain blocked.

The Node integration test executes real HTTP, SQLite and worker processes. Controlled-page rendering and
browser/CLI resolver parity are additional checks, not actual browser navigation. See current evidence.
