# Strategy and selected slice

Status: BOUND for the local reliability baseline.

Preserve `PLATFORM_ARCHITECTURE.md` as the accepted source architecture and keep the
whole-platform roadmap in `IMPLEMENTATION_STATUS_0.3.md` as future work. Work in this
order: complete and review adoption; pause for the coordinator checkpoint; then
implement only BASELINE-001 in the existing launcher, factory/Studio lifecycle, and
verification owners.

The baseline's smallest useful proof combines focused regressions with a fresh build,
full repository suite, verifier run, and bounded real Studio startup/health probe.
Fixtures can prove filtering and failure classification but cannot replace that live
probe. Browser acceptance is separate because the expected Chromium executable is
missing. Preserve all ABI, domain, access, runtime, and deployment semantics; no
dependency or version changes are authorized.

Budget is unknown. Record observable model/tool use and retain failures across retries;
do not invent a numeric token, attempt, or spend allowance.
