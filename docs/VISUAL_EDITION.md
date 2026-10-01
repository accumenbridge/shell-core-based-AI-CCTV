# Foundation 0.2 — Visual edition

## Two explicitly separate modes

**OPEN_PLATFORM.html — standalone explorer.** Product cards, local composer, actual module manifest browser, clickable architecture, sample requests, sample text search and cross-product simulation. All sample records are held in memory. Reload resets them. The generated product definition is the only exported configuration; no grants, source edits or deployment occur.

**Running applications — real local API and records.** The existing host and selected module views use the real loopback backend, generated session credentials, scoped APIs, durable owner stores and workers. The new style, list counters, empty states, overview cards and cross-product visual path reuse those existing clients. No sample data is seeded by the visual edition.

## Open

Double-click OPEN_PLATFORM.html for the visual explorer. On Windows START_APPS.cmd starts the actual four local applications; on macOS/Linux run `sh START_APPS.sh`. Node.js 22.16 or newer is required for the backend. After startup, use Run real apps in the explorer. The entry page does not claim server readiness or automatically make network requests.

## Product composer

Select the included domain modules and export `<id>.product.json`. Put it at `products/<id>/product.json` in this source repository, then build through the existing toolchain. The composer selects only supported existing module IDs and versions. Its Handoff option adds Knowledge and Service Desk and their local bindings. Remote connections require the existing explicit solution configuration. Exporting a definition is not runtime admission.

## Changed source areas

- `packages/web-shell`: maintained visual styles, login presentation, navigation state and presentation helpers. Context, authorization and request lifecycle logic remain unchanged.
- `modules/service-desk`, `modules/knowledge`, `modules/handoff`: presentation only, using existing permitted APIs. Counts are labelled as the currently returned list rather than a whole-database total.
- `visual/`: editable standalone explorer sources.
- `tools/build-visual.mjs`: derives the opening page from actual source manifests; invoked by the ordinary build.
- `DOCUMENTATION.html`: original technical reader, retained at the root so its links remain valid.

Framework and module versions stay 0.2.0; this is a presentation variant, not a new API release. Existing backend, worker, connections, persistence, access, composition and migration source is preserved byte-for-byte. Do not copy the variant over an active installation without the same release review as other source changes.

## Verification boundary

The backend/framework regression suite is rerun. Additional visual-source tests check that composer outputs resolve with actual manifests and do not create unauthorized grants. These do not prove browser rendering. Normal Chromium navigation was attempted for the standalone page and blocked with ERR_BLOCKED_BY_ADMINISTRATOR before any browser assertion. No bypass was attempted. Browser and actual React acceptance remain unverified.
