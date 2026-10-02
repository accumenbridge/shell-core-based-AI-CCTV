# RF-DETR task provenance

Reuse candidate R07: selected preprocessing and focal-logit/box calculations from
`app/vision/rfdetr_backend.py`, source SHA-256
`a0a3b28c788342ac34d6eb7781771ca1c2af8bf30fb397ae4aecd7eeaf61b5a9`.
The earlier source remains unchanged. Its constructor, remote/environment factory,
shadow runner and output shape guessing are excluded.

The new adapter separates tensor execution, pins names/shapes/model bytes, validates
nonfinite values and records normalized original-frame coordinates with explicit
provenance. Unit fixtures preserve the focal/person mapping while adding malformed
outputs, concurrent preprocessing and coverage cases. New package tests do not
reuse imports from the application.

Artifact provenance remains in `models/rfdetr-source.lock.json`: repository
`PierreMarieCurie/rf-detr-onnx`, revision
`94f91976449c187be38e649863e3dadecc312437`, file `rf-detr-small.onnx`.
Publisher interface reference:
[RF-DETR ONNX](https://huggingface.co/PierreMarieCurie/rf-detr-onnx).
Models and research recordings remain local and are excluded from package builds.

The second pinned profile uses the same locked repository revision, file
`rf-detr-large-2026.onnx`. Local ONNX Runtime inspection confirmed input
`input[1,3,704,704]`, boxes `[1,300,4]`, logits `[1,300,91]` and the SHA-256
recorded in the source lock. This is same-family substitution; it establishes
neither cross-family preprocessing compatibility nor production qualification.
