# Recorded temporal intelligence v1

This is the owned local recorded-person profile in `modules/veyviz-intelligence` and `services/veyviz-ai/temporal.py`. It is separate from the existing six-sample analysis protocol. Product owns recording registrations, geometry, original analysis intents, accepted appearances/events/visits and scoped queries. Python owns decoded media, inference and temporary tracking state. No legacy checkout is imported at runtime.

## Admission and provenance

An operator runs `tools/veyviz-recording-admit.mjs` against an authorized regular MP4. The tool copies and hashes the recording into a private local asset directory under an exclusive catalog lock. The catalog binds each recording to a tenant, opaque ID, name, exact bytes/hash, and optionally the UTC time of the **first frame** plus clock uncertainty. UTC is not inferred from a filename or NVR URL. Browsers select opaque recording IDs; paths, model locations and execution commands cannot be supplied through Product routes.

Current limits: MP4 up to 128 MiB, one sequential CPU execution per module instance, at most 120 seconds per request, 250–2000 ms detection interval, 240 measured samples, 20,000 decoded frames, 32 appearances, 512 events, 256 visits, eight polygons of 3–16 normalized corners, and a 4 MiB response. Windows CPU/native profile is selected through the already verified RF-DETR companion. Long source offsets can hit the sequential decode bound and fail explicitly. GPU, live streams, uploads and long-recording scheduling are not qualified by this profile.

`veyviz.temporal-recording.request.v1` retains product/instance/tenant/original actor, command/run/job identity, source version/digest, recording ID, pipeline source digest, geometry version and sampling settings. Python echoes the complete request and records model/source/pipeline digests. Exact rational PTS determines sampling; JSON positions are milliseconds **relative to the first decoded frame**. Original PTS origin is retained separately. Playback uses those relative positions; capture wall-clock, when explicitly admitted, is `captureStartUtc + positionMs`.

## Acceptance and recovery

Registration, geometry and run commands use owner receipts/idempotency and audit. Jobs retain the original actor and reauthorize during execution and at synchronous acceptance. Source-version, admission, model/pipeline, response shape/bounds, timestamp relationships and JPEG evidence checks precede adoption. Result facts, appearance/event/visit indexes and job completion share the owner transaction. No await occurs inside that transaction. Identical acceptance replay is a no-op; conflicting output is rejected. A separate run is a separate revision; statistics and search always select one run, so reanalysis is not silently aggregated.

Cancellation is cooperative. Native decoder/model closure and zero retained leases/bytes must be returned before cleanup is treated as proven. The Product runner owns a durable native marker adjacent to its database. An interrupted or unverifiable owner remains ACTIVE/UNKNOWN and blocks further native dispatch, including after restart. No age/PID heuristic clears it. Restoring authority or marking a job cancelled does not prove native cleanup.

## Meaning of results

Person detections are associated using bounded local spatial/overlap matching. IDs are scoped to a run and do not establish identity or cross-camera uniqueness. Missed detections, crossing people and occlusion can split or swap associations. Upper-body colour is a coarse crop-derived estimate that can include lighting/background effects; it is not a semantic vision-language model.

Geometry uses measured person footpoints, two consecutive observations for transitions, and explicit geometry versions. An initial inside observation creates presence with unknown entry. Lost tracks or recording endings leave uncertain exits. A zone crossing is a crossing of that drawn polygon; it does not establish property entry without suitable geometry/qualification. Coverage is SAMPLED_UNCOMMISSIONED. Unsampled time does not prove absence; uniquePeople is null and occupancy is UNKNOWN.

## UI/API contract

All routes use `veyviz.intelligence.read` or `.write`, declared independently from grants:

| Route | Purpose |
|---|---|
| GET `/api/intelligence/catalog` | Tenant-admitted recording projections; no paths |
| GET/POST `/api/intelligence/sources` | List/register Product-owned recording sources |
| POST `/api/intelligence/geometry` | Save versioned polygons; source version increases |
| GET/POST `/api/intelligence/runs` | List up to 100 runs / submit an interval |
| GET `/api/intelligence/run?runId=...` | Job state, captured intent and accepted result |
| POST `/api/intelligence/cancel` | Request cancellation of an owned run |
| GET `/api/intelligence/events?runId=...` | Time/type/zone-filtered cursor pagination, at most 100 events/page |
| GET `/api/intelligence/timeline?runId=...` | Event buckets, measured sample positions and qualified counts |
| GET `/api/intelligence/visits?runId=...` | Accepted visits and uncertain boundaries |
| GET `/api/intelligence/search?runId=...&q=...` | Literal substring search of accepted descriptions; at most 32 appearances |
| POST `/api/intelligence/playback` | Authorize registered-source or accepted-event playback |

Event pagination fixes one immutable run and binds the cursor to its filters. Appearance and event IDs must always be interpreted alongside runId. Search is scoped structured text search, not vector/face/plate retrieval. The current UI offers person and implemented event categories only.

## Binary playback

The maintained host is JSON-only and its CSP requires same-origin media. `tools/veyviz-intelligence.mjs` supplies a fixed loopback facade; it forwards Product requests to the existing host and `/media/<capability>` to the owned binary gateway. It preserves CSP and validates incoming Host/Origin before fixed-target forwarding. It is not an arbitrary proxy or production identity gateway.

Playback capabilities expire after 120 seconds and recheck original HTTP session, current grants, source ownership and admission on every request. Removing/changing a catalog admission withdraws outstanding playback. Exact recording bytes are hashed before delivery and retained in a bounded buffer, so playback uses the admitted bytes. HEAD, single byte ranges, open-ended/suffix ranges and 416 responses are supported. Maximum eight concurrent/in-flight grants and 256 MiB retained/reserved bytes. Browser player reuses a current capability across event jumps and renews it when needed. Delivered/browser-buffered bytes cannot be recalled.

The composition-bound `veyviz.product-authority.v1` is a current-host authorization adapter supplied by solution wiring. Its declaration and provider marker are not a grant. It only reconstructs and checks the captured actor against the current selected Product/module scope.
