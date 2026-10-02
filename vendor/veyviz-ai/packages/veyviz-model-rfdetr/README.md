# Pinned RF-DETR person task adapters

Owner: the semantics of pinned RF-DETR-small and large exports. This package owns RGB
conversion, OpenCV linear stretch to the profile's input size, ImageNet normalization, sparse
COCO category 1 focal logits and normalized original-frame xyxy decoding.
It imports the tensor port and person/media contracts, never ONNX Runtime or the
earlier application. It has no session creation, environment lookup or downloads.

`RfDetrSmallPersonAdapter(confidence=..., execution_generation=...)` constructs
deterministic configuration provenance. `validate_executor` requires the exact
model hash and named signature. `prepare` accepts immutable packed RGB/BGR bytes
or a read-only lease view; each call returns its own contiguous float32 tensor.
`decode` requires named finite outputs, applies a person threshold, clips boxes
and rejects degenerate boxes. It does not guess shape, use softmax, drop category
90 as background, add NMS or produce track identities. Detection IDs are query
IDs local to the referenced frame. Selected zero-area/clipped-away queries are
discarded as non-observations; negative predicted sizes reject the batch.

The caller supplies coverage from source quality/commissioning. Successful full
image inference alone does not prove complete visibility. Native failures must
become failed/unknown downstream, never observed-empty. Host admission validates
the executor before use and checks frame leases/freshness/generation around
execution; `decode` alone is not proof that inference occurred.

Supported bytes are SHA-256
`0e0817f4cafa479ccba17662a142092932b0b10c98947e7cf60f3badd0f5c219`,
with input `input[1,3,512,512]`, `pred_boxes[1,300,4]` and
`pred_logits[1,300,91]`. Other exports need their own reviewed binding. The local
source lock records publisher revision and declared Apache-2.0 metadata; this
adapter does not establish redistribution rights or production quality.

Run `python tools/packages/verify_workspace.py --output .ci/package-checks/workspace`.
See [selective reuse provenance](PROVENANCE.md).

`RfDetrLargePersonAdapter(confidence=..., execution_generation=...)` uses the same
semantic output contract, with input `input[1,3,704,704]` and model SHA-256
`a6ed7ddbec25bf448f72fe545b32c3c133ad6972fc4c106156b58522ffa83a9a`.
Its provider identity, preprocessing identity and configuration digest differ from
small. Each profile rejects the other's executor. Shared internal calculations
avoid copying task logic; there is no arbitrary hash/shape constructor in the
public exports. Switching this selection requires fresh consumer bindings and
tracking state; it is not automatic hot replacement.
