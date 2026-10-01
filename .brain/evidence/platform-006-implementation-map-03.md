# CP6 concrete source seams

Sol/high read-only source planning, 2026-10-01. Complements PLATFORM-006's bounded
core contract; current execution remains PLATFORM-005A-CORE. No CP6 code or tests
were run. Source planning is attributed evidence, not native/provider acceptance.

Add `deriveRuntimeWorkspaceClosure(plan, readManifest(relativePath))` in
`packages/composition/src/workspace-closure.ts`, returning sorted package/module
copy roots, names, actual versions and flattened exact runtime dependencies. Start
from the existing reviewed host-package seed list and selected modules. Do not seed
from apps/runtime/package.json dependencies: that file currently lists all modules
and would defeat product scoping. Traverse declared runtime workspace dependencies
at fixed packages/<id>/package.json or already-selected modules/<id>/package.json.
Require exact names/versions and reject missing/unselected modules, external/range
dependencies, cycles and colliding package names. Do not download packages.

`tools/factory.mjs` assemble uses this closure to copy roots and write exact runtime
dependencies, including ai-core 0.3.0 when selected. `expectedFactoryInventory` and
`verifySnapshotManifestUsing` use the same pure closure; verification's manifest
reader uses existing captured readBytes, never current checkout manifests. Old
captured exports retain their own old closure independently of later source.

`packages/backend-host/src/http.ts` captures original token/bearer and authenticated
actor before awaited request-body processing. A synchronous original-auth callback
authenticates those same credentials, compares actor id and kind, and checks request
abort. Pass it as a backward-compatible optional final argument to ApplicationHost
execute. Context/execute support that callback; ctx.assertAllowed invokes it before
existing access.assertModule. No new required RequestContext ABI member, global
session resolver or public actor registry is needed.

Execute awaits the handler and repeats route permission/kind checks before returning;
HTTP performs final original-auth validation before delivery. Knowledge calls its
existing ctx.assertAllowed before retrieval/provider work and after awaited work.
Preserve original-credential rejection priority on error paths where applicable.
Direct non-HTTP contexts retain their existing grant semantics.

Minimum checks remain actual indexed exact citations/no-evidence, original logout/
expiry and cancellation suppression during awaits, tenant/grant/module denial, and
coherent new export/old captured closure. No expanded fault/stress matrix.
