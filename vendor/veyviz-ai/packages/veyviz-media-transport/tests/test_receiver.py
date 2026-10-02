import hashlib
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from veyviz_media import SourceContractError, SourceReadError
from veyviz_process_supervision import WorkerError

from veyviz_media_transport import FrameReceiver


class ReceiverTests(unittest.TestCase):
    def test_budgets_payload_integrity_and_history(self):
        for limit in (True, 0, 64 * 1024 * 1024 + 1):
            with self.assertRaises(SourceContractError):
                FrameReceiver(limit)
        reply = dict(
            status="frame",
            sequence=0,
            position_numerator=0,
            position_denominator=1,
            width=1,
            height=1,
            pixel_format="bgr24",
            size=3,
            sha256=hashlib.sha256(b"abc").hexdigest(),
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "frame.bin").write_bytes(b"abc")
            for changes in (
                {"status": "failed"},
                {"size": 2},
                {"sha256": "wrong"},
                {"size": 4},
                {"size": True},
                {"width": 2},
                {"position_denominator": 0},
                {"pixel_format": "wrong"},
            ):
                with self.assertRaises((SourceReadError, SourceContractError, WorkerError, ValueError)):
                    FrameReceiver(3).receive(directory, reply | changes)
            for changes in (
                {"sequence": 0, "position_numerator": 1},
                {"sequence": 1, "position_numerator": 0},
                {"sequence": 1, "position_numerator": 1, "width": 3, "pixel_format": "gray8"},
            ):
                receiver = FrameReceiver(3)
                self.assertEqual(receiver.receive(directory, reply).pixels, b"abc")
                with self.assertRaises(SourceReadError):
                    receiver.receive(directory, reply | changes)
                # A rejected frame must not advance accepted history.
                accepted = receiver.receive(directory, reply | {"sequence": 1, "position_numerator": 1})
                self.assertEqual(accepted.presentation_time, Fraction(1))
