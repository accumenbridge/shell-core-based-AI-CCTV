# Recording intelligence

Product-owned recording analysis, drawn polygon zones, category timelines, evidence playback, durable batches, live segment watches, alerts and factual summaries. Python owns bounded native execution; Product owns permissions and accepted results.

## Implemented paths

- People, vehicles and animals through the pinned RF-DETR COCO export; anonymous local tracks.
- CPU or CUDA detection, sampled frames, motion filtering and heartbeat observations. Skipped time cannot establish absence.
- Paired SigLIP2 image/text retrieval, reference-image similarity, possible SFace matches and normalized OCR candidates. Results require review.
- Draw/save zones; debounce entry/exit observations; observed dwell rules; versioned rule enable/disable and alert acknowledgement.
- Human-reviewed anonymous entity links, aggregate accepted-run summaries and per-appearance events/visits. Physical uniqueness and occupancy remain unknown.
- Operator ingestion supplies immutable segments. Batches and watches inherit template geometry and alert rules, retain original actor grants, and survive normal restart.
- Exact cosine search in tenant SQLite, bounded to 100 runs and 32 MiB accepted records per query. No external vector database is required for this scope.

## Private runtime

Keep the original CPU companion. Create a separate Python 3.13 environment; install services/veyviz-ai/requirements-intelligence.txt and run runtime_setup.py with that interpreter. It captures models, installed files, interpreter and worker bytes. Select the resulting private profile explicitly. Local OCR redistribution provenance still needs review.

```powershell
node tools/veyviz-intelligence.mjs --catalog .local/veyviz-intelligence/catalog.json --data-root .local/veyviz-intelligence-browser --profile .local/veyviz-ai/profile.json --intelligence-profile .local/veyviz-intelligence-runtime/profile.json
```

The loopback launcher prints its URL and local credential-file path. Enter `stop` for owned cleanup. Failed or interrupted native owners remain quarantined; do not erase markers to claim recovery.

## Long recordings and live feeds

Run services/veyviz-ai/ingest.py with the separate interpreter, a private operator profile, a new output directory and the catalog directory. Supported kinds: file, rtsp, tcp and ssh-rtsp. Browser input cannot supply camera URLs or credentials. SSH requires an existing known-host key and a private password file.

Select tenantId, prefix, segmentSeconds (5–120), durationSeconds and encoder (cpu or nvenc). At most 90 segments per capture; catalog limit 100. Files are at most 8 GiB; admitted segments at most 128 MiB. Capture/transcode hashes and closure evidence are retained. Only closed CSV-listed segments are admitted.

File inputs may supply captureStartUtc and clockUncertaintyMs for the source first frame. Timestamps are normalized before segmentation; live connection time never becomes a frame clock. Derived 12 fps footage may contain resampled frames. Preserve originals separately.

Register a template and draw zones. Analyze admitted segments by prefix or watch new segments. Start ingestion separately. Stop-watch cancels analyses; it does not stop operator capture. Live alert latency includes segment closure and accepted analysis.

## Verification

Build before tests. Run npm test; installed test_runner.py and test_temporal.py with absolute profile/catalog paths; test_runtime.py with VEYVIZ_INTELLIGENCE_PROFILE and VEYVIZ_RUNTIME_TEST_CLIP; test_ingest.py with the authorized clip. Use the actual browser for drawing, filters, review, search and playback.

One clip and controlled references do not qualify camera accuracy, physical unique counts, facial identity, plates, animals, cross-camera tracking or continuous live reliability. See [verification](../../docs/veyviz/INTELLIGENCE_VERIFICATION.md) and contracts/veyviz-temporal-recording/v1/EXTENSIONS.md.
