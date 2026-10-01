# Adopting Foundation 0.2 from 0.1

## Recommended path

Extract the complete 0.2 archive into a **new directory**. Run `npm run setup`, then `npm run demo` with new local data. Keep the original source and data intact. This is a local framework preview, not an automatically managed production upgrade.

The accompanying source patch is for the exact original 0.1 archive, not an arbitrary checkout. Use `git apply --check` first and review changes. The patch does not contain refreshed compiled output: run the build using the pinned development tools before starting patched source. The complete archive already contains the updated compiled products.

## Package and browser compatibility

All maintained packages, reference modules and selected product definitions are 0.2.0. Rebuild an exact composition; do not mix 0.1 clients with 0.2 framework packages merely because the module ABI retains its v1 name. There is no independent published-package rolling-upgrade guarantee.

The browser loader now honors the exact `export` name. Modules can use selected multi-file native ESM and declared assets. Unsupported bare browser imports fail build rather than being exposed through the server. Existing single-workspace examples remain valid.

## Explicit destination contract

Existing human `GET/POST /api/requests` and `desk.requests.create.v1` remain. New cross-product wiring selects:

- `desk.requests.create.v2` and `POST /api/requests/commit` for an explicit COMMITTED receipt;
- `GET /api/requests/receipt?commandId=...` for **lookup only**;
- exact destination product, instance, tenant mapping and destination service actor;
- original command identity preserved across retries and receipt reads.

`desk.receipts.read` permits only the authenticated actor's original v2 receipts in its permitted tenant. It does not grant normal `desk.read`. `handoff.reconcile` permits the source's explicit reconciliation operation. The fresh local example seeds these grants; **existing seeded principals are not silently changed**. An operator must review and deliberately apply any local grant/configuration migration, or use a separate clean preview data directory. Do not hand-copy secrets into source.

## Existing local data

Service Desk's existing migration is unchanged. Handoff migration 1 is unchanged. Handoff migration 2 adds a protocol marker and an owner-local delivery-fact table. Queue metadata adds a separate stop reason and scheduling cursors. Tests exercise old schema preservation and refusal of edited migration history.

These migrations do not supply a backup/restore system. Preserve a consistent stopped local data copy before experimenting with existing data. Opening migrated Handoff data with old 0.1 code is not supported and must not be called rollback.

### Legacy pending cross-product operations

A v1 destination command may already have committed even when the old source records no receipt. **Do not send that old operation through v2:** the receiver's operation/receipt namespace changed, so it could create a second resource.

The 0.2 source retains those v1 rows and reports `RECONCILIATION_REQUIRED`; already accepted v1 rows retain their target references and are labelled legacy. It does not fabricate a v2 receipt, silently rewrite the old command identity or automatically resend.

Resolve a legacy pending operation through its original receiver/actor/tenant/command protocol and an explicit reviewed migration. An automated legacy reconciliation tool is not included. This deliberate hold is safer than duplicating a cross-product business action.

### New v2 operations

A recorded COMMITTED receipt can coexist with a failed/cancelled local job. UNKNOWN remains after timeout, cancellation or exhaustion. The authorized **Check original receipt** action checks the original command without resending. Source business completion still passes its owner command and current authority. Technical attempt history is not rewritten to look successful.

Changing a destination binding or service principal for a pending operation requires reconciliation rather than retargeting it. Same-principal credential rotation is distinct from choosing another identity.

## What the version exercise proves

`tools/version-isolation.mjs --older-root <original-0.1-directory>` runs actual old/new neutral snapshots in separate temporary local instances and verifies the older runtime stays on 0.1 with unchanged executable bytes when 0.2 starts.

It does **not** prove published package distribution, shared-data migration rollback, browser compatibility, production rolling upgrades or fleet operation. See `evidence/version_isolation.json`.
