# Veyviz person observation contracts

Owner: person-perception boundary between task providers and tracking/capabilities.
This package depends only on the declared media-contract distribution, never the
SDK, a model framework or the earlier app. The initial semantic schema is
`veyviz.perception.person-observations` version `1.0.0`; the independently versioned
Python distribution is `0.1.0a1`.

Public records: `BoundingBox`, `ProviderIdentity`, `PersonDetection`,
`ObservationBatch`; enums `Coverage`, `ObservationOutcome`; error
`PerceptionContractError`. Boxes are normalized continuous xyxy coordinates in
the original frame. Model adapters must invert resize/crop/letterbox transforms
before constructing them; this type does not infer a coordinate transformation.
Confidence is a finite provider score in [0,1], not a cross-model calibrated
probability or evidence of business meaning.

An observation batch carries immutable source/session/frame and exact model/config
provenance, adapter/preprocessing/ontology revisions, execution generation and
completion time. Digests identify artifacts, not licensing rights, trust or
qualification. Producer generations remain separate from source-session epochs.
Raw detections are measurements; propagated tracks require a separate tracking
contract and cannot be presented as measured detection results.

`OBSERVED_EMPTY` with complete coverage is different from no inference, provider
failure, partial/unknown coverage, uncertain time and expired results. Missing or
failed inference has no detections, unknown coverage and an explicit reason. A
partial empty batch cannot establish a complete zero count. Task coverage means
coverage of the configured frame observation task; a consuming capability still
evaluates its own zone/visibility/history requirements. Completion and capture
freshness are checked separately from the outcome.

Detection IDs are unique within a batch and have no person-identity meaning.
Collections are snapshotted and bounded to 4096 detections. Decoders/transports must
enforce their input-size limits before materializing untrusted payloads.

The package contains no inference implementation. Installed tests use declared
local dependency wheels and independent fixtures through the package verification
tools. Task/runtime adapters and occupancy consumers follow these contracts in M1.

From the repository, run `python tools/packages/verify_workspace.py --output
.ci/package-checks/workspace` with the pinned package tools. This builds and installs
the declared media dependency from the same checkout before testing perception.
