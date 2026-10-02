# ONNX Runtime CPU adapter

Owner: native tensor execution. `OnnxCpuExecutor` accepts an explicit local model
path, expected SHA-256, model-byte budget and CPU thread count. It reads bounded
bytes, verifies those exact bytes and loads them directly, avoiding a path reopen
between verification and execution. A checksum is not trusted publisher approval.
Use only admitted local artifacts; native parsing needs worker isolation.

The first implementation explicitly selects CPUExecutionProvider, disables run
fallback, uses sequential execution/basic graph optimization, and checks static
float32 signatures. Each boundary permits at most 32 tensors and 64 MiB total.
It validates input/output names, shapes, dtype and finiteness; unsupported/dynamic
models fail rather than being guessed or cast. File-backed external tensor data
are not supported by this bytes-only path. Model bytes are not a runtime RSS limit.

Calls serialize within one instance. `close()` waits for native calls and then
releases the session; subsequent calls fail. Native errors propagate as
`TensorExecutionError`, not an empty observation. There is no thread cancellation,
GPU admission or hard thread timeout in this synchronous class.

## Supervised CPU execution

`SupervisedOnnxCpuExecutor` implements the same `TensorExecutor` port using a fixed
installed child executable. The task adapter does not change. Importing this package
does not load ONNX Runtime in the parent; the child verifies the exact model bytes,
creates the CPU session and returns its bounded static signature and model identity.

The shared [process owner](../../../modules/process_supervision/README.md) supplies
deadlines, increasing request IDs, worker-loss detection, termination and confirmed-exit
cleanup. This adapter supplies validated tensor metadata and fixed-order little-endian
float32 files. Each input/output boundary is at most 64 MiB. Size and SHA-256 are
checked before decoding; outputs are independent writable parent-owned arrays.
Published files and their atomic replacement staging files consume separate space.
The raw-file protocol has no pickle, shared pointer or arbitrary operation dispatch.

Calls and close serialize. Invalid caller inputs fail before native work and leave
the worker usable. A run failure, corrupt reply, deadline or abrupt death fences the
executor, attempts shutdown and requires a new assignment; there is no silent retry.
Defaults are 30 seconds for admission, 10 seconds per run and 1 second per stop wait.
No timeout alone authorizes file reclamation. Unconfirmed cleanup retains a retryable
owner in the `WorkerCleanupError` cause of `TensorExecutionError`, including failed
construction. Caller inputs are copied before native execution; the child never
holds a pointer into a parent's frame lease. Child files/residency remain owned until
confirmed completion/exit, even if the parent's copied inputs are no longer needed.
`is_alive()` exposes the observed child-process state to the selected site
owner; it does not assert inference quality or completion of any pending call.

No OS memory quota, parent-crash recovery, device admission scheduler, GPU transport,
batching, qualified provider replacement or site authorization is established here.
Model/task compatibility and signed release authority remain distinct from SHA-256
identity. Local files and process isolation are not an adversarial security sandbox.

The small Identity ONNX fixture in tests executes through the real CPU provider;
mocked cases cover error paths only. Real RF-DETR replay is recorded separately.
Run `python tools/packages/verify_workspace.py --output .ci/package-checks/workspace`.
API basis: [official ONNX Runtime Python API](https://onnxruntime.ai/docs/api/python/api_summary.html).
