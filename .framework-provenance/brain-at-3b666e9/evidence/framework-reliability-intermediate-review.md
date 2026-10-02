# Intermediate reliability review — actual gap, not acceptance

Root inspected candidate 4eac86b2fe24aea54803478910589bacc88f07438d9eee765ca74609f38f3a92 after Luna's actual fresh build and focused29/29 pass. Those results are retained as ce8048f2-2e34-4d1a-8f39-77dfd388d1d1 and 5b852439-5dcc-433a-953e-21933f001442.

The scan helper did not recognize the exact observed `ACCESS.SQLITE-SHM.tmp`: its suffix regex selected only `.tmp`, producing the owner `ACCESS.SQLITE-SHM`, and the root-owner comparison was case-sensitive. Existing focused tests had not exercised this disappearance. Root returned this concrete core failure to the same Luna within the existing nine-file contract, requiring an exact WAL/SHM optional-temporary grammar and a deterministic enumerated-entry unlink regression with stable-file disappearance still failing closed.

The new access tests exercised LocalAccess directly but omitted the agreed actual createRuntime same-config restart. Root also requested one real Desk runtime fixture proving retained records and persistent identity deletion/revocation, including a fully emptied existing store.

Separate Sol/high intermediate review found no other concrete core blocker in seeding, append-only heartbeat or rich metadata. This is not final candidate acceptance. Preserve the passing component observations, failed prior audit and actual review gap; fresh build/focused results for the revised source, complete npm test and independent exact review remain required.
