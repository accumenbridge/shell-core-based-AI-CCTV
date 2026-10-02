"""Serialized decoded-frame transport for trusted local source workers."""

from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Protocol

from veyviz_media import DecodedVideoFrame, SourceReadError
from veyviz_process_supervision import integer, read_message, retry_file_access, write_message


class FrameReader(Protocol):
    def read(self) -> DecodedVideoFrame | None: ...


def serve_frames(directory: Path, source: FrameReader) -> None:
    write_message(directory, "reply.json", {"request_id": 0, "status": "ready"})
    expected = 1
    while True:
        command = directory / "request.json"
        if not command.exists():
            time.sleep(0.005)
            continue
        request = read_message(command)
        retry_file_access(command.unlink)
        if set(request) != {"request_id"} or integer(request, "request_id") != expected:
            raise SourceReadError("out-of-order frame request")
        try:
            frame = source.read()
            if frame is None:
                write_message(directory, "reply.json", {"request_id": expected, "status": "eof"})
                return
            payload = directory / "frame.tmp"
            retry_file_access(lambda: payload.write_bytes(frame.pixels))
            retry_file_access(lambda: payload.replace(directory / "frame.bin"))
            write_message(
                directory,
                "reply.json",
                {
                    "request_id": expected,
                    "status": "frame",
                    "sequence": frame.sequence,
                    "position_numerator": frame.presentation_time.numerator,
                    "position_denominator": frame.presentation_time.denominator,
                    "width": frame.width,
                    "height": frame.height,
                    "pixel_format": frame.pixel_format.value,
                    "size": len(frame.pixels),
                    "sha256": hashlib.sha256(frame.pixels).hexdigest(),
                },
            )
        except Exception:
            write_message(
                directory,
                "reply.json",
                {"request_id": expected, "status": "failed", "reason": "source read failed"},
            )
            return
        expected += 1
