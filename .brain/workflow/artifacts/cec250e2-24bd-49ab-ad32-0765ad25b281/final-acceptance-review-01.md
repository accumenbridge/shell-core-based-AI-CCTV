# SAFE-UPGRADE-001 independent final review

**Decision: ACCEPTED — exact scoped local safe upgrade.**

Reviewer: `/root/repo_brain_architect`; implementer: `/root/repo_brain_validation`. This is an independent reported source/evidence review, not an independent execution of the coordinator's browser or native fixtures, nor authentication of actor identity.

## Exact binding

- Current candidate: `8531a021a0e7c484e402a9132c107e5ce0c2968d7b18467c36adb77e35a0684f`.
- Governing raw contract SHA256: `55153a14688de5b2bf8e6c28f527eac7deef10ce1cbbba143a8937d60725116d`.
- Independently read and hashed all 251 physical maintained files: zero mismatches against the frozen manifest. The aggregate reproduced the candidate using the canonical `path.localeCompare(other, 'en')` ordering and `path + NUL + sha256 + newline` encoding. The raw current contract reproduced the governing hash.
- Finite approved ownership: 35 edit owners, six new paths. The final change from the real-journey candidate is exactly two existing test fixtures and four fixed helper-copy calls; the other 249 paths remain unchanged. Existing source, fixture-delta, and executable-equivalence reviews remain applicable.

## Current qualifying evidence

| Record | Observed result and scope |
| --- | --- |
| `411cfb26-a697-49a9-8a74-6bbf879b18a4` | Fresh build08, PASSED, original exit 0/null signal; current candidate/contract. |
| `a3c5b48c-9abf-4b32-9c2f-11d98c37d45a` | Focus03, PASSED, 70/70, zero failures/cancellations/skips/TODO, original exit 0/null signal; current candidate/contract. |
| `2167bf80-15c6-4b70-ae1c-738030713669` | Current-candidate attributed journey evaluation supported by the completed read-only executable-equivalence observation; explicit reuse of historical actual journey, no second browser/native execution. |
| `b9eda63d-7731-44b1-9ca9-f0833027b70f` | Complete ordinary full02: actual exit 0/null signal, 368 tests, 367 passed, 0 failed, 0 cancelled, 1 named skip, 0 TODO. Record remains BLOCKED solely for unqualified skipped coverage. |

The four current records' integrity digests, recipe bindings, and all nine record-owned artifact byte sizes/hashes were checked. The historical actual journey's 23 artifacts and the first failed full's two artifacts were also checked: 34 artifacts across these six records, without repinning historical evidence.

Full02 ran `npm test`, including its fresh build, from `2026-10-02T19:54:48.584Z` to `2026-10-02T20:07:16.587Z`. Saved execution metadata records the awaited original npm child close as exit 0/null signal, with identical before/after candidate and contract. Coordinator directly observed original outer session `35650` close 0/null signal in tool chunk `5034d0`; the reviewer inspected that reported provenance and saved execution/log rather than controlling the process.

The complete log contains no failing TAP cases. Both repaired existing cases passed: case99, main shutdown audit rollback and retry of the same proven owner without invented STOP; and case106, paired console without a private build-host profile reporting build requests unavailable. The only skip is case101, the owned file-symlink rejection fixture whose creation was denied with Windows EPERM. This coverage is BLOCKED, not PASSED.

- Full raw log: `.local/safe-upgrade-001/full-suite-02.log`, 85,347 bytes, SHA256 `90cdca36fc9556a61e2e426c16bcb81c68166ee65ead33ff51f93e1b556e2997`.
- Original-close metadata: `.local/safe-upgrade-001/full-suite-02-execution.json`, 690 bytes, SHA256 `c08a5bd39667e0d7011e299c2e89709ace4686e4c43c9af1c41924574eeb4c3a`.

## Actual journey and current attribution

Historical actual ordinary Chrome/native journey `e8a2ba66-e7d9-4e73-adf8-0edb273596ac` stays bound to original candidate `0c47a3ca0b606db4f9fe24c0a781bc23697eec6e53b8a01670ffce7636ba9074` and original contract `3dcb39e18df060243ec6b10af6bd27289e30a796c1a82c5d98ecf3b074606716`. Its completed scope is independently assessed in `actual-journey-review-01.md` (SHA256 `80c14c0e2d2ddedda5c00f8f36e9846fe900ffc5b85aed1526cf3cb7b68998c8`).

The one real Combined0.2.3 → Combined0.2.4 journey preserved instance `runtime-c2582154-368c-40dd-8bc1-a6a2367e2716`, complete access and domain owner facts, removed identity/revoked grant/read-only mode behavior, original receipt identities, and an actual queued job's identity and deadline. Upgrade reached SUCCEEDED/CLEAN and UPGRADE_READY before a separately confirmed target Restart. The real separate worker completed the migrated pending job within its unchanged deadline. Normal target writes, positive Stop, target backup/verification, absent-root restore, old-generation backup refusal, another separately confirmed Restart, retained old/new records, and final positive Stop were observed. Original console session `81251` closed 0/null signal; final runtime/recovery/upgrade slots were EMPTY and the target's final attempt positively STOPPED/EMPTY/helperClosed/executionClean.

Current attribution is justified by `executable-equivalence-review-02.md` (SHA256 `e416b24badc12dfbfb6701fce996cda0acac87cf63da9264f21a9163d57ee496`) and the actual read-only equivalence03 report (SHA256 `d225e0b950c2ca7fe0a45c453c2b8f5fb9902eb0e4e5654708fb925c9e8d4c32`, root exit 0, chunk `63ff0e`). That observation confirms unchanged executable source fingerprint, compiler identity, all 141 emitted output files, six operational helper bytes/pins, registered target's exact 188-entry physical inventory, and retained complete owner/source/old export/three backup/oracle facts. Incremental `.tsbuildinfo` is excluded as cache metadata; it is not an executable-equivalence claim. This is not a rerun, deadline reset, new cutover, or second live browser/native qualification.

## History and limits retained

First full `5f177b12-4e2a-407d-9435-33a29754928a` remains FAILED: original exit 1, 368 tests/365 pass/two missing-upgrade-helper fixture failures/one EPERM skip. Its two exact fixture defects were repaired without changing application behavior; current full02 passes the same cases. Earlier failed discovery/focused/launcher/observer attempts remain historical, including strict malformed-pin rejection and observer cache/manifest-self expectation failures. No successful later observation rewrites them.

The complete retained-owner and file comparisons support the stated local journey. Early saved UPGRADE_READY DOM preceded the richer response, so no missing later DOM text is invented; failed observer01 remains preserved. Actual viewport PNG/DOM evidence is used; timed-out full-page screenshot capture is not claimed. The selected known-private-value scan has its finite scope, not a universal privacy audit.

Acceptance satisfies the existing contract's core criteria and the completed full-suite required observation with explicit blocked coverage. It does not qualify the skipped symlink test, arbitrary migration/rollback after new target writes, hosted Windows, customer production, paid/external inference providers, native phones, or any broader deployment profile. Original uncertainty and historical unknown causes remain retained. No maintained source, shared Brain, application fixture, test, browser, or native process was modified or executed by this review.
