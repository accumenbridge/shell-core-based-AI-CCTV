"""Task-specific raw person observations, independent from tracking and policy."""

from .persons import (
    BoundingBox,
    Coverage,
    ObservationBatch,
    ObservationOutcome,
    PerceptionContractError,
    PersonDetection,
    ProviderIdentity,
)

__all__ = [
    "BoundingBox",
    "Coverage",
    "ObservationBatch",
    "ObservationOutcome",
    "PerceptionContractError",
    "PersonDetection",
    "ProviderIdentity",
]
