# Live Brain oversight and managed proposals

This local increment adds an always available project view and a bounded managed-candidate workflow. The existing offline atlas stays read-only. The console reads the actual canonical checkpoint and inspects the current atlas sources on each refresh; it does not rewrite either authority.

## Open a project

```text
node tools/brain-live.mjs --root . --store .local/brain-control
```

Open the printed local access URL. The token authenticates this console; keep it private. The service listens only on 127.0.0.1. Close it with Ctrl+C. The default is observation only. It shows agreed outcomes, the current canonical task, next action, evidence qualification, source drift, unresolved planning gaps, architecture links and proposed screen designs. A disconnected view says it is no longer live.

The checkpoint can be structurally valid while its candidate remains unqualified. Historical atlas observations are labelled separately. No source hash warning proves product failure or acceptance, and no test count is converted to a completion percentage.

## Managed execution profile

Managed work is opt-in per canonical task. An owner reviews `.brain/control/<TASK-ID>.json` together with the task contract, approved atlas nodes, complete input closure and fixed check scripts. The file is not a permission grant to an external service. Example:

```json
{
  "schema": "brain.control-profile.v1",
  "taskId": "DEMO-001",
  "inputPaths": ["index.html", "build.mjs", "check.test.mjs"],
  "checks": [
    {"id": "build", "kind": "build", "script": "build.mjs"},
    {"id": "behavior", "kind": "test", "script": "check.test.mjs"}
  ],
  "previewPath": "index.html",
  "planNodeIds": ["SCREEN-1"]
}
```

The contract supplies exact editable paths and criteria. Every editable path must be in `inputPaths`. Verification scripts must be captured inputs outside edit scope. Project authority, agent instructions and controller records cannot be proposed edit targets. Linked plan nodes must have accepted intent and observable criteria. A complete input closure is an owner responsibility; the tool cannot infer every dependency of an arbitrary application.

To enable an installed Codex adapter, supply its executable explicitly:

```text
node tools/brain-live.mjs --root PATH_TO_PROJECT --store PATH_TO_PRIVATE_STORE --codex PATH_TO_CODEX_EXECUTABLE
```

An optional `--model` selects an available model. The adapter uses local App Server stdio, an ephemeral read-only conversation, denied approvals and a structured edit response. It does not attach to existing desktop chats. All requested source context is supplied with the work order; unexpected tool activity causes interruption. This is a proposal-only coding profile, not unrestricted autonomous shell execution. The controller applies validated changes itself.

No framework installation or global configuration change is performed. Protocol documentation: https://learn.chatgpt.com/docs/app-server . Generated schemas and actual transport observations must match the installed CLI version.

## The human workflow

1. Read the current outcome, architecture, proposed screen states, source drift and evidence limitations.
2. Prepare an order. It captures project/root identity, plan and checkpoint revisions, contract/profile digests, exact inputs and allowed edits.
3. Review that scope and start the proposal. The controller copies inputs to an isolated candidate directory. Original project files stay unchanged.
4. Observe actual activity. The entire edit proposal is checked before writes. The fixed build runs before Node tests; logs, exits and candidate identities are captured by the controller outside the candidate.
5. Review the candidate preview and check results. Preview content runs in an opaque iframe sandbox with no console token or API authority.
6. Accept the exact candidate with a review note, or request a direction change. Acceptance is local to the managed candidate; it does not merge source, publish a release or mark the canonical platform task accepted.

Normal actions reject stale project/controller/candidate bindings. Pause and direction changes identify the current order and controller revision; they remain usable if project source changed. A direction change invalidates the running proposal, records the requested direction and requires a newly prepared order. Late output cannot be applied. `STOPPING` is a request, not an acknowledgement and not rollback.

The checks execute only fixed Node scripts through `process.execPath`, without a shell or browser-supplied argv. They have a 60-second operational timeout and bounded output. This local developer profile does not supervise arbitrary process descendants: forced check interruption retains UNKNOWN rather than claiming a complete process-tree stop. UNKNOWN work must be reconciled before further dispatch. Normal check scripts must be reviewed, bounded and suitable for this profile.

## Evidence and recovery

The controller store has a project/root binding, exclusive participating-writer lock and an append-only hash-linked event sequence. Records separate observed process results from model text. Source changes during verification prevent qualification. Test skips, cancellations, missing TAP counts or failed checks cannot become a clean pass.

Restart reconstructs events and retains interrupted work as UNKNOWN; it never automatically replays a dispatch. A lock surviving a crash is deliberately retained. Inspect and reconcile the actual owner before explicitly removing an abandoned lock. The service never treats elapsed time or a saved PID as termination proof.

The store is outside the managed candidate and is not an allowed model edit target. Hashes establish consistency, not authenticated provenance against a hostile filesystem owner. Read-only Codex settings, project envelopes and patch restrictions do not establish a hostile-user sandbox or prove that all filesystem reads are isolated. Cross-project decision/store reuse is rejected. Use independently reviewed execution isolation before enabling untrusted code or stronger security claims.

## Existing evidence workflow repairs

The file-backed Brain now considers all matching failed, blocked or unknown required runs and rejected/blocked reviews, including records omitted from checkpoint selections. Observation-only suite failures remain observations. A matching earlier pass cannot conceal an unresolved negative.

A new positive run or review may carry `resolution: {"recordIds": ["existing-record-id"], "reason": "actual diagnosis and disposition"}` with supporting artifacts. The recorder validates the same task, contract, candidate and evidence kind, plus recipe/digest for runs or reviewer/implementer/scope/independence for reviews. The selected resolving record must be referenced by the checkpoint. Original failures remain unchanged. Resolutions remain attributed reports, not authenticated human identities.

Unbound tasks can declare future files. Context returns `candidate: null` and `missingPlannedPaths` until those files materialize; validation still checks lexical confinement and existing ancestor types/symlinks. Bound, REVIEW and ACCEPTED candidates require their complete file manifest. Intentional deletion in the existing v1 evidence manifest requires a revised contract; the managed proposal layer separately represents deletions explicitly.

## Scope of qualification

Automated fixtures demonstrate controller state, proposal boundaries, real fixed Node checks, stale decisions, project separation, missing planned files and contradictory evidence. Actual browser and installed App Server execution are separate observations. A successful transport handshake is not a successful coding run; a successful coding run is not browser acceptance. Full project UI design, portfolio scheduling, process-tree isolation, automatic source integration and defect-free software guarantees remain outside this increment.
