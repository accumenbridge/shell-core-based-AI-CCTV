# Local recording source

Owner: recorded-video decoding and its local subprocess lifetime.
`SupervisedRecordingSource` and its synchronous decoder `PyAvRecordingSource`
implement the media owner's `RecordedVideoSource` port. They have no model, occupancy, database or API
dependency. The caller supplies an admitted local path, expected SHA-256 and
snapshot byte budget. Admission copies and hashes the input into an owned bounded
temporary file; decoding uses that verified snapshot even if the original changes.
Close, EOF and read failure release native resources and the temporary file.
FFmpeg opens the completed snapshot through native file I/O. The PyAV 16 candidate
crashed on a real MPEG development recording; the selected PyAV 18 path parses it
and rejects its timestamp discontinuity. This does not prove all native inputs safe.
Direct use of `PyAvRecordingSource` cannot recover from native process death.
The supervisor instead owns a private temporary directory, runs decoding in a fixed
child executable and reclaims that child's snapshots only after confirmed exit.
The child closes native decoder resources but retains its snapshot for this parent
cleanup, avoiding competing file-deletion owners. Direct use retains its original
close-and-delete default; external snapshot ownership requires an explicit directory.
Snapshots use unpredictable OS temporary names
and are not an authorization boundary against another process running as the user.

The adapter accepts one video stream in MPEG, MOV/MP4, Matroska or AVI. Network
protocols and other demuxers are not admitted. It decodes sequentially using one
codec thread, preserving exact rational presentation time instead of assuming FPS
or zero origin. Returned pixels are immutable packed BGR24 bytes. A successful
`read()` transfers those bytes to the caller; normal decoder exhaustion is `None`.
Native failures, corruption, unavailable/backward/repeated timestamps, changing
dimensions and oversized frames raise `SourceReadError` and require a new source.
Normal decoder exhaustion is not proof that a recording was never truncated.

Calls serialize with close. Byte limits cover the snapshot and returned packed
frame, not all native codec buffers/RSS. The source is not an authorizer,
does not establish capture wall time, apply commissioning transforms, reconnect a
camera or silently seek/restart. Trusted admission remains host work.

## Supervised reads

The supervisor imports no native decoder in the parent. It launches the installed
worker through the current interpreter with `-I`; Windows launches have no console
window. The worker never receives a callable, arbitrary module name or pickle.
The shared [process owner](../../../modules/process_supervision/README.md) owns
lifecycle and IPC. Version 1 JSON messages are limited to 32 KiB, use increasing request IDs and atomic
file replacement. One bounded raw-pixel file is validated by size, SHA-256 and the
media contract before returned bytes become caller-owned. This is local copying
transport, not shared memory, durable messaging or a high-camera-count claim.
Frame publication and parent-side validation now belong to the shared
[local media transport](../../media/local_transport/README.md). Recording keeps
snapshot admission, decoder construction, finite EOF and terminal failure policy;
live-source adapters can reuse the transport without importing recording code.

Defaults: 30 seconds for admission, 10 seconds per read, 1 second per termination
wait. Admission/read deadlines may be configured within 1..120000 ms, termination
waits within 1..10000 ms. The same wait budget bounds retries for Windows
busy/delete-pending files and directories after exit. A deadline or unexpected exit fails the assignment;
timeouts are never EOF and there is no automatic restart. Terminate is followed by
kill if needed, each with a bounded wait. If termination remains unconfirmed,
owned files are retained; `close()` can retry. A cleanup failure retains its owner
through `WorkerCleanupError` in the source error's cause, even during construction.
Cleanup checks the original directory
and refuses nested directories. `close()` waits for a current serialized read to
finish or hit its deadline before stopping the worker. Local filesystem stalls and
OS scheduling mean these are operational deadlines, not real-time guarantees.

```mermaid
sequenceDiagram
  participant Caller
  participant Parent as Recording supervisor
  participant Child as Decoder process
  Caller->>Parent: read()
  Parent->>Child: bounded request with next ID
  alt Valid decoded frame
    Child-->>Parent: metadata and raw pixel file
    Parent-->>Caller: validated immutable frame
  else Deadline, failure or worker exit
    Parent->>Child: terminate, then kill if needed
    Note over Parent,Child: Confirm process exit before reclaiming files
    Parent-->>Caller: SourceReadError; new assignment required
  end
```

The caller must close the source explicitly. Parent-process crashes/orphan cleanup,
OS memory/CPU quotas, process-tree containment, live camera reconnection and site
assignment generation management remain host work. This trusted local worker is
not a security sandbox; the fixed decoder does not intentionally spawn descendants.
The ONNX adapter uses the same process owner for a separate inference child; this
recording adapter has no inference dependency.

Tests encode a small lossless fixture locally, then decode its real bytes through
the adapter; no research media or external codec executable is needed. Negative
fixtures exercise budgets, mutation, EOF, corruption and timestamp discontinuities.
Supervision tests additionally exercise real process death, deadlines, cleanup,
stale/corrupt replies and refusal to reclaim before confirmed termination. POSIX
tests include a worker that ignores SIGTERM and requires SIGKILL.
Run `python tools/packages/verify_workspace.py --output .ci/package-checks/workspace`.

Timestamp semantics follow the [PyAV time API](https://pyav.org/docs/stable/api/time.html):
presentation time is the timestamp multiplied by its time base. The media owner
maps that position onto an explicit session clock through `RecordingTimeline`.
