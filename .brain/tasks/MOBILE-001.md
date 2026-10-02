# MOBILE-001 Mobile browser shell and client packaging

Authorization: user on 2026-10-02 said "ok build this" for the reviewed mobile plan,
then explicitly chose "Choose the identity/API profile in a later increment".
Implement the shared-client/mobile DOM shell and attainable packaging portion now.
Android first and later iOS follows the proposed order. Real native authentication,
device proof, signing and delivery remain separate from this local increment.

The other platform coordinator explicitly handed this chat source and shared Brain
ownership at accepted checkpoint55; its agents and runtime/build work were idle.
Preserve KERNEL-CI-002 and every earlier observation as immutable history, including
the historical uncertain owner closure. Never act on that old owner by saved PID.

Design: docs/plans/MOBILE_APP_SHELL_PLAN.md and its visual companion. Named Sol/high
reviewer /root/mobile_plan_review approved a finite implementation order. Sole
Luna/xhigh /root/mobile_implementation writes the contract's source paths. Root
alone writes Brain task/atlas/events/results and observes browser/full-suite work.

Keep startShell as one session/bootstrap/workspace orchestrator. Extract only its
request and own-module scope-fencing logic to client-core. Add small presentation
and lifecycle ports; mobile-shell supplies phone chrome and responsive navigation.
Default desktop behavior and existing test meanings remain. Domain workspaces are
loaded by exact named export from build-owned static registrations.

Use fixed mobile-preview presentation through existing runtime HTTP/CLI plumbing,
retaining the same loopback listener, login cookies, grants and original-session
checks. No proxy or local-access/HTTP security edits. Packaged startup displays
Connection not configured and performs zero auth/API requests until the deferred
native identity/access adapter is provided. Do not ship a localhost fallback.

Use esbuild0.28.2 as exact development tooling. Capacitor8.5.2 core/CLI/Android/iOS
belong to an independently locked native template and generated workspace outside
root workspaces. Extend reviewed frontend closure before bundling; the bundler must
not broaden dependency access. No server implementations, stores, worker/solution
code, local config or credentials in public mobile assets. No apps/mobile-runtime
directory is necessary: compose a generated fixed entry instead.

Exact candidate paths live in workflow/contracts/MOBILE-001.json. Generated root
tsconfig.json is included because tools/build.mjs derives package references.
Additional maintained source paths require a named, evidence-grounded amendment.
No control-plane/registry/UI business/auth changes, global settings, deployment,
provider setup or external repository writes. Root owns source-state coordination.

Acceptance: desktop shell parity; neutral/Desk/Combined derived mobile UI; immediate
tenant/logout/suspend invalidation and revalidated resume; navigation/More/account;
real same-origin Desk create/read and ordinary-view parity; separate client-only
selected-assets packaging with digests and lazy/style resolution; pinned native
scaffold with bundled webDir and no remote live-reload config; packaged zero-network
unconfigured state. Build before meaningful focused tests; required full npm test
and exact independent review. Browser 360px/safe-area/keyboard/accessibility checks
must be actual observations or explicitly BLOCKED, never inferred from DOM fixtures.

MOBILE-001 can accept only the implemented browser-shell/packaging scope when actual
required source/regression checks pass. Missing Android SDK/Java/device tooling,
Android binary/device lifecycle, native secure storage, HTTPS/OIDC, signing and iOS
remain separately BLOCKED/NOT_RUN/DEFERRED. No Android/iOS delivery acceptance follows.

Managed-build integration amendment (2026-10-02): full npm test showed the fixed reviewed build-input manifest rejected mobile.css. Named independent review approved exact admission of the mobile stylesheet, assembler and three native-template files, plus complete pinned esbuild/current-platform native package hashing and private copying. The only control-plane source exceptions are apps/control-plane/src/build-inputs.ts and the staged native executable path-budget entry in build-worker.ts. Preserve unknown/secret/link rejection, original authority, worker supervision, cancellation, registry and lifecycle behavior. Add focused regressions in control-plane-build-host.test.mjs and complete fixture dependency layout in source-copy.mjs. Retain failed full-suite record16878e4f-8954-403b-a531-237dab61231a; rerun fresh build/fullfocused/fullsuite and independent review for the amended37-path candidate.

Evidence reconciliation (2026-10-02): retain build/focused as required passing recipes. Following the adopted KERNEL-CI-002 pattern, the complete npm test is a required observation because its one host-denied owned file-symlink EPERM case remains BLOCKED coverage. Final independent qualification review must inspect actual original close exit0, exact zero failed/cancelled/TODO counters, unchanged candidate, and no skipped case beyond that named environment case. This preserves the original named-skip allowance; an observation or source-only review cannot qualify a failed suite. Record all exact counts and the skipped coverage without alteration.
