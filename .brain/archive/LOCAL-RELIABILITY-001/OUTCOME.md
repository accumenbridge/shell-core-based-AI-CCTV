# Current intended outcome

Status: APPROVED bounded local work; not whole-platform completion.
Outcome revision: `LOCAL-RELIABILITY-001`.
Canonical direction: user's 2026-09-30 instruction, “ok proceed,” and the accepted
source architecture in `PLATFORM_ARCHITECTURE.md`.
Authorization scope: complete ADOPTION-001, then the bounded BASELINE-001 contract.

## Useful end state

The imported Product Studio source is safely rooted in this local repository, its
provenance and canonical project records are reviewable, and the Windows full-Studio
launcher plus factory/Studio lifecycle and verification report give accurate,
fail-closed results for the bounded cases in BASELINE-001.

## Current release slice

First complete repository adoption. After the coordinator's adoption checkpoint,
implement and verify BASELINE-001. The baseline is limited to
`START_FULL_STUDIO.cmd` working-directory, call, and failure propagation; dependency
junction lifecycle and early cleanup; portable source-copy filtering; and
`tools/verify.mjs` TAP discovery, failure, spawn/signal, count, and proof-reporting
behavior. The detailed contract and acceptance cases are in the mapped task.

## Explicitly outside this outcome

The broader 0.3 platform roadmap, production adapters, deployment, real browser
qualification, Veyviz integration or changes, global Codex settings, dependencies,
version changes, credentials, and external systems are outside the current
authorization. Browser acceptance remains separately blocked by the unavailable
Chromium executable; no current navigation-policy result is established.
