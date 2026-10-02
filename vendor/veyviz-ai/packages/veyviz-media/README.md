# Veyviz media ownership

Owner: the media runtime. `FramePool` is an instance-owned, thread-safe CPU byte
buffer with explicit limits on retained bytes, frames, source slots and consumer
leases. It depends only on the public media-contract package.

The trusted host registers admitted `StreamSession` assignments. A replacement
requires both a higher epoch and a different session ID. Closed source slots keep
their generation tombstones within the configured source bound until pool close;
they cannot be silently reopened with old authority. Registration itself is not
authorization and cannot replace the site's supervisor/access checks.

`offer(frame, pixels, now_ms=...)` admits exact immutable packed RGB24/BGR24/GRAY8
bytes for a fresh frame. Sequence and capture time cannot go backwards. An exact
duplicate is idempotent; changed metadata/bytes at the same sequence is rejected.
Dimensions or pixel format changes require a new stream session.
Capacity rejection preserves the existing latest frame. Newest-frame replacement
can reclaim an unleased old frame, but cannot reclaim an in-flight consumer's data.
Other sources' still-valid frames are not silently evicted to admit a new one.
Replacing the latest frame stops new acquisitions of the old frame; existing
consumers can still produce valid results until expiry, cancellation or session
revocation. Downstream consumers enforce their own result ordering.

`acquire(session, now_ms=...)` returns a local `FrameLease` with a read-only pixel
view. `result_valid(now_ms=...)` checks cancellation, source replacement, expiry
and pool closure. `cancel()` invalidates the result but retains its resource pin.
`complete()` is called **only after actual native/DMA completion or confirmed
process/device termination**; it releases that consumer's pin and is idempotent.
There is no GC, context-manager or timeout path that silently releases a pin.

Expiration, session replacement/closure and pool close retire buffers immediately
for new work while retaining all pinned bytes. Pool close is nonblocking;
`snapshot().outstanding_leases` and `retained_bytes` show outstanding ownership.
Cancellation does not stop native work. The execution adapter/supervisor must
provide the real completion/termination evidence before completing a lease.

These bounds describe storage retained by the pool, not total process RSS.
Trusted consumers must not retain/use derived views after completion. Python
cannot revoke a previously returned view; immutable bytes are never overwritten.
CPU-local leases are not serialized pointers, remote credentials, GPU shared-memory
handles or a universal zero-copy transport. Cross-process transport and native
execution ownership remain integration work. This latest-frame pool is also not
an evidence pre/post-event ring or an ordered temporal-window queue.

Run the full dependency-aware package checks with
`python tools/packages/verify_workspace.py --output .ci/package-checks/workspace`.
See [provenance](PROVENANCE.md) for the relationship to the earlier buffer.

## Recorded source boundary

`RecordedVideoSource` is this owner's consumer port for admitted local recordings.
`DecodedVideoFrame` carries immutable packed pixels, a decoded sequence and exact
rational presentation time. It does not invent a capture clock or grant access.
`RecordingTimeline` maps a caller-selected media origin onto an assigned session
clock, retaining scope, generation, dimensions and sequence. The sub-nanosecond
remainder is truncated, never accumulated from an assumed frame rate.

In development replays the clock is explicitly virtual. Relating old footage to
actual capture wall time needs external provenance, not this mapping alone.
Clock uncertainty remains the session's declared value. Decoder order checks,
source lifetime and process termination stay with their owners; timeline mapping
is immutable and does not create another buffer or scheduler.
