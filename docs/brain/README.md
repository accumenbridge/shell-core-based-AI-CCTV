# Reusable project atlas

The atlas gives a project one inspectable map from intended outcomes to journeys, screens, architecture, contracts, milestones, stories and delivery observations. It is a planning layer alongside the existing evidence Brain. The complete intended operating model is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Use the current project map

From the repository root:

```text
node tools/brain-atlas.mjs validate --root .
node tools/brain-atlas.mjs render --root .
```

Open `.brain/atlas/PROJECT_ATLAS.html`. It is an offline, read-only snapshot. It has no build, command execution, network or filesystem authority. Regenerate it after changing the profile or refreshing evidence references. A warning about a changed source is a request to reconcile the plan; it does not prove that delivery failed or passed.

In this repository, continue using `npm run brain -- context` and `npm run brain -- validate` for the authoritative execution checkpoint. Those commands belong to the separately installed evidence Brain; atlas initialization does not install them. The atlas does not replace `.brain/project.json`, task contracts or immutable workflow records. A previously accepted milestone in this profile is attributed historical context, not a fresh acceptance of the working tree.

## Execution readiness and current-work projection

The workflow CLI now reports record **integrity** separately from **execution readiness**. Use `npm run brain -- preflight` before beginning platform implementation. JSON callers can use `npm run brain -- preflight --json`. Preflight returns a nonzero exit when execution records are invalid or the current work is not ready; its reasons identify the plan/task links that need attention. `context` and `validate` also show readiness, but a valid integrity result does not by itself mean the plan is ready.

When an atlas exists, readiness requires a structurally valid profile, an accepted focus with observable acceptance criteria, a safely readable authorized canonical task matching the current platform checkpoint, and a direct focus reference to that exact task file. It also checks pinned source references on the focus and its `dependsOn` prerequisite closure. Drift or an unpinned reference in that governing set blocks a new or resumed platform transition to `IMPLEMENTING`; reconcile the plan explicitly and inspect it again. Drift in unrelated future or historical references remains visible in atlas inspection but does not block the selected work. Structural profile errors remain a project-wide blocker. With no atlas, preflight explicitly reports `LEGACY_COMPATIBLE` and preserves the previous workflow behavior without plan governance.

Only entry into platform `IMPLEMENTING` is gated. Existing in-progress checkpoint updates, `BLOCKED` and `DEFERRED` reporting, historical results, evidence recording and source reconciliation remain available when readiness fails. This gate checks declared links and current bytes; it does not determine whether the architecture is correct, dispatch agents, run checks or authenticate reported evidence.

The managed controller composes the same assessment with its existing validated control profile: that profile must include the current focus in `planNodeIds`. A missing or malformed managed profile remains visible in the read-only state as an observation-only limitation. Preparation is refused before candidate/order effects, and starting a prepared order repeats the check. A prepared order also remains bound to its complete source-inspection snapshot: any inspected source change after preparation can invalidate that order and require a fresh prepare, even when the changed reference is unrelated to the focus.

The default atlas CLI render and the live `/atlas` view project the canonical task and checkpoint beside the atlas focus, including an explicit mismatch state. Calling `renderAtlas` without execution data remains a standalone planning view and says that canonical execution data was not supplied. The planning focus and the execution checkpoint remain separate authorities.

## Reuse with another project

The tools use only Node built-ins. For atlas-only use, copy `tools/brain-atlas.mjs` and both guides (`docs/brain/README.md` and `docs/brain/ARCHITECTURE.md`, together in the same directory) into the intended new project. For the evidence workflow and its canonical readiness projection, copy `tools/brain.mjs`, `tools/brain-core.mjs`, `tools/brain-readiness.mjs` and `tools/brain-atlas.mjs` together, plus the workflow records described above. The atlas-only renderer remains usable without the evidence workflow and will explicitly show when canonical execution data was not supplied. After installing the intended tool set, initialize that explicitly selected root:

```text
node tools/brain-atlas.mjs init --root PATH_TO_PROJECT --project-id my-project --title "My project"
node tools/brain-atlas.mjs validate --root PATH_TO_PROJECT
node tools/brain-atlas.mjs render --root PATH_TO_PROJECT
```

Initialization refuses to overwrite an existing profile. A blank profile is deliberately unplanned. Fill its vision, real source references and linked nodes; do not copy Quadbridge's completion claims. Relative paths belong to the selected root. This command is a user-invoked local file operation, not a grant for an agent to access unrelated projects.

To adopt the atlas in that project's agent workflow, add an entry instruction that reads this guide and the profile, validates relevant source references, and reconciles planning focus with that project's own task authority before implementation. Copy the procedure, not Quadbridge's task paths or approvals. Initialization alone does not activate an agent or scheduler.

## Profile conventions

The versioned profile lives at `.brain/atlas/project.json`. Its `projectId` identifies the project and `planRevision` identifies this planning revision. Optional `focusNodeId` points to the intended next planning focus; it is not a scheduler and must agree with the current execution task before work starts. Core priority expresses importance, not simultaneous selection. Node kinds are outcome, journey, screen, component, contract, milestone, story and backlog. Each has an owner, intent status, priority reason, dependencies, related nodes, source references and acceptance statements. Accepted intent means an intended requirement or direction is established; it does not mean the node is implemented.

Observations reference nodes separately and carry source provenance, candidate identity when known, observation time and limitations. Source inspection may report implementation presence. Verified observations require execution provenance, candidate identity and evidence references, but the validator still cannot authenticate the truth of an author's claims. Missing observations mean unassessed, never complete.

Source references may pin SHA-256 digests. Inspection compares those pins with current files. Dependency cycles and broken or ambiguous references are invalid; changed source files are drift warnings. The page separates structural validity, source inspection and planning gaps. Missing acceptance criteria, missing milestone stories and proposed screen designs remain visible. These checks do not prove design quality, estimate completeness or execute acceptance criteria.

Each inspected page records its project identity, complete profile digest and inspection time. A supplied inspection must match the profile and its source checks. This binds displayed results to the inspected data; it does not authenticate claims or make an offline page update itself. Archive meaningful profile/page revisions and link verification records to that exact archived page. The current generated page remains a replaceable convenience view.

Rendering refuses to replace an output belonging to another project or a legacy generated page without identity metadata. For a known legacy page, first inspect and archive it under a unique name in `.brain/atlas/history/`, then render into the now-absent `PROJECT_ATLAS.html` path. Preserve the profile and old evidence. Never remove an unknown output to bypass a refusal.

Retrospectives connect evidence to an improvement hypothesis, owner, action and future measurement. Unknown baseline and target measurements remain null. Set real targets when decided; do not infer them from test counts.

## Current limits

The initial atlas supports one explicit repository root per invocation. It can be reused independently in multiple repositories; a portfolio scheduler and cross-project execution are future work. It does not automatically create wireframes, edit application source, dispatch agents, run checks or merge changes. The roadmap in the architecture guide defines those next capabilities.

The Quadbridge profile captures the core program and representative stories. Detailed future UI designs remain proposed and incomplete. Its source digests make later divergence visible; an agent must still reconcile semantic changes before using it to prepare work. The root `AGENTS.md` now includes this planning entry. Following those instructions remains an agent responsibility; no background controller is installed.
