"""Single-slot tensor executor ownership and local generation fencing."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from threading import Lock

from veyviz_execution_contracts import FloatTensor, TensorExecutor


class SlotError(RuntimeError):
    """Work cannot be admitted in the current lifecycle state."""


class StaleExecutionError(SlotError):
    """Expected generation or completed work is no longer current."""


class SlotState(str, Enum):
    ACTIVE = "active"
    DRAINING = "draining"
    FAULTED = "faulted"
    CLOSED = "closed"


@dataclass(slots=True, eq=False)
class _Owned:
    executor: TensorExecutor
    running: bool = False


class ExecutorSlot:
    """Owns one active executor and at most one accepted replacement.

    Supplied executors must already be ready and task-validated. After successful
    admission here the caller must not run/close them independently. close() must
    wait for native readers to stop or raise while retaining cleanup ownership.
    No authorization, durable epoch allocation or process termination is invented
    here: the composition host and concrete executor own those responsibilities.
    """

    def __init__(self, executor: TensorExecutor, *, generation: int) -> None:
        if type(generation) is not int or not 1 <= generation <= (1 << 63) - 1:
            raise ValueError("positive int64 execution generation required")
        self._current = _Owned(executor)
        self._owned = [self._current]
        self._generation = generation
        self._state = SlotState.ACTIVE
        self._lock = Lock()

    @property
    def state(self) -> SlotState:
        with self._lock:
            return self._state

    @property
    def generation(self) -> int:
        with self._lock:
            return self._generation

    def _expect(self, expected: int) -> None:
        if type(expected) is not int or expected != self._generation:
            raise StaleExecutionError("execution generation changed")
        if self._state is not SlotState.ACTIVE:
            raise SlotError("execution slot is not active")

    def run(self, inputs: Mapping[str, FloatTensor], *, expected_generation: int) -> dict[str, FloatTensor]:
        with self._lock:
            self._expect(expected_generation)
            owned = self._current
            if owned.running:
                raise SlotError("execution slot busy; no request queue")
            owned.running = True
        try:
            result = owned.executor.run(inputs)
        except BaseException:
            with self._lock:
                if self._state is SlotState.ACTIVE and self._current is owned:
                    self._state = SlotState.FAULTED
            raise
        finally:
            with self._lock:
                owned.running = False
        with self._lock:
            if self._state is not SlotState.ACTIVE or self._current is not owned:
                raise StaleExecutionError("completed execution was fenced during native work")
        return result

    def replace(self, candidate: TensorExecutor, *, expected_generation: int) -> int:
        """Fence admission, close old owner, then activate candidate at generation+1.

        Pre-admission rejection leaves candidate ownership with the caller. Once
        DRAINING begins this slot retains both owners, including on interruption
        or uncertain shutdown. close() retries retained cleanup; it never reopens
        a faulted slot. Output already returned still needs receiver-side fencing.
        """
        with self._lock:
            self._expect(expected_generation)
            if candidate is self._current.executor or self._generation == (1 << 63) - 1:
                raise SlotError("distinct candidate and unexhausted generation required")
            previous = self._current
            replacement = _Owned(candidate)
            self._owned.append(replacement)
            self._state = SlotState.DRAINING
        try:
            previous.executor.close()
        except BaseException:
            with self._lock:
                self._state = SlotState.FAULTED
            raise
        with self._lock:
            self._owned.remove(previous)
            self._current = replacement
            self._generation += 1
            self._state = SlotState.ACTIVE
            return self._generation

    def close(self) -> None:
        """Terminal, retryable cleanup; never forget an unconfirmed owner."""
        with self._lock:
            if self._state is SlotState.CLOSED:
                return
            if self._state is SlotState.DRAINING:
                raise SlotError("another lifecycle transition is in progress")
            self._state = SlotState.DRAINING
            pending = tuple(self._owned)
        try:
            for owned in pending:
                owned.executor.close()
                with self._lock:
                    self._owned.remove(owned)
        except BaseException:
            with self._lock:
                self._state = SlotState.FAULTED
            raise
        with self._lock:
            self._state = SlotState.CLOSED
