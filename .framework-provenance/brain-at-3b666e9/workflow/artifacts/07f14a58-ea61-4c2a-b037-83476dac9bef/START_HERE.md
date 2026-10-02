# Project Brain — active entry point

This Brain belongs to the independent Quadbridge Product Studio source repository.
The accepted framework authority is `PLATFORM_ARCHITECTURE.md`; the 0.3 scope and
limits are described in `IMPLEMENTATION_STATUS_0.3.md` and `docs/STATUS.md`. The
existing `analysis/` tree is supporting research, not product authority.

At each session start, read `project.json`, the mapped outcome and progress, and the
mapped `current_work` task. Follow those actual paths. Read current repository
instructions and inspect the relevant source before changing code. If a binding or
claim cannot be verified, record it as unknown or blocked instead of guessing.

The adopted file-backed workflow is documented in `WORKFLOW.md`. When
`.brain/workflow/current.json` exists, use `npm run brain -- context` to read its
authoritative checkpoint and `npm run brain -- validate` to check record integrity
and the generated view. The project map names the canonical readable progress
file. Legacy `PROGRESS.md` and `checks.json` retain historical records; their
embedded next-action text is not a second current checkpoint. Reconcile any later
legacy edits explicitly before publishing a new checkpoint.

Route every request through `ROUTING.md`. Distinguish questions, proposals, directed
changes, and explicit approvals by meaning. The user has authorized the full local
platform program. Follow .brain/PLATFORM_ROADMAP.md and the mapped current task, delivering
coherent increments with truthful evidence.

For authorized code work, complete the smallest coherent behavior in the existing
owners, run the relevant real checks, repair ordinary in-scope failures, and checkpoint
the actual candidate, results, blockers, and next action. Do not claim browser,
production, or roadmap acceptance from source review or mocked tests. Review by
the implementation agent is self-review; use a separate read-only reviewer when
independent review is required, and keep that requirement open when unavailable.

One coordinator owns shared Brain state at a time. After adoption, the root
coordinator publishes structured checkpoints and task status; workers report evidence
instead of racing shared records. The generated progress view is derived from the
current immutable event. The local profiles in `.codex/agents/` provide role
instructions and model/effort settings only when Codex selects those roles. They do
not dispatch work, authenticate approval, enforce budgets, or create isolation.

The user's 2026-09-30 full architecture build request supersedes earlier baseline-only
scope, archived under `.brain/archive/LOCAL-RELIABILITY-001/`. External deployment,
repositories, credentials, spending and global configuration remain outside scope.
Budget is unknown; do not invent a numeric limit.

The user's 2026-10-01 request to implement the proposed Brain design authorizes
BRAIN-001 repository tooling and safe adoption. It does not itself accept the
platform, expand product scope, or replace the mapped platform task. Historical
state imported into the workflow remains explicitly reported context.
