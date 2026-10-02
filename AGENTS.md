# Independent Veyviz product engineering

This repository is the new Veyviz product built on the pinned Quadbridge source foundation. Read docs/veyviz/ARCHITECTURE.md, docs/veyviz/ACCEPTANCE.md, docs/veyviz/PROVENANCE.md and .brain/START_HERE.md before product work. Root README.md, PLATFORM_ARCHITECTURE.md and docs/STATUS.md describe the inherited framework; their historical acceptance is not acceptance of this product.

- Maintained packages/*, apps/* and existing framework construction tools remain upstream-owned and unmodified. Report defects to worker1 in CORE-FRAMEWORKS; adopt a reviewed upstream revision explicitly.
- Product behavior belongs in new owned modules; product wiring belongs in products and solutions. Neutral packages never import domain modules. No arbitrary executable import URLs.
- Product tenancy/access, source inventory, analysis requests and accepted business records remain Product-owned. Python AI/media packages own machine execution and temporary semantic state. Use scoped authenticated contracts; never cross-read private databases.
- Keep actor/product/instance/tenant/site/source and original command identity intact. Module declarations are requirements, never grants. Browser input never creates authority. Recheck grants and object scope at each operation and result adoption.
- Never await inside SQLite transaction callbacks. External effects require durable original-identity reconciliation. Separate delivery, execution and Product acceptance. Cancellation requested is not native cleanup proven.
- Use only explicit reviewed local recording/model profiles. Real inference may report detections; uncommissioned footage cannot establish true occupancy, absence, coverage or live-camera qualification.
- Preserve the original Veyviz and CORE-FRAMEWORKS repositories, credentials and user data. No production/cloud mutation, deployment, spending, global configuration or external messaging without applicable authorization.
- Build source before tests. Run npm test, meaningful installed Python tests and actual end-to-end/browser checks for the edited scope. Keep skipped, blocked, deferred and unrun gates visible; never bypass browser policy.
- Keep offline planning views read-only; paired Studio operations remain fixed, reviewed and explicitly confirmed. Managed artifacts are frozen snapshots; changed fingerprints never silently reuse data. Never reseed removed identities/grants.
- Root owns protocol, launchers, root dependency/config changes, integration and shared Brain state. Writers own only their assigned files and must preserve others' edits. Use parallel read-only review; coordinate disjoint writers only after the protocol and finite file manifests are frozen.

Read .brain/project.json and its mapped current task. Route through .brain/ROUTING.md. Read and validate the product atlas, then run node tools/brain.mjs preflight --json before implementation. Root alone publishes checkpoints and expands exact candidate files. Preflight is plan admission, not delivery acceptance. Inherited records in .framework-provenance/brain-at-3b666e9 are historical framework provenance only.
