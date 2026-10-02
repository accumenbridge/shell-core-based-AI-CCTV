# Construction full-suite cleanup diagnosis01

Reviewer: /root/repo_brain_architect, Sol/high, independent_reported. Read-only owning diagnosis; no application, test, shared Brain or runtime mutations were performed.

## Exact observed failure

Current tests/frontend-assembly.test.mjs SHA256 a730e8b73404d7d69bedb09744dd304df6e99569312b9d05cd513a0789aae957.
Frozen candidate25e59142bcf5e0950dbd79a15533f4de5e8b4d8b889631afcf3169304d63ebee,245files; contract38c96314983810a44afd2baefcadb3884f2debad274a4f0496d42f38039c9bde.

I inspected root-full-01.log lines1113–1122: test184 mobile preview assets survive an ordinary fixed product export and are served by that snapshot failed with failureType hookFailed and ENOTEMPTY while removing the test-owned qb-mobile-export temporary root's data/modules directory. No ordinary body assertion failure is reported. The complete original-close metadata now available in root-full-01-execution.json says exit1/nullsignal, unchanged candidate/contract,362tests360pass1fail1skip0cancel0TODO. Root separately reports directly observed original session98885 closure and immutable failurea2b45ffb-7bc9-4f0c-a105-47ad8dcd5629. The original failure must remain FAILED.

The hook at tests/frontend-assembly.test.mjs78–82 awaits server.close(), then runtime.close(), then rm(area,{recursive:true,force:true}). An error from either awaited close prevents this rm from executing. The reported rmdir error therefore follows those normal close promises resolving in this run. The test owns a new mkdtemp root held in a local constant; the removal target is not supplied by a request.

Canonical HTTP close awaits server.close and closes idle connections (packages/backend-host/src/http.ts198). Runtime close awaits host.stop then access.close (apps/runtime/src/index.ts142); host.stop awaits each started module close (backend-host index86–105). Service Desk close delegates to its SqliteOwner.close, and LocalAccess does likewise; SqliteOwner.close directly closes its DatabaseSync. This is source-grounded closure ordering, not proof that Windows has no transient filesystem observers. It does not identify the filesystem/handle/AV cause, nor establish a native Job Object problem. No concrete application closure defect is demonstrated by this error.

## Minimum next action

The parent's preference for one unchanged, bounded diagnostic rerun of the existing tests/frontend-assembly.test.mjs file is appropriate first. The reviewed fresh build is already current; source/contract must remain unchanged. Record actual original child close and complete file results. Do not delete or control the original failed fixture through PID/path guesses. A successful rerun means that invocation passed, not that the historical ENOTEMPTY cause is diagnosed or that it was harmless. A failure should retain its exact error and closure facts.

If that file passes unchanged, one full same-candidate retry is justified by the actual failed qualification. No new maintained owner, contract/source amendment, duplicate browser or install run is needed for that route. Acceptance still requires the new complete original full invocation to exit0 with zero failures/cancel/TODO, named blocked skip preserved, unchanged tuple, and explicit review resolution of the earlier required failure. An isolated pass alone is insufficient.

If the same after-close ENOTEMPTY recurs, the smallest source repair is only the existing mobile-export hook's rm options: add maxRetries:4,retryDelay:100, retaining recursive:true,force:true and both canonical close awaits. This matches existing helper patterns in tests/source-copy.mjs30 and tests/helpers.mjs35 and leaves an exhausted cleanup error visible. It neither changes application close semantics nor ignores a cleanup failure or weakens native ownership/policy. Such a repair requires explicit admission of tests/frontend-assembly.test.mjs as the27th owner (already present in245fingerprint), before edit; fresh build, existing frontend file, frozen candidate and full npmtest qualify its changed test bytes. It is not presently authorized by this note and should not be made merely to obtain green output before the diagnostic result.

No blanket fixture cleanup campaign, sleep, timeout/profile change, new test matrix, force overwrite or application/SQLite owner rewrite is warranted. The cause of the original ENOTEMPTY remains UNKNOWN. The prior source/build/focused/install/browser review continues to support its bounded components, but final construction acceptance remains open.