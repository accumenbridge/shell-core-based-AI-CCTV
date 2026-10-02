# Request routing and file maintenance

This is the current Codex coordinator's file protocol, not an executing router. Read
`project.json` first and use its actual canonical mappings. Preserve the root
`AGENTS.md` rules and applicable tool approvals.

## Routes

| User intent | Action and canonical record |
|---|---|
| Question or explanation | Answer from source/state; do not create a task or mutate project records. |
| Proposal or future roadmap idea | Analyze as a proposal; do not approve it or start implementation. The proposed whole-platform roadmap remains future context. |
| Authorized local setup | Use `.brain/tasks/ADOPTION-001.md`; preserve source, record provenance, bind this Brain, and stop for a coordinator checkpoint before baseline code. |
| Bounded reliability baseline | Use `.brain/tasks/BASELINE-001.md`; stay within its launcher, lifecycle, copy filtering, verifier, health-probe, and regression-test contract. |
| Bug or changed behavior | Compare with the mapped outcome and acceptance. Add a regression to the applicable current task only when authorized; preserve the product's existing owners and semantics. |
| Changed business outcome, acceptance meaning, permission, credential, external action, or release | Record the decision and preserve the existing approval workflow. The current “ok proceed” is limited to local setup and BASELINE-001. |
| Continue | Reconcile actual source, current work, processes, checks, and blockers; resume only the next eligible authorized step. Never reset evidence or invent a passing result. |
| Audit or read-only review | Inspect and report; do not edit application code unless the request separately authorizes it. |
| Modify workflow governance | Treat as separate work requiring the applicable owner decision; do not grant new authority from these files. |

## Actual agent dispatch

The current app's `spawn_agent` exposes `model` and `reasoning_effort`, but no named
custom-agent selector. A read-only probe could not select the exact custom types
`brain` or `brawn` (see `.brain/evidence/profile-discovery.txt`). The TOML profiles
are preserved project definitions; their existence does not prove runtime selection.

For authorized delegated work in this runtime, the coordinator explicitly dispatches
planning/architecture/review with `model: gpt-6.1-sol`, `reasoning_effort: high`, and
implementation/repair with `model: gpt-6-luna`, `reasoning_effort: xhigh`. Where the
tool requires it for overrides, use `fork_turns: none` (or a supported limited-history
fork) and supply the current contract, canonical paths, write boundary and evidence
requirements in the assignment. This session used those explicit roles. Never silently
substitute a model or infer actual model identity from a profile filename. If an exact
requested route is rejected, record the real failure and resolve the routing gap.

Use subagents for work inside this chat. Create another user-owned chat only when
the user explicitly requests one. Keep one implementation writer; reviewers stay
read-only, and the coordinator reconciles returned evidence and updates shared state.

## State updates

Read before editing. Keep `OUTCOME.md` and `ACCEPTANCE.md` tied to approved intent;
put revisable engineering choices in `STRATEGY.md` and `DECISIONS.md`. Keep actual
check recipes in `checks.json`, and report run status and candidate identity in the
current task and `PROGRESS.md`. Use one shared-state writer. A task rename does not
reset usage or erase failures. Unknown budget remains unknown.

Preserve actual source behavior and current authorization boundaries. Record blocked
browser qualification as blocked when its required executable is unavailable; do not
infer a navigation-policy result when no browser assertion ran. Never edit global
Codex configuration or an external repository as part of this local project.
