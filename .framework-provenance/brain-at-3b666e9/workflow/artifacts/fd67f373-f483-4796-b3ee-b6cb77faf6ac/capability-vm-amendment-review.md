# CAPABILITY-001 finite VM harness amendment review

Reviewer: /root/repo_brain_architect, Sol/high. Disposition: APPROVED_FINITE_AMENDMENT, not delivery acceptance. No maintained source, Brain, build, tests or runtime were changed/executed by this reviewer.

## Actual basis

Immutable FAILED full run8a1126f9-d48a-4cb6-8f48-bab9b0fd8f52 is bound to candidate4ab25358c3dca14ef553697e8b62938949b6986142a8ca4a14727685d018f1d6 and contract95abfce5b5765991c1f996f571df96cec82634bbc3bf3ee38bf503eee4c70d1f. Original child close records exit1/null signal; complete raw results are336tests/332pass/3fail/1namedEPERMskip/zero cancellation/TODO. All four archived artifact hashes and sizes match. Raw log SHA256c43c709a2ddc19ddb98a64e267f215d3999c5805db9b9e880e3be2adcf6524a6.

Exact source inspected: tests/studio-integration.test.mjs SHA256ef8516d93e16b33fe14e9d1a6bf54c811c6a589ee75ceef3b46ad03db9c0cd70; tests/studio-product-editor.test.mjs SHA25677218a3a646d9eb4ab5822d10d795da71b3b04c1161b58ed8cb7e25c819cc0d3.

- Case300, integration line36: VM browserCore receives c.modules/c.solutions objects created by host JSON parsing. Strict operation ownRecord compares their prototype to the VM Object.prototype and rejects the foreign-realm descriptor. The browser uses its own JSON-created objects; this fixture is not representative of that boundary. This case also lacks TextEncoder, which will be required once the descriptor realm mismatch is corrected.
- Case304, integration htmlContext lines22/56–58: generated HTML parses its inline catalogue in its own VM realm correctly, but its VM globals omit the browser TextEncoder. The actual failure is ReferenceError TextEncoder is not defined during canonical compose, before application launch/domain persistence/receipt assertions. No runtime failure should be inferred, and these downstream assertions are not qualified from this failed case.
- Case309, product-editor lines121–128: the VM already supplies TextEncoder, but serialize/parse receive host-realm sourceCatalogue.modules/solutions. The same strict operation descriptor prototype check rejects them.

## Authorized minimum correction

Add only those two existing test owners to the CAPABILITY edit grant (25→27 paths), and add both files to the focused recipe. No production paths need reopening.

1. In integration test, import TextEncoder from node:util and expose it to both browserCore VM context and htmlContext. This is a standard browser encoding global used for UTF8 byte accounting, not fetch, filesystem, shell, build or Node import authority. Retain the fail-on-fetch offline guard and existing generated HTML execution.
2. Transport catalogue/solutions, and any browser-owned draft or product fixture entering pure browser helpers, as JSON strings; parse with JSON.parse executed inside the destination VM. Do not inject host Object/prototype, substitute the validator, loosen ownRecord, suppress the error or remove operation declarations. Pass only realm-local decoded data to compose/serialize/parse, then use an ordinary JSON projection to compare cross-realm results to CLI expectations.
3. In offline product-editor case, decode the complete original product and source catalogue in the destination context before serialize/parse. Preserve the description, exact-version, custom binding instance, valid result and absence-of-fetch assertions. The separate compiled application handler tests are unchanged.
4. Preserve integration's existing generated-module count, unchanged maintained BackendHost, immutable save/conflict, real build, compiled dynamic views, separate launch, actual generated record, Knowledge/Handoff committed receipt, mode revocation and restart-retention assertions and original failure diagnostics/cleanup. Do not replace that journey with a mocked result.

## Qualification sequence and limits

Root archives/amends task, contract, focused recipe and source pins before re-admitting sole Luna writer. Prior source/focused acceptance scope remains historical; failed full run remains FAILED. Fresh amended-contract build, focused tests including both owners and complete frozen ordinary npm test are required for final review. No blind retry on unchanged harness or new campaign is proposed.

The existing actual frozen Desk snapshot and live Desk0.2.0-versus-new0.2.1 build cases passed this failed full run and support the finite legacy no-operation snapshot coherence condition; they are not older Knowledge/Handoff operation invocation evidence. No new live browser, MCP, provider, phone, remote deployment or production qualification is inferred.
