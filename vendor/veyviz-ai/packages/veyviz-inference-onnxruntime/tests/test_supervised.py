import hashlib
import runpy
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
from test_runtime import IDENTITY
from veyviz_execution_contracts import TensorContractError, TensorExecutionError, TensorSpec
from veyviz_process_supervision import (
    WorkerCleanupError,
    WorkerError,
    WorkerProcess,
    read_message,
    write_message,
)

from veyviz_inference_onnxruntime import SupervisedOnnxCpuExecutor, worker
from veyviz_inference_onnxruntime._tensors import (
    decode_specs,
    encode_specs,
    read_tensors,
    validate_feed,
    write_tensors,
)


class SupervisedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "identity.onnx"
        self.path.write_bytes(IDENTITY)
        self.digest = hashlib.sha256(IDENTITY).hexdigest()
        self.feed = {"input": np.asarray([[1.25, -2.5]], dtype=np.float32)}

    def executor(self, script=None, **changes):
        options = dict(expected_sha256=self.digest, max_model_bytes=4096) | changes
        if script is None:
            executor = SupervisedOnnxCpuExecutor(self.path, **options)
        else:
            path = self.directory / "controlled_worker.py"
            path.write_text(script, encoding="utf-8")
            with patch.object(
                WorkerProcess,
                "_command",
                lambda owner: [sys.executable, "-I", str(path), str(owner.directory)],
            ):
                executor = SupervisedOnnxCpuExecutor(self.path, **options)
        self.addCleanup(executor.close)
        return executor

    def idle_script(self, **changes):
        reply = (
            dict(
                request_id=0,
                status="ready",
                model_sha256=self.digest,
                inputs=[dict(name="input", shape=[1, 2])],
                outputs=[dict(name="output", shape=[1, 2])],
            )
            | changes
        )
        return (
            "import sys,time\nfrom pathlib import Path\nfrom veyviz_process_supervision import write_message\n"
            + f"write_message(Path(sys.argv[1]),'reply.json',{reply!r})\ntime.sleep(60)\n"
        )

    def test_real_child_identity_and_parent_owned_outputs(self):
        executor = self.executor()
        self.assertTrue(executor.is_alive())
        self.assertEqual(executor.model_sha256, self.digest)
        self.assertEqual(executor.inputs, (TensorSpec("input", (1, 2)),))
        self.assertEqual(executor.outputs, (TensorSpec("output", (1, 2)),))
        self.path.write_bytes(b"changed model after admission")
        output = executor.run(self.feed)["output"]
        np.testing.assert_array_equal(output, self.feed["input"])
        self.assertFalse(np.shares_memory(output, self.feed["input"]))
        self.feed["input"][:] = 7
        later = executor.run(self.feed)["output"]
        np.testing.assert_array_equal(output, [[1.25, -2.5]])
        np.testing.assert_array_equal(later, [[7, 7]])
        self.assertTrue(output.flags.writeable)
        executor.close()
        self.assertFalse(executor.is_alive())
        executor.close()
        self.assertTrue(executor._worker.exit_confirmed)
        self.assertFalse(executor._worker.directory.exists())
        with self.assertRaises(TensorExecutionError):
            executor.run(self.feed)

    def test_bad_input_does_not_poison_healthy_worker_and_calls_serialize(self):
        executor = self.executor()
        for feed in (
            {},
            {"wrong": self.feed["input"]},
            {"input": np.zeros((1, 3), np.float32)},
            {"input": np.full((1, 2), np.inf, np.float32)},
        ):
            with self.assertRaises(TensorContractError):
                executor.run(feed)

        def run(value):
            return executor.run({"input": np.full((1, 2), value, np.float32)})["output"]

        with ThreadPoolExecutor(max_workers=4) as threads:
            values = list(threads.map(run, range(8)))
        for index, value in enumerate(values):
            np.testing.assert_array_equal(value, [[index, index]])

    def test_parent_does_not_import_onnxruntime(self):
        probe = subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                "import sys,veyviz_inference_onnxruntime; assert 'onnxruntime' not in sys.modules",
            ],
            capture_output=True,
            timeout=20,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)

    def test_bad_admission_and_identity_are_rejected(self):
        for changes in (
            dict(expected_sha256=None),
            dict(expected_sha256="bad"),
            dict(max_model_bytes=True),
            dict(threads=0),
            dict(run_timeout_ms=0),
        ):
            with self.assertRaises(TensorContractError):
                self.executor(**changes)
        with self.assertRaises(TensorExecutionError):
            self.executor(expected_sha256="0" * 64)
        with self.assertRaises(TensorExecutionError):
            self.executor(self.idle_script(model_sha256="0" * 64))
        with self.assertRaises(TensorExecutionError):
            self.executor(self.idle_script(inputs=[]))
        with patch.object(WorkerProcess, "start", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.executor()

    def test_hung_execution_abrupt_death_and_stale_reply_are_fenced(self):
        for mode in ("timeout", "death", "stale"):
            executor = self.executor(self.idle_script(), run_timeout_ms=50)
            if mode == "death":
                executor._worker._process.kill()
                executor._worker._process.wait(timeout=5)
            elif mode == "stale":
                write_message(
                    executor._worker.directory, "reply.json", {"request_id": 999, "status": "result"}
                )
            with self.assertRaises(TensorExecutionError):
                executor.run(self.feed)
            self.assertTrue(executor._worker.exit_confirmed)
            self.assertFalse(executor._worker.directory.exists())
            with self.assertRaises(TensorExecutionError):
                executor.run(self.feed)

    def test_failed_or_corrupt_result_and_interrupt_release_worker(self):
        for status, payload, digest in (
            ("failed", b"12345678", None),
            ("result", b"12345678", "0" * 64),
            ("result", b"short", None),
            ("result", np.full((1, 2), np.nan, np.float32).tobytes(), None),
        ):
            executor = self.executor(self.idle_script())
            (executor._worker.directory / "output.bin").write_bytes(payload)
            reply = dict(status=status, size=8, sha256=digest or hashlib.sha256(payload).hexdigest())
            with patch.object(executor._worker, "exchange", return_value=reply):
                with self.assertRaises(TensorExecutionError):
                    executor.run(self.feed)
            self.assertTrue(executor._worker.exit_confirmed)
            self.assertFalse(executor._worker.directory.exists())
        executor = self.executor(self.idle_script())
        with patch.object(executor._worker, "exchange", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                executor.run(self.feed)
        self.assertTrue(executor._worker.exit_confirmed)

    def test_constructor_cleanup_failure_retains_owner_in_error_cause(self):
        owner = WorkerProcess("veyviz_inference_onnxruntime.worker")
        self.addCleanup(owner.close)
        cleanup = WorkerCleanupError("stop unconfirmed", owner)
        with (
            patch("veyviz_inference_onnxruntime.supervised.WorkerProcess", return_value=owner),
            patch.object(owner, "start", side_effect=WorkerError("startup failed")),
            patch.object(owner, "close", side_effect=cleanup),
        ):
            with self.assertRaises(TensorExecutionError) as failure:
                self.executor()
        self.assertIs(failure.exception.__cause__.owner, owner)
        failure.exception.__cause__.owner.close()
        self.assertFalse(owner.directory.exists())


class TensorWireTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_signature_and_multi_tensor_payload_round_trip(self):
        specs = (TensorSpec("a", (1, 2)), TensorSpec("b", (3,)))
        self.assertEqual(decode_specs(encode_specs(specs)), specs)
        values = {"b": np.asarray([3, 4, 5], np.float32), "a": np.asarray([[1, 2]], np.float32)}
        validate_feed(specs, values)
        metadata = write_tensors(self.directory, "values.bin", specs, values)
        recovered = read_tensors(self.directory, "values.bin", specs, metadata)
        for name in values:
            np.testing.assert_array_equal(recovered[name], values[name])
            self.assertFalse(np.shares_memory(recovered[name], values[name]))
        self.assertEqual(
            (self.directory / "values.bin").read_bytes(), np.asarray([1, 2, 3, 4, 5], "<f4").tobytes()
        )
        with self.assertRaises(WorkerError):
            read_tensors(self.directory, "values.bin", specs, metadata | {"size": 4})
        with self.assertRaises(WorkerError):
            read_tensors(self.directory, "values.bin", specs, metadata | {"sha256": "0" * 64})

    def test_invalid_and_over_budget_signatures(self):
        for value in (
            None,
            [],
            [None],
            [{"name": None, "shape": [1]}],
            [{"name": "a", "shape": None}],
            [{"name": "a", "shape": [True]}],
            [{"name": "a", "shape": [1]}] * 2,
            [{"name": name, "shape": [16_777_216]} for name in ("a", "b")],
        ):
            with self.assertRaises((WorkerError, TensorContractError)):
                decode_specs(value)
        # The maximum count/name/rank metadata fits the shared control budget.
        specs = tuple(TensorSpec("t" + str(n) + "x" * 120, (1,) * 8) for n in range(32))
        write_message(
            self.directory, "reply.json", {"inputs": encode_specs(specs), "outputs": encode_specs(specs)}
        )
        self.assertEqual(decode_specs(read_message(self.directory / "reply.json")["inputs"]), specs)

    def test_worker_loop_real_payload_and_failure_are_distinct(self):
        executor = Mock()
        executor.model_sha256 = "0" * 64
        executor.inputs = (TensorSpec("input", (1, 2)),)
        executor.outputs = (TensorSpec("output", (1, 2)),)
        executor.run.side_effect = [
            {"output": np.asarray([[4, 9]], np.float32)},
            TensorExecutionError("native failure"),
        ]
        failure = []

        def serve():
            try:
                worker.serve(self.directory, executor)
            except BaseException as exc:
                failure.append(exc)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()

        def reply():
            path = self.directory / "reply.json"
            deadline = time.monotonic() + 5
            while not path.exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            result = read_message(path)
            path.unlink()
            return result

        self.assertEqual(reply()["status"], "ready")
        metadata = write_tensors(
            self.directory, "input.bin", executor.inputs, {"input": np.asarray([[4, 9]], np.float32)}
        )
        write_message(self.directory, "request.json", metadata | {"request_id": 1, "operation": "run"})
        result = reply()
        self.assertEqual(result["status"], "result")
        np.testing.assert_array_equal(
            read_tensors(self.directory, "output.bin", executor.outputs, result)["output"], [[4, 9]]
        )
        write_message(self.directory, "request.json", metadata | {"request_id": 2, "operation": "run"})
        self.assertEqual(reply()["status"], "failed")
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failure, [])
        for message in (
            {"request_id": 3},
            metadata | {"request_id": 2, "operation": "run"},
            metadata | {"request_id": 1, "operation": "other"},
        ):
            write_message(self.directory, "request.json", message)
            with self.assertRaisesRegex(WorkerError, "out-of-order"):
                worker.serve(self.directory, executor)

    def test_worker_entry_closes_executor_and_reports_startup_failure(self):
        configuration = dict(
            path=str(self.directory / "model.onnx"), sha256="0" * 64, max_model_bytes=4096, threads=1
        )
        write_message(self.directory, "config.json", configuration)
        with (
            patch.object(sys, "argv", ["worker", str(self.directory)]),
            patch.object(worker, "OnnxCpuExecutor") as factory,
            patch.object(worker, "serve") as serve,
        ):
            worker.main()
            factory.return_value.close.assert_called_once()
            serve.assert_called_once_with(self.directory, factory.return_value)
            serve.side_effect = WorkerError("invalid request")
            with self.assertRaises(WorkerError):
                worker.main()
            self.assertEqual(factory.return_value.close.call_count, 2)
            serve.side_effect = lambda directory, executor: write_message(
                directory, "reply.json", {"request_id": 7, "status": "result"}
            )
            factory.return_value.close.side_effect = TensorExecutionError("shutdown failed")
            with self.assertRaises(TensorExecutionError):
                worker.main()
            self.assertEqual(
                read_message(self.directory / "reply.json"), {"request_id": 7, "status": "result"}
            )
        write_message(self.directory, "config.json", {"path": None})
        with patch.object(sys, "argv", ["worker", str(self.directory)]), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            runpy.run_module("veyviz_inference_onnxruntime.worker", run_name="__main__")
        self.assertEqual(read_message(self.directory / "reply.json")["status"], "failed")
