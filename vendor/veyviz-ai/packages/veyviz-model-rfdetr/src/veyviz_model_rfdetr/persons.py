"""Exact inspected RF-DETR exports; no output-shape or ontology guessing."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping

import cv2
import numpy as np
from veyviz_execution_contracts import FloatTensor, TensorContractError, TensorExecutor, TensorSpec
from veyviz_media_contracts import FrameReference, PixelFormat
from veyviz_perception_contracts import (
    BoundingBox,
    Coverage,
    ObservationBatch,
    ObservationOutcome,
    PersonDetection,
    ProviderIdentity,
)

MODEL_SHA256 = "0e0817f4cafa479ccba17662a142092932b0b10c98947e7cf60f3badd0f5c219"
LARGE_MODEL_SHA256 = "a6ed7ddbec25bf448f72fe545b32c3c133ad6972fc4c106156b58522ffa83a9a"
_BOXES = TensorSpec("pred_boxes", (1, 300, 4))
_LOGITS = TensorSpec("pred_logits", (1, 300, 91))


class _RfDetrPersonAdapter:
    """Immutable resolved task configuration; per-call transforms have no shared state."""

    def __init__(
        self, *, confidence: float, execution_generation: int, size: int, digest: str, variant: str
    ) -> None:
        if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise TensorContractError("finite confidence threshold in [0, 1] required")
        self._input = TensorSpec("input", (1, 3, size, size))
        self._size = size
        configuration = {
            "confidence": float(confidence),
            "person_category": 1,
            "input_shape": list(self._input.shape),
            "boxes": "normalized_cxcywh",
            "logits": "sparse_coco91_focal",
            "resize": "opencv_inter_linear_stretch",
            "normalize": "rgb_float32_imagenet",
            "nms": "none",
        }
        configuration_digest = hashlib.sha256(
            json.dumps(configuration, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        ).hexdigest()
        self._confidence = float(confidence)
        self._provider = ProviderIdentity(
            f"veyviz.perception.person.rfdetr-{variant}",
            "0.1.0a1",
            digest,
            configuration_digest,
            f"rgb-stretch{size}-imagenet-v1",
            "coco91-person1-focal-v1",
            execution_generation,
        )

    @property
    def provider(self) -> ProviderIdentity:
        return self._provider

    def validate_executor(self, executor: TensorExecutor) -> None:
        if (
            executor.model_sha256 != self.provider.model_sha256
            or executor.inputs != (self._input,)
            or {spec.name: spec for spec in executor.outputs} != {_BOXES.name: _BOXES, _LOGITS.name: _LOGITS}
            or len(executor.outputs) != 2
        ):
            raise TensorContractError("executor does not match the pinned RF-DETR export")

    def prepare(self, frame: FrameReference, pixels: bytes | memoryview) -> dict[str, FloatTensor]:
        if not isinstance(frame, FrameReference) or frame.pixel_format not in (
            PixelFormat.RGB24,
            PixelFormat.BGR24,
        ):
            raise TensorContractError("validated packed RGB24 or BGR24 frame required")
        if not isinstance(pixels, (bytes, memoryview)):
            raise TensorContractError("immutable bytes or a read-only contiguous byte view required")
        view = memoryview(pixels)
        if (
            not view.readonly
            or not view.c_contiguous
            or view.itemsize != 1
            or view.nbytes != frame.width * frame.height * 3
        ):
            raise TensorContractError("pixel buffer does not match the immutable packed frame")
        image = np.frombuffer(view, dtype=np.uint8).reshape(frame.height, frame.width, 3)
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB) if frame.pixel_format is PixelFormat.BGR24 else image
        normalized = np.asarray(
            cv2.resize(rgb, (self._size, self._size), interpolation=cv2.INTER_LINEAR), dtype=np.float32
        )
        np.divide(normalized, np.float32(255.0), out=normalized)
        np.subtract(normalized, np.asarray([0.485, 0.456, 0.406], dtype=np.float32), out=normalized)
        np.divide(normalized, np.asarray([0.229, 0.224, 0.225], dtype=np.float32), out=normalized)
        tensor = np.ascontiguousarray(normalized.transpose(2, 0, 1)[None], dtype=np.float32)
        self._input.validate(tensor)
        return {self._input.name: tensor}

    def decode(
        self,
        outputs: Mapping[str, FloatTensor],
        frame: FrameReference,
        *,
        completed_at_ms: int,
        coverage: Coverage,
        reason: str | None = None,
    ) -> ObservationBatch:
        if set(outputs) != {_BOXES.name, _LOGITS.name}:
            raise TensorContractError("exact named RF-DETR boxes and logits required")
        _BOXES.validate(outputs[_BOXES.name])
        _LOGITS.validate(outputs[_LOGITS.name])
        boxes = outputs[_BOXES.name][0]
        if bool((boxes[:, 2:] < 0).any()):
            raise TensorContractError("negative predicted box size")
        scores = 1.0 / (1.0 + np.exp(-np.clip(outputs[_LOGITS.name][0, :, 1], -80.0, 80.0)))
        detections: list[PersonDetection] = []
        for query in np.flatnonzero(scores >= self._confidence):
            cx, cy, width, height = (float(value) for value in boxes[query])
            x1, y1, x2, y2 = (
                min(1.0, max(0.0, value))
                for value in (cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2)
            )
            if x2 > x1 and y2 > y1:
                detections.append(
                    PersonDetection(f"query-{int(query)}", BoundingBox(x1, y1, x2, y2), float(scores[query]))
                )
        return ObservationBatch(
            frame,
            self.provider,
            completed_at_ms,
            ObservationOutcome.OBSERVED if detections else ObservationOutcome.OBSERVED_EMPTY,
            coverage,
            tuple(detections),
            reason,
        )


class RfDetrSmallPersonAdapter(_RfDetrPersonAdapter):
    """Pinned 512-pixel small export; preserves the original public profile."""

    def __init__(self, *, confidence: float, execution_generation: int) -> None:
        super().__init__(
            confidence=confidence,
            execution_generation=execution_generation,
            size=512,
            digest=MODEL_SHA256,
            variant="small",
        )


class RfDetrLargePersonAdapter(_RfDetrPersonAdapter):
    """Pinned 704-pixel large export; same semantic observation contract."""

    def __init__(self, *, confidence: float, execution_generation: int) -> None:
        super().__init__(
            confidence=confidence,
            execution_generation=execution_generation,
            size=704,
            digest=LARGE_MODEL_SHA256,
            variant="large",
        )
