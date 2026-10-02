"""Bounded retries for Windows temporary-file sharing failures."""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

T = TypeVar("T")


def retry_file_access(operation: Callable[[], T]) -> T:
    """Retry transient Windows access errors for at most one second.

    Python's Windows file-open errors may expose only EACCES, without winerror.
    Persistent denials still raise; this grants no permission or trust bypass.
    The operation must be bounded and safe to repeat, such as owned file I/O.
    """
    deadline = time.monotonic() + 1
    while True:
        try:
            return operation()
        except PermissionError:
            if sys.platform != "win32" or time.monotonic() >= deadline:
                raise
            time.sleep(0.005)


def read_bytes(path: Path, limit: int) -> bytes:
    if type(limit) is not int or not 1 <= limit <= 64 * 1024 * 1024 + 1:
        raise ValueError("bounded positive read limit required")

    def read() -> bytes:
        with path.open("rb") as handle:
            return handle.read(limit)

    return retry_file_access(read)
