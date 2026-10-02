# ADOPTION-001 — import and bind the repository Brain

Status: COMPLETE. This records the historical adoption checkpoint before baseline
code started. BASELINE-001 has since been accepted; current state is in PROGRESS.md.
Authorization: user's 2026-09-30 “ok proceed” for local setup and bounded reliability
work.

## Work completed

- Safely imported `C:/Users/Lenovo/Downloads/Quadbridge_Product_Studio_v0.3_Full_Platform_Kernel.zip`, stripping the single `Quadbridge_Product_Studio/` prefix.
- Recorded original archive SHA-256 `7669f93c4e6f40574cbb9bcd5c15f6f351342ebc25f433fd6258f42157136b8f` and per-file imported hashes in `.brain/evidence/adoption-source.json`.
- Verified 318 imported files / 2,401,008 bytes against decompressed ZIP entries. Preflight found no unsafe paths, case-insensitive collisions, preexisting targets, or symlink entries. Source ZIP remains unchanged.
- Read source `AGENTS.md`, `README.md`, `PLATFORM_ARCHITECTURE.md`, and `docs/STATUS.md` before editing. Original guidance remains intact; only a short Brain entry was appended.
- Bound the project map, outcome, acceptance, strategy, decisions, progress, check catalogue, and policy. Added this task and the next bounded task.
- Added local `brain` and `brawn` custom-agent profiles with the requested model/effort settings. No global Codex configuration was changed.
- Adapted the `Codex_Repo_Brain_No_Installer.zip` seed (SHA-256 `5478568defa3ac27b8137d4b63bcc482fe9bcdb50d8b5b132e2b554d129a1826`) for this project; no supplied adoption or installer instructions were executed.
- Extended root ignore rules for `analysis/`, generated root evidence/output, and TypeScript build-info. `.brain/` and `profiles/` remain trackable.
- Initialized a local Git repository only. No remote, global identity/configuration, commit, or stage operation was performed by this task.

## Verification and limits

All four bound JSON files parse; both agent TOML files parse; all non-null project,
check, policy, and task paths resolve. The source import count and hashes are recorded
for independent coordinator review. No application build or test was run. The
required Chromium executable is absent, so browser checks remain separately BLOCKED;
there is no current browser assertion or navigation-policy result.

## Historical handoff — completed

Root coordinator owns shared progress/task status after adoption. It should audit Git
identity and the exact trackable tree, stage only the reviewed adoption files, record
the staged tree as the baseline diff base, and run fresh-session read-only discovery.
That checkpoint, baseline execution and independent review have now completed.
Use `.brain/PROGRESS.md` and the accepted BASELINE-001 record for current state;
do not repeat this historical handoff.
