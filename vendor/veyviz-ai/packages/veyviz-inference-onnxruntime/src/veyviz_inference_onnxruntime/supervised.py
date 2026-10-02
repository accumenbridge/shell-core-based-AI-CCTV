"""ONNX CPU execution in a supervised child, behind the unchanged tensor port."""

from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from pathlib import Path

from veyviz_execution_contracts import FloatTensor, TensorContractError, TensorExecutionError, TensorSpec
from veyviz_process_supervision import WorkerProcess

from ._tensors import decode_specs, read_tensors, validate_feed, write_tensors


class SupervisedOnnxCpuExecutor:
    """Copies cross the process boundary; no shared native input pointers.

    Failed runs fence this owner and attempt confirmed shutdown. On uncertain
    shutdown, WorkerCleanupError retains ownership for a later cleanup retry.
    """

    def __init__(
        self,
        model_path: Path,
        *,
        expected_sha256: str,
        max_model_bytes: int,
        threads: int = 1,
        startup_timeout_ms: int = 30000,
        run_timeout_ms: int = 10000,
        stop_timeout_ms: int = 1000,
    ) -> None:
        if not isinstance(expected_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
            raise TensorContractError("exact lowercase model SHA-256 required")
        for value, maximum in ((max_model_bytes, 1_073_741_824), (threads, 64)):
            if type(value) is not int or not 1 <= value <= maximum:
                raise TensorContractError("positive bounded model/CPU resource required")
        try:
            self._worker = WorkerProcess(
                "veyviz_inference_onnxruntime.worker",
                startup_timeout_ms=startup_timeout_ms,
                request_timeout_ms=run_timeout_ms,
                stop_timeout_ms=stop_timeout_ms,
            )
        except ValueError as exc:
            raise TensorContractError("invalid execution deadlines") from exc
        self._model_sha256 = expected_sha256
        self._lock = threading.Lock()
        self._closed = False
        try:
            reply = self._worker.start(
                {
                    "path": str(model_path.resolve(strict=True)),
                    "sha256": expected_sha256,
                    "max_model_bytes": max_model_bytes,
                    "threads": threads,
                }
            )
            if reply.get("model_sha256") != expected_sha256:
                raise TensorExecutionError("worker model identity mismatch")
            self._inputs = decode_specs(reply.get("inputs"))
            self._outputs = decode_specs(reply.get("outputs"))
        except BaseException as exc:
            self._close_worker()
            if isinstance(exc, Exception):
                raise TensorExecutionError("ONNX worker admission failed") from exc
            raise

    @property
    def model_sha256(self) -> str:
        return self._model_sha256

    def is_alive(self) -> bool:
        """Observed child liveness, without a successful inference claim."""
        with self._lock:
            return not self._closed and not self._worker.exit_confirmed

    @property
    def inputs(self) -> tuple[TensorSpec, ...]:
        return self._inputs

    @property
    def outputs(self) -> tuple[TensorSpec, ...]:
        return self._outputs

    def run(self, inputs: Mapping[str, FloatTensor]) -> dict[str, FloatTensor]:
        with self._lock:
            if self._closed:
                raise TensorExecutionError("ONNX worker closed or failed; new assignment required")
            validate_feed(self.inputs, inputs)
            try:
                metadata = write_tensors(self._worker.directory, "input.bin", self.inputs, inputs)
                reply = self._worker.exchange(metadata | {"operation": "run"})
                if reply.get("status") != "result":
                    raise TensorExecutionError("ONNX worker did not produce a result")
                return read_tensors(self._worker.directory, "output.bin", self.outputs, reply)
            except BaseException as exc:
                self._closed = True
                self._close_worker()
                if isinstance(exc, Exception):
                    raise TensorExecutionError(
                        "ONNX worker execution failed; new assignment required"
                    ) from exc
                raise

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._close_worker()

    def _close_worker(self) -> None:
        try:
            self._worker.close()
        except Exception as exc:
            raise TensorExecutionError("ONNX worker cleanup failed; retain cleanup owner") from exc
