"""Measured person detections and explicit absence/failure, not business conclusions."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from enum import Enum
from itertools import islice

from veyviz_media_contracts import FrameReference, Freshness


class PerceptionContractError(ValueError):
    """Task output is structurally invalid or contradictory."""


class ObservationOutcome(str, Enum):
    OBSERVED = "observed"
    OBSERVED_EMPTY = "observed_empty"
    UNOBSERVED = "unobserved"
    FAILED = "failed"


class Coverage(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    UNKNOWN = "unknown"


def _text(value: str) -> None:
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or not value.strip():
        raise PerceptionContractError("bounded nonblank identifier/reason required")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise PerceptionContractError("control characters are not permitted")


def _unit(value: float) -> float:
    if type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value):
        raise PerceptionContractError("finite number in [0, 1] required")
    return float(value)


@dataclass(frozen=True, slots=True)
class BoundingBox:
    """Continuous normalized xyxy coordinates in the original frame, never model-input space."""

    x_min: float
    y_min: float
    x_max: float
    y_max: float

    def __post_init__(self) -> None:
        for name in ("x_min", "y_min", "x_max", "y_max"):
            object.__setattr__(self, name, _unit(getattr(self, name)))
        if self.x_max <= self.x_min or self.y_max <= self.y_min:
            raise PerceptionContractError("bounding box must have positive width and height")

    @property
    def bottom_center(self) -> tuple[float, float]:
        return ((self.x_min + self.x_max) / 2, self.y_max)


@dataclass(frozen=True, slots=True)
class ProviderIdentity:
    adapter_id: str
    adapter_version: str
    model_sha256: str
    configuration_sha256: str
    preprocessing_revision: str
    ontology_revision: str
    execution_generation: int

    def __post_init__(self) -> None:
        for value in (
            self.adapter_id,
            self.adapter_version,
            self.preprocessing_revision,
            self.ontology_revision,
        ):
            _text(value)
        for value in (self.model_sha256, self.configuration_sha256):
            if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value, re.ASCII) is None:
                raise PerceptionContractError("exact lowercase SHA-256 digest required")
        if type(self.execution_generation) is not int or not 1 <= self.execution_generation < 1 << 63:
            raise PerceptionContractError("positive execution generation required")


@dataclass(frozen=True, slots=True)
class PersonDetection:
    detection_id: str
    bbox: BoundingBox
    confidence: float

    def __post_init__(self) -> None:
        _text(self.detection_id)
        if not isinstance(self.bbox, BoundingBox):
            raise PerceptionContractError("validated normalized bounding box required")
        object.__setattr__(self, "confidence", _unit(self.confidence))


@dataclass(frozen=True, slots=True)
class ObservationBatch:
    frame: FrameReference
    provider: ProviderIdentity
    completed_at_ms: int
    outcome: ObservationOutcome
    coverage: Coverage
    detections: tuple[PersonDetection, ...]
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.frame, FrameReference) or not isinstance(self.provider, ProviderIdentity):
            raise PerceptionContractError("validated frame reference and provider provenance required")
        if (
            type(self.completed_at_ms) is not int
            or not self.frame.captured_at_ms <= self.completed_at_ms < 1 << 63
        ):
            raise PerceptionContractError("completion time must not precede capture")
        if not isinstance(self.outcome, ObservationOutcome) or not isinstance(self.coverage, Coverage):
            raise PerceptionContractError("explicit outcome and coverage enums required")
        try:
            detections = tuple(islice(self.detections, 4097))
        except TypeError as exc:
            raise PerceptionContractError("bounded detection collection required") from exc
        if len(detections) > 4096 or any(not isinstance(item, PersonDetection) for item in detections):
            raise PerceptionContractError("at most 4096 validated detections required")
        if len({item.detection_id for item in detections}) != len(detections):
            raise PerceptionContractError("detection IDs must be unique within a frame")
        if self.reason is not None:
            _text(self.reason)
        if self.outcome is ObservationOutcome.OBSERVED:
            if not detections:
                raise PerceptionContractError("observed outcome requires detections")
        elif detections:
            raise PerceptionContractError("only observed outcome may contain detections")
        if self.outcome in (ObservationOutcome.UNOBSERVED, ObservationOutcome.FAILED):
            if self.coverage is not Coverage.UNKNOWN or self.reason is None:
                raise PerceptionContractError(
                    "missing/failed inference requires unknown coverage and a reason"
                )
        if self.coverage is not Coverage.COMPLETE and self.reason is None:
            raise PerceptionContractError("partial/unknown coverage requires an assessability reason")
        object.__setattr__(self, "detections", detections)

    def freshness(self, *, now_ms: int) -> Freshness:
        frame_state = self.frame.freshness(now_ms=now_ms)
        if frame_state is not Freshness.FRESH:
            return frame_state
        if now_ms < self.completed_at_ms:
            return Freshness.FUTURE
        return Freshness.FRESH
