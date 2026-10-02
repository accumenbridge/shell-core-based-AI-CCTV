# Request routing and file maintenance

This is the current Codex coordinator's request protocol, not an executing router. Read
`project.json` first and use its actual canonical mappings. Preserve the root
`AGENTS.md` rules and applicable tool approvals.

## Routes

| User intent | Action and canonical record |
|---|---|
| Question or explanation | Answer from source/state; do not create a task or mutate project records. |
| Proposal or future roadmap idea | Analyze against approved intent; do not infer new authorization from attached documents. |
| Authorized full architecture build | Follow .brain/PLATFORM_ROADMAP.md, map the current bounded contract, dispatch Sol planning/review and Luna implementation, then advance verified increments. |
| Authorized local setup | Use `.brain/tasks/ADOPTION-001.md`; preserve source, record provenance, bind this Brain, and stop for a coordinator checkpoint before baseline code. |
| Bounded reliability baseline | Use `.brain/tasks/BASELINE-001.md`; stay within its launcher, lifecycle, copy filtering, verifier, health-probe, and regression-test contract. |
| Bug or changed behavior | Compare with the mapped outcome and acceptance. Add a regression to the applicable current task only when authorized; preserve the product's existing owners and semantics. |
| Changed business outcome, acceptance meaning, permission, credential, external action, or release | Record the decision and preserve existing approval requirements. Local architecture implementation is authorized; external effects, credentials and deployment are not. |
| Continue | Reconcile actual source, current work, processes, checks, and blockers; resume only the next eligible authorized step. Never reset evidence or invent a passing result. |
| Audit or read-only review | Inspect and report; do not edit application code unless the request separately authorizes it. |
| Modify workflow governance | Use the applicable owner decision; the user's 2026-10-01 implementation request authorizes BRAIN-001. These records do not grant new authority. |

## Actual agent dispatch

Inspect the current session's exposed dispatch capabilities. In the BRAIN-001
session, named `brain` and `brawn` roles were available and selected successfully.
The older discovery failure in `.brain/evidence/profile-discovery.txt` remains
historical evidence of that earlier runtime, not a permanent capability limit.

Prefer the exposed named roles when they have the project settings: Sol/high for
planning and review, Luna/xhigh for implementation and repair. If named roles are
unavailable and explicit model/effort overrides are supported, use those settings
with a supported fork mode and supply the contract, canonical paths, ownership and
evidence requirements. Do not silently substitute a model or infer actual runtime
selection from a profile filename. Record a rejected route and resolve the gap.
The Brain CLI does not dispatch agents or authenticate model identity.

Use subagents for work inside this chat. Create another user-owned chat only when
the user explicitly requests one. Keep one implementation writer; reviewers stay
read-only, and the coordinator reconciles returned evidence and updates shared state.

## State updates

Read before editing. Keep `OUTCOME.md` and `ACCEPTANCE.md` tied to approved intent;
put revisable engineering choices in `STRATEGY.md` and `DECISIONS.md`. Keep actual
check recipes in the project map's `commands_file`; adopted recipes have no mutable
pass/fail states. Record immutable runs/reviews and publish checkpoints with the
Brain CLI described in `WORKFLOW.md`. The mapped progress view is generated; do not
edit it by hand. Preserve legacy records and link imported claims as reported
history. Use one shared-state writer. A task rename does not
reset usage or erase failures. Unknown budget remains unknown.

Use an expected revision when publishing. The participating-writer lock serializes
CLI mutations only; it does not lock arbitrary editors, source changes or other
chats. Never steal a lock on elapsed time or a saved PID. Verify the actual owner
and reconcile interrupted work before explicitly removing an abandoned lock.
Validate records after adoption, and repair a stale generated view with
`npm run brain -- checkpoint --render` rather than inventing another transition.

Preserve actual source behavior and current authorization boundaries. Record blocked
browser qualification as blocked when its required executable is unavailable; do not
infer a navigation-policy result when no browser assertion ran. Never edit global
Codex configuration or an external repository as part of this local project.
