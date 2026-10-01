# Security and lifecycle — exact scope

## Implemented local profile

The HTTP adapter binds to 127.0.0.1 and checks the Host header. Cookie mutations require the exact Origin. Sessions use random opaque tokens; only their hashes are stored. Passwords use salted scrypt. Cookies are HttpOnly and SameSite=Strict; TLS/Secure cookie deployment is not claimed on local HTTP. Local login attempts are bounded in memory.

Principal, tenant grant and module mode are rechecked by the accepting operation. Human and service credentials are separate. Source-supplied fields cannot grant a tenant, and permission declarations cannot grant themselves. Data directories are bound to product and instance identity. Query predicates and unique constraints contain tenant scope.

Credentials/configs are generated under `.local/`, which is excluded from Git and packaging. Restrict filesystem access, including Windows ACLs. The profile assumes reviewed first-party code and trusted machine administration. It does not sandbox malicious code in a shared process or defend against a compromised host administrator.

## Real invariants

- Record change, receipt and audit are committed in one owner transaction.
- Durable job intent is in the initiating owner's transaction.
- Changed input under the same command key conflicts.
- Receipt replay still requires current permission.
- Only a current unexpired attempt can commit a job result.
- A local/HTTP destination is fixed by reviewed wiring; request data cannot supply a URL.
- Tenant translation is explicit. Prototype object properties cannot become tenant-map entries.
- Actual destination product/instance/tenant/service identity is verified; mutation rechecks the expected destination before executing.
- A committed receipt binds contract, original command, actual destination/actor and domain resource. A 202 or arbitrary ID is rejected as incompatible.
- A destination timeout is uncertain acceptance, not proof of rejection.
- External receipt/uncertainty is retained independently of local job error/stop reason. A fact-only recorder cannot grant new dispatch or business-completion authority.
- Explicit receipt lookup is authorized separately, bound to the original actor/tenant/command, and does not resend.
- Requested tenant and accepted workspace scope are separated; scoped clients cannot retarget through a mutable global selector.
- Removing a view is not cancelling its accepted business operation.

## Important limits

Authorization and a domain commit occur in separate owner stores. Checks are made at declared operation/commit points; this is **not a globally atomic revocation protocol across processes/databases**. A production profile must choose and qualify the required revocation and offline behavior.

SQLite APIs in this profile are synchronous and share one local host/filesystem. This is not a high-throughput hosted database design. Transactions must remain short. Schema ownership is enforced by code, file binding and tests—not by a hostile-plugin sandbox or a database administrator separation scheme.

The bounded worker uses a neutral execution-store port and rotating eligibility/module selection. The independent memory adapter proves replaceability, not durability. The bounded worker uses leases. It does not prove that an external operation or native computation has stopped merely because its attempt expired. No GPU, model inference, untrusted plugin execution or arbitrary URL tool is included.

The browser entry has CSP and does not embed auth tokens. Its reference renderer uses text nodes for supplied content. Actual browser execution was blocked by the evaluation environment's administrator policy; XSS/CSRF/UI conformance is not declared qualified on the basis of static code inspection.

## Disable versus removal

Read-only preserves authorized history and rejects new mutations; queued jobs remain. Off blocks the module's APIs and workspace. Both retain data. Physical removal is only assessed, not automatically executed when retained records, dependencies or jobs exist. No purge, legal hold or destructive uninstall engine is supplied.

## Updates and restoration

Build fingerprints detect accidental drift of selected artifacts and plans. They are not signed provenance or protection against an attacker who can edit both files and the manifest. Startup refuses incompatible or changed migration history. Production backup/restore, key rotation, OIDC federation, tenant transfer, distributed failover and rolling release orchestration are **not implemented**.

## Next production profile

Keep the public boundaries. Integrate reviewed identity/access and persistence implementations, production HTTP/TLS/session controls, secret custody, operational resource budgets, durable delivery reconciliation, telemetry and recovery. Run real browser and multi-process failure/security acceptance before allowing that profile to serve customers. Do not turn off the local guard and call it production.

## Version 0.2 adoption

New v2 receipt and source-reconciliation permissions are explicit. Existing seeded identities are not silently regranted. Old v1 pending Handoff rows are retained and held for original-protocol reconciliation; switching their retry endpoint would risk duplicate effects. See `UPGRADE_FROM_0_1.md`.
