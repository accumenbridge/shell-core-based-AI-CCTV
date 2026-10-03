# Concept-led Veyviz interface

User direction, 2026-10-03: compare the five generated Veyviz screens with the actual product and implement their visual quality. The user rejected the earlier CSS refresh. This increment adopts a concrete visual system rather than treating backend test passes as visual acceptance.

## Visual target

The reviewed images are in `.local/design-concepts-20261003-v1`: command center, AI investigation, incident case, site intelligence and platform health. They are illustrative references, not implemented behavior or valid analytical datasets. The first, second and fifth define this increment's layout, hierarchy and material treatment.

- At 1440 px, use a roughly 210 px dark permanent sidebar, compact 56-64 px tenant/account bar and 24 px content gutters. Veyviz is the primary identity; framework attribution is secondary.
- Command Center is graphite, with the actual accepted recording sample as its principal surface, a purposeful review queue, source context and real sampled-frame navigation. Clearly label recorded media. No fabricated live indicators, aerial maps, camera counts or detections.
- Investigate is a lighter evidence workspace, with a working search/filter bar, image-led analysis results, selected footage, sample sequence and saved review controls. Filtering explicitly covers the returned latest analyses, not a nonexistent global search index.
- Recordings and System Health use the same typography, icons, borders and navigation rhythm. Health shows actual verified profile facts and packages, never fabricated runtime telemetry. Registration, rename, availability refresh and review must actually work.
- Use restrained evergreen emphasis, near-black navigation, legible secondary text, small corners and thin separators. Avoid inflated metric cards, repeated oversized page introductions, layout gaps, gradients and decorative diagrams that do not describe current behavior.

## Product boundary

The maintained shell already supports sidebar layout and product module CSS. Workspaces belong to the owner whose scoped API they use. Command Center and Investigate belong to veyviz-analysis; System Health belongs to veyviz-rfdetr. Use existing permissions and API contracts. Root owns module workspace declarations and product/solution wiring; the two UI writers own disjoint UI/CSS paths. No maintained host/package changes, public providers, scope grants, reseeding or original-repository changes.

Maps, continuous live video, natural-language object search, case entities, spatial analytics and third-party plugin installation in the concept images remain separate functional increments. This increment implements the reference visual system and meaningful owner-scoped workspaces over real available data. Unimplemented conceptual features must not appear as deceptive working controls.

## Acceptance and verification

1. Compare an actual browser screenshot with the reference at CSS 1440x1000 and 1280x900 before freezing source. The sidebar, compact top bar, media prominence, queue and lower sample strip must visibly resemble the adopted design. A passing overflow check alone is insufficient.
2. Real fixture analysis, result selection, previous/next and keyboard navigation, saved review/dismissal, cancellation, rename and reload persistence remain functional. Search/filter must change visible results without losing current evidence or lying about scope.
3. Empty, loading, unavailable, denied, failed and cancelled states have useful visible actions and no invented success state. Async requests cannot cross selections or tenants; duplicate mutations and stale list/image responses remain guarded.
4. Viewer controls stay read-only; beta does not show alpha data. Added workspace calls remain within their module's authorized routes. No data migration across changed runtime fingerprints.
5. At widths 390 and 768 all actions are reachable and content does not create horizontal document overflow. Focus remains visible and stable; actual image aspect ratio remains correct.
6. Build source, perform real browser journeys and independent visual/source review, then freeze full inputs before one required npm test. Verify Python and independently exported review/catalog products against the same input inventory. Record the Windows file-symlink fixture block separately if it recurs.

Source/evidence acceptance cannot guarantee user satisfaction or production completeness. Record the visual comparison honestly and preserve the user's rejected prior design as historical evidence.
