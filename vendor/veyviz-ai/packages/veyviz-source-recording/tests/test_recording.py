import hashlib
import tempfile
import unittest
import weakref
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import av
import numpy as np
from veyviz_media import SourceContractError, SourceReadError

from veyviz_source_recording import PyAvRecordingSource


class RecordingTests(unittest.TestCase):
    def test_close_discards_decoder_iterator_and_its_native_frame_references(self):
        source = self.source()
        iterator = weakref.ref(source._frames)
        source.read()
        source.close()
        self.assertIsNone(iterator())
        self.assertFalse(source._snapshot_path.exists())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "fixture.mkv"
        with av.open(str(self.path), "w") as container:
            stream = container.add_stream("ffv1", rate=25)
            stream.width, stream.height = 16, 16
            stream.pix_fmt = "bgr0"
            stream.time_base = Fraction(1, 1000)
            stream.codec_context.time_base = Fraction(1, 1000)
            for pts, color in [(1000, 20), (1040, 100), (1120, 200)]:
                frame = av.VideoFrame.from_ndarray(
                    np.full((16, 16, 3), color, dtype=np.uint8), format="bgr24"
                )
                frame.pts, frame.time_base = pts, Fraction(1, 1000)
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def source(self, **changes):
        source = PyAvRecordingSource(
            self.path, **(dict(expected_sha256=self.digest, max_file_bytes=1024 * 1024) | changes)
        )
        self.addCleanup(source.close)
        return source

    def test_real_lossless_decoding_preserves_nonzero_pts_and_variable_spacing(self):
        source = self.source()
        self.assertEqual(source.content_sha256, self.digest)
        frames = [source.read() for _ in range(3)]
        self.assertEqual([x.sequence for x in frames], [0, 1, 2])
        self.assertEqual(
            [x.presentation_time for x in frames], [Fraction(1), Fraction(26, 25), Fraction(28, 25)]
        )
        self.assertEqual([x.pixels for x in frames], [bytes([n]) * 768 for n in (20, 100, 200)])
        self.assertIsNone(source.read())
        self.assertIsNone(source.read())
        self.assertFalse(source._snapshot_path.exists())
        source.close()
        source.close()
        with self.assertRaises(SourceReadError):
            source.read()

    def test_admitted_snapshot_survives_original_file_mutation(self):
        source = self.source()
        self.path.write_bytes(b"replacement after admission")
        self.assertEqual(source.read().pixels, bytes([20]) * 768)

    def test_snapshot_and_frame_budgets_are_enforced(self):
        for changes in (
            dict(expected_sha256="bad"),
            dict(expected_sha256="0" * 64),
            dict(max_file_bytes=True),
            dict(max_file_bytes=1),
            dict(max_frame_bytes=True),
            dict(max_frame_bytes=0),
            dict(remove_snapshot_on_close="yes"),
            dict(remove_snapshot_on_close=False),
        ):
            with self.assertRaises(SourceContractError):
                self.source(**changes)
        source = self.source(max_frame_bytes=767)
        with self.assertRaises(SourceReadError):
            source.read()
        self.assertFalse(source._snapshot_path.exists())
        with self.assertRaises(SourceReadError):
            source.read()

    def test_supervised_snapshot_retained_for_parent_after_native_close(self):
        source = self.source(snapshot_directory=Path(self.temporary.name), remove_snapshot_on_close=False)
        source.read()
        source.close()
        self.assertTrue(source._snapshot_path.exists())
        self.assertIsNone(source._container)
        source._snapshot_path.unlink()
        self.assertFalse(source._snapshot_path.exists())
        with self.assertRaises(SourceReadError):
            source.read()

    def test_empty_content_and_ambiguous_streams_are_rejected(self):
        with patch("av.open") as opening:
            opening.return_value.streams.video = []
            with self.assertRaises(SourceContractError):
                self.source()
            opening.return_value.close.assert_called_once()
        self.path.write_bytes(b"")
        with self.assertRaises(SourceContractError):
            self.source()

    def test_native_decode_failure_is_not_eof_and_releases_resources(self):
        source = self.source()

        def failure():
            raise RuntimeError("decode failure")
            yield

        source._frames = failure()
        with self.assertRaises(SourceReadError):
            source.read()
        self.assertFalse(source._snapshot_path.exists())
        with self.assertRaises(SourceReadError):
            source.read()

    def test_invalid_timestamp_corruption_and_resolution_change_fail_closed(self):
        for changes in (
            dict(pts=None),
            dict(time_base=None),
            dict(is_corrupt=True),
            dict(pts=0),
            dict(width=32),
            dict(width=0),
        ):
            source = self.source()
            source.read()
            next_frame = SimpleNamespace(
                **(
                    dict(pts=1040, time_base=Fraction(1, 1000), is_corrupt=False, width=16, height=16)
                    | changes
                )
            )
            source._frames = iter([next_frame])
            with self.assertRaises(SourceReadError):
                source.read()
            self.assertFalse(source._snapshot_path.exists())


if __name__ == "__main__":
    unittest.main()
