import tempfile
import threading
import time
import unittest
from fractions import Fraction
from pathlib import Path
from unittest.mock import Mock

from veyviz_media import DecodedVideoFrame, SourceReadError
from veyviz_media_contracts import PixelFormat
from veyviz_process_supervision import read_message, write_message

from veyviz_media_transport import serve_frames


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_worker_serves_frame_then_eof(self):
        source = Mock()
        source.read.side_effect = [
            DecodedVideoFrame(0, Fraction(1, 25), 1, 1, PixelFormat.BGR24, b"abc"),
            None,
        ]
        failure = []

        def serve():
            try:
                serve_frames(self.directory, source)
            except BaseException as exc:
                failure.append(exc)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()

        def reply():
            path = self.directory / "reply.json"
            deadline = time.monotonic() + 5
            while not path.exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            message = read_message(path)
            path.unlink()
            return message

        self.assertEqual(reply(), {"request_id": 0, "status": "ready"})
        write_message(self.directory, "request.json", {"request_id": 1})
        message = reply()
        self.assertEqual(message["status"], "frame")
        self.assertEqual(message["position_numerator"], 1)
        self.assertEqual(message["position_denominator"], 25)
        self.assertEqual((self.directory / "frame.bin").read_bytes(), b"abc")
        write_message(self.directory, "request.json", {"request_id": 2})
        self.assertEqual(reply(), {"request_id": 2, "status": "eof"})
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failure, [])

    def test_worker_failure_and_invalid_request(self):
        source = Mock()
        source.read.side_effect = SourceReadError("corrupt video")
        write_message(self.directory, "request.json", {"request_id": 1})
        serve_frames(self.directory, source)
        self.assertEqual(read_message(self.directory / "reply.json")["status"], "failed")
        for request in ({"request_id": 2}, {"request_id": 1, "unexpected": True}):
            write_message(self.directory, "request.json", request)
            with self.assertRaisesRegex(SourceReadError, "out-of-order"):
                serve_frames(self.directory, source)
