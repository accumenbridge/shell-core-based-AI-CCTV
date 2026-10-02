import dataclasses
import unittest
from fractions import Fraction

from veyviz_media_contracts import CaptureClock, PixelFormat, SourceScope, StreamSession

from veyviz_media import DecodedVideoFrame, RecordingTimeline, SourceContractError


def decoded(**changes):
    return DecodedVideoFrame(
        **(
            dict(
                sequence=0,
                presentation_time=Fraction(3, 2),
                width=2,
                height=1,
                pixel_format=PixelFormat.BGR24,
                pixels=b"123456",
            )
            | changes
        )
    )


def session():
    return StreamSession(
        SourceScope("tenant", "site", "camera"),
        "source",
        "session",
        1,
        "view",
        CaptureClock("virtual", 100, 1000, 0),
    )


class SourceContractsTests(unittest.TestCase):
    def test_exact_fraction_and_immutable_pixels(self):
        value = decoded(presentation_time=Fraction(-1, 90000))
        self.assertEqual(value.presentation_time, Fraction(-1, 90000))
        self.assertEqual(decoded(pixel_format=PixelFormat.GRAY8, pixels=b"12").pixels, b"12")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            value.sequence = 1

    def test_invalid_decoded_metadata_and_payload(self):
        for changes in (
            dict(sequence=True),
            dict(sequence=-1),
            dict(presentation_time=0.5),
            dict(presentation_time=Fraction(1 << 63)),
            dict(width=0),
            dict(height=True),
            dict(pixel_format="rgb24"),
            dict(pixels=bytearray(b"123456")),
            dict(pixels=b"12"),
            dict(width=65536, height=65536),
        ):
            with self.subTest(changes=changes), self.assertRaises(SourceContractError):
                decoded(**changes)

    def test_explicit_origin_preserves_fractional_spacing_and_scope(self):
        timeline = RecordingTimeline(session(), Fraction(3, 2), 100)
        first = timeline.reference(decoded())
        later = timeline.reference(
            decoded(sequence=30, presentation_time=Fraction(3, 2) + Fraction(1001, 30000))
        )
        self.assertEqual(first.captured_monotonic_ns, 100)
        self.assertEqual(later.captured_monotonic_ns, 33_366_766)
        self.assertEqual(later.captured_at_ms, 1033)
        self.assertEqual(later.expires_at_ms, 1133)
        self.assertEqual(later.session, session())
        self.assertEqual(later.sequence, 30)

    def test_invalid_timeline_does_not_invent_timestamps(self):
        for args in (
            (None, Fraction(0), 10),
            (session(), 0.0, 10),
            (session(), Fraction(0), True),
            (session(), Fraction(0), 0),
            (dataclasses.replace(session(), clock=CaptureClock("clock", 0, 1000, 10)), Fraction(0), 10),
        ):
            with self.assertRaises(SourceContractError):
                RecordingTimeline(*args)
        timeline = RecordingTimeline(session(), Fraction(3, 2), 100)
        for frame in (None, decoded(presentation_time=Fraction(1))):
            with self.assertRaises(SourceContractError):
                timeline.reference(frame)


if __name__ == "__main__":
    unittest.main()
