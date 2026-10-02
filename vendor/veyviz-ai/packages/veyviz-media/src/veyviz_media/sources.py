"""Decoded source port and explicit recorded-time mapping, without native imports."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Protocol

from veyviz_media_contracts import FrameReference, PixelFormat, StreamSession


class SourceReadError(RuntimeError):
    """Source cannot produce trustworthy decoded input; distinct from normal EOF."""


class SourceContractError(ValueError):
    """Invalid decoded pixels, timestamp or recording timeline configuration."""


def _position(value: Fraction) -> None:
    if not isinstance(value, Fraction) or abs(value) * 1_000_000_000 >= 1 << 63:
        raise SourceContractError("bounded exact rational media position required")


@dataclass(frozen=True, slots=True)
class DecodedVideoFrame:
    sequence: int
    presentation_time: Fraction
    width: int
    height: int
    pixel_format: PixelFormat
    pixels: bytes

    def __post_init__(self) -> None:
        if type(self.sequence) is not int or not 0 <= self.sequence < 1 << 63:
            raise SourceContractError("bounded nonnegative decoded sequence required")
        _position(self.presentation_time)
        if any(type(value) is not int or not 1 <= value <= 65536 for value in (self.width, self.height)):
            raise SourceContractError("positive bounded image dimensions required")
        if not isinstance(self.pixel_format, PixelFormat):
            raise SourceContractError("explicit pixel format required")
        channels = 1 if self.pixel_format is PixelFormat.GRAY8 else 3
        size = self.width * self.height * channels
        if size > 64 * 1024 * 1024 or type(self.pixels) is not bytes or len(self.pixels) != size:
            raise SourceContractError("exact immutable packed pixels within 64 MiB required")


class RecordedVideoSource(Protocol):
    """Local admitted recording. EOF is None; failures raise SourceReadError.

    Source owns native decoder/file resources until close. Decoded immutable bytes
    are caller-owned. Sources are not authorizers and do not create capture clocks.
    """

    @property
    def content_sha256(self) -> str: ...

    def read(self) -> DecodedVideoFrame | None: ...

    def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class RecordingTimeline:
    """Map an explicit media origin onto a host-assigned session clock.

    For development this is a virtual clock, not original wall-clock capture time.
    Source ordering belongs to the decoder; admission and generations to FramePool.
    """

    session: StreamSession
    origin_presentation_time: Fraction
    valid_for_ms: int

    def __post_init__(self) -> None:
        if not isinstance(self.session, StreamSession):
            raise SourceContractError("host-assigned stream session required")
        _position(self.origin_presentation_time)
        if type(self.valid_for_ms) is not int or not 1 <= self.valid_for_ms <= 60000:
            raise SourceContractError("frame validity duration must be within 1..60000 ms")
        if self.valid_for_ms <= (self.session.clock.uncertainty_ms or 0):
            raise SourceContractError("validity duration must exceed declared clock uncertainty")

    def reference(self, frame: DecodedVideoFrame) -> FrameReference:
        if (
            not isinstance(frame, DecodedVideoFrame)
            or frame.presentation_time < self.origin_presentation_time
        ):
            raise SourceContractError("decoded frame must not precede the assigned media origin")
        offset_ns = int((frame.presentation_time - self.origin_presentation_time) * 1_000_000_000)
        captured_ns = self.session.clock.anchor_monotonic_ns + offset_ns
        captured_ms = self.session.clock.to_unix_ms(captured_ns)
        return FrameReference(
            self.session,
            f"decoded-{frame.sequence}",
            frame.sequence,
            captured_ns,
            captured_ms + self.valid_for_ms,
            frame.width,
            frame.height,
            frame.pixel_format,
        )
