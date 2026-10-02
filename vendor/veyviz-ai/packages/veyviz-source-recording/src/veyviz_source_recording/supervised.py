"""Recording semantics over the shared local process owner."""

from __future__ import annotations

import re
import threading
from pathlib import Path

from veyviz_media import DecodedVideoFrame, SourceContractError, SourceReadError
from veyviz_media_transport import FrameReceiver
from veyviz_process_supervision import WorkerProcess


class SupervisedRecordingSource:
    """Serialized reads with native decode isolated from the caller."""

    def __init__(
        self,
        path: Path,
        *,
        expected_sha256: str,
        max_file_bytes: int,
        max_frame_bytes: int = 64 * 1024 * 1024,
        startup_timeout_ms: int = 30000,
        read_timeout_ms: int = 10000,
        stop_timeout_ms: int = 1000,
    ) -> None:
        if not isinstance(expected_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
            raise SourceContractError("expected lowercase SHA-256 required")
        for value, maximum in ((max_file_bytes, 1 << 40), (max_frame_bytes, 64 * 1024 * 1024)):
            if type(value) is not int or not 1 <= value <= maximum:
                raise SourceContractError("positive bounded recording resource required")
        try:
            self._worker = WorkerProcess(
                "veyviz_source_recording.worker",
                startup_timeout_ms=startup_timeout_ms,
                request_timeout_ms=read_timeout_ms,
                stop_timeout_ms=stop_timeout_ms,
            )
        except ValueError as exc:
            raise SourceContractError("invalid worker deadlines") from exc
        self._digest = expected_sha256
        self._frames = FrameReceiver(max_frame_bytes)
        self._closed = self._failed = self._ended = False
        self._lock = threading.Lock()
        try:
            self._worker.start(
                {
                    "path": str(path.resolve(strict=True)),
                    "sha256": expected_sha256,
                    "max_file_bytes": max_file_bytes,
                    "max_frame_bytes": max_frame_bytes,
                }
            )
        except BaseException as exc:
            self._close_worker()
            if isinstance(exc, Exception):
                raise SourceReadError("recording worker admission failed") from exc
            raise

    @property
    def content_sha256(self) -> str:
        return self._digest

    @property
    def worker_pid(self) -> int | None:
        return self._worker.pid

    def read(self) -> DecodedVideoFrame | None:
        with self._lock:
            if self._closed or self._failed:
                raise SourceReadError("recording worker closed or failed; new assignment required")
            if self._ended:
                return None
            try:
                reply = self._worker.exchange({})
                if reply.get("status") == "eof":
                    self._ended = True
                    self._close_worker()
                    return None
                return self._frames.receive(self._worker.directory, reply)
            except BaseException as exc:
                self._failed = True
                self._close_worker()
                if isinstance(exc, Exception):
                    raise SourceReadError("recording worker read failed; new assignment required") from exc
                raise

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._close_worker()

    def _close_worker(self) -> None:
        try:
            self._worker.close()
        except Exception as exc:
            raise SourceReadError("recording worker cleanup failed; retain cleanup owner") from exc
