import dataclasses
import unittest

from veyviz_media_contracts import (
    CaptureClock,
    FrameReference,
    Freshness,
    MediaContractError,
    PixelFormat,
    SourceScope,
    StreamSession,
)


def session(**changes):
    values = dict(
        scope=SourceScope("Tenant-A", "site", "camera"),
        source_id="source",
        session_id="session",
        epoch=1,
        view_revision="view-1",
        clock=CaptureClock("host-boot-1", 1_000_000_000, 1000, 0),
    )
    return StreamSession(**(values | changes))


def frame(**changes):
    values = dict(
        session=session(),
        frame_id="frame-1",
        sequence=0,
        captured_monotonic_ns=1_100_000_000,
        expires_at_ms=1500,
        width=1920,
        height=1080,
        pixel_format=PixelFormat.RGB24,
    )
    return FrameReference(**(values | changes))


class MediaIdentityTests(unittest.TestCase):
    def test_identity_separates_tenants_sessions_and_epochs(self):
        original = frame()
        for changed in (
            frame(session=session(scope=SourceScope("tenant-a", "site", "camera"))),
            frame(session=session(epoch=2)),
            frame(session=session(session_id="reconnect")),
            frame(session=session(source_id="replacement")),
            frame(sequence=1),
            frame(frame_id="frame-2"),
        ):
            self.assertNotEqual(original.identity, changed.identity)
        self.assertEqual(original.session.scope.tenant_id, "Tenant-A")

    def test_clock_mapping_does_not_consult_process_wall_clock(self):
        self.assertEqual(frame().captured_at_ms, 1100)
        self.assertEqual(CaptureClock("clock", 100, 200, 0).to_unix_ms(1_000_099), 200)
        with self.assertRaises(MediaContractError):
            CaptureClock("clock", 100, 200, 0).to_unix_ms(99)
        with self.assertRaises(MediaContractError):
            CaptureClock("clock", 0, (1 << 63) - 1, 0).to_unix_ms(1_000_000)

    def test_expiry_boundary_and_future_are_distinct(self):
        reference = frame()
        self.assertEqual(reference.freshness(now_ms=1099), Freshness.FUTURE)
        self.assertEqual(reference.freshness(now_ms=1100), Freshness.FRESH)
        self.assertEqual(reference.freshness(now_ms=1499), Freshness.FRESH)
        self.assertEqual(reference.freshness(now_ms=1500), Freshness.EXPIRED)

    def test_uncertainty_does_not_become_a_fresh_observation(self):
        reference = frame(session=session(clock=CaptureClock("clock", 1_000_000_000, 1000, 10)))
        self.assertEqual(reference.freshness(now_ms=1089), Freshness.FUTURE)
        self.assertEqual(reference.freshness(now_ms=1090), Freshness.UNKNOWN)
        self.assertEqual(reference.freshness(now_ms=1109), Freshness.UNKNOWN)
        self.assertEqual(reference.freshness(now_ms=1110), Freshness.FRESH)
        unknown = frame(session=session(clock=CaptureClock("clock", 1_000_000_000, 1000, None)))
        self.assertEqual(unknown.freshness(now_ms=1200), Freshness.UNKNOWN)
        self.assertEqual(unknown.freshness(now_ms=1500), Freshness.EXPIRED)

    def test_unknown_clock_and_known_clock_produce_distinct_metadata(self):
        known = frame()
        unknown = frame(session=session(clock=dataclasses.replace(known.session.clock, uncertainty_ms=None)))
        self.assertEqual(known.identity, unknown.identity)
        self.assertNotEqual(known, unknown)  # Same-key metadata conflict must be rejected by a registry.

    def test_records_are_immutable(self):
        reference = frame()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            reference.sequence = 2

    def test_identifiers_are_validated_without_sanitizing(self):
        for value in (None, 5, "", "   ", "x" * 257, "a\nb", "a\x7fb"):
            with self.subTest(value=value), self.assertRaises(MediaContractError):
                SourceScope(value, "site", "camera")
        self.assertEqual(SourceScope("Tenant-東京", "site", "camera").tenant_id, "Tenant-東京")
        with self.assertRaises(MediaContractError):
            session(source_id="")
        with self.assertRaises(MediaContractError):
            frame(frame_id="")

    def test_scope_clock_and_epoch_require_validated_values(self):
        for changes in ({"scope": None}, {"clock": None}, {"epoch": 0}, {"epoch": True}, {"epoch": 1 << 63}):
            with self.assertRaises(MediaContractError):
                session(**changes)
        with self.assertRaises(MediaContractError):
            CaptureClock("clock", -1, 1000, 0)
        for uncertainty in (-1, 60001, True):
            with self.assertRaises(MediaContractError):
                CaptureClock("clock", 0, 1000, uncertainty)

    def test_frame_rejects_invalid_dimensions_formats_and_lifetimes(self):
        for changes in (
            {"session": None},
            {"width": 0},
            {"height": 65537},
            {"sequence": -1},
            {"sequence": True},
            {"pixel_format": "rgb24"},
            {"expires_at_ms": 1100},
            {"captured_monotonic_ns": 1},
            {"captured_monotonic_ns": 1 << 63},
        ):
            with self.subTest(changes=changes), self.assertRaises(MediaContractError):
                frame(**changes)
        uncertain = session(clock=CaptureClock("clock", 1_000_000_000, 1000, 10))
        with self.assertRaises(MediaContractError):
            frame(session=uncertain, expires_at_ms=1110)
        with self.assertRaises(MediaContractError):
            frame().freshness(now_ms=True)


if __name__ == "__main__":
    unittest.main()
