"""One verified local recording snapshot, decoded sequentially using PyAV."""

from __future__ import annotations

import hashlib
import re
import tempfile
import threading
from collections.abc import Iterator
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING

from veyviz_media import DecodedVideoFrame, SourceContractError, SourceReadError
from veyviz_media_contracts import PixelFormat

if TYPE_CHECKING:
    import av


class PyAvRecordingSource:
    """Synchronous local decoder; hard timeouts require an isolated process owner."""

    def __init__(
        self,
        path: Path,
        *,
        expected_sha256: str,
        max_file_bytes: int,
        max_frame_bytes: int = 64 * 1024 * 1024,
        snapshot_directory: Path | None = None,
        remove_snapshot_on_close: bool = True,
    ) -> None:
        import av

        if not isinstance(expected_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
            raise SourceContractError("expected lowercase SHA-256 required")
        if type(max_file_bytes) is not int or not 1 <= max_file_bytes <= 1 << 40:
            raise SourceContractError("explicit snapshot budget within 1 byte..1 TiB required")
        if type(max_frame_bytes) is not int or not 1 <= max_frame_bytes <= 64 * 1024 * 1024:
            raise SourceContractError("decoded frame budget within 1 byte..64 MiB required")
        if type(remove_snapshot_on_close) is not bool or (
            not remove_snapshot_on_close and snapshot_directory is None
        ):
            raise SourceContractError("retained snapshots require an explicit owner directory")
        self._remove_snapshot_on_close = remove_snapshot_on_close
        self._snapshot = tempfile.NamedTemporaryFile(
            mode="wb", prefix="recording-", suffix=".video", delete=False, dir=snapshot_directory
        )
        self._snapshot_path = Path(self._snapshot.name)
        self._container: av.container.InputContainer | None = None
        self._frames: Iterator[av.VideoFrame] = iter(())
        try:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as original:
                for chunk in iter(lambda: original.read(min(1024 * 1024, max_file_bytes - size + 1)), b""):
                    size += len(chunk)
                    if size > max_file_bytes:
                        raise SourceContractError("recording exceeds snapshot byte budget")
                    digest.update(chunk)
                    self._snapshot.write(chunk)
            if size == 0 or digest.hexdigest() != expected_sha256:
                raise SourceContractError("empty recording or content digest mismatch")
            self._snapshot.close()
            self._container = av.open(
                str(self._snapshot_path),
                mode="r",
                options={"protocol_whitelist": "file", "format_whitelist": "mpeg,mov,matroska,avi"},
            )
            if len(self._container.streams.video) != 1:
                raise SourceContractError("exactly one video stream required; select/remux explicitly")
            stream = self._container.streams.video[0]
            stream.thread_type = "NONE"
            stream.codec_context.thread_count = 1
            stream.codec_context.options = {"err_detect": "explode"}
            self._frames = iter(self._container.decode(stream))
        except BaseException:
            self._release()
            raise
        self._content_sha256 = expected_sha256
        self._max_frame_bytes = max_frame_bytes
        self._sequence = 0
        self._previous_time: Fraction | None = None
        self._dimensions: tuple[int, int] | None = None
        self._ended = False
        self._failed = False
        self._closed = False
        self._lock = threading.Lock()

    @property
    def content_sha256(self) -> str:
        return self._content_sha256

    def _release(self) -> None:
        self._frames = iter(())
        try:
            if self._container is not None:
                self._container.close()
                self._container = None
        finally:
            self._snapshot.close()
            if self._remove_snapshot_on_close:
                self._snapshot_path.unlink(missing_ok=True)

    def read(self) -> DecodedVideoFrame | None:
        with self._lock:
            if self._closed or self._failed:
                raise SourceReadError("source closed or failed; a new source session is required")
            if self._ended:
                return None
            try:
                frame = next(self._frames)
            except StopIteration:
                self._ended = True
                self._release()
                return None
            except Exception as exc:
                self._failed = True
                self._release()
                raise SourceReadError("native video decode failed") from exc
            try:
                if frame.is_corrupt or frame.pts is None or frame.time_base is None:
                    raise SourceReadError("corrupt frame or unavailable presentation timestamp")
                position = frame.pts * frame.time_base
                if self._previous_time is not None and position <= self._previous_time:
                    raise SourceReadError("presentation time discontinuity requires a new session")
                dimensions = (frame.width, frame.height)
                if self._dimensions is not None and dimensions != self._dimensions:
                    raise SourceReadError("resolution changed; a new commissioned session is required")
                if (
                    not 1 <= frame.width <= 65536
                    or not 1 <= frame.height <= 65536
                    or frame.width * frame.height * 3 > self._max_frame_bytes
                ):
                    raise SourceReadError("decoded dimensions exceed the packed-frame byte budget")
                result = DecodedVideoFrame(
                    self._sequence,
                    position,
                    frame.width,
                    frame.height,
                    PixelFormat.BGR24,
                    frame.to_ndarray(format="bgr24").tobytes(),
                )
                self._sequence += 1
                self._previous_time = position
                self._dimensions = dimensions
                return result
            except Exception as exc:
                self._failed = True
                self._release()
                raise SourceReadError("decoded frame violates source contract") from exc

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._release()
