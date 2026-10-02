"""Local transport failures do not imply native completion."""

from __future__ import annotations

from typing import Protocol


class WorkerError(RuntimeError):
    """Worker transport, protocol or lifecycle failed."""


class CleanupOwner(Protocol):
    def close(self) -> None: ...


class WorkerCleanupError(WorkerError):
    """Cleanup failed; retain the owner even if adapter construction failed.

    The caller can keep this error (or its cause) and call owner.close() again.
    A deadline is never evidence that the native process or its file reads ended.
    """

    def __init__(self, message: str, owner: CleanupOwner) -> None:
        super().__init__(message)
        self.owner = owner
