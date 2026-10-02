import dataclasses
import unittest
from concurrent.futures import ThreadPoolExecutor

from veyviz_media_contracts import CaptureClock, FrameReference, PixelFormat, SourceScope, StreamSession

from veyviz_media import (
    FrameCapacityError,
    FrameLease,
    FrameLeaseError,
    FramePool,
    FramePoolError,
    OfferOutcome,
)


def session(**changes):
    values = dict(
        scope=SourceScope("tenant", "site", "camera"),
        source_id="source",
        session_id="session",
        epoch=1,
        view_revision="view",
        clock=CaptureClock("clock", 0, 1000, 0),
    )
    return StreamSession(**(values | changes))


def frame(sequence=0, **changes):
    values = dict(
        session=session(),
        frame_id=f"frame-{sequence}",
        sequence=sequence,
        captured_monotonic_ns=sequence * 10_000_000,
        expires_at_ms=2000,
        width=2,
        height=1,
        pixel_format=PixelFormat.RGB24,
    )
    return FrameReference(**(values | changes))


def pool(**changes):
    values = dict(max_bytes=100, max_frames=10, max_sources=2, max_leases=4)
    result = FramePool(**(values | changes))
    result.register_session(session())
    return result


class FrameOwnershipTests(unittest.TestCase):
    def test_new_frame_does_not_starve_inflight_results_but_session_close_fences_them(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        older = owner.acquire(session(), now_ms=1100)
        owner.offer(frame(1), b"654321", now_ms=1100)
        self.assertTrue(older.result_valid(now_ms=1100))
        newest = owner.acquire(session(), now_ms=1100)
        self.assertEqual(newest.frame.sequence, 1)
        self.assertEqual(bytes(older.pixels), b"123456")
        owner.close_session(session())
        self.assertFalse(older.result_valid(now_ms=1100))
        self.assertFalse(newest.result_valid(now_ms=1100))
        older.complete()
        newest.complete()
        self.assertEqual(owner.snapshot().retained_bytes, 0)

    def test_retired_inflight_frame_is_expired_without_revival(self):
        owner = pool()
        owner.offer(frame(expires_at_ms=1200), b"123456", now_ms=1100)
        older = owner.acquire(session(), now_ms=1100)
        owner.offer(frame(1), b"654321", now_ms=1100)
        self.assertEqual(owner.expire(now_ms=1200), 1)
        self.assertFalse(older.result_valid(now_ms=1100))
        self.assertEqual(owner.snapshot().retained_bytes, 12)
        older.complete()
        self.assertEqual(owner.snapshot().retained_bytes, 6)

    def test_idle_source_can_be_replaced_or_closed_without_a_frame(self):
        owner = pool()
        replacement = session(session_id="new", epoch=2)
        owner.register_session(replacement)
        owner.close_session(replacement)
        self.assertEqual(owner.snapshot().retained_bytes, 0)
        self.assertEqual(owner.snapshot().active_sources, 0)

    def test_empty_then_acquire_read_only_pixels(self):
        owner = pool()
        self.assertIsNone(owner.acquire(session(), now_ms=1100))
        self.assertEqual(owner.offer(frame(), b"123456", now_ms=1100), OfferOutcome.STORED)
        lease = owner.acquire(session(), now_ms=1100)
        self.assertEqual(lease.frame, frame())
        self.assertEqual(bytes(lease.pixels), b"123456")
        self.assertTrue(lease.pixels.readonly)
        with self.assertRaises(TypeError):
            lease.pixels[0] = 0
        self.assertTrue(lease.result_valid(now_ms=1100))
        self.assertTrue(lease.complete())
        self.assertFalse(lease.complete())
        self.assertFalse(lease.cancel())
        self.assertFalse(lease.result_valid(now_ms=1100))
        with self.assertRaises(FrameLeaseError):
            _ = lease.pixels

    def test_immutable_packed_bytes_and_supported_formats(self):
        for pixel_format, pixels in (
            (PixelFormat.RGB24, b"123456"),
            (PixelFormat.BGR24, b"123456"),
            (PixelFormat.GRAY8, b"12"),
        ):
            owner = pool()
            owner.offer(frame(pixel_format=pixel_format), pixels, now_ms=1100)
            lease = owner.acquire(session(), now_ms=1100)
            self.assertEqual(bytes(lease.pixels), pixels)
            lease.complete()
        for pixels in (b"1", bytearray(b"123456"), memoryview(b"123456"), None):
            with self.assertRaises(FramePoolError):
                pool().offer(frame(), pixels, now_ms=1100)

    def test_duplicates_are_idempotent_but_conflicts_fail(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        before = owner.snapshot()
        self.assertEqual(owner.offer(frame(), b"123456", now_ms=1100), OfferOutcome.DUPLICATE)
        self.assertEqual(owner.snapshot(), before)
        for reference, pixels in ((frame(), b"654321"), (frame(frame_id="conflict"), b"123456")):
            with self.assertRaises(FramePoolError):
                owner.offer(reference, pixels, now_ms=1100)
        self.assertEqual(owner.snapshot(), before)

    def test_rejected_older_or_changed_format_does_not_replace_latest(self):
        owner = pool()
        owner.offer(frame(2), b"123456", now_ms=1100)
        for reference, pixels in (
            (frame(1), b"123456"),
            (frame(3, captured_monotonic_ns=1), b"123456"),
            (frame(3, pixel_format=PixelFormat.GRAY8), b"12"),
            (frame(3, width=1), b"123"),
        ):
            with self.assertRaises(FramePoolError):
                owner.offer(reference, pixels, now_ms=1100)
        lease = owner.acquire(session(), now_ms=1100)
        self.assertEqual(lease.frame.sequence, 2)
        lease.complete()

    def test_unleased_latest_can_be_replaced_within_one_frame_budget(self):
        owner = pool(max_bytes=6, max_frames=1)
        owner.offer(frame(), b"123456", now_ms=1100)
        owner.offer(frame(1), b"654321", now_ms=1100)
        self.assertEqual((owner.snapshot().retained_bytes, owner.snapshot().retained_frames), (6, 1))
        lease = owner.acquire(session(), now_ms=1100)
        self.assertEqual(bytes(lease.pixels), b"654321")
        lease.complete()

    def test_cancellation_keeps_pin_until_actual_consumer_completion(self):
        for limits in ({"max_bytes": 6}, {"max_frames": 1}):
            owner = pool(**limits)
            owner.offer(frame(), b"123456", now_ms=1100)
            lease = owner.acquire(session(), now_ms=1100)
            self.assertTrue(lease.cancel())
            self.assertFalse(lease.cancel())
            self.assertFalse(lease.result_valid(now_ms=1100))
            self.assertEqual(owner.snapshot().retained_bytes, 6)
            with self.assertRaises(FrameCapacityError):
                owner.offer(frame(1), b"654321", now_ms=1100)
            self.assertEqual(bytes(lease.pixels), b"123456")
            lease.complete()
            owner.offer(frame(1), b"654321", now_ms=1100)

    def test_expiry_invalidates_work_but_does_not_release_native_pin(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        lease = owner.acquire(session(), now_ms=1100)
        self.assertEqual(owner.expire(now_ms=1999), 0)
        self.assertEqual(owner.expire(now_ms=2000), 1)
        self.assertEqual(owner.expire(now_ms=2001), 0)
        self.assertIsNone(owner.acquire(session(), now_ms=2001))
        self.assertFalse(lease.result_valid(now_ms=2001))
        self.assertEqual(owner.snapshot().retained_bytes, 6)
        lease.complete()
        self.assertEqual(owner.snapshot().retained_bytes, 0)
        self.assertIsNone(owner.acquire(session(), now_ms=2001))

    def test_lazy_acquire_expiry_reclaims_only_unpinned_storage(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        self.assertIsNone(owner.acquire(session(), now_ms=2000))
        self.assertEqual(owner.snapshot().retained_frames, 0)

    def test_replacement_fences_old_lease_and_allows_new_sequence_epoch(self):
        owner = pool()
        owner.offer(frame(2), b"123456", now_ms=1100)
        old = owner.acquire(session(), now_ms=1100)
        new_session = session(session_id="replacement", epoch=2)
        self.assertTrue(owner.register_session(new_session))
        self.assertFalse(old.result_valid(now_ms=1100))
        with self.assertRaises(FramePoolError):
            owner.offer(frame(3), b"123456", now_ms=1100)
        owner.offer(frame(session=new_session), b"654321", now_ms=1100)
        self.assertEqual(owner.snapshot().retained_bytes, 12)
        old.complete()
        self.assertEqual(owner.snapshot().retained_bytes, 6)

    def test_session_close_preserves_high_water_mark_and_source_slot_bound(self):
        owner = pool(max_sources=1)
        owner.offer(frame(), b"123456", now_ms=1100)
        owner.close_session(session())
        self.assertEqual((owner.snapshot().registered_sources, owner.snapshot().active_sources), (1, 0))
        with self.assertRaises(FramePoolError):
            owner.register_session(session())
        with self.assertRaises(FrameCapacityError):
            owner.register_session(session(source_id="another"))
        owner.register_session(session(session_id="new", epoch=2))
        self.assertEqual(owner.snapshot().active_sources, 1)

    def test_close_keeps_all_pinned_bytes_until_each_consumer_completes(self):
        owner = pool(max_leases=2)
        owner.offer(frame(), b"123456", now_ms=1100)
        first = owner.acquire(session(), now_ms=1100)
        second = owner.acquire(session(), now_ms=1100)
        with self.assertRaises(FrameCapacityError):
            owner.acquire(session(), now_ms=1100)
        first.cancel()
        self.assertTrue(second.result_valid(now_ms=1100))
        owner.close()
        owner.close()
        self.assertFalse(second.result_valid(now_ms=1100))
        first.complete()
        self.assertEqual(owner.snapshot().retained_bytes, 6)
        self.assertEqual(owner.snapshot().outstanding_leases, 1)
        second.complete()
        self.assertEqual(owner.snapshot().retained_bytes, 0)
        self.assertTrue(owner.snapshot().closed)
        with self.assertRaises(FramePoolError):
            owner.register_session(session(session_id="new", epoch=2))

    def test_close_without_pins_immediately_reclaims_buffers(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        owner.close()
        self.assertEqual(owner.snapshot().retained_frames, 0)

    def test_another_scope_cannot_acquire_registered_camera_bytes(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        with self.assertRaises(FramePoolError):
            owner.acquire(session(scope=SourceScope("other-tenant", "site", "camera")), now_ms=1100)

    def test_forged_lease_cannot_read_or_release_another_consumer(self):
        owner = pool()
        owner.offer(frame(), b"123456", now_ms=1100)
        actual = owner.acquire(session(), now_ms=1100)
        fake = FrameLease(owner, frame().identity, 1, frame())
        for operation in (
            lambda: fake.pixels,
            lambda: fake.result_valid(now_ms=1100),
            fake.cancel,
            fake.complete,
        ):
            with self.assertRaises(FrameLeaseError):
                operation()
        self.assertEqual(owner.snapshot().outstanding_leases, 1)
        actual.complete()

    def test_lease_admission_is_atomic_across_concurrent_consumers(self):
        owner = pool(max_leases=2)
        owner.offer(frame(), b"123456", now_ms=1100)

        def acquire(_):
            try:
                return owner.acquire(session(), now_ms=1100)
            except FrameCapacityError:
                return None

        with ThreadPoolExecutor(max_workers=8) as executor:
            leases = [lease for lease in executor.map(acquire, range(8)) if lease is not None]
        self.assertEqual(len(leases), 2)
        for lease in leases:
            lease.complete()
        owner.close()
        self.assertEqual(owner.snapshot().retained_bytes, 0)

    def test_invalid_budgets_sessions_times_and_frame_age_are_rejected(self):
        for budget in (0, -1, True, 1 << 63):
            with self.assertRaises(FramePoolError):
                FramePool(max_bytes=budget, max_frames=1, max_sources=1, max_leases=1)
        owner = pool()
        self.assertFalse(owner.register_session(session()))
        for replacement in (session(epoch=2), session(session_id="new"), None):
            with self.assertRaises(FramePoolError):
                owner.register_session(replacement)
        for operation in (
            lambda: owner.acquire(None, now_ms=1100),
            lambda: owner.offer(None, b"123456", now_ms=1100),
            lambda: owner.offer(frame(), b"123456", now_ms=True),
            lambda: owner.acquire(session(), now_ms=True),
            lambda: owner.expire(now_ms=True),
        ):
            with self.assertRaises(FramePoolError):
                operation()
        for now in (999, 2000):
            with self.assertRaises(FramePoolError):
                owner.offer(frame(), b"123456", now_ms=now)
        unknown_clock = dataclasses.replace(session(), clock=CaptureClock("clock", 0, 1000, None))
        unknown = FramePool(max_bytes=10, max_frames=1, max_sources=1, max_leases=1)
        unknown.register_session(unknown_clock)
        with self.assertRaises(FramePoolError):
            unknown.offer(frame(session=unknown_clock), b"123456", now_ms=1100)
        with self.assertRaises(FrameCapacityError):
            pool(max_bytes=5).offer(frame(), b"123456", now_ms=1100)


if __name__ == "__main__":
    unittest.main()
