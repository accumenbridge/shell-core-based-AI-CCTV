import dataclasses
import unittest

from veyviz_media_contracts import (
    CaptureClock,
    FrameReference,
    Freshness,
    PixelFormat,
    SourceScope,
    StreamSession,
)

from veyviz_perception_contracts import (
    BoundingBox,
    Coverage,
    ObservationBatch,
    ObservationOutcome,
    PerceptionContractError,
    PersonDetection,
    ProviderIdentity,
)


def frame():
    session = StreamSession(
        SourceScope("tenant", "site", "camera"),
        "source",
        "session",
        1,
        "view-1",
        CaptureClock("boot-clock", 0, 1000, 0),
    )
    return FrameReference(session, "frame", 0, 0, 2000, 1920, 1080, PixelFormat.RGB24)


def provider(**changes):
    values = dict(
        adapter_id="veyviz.person.example",
        adapter_version="1.0.0",
        model_sha256="a" * 64,
        configuration_sha256="b" * 64,
        preprocessing_revision="preprocess-1",
        ontology_revision="person-1",
        execution_generation=1,
    )
    return ProviderIdentity(**(values | changes))


def detection(identity="d1"):
    return PersonDetection(identity, BoundingBox(0.1, 0.2, 0.3, 0.4), 0.9)


def batch(**changes):
    values = dict(
        frame=frame(),
        provider=provider(),
        completed_at_ms=1100,
        outcome=ObservationOutcome.OBSERVED,
        coverage=Coverage.COMPLETE,
        detections=(detection(),),
    )
    return ObservationBatch(**(values | changes))


class PersonObservationTests(unittest.TestCase):
    def test_box_footpoint_and_source_coordinates(self):
        self.assertEqual(detection().bbox.bottom_center, (0.2, 0.4))
        self.assertEqual(BoundingBox(0, 0, 1, 1).bottom_center, (0.5, 1))

    def test_invalid_boxes_and_confidences_rejected(self):
        for box in (
            (0, 0, 0, 1),
            (0, 1, 1, 0),
            (-1, 0, 1, 1),
            (0, 0, 2, 1),
            (0, 0, float("nan"), 1),
            (False, 0, 1, 1),
        ):
            with self.subTest(box=box), self.assertRaises(PerceptionContractError):
                BoundingBox(*box)
        for score in (True, -0.1, 1.1, float("inf"), float("nan"), None):
            with self.assertRaises(PerceptionContractError):
                PersonDetection("d", BoundingBox(0, 0, 1, 1), score)
        with self.assertRaises(PerceptionContractError):
            PersonDetection("d", None, 0.5)

    def test_empty_measurement_missing_failure_and_partial_remain_distinct(self):
        empty = batch(outcome=ObservationOutcome.OBSERVED_EMPTY, detections=())
        missing = batch(
            outcome=ObservationOutcome.UNOBSERVED,
            coverage=Coverage.UNKNOWN,
            detections=(),
            reason="not_scheduled",
        )
        failed = dataclasses.replace(missing, outcome=ObservationOutcome.FAILED, reason="provider_error")
        partial = dataclasses.replace(empty, coverage=Coverage.PARTIAL, reason="occluded_region")
        self.assertEqual(len({empty, missing, failed, partial}), 4)

    def test_invalid_outcome_and_coverage_combinations_fail_closed(self):
        for changes in (
            {"detections": ()},
            {"outcome": ObservationOutcome.OBSERVED_EMPTY},
            {"outcome": ObservationOutcome.FAILED},
            {"outcome": "observed"},
            {"coverage": "complete"},
            {"coverage": Coverage.PARTIAL},
            {"coverage": Coverage.UNKNOWN},
            {"outcome": ObservationOutcome.UNOBSERVED, "detections": (), "reason": "skipped"},
            {"outcome": ObservationOutcome.FAILED, "detections": (), "coverage": Coverage.UNKNOWN},
        ):
            with self.subTest(changes=changes), self.assertRaises(PerceptionContractError):
                batch(**changes)

    def test_freshness_checks_capture_completion_and_expiry(self):
        value = batch()
        self.assertEqual(value.freshness(now_ms=999), Freshness.FUTURE)
        self.assertEqual(value.freshness(now_ms=1050), Freshness.FUTURE)
        self.assertEqual(value.freshness(now_ms=1100), Freshness.FRESH)
        self.assertEqual(value.freshness(now_ms=2000), Freshness.EXPIRED)
        late = batch(completed_at_ms=2100)
        self.assertEqual(late.freshness(now_ms=2200), Freshness.EXPIRED)

    def test_source_and_model_generations_are_independent_provenance(self):
        original = batch()
        replacement = batch(provider=provider(execution_generation=2))
        self.assertEqual(original.frame, replacement.frame)
        self.assertNotEqual(original.provider, replacement.provider)

    def test_invalid_provenance_and_identifiers_rejected(self):
        for changes in (
            {"model_sha256": "A" * 64},
            {"model_sha256": None},
            {"configuration_sha256": "abc"},
            {"execution_generation": 0},
            {"execution_generation": True},
            {"execution_generation": 1 << 63},
            {"adapter_id": ""},
            {"adapter_version": "\n"},
        ):
            with self.assertRaises(PerceptionContractError):
                provider(**changes)
        for identity in ("", " ", "x" * 257, None, "a\x7fb"):
            with self.assertRaises(PerceptionContractError):
                detection(identity)
        with self.assertRaises(PerceptionContractError):
            batch(reason="")

    def test_detections_are_bounded_unique_validated_and_immutable(self):
        for detections in (None, (None,), (detection(), detection()), (detection(),) * 4097):
            with self.assertRaises(PerceptionContractError):
                batch(detections=detections)
        mutable = [detection()]
        value = batch(detections=mutable)
        mutable.clear()
        self.assertEqual(len(value.detections), 1)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            value.reason = "changed"

    def test_oversized_iterable_does_not_get_fully_materialized(self):
        consumed = []

        def detections():
            for index in range(10000):
                consumed.append(index)
                yield detection(str(index))

        with self.assertRaises(PerceptionContractError):
            batch(detections=detections())
        self.assertEqual(len(consumed), 4097)

    def test_invalid_frame_provenance_and_completion_time_rejected(self):
        for changes in (
            {"frame": None},
            {"provider": None},
            {"completed_at_ms": 999},
            {"completed_at_ms": True},
            {"completed_at_ms": 1 << 63},
        ):
            with self.assertRaises(PerceptionContractError):
                batch(**changes)


if __name__ == "__main__":
    unittest.main()
