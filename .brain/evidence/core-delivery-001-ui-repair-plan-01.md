# CORE-DELIVERY-001 — bounded Products UI repair

Source-grounded planning evidence, 2026-10-01. Root coordinates the contract and single-writer handoff; Luna implements. No application edit or executable check is performed by this proposal.

## Actual core failures

1. First Products navigation rendered “No modules are available” indefinitely although catalogue loading succeeded. `apps/studio-web/src/main.ts:335` updates the route and navigation generation, writes the hash, and starts the catalogue request. The `hashchange` handler at line504 increments that generation again and renders before the response, without a Products completion loader. The original completion caches the catalogue but fails its navigation-generation check. A second Products click displays the cached three modules. Preserve the browser observation; the first entry did not work.

2. Save uses `window.confirm()` at line329. In the actual owned browser fixture, the native confirmation opened, but documented dialog acceptance and key control timed out in CDP focus emulation. Read-only SQL proved no custom product was saved. The fixture closed through its original owner with observed outer exit0. This is an incomplete browser/tool transport attempt, not a permission change or an accepted save. It is distinct from the earlier blocked file-upload permission and must not be used to work around that block.

## Exact maintained scope

- `apps/studio-web/src/main.ts`
- `tests/studio-product-editor.test.mjs`

No operator/store/API/runtime change. No generic navigation framework, additional browser permissions, arbitrary execution or new native fixture campaign.

## Required behavior

Suppress redundant hash-change processing when the hash names the route already applied by a navigation click. Genuine hash/back navigation still updates navigation identity and loads Products with a completion render guarded by the captured session, navigation and current Products route. Preserve existing editor request/session invalidation. First navigation must show the actual catalogue without another click; navigating elsewhere while it loads must not restore the old Products view.

Replace only the product Save native dialog with a visible in-page checkbox naming the exact previewed `id@version`, matching the existing explicit build/runtime confirmation convention. It is unchecked by default. Save requires the current valid preview, matching editor generation, active original paired session and explicit checked confirmation. Capture the exact previewed product, consume/reset confirmation before dispatch, and retain the existing server payload `confirm: true`, original-session API checks and immutable-save behavior. An unchecked click sends no save request and explains the necessary confirmation.

Confirmation must not survive edits, a new preview, logout/re-pair, navigation away/back or a completed/failed save attempt. Rendering may conservatively reset it; never preserve this checkbox via the unrelated runtime-confirmation restoration loop. No fallback native dialog is required. Show the exact identity adjacent to confirmation so the operator can review what will be saved.

## Minimal meaningful regression and evidence

Use the freshly compiled Studio script and real registered DOM/event handlers in a controlled VM harness, following the existing `studio-runtime-ui.test.mjs` pattern. The current product-editor test file exercises pure composer helpers; new UI coverage must execute maintained compiled handlers rather than duplicate navigation/save logic.

1. Defer the catalogue response, invoke the Products click and its corresponding hash event, then resolve the actual catalogue response. Assert first-entry module choices render without a second click. A genuine navigation away while pending must stay on its selected route.
2. Prepare an exact valid editor preview, assert the visible identity and initially unchecked confirmation, and verify unchecked Save sends no mutation. Check confirmation and Save; assert one request carries the exact complete previewed ProductDefinition and `confirm: true`, with no `window.confirm` invocation and confirmation consumed. Edit/re-preview and navigation/session changes clear authorization to reuse that confirmation; existing request-generation guards still suppress stale results.

These tests qualify compiled UI behavior with controlled DOM/network dependencies, not a real browser or saved database. After fresh build and focused tests, root captures exact two-file hashes and independent source review, then starts a fresh empty owned fixture and qualifies the ordinary in-page compose/preview/confirm/save journey through actual HTTP/store/build/runtime/domain/recovery controls. Preserve the failed native-dialog attempt and blocked file import separately. Run the required shared full suite only at the coordinated final frozen source boundary.
