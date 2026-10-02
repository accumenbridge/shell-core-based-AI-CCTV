"""Bounded synchronous CPU float32 tensor port; no task or device semantics."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from itertools import islice
from typing import Protocol

import numpy as np
from numpy.typing import NDArray

FloatTensor = NDArray[np.float32]


class TensorContractError(ValueError):
    """Tensor metadata or values violate the resolved execution contract."""


class TensorExecutionError(RuntimeError):
    """Native execution failed; it did not produce an empty task observation."""


@dataclass(frozen=True, slots=True)
class TensorSpec:
    name: str
    shape: tuple[int, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,127}", self.name) is None:
            raise TensorContractError("bounded tensor name required")
        try:
            shape = tuple(islice(self.shape, 9))
        except TypeError as exc:
            raise TensorContractError("bounded static tensor dimensions required") from exc
        if not 1 <= len(shape) <= 8 or any(type(size) is not int or size < 1 for size in shape):
            raise TensorContractError("one to eight positive static dimensions required")
        if math.prod(shape) > 16_777_216:
            raise TensorContractError("tensor exceeds 64 MiB float32 contract limit")
        object.__setattr__(self, "shape", shape)

    def validate(self, value: FloatTensor) -> None:
        if (
            not isinstance(value, np.ndarray)
            or value.dtype != np.dtype(np.float32)
            or value.shape != self.shape
            or not value.flags.c_contiguous
            or not bool(np.isfinite(value).all())
        ):
            raise TensorContractError(f"{self.name}: finite contiguous float32 tensor {self.shape} required")


class TensorExecutor(Protocol):
    """One synchronous execution; return/raise only after native input reads end.

    Caller retains input ownership during run and does not mutate it. Outputs are
    caller-owned arrays. Hard termination and deadlines require a process owner.
    """

    @property
    def model_sha256(self) -> str: ...

    @property
    def inputs(self) -> tuple[TensorSpec, ...]: ...

    @property
    def outputs(self) -> tuple[TensorSpec, ...]: ...

    def run(self, inputs: Mapping[str, FloatTensor]) -> dict[str, FloatTensor]: ...

    def close(self) -> None: ...
