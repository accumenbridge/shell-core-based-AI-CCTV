"""Fixed-order little-endian float32 payloads; signatures fence each process."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from pathlib import Path

import numpy as np
from veyviz_execution_contracts import FloatTensor, TensorContractError, TensorSpec
from veyviz_process_supervision import WorkerError, integer, read_bytes, retry_file_access


def encode_specs(specs: tuple[TensorSpec, ...]) -> list[dict[str, object]]:
    return [{"name": spec.name, "shape": list(spec.shape)} for spec in specs]


def decode_specs(value: object) -> tuple[TensorSpec, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise WorkerError("one to 32 tensor specs required")
    result = []
    for item in value:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not isinstance(item.get("shape"), list)
        ):
            raise WorkerError("invalid tensor signature metadata")
        result.append(TensorSpec(item["name"], tuple(item["shape"])))
    if (
        len({spec.name for spec in result}) != len(result)
        or sum(math.prod(spec.shape) for spec in result) > 16_777_216
    ):
        raise WorkerError("duplicate names or combined tensor boundary exceeds 64 MiB")
    return tuple(result)


def validate_feed(specs: tuple[TensorSpec, ...], values: Mapping[str, FloatTensor]) -> None:
    if set(values) != {spec.name for spec in specs}:
        raise TensorContractError("tensor names do not match the admitted signature")
    for spec in specs:
        spec.validate(values[spec.name])


def write_tensors(
    directory: Path, name: str, specs: tuple[TensorSpec, ...], values: Mapping[str, FloatTensor]
) -> dict[str, object]:
    """Caller validates values first and serializes file access for this request."""
    temporary = directory / f"{name}.tmp"
    digest = hashlib.sha256()
    size = 0
    with retry_file_access(lambda: temporary.open("wb")) as handle:
        for spec in specs:
            payload = values[spec.name].astype("<f4", copy=False).tobytes(order="C")
            handle.write(payload)
            digest.update(payload)
            size += len(payload)
    retry_file_access(lambda: temporary.replace(directory / name))
    return {"size": size, "sha256": digest.hexdigest()}


def read_tensors(
    directory: Path, name: str, specs: tuple[TensorSpec, ...], metadata: dict[str, object]
) -> dict[str, FloatTensor]:
    expected_size = sum(math.prod(spec.shape) * 4 for spec in specs)
    if integer(metadata, "size", minimum=1, maximum=64 * 1024 * 1024) != expected_size:
        raise WorkerError("tensor boundary size mismatch")
    payload = read_bytes(directory / name, expected_size + 1)
    if len(payload) != expected_size or hashlib.sha256(payload).hexdigest() != metadata.get("sha256"):
        raise WorkerError("tensor payload size or digest mismatch")
    result: dict[str, FloatTensor] = {}
    offset = 0
    for spec in specs:
        count = math.prod(spec.shape)
        array = (
            np.frombuffer(payload, dtype="<f4", count=count, offset=offset)
            .astype(np.float32, copy=True)
            .reshape(spec.shape)
        )
        spec.validate(array)
        result[spec.name] = array
        offset += count * 4
    return result
