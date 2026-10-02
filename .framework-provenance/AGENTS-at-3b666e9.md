# Engineering instructions for this independent source repository

Read README.md, PLATFORM_ARCHITECTURE.md, docs/STATUS.md and the relevant module before changing code. This is the product-neutral platform, not the existing Veyviz repository.

- Keep `packages/*` free of imports from `modules/*`, `products/*` and `solutions/*`.
- Keep domain data and migrations in its module. Do not invent a universal domain object or expose another owner's database.
- Keep product/solution wiring outside maintained hosts. Runtime strings are never executable import URLs.
- Module declarations are requirements, not grants. Keep actor/product/instance/tenant scope and command identity intact.
- Never await inside the SQLite transaction callback. External effects require original-identity reconciliation.
- Build before testing edited source. Do not claim success from a stale dist folder.
- Run `npm test`; record any skipped/blocked browser, provider or live integration separately.
- Do not change a user's external repository, credentials, entitlement or deployment from this scaffold.
- Local developer security controls must not be weakened to claim a production profile.
- Do not edit exported package copies as a new framework source authority.

## Studio integration constraints
- `OPEN_PLATFORM.html` is offline; it must not gain filesystem/build privileges.
- The optional paired loopback Studio exposes only fixed reviewed operations with explicit confirmation.
- Derive catalogues/plans from source; do not add independent allowed-module or product-name logic.
- Never reseed removed identities/grants into an existing local store to make a demonstration pass.
- Managed apps run fixed exported snapshots. Different build fingerprints do not silently reuse data.
- Record browser policy blocks as blocked, not pass, and never work around them.

## Project Brain entry
For project work, read `.brain/START_HERE.md` and follow the canonical paths in
`.brain/project.json`. Refresh the current task and checkpoint before acting, route
the request through `.brain/ROUTING.md`, and record only actual decisions and results.
This local workflow does not change the existing safety, ownership, or approval rules.

When `.brain/atlas/project.json` exists, also read `docs/brain/README.md` and the
atlas profile before preparing project work. Run its documented validation command,
reconcile relevant source drift and planning gaps, and compare its planning focus
with the canonical current task. Use the linked outcome, journey, contracts and
acceptance criteria to prepare the next core increment; defer unrelated optional
work with a reason. The atlas is a planning snapshot, not an execution checkpoint
or permission grant. Regenerate its view for project-map reviews after reconciling
changes; keep actual execution results in the existing evidence workflow.
