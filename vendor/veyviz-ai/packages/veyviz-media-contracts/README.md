# Veyviz media contracts

Owner: media contract boundary consumed by sources, task providers and capabilities.
This independent typed standard-library package contains immutable `SourceScope`,
`CaptureClock`, `StreamSession`, `FrameReference`, `PixelFormat`, `Freshness` and
`MediaContractError`. It imports neither the SDK nor the legacy application.

Tenant/site/camera/source/session/view identities are explicit and preserved
without case folding. Reconnection, capture-clock recalibration or discontinuity
requires a new stream session/epoch from the owning host. Producer authority and
resource authorization are separate from these structurally validated records.

Capture uses monotonic nanoseconds and an immutable clock-domain correlation to
Unix milliseconds (submillisecond offset is floored). `uncertainty_ms=None` means
unknown synchronization. The provided uncertainty must include clock estimation,
drift and timestamp quantization; these records do not measure those errors.
Adapters refresh/restart sessions when their validated clock envelope changes.
Original camera PTS can remain adapter metadata until its mapping is validated.

Freshness requires a trusted caller-supplied current wall time. Known future frames
are `FUTURE`; an uncertainty interval overlapping now is `UNKNOWN`; after the
latest possible capture and before expiry the reference is `FRESH`. At expiry it
is `EXPIRED`, including references whose capture clock was unknown. A future
consumer with uncertain wall time must first obtain a trusted comparison or
withhold assessment; this helper does not infer synchronization across hosts.

Frame metadata records dimensions, format, sequence and a scoped identity. Memory
locality, actual buffer ownership, admission, leases and completion/release are
the media runtime's responsibilities and are not implemented by a reference.
Registries must reject conflicting metadata under the same identity. This first
contract does not imply that a decoder, camera connection or process supervisor
has been implemented.

Run `python tools/packages/verify_package.py contracts/media --output
.ci/package-checks/media-contracts` from the repository with the pinned package
tools. Unit cases run against the rebuilt installed distribution outside the checkout.
