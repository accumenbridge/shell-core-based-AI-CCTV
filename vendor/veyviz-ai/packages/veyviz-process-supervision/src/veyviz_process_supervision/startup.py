"""Bounded anonymous-pipe delivery for trusted worker startup inputs."""

from __future__ import annotations

from threading import Thread
from typing import IO

from .errors import WorkerError


class StartupInput:
    """Owner keeps this sender until the pipe writer has exited."""

    def __init__(self, stream: IO[bytes], payload: bytes) -> None:
        self.failed = False
        self._thread = Thread(target=self._send, args=(stream, payload), daemon=True)
        try:
            self._thread.start()
        except BaseException:
            stream.close()
            raise

    def _send(self, stream: IO[bytes], payload: bytes) -> None:
        try:
            with stream:
                if stream.write(payload) != len(payload):
                    raise WorkerError("incomplete startup input delivery")
        except BaseException:
            # No payload or native exception text crosses this boundary.
            self.failed = True

    def wait(self, timeout: float) -> None:
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise WorkerError("startup input delivery termination unconfirmed")
