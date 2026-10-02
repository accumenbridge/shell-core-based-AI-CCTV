"""Fixed native ONNX CPU executable; source and capability code stay outside."""

from __future__ import annotations

import sys
import time
from pathlib import Path

from veyviz_execution_contracts import TensorExecutor
from veyviz_process_supervision import WorkerError, integer, read_message, retry_file_access, write_message

from ._tensors import encode_specs, read_tensors, validate_feed, write_tensors
from .runtime import OnnxCpuExecutor


def serve(directory: Path, executor: TensorExecutor) -> None:
    write_message(
        directory,
        "reply.json",
        {
            "request_id": 0,
            "status": "ready",
            "model_sha256": executor.model_sha256,
            "inputs": encode_specs(executor.inputs),
            "outputs": encode_specs(executor.outputs),
        },
    )
    expected = 1
    while True:
        command = directory / "request.json"
        if not command.exists():
            time.sleep(0.005)
            continue
        request = read_message(command)
        retry_file_access(command.unlink)
        if (
            set(request) != {"request_id", "operation", "size", "sha256"}
            or integer(request, "request_id") != expected
            or request.get("operation") != "run"
        ):
            raise WorkerError("out-of-order or invalid execution request")
        try:
            inputs = read_tensors(directory, "input.bin", executor.inputs, request)
            outputs = executor.run(inputs)
            validate_feed(executor.outputs, outputs)
            metadata = write_tensors(directory, "output.bin", executor.outputs, outputs)
            write_message(directory, "reply.json", metadata | {"request_id": expected, "status": "result"})
        except Exception as exc:
            write_message(
                directory,
                "reply.json",
                {"request_id": expected, "status": "failed", "reason": str(exc)[:1024]},
            )
            return
        expected += 1


def main() -> None:
    directory = Path(sys.argv[1])
    try:
        configuration = read_message(directory / "config.json")
        path, digest = configuration.get("path"), configuration.get("sha256")
        if not isinstance(path, str) or not isinstance(digest, str):
            raise WorkerError("model path and digest required")
        executor = OnnxCpuExecutor(
            Path(path),
            expected_sha256=digest,
            max_model_bytes=integer(configuration, "max_model_bytes", minimum=1, maximum=1_073_741_824),
            threads=integer(configuration, "threads", minimum=1, maximum=64),
        )
    except Exception as exc:
        write_message(
            directory, "reply.json", {"request_id": 0, "status": "failed", "reason": str(exc)[:1024]}
        )
        return
    try:
        serve(directory, executor)
    finally:
        executor.close()


if __name__ == "__main__":
    main()
