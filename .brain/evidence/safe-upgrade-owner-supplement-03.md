# SAFE-UPGRADE-001 single test-owner supplement

Reviewer: /root/repo_brain_architect (Sol/high). Source inspection only; no maintained edits, builds, tests or Brain mutation. This recommends a forward-only coordinator amendment, not implementation acceptance.

Current canonical task/contract and approved work-order02 authorize33 edit owners, six new paths and a251-path candidate. The approved Desk module/package/product change0.2.1→0.2.2 is explicit in work-order02; the current product source already declares product0.2.2 and selected Desk module0.2.2.

Add exactly one existing edit owner:

34. tests/ui-contributions.test.mjs — baseline SHA2568e1b91847cf33cec6c92d7e61d2818c63d1a8032615c6e4174177e1ad0186555; existing path, not new.

Its test 'current source import preserves the captured old product identity and is idempotent' calls loadSourceSnapshot(ROOT), then imports that actual current source into the store. Line81 currently asserts currentDesk.version==='0.2.1'; the approved current release is now0.2.2. Change only that expected current source version to0.2.2. Preserve every surrounding assertion: priorDesk product/module0.2.0, exact oldBefore equality after both imports, exact current definition equality and unchanged version count on reimport. This retains actual immutable old-version coexistence/idempotence coverage rather than rewriting historical fixture identities.

Do not change tests/shell-regressions.test.mjs: its0.2.1 value belongs to a synthetic local catalogue fixture, not loadSourceSnapshot current release. No additional source owner, product version change, test matrix or host behavior is requested.

Coordinator should preserve the old33-owner contract/work-order snapshot, update the finite edit grant to34 and add this existing test to the fixed focused recipe. The full candidate remains251 paths because the test is already included in allowedPaths/fingerprint. Rebind final source/contract qualification after the amendment; older records remain historical. Fresh build precedes focused execution and final npm test as already required.

Recommendation: APPROVED_FOR_FINITE_OWNER_AMENDMENT. Delivery/runtime/browser/final acceptance remain pending.
