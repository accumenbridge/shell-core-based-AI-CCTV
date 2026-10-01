# Repository Brain workflow

The Brain preserves approved intent, bounded task contracts and inspectable results for development work. It lives outside product runtime packages and exported application snapshots. The CLI uses local files and Node's standard library; it does not run checks, dispatch agents, authenticate approval or change tool permissions.

## Read current work

```text
npm run brain -- validate
npm run brain -- context
npm run brain -- context --task BRAIN-001 --json
```

Read `project.json` for the actual canonical mappings. `.brain/workflow/current.json` identifies one immutable checkpoint event. `.brain/CURRENT.md` is the generated readable view of that event. The platform task and any maintenance task are distinct: completing Brain tooling does not complete the platform.

Legacy `PROGRESS.md`, `checks.json`, task prose and evidence remain historical source material. Imported state is explicitly reported state with provenance, not freshly executed qualification. Follow the generated checkpoint and its references for the adopted workflow. If another session edits a legacy record directly, reconcile that change before publishing a new checkpoint; it is not automatically authoritative over the checkpoint.

## Roles and authority

The coordinator interprets the user's request, assigns work, reconciles results and publishes checkpoints. Brain plans and reviews; Brawn implements the assigned scope and reports evidence. Select only agent capabilities actually available in the current session. The preferred project roles remain Sol/high for planning/review and Luna/xhigh for implementation. A profile or a saved model name does not establish which model actually ran.

User and tool authorization remains external to these files. Contract authorization references and independent-review identities are attributed records; the CLI checks consistency, not authenticity. A passing validator is not product acceptance. Keep existing architecture, owner data, access, transaction, immutable-runtime and approval rules intact.

## Task contracts and checks

Structured contracts under `workflow/contracts/` identify the task, source task prose, authorization reference, assigned owners, allowed source files, exclusions, prerequisites, criteria, required check recipes and review requirement. Keep the deliverable finite. Changes to acceptance meaning require the applicable user/owner decision and a new recorded contract revision.

`allowedPaths` is the explicit source-file manifest used to fingerprint the candidate; it is not a filesystem permission grant. Coordinator-owned events, runs, pointers and generated views have the fixed operational scope recorded in the task and are excluded from that manifest. `requiredRecipeIds` requires qualifying passes. `requiredObservationRecipeIds` separately requires recorded actual invocations, so the required full suite can preserve unrelated blocked gates without claiming those gates passed. Imported or proposal contracts cannot acquire fresh `ACCEPTED` status.

`workflow/recipes.json` contains definitions only. Run the relevant reviewed command through the ordinary tools, then record its actual result. Do not copy historical pass states into recipes. Build edited source before testing, and run the repository's required `npm test`. Keep skipped, blocked, deferred, unknown and unrun gates visible. Do not grow an unrelated edge-case campaign or rerun a duplicate full suite without a concrete reason.

## Immutable evidence

```text
npm run brain -- record --input .local/brain-input/run.json
```

Prepare a record draft using the documented CLI schema. Bind a run or review to the exact task, contract and candidate. The recorder creates a new record identity, copies supplied artifacts into its own immutable directory, and records their hashes. Retain failed runs as well as successful ones. Later source captures do not establish which bytes an earlier run tested.

Capture `context --task <id> --json` before running a check and keep its candidate object. Confirm that candidate is unchanged afterwards, then supply it in the run draft. Omitting `candidate` only captures the files at recording time; that default cannot prove which bytes an earlier command tested.

Run drafts use `schema: "brain.record-input.v1"` and these fields:

| Field | Value |
|---|---|
| `kind`, `taskId`, `recipeId` | `"run"` and the exact contract/recipe IDs |
| `candidate` | The captured `{files: [{path, sha256}], digest}` object |
| `status`, `exitCode` | `PASSED`, `FAILED`, `BLOCKED`, `NOT_RUN` or `UNKNOWN`; actual numeric exit or `null` |
| `environment` | A flat map of string values, such as Node version, operating system and process-local test exclusions |
| `counts` | Optional nonnegative `tests`, `passed`, `failed`, `cancelled`, `skipped`, `todo` counters |
| `artifactPaths` | Repository-relative paths to the exact saved outputs to copy |
| `provenance` | `{kind: "reported", reference: "observer and actual tool/run reference"}` |
| `limitations` | An array of explicit scope limits; use `[]` when none apply |

Review drafts use the same schema, `kind: "review"`, task/candidate/provenance/limitations, and explicit `reviewer`, `implementer`, `independence`, `outcome`, and `scope`. A review identifies the actual separate reviewer and exact candidate. The CLI never supplies an independent-review identity on the user's behalf.

Recording evidence does not execute a command or independently prove a reported exit code. Describe the observer, command, environment, scope and limitations honestly. Distinguish a source/component review from native, browser, provider or production execution. Record external tool failures and missing evidence without fabricating zero counts or success.

## Checkpoint publication

```text
npm run brain -- checkpoint --input .local/brain-input/checkpoint.json --expected-revision 0
npm run brain -- checkpoint --render
```

Use the revision returned by `context`, not a guessed value. The initial revision is zero before adoption. Publication obtains an exclusive participating-writer lock and rechecks the expected revision. It writes complete immutable event material before atomically replacing the current pointer, then generates the readable view. A stale revision is rejected; reread and reconcile rather than blindly retrying the same edit.

Checkpoint input uses `schema: "brain.checkpoint-input.v1"`, a `reportedActor`, a
`platformTask` state and an optional `maintenanceTask` state. Each state contains
`taskId`, `status`, `candidate`, `runIds`, `reviewIds`, `blockers`, `nextAction` and
`gates`. Preserve the other task's state when updating one task. A gate contains
`id`, `status`, `evidenceRefs` and `limitations`; its cited status is reported
context and cannot replace the acceptance checks on actual run/review records.
An imported state also has `importProvenance` with an immutable `sourceRef`,
`sourceSha256`, `originalStatus`, `observedAt` and `limitations`. Use
`IMPORTED` or `REPORTED_IN_PROGRESS` for that context. Normal task progression is
`READY` to `IMPLEMENTING` to `REVIEW` to `ACCEPTED`; keep any `BLOCKED` or `DEFERRED`
state and its reasons explicit.

If the pointer was committed but view generation failed, the command reports that outcome. `validate` detects the stale view; `checkpoint --render` regenerates it without creating another transition. The legacy progress file is never the rendering target.

The lock serializes cooperating CLI writers only. It does not prevent direct editors or other tools from writing source. A lock left by interruption is retained; do not infer owner termination from age or a saved PID. Inspect the operation and reconcile with its owner before explicitly removing a known abandoned lock. The CLI never steals it automatically.

## Acceptance

An accepted task must reference the required qualifying results and required review for the same task, contract and current candidate. Missing, stale or failed evidence does not qualify. A review labelled independent is still attributed reported evidence and must be supported by the coordinator's actual separate review. Imported platform history cannot qualify a new task.

## Limits

This is a local coordination protocol with conservative path checks, not protection against a hostile filesystem owner, a distributed scheduler, a hard budget system or a guarantee of power-loss durability. There is no daemon, arbitrary command runner, automatic agent dispatcher or automatic external action. The coordinator remains responsible for context, authorization and truthful decisions.
