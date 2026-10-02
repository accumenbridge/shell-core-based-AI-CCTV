# Safe local product upgrade

The paired local **Runtime** view can move one positively stopped instance to a newer already promoted
artifact when the source-derived plans retain compatible module ownership, bindings, permissions and
runtime profile. This is an explicit, same-instance maintenance action. It is not automatic deployment
or a general-purpose migration runner.

## Operator sequence

1. Inspect the instance and stop it using the existing confirmed Runtime action. The upgrade is enabled
   only when the current generation, attempt, native empty-tree proof and owned cleanup all match.
2. Load backups and verify the backup for that exact instance, source generation, artifact and attempt.
   The backup remains private; Studio never downloads database files, credentials or private paths.
3. Select the exact newer promoted release. Review the source generation, backup digest, target version
   and full target artifact digest, then check the explicit confirmation and submit **Upgrade exact
   stopped generation**.
4. The operator prepares a separate target-generation directory from the verified backup, copies the
   exact promoted snapshot, and runs the fixed initialization-only migration driver under the existing
   reviewed Windows process-tree profile. The target does not run normal startup hooks, a worker or
   business operations during migration.
5. After the migration process and its Job Object close positively, the operator independently checks
   target enrollment and owner inventory, publishes the new data directory without replacement, verifies
   the published destination and records the cutover under the original session and source-generation
   fence.
6. Cutover reports **UPGRADE_READY**. This is not a running target and carries no target readiness or
   application address. The user separately checks and submits the existing confirmed **Restart** action.

## Retained identity and data

The source generation, commands, attempts, actors, timestamps, stop facts, verified backup and data remain
retained. The target is another immutable generation of the same runtime instance. Its artifact origin
and target operator actions keep their own actor identities. Service Desk migration logic stays in the
Service Desk module; neutral control-plane packages store generation lineage and physical ownership only.
Initialization uses empty principal seeds, so removed users and revoked grants are not recreated. Existing
Knowledge, Handoff and other selected module owners retain their own records and schemas when the exact
source-derived plan supports the target.

The operator exposes only fixed paired routes: `GET`/`POST`
`/platform-api/runtime-instances/:id/upgrades` and `GET /platform-api/runtime-upgrades/:operationId`.
Responses contain bounded generation and operation facts, not owner tokens, credentials, SQL, filesystem
paths or arbitrary executable input.

The current source evolution advances Service Desk from `0.2.1` to `0.2.2` and Combined from `0.2.3` to
`0.2.4`; Knowledge and Handoff remain at `0.2.3`. Service Desk owns the additive schema migration: it
adds the internal request-origin classification while preserving the existing request routes, public
record keys, idempotency keys and receipt behavior. Managed upgrade runs it only for the selected target
snapshot without dispatching business operations; ordinary default startup continues the module's normal
startup hooks and additive migrations.

## Limits

The path supports one explicit upgrade of an existing local instance to a compatible newer promoted
artifact, followed by the ordinary separate Restart. It does not automatically upgrade, retry uncertain
owners, reclaim work by age or saved PID, roll back, remove old generations, support multi-hop upgrades,
run request-supplied migrations, or adopt data across instances/artifacts. If native, publication,
verification or original-session evidence is incomplete, the operation retains its reservation and
materials as unresolved. Existing backup/restore remains a separate same-instance workflow. Production,
hosted, remote-backup and fleet migration are outside this local profile.

Candidate-specific qualification and limitations are recorded under the canonical SAFE-UPGRADE-001 task
and evidence; this guide describes the implemented operator contract, not a claim about a hosted or
production profile.
