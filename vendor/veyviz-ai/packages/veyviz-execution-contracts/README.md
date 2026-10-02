# CPU tensor execution contract

Owner: the execution boundary shared by model-task and native-runtime adapters.
`TensorSpec` validates named, static, finite contiguous float32 NumPy tensors.
Each tensor is bounded to 64 MiB, with one to eight positive dimensions.
`TensorExecutor` describes exact model identity, signatures, synchronous run and
close. It does not promise task semantics, GPU transport, access or qualification.

The caller owns input arrays and keeps them unchanged until `run` returns or
raises after native reads finish. Returned arrays belong to the caller. Cancellation
or a deadline cannot be interpreted as completion by a wrapper abandoning a thread.
Process supervision is required for hard termination. A runtime's own aggregate
admission, native memory and output limits are additional responsibilities.

NumPy is local to this execution boundary; geometry, media/perception records and
occupancy remain independent of it. Dynamic shapes/dtypes and device buffers are
unsupported in this first explicit contract rather than silently coerced.

Run `python tools/packages/verify_workspace.py --output .ci/package-checks/workspace`.
