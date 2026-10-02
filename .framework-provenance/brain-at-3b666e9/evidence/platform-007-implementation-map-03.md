# CP7 concrete source seams

Sol/high read-only handoff received by /root on 2026-10-01, adopted as next planned
core increment after CP6. Planning only; no implementation or qualification claimed.
Bounded contract remains .brain/tasks/PLATFORM-007.md.

Keep composeDraft as New only; complete ProductDefinition JSON is the editor authority.
Add shared bounded parse/serialize/preview helpers and source-derived graph in
packages/composition/src/studio.ts; expose their compiled browser functions through
tools/studio-catalogue.mjs. Unsupported values remain in editor text with diagnostics.

Fixed operator-server exact GET products/id/version and read-only POST products/preview
reuse validateProduct/resolve and existing confirmed immutable save. Narrow optional
synchronous authorization callback in ControlPlaneStore.putProduct executes inside
its existing transaction after BEGIN and before equal-return/insert/audit. No schema.

Paired apps/studio-web/src/main.ts full JSON+convenient fields, file import, exact saved
version load, semantic export, source graph and confirmed save. Bind draft/session/
request generation; edit/import/catalogue change invalidates preview+confirmation.
Offline visual/studio.js equivalent uses the same QBComposer helpers and file input/
download only, no network/filesystem/build authority. Small styles in paired static/
studio.css and visual/studio.css. build-visual already regenerates offline outputs.

Finite tests: studio-integration; control-plane-http; new studio-product-editor;
visual-edition; one control-plane-artifacts full-definition save -> exact build plan.
Docs: README, docs/STUDIO_INTEGRATION, docs/STATUS. Existing immutable store equality
is idempotent; differing same-version input conflicts; explicit new version required.
No installer/signing/multi-version-catalogue/native-helper or recovery changes.

Minimum actual evidence: semantic roundtrip, unsupported input retained+denied,
paired GET/preview/save equality/conflict/newversion/exact build, stale preview fences,
offline no-network import/export, fresh build/npm test, exact independent review,
ordinary paired and offline browser journeys separately. No expanded fault campaign.
