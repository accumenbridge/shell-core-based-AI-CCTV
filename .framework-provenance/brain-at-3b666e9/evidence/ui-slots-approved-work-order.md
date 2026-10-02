# EXTENSION-001 trusted workspace slots — proposal only

Prepared by /root/repo_brain_architect (Sol/high),2026-10-02. FAMILY-001 remains the sole active implementation. This proposal is not adoption, permission, execution evidence or a completed API review. No maintained source/Brain/build/test/browser/runtime changes were made. Only this .local file was written. Root should re-read the accepted FAMILY source/current checkpoint and re-hash the inspected owners before finite adoption; several shared composition/catalogue/test paths are currently owned by Luna.

## Existing working authority and actual gap

The maintained web-shell already loads fixed build-owned module UI imports, resolves the exact named workspace export, supplies frozen accepted scope and scoped requests, and disposes/aborts on navigation, tenant/access changes, logout, suspension or stop. client-core checks declared owner routes, captures tenant and AbortSignal, and rejects late output when its current-generation predicate fails. BackendHost bootstrap filters selected workspaces by scope/mode/permission; actual HTTP original-session reconciliation stays in the existing adapter. frontendClosure already validates literal imports/assets, containment, selected roots and owner dependencies; build emits static module loaders. React adapter is an existing trusted renderer lifecycle seam and is not a bundled React runtime.

Missing behavior: rich Studio extensionPoints are descriptive labels. There is no executable declared contribution catalogue, exact contribution export registration, reviewed product/solution mapping to shell slots, or independent contribution lifetime/client inside another workspace. A second whole workspace already works and is not a new reusable extension proof. Keep the existing workspace and shell presentation systems; add only a small in-workspace composition seam.

## Useful first result

Use two read-only, differently shaped contributions from existing owners:

1. Knowledge referenceSearch: compact query form plus at most25 indexed title/version/excerpt matches from existing GET /api/documents/search. Extract a reviewed module-owned rendering helper reused by the existing Knowledge library workspace and a named referenceSearchPanel export, so the standalone and embedded behavior uses the same owner route/helper. No direct database and no domain data passed from the hosting Desk workspace.
2. Service Desk recentRequests: small recent-request cards (at most5 projected rows, state/title) from existing GET /api/requests; a separate named recentRequestsPanel export. It is visibly a returned-list summary, not an absolute total. This is a second shape/module implementation of the same contribution contract, not another UI framework.

In the full local knowledge-to-desk solution, Knowledge reference search appears beside Service requests; recent requests appear below Knowledge library. This helps users reference existing text or inspect related requests without changing the selected workspace. The family Desk-only variant must omit Knowledge contributions and all Knowledge code/assets; standalone library/search stays working. Existing manual products and neutral/no-contribution modules remain compatible. No new business backend, operation transport or database is required.

## Minimal contract and data separation

Add optional ModuleManifest.uiContributions descriptors: {id,permission,export,label}; IDs are module-qualified, exports are simple reviewed JS export names, permissions must be declared by that owner. Initial contributions are read-only. The descriptor is a requirement/discovery surface, not a grant. Define neutral UiContribution with synchronous mount(context) returning optional synchronous disposal, and UiContributionContext with its own root, frozen accepted scope/permissions, signal, notice and a read-only api.get. No arbitrary parameters, markup strings, CSS selectors, callback names, URLs or executable import paths. No Promise mount in this first contract; async work happens behind the captured signal/current context.

Use two shell-owned fixed slot names only: workspace.aside and workspace.footer. The shell wraps each active workspace in a generic layout with main/aside/footer containers; the existing module workspace receives only the main root. It must not erase sibling slot containers while refreshing its own root. Avoid changing the desktop/mobile presentation API or requiring domain-specific shell branches.

Add one strict small pure helper in contracts/ui-contributions.ts for descriptor and binding validation; SDK/composition/backend/build reuse it. Suggested profile: at most16 contributions/module, at most32 binding records/product, at most8 bound contributions/workspace, labels120characters, IDs/export/slot128, no unknown fields; duplicate identity/binding rejects. This is finite metadata validation, not arbitrary JSON Schema or a conflict engine.

Product/solution wiring stays outside maintained hosts. New solutions/knowledge-to-desk/ui.json contains reviewed records {workspaceId,slot,contributionId,optional:true} only. Build resolves this fixed file for the accepted product.wiring using the existing reviewed solution directory, never a user path. The pure binding resolver checks the selected canonical plan/manifests and exact workspace/contribution IDs. Explicit optional records are omitted with reasons when a source owner is not selected; an installed-but-malformed target/export/permission or duplicate fails. Do not retarget a missing contribution or infer mapping from module/product names. ProductDefinition and its existing closed import/editor/save schema need no new field or schema migration. Manual products without UI wiring have zero slot bindings.

Build emits these validated bindings as literal ShellOptions data in the fixed composition entry. Backend bootstrap supplies only authorized selected contribution descriptor data with moduleId; it does not interpret solution/product mappings. The shell intersects build-owned bindings with current bootstrap selected workspaces/contributions. Server HTTP authorization remains authoritative for every read. A client cannot obtain owner data merely by declaring a contribution. Existing packages/client-core implementation can be reused unchanged: bind its owner moduleId, accepted tenant, signal and current predicate, and expose get only. Do not reuse the hosting workspace's moduleId or give a Knowledge contribution Desk routes.

## Lifecycle and exact selected assets

Each mounted contribution has its own AbortController linked to the workspace generation, frozen actor/product/instance/tenant snapshot and disposer registered immediately. Before and after loader awaits, match current generation/snapshot and current descriptor selection. A provider's thrown mount is isolated to its slot with a plain unavailable message; siblings do not disappear. Mount/dispose are idempotently tracked; disposing one slot cannot preserve stale listeners/requests or prevent the shell cleaning the others. Scope/session/mode change invalidates the whole old view through the existing refresh/accessFailure path. No claim of instant push revocation: existing server checks and bootstrap refresh establish current access. Rejected awaited requests and notices from old slot identities must not repaint the newer workspace.

Resolve exact named exports from the same reviewed module UI loader; do not fall back to workspace/default or use runtime strings as import URLs. Extend frontendClosure/build loader eligibility from modules with workspaces to modules with workspaces OR declared contributions, using static selected UI imports. Existing owner/dependency/asset checks stay intact. For this first proof the two owners already have workspaces, so do not refactor loader architecture beyond this additive testable condition. Existing browserAssets registrations suffice; no new external styles, network fonts, renderer library, provider SDK, iframe, React dependency, plugin installer or permission/policy changes.

The offline catalogue carries descriptive contribution metadata through the same pure validation. If composition imports the new helper, studio-catalogue adds exactly one fixed compiled pure wrapper and explicit symbols to its reviewed closure; do not implement a recursive bundler or duplicate validator. Regenerate OPEN_PLATFORM/visual data through the normal fresh build, retaining FAMILY and Mobile data-only behavior. No offline mount/build/runtime privilege is introduced; a live extension requires the paired/exported authenticated runtime.

## Version and immutable packaging

New UI source/manifest behavior should receive coherent source pins: Knowledge0.2.3, ServiceDesk0.2.1, Handoff0.2.3 with its exact Knowledge0.2.3 dependency, and matching package/runtime/lock/product selections. Neutral package ABI/version additions stay additive, owner migration schemas and backend source are unchanged. Confirm these versions against the accepted FAMILY state before adoption. Preserve old registered manifests/closures; never compare old artifacts to current package versions or edit exported copies. Update only source-catalogue expectations in owned tests; hardcoded old Desk0.2.0/0.2.1 snapshot/rebuild fixtures are historical identities and must not be broad-replaced. Dynamic family derivation takes current source versions automatically; its business choices/provenance mechanisms do not need another implementation.

## Proposed finite source manifest (37 paths)

- packages/contracts/src/index.ts
- packages/contracts/src/ui-contributions.ts (new)
- packages/backend-host/src/index.ts
- packages/composition/src/index.ts
- packages/module-sdk/src/index.ts
- packages/studio-model/src/index.ts
- packages/web-shell/src/index.ts
- apps/control-plane/src/build-inputs.ts
- tools/build.mjs
- tools/frontend-closure.mjs
- tools/studio-catalogue.mjs
- modules/knowledge/src/ui.ts
- modules/knowledge/src/ui/reference-search.ts (new)
- modules/service-desk/src/ui.ts
- modules/service-desk/src/ui/recent-requests.ts (new)
- modules/knowledge/module.json
- modules/knowledge/package.json
- modules/service-desk/module.json
- modules/service-desk/package.json
- modules/handoff/module.json
- modules/handoff/package.json
- apps/runtime/package.json
- package-lock.json
- products/combined/product.json
- products/knowledge/product.json
- products/service-desk/product.json
- solutions/knowledge-to-desk/ui.json (new)
- OPEN_PLATFORM.html
- visual/data.json
- docs/UI_CONTRIBUTIONS.md (new)
- tests/ui-contributions.test.mjs (new)
- tests/shell-regressions.test.mjs
- tests/frontend-assembly.test.mjs
- tests/composition.test.mjs
- tests/module-sdk.test.mjs
- tests/factory-lifecycle.test.mjs
- tests/workspace-closure.test.mjs

The manifest includes integration/version-only paths rather than granting whole directories. packages/client-core, apps/runtime implementation, local-access, SQLite, domain backend/migrations, mobile-shell, native helpers and UI/host security policy are outside edits. tools/factory already copies selected solution trees and fixed closures; no change is proposed there. If fixed imported helper public ESM mapping needs a contracts/ui-contributions specifier, add only that explicit mapping in frontend-closure. No new runtime/client dependency download. Do not add a path because an unrelated old assertion mentions the same version. Root must capture baseline hashes/actual finite contract after FAMILY acceptance; newly created files enter the candidate manifest before qualification.

## Core acceptance and recipes

Required build first, then a small focused recipe: tests/ui-contributions.test.mjs, shell-regressions, frontend-assembly, composition,module-sdk,factory-lifecycle,workspace-closure. Preserve all existing meaningful assertions; add only named export/parity/permission, selected omission and late/disposal checks needed for this seam. One private source compile/export setup, sequential runtime products under the unchanged original-owned native profile. No stress matrix.

1. Shared pure descriptors/bindings accept the maintained valid data and reject a handful of actual dangerous malformed cases: unknown slot/export, missing selected declaration, duplicate binding, undeclared permission. Existing no-contribution modules remain valid.
2. Actual exported full local product: seed through reviewed canonical enrollment, create Desk request and Knowledge text through existing owner HTTP/commands, index through real worker, mount both contributions through compiled shell. Their displayed records correspond to the exact tenant's real owner data. Viewer reads but has no write control; tenantB sees its own empty returned data.
3. Small controlled shell lifecycle components prove late loader/result/notice suppression and exactly-once disposal across navigation/logout/tenant replacement. Use the real existing scoped client API, clearly label controlled DOM tests rather than browser/native evidence. Initial read-only contribution API cannot POST or borrow another module's route.
4. Physical independent export verification: full selected renderer exports/assets present, Desk-only Knowledge UI/assets absent, no runtime checkout/compiler requirement. Prior accepted snapshot/source invariants remain. Use existing assets/closure algorithm rather than new packaging authority.
5. Required ordinary real browser journey on the exact promoted full artifact: authenticated login, persistent Knowledge text→indexed search, navigate Desk and search from embedded Knowledge panel, navigate library and see the recent Desk request card, tenant change clears old slot content, viewer has only reads, logout clears panels, same artifact restart retains records, final positive owner stop/close. Capture exact product/build/artifact/runtime/profile identity and sanitized DOM/screenshots. A browser policy or tool block stays BLOCKED and does not qualify the full journey through a simulated fixture. Do not bypass blocked file-import; no upload is needed for this slot journey.
6. Freeze and run ordinary npm test with actual original child close exit0, zero failures/cancel/TODO and only named justified unavailable coverage, then independent exact source/artifact/evidence review. Proposed recipe IDs brain-build, ui-slots-focused, ui-slots-browser (actual observed journey); full suite is required observation with the explicit exit0 review gate. Build/focused alone cannot accept the browser criterion.

## Boundaries and next dependency

These are statically reviewed same-origin trusted contributions; they share browser process/origin and are not an untrusted plugin sandbox. Declaration labels do not implement UI, RAG or model inference. No MCP Apps/iframe bridge, remote authentication, provider, native device, global configuration or production/customer qualification in this task. Family builder remains prerequisite and does not receive simultaneous new writer edits.

ENTITY-BUILDER can then generate owner operations plus whole list/create/detail workspaces and optional reviewed read contributions using these contracts/SDK/dom helpers. It must generate a fixed named export and descriptor, not shell branches or renderer URLs; source spec/data ownership remains its own separate contract. Entity editing/optimistic concurrency does not belong in the slot increment.

## Inspected source hashes (planning snapshot, not acceptance)

- packages/contracts/src/index.ts: 852c500432771ca76f0c6377281588c6a918d5cc57096e8c63684a110302c1ed
- packages/client-core/src/index.ts: f2b8521725db0f06934ac59ccb0139cd82eea608805457bc8e33f0122d863c5e
- packages/web-shell/src/index.ts: db0186cc8ee7f8b192b7df15172e60bd4df95017ef3c88a56129a230ac1a4d0c
- packages/web-shell/src/react-adapter.ts: 65959d9eae79cb3f80c71b1d3ce2910e4206918ed1bda697733195fe8057c315
- packages/studio-model/src/index.ts: 0bb8f45a2324dab5c5cf694ed0e8f8f6e0afdad1c90c0b2a81688b785a55fa72
- packages/backend-host/src/index.ts: 4d3a930b79243a198b75bea90b706686da905f77d9f70ad7e0787f0b2656ddb5
- modules/knowledge/src/ui.ts: bbd6d806b3334462fd324a7b0b456c1993b22a224f2d70dd41f3cce421623ba2
- modules/service-desk/src/ui.ts: 8363b8a32a1114489b5d131518ae25baa14dfcdde5dcd912552b529c5d287ab2
- modules/service-desk/src/ui/overview.ts: 5de3636f9ae8ec385625e4eb9c5509a1670984b7547ce57c74968b1f01926d55
- modules/knowledge/module.json: 3d8aef6f576666d363fa50da8b8ad80778cb359e7d12c076c25073dbe9fca538
- modules/service-desk/module.json: 448b03e9a8a8cc94cd65451d22cb2fdb3db9074e7b1df471acc27414e428e698
- modules/handoff/module.json: 7be25546531fffa2eb0368c69c65912e0b41083090090236fa7bf17b9aacd2db
- tools/frontend-closure.mjs: e9a264807c8ae6793d71adb1aec1f6cbd282cd6618b35f652cffd60296db5387
- tools/build.mjs: d08713084bb96166cbd3140285735aba7293c4c69719f3988e6689d79de05b27
- tools/factory.mjs: fc1e8b8bb0953216bb61df7b31893d3be23319f733fd02cb5fee8af2f281f62c
- tools/mobile/assemble.mjs: 85996517abfd5da7138535403b812cde9f3721f108e16ccce3e1626fb3b8694e
- tests/frontend-assembly.test.mjs: 61adf736354489759db20439b8c31f2b4fdb7fcf19240b5feb1549ed7ce83bec
- tests/shell-regressions.test.mjs: 165399704229b03604e963dfbf66caf1d7a35fd84f501f69a43c833f5a611765
- docs/plans/SPLE_FAST_PRODUCT_BUILDER_PLAN.md: c5c3bc76040a5d6c9564b26fc150b7135422ee3dc74b7a66a6fd778ceeb78bc3
- .brain/evidence/framework-next-core-plan.md: 10b526409bd551564e65b9340d5a1e1cbd6c15a4e66ae4aca7c2c5fde8365e52

Reinspection required before adoption: canonical FAMILY acceptance/current task/atlas, actual shell/bootstrap/closure/build and shared contract/catalogue/generated-source versions. Planning snapshot hashes alone do not grant readiness or prove current source still equals these observations.

## Revised planning amendment 01 — reviewed UI mapping copy authority

Prepared 2026-10-02T08:05:36.787Z by /root/repo_brain_architect. This is a separate proposal revision, not adoption or FAMILY execution evidence. Original proposal remains unchanged: .local/ui-slots-plan.md, SHA256 6ba8260619eb4f52892e222a885fa53beccfa35b2a069747e6a5af02bb524dce.

Confirmed current owner seam: apps/control-plane/src/build-inputs.ts, SHA256 cb5cb5ac95f0e4ea8dfac74847ea26ac3c2c4bae5449302a1a0e2dadaf6c0528, currently accepts only solutions/<safe-id>/solution.json and wiring.mjs. New reviewed ui.json would therefore make reviewedBuildFiles/private source copying reject the solution input before an actual immutable build. Add this one owner to the finite manifest (37 total); do not expand the accepted directory or generic JSON policy.

The exact proposed rule adds only leaf ui.json at depth3 under an already safe solution ID, as bounded inert reviewed solution data. Existing physical regular-file/no-link checks, portable-path/secret exclusions, per-file/copied-set identity checks and copied source containment remain. Pure slot binding validation validates its bounded closed records against the captured selected plan. No request-selected path, dynamic renderer import, runtime-only download or alternate fingerprint algorithm is introduced. The same reviewedBuildFiles/copyReviewedBuildInputs source set must include ui.json, so changes bind the frozen pre-overlay source fingerprint and copied snapshot inventory through existing mechanisms.

Preserve FAMILY's existing families/<safe-id>/family.json branch unchanged, and the current source-derived catalogue/browser wrapper. Family derivation already produces ordinary products: adding UI mapping must not invent family-specific copy or host branches. This inspected build-input owner is currently part of Luna's FAMILY finite source; no concurrent edit is authorized. Reinspect its accepted final FAMILY bytes before future EXTENSION admission.

Minimum check addition within the existing proposed new tests/ui-contributions.test.mjs owner: use a tiny fixed source fixture with reviewed solution.json/wiring.mjs/ui.json, assert the exact ui.json entry is included in reviewedBuildFiles and changes its source fingerprint, then copy through the existing reviewed-copy helper and assert equal bytes/hash. Keep an adjacent unreviewed solution file rejected and existing link/secret guards intact; reuse existing helper behavior, no added test matrix or test-owner expansion. The existing actual private exported-runtime journey then verifies the mapped contributions survive the canonical copied build path. No current build/test was run for this planning amendment.
