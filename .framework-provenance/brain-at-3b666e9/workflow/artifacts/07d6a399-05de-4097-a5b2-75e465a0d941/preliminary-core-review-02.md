# EXTENSION-001 preliminary stable core source review02

Prepared 2026-10-02T09:45:32.877Z by /root/repo_brain_architect, user-requested Sol/high independent reviewer. Sole Luna is application writer; root owns Brain/browser. No maintained source, shared Brain, build/test/native/runtime/browser mutation.

Disposition: SOURCE_CLEAR_FOR_UNCHANGED_FOCUSED_RETRY; task acceptance remains OPEN. Physical232 files all match held build06 candidate fd404c7993497c2016887f01676574c2f1f3daad4a323f7105a874b99b980e9b; mismatches=0; final recapture changes=0. Physical contract SHA256 70eb2bb9895a68b0e80d403d2e63407840811d457345fb44b627d438fda75a47. Finite41 is edit scope; larger232 is fingerprint only.

## Reviewed core behavior

- Shared closed UI contribution descriptors and solution bindings are validated at SDK, composition, catalogue/build and backend boundaries. Workspace ownership comes from full declaring source maps (service-desk owns desk.requests), not inferred namespace. Only exact statically selected named UI exports are loaded; optional omission is explicit. Selected metadata equality, exact binding duplicates and eight/workspace bounds remain.
- Fixed source copy accepts the exact solution ui.json leaf, not arbitrary JSON. Build loads mapping against the complete source catalogue, serializes accepted bindings into generated startup, and frontend closure follows reviewed literal selected imports/assets. Offline fixed QBUiContributions precedes QBComposition and supplies the previously missing validateUiContributionDescriptors binding. No new offline filesystem/build/runtime privileges.
- Each mounted contribution now receives its own section child. Failing siblings only replace their own child; shared slot content is not cleared per binding. Aborts/disposers are tracked separately and clear on workspace/tenant/session replacement; post-loader and scoped request callbacks check captured current scope. read-only api.get is from the declaring module via existing client-core, preserving server authorization. Actual controlled sibling/tenant regression passed in recorded focused03. This is trusted same-origin code, not isolation from malicious plugins.
- Knowledge reference search reuses the owner search path with bounded25 rendered indexed matches and original signal/generation fences; Desk recent cards use own GETrequests and render at most5. No domain database exposure/backend change/migration/new grant. Static shell.css addition is appropriate fixed grid/responsive layout; no .style or .remove workaround/harness edit. Earlier pre-admission stylesheet deviation remains preserved and is not retroactively authorized by this review.
- Current source product versions now Desk0.2.1, Knowledge/Combined0.2.3 with exact coherent module/runtime/lock references. Actual source-import coexistence/idempotence test passed while retaining the prior immutable Desk0.2.0 definition. Artifact test sets initialDeskProductVersion0.2.0 only before capture in the deliberate live-rebuild case; other callers use current source. This does not claim old module-code execution. The two added current-source tests select actual Desk version/expect0.2.1; native deadlines/protocol/cleanup assertions are unchanged.

## Actual qualification and failures

Saved build06 logger closed exit0/nullsignal with exact before/after candidate and fresh compilation. Saved focused03 logger closed exit1/nullsignal:97 tests,95 passed,2 failed,0cancel/skip/TODO; source unchanged. The listed UI/metadata/copy/coexistence/selected-frontend cases in this invocation passed; offline binding correction is source-reviewed here, not separately rerun by this reviewer. Focused03 remains FAILED, not a qualifying full focused pass.

- Case5 Windows file-lock cleanup: waitForMarker failed at test line208 after its unchanged10000ms observation. The test never reached file lock creation, cancellation or expected UNKNOWN assertions. Neither the thrown error nor TAP includes the build phase/native startup cause. Do not attribute it to BUILD_TIMEOUT, contention, policy, UI source, or a completed termination proof. Failed exact attempt cause is UNKNOWN.
- Case8 factory output tampering: LocalBuildWorker.create rejected before admission with generic BuildExecutorUnavailable. Its source has separate Windows path-budget handling and a catch covering assertWindowsBuildHost plus privateToolchainDigest, so TAP cannot distinguish path/profile/executable/policy/preflight timeout/compiler cause. No tampering assertion was reached. Do not describe it as a proven policy failure or change the host guard.
- Root recorded one ordinary unchanged host preflight afterward available=true at7.6.5/RemoteSigned (0.49s). That current availability observation does not diagnose the failed attempt or establish the private copied compiler identity. It supports one bounded unchanged exact focused retry after original close; no source, timer, policy/profile override or new matrix is needed. Preserve failed record/history; qualify only actual matching retry if it closes normally and passes.

## Open scope

No substantive new core source blocker found in this finite review. Original complete browser, frozen full npm suite, actual native/core artifact journey and independent final record validation remain pending. No current task ACCEPTED verdict, hosted/provider/MCP/native-phone/untrusted-plugin/customer-production claim. Read-only final record/artifact review will bind eventual frozen source; this report is preliminary held-source/failure disposition.

## Exact inspected41 source hashes

- packages/contracts/src/index.ts: f246c861f2ecd5916e072ebdc71b2d116c81f19ebb55e362b120ff3a238b2d0c
- packages/contracts/src/ui-contributions.ts: f194ed9e049adacc6b666f29bd233377307f64fff3324410dd02c65e2fddb112
- packages/backend-host/src/index.ts: e9cdcd0455fe1ae7af574bee7f9c378d368f983ca0cf7cdb0ed2f870f104c7fa
- packages/composition/src/index.ts: c897ed5639e3a255de83ff96ca37697d7e1ab19c5015e5d137751f841a629276
- packages/module-sdk/src/index.ts: f6f8a68254f695d07fa08b8ba3c2f7e5af5df18f0c8b3f0617e21e16e80d213d
- packages/studio-model/src/index.ts: bb73726b2c7e866442ec84592cec4bb06ebb7f94675c337482a781262ccb2e88
- packages/web-shell/src/index.ts: a5fa992459c5acf6429b8bc3169c3355616e1f1fd7d11b13f16780ab318e8848
- apps/control-plane/src/build-inputs.ts: aa43159e1f688abfdbd99ed8c8abe171a251e863f7e77e55a68fc769e8e2a423
- tools/build.mjs: 35b9ccd2b23bf8a7d80eb5c04c732f53fc4d351a309d4f2d1e09724efd5b73c6
- tools/frontend-closure.mjs: 7f7999cdf60eb80558aa9aaade8e5566c102414be670d370b94db4a4cc8cc45f
- tools/studio-catalogue.mjs: 9f0dc5198ceee5468fab3dbcfe305e153c25d6862b2ed15e6ea62583a1c809c7
- modules/knowledge/src/ui.ts: 6cda83eb31f559e2c1f2329e96dc51c40f233225078046f68b39f69c833ac9ab
- modules/knowledge/src/ui/reference-search.ts: 62ca400e6c5a2fb8ed31da013c91610399c97ae4b02434b645497c5798a4ffe2
- modules/service-desk/src/ui.ts: 26a67fd72c54878a8a16a0a08dd1adcc644798e8fbee0d0a9d5c5146763cf864
- modules/service-desk/src/ui/recent-requests.ts: cd9637f5099618cab57c4e15c1f72e48687d04c65417f2c2f2db4d69e8988b54
- modules/knowledge/module.json: 54940b0135e0ab46c4cfe5d92ed4b897355fed536481fbc8f3b1615353e3abaf
- modules/knowledge/package.json: 327e28215f63e178dda57e043447eeab4740f778faf143eea58f093658aec283
- modules/service-desk/module.json: 6f1cb2e2fde1c008a30fb6cfac14d17b1ecf208a3f5baa66d4b3092542c2578c
- modules/service-desk/package.json: aa6bcb33cee0c0a57f98ee3f78728ca67684622a3aa3c4447d23043bb5f20c36
- modules/handoff/module.json: cced127c2365552d607c3490c67a77dc91b87dfd84aa750b919e7cbd6fc93e06
- modules/handoff/package.json: 56ffea0209fe6340cfd73d57f86ef2d917951c6ce4aeb6e0b144abf99e5d6992
- apps/runtime/package.json: 0f0d90a539c5d741ce80f91dcf0eb686981c8e31df792694becc03ee0cad7fad
- package-lock.json: fe8093fc5cc441763b65e2d58d16ac59fd0cff04e1c536acefe8f515a12f6254
- products/combined/product.json: 28cd5271f415848dad92eb5a090513ab922c19abd2210cbd89825d9de2fccbae
- products/knowledge/product.json: e7ee879edce5781d9e5ad0129a0a2e062be5305ba9adf18c0d8f246dfe36b557
- products/service-desk/product.json: 8e489f4fdd9dc9533bee14813522d319ebc899190d4195726ffcbb7e72f14aa7
- solutions/knowledge-to-desk/ui.json: 188f09afb481f735548c6e977a4003a6a5a2a956798433f78f206bfe68874bb5
- OPEN_PLATFORM.html: 1cc0fd9d14ef493d6d1ca6d0065974120cd5b76a195de00550e6743c855c4d72
- visual/data.json: ba5d707516222fed9d20b8aa89ac0b86ef09bd98ba1a221d75edc515eb2ca7dd
- docs/UI_CONTRIBUTIONS.md: 690efc40463f037ef7d6c82169b799b692e7586f5b00d239d3e39abbf200d6e5
- tests/ui-contributions.test.mjs: 8e1b91847cf33cec6c92d7e61d2818c63d1a8032615c6e4174177e1ad0186555
- tests/shell-regressions.test.mjs: b44b0af184a8d36c7c2d7019876b1df24504066b188398b79762135d21f768b0
- tests/frontend-assembly.test.mjs: a730e8b73404d7d69bedb09744dd304df6e99569312b9d05cd513a0789aae957
- tests/composition.test.mjs: 89ad1f511d608fff58ad4726e2b512d9e55a7ed2e548062a26bdf4ca07555f6d
- tests/module-sdk.test.mjs: 30d1a8caaed11c8fddcb35a7d8a259d1a1e1753eadc4e322b0da61788b0397f4
- tests/factory-lifecycle.test.mjs: b6994973c21f023f21cb24d488fa0f3236e0279309d8a34ccc68ae5c7161726f
- tests/workspace-closure.test.mjs: 2400c136171877a3662d47d0dd19c2da0cbe529875ca8e54057ad5b53ed6ebee
- tests/control-plane-artifacts.test.mjs: 064f016cb119a1681da6ed4187474a51095e4b1c18bcd43f966f824c6c4128f8
- packages/web-shell/src/shell.css: 9f84b581785f17e070e42cd592e54c06c6e109814e31eb37da1c20f61639d54e
- tests/build-worker-process.test.mjs: 90b49197c3ee28f561d6fa43bb910105653f67c1e5ed30d2f26974c250e759e9
- tests/control-plane-http.test.mjs: 1aaa3ad32990f0b4d97c1b4ee0d82561c3d4c721868f0b88f2e246fd88f41dc8

## Inspected saved artifacts

- .local/extension-001/brawn-build-06.log: SHA256 00af2a7e9e6323044f8f2986b1cb9bc7f72d7b02db3faa4c8eab5260dfb97c83, 409 bytes.
- .local/extension-001/brawn-build-06-execution.json: SHA256 404c50ffc70f6d06f7e39eb0e7981941830e7530be4e111cef72c22020e2df14, 563 bytes.
- .local/extension-001/brawn-focused-03.log: SHA256 cd4029f185f6d3f155731f4299a6aa6584057d42f78711831f4366a79db7fee0, 22970 bytes.
- .local/extension-001/brawn-focused-03-execution.json: SHA256 674bcf51b9251d2040786405cacc4e42fbdf1fd31149784fbda667440d4bcca0, 1383 bytes.
- .local/extension-001/root-host-preflight-01.json: SHA256 bdea7c0ab04dd6b7822184b91441ceb19bab4a80fd6386d7cde80bee91b865a9, 161 bytes.

All232 independently rehashed and matched saved context; exact41 scope hashes shown for source attribution. Saved logger metadata is an inspected original-child-close report, not a new native invocation or independent live terminal observation.
