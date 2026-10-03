# Veyviz review experience

Design intent, 2026-10-03: the user rejected the engineering-demo presentation. The core outcome is a reviewer understanding the recording, sampled evidence, model observations and saved review decision without reading implementation details.

## Selected direction

A quiet professional review workstation: midnight navigation and media stage, warm white working surfaces, a restrained teal accent, crisp type hierarchy, deliberate spacing and borders. Use system fonts and local CSS; no external assets or fake telemetry. Product identity and the actual task take precedence over framework exposition. Retain accessible navigation, tenant switching and sign-out.

The review page opens the newest available result automatically. A large single-frame stage, numbered sample strip, timestamp/frame index and adjacent findings form the center. Previous/next controls and keyboard access inspect actual samples; do not imply full video playback. Show saved review state and persistent actions together. A compact request list lets reviewers switch analyses. New analysis is a deliberate disclosure; sampling configuration is secondary to the source and primary action. Technical hashes and verified package details remain available under disclosures.

The recordings page is an intentional library with a clear empty state and one supported local sample profile. Registration and inline renaming retain real server semantics. Do not add upload/live buttons that do nothing. Cross-workspace navigation must be based on supported permissions/composition, not imply AI in the catalogue-only product.

## Observable acceptance

1. Desktop at 1440 and 1280: the selected frame and review action are discoverable immediately; no large setup/statistics panels before the media.
2. Narrow at 390 and normal app panel: readable single-column flow, no document horizontal overflow, full actions and sample navigation reachable.
3. All samples originate in the accepted response; selected sample identity/timestamp/counts agree. Zero detections says only no person detections in the sample, never all clear or nobody present.
4. Analysis/review/loading/failed/cancelled/unavailable/empty states have plain-language labels; no invented progress percentage. Job completion and human review remain separate. Pending review counts exclude already reviewed/dismissed results.
5. Review mutation has in-flight duplicate prevention, saved/error feedback, immediate list/detail reconciliation. Refresh cannot steal focus, erase editing or race selection; stale asynchronous result responses cannot overwrite a newer choice.
6. Viewer cannot see active mutation actions; server scope checks remain authoritative. Tenant navigation clears old data through the shell lifecycle. Reads and updates honor the workspace abort signal.
7. Keyboard-visible focus, semantic headings/labels/button names, sample pressed state, image alternatives and live status announcements. Reduced-motion preference respected. No autoplay or forced continuous animation.
8. Build then actual desktop/narrow browser journey and independent source review before final source freeze and required npm test. Preserve the existing Windows symlink qualification block if it recurs.

## Scope and ownership

Only product-owned module UI/CSS, selected product presentation metadata and reviewed solution UI slots may change. Backend/AI protocol and maintained hosts/packages stay unchanged. Root owns this design, Brain, inventory and verification. TS writer owns analysis UI/CSS; root owns product/solution presentation metadata; the second writer owns recordings, provenance and shared product CSS. All implementation inputs are captured by the full release inventory. Existing local results are preserved in their original fingerprint generation.

World-standard product readiness also requires representative user evaluation, real recording admission, measured detection performance, operational resilience and deployment qualification. This increment improves the usable review experience; it does not claim those unimplemented profiles.

