# Local verification — 3 October 2026

Scope: the first recorded-person Product feature on the Windows CPU profile. This verifies implementation and one positive clip; it does not establish production readiness or detector accuracy across cameras.

| Check | Observed result |
|---|---|
| Product build | Passed with four selected modules |
| Focused backend/media tests | 9 passed, no failures or skips |
| Temporal Python tests | 8 passed, including cancellation after both native owners started |
| Existing installed Python tests | 10 passed, no skips |
| Final `npm test` | 390 tests: 389 passed, 0 failed, 1 skipped; exit 0 |
| Native recorded clip | 264 decoded frames, 22 samples, one tracked appearance; 36.29 seconds |
| Native cleanup | Source and inference closed; zero outstanding leases and retained bytes |
| Browser with drawn polygon | Accepted run: one tracked appearance, one zone entry, one zone exit, closed visit; 41 measured samples |
| Browser playback | Entry event seeks to 9.76 seconds; 22.003-second recording plays without a media error |
| Browser filtering | Event filter selects the entry; `blue` matches the accepted description and `red` does not |
| Browser tenant scope | Beta has no admitted recording; Alpha retains its recording and accepted result |
| Graceful restart | `stop` exits 0, native markers are CLOSED; saved run and event playback remain available after restart |
| Read-only review | No remaining concrete blocker in the final shutdown fix |

The full-suite skip is an existing file-symlink fixture denied by Windows with EPERM. An earlier full run had a Windows temporary-directory cleanup failure in the unchanged recovery-store tests; its focused retry passed, and the final full run passed that test too.

The tested recording is `cam05-p001-native`, SHA-256 `dd0eeab9fca9d127335414be22dde8b66ed63965630bf424b2e584ac05efca14`. Its admitted first-frame clock is 2026-10-02T06:20:00Z (11:50:00 IST), with 1000 ms uncertainty. The tested pipeline SHA-256 is `a0d93eaba07239798e4d6c3eba71a51ef13abeb6a7c7df6c6c8ac37403f0ba66`.

The browser visit is in at 11:50:09 IST and out at 11:50:11 IST. These are transitions through the drawn polygon; unique people and site occupancy remain unknown. The colour description is a crop-derived estimate. Tracking at sampled intervals may split or swap appearances.

Private local evidence lives under `.local/`: `veyviz-intelligence-build.log`, `veyviz-intelligence-focused-final.log`, `veyviz-intelligence-temporal-python.log`, `veyviz-intelligence-python-regression.log`, `veyviz-intelligence-real-check.log`, `veyviz-intelligence-real-result.json`, `veyviz-intelligence-regression-final.log`, and `veyviz-intelligence-browser-final.jpg`. Footage and credentials remain private local assets.

One earlier launcher attempt was stopped abruptly and retains an unconfirmed native marker. It was not cleared. The separately tested final runtime was stopped gracefully and restarted normally.

At this first slice, remaining increments were long-recording scheduling, live ingestion, motion filtering/GPU execution, vehicle and animal adapters, unique-person/vehicle review, retrieval, face/plate search, and summaries. The extension evidence below supersedes that implementation backlog. No production or cloud deployment was performed.

## Extension candidate — 3 October 2026

The Product now implements all three object categories, explicit CPU/CUDA execution, motion filtering with heartbeat samples, paired image/text retrieval, reference-image search, face and plate candidates, reviewed anonymous entity links, summaries, versioned alert rules, acknowledgement, immutable segmented ingestion, durable batches and live watches. It continues to use Product-owned tenant SQLite. An external vector database, DBX, graph-RAG service or generative model is not needed for this bounded implementation.

### Ground-level ownership

| Path | Responsibility |
|---|---|
| `modules/veyviz-intelligence/src/index.ts` | Scoped source/run APIs, result adoption, timeline/visit/playback, durable batches and watches; retained original actor and grant checks |
| `modules/veyviz-intelligence/src/analytics.ts` | Versioned rules, accepted-event alerts, acknowledgements, overlap-checked anonymous review, possible visual groups and factual summaries |
| `modules/veyviz-intelligence/src/features.ts` | Fixed profile selection, native query ownership, matched embedding-space identities and bounded exact cosine search |
| `modules/veyviz-intelligence/src/runner.ts` | Fixed temporal runner, original request identity, cancellation, actual closure and quarantine |
| `modules/veyviz-intelligence/src/ui.ts` | Drawing, category/event filters, evidence jumps, reference uploads, review, search, summary, rule and watch controls |
| `services/veyviz-ai/temporal.py` | Sampled detection/tracking, geometry transitions, motion heartbeat, optional enrichment and native lease cleanup |
| `services/veyviz-ai/runtime_worker.py` | Pinned RF-DETR, paired SigLIP2, SFace/YuNet and OCR execution; explicit CUDA selection without fallback |
| `services/veyviz-ai/ingest.py` | Private operator file/RTSP/TCP/SSH profiles, CPU/NVENC segmentation, closed-segment digest admission and retained capture evidence |

Long recordings use independently accepted segments, each at most 120 seconds. The operator capture is bounded to 90 segments and the current catalog to 100 recordings. Watches analyze closed admitted segments and retain their original authorization across restart; they do not start camera capture. The UI team can consume the timeline/event APIs for the final timeline design. Current events and summaries describe measured presence, polygon entry/exit and observed dwell, rather than unrestricted action recognition.

### Actual evidence

| Check | Observed result |
|---|---|
| Frozen Product build | Passed, qualification digest `641d9cad98f3c7e203a8046b1eb6d3fa40b7c3c64f288baefc710f2108206350` |
| Temporal installed Python | 11 passed, including both native owners started before cancellation and distinct person/vehicle colour crop tests |
| Existing installed Python | 10 passed, no skips |
| Installed advanced models | 6 passed, no skips; real CPU/CUDA detector, paired text/image, controlled OCR, supervised intent/closure, drift refusal and public face reference |
| Native ingestion tests | 2 passed; real file creates three digest-admitted closed segments with retained clock offsets |
| Warm detector comparison | CPU 284.08 ms versus CUDA 11.21 ms on the tested frames, about 25.35×; four accepted objects match by category, confidence and overlap |
| Browser native run | `09b374f4…`: accepted one person and three vehicle appearances, 22 measured samples, one closed polygon visit |
| Drawn-zone clock | Person enters 11:50:11 IST, exits 11:50:13 IST; admitted clock uncertainty ±1000 ms, sampled/debounced observations |
| Browser retrieval | `a person walking` returns the person candidate; authorized person crop returns image similarity 0.987; both require review |
| Browser review/alerts | Anonymous person link saved; person presence acknowledgement retained; rule disable applied; event and alert footage open at authoritative offsets |
| Actual Pi capture | SSH over Tailscale, CAM05 RTSP relay, laptop NVENC: four closed segments, 19.416667 seconds total, capture and remote process closure proven |
| Actual Pi Product analysis | All four segments accepted; latest live alert opens a 3.416667-second segment with no video error; three vehicle tracks in that segment |
| Aggregate browser summary | Five accepted runs, 16 appearances: one person, 15 vehicle appearances and zero animals; one reviewed anonymous person; repeated appearances are not physical unique counts |
| Normal stop | Exit 0; Product, temporal and feature owner markers CLOSED; runtime copy removed |
| Independent read-only review | No concrete blocker found in final warmup, rule versioning, colour crop, hash pins or portable fixture change |

The actual live frame clock is UNKNOWN. A connection timestamp was not substituted for capture time. The controlled OCR reference reads `KA01AB1234` at confidence 0.9865; this does not establish the plate of a real camera vehicle. The tested native person crop contains no usable face vector. The separate public OpenCV face reference yields a 128-dimensional vector and resized similarity 0.9051 without establishing identity. Animal detection is implemented but has no positive actual-camera evidence in this capture.

Current temporal SHA-256: `0528b78b688ebac4c85317f2d509372beff4e9565badec452b40dbbb487b48e9`. Advanced private profile SHA-256: `3dce8a6b8306715ed48c3897471e04373e665ef666c109a59114ae012151d977`. The paired vector-space identity includes algorithm version, both encoders, tokenizer, tokenizer configuration and preprocessing bytes. Crop colours are estimates; camera-specific description accuracy is unqualified. Motion filtering did not reduce the 22 measured samples in the tested moving scene; frame sampling reduced inference frequency from the 264 decoded frames.

### Regression and retained failures

The frozen full `npm test` run reports **404 tests: 399 passed, 4 failed, 1 skipped, no cancellations**. All intelligence tests, launcher health, lifecycle and snapshot tests pass in this run. The four failures are the unchanged Windows compiler-descendant startup heartbeat deadlines in `build-worker-process.test.mjs` (cancellation/timeout, shutdown/requeue, lease loss and file-lock scenarios). Their isolated rerun reports **4 passed, no failures/skips**, and the final focused intelligence run reports **16 passed, no failures/skips**. A full green regression gate is not established by a focused retry. A final full retry with native inference stopped is recorded in `.local/veyviz-intelligence-extension-regression-idle-final.log`.

Earlier full attempts and isolated failures are retained. The initial documentation placement inside the reviewed module closure was corrected by moving this report into `docs/veyviz`. A source test edit during an earlier run invalidated its qualification; the frozen run has no such drift. The portable launcher fixture now explicitly copies physical pinned dependencies, matching the Product qualification requirement, while other fixtures retain their prior behavior.

One frozen-candidate browser attempt failed before acceptance with unconfirmed inference cleanup. Its UNKNOWN markers remain retained. Exact replay initially failed too; a subsequent replay of the same saved request succeeded with all native cleanup proven. The separate final browser instance accepted the native run and all four live segments and stopped normally. Intermittent native startup/feature execution under workstation load remains a reliability qualification limit; no failed marker was erased or relabelled CLOSED.

Private evidence: `.local/veyviz-intelligence-extension-regression-frozen.log`, `.local/veyviz-intelligence-extension-windows-isolated-final.log`, `.local/veyviz-intelligence-temporal-tests-final.log`, `.local/veyviz-intelligence-original-tests.log`, `.local/veyviz-intelligence-runtime/model-tests-final.log`, `.local/veyviz-intelligence-runtime/model-test-evidence-final.json`, `.local/veyviz-intelligence-runtime/ingest-tests-final.log`, `.local/veyviz-intelligence-runtime/pi-live-qualification-v2/evidence.json`, and `.local/replay-final-trace-evidence.log`. Camera credentials, source profiles, footage, embeddings, references and databases remain private local assets.

### Remaining qualification

Physical uniqueness/occupancy, calibrated per-camera accuracy, animal/plate positive camera evidence, cross-camera continuity, continuous live reliability, OCR asset redistribution review and production scale are not established. There was no production/cloud deployment, commit or push in this extension turn. GitHub Actions were skipped at the user's request.

### Local operating sequence

1. Build the Product and launch `tools/veyviz-intelligence.mjs` with the admitted catalog, data root, original CPU profile and separate intelligence profile. Keep camera secrets in private operator profiles.
2. Register the template recording, draw/save geometry, choose categories/processing, and save presence/zone/dwell rules. New runs capture the geometry version.
3. For a long recording or live source, choose its admitted recording prefix and start a batch or watch. Run capture in a separate operator terminal, with a fresh output directory:

   ```powershell
   & ./.local/veyviz-intelligence-runtime/venv/Scripts/python.exe services/veyviz-ai/ingest.py --profile .local/veyviz-intelligence-runtime/pi-ingest.json --output .local/veyviz-intelligence-runtime/new-capture-output --catalog-directory .local/veyviz-intelligence
   ```

   The selected private profile supplies the bounded duration, encoder and source. The example output directory must not already exist. Successful capture reports `COMPLETED` and `nativeClosed: true`. Only closed, verified segments become eligible for the watch.
4. Review accepted alerts and supporting footage; acknowledge alerts, confirm anonymous entity links, or search with descriptions/reference photos/plate candidates. Summaries report accepted observations and reviewed links rather than exact physical uniqueness.
5. Stop the watch to cancel pending analyses. Operator capture has its own bounded lifetime. Enter `stop` in the launcher terminal for owned shutdown. Restart the same frozen candidate/data root to retain records; a different build intentionally selects a separate generation. Preserve UNKNOWN owners for explicit diagnosis.
