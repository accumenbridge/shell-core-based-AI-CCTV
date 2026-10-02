"""Validate frame payloads and monotonic source history in the parent."""

from __future__ import annotations

import hashlib
from fractions import Fraction
from pathlib import Path

from veyviz_media import DecodedVideoFrame, SourceContractError, SourceReadError
from veyviz_media_contracts import PixelFormat
from veyviz_process_supervision import integer, read_bytes


class FrameReceiver:
    """One serialized worker session; create a new receiver for each source epoch."""

    def __init__(self, max_frame_bytes: int = 64 * 1024 * 1024) -> None:
        if type(max_frame_bytes) is not int or not 1 <= max_frame_bytes <= 64 * 1024 * 1024:
            raise SourceContractError("positive bounded frame budget required")
        self._max_frame_bytes = max_frame_bytes
        self._sequence = -1
        self._position: Fraction | None = None
        self._dimensions: tuple[int, int, PixelFormat] | None = None

    def receive(self, directory: Path, reply: dict[str, object]) -> DecodedVideoFrame:
        if reply.get("status") != "frame":
            raise SourceReadError("source worker could not produce a frame")
        size = integer(reply, "size", minimum=1, maximum=self._max_frame_bytes)
        pixels = read_bytes(directory / "frame.bin", self._max_frame_bytes + 1)
        if len(pixels) != size or hashlib.sha256(pixels).hexdigest() != reply.get("sha256"):
            raise SourceReadError("pixel size or digest mismatch")
        frame = DecodedVideoFrame(
            integer(reply, "sequence"),
            Fraction(
                integer(reply, "position_numerator", minimum=-(1 << 63)),
                integer(reply, "position_denominator", minimum=1),
            ),
            integer(reply, "width", minimum=1),
            integer(reply, "height", minimum=1),
            PixelFormat(str(reply.get("pixel_format"))),
            pixels,
        )
        dimensions = (frame.width, frame.height, frame.pixel_format)
        if (
            frame.sequence <= self._sequence
            or (self._position is not None and frame.presentation_time <= self._position)
            or (self._dimensions is not None and dimensions != self._dimensions)
        ):
            raise SourceReadError("worker source order or dimensions changed")
        self._sequence, self._position, self._dimensions = (
            frame.sequence,
            frame.presentation_time,
            dimensions,
        )
        return frame
