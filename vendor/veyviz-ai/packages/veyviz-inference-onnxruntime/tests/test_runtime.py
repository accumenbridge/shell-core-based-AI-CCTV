import base64
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from veyviz_execution_contracts import TensorContractError, TensorExecutionError, TensorSpec

from veyviz_inference_onnxruntime import OnnxCpuExecutor

# Generated using ONNX 1.19.1 helper.make_model: Identity input->output,
# float32 [1,2], IR 10, opset 18. No weights or external files.
IDENTITY = base64.b64decode(
    "CAo6WAoZCgVpbnB1dBIGb3V0cHV0IghJZGVudGl0eRIIaWRlbnRpdHlaFwoFaW5wdXQSDgoMCAESCAoCCAEKAggCYhgKBm91dHB1dBIOCgwIARIICgIIAQoCCAJCBAoAEBI="
)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "identity.onnx"
        self.path.write_bytes(IDENTITY)
        self.digest = hashlib.sha256(IDENTITY).hexdigest()

    def executor(self, **changes):
        return OnnxCpuExecutor(
            self.path, **(dict(expected_sha256=self.digest, max_model_bytes=4096) | changes)
        )

    def test_real_native_execution_validates_identity_and_releases_session(self):
        executor = self.executor()
        self.assertEqual(executor.model_sha256, self.digest)
        self.assertEqual(executor.inputs, (TensorSpec("input", (1, 2)),))
        self.assertEqual(executor.outputs, (TensorSpec("output", (1, 2)),))
        self.path.write_bytes(b"changed after construction")
        data = np.asarray([[1.25, -2.5]], dtype=np.float32)
        result = executor.run({"input": data})["output"]
        np.testing.assert_array_equal(result, data)
        self.assertFalse(np.shares_memory(result, data))
        executor.close()
        executor.close()
        with self.assertRaises(TensorExecutionError):
            executor.run({"input": data})

    def test_rejects_wrong_names_shapes_and_nonfinite_before_native_execution(self):
        executor = self.executor()
        self.addCleanup(executor.close)
        for feed in (
            {},
            {"other": np.zeros((1, 2), np.float32)},
            {"input": np.zeros((2,), np.float32)},
            {"input": np.full((1, 2), np.inf, np.float32)},
        ):
            with self.assertRaises(TensorContractError):
                executor.run(feed)

    def test_artifact_and_configuration_admission(self):
        for changes in (
            dict(expected_sha256="bad"),
            dict(expected_sha256="0" * 64),
            dict(max_model_bytes=True),
            dict(max_model_bytes=1),
            dict(threads=0),
            dict(threads=True),
        ):
            with self.assertRaises(TensorContractError):
                self.executor(**changes)
        self.path.write_bytes(b"")
        with self.assertRaises(TensorContractError):
            self.executor()
        payload = b"not an ONNX model"
        self.path.write_bytes(payload)
        with self.assertRaises(TensorExecutionError):
            self.executor(expected_sha256=hashlib.sha256(payload).hexdigest())

    def test_unsupported_signatures_and_provider_are_rejected(self):
        node = SimpleNamespace(name="input", shape=[1, 2], type="tensor(float)")
        cases = (
            [],
            [SimpleNamespace(name="input", shape=[1, 2], type="tensor(int64)")],
            [node, node],
            [SimpleNamespace(name="input", shape=[1, "dynamic"], type="tensor(float)")],
            [SimpleNamespace(name=name, shape=[16_777_216], type="tensor(float)") for name in ("a", "b")],
        )
        for nodes in cases:
            with patch("onnxruntime.InferenceSession") as constructor:
                constructor.return_value.get_providers.return_value = ["CPUExecutionProvider"]
                constructor.return_value.get_inputs.return_value = nodes
                with self.assertRaises(TensorContractError):
                    self.executor()
        with patch("onnxruntime.InferenceSession") as constructor:
            constructor.return_value.get_providers.return_value = ["CUDAExecutionProvider"]
            with self.assertRaises(TensorContractError):
                self.executor()

    def test_native_failure_and_invalid_outputs_are_not_empty_success(self):
        executor = self.executor()
        self.addCleanup(executor.close)
        feed = {"input": np.zeros((1, 2), np.float32)}
        with patch.object(executor._session, "run", side_effect=RuntimeError("native failure")):
            with self.assertRaises(TensorExecutionError):
                executor.run(feed)
        for values in ([], [np.full((1, 2), np.nan, np.float32)]):
            with patch.object(executor._session, "run", return_value=values):
                with self.assertRaises(TensorContractError):
                    executor.run(feed)


if __name__ == "__main__":
    unittest.main()
