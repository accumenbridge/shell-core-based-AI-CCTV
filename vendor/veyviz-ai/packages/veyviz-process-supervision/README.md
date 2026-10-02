# Local process supervision

Owner: trusted local child-process lifetime and bounded control-file exchanges.
This dependency-free infrastructure module is shared by recording and ONNX
adapters. It has no media, tensor, model, business, SDK or authorization dependency.
Consumers choose fixed installed worker modules; do not expose module selection or
these private directories as a customer API. No untrusted callable or pickle crosses
the boundary. Domain modules keep their existing ports.

Construct `WorkerProcess`, call `start(configuration)`, serialize `exchange()` calls
and payload access, and always call `close()` after any failure or at shutdown.
Construction does not start native work. Workers use the bounded version 1 JSON
helpers, with 32 KiB control limits, atomic publication and increasing request IDs.
The limit admits both recording metadata and the tensor port's 32-input/32-output
static signatures. Payload codecs and their byte limits belong to each adapter.

An optional `start(configuration, startup_input=payload)` delivers 1–4096 bytes to
the child's anonymous stdin pipe and closes it, providing EOF. Put only public
metadata in `configuration`: it is still written to `config.json`. Startup input
is not added to files, environment variables, arguments or diagnostic messages.
A dedicated bounded sender keeps pipe backpressure off the calling thread; the
startup deadline covers process creation, delivery and the ready reply. On failure,
call `close()` as usual. Cleanup confirms child exit and sender termination before
removing owned files; uncertain cleanup retains the owner. Existing workers keep
stdin disconnected unless this input is explicitly supplied.

The child must read a bounded payload and validate its own domain schema before
publishing ready. This transport is not a credential vault, encryption mechanism,
memory-zeroization guarantee or defense against a privileged local debugger. It
does not prevent a trusted child from persisting input itself. RTSP integration
must supply that child-side admission and credential policy separately.

Owned temporary-file accesses retry Windows `PermissionError` for at most one second
per operation; Python can report transient sharing conflicts as EACCES without a
Windows error code. Persistent denials still raise. Reply access is checked again
against the response deadline after file access, so a late readable reply fails.
These bounded retries and serialization/validation time can add caller latency;
response deadlines are not whole-method real-time guarantees.

Admission/read deadlines fail; they do not imply native completion. Close terminates,
waits, then kills and waits if necessary. Only confirmed child exit permits flat
owned-directory cleanup. The established Windows busy/delete-pending retries are
bounded. Cleanup errors carry a `WorkerCleanupError.owner` handle, including during
adapter constructor failure; retain it and retry `owner.close()`. Error causes expose
the reason. Cleanup never recursively follows unexpected directories.

If cleanup itself is interrupted by a `BaseException` such as `KeyboardInterrupt`
or `SystemExit`, close raises a `BaseExceptionGroup` containing the original
interruption and a `WorkerCleanupError` with the retained owner. This remains
outside ordinary `except Exception` handling. Preserve that group/owner and retry
close; an interruption is not confirmation of child exit. An interruption in
startup/read with successful cleanup continues to propagate unchanged.

The owner has no automatic restart or finalizer. An adapter must serialize its
public calls; this low-level owner is not independently thread-safe. Operational
deadlines do not bound OS/filesystem stalls. The worker is not an OS sandbox,
process-tree container, memory/CPU quota, parent-crash recovery service, device
admission scheduler, durable queue or site assignment manager. Local copies are
used; this is not universal zero-copy transport or a capacity qualification.

Run the standard workspace verifier for independent build/install/type/coverage
checks and real child-process failure tests on Windows and Linux.
