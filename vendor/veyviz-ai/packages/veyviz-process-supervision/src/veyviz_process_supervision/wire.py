"""Bounded versioned JSON control files. No pickle or memory-pointer transport."""

from __future__ import annotations

import json
from pathlib import Path

from .errors import WorkerError
from .files import read_bytes, retry_file_access

MAX_CONTROL_BYTES = 32768


def write_message(directory: Path, name: str, message: dict[str, object]) -> None:
    payload = json.dumps(
        {"protocol_version": 1, "body": message}, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")
    if len(payload) > MAX_CONTROL_BYTES:
        raise WorkerError("control message exceeds byte budget")
    temporary = directory / f"{name}.tmp"
    retry_file_access(lambda: temporary.write_bytes(payload))
    retry_file_access(lambda: temporary.replace(directory / name))


def read_message(path: Path) -> dict[str, object]:
    payload = read_bytes(path, MAX_CONTROL_BYTES + 1)
    if len(payload) > MAX_CONTROL_BYTES:
        raise WorkerError("control message exceeds byte budget")
    try:
        value: object = json.loads(payload)
    except (ValueError, UnicodeError) as exc:
        raise WorkerError("invalid control JSON") from exc
    if (
        not isinstance(value, dict)
        or type(value.get("protocol_version")) is not int
        or value.get("protocol_version") != 1
        or not isinstance(value.get("body"), dict)
    ):
        raise WorkerError("version 1 control object required")
    return dict(value["body"])


def integer(message: dict[str, object], key: str, *, minimum: int = 0, maximum: int = (1 << 63) - 1) -> int:
    value = message.get(key)
    if type(value) is not int or not minimum <= value <= maximum:
        raise WorkerError(f"invalid bounded integer: {key}")
    return value
