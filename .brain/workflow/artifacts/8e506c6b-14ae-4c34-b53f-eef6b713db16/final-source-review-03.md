# Final source review 03: native helper pin repair

Reviewer `/root/repo_brain_architect`, independent reported Sol/high. Read/hash inspection only; no maintained/Brain edits or build/test/native/browser execution by this reviewer.

**Disposition: PRE_NATIVE_SOURCE_AND_FOCUSED_CLEAR.** This is a forward repair review, not whole upgrade acceptance or reinterpretation of either failed operational launch.

## Exact binding

- Candidate `0c47a3ca0b606db4f9fe24c0a781bc23697eec6e53b8a01670ffce7636ba9074`, 251 files.
- Raw contract SHA256 `3dcb39e18df060243ec6b10af6bd27289e30a796c1a82c5d98ecf3b074606716`.
- All 251 current physical hashes match the saved build/focused candidate before and after review; zero mismatches. Independently recomputed sorted path/NUL/file-digest/newline aggregate equals the candidate digest. Build and focused metadata both bind this same source/contract before and after.
- Exactly two paths differ from candidate `1a0163b412a09070fbb2a90a6cdb401d2ce87df20060129077e8b0dbf49fd361`; all other 249 are unchanged.

Changed paths:

1. `apps/control-plane/src/runtime-recovery.ts`: `667eb92894f6d553dc298c0da9abb7cfa34384b0f6536c87da96973838f43b3d`, formerly `9b0e75ef120e3d25bdc02572c07e2d2fab2ec96a4b9126ec2e5ecbab9665e0a8`.
2. `tests/runtime-upgrade.test.mjs`: `5a4c0b4ba4f926fc6e5ef5ceb951a37a9d40c9a8e466cc3ecf8a5e8b13041a02`, formerly `8498598365b6a8c7780069cbfda73a2306bceef8b8cffe6fe60394285ff1f250`.

## Repair verification

Recovery source and fresh compiled export now contain the complete 64-character digest `050cd8aaceee85709f9f8e0def5d5256ca00e94af70083aed820a29443f72be4`, independently equal to the actual maintained recovery helper bytes. Replacing only this corrected literal with the prior 63-character literal reconstructs exactly the previous recovery source SHA256. Therefore this application change is exactly the digest correction; no helper, validation, native policy, identity, cleanup or permission behavior changed. Compiled recovery file SHA256: `997ea9604e7b014d2364a62bb4b164907f3b53dce7b2c01f2a94019b12387c0f`.

The added ordinary regression imports the fresh compiled recovery/upgrade/publisher pin exports, asserts complete lowercase 64-character SHA256 shape, reads each exact checked-in native helper and compares its actual byte digest. It does not invoke native commands or weaken the strict source-pin guard. Actual upgrade helper digest remains `216c516f525d95c6c17b5c77d7a6d7e578358c3e51fa329d5763fc120d709825`; publisher remains `edfc065d234885678d252e9bd13ebd2bef9814353335671fac662b243cddf57f`.

Prior review02's three wiring repairs and prior core source dispositions remain applicable to the unchanged 249 paths. Startup02's malformed pin rejection stays a preserved failed invocation; this repair does not claim that earlier invocation started successfully.

## Actual saved evidence inspected

- Build07 record `48eeecb5-3612-44cc-aefb-7dc34cf419e4`: saved original npm build exit 0/null signal, 2026-10-02T19:21:12.640Z–19:21:15.038Z. Raw log SHA256 `00af2a7e9e6323044f8f2986b1cb9bc7f72d7b02db3faa4c8eab5260dfb97c83`; execution SHA256 `05133151ef1f62de89c91969ed048c1be9e7803e5d44470bba0d51bf6fa1c802`.
- Focused02 record `56741018-7724-49f4-a943-cffb25216ed9`: original saved node test process exit 0/null signal, 19:21:21.802Z–19:21:35.302Z. Complete raw TAP 65 tests/65 pass/0 fail/0 cancel/0 skip/0 TODO. Raw log SHA256 `251e04e356ebaf0ca0f0a847e6b79fd21c82516fdaeaa6955efce95cb7bd2158`; execution SHA256 `02b35ddc7e069dca44d71c50f44eed30a073a618b97d4e563a9474bfc0af87e9`.
- All four archived record-owned artifact byte hashes independently match. These are saved observer execution metadata, not this reviewer's direct terminal observations. Raw build output has no fabricated exit marker; the actual exit comes from its execution metadata.

## Limits

Native upgrade/Job ownership, real pending-job migration, publisher closure, target browser continuity/recovery and whole full-suite qualification remain pending for this candidate. Launcher03 and repaired business helper preparation remain separate operational source reviews; no fixture execution is inferred from this clearance. Historical failures, skipped coverage and all external/provider/production limitations remain preserved.
