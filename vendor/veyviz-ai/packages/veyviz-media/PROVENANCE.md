# Frame ownership provenance

This implements reuse candidate R01's required adaptation of the earlier
`app/runtime/camera_frame_buffer.py` `LatestFrameBuffer` concept.

- Source revision: `d191f723ed7634713098e671b8d3f410cc3ef9e7`.
- Inspected source SHA-256: `331284c1a8d0d35c118d642086b11bee0fc78024210aa189ac3ac397a8aaa998`.
- Retained behavior: newest frame per source, explicit stale-frame rejection and
  synchronized access to the instance-owned buffer.
- Reimplemented ownership: fully scoped session keys, exact-frame conflicts,
  byte/frame/source/lease bounds, read-only bytes, pinned retired buffers, explicit
  completion and generation-safe replacement/close. Old camera-only keys,
  arbitrary mutable frame/metadata values and unbounded storage are not imported.

This is a behavioral adaptation under new contracts rather than copying the
original class. No earlier application dependency is retained and no source file
was moved. New tests exercise the added ownership and failure semantics against
the independently installed package. Decoder, transport, evidence windows and
native inference admission are separate subsequent owners.
