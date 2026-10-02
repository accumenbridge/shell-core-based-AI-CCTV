"""Source identity and monotonic-to-wall-time correlation for the initial video slice."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

MAX_INTEGER = (1 << 63) - 1


class MediaContractError(ValueError):
    """A media reference is structurally invalid or its clock cannot represent time."""


class PixelFormat(str, Enum):
    RGB24 = "rgb24"
    BGR24 = "bgr24"
    GRAY8 = "gray8"


class Freshness(str, Enum):
    FRESH = "fresh"
    EXPIRED = "expired"
    FUTURE = "future"
    UNKNOWN = "unknown"


def _identifier(value: str) -> None:
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or not value.strip():
        raise MediaContractError("nonblank opaque identifier of at most 256 characters required")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise MediaContractError("control characters are not valid identifiers")


def _integer(value: int, *, minimum: int = 0, maximum: int = MAX_INTEGER) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise MediaContractError(f"integer between {minimum} and {maximum} required")


@dataclass(frozen=True, slots=True)
class SourceScope:
    tenant_id: str
    site_id: str
    camera_id: str

    def __post_init__(self) -> None:
        for value in (self.tenant_id, self.site_id, self.camera_id):
            _identifier(value)


@dataclass(frozen=True, slots=True)
class CaptureClock:
    """A stable capture-clock correlation, scoped by device/boot domain identity.

    Uncertainty is the declared wall-time error bound in milliseconds. None means
    unknown. Clock synchronization and domain authenticity are adapter/host duties.
    Correlation changes require a new stream session; never reinterpret old frames.
    """

    domain_id: str
    anchor_monotonic_ns: int
    anchor_unix_ms: int
    uncertainty_ms: int | None

    def __post_init__(self) -> None:
        _identifier(self.domain_id)
        _integer(self.anchor_monotonic_ns)
        _integer(self.anchor_unix_ms)
        if self.uncertainty_ms is not None:
            _integer(self.uncertainty_ms, maximum=60000)

    def to_unix_ms(self, captured_monotonic_ns: int) -> int:
        _integer(captured_monotonic_ns, minimum=self.anchor_monotonic_ns)
        result = self.anchor_unix_ms + (captured_monotonic_ns - self.anchor_monotonic_ns) // 1_000_000
        _integer(result)
        return result


@dataclass(frozen=True, slots=True)
class StreamSession:
    scope: SourceScope
    source_id: str
    session_id: str
    epoch: int
    view_revision: str
    clock: CaptureClock

    def __post_init__(self) -> None:
        if not isinstance(self.scope, SourceScope) or not isinstance(self.clock, CaptureClock):
            raise MediaContractError("validated scope and capture clock required")
        for value in (self.source_id, self.session_id, self.view_revision):
            _identifier(value)
        _integer(self.epoch, minimum=1)


@dataclass(frozen=True, slots=True)
class FrameReference:
    """Metadata identity only: not a memory address, buffer lease or access credential."""

    session: StreamSession
    frame_id: str
    sequence: int
    captured_monotonic_ns: int
    expires_at_ms: int
    width: int
    height: int
    pixel_format: PixelFormat

    def __post_init__(self) -> None:
        if not isinstance(self.session, StreamSession):
            raise MediaContractError("validated stream session required")
        _identifier(self.frame_id)
        _integer(self.sequence)
        _integer(self.width, minimum=1, maximum=65536)
        _integer(self.height, minimum=1, maximum=65536)
        if not isinstance(self.pixel_format, PixelFormat):
            raise MediaContractError("explicit PixelFormat required")
        latest_capture_ms = self.captured_at_ms + (self.session.clock.uncertainty_ms or 0)
        _integer(self.expires_at_ms, minimum=latest_capture_ms + 1)

    @property
    def captured_at_ms(self) -> int:
        return self.session.clock.to_unix_ms(self.captured_monotonic_ns)

    @property
    def identity(self) -> tuple[SourceScope, str, str, int, str, int]:
        """Stable lookup identity; registries must reject conflicting metadata under it."""
        return (
            self.session.scope,
            self.session.source_id,
            self.session.session_id,
            self.session.epoch,
            self.frame_id,
            self.sequence,
        )

    def freshness(self, *, now_ms: int) -> Freshness:
        """Conservative evaluation against a trusted current wall clock supplied by the caller."""
        _integer(now_ms)
        if now_ms >= self.expires_at_ms:
            return Freshness.EXPIRED
        uncertainty = self.session.clock.uncertainty_ms
        if uncertainty is None:
            return Freshness.UNKNOWN
        capture = self.captured_at_ms
        if now_ms < capture - uncertainty:
            return Freshness.FUTURE
        if now_ms < capture + uncertainty:
            return Freshness.UNKNOWN
        return Freshness.FRESH
