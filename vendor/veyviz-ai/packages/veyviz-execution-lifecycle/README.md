# Execution lifecycle

`ExecutorSlot` owns a ready, task-validated `TensorExecutor`. A single native call
may run; competing calls fail immediately without queueing input buffers. A host
submits an explicit expected generation on run/replacement. Replacement fences
admission before closing the old executor and activates the candidate only after
confirmed close. Results completing across that boundary are rejected.

The slot takes ownership of a candidate only after all pre-admission checks pass.
A rejected candidate remains the caller's responsibility. If old cleanup fails,
both owners remain retained and the slot faults. `close()` retries retained owners
and becomes terminal only after all closes succeed. Interruptions follow the same
ownership rule. The concrete executor must serialize close with native work and
confirm termination or raise; this layer cannot make a dishonest close safe.

One active and at most one candidate owner are retained. Provisioning candidates,
resource reservation, task conformance/readiness, authorization and qualification
are host responsibilities. No adapter, model, camera, HTTP or industry dependency
is imported. This complements SDK startup ordering and native process supervision.

Generations are local int64 counters, not persisted site authority. A receiver
must still fence already-returned outputs atomically with its own state/effects.
No durable activation, automatic rollback/restart, distributed coordination or
hard shutdown deadline is claimed. Input ownership follows the synchronous tensor
port; callers must not mutate/release inputs before run returns or raises.
