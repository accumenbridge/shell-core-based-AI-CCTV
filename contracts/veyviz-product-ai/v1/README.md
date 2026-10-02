# Veyviz recorded analysis protocol

This product-owned protocol connects a Quadbridge job to a fixed installed Python runner over inherited anonymous pipes. It does not expose a public HTTP inference endpoint. The product owns authentication, authorization, job intent and final acceptance. Python owns decoding, inference and cleanup. The framework host and original Veyviz repository remain unchanged.

The Node parent launches the configured Python 3.13 executable with `-I <runner.py> --profile <profile.json>` and shell disabled. The trusted local profile and executable/package inventories are verified before dispatch. No browser input becomes an executable path, Python import, filesystem path or model URL. The profile contains the admitted `mivia-vid0062` recording and `rfdetr-small-cpu-v1` model with exact digests; source/model bytes are copied to private assets in this new repository.

The parent writes one bounded request JSON line to stdin. It leaves stdin open for a possible second cancellation line `{ "type": "cancel", "jobId": "<same-job>" }`. Python checks cancellation between bounded native operations and unwinds its owned resources. The parent waits for actual process exit/close; cancellation alone is not closure proof. No process is recovered or terminated by a remembered PID. Each implementation must retain uncertain ownership visibly instead of claiming cleanup.

## Request

All keys are required and unknown fields are rejected. Maximum request size is 16 KiB. Identifiers are nonempty ASCII letters, digits, dot, colon, underscore or hyphen, at most 128 characters.

```json
{
  "schema": "veyviz.recorded-analysis.request.v1",
  "jobId": "job-123",
  "commandId": "analysis-command-123",
  "scope": {
    "productId": "veyviz-review",
    "instanceId": "veyviz-local",
    "tenantId": "alpha",
    "actorId": "admin",
    "actorKind": "user"
  },
  "sourceId": "source-123",
  "sourceVersion": 1,
  "fixtureId": "mivia-vid0062",
  "profileId": "rfdetr-small-cpu-v1",
  "frameCount": 3,
  "sampleStride": 10
}
```

`frameCount` is an integer from 1 through 6; `sampleStride` is an integer from 1 through 30. Source identity and original actor/scope are captured by the product's authorized enqueue operation, not accepted from the browser. Revalidate source version and job authority before dispatch and before acceptance. Python echoes the exact request identity; it cannot grant actor permissions.

## Successful response

Exactly one JSON line is written to stdout and the process exits zero only after cleanup. Diagnostics go to bounded stderr. Response is at most 2 MiB. Result is a proposal until the product rechecks the job lease, scope, source version, digest/profile identity and commits synchronously to its owned database.

```json
{
  "schema": "veyviz.recorded-analysis.result.v1",
  "status": "SUCCEEDED",
  "request": { "all": "original request fields, unchanged" },
  "sourceSha256": "64 lowercase hex characters",
  "modelSha256": "64 lowercase hex characters",
  "modelId": "rfdetr-small-cpu-v1",
  "startedAt": "ISO UTC timestamp",
  "completedAt": "ISO UTC timestamp",
  "decodedFrames": 21,
  "samples": [
    {
      "frameIndex": 0,
      "positionMs": 0,
      "width": 640,
      "height": 480,
      "inferenceMs": 100,
      "detections": [
        { "confidence": 0.9, "x1": 10, "y1": 20, "x2": 100, "y2": 200 }
      ],
      "thumbnailJpegBase64": "bounded optional JPEG bytes encoded as base64"
    }
  ],
  "coverage": "UNCOMMISSIONED_RECORDING",
  "occupancy": "UNKNOWN",
  "cleanup": { "sourceClosed": true, "inferenceClosed": true, "retainedBytes": 0, "outstandingLeases": 0 },
  "versions": { "distribution-name": "installed version" }
}
```

The actual `request` is the complete original request, not the illustrative placeholder above. Detections are observed model outputs, never claimed physical occupancy or identified people. Source position is recording PTS, not live capture wall time. Preserve explicit unknown commissioning/coverage. Each sample has at most 100 bounded finite boxes in original frame coordinates; JPEG is optional and at most 96 KiB decoded, resized to at most 640 pixels on either axis. No faces/identities are inferred. Model provenance and actual inference timing remain visible.

For cancellation or failure, return the same schema/request identity with `status` equal to `CANCELLED` or `FAILED`, a bounded `{code,message}` error and actual cleanup facts; no successful samples are accepted. Errors must not expose credentials or arbitrary private paths. Nonzero exit, malformed/oversized output, identity mismatch or uncertain cleanup always prevents successful Product acceptance.

## Trusted local profile

Profile shape: `schema: veyviz.recorded-profile.v1`, `profileId`, `fixtureId`, absolute `modelPath`/`recordingPath`, `modelSha256`/`recordingSha256`, `pythonExecutable`, `runnerPath`, and `inventoryPath`. These values belong to reviewed local setup, never request bodies. The separate inventory covers selected Python source distributions, runner source and installed package/wheel provenance. The large model and private media are not falsely treated as part of Quadbridge's small immutable runtime artifact; their digest-bound companion profile is verified separately.

## Product modules and integration

- `veyviz-sources` owns source records and exposes `veyviz.sources.read.v1` through ordinary source-owner authorization.
- `veyviz-analysis` owns queued requests, accepted result JSON and review state. It requires the source port and `veyviz.recorded-analysis.run.v1`.
- `veyviz-rfdetr` provides that analysis port using this fixed pipe protocol. It supplies executable readiness/provenance operations and a read-only UI contribution to the analysis workspace.
- `solutions/veyviz` translates explicit bindings without cross-owner SQL or browser-derived grants.
- `veyviz-review` selects all three modules; `veyviz-catalog` selects sources alone to prove product-level exclusion.

The analysis service method is `run(request, {signal, assertCurrent}) -> Promise<Result>`, with `readiness()` returning bounded nonsecret configuration/provenance facts. Source service methods are `list(ctx)` and `get(ctx, sourceId)`; records include id, tenant, name, fixtureId, version and created timestamp. Wiring preserves the same actor and tenant when invoking source-owner context. Source records use an admitted opaque fixture ID; the product does not accept arbitrary recording paths or live credentials in this first profile.

Root coordinates any protocol change before both language implementations change. Contract examples are documentation; actual parsing and validation must execute on both sides and be covered by negative tests.
