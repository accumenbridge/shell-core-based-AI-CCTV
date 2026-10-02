import dataclasses
import unittest
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from veyviz_execution_contracts import TensorContractError, TensorSpec
from veyviz_media_contracts import CaptureClock, FrameReference, PixelFormat, SourceScope, StreamSession
from veyviz_perception_contracts import Coverage, ObservationOutcome

from veyviz_model_rfdetr import (
    LARGE_MODEL_SHA256,
    MODEL_SHA256,
    RfDetrLargePersonAdapter,
    RfDetrSmallPersonAdapter,
)


def frame(**changes):
    session = StreamSession(
        SourceScope("tenant", "site", "camera"),
        "source",
        "session",
        1,
        "view",
        CaptureClock("clock", 0, 1000, 0),
    )
    return FrameReference(
        **(
            dict(
                session=session,
                frame_id="frame",
                sequence=0,
                captured_monotonic_ns=0,
                expires_at_ms=2000,
                width=2,
                height=1,
                pixel_format=PixelFormat.RGB24,
            )
            | changes
        )
    )


def outputs():
    return {
        "pred_boxes": np.zeros((1, 300, 4), dtype=np.float32),
        "pred_logits": np.full((1, 300, 91), -10.0, dtype=np.float32),
    }


class ExecutorSignature:
    model_sha256 = MODEL_SHA256
    inputs = (TensorSpec("input", (1, 3, 512, 512)),)
    outputs = (TensorSpec("pred_logits", (1, 300, 91)), TensorSpec("pred_boxes", (1, 300, 4)))


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.adapter = RfDetrSmallPersonAdapter(confidence=0.5, execution_generation=1)

    def test_large_profile_is_distinct_and_rejects_small_executor(self):
        large = RfDetrLargePersonAdapter(confidence=0.5, execution_generation=2)
        with self.assertRaises(TensorContractError):
            large.validate_executor(ExecutorSignature())
        signature = ExecutorSignature()
        signature.model_sha256 = LARGE_MODEL_SHA256
        signature.inputs = (TensorSpec("input", (1, 3, 704, 704)),)
        large.validate_executor(signature)
        with self.assertRaises(TensorContractError):
            self.adapter.validate_executor(signature)
        tensor = large.prepare(frame(), bytes([255, 0, 0] * 2))["input"]
        self.assertEqual(tensor.shape, (1, 3, 704, 704))
        np.testing.assert_allclose(
            tensor[0, :, 0, 0], self.adapter.prepare(frame(), bytes([255, 0, 0] * 2))["input"][0, :, 0, 0]
        )
        self.assertNotEqual(large.provider.configuration_sha256, self.adapter.provider.configuration_sha256)
        values = outputs()
        values["pred_boxes"][0, 0] = [0.5, 0.5, 0.5, 0.5]
        values["pred_logits"][0, 0, 1] = 4
        batch = large.decode(values, frame(), completed_at_ms=1100, coverage=Coverage.COMPLETE)
        self.assertEqual(batch.provider.model_sha256, LARGE_MODEL_SHA256)
        self.assertEqual(batch.provider.execution_generation, 2)
        self.assertEqual(dataclasses.astuple(batch.detections[0].bbox), (0.25, 0.25, 0.75, 0.75))

    def test_person_focal_logits_and_original_normalized_coordinates(self):
        values = outputs()
        values["pred_boxes"][0, 0] = [0.5, 0.5, 0.5, 0.5]
        values["pred_logits"][0, 0, 1] = 4
        values["pred_boxes"][0, 1] = [0.5, 0.5, 0.2, 0.2]
        values["pred_logits"][0, 1, 90] = 10
        batch = self.adapter.decode(values, frame(), completed_at_ms=1100, coverage=Coverage.COMPLETE)
        self.assertEqual(batch.outcome, ObservationOutcome.OBSERVED)
        self.assertEqual(len(batch.detections), 1)
        detection = batch.detections[0]
        self.assertEqual(dataclasses.astuple(detection.bbox), (0.25, 0.25, 0.75, 0.75))
        self.assertAlmostEqual(detection.confidence, 0.9820138)
        self.assertEqual(detection.detection_id, "query-0")
        self.assertEqual(batch.provider.model_sha256, MODEL_SHA256)

    def test_invalid_or_unobservable_inputs_cannot_become_empty(self):
        for replacement in (
            {},
            {"pred_boxes": np.zeros((1, 1, 4), dtype=np.float32), "pred_logits": outputs()["pred_logits"]},
        ):
            with self.assertRaises(TensorContractError):
                self.adapter.decode(replacement, frame(), completed_at_ms=1100, coverage=Coverage.COMPLETE)
        for key in ("pred_boxes", "pred_logits"):
            values = outputs()
            values[key].flat[0] = np.nan
            with self.assertRaises(TensorContractError):
                self.adapter.decode(values, frame(), completed_at_ms=1100, coverage=Coverage.COMPLETE)
        values = outputs()
        values["pred_boxes"][0, 0, 2] = -1
        with self.assertRaises(TensorContractError):
            self.adapter.decode(values, frame(), completed_at_ms=1100, coverage=Coverage.COMPLETE)
        empty = self.adapter.decode(
            outputs(), frame(), completed_at_ms=1100, coverage=Coverage.PARTIAL, reason="occluded"
        )
        self.assertEqual(empty.outcome, ObservationOutcome.OBSERVED_EMPTY)
        self.assertEqual(empty.coverage, Coverage.PARTIAL)

    def test_clips_boxes_and_rejects_degenerate_selected_queries(self):
        values = outputs()
        values["pred_logits"][0, :2, 1] = 10
        values["pred_boxes"][0, 0] = [0.5, 0.5, 2, 2]
        batch = self.adapter.decode(values, frame(), completed_at_ms=1100, coverage=Coverage.COMPLETE)
        self.assertEqual(len(batch.detections), 1)
        self.assertEqual(dataclasses.astuple(batch.detections[0].bbox), (0, 0, 1, 1))

    def test_rgb_bgr_are_equivalent_and_request_state_is_not_shared(self):
        red = bytes([255, 0, 0] * 2)
        blue = bytes([0, 0, 255] * 2)
        tensor = self.adapter.prepare(frame(), red)["input"]
        bgr = self.adapter.prepare(frame(pixel_format=PixelFormat.BGR24), blue)["input"]
        np.testing.assert_array_equal(tensor, bgr)
        self.assertEqual(tensor.shape, (1, 3, 512, 512))
        np.testing.assert_allclose(
            tensor[0, :, 0, 0],
            (np.array([1, 0, 0]) - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225],
            rtol=1e-6,
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(lambda payload: self.adapter.prepare(frame(), payload)["input"], [red, blue])
            )
        np.testing.assert_array_equal(results[0], tensor)
        self.assertFalse(np.shares_memory(*results))
        self.assertNotEqual(results[0][0, 0, 0, 0], results[1][0, 0, 0, 0])

    def test_preprocessing_rejects_mismatched_or_mutable_pixels(self):
        for reference, pixels in (
            (None, b"123456"),
            (frame(pixel_format=PixelFormat.GRAY8), b"12"),
            (frame(), None),
            (frame(), b"1"),
            (frame(), bytearray(b"123456")),
            (frame(), memoryview(bytearray(b"123456"))),
            (frame(), memoryview(b"123456")[::2]),
        ):
            with self.assertRaises(TensorContractError):
                self.adapter.prepare(reference, pixels)

    def test_exact_model_and_signature_required(self):
        self.adapter.validate_executor(ExecutorSignature())
        for attribute, wrong in (
            ("model_sha256", "0" * 64),
            ("inputs", (TensorSpec("input", (1, 3, 704, 704)),)),
            ("outputs", ()),
        ):
            executor = ExecutorSignature()
            setattr(executor, attribute, wrong)
            with self.assertRaises(TensorContractError):
                self.adapter.validate_executor(executor)

    def test_configuration_provenance_is_deterministic_and_sensitive_to_threshold(self):
        same = RfDetrSmallPersonAdapter(confidence=0.5, execution_generation=2)
        other = RfDetrSmallPersonAdapter(confidence=0.6, execution_generation=1)
        self.assertEqual(same.provider.configuration_sha256, self.adapter.provider.configuration_sha256)
        self.assertNotEqual(other.provider.configuration_sha256, self.adapter.provider.configuration_sha256)
        self.assertNotEqual(same.provider.execution_generation, self.adapter.provider.execution_generation)
        for confidence in (True, None, -1, 2, float("nan")):
            with self.assertRaises(TensorContractError):
                RfDetrSmallPersonAdapter(confidence=confidence, execution_generation=1)


if __name__ == "__main__":
    unittest.main()
