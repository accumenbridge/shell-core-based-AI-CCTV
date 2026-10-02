# FAMILY-001 proposed useful Service Operations builder

Prepared by /root/repo_brain_architect (Sol/high), 2026-10-02. Proposal only; CAPABILITY-001 is the current implementation. Root adopts a finite contract only after matching capability acceptance. One Luna/xhigh writer, root shared Brain owner, independent Sol/high review. Preserve current Mobile, reliability and capability changes. No implementation, build, test or runtime invocation performed for this plan.

## Outcome and three variants

Add a familiar Service Operations family to paired Products and the offline Composer while preserving the arbitrary complete ProductDefinition editor and module starter. Choices are **Requests**, **Shared library**, and **Document handoff**. Requests is required; document handoff requires the library. Features are business choices, never tenant modes or actor grants.

| Selection | Exact selected owners | Required behavior |
|---|---|---|
| Requests | service-desk | No worker/bindings; create, read, close a persisted request |
| Requests + Shared library | service-desk, knowledge | Separate Knowledge worker; no Handoff module/bindings; persist request and add/index/search/read a document |
| Requests + Shared library + Document handoff | service-desk, knowledge, handoff | Separate worker; both reviewed local ports; accepted handoff with destination-owned committed receipt |

The existing Knowledge product is not the middle variant: it includes Handoff and an HTTP Desk connection. Family derivation must create ordinary new immutable definitions, not rename the existing Knowledge product or copy its bindings. Full family explicitly selects `local` for `handoff:knowledge.document.read.v1` and `handoff:desk.requests.create.v2`, identifiers present in solutions/knowledge-to-desk/solution.json. The source catalogue remains the authority for exact module versions, dependencies, provided contracts and binding implementations. Do not bake the current 0.2.x versions into family data or hosts.

## Pure mechanism and reviewed mapping

New packages/composition/src/family.ts exports a pure `deriveFamily(family,selection,productIdentity,catalogue,solutions)` and bounded family-data validation through the existing composition wildcard subpath. It imports only neutral contracts and the canonical composer/resolver; no filesystem, Node, module owner or grant imports. Existing composeDraft adds technical dependencies and resolves reviewed binding choices. Return the normal complete ProductDefinition, canonical resolved plan, selected feature reasons and separate derivation provenance. ProductDefinition's closed fields do not change.

New families/service-operations/family.json is reviewed data outside maintained hosts. Suggested closed schema `quadbridge.product-family.v1`: id/version/title/description; required/default feature IDs; feature entries with id/label/description/moduleIds/requires plus explicit reviewed binding-choice IDs where needed. No executable import/URL, permission assignment, provider command or customer credentials. Bound to at most16 features and ordinary bounded strings/arrays. Family module references are IDs; derive their versions from the supplied source catalogue. Generic code must not branch on Service Operations, Knowledge or product names.

Validate business constraints before composeDraft: unknown/duplicate/conflicting feature inputs and handoff-without-library produce readable structured diagnostics. Do not silently add an omitted business feature or choose another adapter. Canonical technical dependency additions are returned as explanations; if an addition contradicts family exclusion, report the inconsistency. Equivalent reordered selections derive identical normalized outputs. Use fixed codes such as FAMILY_UNKNOWN_FEATURE, FAMILY_REQUIREMENT_UNMET, FAMILY_IMPLEMENTATION_UNAVAILABLE and FAMILY_BINDING_UNAVAILABLE in diagnostic data; retain existing PlatformError codes for malformed request envelopes. No expansion of generic failure/grant types is necessary.

Identity includes id/title/version/layout/description. Preserve an intentional empty description. After composeDraft, use existing complete-definition validation and resolver when applying description so returned product and plan agree. This adds no second resolver. Source manifests/solutions and operation declarations delivered by CAPABILITY remain authoritative and compatible.

## Provenance with no new domain/schema framework

Derivation provenance is a separate `quadbridge.family-derivation.v1` value: family id/version; normalized business selection; selected module versions; exact reviewed binding choices; concise reasons; product definition identity/digest; captured family/source-catalogue digest. The pure result can carry canonical captured data for server hashing; do not add a browser crypto mirror or make a client-provided hash authoritative.

Prefer existing control-plane audit ownership over a new schema migration: extend the existing atomic product.version.put audit payload with optional server-produced family derivation, captured while saving the immutable product version. Provide a read-only exact-version accessor/DTO. The current putProduct transaction already inserts product/version/audit together with synchronous after-BEGIN authorization. Keep that invariant. On an identical family-save retry return the same definition/provenance without another audit; conflicting provenance for an existing version refuses, never rewrites or attaches invented historical provenance. Ordinary manual saves and old versions remain valid with no family provenance. A manually edited derived definition clears its family claim unless rederived; matching module IDs alone cannot reconstruct a historical claim.

If implementation inspection shows the existing audit cannot retain/retrieve exact version provenance safely, report that owning seam before expanding schema; do not quietly create a general evidence repository. This plan's intended minimal implementation uses the existing audit.

Projection joins saved version/provenance to actual build input/definition digest, buildId/snapshotId/snapshotDigest, registered inventory digest, promoted release and exact runtime instance/attempt/profile/config digest. Use existing records/DTOs and clearly separated states: derived/saved, built, registered, promoted, running, stopped or unknown. A recipe's actual domain journey evidence is separately bound to these identities in root's existing workflow. Do not infer verified business behavior from a feature label, declared layer, API readiness, unrelated earlier acceptance or a module name. If no matching journey evidence is available to the UI, say the workflow has not been verified there; no new implemented flag or broad Brain dashboard.

## Fixed paired and offline integration

Extend reviewed catalogue data with families. `readCatalogue` validates family files and identities in the same fixed source mechanism; missing families in legacy/independent exports is an empty optional catalogue. Do not maintain another module or adapter list.

Paired API adds one fixed read-only derivation endpoint `/platform-api/products/derive-family`: bounded familyId/selection/identity only; selected family and current module/solution snapshots come from trusted source. Reuse source-drift checks and original-session recheck before response. Extend the existing confirmed `/platform-api/products` save envelope with optional derivation request data; server independently rederives, verifies the complete exact product match, computes captured digests, then persists under original-session after-BEGIN authorization. Client reasons/hash/feature labels are not accepted as authority. Existing preview/immutable save/build/register/promote/start/stop paths stay in use. An exact-version family provenance GET may be `/platform-api/products/derivation?productId=...&version=...`; no arbitrary URL/path/table inputs.

Paired UI uses the same complete editor state and explicit unchecked immutable-save checkbox. Family/feature/identity changes invalidate earlier derivation, preview and confirmation. Awaited derive/save/load/catalogue responses retain current editor/navigation/session-generation fences. Changing full JSON or bindings clears attached family provenance; arbitrary composition still works. Render dependencies and unmet choices before build, with user-facing business labels. Reuse existing build/release/runtime details for exact identity links. Avoid technical implementation jargon in the selection flow.

Offline UI uses the exact compiled pure family mechanism and source-derived family data, allows selection/derive/preview/download only, and identifies itself as a preview. It obtains no filesystem/build privilege and sends no network requests. Family provenance may be downloaded separately as data; a ProductDefinition alone remains valid and does not assert historical family derivation. Browser import permission/policy blocks remain blocked; normal in-page family selection can be qualified independently without bypassing file-import controls.

## Build/export seams and finite writer paths

The current browserCore is a fixed wrapper, not a dependency resolver. Add exactly one reviewed compiled QBFamilies wrapper after QBComposer (and CAPABILITY's QBOperations); inject the precise existing pure symbols it imports. Fail closed on unsupported formats; no general bundler rewrite. Regenerate OPEN_PLATFORM.html and visual/data.json after fresh compilation, retaining Mobile/operation metadata.

Build-input policy currently accepts only apps/modules/packages/products/solutions/tools/profiles/templates/visual. Add a narrow `families/<safe-id>/family.json` reviewed source root/file rule, retaining secret/data/path/symlink exclusions and all exact copied-source fingerprint checks. Family mappings that participated in derivation then enter the build's frozen source identity explicitly. Fixed runtime exports continue to contain the selected ordinary product, modules and closure; the family definition is not executable runtime wiring. Provenance is retained separately by control-plane metadata/evidence; do not claim a new provenance file is included in exported inventory unless the fixed recipe explicitly includes and verifies it.

Initial proposed edit/new-file manifest: **18 paths** (4 new,14 existing):

1. packages/composition/src/family.ts — new pure mechanism/types/validation.
2. families/service-operations/family.json — new reviewed business mapping.
3. docs/PRODUCT_FAMILIES.md — new concise public example/limits.
4. tests/product-family.test.mjs — new pure and real owner variant proof; reuse fixed existing fixtures.
5. tools/studio-catalogue.mjs — family catalogue and fixed pure browser wrapper.
6. apps/control-plane/src/build-inputs.ts — narrow reviewed family data closure.
7. apps/control-plane/src/operator-server.ts — derive/save/provenance fixed operations and current session/source checks.
8. packages/control-plane/src/index.ts — immutable save audit provenance/exact-version read, no migration planned.
9. apps/studio-web/src/main.ts — usable family selection and existing editor/generation/confirmation integration.
10. visual/studio.js — offline pure selection/preview/data-download integration.
11. OPEN_PLATFORM.html — source-derived generated offline result.
12. visual/data.json — source-derived generated catalogue.
13. tests/control-plane.test.mjs — exact immutable provenance/audit behavior.
14. tests/control-plane-http.test.mjs — real paired derive/save/source/auth envelope proof.
15. tests/studio-product-editor.test.mjs — compiled handler feature/preview/confirmation/stale result behavior.
16. tests/visual-edition.test.mjs — offline same derivation/no privilege or network.
17. tests/factory-lifecycle.test.mjs — selected export/asset omissions, old composition preserved.
18. tests/reliability-baseline.test.mjs — fixed family source copy/hash inclusion plus existing sensitive-input rejection.

No module/data/grant/runtime/native helper/provider/schema-version/package-version changes expected. No factory algorithm change expected: derived definitions already enter its normal selected export recipe. If test4's actual three-artifact managed-runtime journey requires an existing control-plane-artifacts test helper export rather than simple reuse, root may explicitly substitute/add that one test owner during contract adoption; do not treat the broad candidate inventory as edit authorization.

## Core proof, sequence and acceptance

1. After accepted CAPABILITY source, root refreshes canonical contract/focus and finite manifest. Root records metadata/schema/provenance choices. Sole Luna implements pure mechanism+fixed family mapping and selected source-closure rules, then paired/offline integration. Build before focused checks; root hashes all newly created paths before any qualifying run.
2. A small pure table covers three exact selections, deterministic reordered choices, handoff-without-library diagnostics and catalogue/version/binding disagreement. It asserts Desk-only no worker, middle worker with no Handoff/bindings, full both local bindings. Source versions are read, not copied constants. Do not add an exhaustive feature/constraint engine campaign.
3. One real local journey recipe derives and saves new versions, builds verified immutable artifacts and sequentially registers/promotes/starts the three variants through existing owners. Create/read/close Desk; middle add document with actual PENDING->READY and indexing job success plus search/get using the accepted operations; full actual accepted Handoff with typed committed destination receipt and no duplicate on original-key replay. Stop/restart proves retained relevant owner records. All native ownership/EMPTY/helper-close/clean flags remain exact; preserve uncertainty if teardown lacks proof. Reuse one privately compiled source copy and existing reviewed host profile, not concurrent heavy native fixtures.
4. Excluded owners, routes and browser assets are absent in each appropriate build/export. Read actual release inventory/compiled imports; verify excluded domain endpoints/assets are not served from the running variant. This is selected-feature omission proof, not broad source deletion/uninstall.
5. Root's first ordinary paired Chrome proof chooses Service Operations, changes features with correct diagnostics/invalidation, derives/previews/confirms exact immutable save, builds/registers/promotes/starts the full variant and performs the actual document-to-request flow. Pure derive of the other choices can occur in the same browser session; their persistent runtime journeys come from step3. Exact family/product/build/artifact/profile/runtime identities bind sanitized UI/domain observations. Honor policy/tool blocks, record actual owner closure; do not infer browser success from VM tests or bypass blocked file import.
6. Freeze source after focused fixes and minimal docs, run mandatory ordinary npm test with actual complete original process close and unchanged candidate; zero failed/cancelled/TODO, only explicitly named existing unavailable coverage permitted. Root recipe records: brain-build and family-core-focused/three-variant-journey required success; brain-full-suite actual exit0 required; family-browser ordinary actual scope success or explicit blocked scope requiring coordinator disposition. Independent exact review before acceptance. Root owns run recipes/candidates/evidence; no source-fingerprint or tested counts in docs before actual run.

Scope excludes marketplace/plugin installation, generic page/entity/compiler systems, ERP/CCTV feature claims, model/provider inference, native devices, external HTTPS/identity/database/deployment or spending. Next useful derivation/generator/slot increment has its own bounded contract. MCP can consume accepted operations later; it does not block this family builder.
