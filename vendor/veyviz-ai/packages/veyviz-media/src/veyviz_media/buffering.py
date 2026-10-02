"""Instance-owned latest-frame storage with bounded, explicit consumer lifetimes."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from enum import Enum

from veyviz_media_contracts import FrameReference, Freshness, PixelFormat, SourceScope, StreamSession

_FrameKey = tuple[SourceScope, str, str, int, str, int]
_SourceKey = tuple[SourceScope, str]
_MAX_INTEGER = (1 << 63) - 1


class FramePoolError(ValueError):
    """Invalid, unregistered, conflicting or stale frame/session input."""


class FrameCapacityError(RuntimeError):
    """Admission would exceed the configured resource budget."""


class FrameLeaseError(RuntimeError):
    """A local lease is not owned by this pool or has completed."""


class OfferOutcome(str, Enum):
    STORED = "stored"
    DUPLICATE = "duplicate"


def _integer(value: int, *, positive: bool = False) -> None:
    if type(value) is not int or not int(positive) <= value <= _MAX_INTEGER:
        raise FramePoolError("bounded integer resource/time value required")


@dataclass(frozen=True, slots=True)
class FramePoolStats:
    retained_bytes: int
    retained_frames: int
    outstanding_leases: int
    registered_sources: int
    active_sources: int
    closed: bool


@dataclass
class _Entry:
    frame: FrameReference
    pixels: bytes
    pins: int = 0
    retired: bool = False
    invalidated: bool = False


@dataclass
class _SessionState:
    session: StreamSession
    active: bool = True
    last_frame: FrameReference | None = None
    last_digest: bytes | None = None


class FrameLease:
    """Local consumer pin. Created by FramePool.acquire, never deserialized.

    cancel invalidates the result only. complete is called after native/DMA work
    has actually finished or confirmed process/device termination. There is no
    timeout/GC/context-manager path that silently completes a consumer.
    """

    __slots__ = ("_pool", "_key", "_token", "_frame", "_cancelled", "_completed")

    def __init__(self, pool: FramePool, key: _FrameKey, token: int, frame: FrameReference) -> None:
        self._pool = pool
        self._key = key
        self._token = token
        self._frame = frame
        self._cancelled = False
        self._completed = False

    @property
    def frame(self) -> FrameReference:
        return self._frame

    @property
    def pixels(self) -> memoryview:
        return self._pool._view(self)

    def result_valid(self, *, now_ms: int) -> bool:
        return self._pool._valid(self, now_ms)

    def cancel(self) -> bool:
        return self._pool._cancel(self)

    def complete(self) -> bool:
        return self._pool._complete(self)


class FramePool:
    """Thread-safe local immutable RGB/BGR/gray bytes with bounded source slots.

    Source slots retain generation tombstones until close, preventing old session
    re-registration without growing state beyond max_sources. This registry is
    not device authorization; the host registers only its admitted assignments.
    """

    def __init__(self, *, max_bytes: int, max_frames: int, max_sources: int, max_leases: int) -> None:
        for value in (max_bytes, max_frames, max_sources, max_leases):
            _integer(value, positive=True)
        self._max_bytes = max_bytes
        self._max_frames = max_frames
        self._max_sources = max_sources
        self._max_leases = max_leases
        self._lock = threading.RLock()
        self._sources: dict[_SourceKey, _SessionState] = {}
        self._entries: dict[_FrameKey, _Entry] = {}
        self._leases: dict[int, FrameLease] = {}
        self._bytes = 0
        self._next_token = 0
        self._closed = False

    def _open(self) -> None:
        if self._closed:
            raise FramePoolError("frame pool is closed")

    def _state(self, session: StreamSession) -> _SessionState:
        if not isinstance(session, StreamSession):
            raise FramePoolError("validated stream session required")
        state = self._sources.get((session.scope, session.source_id))
        if state is None or not state.active or state.session != session:
            raise FramePoolError("session is not the current active assignment")
        return state

    def _retire(self, key: _FrameKey, *, invalidate: bool = False) -> None:
        entry = self._entries.get(key)
        if entry is not None:
            entry.retired = True
            entry.invalidated = entry.invalidated or invalidate
            if entry.pins == 0:
                self._bytes -= len(entry.pixels)
                del self._entries[key]

    def register_session(self, session: StreamSession) -> bool:
        with self._lock:
            self._open()
            if not isinstance(session, StreamSession):
                raise FramePoolError("validated stream session required")
            key = (session.scope, session.source_id)
            previous = self._sources.get(key)
            if previous is not None:
                if previous.active and previous.session == session:
                    return False
                if (
                    session.epoch <= previous.session.epoch
                    or session.session_id == previous.session.session_id
                ):
                    raise FramePoolError("replacement needs a greater epoch and a new session ID")
                if previous.last_frame is not None:
                    self._retire(previous.last_frame.identity, invalidate=True)
            elif len(self._sources) >= self._max_sources:
                raise FrameCapacityError("source-slot budget exhausted")
            self._sources[key] = _SessionState(session)
            return True

    def close_session(self, session: StreamSession) -> None:
        with self._lock:
            self._open()
            state = self._state(session)
            state.active = False
            if state.last_frame is not None:
                self._retire(state.last_frame.identity, invalidate=True)

    def offer(self, frame: FrameReference, pixels: bytes, *, now_ms: int) -> OfferOutcome:
        with self._lock:
            self._open()
            _integer(now_ms)
            if not isinstance(frame, FrameReference):
                raise FramePoolError("validated frame reference required")
            state = self._state(frame.session)
            if frame.freshness(now_ms=now_ms) is not Freshness.FRESH:
                raise FramePoolError("only fresh frames with known capture time may be admitted")
            channels = 1 if frame.pixel_format is PixelFormat.GRAY8 else 3
            if type(pixels) is not bytes or len(pixels) != frame.width * frame.height * channels:
                raise FramePoolError("exact immutable packed pixel bytes required")
            if len(pixels) > self._max_bytes:
                raise FrameCapacityError("single frame exceeds the byte budget")
            digest = hashlib.sha256(pixels).digest()
            previous = state.last_frame
            if previous is not None:
                if (frame.width, frame.height, frame.pixel_format) != (
                    previous.width,
                    previous.height,
                    previous.pixel_format,
                ):
                    raise FramePoolError("format or dimensions changed; a new stream session is required")
                if (
                    frame.sequence < previous.sequence
                    or frame.captured_monotonic_ns < previous.captured_monotonic_ns
                ):
                    raise FramePoolError("frame ordering moved backwards")
                if frame.sequence == previous.sequence:
                    if frame != previous or digest != state.last_digest:
                        raise FramePoolError("same sequence has conflicting frame metadata or bytes")
                    return OfferOutcome.DUPLICATE
            old = self._entries.get(previous.identity) if previous is not None else None
            reclaimable = old is not None and old.pins == 0
            new_bytes = (
                self._bytes + len(pixels) - (len(old.pixels) if old is not None and reclaimable else 0)
            )
            new_frames = len(self._entries) + 1 - int(reclaimable)
            if new_bytes > self._max_bytes or new_frames > self._max_frames:
                raise FrameCapacityError("frame or byte budget exhausted; in-flight pins cannot be reclaimed")
            if previous is not None:
                self._retire(previous.identity)
            self._entries[frame.identity] = _Entry(frame, pixels)
            self._bytes += len(pixels)
            state.last_frame = frame
            state.last_digest = digest
            return OfferOutcome.STORED

    def acquire(self, session: StreamSession, *, now_ms: int) -> FrameLease | None:
        with self._lock:
            self._open()
            _integer(now_ms)
            state = self._state(session)
            if state.last_frame is None:
                return None
            key = state.last_frame.identity
            entry = self._entries.get(key)
            if entry is None or entry.retired:
                return None
            if entry.frame.freshness(now_ms=now_ms) is not Freshness.FRESH:
                self._retire(key, invalidate=True)
                return None
            if len(self._leases) >= self._max_leases or self._next_token >= _MAX_INTEGER:
                raise FrameCapacityError("consumer lease budget exhausted")
            self._next_token += 1
            lease = FrameLease(self, key, self._next_token, entry.frame)
            self._leases[self._next_token] = lease
            entry.pins += 1
            return lease

    def _owned(self, lease: FrameLease) -> _Entry:
        if self._leases.get(lease._token) is not lease:
            raise FrameLeaseError("lease has completed or is not owned by this pool")
        return self._entries[lease._key]

    def _view(self, lease: FrameLease) -> memoryview:
        with self._lock:
            return memoryview(self._owned(lease).pixels)

    def _valid(self, lease: FrameLease, now_ms: int) -> bool:
        with self._lock:
            _integer(now_ms)
            if lease._completed:
                return False
            entry = self._owned(lease)
            state = self._sources.get((entry.frame.session.scope, entry.frame.session.source_id))
            return (
                not self._closed
                and not lease._cancelled
                and not entry.invalidated
                and state is not None
                and state.active
                and state.session == entry.frame.session
                and entry.frame.freshness(now_ms=now_ms) is Freshness.FRESH
            )

    def _cancel(self, lease: FrameLease) -> bool:
        with self._lock:
            if lease._completed:
                return False
            self._owned(lease)
            changed = not lease._cancelled
            lease._cancelled = True
            return changed

    def _complete(self, lease: FrameLease) -> bool:
        with self._lock:
            if lease._completed:
                return False
            entry = self._owned(lease)
            del self._leases[lease._token]
            entry.pins -= 1
            lease._completed = True
            if entry.retired and entry.pins == 0:
                self._retire(lease._key)
            return True

    def expire(self, *, now_ms: int) -> int:
        with self._lock:
            _integer(now_ms)
            expired = [
                key
                for key, entry in self._entries.items()
                if not entry.invalidated and entry.frame.freshness(now_ms=now_ms) is not Freshness.FRESH
            ]
            for key in expired:
                self._retire(key, invalidate=True)
            return len(expired)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for key in tuple(self._entries):
                self._retire(key, invalidate=True)
            self._sources.clear()

    def snapshot(self) -> FramePoolStats:
        with self._lock:
            return FramePoolStats(
                self._bytes,
                len(self._entries),
                len(self._leases),
                len(self._sources),
                sum(state.active for state in self._sources.values()),
                self._closed,
            )
