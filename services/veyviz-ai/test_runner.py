"""Run with the private installed environment; --profile enables real CPU tests."""
from __future__ import annotations

import argparse
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

RUNNER = Path(__file__).with_name("runner.py")
spec = importlib.util.spec_from_file_location("veyviz_product_runner", RUNNER)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
PROFILE = None
REQUEST = {"schema": "veyviz.recorded-analysis.request.v1", "jobId": "python-proof-1",
           "commandId": "python-proof-command-1", "scope": {"productId": "veyviz-review",
           "instanceId": "veyviz-local", "tenantId": "alpha", "actorId": "admin", "actorKind": "user"},
           "sourceId": "source-fixture-1", "sourceVersion": 1, "fixtureId": "mivia-vid0062",
           "profileId": "rfdetr-small-cpu-v1", "frameCount": 3, "sampleStride": 10}


class ProtocolTests(unittest.TestCase):
    def test_identity_roundtrip(self):
        self.assertEqual(runner.validate_request(copy.deepcopy(REQUEST)), REQUEST)

    def test_unknown_and_missing_fields_denied(self):
        for patch in ({"modelPath": "untrusted"}, {"frameCount": True}, {"frameCount": 7},
                      {"sampleStride": 31}, {"sourceVersion": 0}, {"jobId": "../outside"},
                      {"fixtureId": "other"}, {"profileId": "other"}):
            with self.subTest(patch=patch), self.assertRaises(runner.ProtocolError):
                runner.validate_request(REQUEST | patch)
        value = copy.deepcopy(REQUEST)
        del value["scope"]["actorId"]
        with self.assertRaises(runner.ProtocolError):
            runner.validate_request(value)

    def test_duplicate_nonfinite_and_nonobject_denied(self):
        for data in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}'):
            with self.subTest(data=data), self.assertRaises(runner.ProtocolError):
                runner.strict_json(data)
        with self.assertRaises(runner.ProtocolError):
            runner.validate_request([])

    def test_cancellation_identity_is_required(self):
        for value, invalid in (({"type": "cancel", "jobId": REQUEST["jobId"]}, False),
                               ({"type": "cancel", "jobId": "wrong"}, True)):
            with tempfile.TemporaryFile() as stream:
                stream.write(json.dumps(value).encode() + b"\n")
                stream.seek(0)
                control = runner.Cancellation()
                control.listen(REQUEST["jobId"], stream.fileno())
                self.assertTrue(control.event.is_set())
                self.assertEqual(control.invalid, invalid)
                with self.assertRaises(runner.ProtocolError if invalid else runner.Cancelled):
                    control.check()

    def test_control_size_is_bounded(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(b"x" * (runner.MAX_REQUEST + 2))
            stream.seek(0)
            with self.assertRaises(runner.ProtocolError):
                runner.read_line(stream.fileno(), runner.MAX_REQUEST)

    def test_installed_packages_are_not_original_checkout_imports(self):
        import veyviz_source_recording
        import veyviz_model_rfdetr
        import veyviz_inference_onnxruntime
        for module in (veyviz_source_recording, veyviz_model_rfdetr, veyviz_inference_onnxruntime):
            self.assertIn(Path(sys.prefix).resolve(), Path(module.__file__).resolve().parents)


class RealExecutionTests(unittest.TestCase):
    def setUp(self):
        if PROFILE is None:
            self.skipTest("Actual installed profile not supplied")

    def launch(self, request: object, control: object | None = None):
        payload = json.dumps(request).encode() + b"\n"
        if control is not None:
            payload += json.dumps(control).encode() + b"\n"
        result = subprocess.run([sys.executable, "-I", str(RUNNER), "--profile", str(PROFILE)],
                                input=payload, capture_output=True, timeout=180)
        self.assertLessEqual(len(result.stdout), runner.MAX_RESPONSE)
        self.assertEqual(len(result.stdout.splitlines()), 1, result.stderr.decode())
        return result, json.loads(result.stdout)

    def test_real_three_sample_inference_and_cleanup(self):
        process, result = self.launch(REQUEST)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["request"], REQUEST)
        self.assertEqual(result["decodedFrames"], 21)
        self.assertEqual(result["coverage"], "UNCOMMISSIONED_RECORDING")
        self.assertEqual(result["occupancy"], "UNKNOWN")
        self.assertEqual(result["cleanup"], {"sourceClosed": True, "inferenceClosed": True,
                                            "retainedBytes": 0, "outstandingLeases": 0})
        self.assertEqual([sample["frameIndex"] for sample in result["samples"]], [0, 10, 20])
        import cv2
        import numpy as np
        for sample in result["samples"]:
            self.assertGreater(sample["inferenceMs"], 0)
            self.assertLessEqual(len(sample["detections"]), 100)
            for detection in sample["detections"]:
                self.assertGreaterEqual(detection["confidence"], .5)
                self.assertTrue(0 <= detection["x1"] < detection["x2"] <= sample["width"])
                self.assertTrue(0 <= detection["y1"] < detection["y2"] <= sample["height"])
            thumbnail = base64.b64decode(sample["thumbnailJpegBase64"], validate=True)
            self.assertLessEqual(len(thumbnail), 96 * 1024)
            decoded = cv2.imdecode(np.frombuffer(thumbnail, dtype=np.uint8), cv2.IMREAD_COLOR)
            self.assertLessEqual(max(decoded.shape[:2]), 640)
        evidence = Path(PROFILE).parent / "evidence"
        evidence.mkdir(exist_ok=True)
        (evidence / "real-three-sample.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    def test_invalid_input_has_no_native_work(self):
        process, result = self.launch(REQUEST | {"frameCount": 100})
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(result["status"], "FAILED")
        self.assertNotIn("source-ready", process.stderr.decode())
        self.assertTrue(result["cleanup"]["sourceClosed"])

    def test_cancel_before_execution(self):
        process, result = self.launch(REQUEST, {"type": "cancel", "jobId": REQUEST["jobId"]})
        self.assertEqual(process.returncode, 3)
        self.assertEqual(result["status"], "CANCELLED")
        self.assertEqual(result["request"], REQUEST)
        self.assertTrue(result["cleanup"]["sourceClosed"])
        self.assertTrue(result["cleanup"]["inferenceClosed"])

    def test_cancel_after_native_owners_started(self):
        process = subprocess.Popen([sys.executable, "-I", str(RUNNER), "--profile", str(PROFILE)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        lines = queue.Queue()
        diagnostics = []
        output = bytearray()
        def collect():
            for line in iter(process.stderr.readline, b""):
                diagnostics.append(line)
                lines.put(line)
        def collect_output():
            for data in iter(lambda: process.stdout.read(65536), b""):
                output.extend(data)
        reader = threading.Thread(target=collect, daemon=True)
        output_reader = threading.Thread(target=collect_output, daemon=True)
        reader.start()
        output_reader.start()
        try:
            request = REQUEST | {"frameCount": 6, "sampleStride": 30}
            process.stdin.write(json.dumps(request).encode() + b"\n")
            process.stdin.flush()
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                try:
                    line = lines.get(timeout=1)
                except queue.Empty:
                    if process.poll() is not None:
                        self.fail("Runner exited before native startup: " + b"".join(diagnostics).decode())
                    continue
                if b"inference-ready" in line:
                    break
            else:
                self.fail("Native inference owner never became ready: " + b"".join(diagnostics).decode())
            process.stdin.write(json.dumps({"type": "cancel", "jobId": request["jobId"]}).encode() + b"\n")
            process.stdin.flush()
            process.stdin.close()
            process.wait(timeout=30)
            output_reader.join(timeout=5)
            result = json.loads(output)
            self.assertEqual(process.returncode, 3)
            self.assertEqual(result["status"], "CANCELLED")
            self.assertEqual(result["cleanup"], {"sourceClosed": True, "inferenceClosed": True,
                                                "retainedBytes": 0, "outstandingLeases": 0})
        finally:
            if process.poll() is None:
                # Failure is not a native cleanup success claim. The runner's
                # own native deadlines still remain the primary close path.
                process.stdin.close()
                process.wait(timeout=120)
            process.stdout.close()
            output_reader.join(timeout=5)
            reader.join(timeout=5)
            process.stderr.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path)
    args, remaining = parser.parse_known_args()
    PROFILE = args.profile
    unittest.main(argv=[sys.argv[0], *remaining])
