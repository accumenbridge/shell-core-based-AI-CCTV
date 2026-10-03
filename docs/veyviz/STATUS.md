# Product delivery status

2026-10-03: the local recorded-video product now has a redesigned review workstation and recording library. It runs real RF-DETR CPU inference, displays the accepted sampled images, and stores human review decisions. This is a usable local fixture product, not a qualified production CCTV platform. The live checkpoint is `.brain/CURRENT.md`.

The earlier interface emphasized configuration and provenance over the reviewer's task. The new experience makes the recording, selected sample, model observations and saved review decision primary. Actual thumbnails, previous/next and arrow-key navigation, an adjacent review panel, compact history, progressive setup and engine details, and narrow-screen reflow replace the developer-demo presentation. No fake detections, live playback or invented progress were added.

The source inventory is `8a8da11d29efd18b2c5965a1f8ba69f9e68716697ad65336a6d3e392373660de` (334 files). The review runtime fingerprint is `c39038e41d1cd69a04d451d38d7ed3bb6efa7d7b8b8532b5ffdbde4608462ce1`; the Brain candidate is `21387ecf7587cdea575a75981801f41cb0c5f48130343947584d3c85ddd2c4a1`. Full input verification matched after final UI build, browser review and fresh exported execution. Runtime source was frozen before the required full regression.

| Check | Actual result on this candidate |
|---|---|
| Build and boundaries | Build 04 passed. Maintained packages/apps/tools, backend, protocol, Python and regression test source unchanged in this UX increment |
| Package/companion file verification | Review 61 files, catalog 41 files and private companion assets verified |
| Installed Python/model | 10/10 passed, no skips; actual inference and native cancellation cleanup |
| Independent review export | 8/8 checks passed: actual HTTP, inference, review, authority denials, restart, cancellation and observed close |
| Independent catalog export | 5/5 checks passed: source-only composition, actual HTTP, registration, restart retention and clean close |
| Browser | Real six-frame and three-frame analyses, actual JPEG thumbnails, keyboard sample navigation, saved/reloaded review and dismissal, source-change warning, cancellation, tenant separation and read-only viewer controls passed |
| Responsive layout | CSS widths 1440, 1280, 768 and 390 checked. No document horizontal overflow. At 1280x900 the selected image and review controls are visible at scroll position zero |
| Full regression | Fresh npm test: 379 tests, 378 passed, 0 failed, 1 skipped; exit 0, 843287.385 ms. Required Windows file-symlink fixture denied with EPERM; formal qualification remains REVIEW/BLOCKED_ENV. |
| Independent review | Final exact-candidate source/evidence accepted; nonblocking selector cleanup deferred. The required host fixture remains blocked. |

Interaction repairs include stable history rows and focus across polling, selection/image response epochs, single-flight reads, command retry identity, mutation duplicate prevention, post-save reconciliation, persistent errors/source-change warning, unchanged-name guards, meaningful accessible names and correct pending-review counts. Server authorization remains authoritative.

The fixture yielded zero person detections. That verifies inference and result handling, not detector accuracy, scene occupancy or positive-detection overlay behavior. Browser checks are reported actual tool observations, not an exhaustive fault matrix, formal WCAG audit or user satisfaction study. Full-page narrow screenshot capture at the existing browser zoom can clip the right edge; overflow assertions use actual DOM geometry. Screenshots and private fixture assets remain under ignored `.local`.

Fresh exports and evidence are in `.local/independent-export-ux-20261003`; the browser report is `.local/veyviz-ux-browser-evidence.json`. Immutable copies of actual reports/logs are referenced by the Brain records. The visible preview runs the frozen independent review export, with the same verified runtime fingerprint and its original data generation. Existing identities/grants were not reseeded.

Historical qualification is retained separately: the previous `f4b10dd...` inventory had 378 passes, 0 failures and one Windows EPERM file-symlink block. Earlier full-suite failures and the overlapping-build E2E failure remain in prior logs/records; they are not current passes. UX build 01 also failed strict TypeScript checks; these were corrected before the successful final build. Python 3.11 was historically blocked by Application Control, so the already permitted Python 3.13.7 runtime is used without weakening security settings.

Next core product increments are owned arbitrary-recording admission with limits, longer video and representative detector evaluation, then live-camera inputs and operational recovery. External identity, production deployment, monitoring/load, native devices and third-party plugin installation need their own implementation and qualification. Current extensibility is trusted modules, public ports and UI contributions selected by product/solution composition. The shared framework's hardcoded login attribution remains visible; a product branding/default-workspace seam was reported upstream. A nonblocking dead analysis-specific content selector is deferred; shared layout styling is active. No claim of world-standard user validation or production readiness follows from this visual redesign.
