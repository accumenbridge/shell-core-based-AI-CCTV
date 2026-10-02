"""One trusted local child with bounded control exchanges and owned temporary files."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .errors import WorkerCleanupError, WorkerError
from .files import retry_file_access
from .startup import StartupInput
from .wire import integer, read_message, write_message


class WorkerProcess:
    """Trusted adapters serialize calls and choose the installed worker module.

    Construct before starting so the owner exists even when admission fails.
    Always close after startup, exchange or payload-validation failure. No restart
    is allowed on this owner. It is not an OS sandbox or a resource scheduler.
    """

    def __init__(
        self,
        module: str,
        *,
        startup_timeout_ms: int = 30000,
        request_timeout_ms: int = 10000,
        stop_timeout_ms: int = 1000,
    ) -> None:
        if (
            not isinstance(module, str)
            or re.fullmatch(r"[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+", module) is None
        ):
            raise ValueError("explicit installed worker module required")
        for value, maximum in (
            (startup_timeout_ms, 120000),
            (request_timeout_ms, 120000),
            (stop_timeout_ms, 10000),
        ):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError("positive bounded worker deadline required")
        self._directory = Path(tempfile.mkdtemp(prefix="veyviz-worker-")).resolve()
        self._module = module
        self._startup_timeout_ms = startup_timeout_ms
        self._request_timeout_ms = request_timeout_ms
        self._stop_timeout_seconds = stop_timeout_ms / 1000
        self._process: subprocess.Popen[bytes] | None = None
        self._started = False
        self._closed = False
        self._failed = True
        self._request_id = 0
        self._startup_input: StartupInput | None = None

    def _command(self) -> list[str]:
        return [sys.executable, "-I", "-m", self._module, str(self.directory)]

    @property
    def directory(self) -> Path:
        return self._directory

    @property
    def pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    @property
    def exit_confirmed(self) -> bool:
        return self._process is not None and self._process.poll() is not None

    def start(
        self, configuration: dict[str, object], *, startup_input: bytes | None = None
    ) -> dict[str, object]:
        if self._started or self._closed:
            raise WorkerError("worker owner cannot be started again")
        if startup_input is not None and (
            type(startup_input) is not bytes or not 1 <= len(startup_input) <= 4096
        ):
            raise ValueError("startup input must contain 1 to 4096 bytes")
        self._started = True
        write_message(self.directory, "config.json", configuration)
        deadline = time.monotonic() + self._startup_timeout_ms / 1000
        self._process = subprocess.Popen(
            self._command(),
            stdin=subprocess.DEVNULL if startup_input is None else subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if startup_input is not None:
            assert self._process.stdin is not None
            self._startup_input = StartupInput(self._process.stdin, startup_input)
            self._startup_input.wait(max(0, deadline - time.monotonic()))
            if self._startup_input.failed:
                raise WorkerError("startup input delivery failed")
        remaining_ms = int((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            raise WorkerError("worker startup deadline exceeded")
        reply = self._wait_reply(0, remaining_ms)
        if reply.get("status") != "ready":
            raise WorkerError("worker failed admission")
        self._failed = False
        return reply

    def exchange(self, message: dict[str, object]) -> dict[str, object]:
        if not self._started or self._closed or self._failed:
            raise WorkerError("worker not started, closed or failed")
        self._failed = True
        self._request_id += 1
        write_message(self.directory, "request.json", message | {"request_id": self._request_id})
        reply = self._wait_reply(self._request_id, self._request_timeout_ms)
        self._failed = False
        return reply

    def _wait_reply(self, request_id: int, timeout_ms: int) -> dict[str, object]:
        deadline = time.monotonic() + timeout_ms / 1000
        path = self.directory / "reply.json"
        while time.monotonic() < deadline:
            if path.exists():
                response = read_message(path)
                retry_file_access(path.unlink)
                if time.monotonic() >= deadline:
                    raise WorkerError("worker deadline exceeded during reply access")
                if integer(response, "request_id") != request_id:
                    raise WorkerError("stale or conflicting worker reply")
                return response
            if self._process is None or self._process.poll() is not None:
                raise WorkerError("worker exited without a reply")
            time.sleep(0.005)
        raise WorkerError("worker deadline exceeded")

    def close(self) -> None:
        self._closed = True
        try:
            self._stop()
        except Exception as exc:
            raise WorkerCleanupError(
                "worker cleanup unconfirmed; retain owner and retry close", self
            ) from exc
        except BaseException as exc:
            # Keep cancellation/interrupt semantics while retaining an explicit
            # cleanup handle even when the adapter constructor never returned.
            raise BaseExceptionGroup(
                "worker cleanup interrupted; retain owner and retry close",
                [exc, WorkerCleanupError("worker cleanup unconfirmed", self)],
            ) from None

    def _stop(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=self._stop_timeout_seconds)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=self._stop_timeout_seconds)
                except subprocess.TimeoutExpired as exc:
                    raise WorkerError("worker termination unconfirmed; retaining owned files") from exc
        if self._startup_input is not None:
            self._startup_input.wait(self._stop_timeout_seconds)
        deadline = time.monotonic() + self._stop_timeout_seconds
        while self.directory.exists():
            if self.directory.resolve() != self.directory:
                raise WorkerError("worker directory changed; cleanup refused")
            try:
                for path in self.directory.iterdir():
                    if path.is_dir():
                        raise WorkerError("unexpected child directory; cleanup refused")
                    path.unlink(missing_ok=True)
                self.directory.rmdir()
            except OSError as exc:
                if getattr(exc, "winerror", None) not in {32, 145} or time.monotonic() >= deadline:
                    raise WorkerError("worker exited but file cleanup failed") from exc
                time.sleep(0.01)
