# Source-grounded reliability plan — KERNEL-CI-001

Attributed planner: /root/repo_brain_architect, selected Sol/high role. Root recorded
the returned plan after actual source review; this is a plan, not execution proof.

The prior native failure expired at the first descendant marker wait before any
cancellation/timeout assertion. Its cause remains UNKNOWN. The marker wait covers
queueing, private source/compiler preparation and helper startup, whereas execution
timeout begins later. The host exposes24 logical test-file slots. Contention is a
hypothesis; do not assert it caused the historical failure.

Add bounded owning-state diagnostics before cleanup; retain admission/phase timing,
attempt identity, failure/cleanup facts, already-redacted output and marker status.
Use explicit test-file concurrency1 for the full integration baseline. Preserve test
selection, in-test concurrency and application deadlines. If a current failure
recurs, use its captured facts to justify the smallest named-owner repair.

Protocol tests currently pin the original computer's Node24.19.0 and PS7.6.5 binary
hashes. Verify the selected checkout-local host and actual Node identities instead;
retain the fixed reviewed helper hash and every protocol assertion. CI must use
ordinary -File policy preflight, orchestration through cmd/Node, read-only permissions,
pinned actions, bounded jobs and selected nonprivate evidence uploads.

Qualify Node24.19.0 locally. Automatic portable and separate manual Windows hosted
qualification jobs run npm ci then fresh npm test when their profile is supported.
Official actions/runner-images Configure-BaseImage.ps1 currently sets LocalMachine
Unrestricted; Sol's follow-up review recommends avoiding that predictable failure
on every PR. Portable CI explicitly reports Windows native CI NOT_QUALIFIED and
named platform skips. Manual Windows qualification captures actual preflight state;
an unsupported host fails BLOCKED_HOST_PROFILE before native launch. No self-hosted
runner is invented or registered. Hosted Windows policy incompatibility remains a
visible failure; no policy
changes or silently skipped native matrix. Browser/model/provider/live production
checks remain NOT_RUN unless actually exercised separately.

Acceptance: fresh build, focused native cancellation/timeout and protocol checks,
ordinary complete npm test exit0 with named skips, unchanged final source binding,
independent exact review. Full-suite success is required for this task. Hosted CI
execution status is recorded separately from configuration and local qualification.

Next core direction: choose one concrete operating profile and application outcome,
then deliver its complete artifact-to-runtime journey with identity, persistence,
essential telemetry and recovery. Do not build every possible adapter in advance.
