# Source provenance

## Current isolated core integration, 3 October 2026

The isolated `codex/veyviz-core-ui` checkout is based on product commit `818097ee4ca6d89270f0f5d6c5dace08bae44fa2` plus the explicitly captured product overlay. The active product checkout remains preserved. This integration imports reviewed maintained framework source through `05084b287a383837b595f8c68a62f9524b86eacf`: 135 direct file replacements and four explicit merges preserving product scripts and test fixtures. It additionally adopts only the reviewed shell stylesheet from `c682ced7d17f3e88c74043db43ad7d45ebf6edda` and the three reviewed test fixture changes from `1d762c109061e76d3608dc43f8e4858cbacea509`. Framework Brain records and root guidance were not imported as product authority.

The integration also imports only `tests/managed-runtime-store.test.mjs` from reviewed commit `165c662b5852b73583aec508b8a1195f141443e8`, adding bounded Windows fixture cleanup retries. No snapshot capture limit changes. The framework full run still has a reproduced snapshot-capture timeout and does not establish a complete pass.

The source adoption, separate immutable browser generations, actual local model workflow and bounded verification are recorded in `.brain/evidence/core-ui-browser-20261003/MANIFEST.json` and the current product checkpoint. The original framework commit below remains the initial foundation, not the identity of this integrated source. Historical inventory metadata carrying that initial commit is not a substitute for the current authored-input, toolchain and build-output receipt. Current full product qualification and the command recovery increment remain open.

## Initial foundation

This new independent local repository is based on Quadbridge framework full commit 3b666e9beedb2e5b336f4228091033b1377fae4d, confirmed by git rev-parse HEAD during governance setup. Branch selected by root: codex/veyviz-product. Original framework owner: worker1 in D:/professional-works/company-works/Quadbridge/CORE-FRAMEWORKS.

Inherited .brain was moved within this new repository to .framework-provenance/brain-at-3b666e9 after verifying both absolute paths remained inside D:/Veyviz-code/veyviz-quadbridge-product. Inherited AGENTS is preserved as .framework-provenance/AGENTS-at-3b666e9.md. That archive records framework development history; none of its acceptance, approvals, run counts or tasks applies to this new product.

Original Veyviz reference: D:/Veyviz-code/veyviz-ai-cctv-product-integration-review, HEAD 1f3486acff2f63de4bb47d33ad274eac279007d9 as reported source inspection by root/explorers. The original contains uncommitted work; selected per-file reuse requires actual digests and a named capture. The HEAD value alone does not identify those bytes. Original files are read-only references here.

Root/Python writer must publish selected source inventory, exact file hashes, distribution versions/dependency closure and model/recording profile hashes before qualifying that reuse. Do not copy legacy app, secret stores, runtime data, deployment authority, original virtual environments or inherited dist as qualified product output.

Fresh product Brain starts without run/review records. Documentation and CLI validation establish only internal planning consistency.
