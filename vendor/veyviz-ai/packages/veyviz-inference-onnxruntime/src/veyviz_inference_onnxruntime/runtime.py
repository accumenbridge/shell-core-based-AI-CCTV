"""Explicit CPU ONNX execution with verified model bytes and static signatures."""

from __future__ import annotations

import hashlib
import math
import re
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, cast

from veyviz_execution_contracts import FloatTensor, TensorContractError, TensorExecutionError, TensorSpec

if TYPE_CHECKING:
    import onnxruntime as ort


class OnnxCpuExecutor:
    """Trusted local models only. A digest is identity, not publisher authorization.

    Calls serialize; close waits for native work. No timeout claims termination.
    The surrounding worker must supply process/resource isolation.
    """

    def __init__(
        self, model_path: Path, *, expected_sha256: str, max_model_bytes: int, threads: int = 1
    ) -> None:
        import onnxruntime as ort

        if not isinstance(expected_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
            raise TensorContractError("exact lowercase model SHA-256 required")
        if type(max_model_bytes) is not int or not 1 <= max_model_bytes <= 1_073_741_824:
            raise TensorContractError("model byte limit must be within 1..1 GiB")
        if type(threads) is not int or not 1 <= threads <= 64:
            raise TensorContractError("CPU thread count must be within 1..64")
        with model_path.open("rb") as stream:
            payload = stream.read(max_model_bytes + 1)
        if not payload or len(payload) > max_model_bytes:
            raise TensorContractError("model is empty or exceeds its byte budget")
        if hashlib.sha256(payload).hexdigest() != expected_sha256:
            raise TensorContractError("model digest mismatch")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        try:
            session = ort.InferenceSession(payload, sess_options=options, providers=["CPUExecutionProvider"])
            session.disable_fallback()
        except Exception as exc:
            raise TensorExecutionError("ONNX session creation failed") from exc
        if session.get_providers() != ["CPUExecutionProvider"]:
            raise TensorContractError("unexpected execution provider")
        self._inputs = self._specs(session.get_inputs())
        self._outputs = self._specs(session.get_outputs())
        self._model_sha256 = expected_sha256
        self._session: ort.InferenceSession | None = session
        self._lock = threading.Lock()

    @staticmethod
    def _specs(nodes: list[ort.NodeArg]) -> tuple[TensorSpec, ...]:
        if not 1 <= len(nodes) <= 32 or any(node.type != "tensor(float)" for node in nodes):
            raise TensorContractError("one to 32 float32 tensors required per boundary")
        result = tuple(TensorSpec(node.name, tuple(node.shape)) for node in nodes)
        if len({spec.name for spec in result}) != len(result):
            raise TensorContractError("duplicate tensor names")
        if sum(math.prod(spec.shape) for spec in result) > 16_777_216:
            raise TensorContractError("combined tensor boundary exceeds 64 MiB")
        return result

    @property
    def model_sha256(self) -> str:
        return self._model_sha256

    @property
    def inputs(self) -> tuple[TensorSpec, ...]:
        return self._inputs

    @property
    def outputs(self) -> tuple[TensorSpec, ...]:
        return self._outputs

    def run(self, inputs: Mapping[str, FloatTensor]) -> dict[str, FloatTensor]:
        with self._lock:
            if self._session is None:
                raise TensorExecutionError("executor is closed")
            if set(inputs) != {spec.name for spec in self.inputs}:
                raise TensorContractError("input names do not match the model signature")
            for spec in self.inputs:
                spec.validate(inputs[spec.name])
            try:
                values = self._session.run([spec.name for spec in self.outputs], dict(inputs))
            except Exception as exc:
                raise TensorExecutionError("ONNX execution failed") from exc
            if len(values) != len(self.outputs):
                raise TensorContractError("output count does not match the model signature")
            result: dict[str, FloatTensor] = {}
            for spec, value in zip(self.outputs, values, strict=True):
                tensor = cast(FloatTensor, value)
                spec.validate(tensor)
                result[spec.name] = tensor
            return result

    def close(self) -> None:
        with self._lock:
            self._session = None
