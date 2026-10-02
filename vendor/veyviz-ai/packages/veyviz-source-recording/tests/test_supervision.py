import hashlib
import json
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch

from veyviz_media import SourceContractError, SourceReadError
from veyviz_process_supervision import WorkerCleanupError, WorkerProcess, read_message, write_message

from veyviz_source_recording import SupervisedRecordingSource, worker


class SupervisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "fixture.bin"
        self.path.write_bytes(b"source input")
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def source(self, script=None, **changes):
        options = dict(expected_sha256=self.digest, max_file_bytes=1024 * 1024)
        if script is None:
            result = SupervisedRecordingSource(self.path, **(options | changes))
        else:
            script_path = self.directory / "controlled_worker.py"
            script_path.write_text(script, encoding="utf-8")

            def command(instance):
                return [sys.executable, "-I", str(script_path), str(instance.directory)]

            with patch.object(WorkerProcess, "_command", command):
                result = SupervisedRecordingSource(self.path, **(options | changes))
        self.addCleanup(result.close)
        return result

    @staticmethod
    def idle_script():
        return (
            "import sys,time\nfrom pathlib import Path\n"
            "from veyviz_process_supervision import write_message\n"
            "directory=Path(sys.argv[1])\n"
            "(directory/'recording-owned.video').write_bytes(b'owned snapshot')\n"
            "write_message(directory,'reply.json',{'request_id':0,'status':'ready'})\n"
            "time.sleep(60)\n"
        )

    def test_real_decode_eof_mutation_and_reclamation(self):
        import av
        import numpy as np

        self.path = self.directory / "recording.mkv"
        with av.open(str(self.path), "w") as container:
            stream = container.add_stream("ffv1", rate=25)
            stream.width, stream.height, stream.pix_fmt = 16, 16, "bgr0"
            for color in (20, 100, 200):
                frame = av.VideoFrame.from_ndarray(
                    np.full((16, 16, 3), color, dtype=np.uint8), format="bgr24"
                )
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        source = self.source()
        self.assertEqual(source.content_sha256, self.digest)
        self.assertIsInstance(source.worker_pid, int)
        self.path.write_bytes(b"changed original")
        frames = [source.read() for _ in range(3)]
        self.assertEqual([frame.sequence for frame in frames], [0, 1, 2])
        self.assertEqual([frame.pixels for frame in frames], [bytes([n]) * 768 for n in (20, 100, 200)])
        self.assertEqual(
            [frame.presentation_time for frame in frames], [Fraction(0), Fraction(1, 25), Fraction(2, 25)]
        )
        self.assertIsNone(source.read())
        self.assertIsNone(source.read())
        self.assertIsNotNone(source._worker._process.poll())
        self.assertFalse(source._worker.directory.exists())
        source.close()
        source.close()
        with self.assertRaises(SourceReadError):
            source.read()

    def test_parent_import_does_not_load_native_decoder(self):
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                "import sys,veyviz_source_recording; assert 'av' not in sys.modules",
            ],
            capture_output=True,
            timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_read_timeout_is_sticky_and_reclaims_after_confirmed_death(self):
        source = self.source(self.idle_script(), read_timeout_ms=50)
        started = time.monotonic()
        with self.assertRaises(SourceReadError) as failure:
            source.read()
        self.assertIn("deadline", str(failure.exception.__cause__))
        self.assertLess(time.monotonic() - started, 10)
        self.assertIsNotNone(source._worker._process.poll())
        self.assertFalse(source._worker.directory.exists())
        with self.assertRaises(SourceReadError):
            source.read()

    def test_abrupt_worker_exit_is_failure_not_eof(self):
        source = self.source(self.idle_script())
        source._worker._process.kill()
        source._worker._process.wait(timeout=5)
        with self.assertRaises(SourceReadError) as failure:
            source.read()
        self.assertIn("exited", str(failure.exception.__cause__))
        self.assertFalse(source._worker.directory.exists())

    def test_admission_errors_and_launch_failure_clean_directory(self):
        for changes in (
            dict(expected_sha256=None),
            dict(expected_sha256="BAD"),
            dict(max_file_bytes=True),
            dict(max_frame_bytes=0),
            dict(startup_timeout_ms=120001),
            dict(read_timeout_ms=0),
            dict(stop_timeout_ms=10001),
        ):
            with self.assertRaises(SourceContractError):
                self.source(**changes)
        with self.assertRaisesRegex(SourceReadError, "admission"):
            self.source()  # Verified bytes are not a valid recording.
        with patch(
            "veyviz_process_supervision.process.subprocess.Popen", side_effect=OSError("launch failed")
        ):
            with self.assertRaisesRegex(SourceReadError, "admission failed"):
                self.source()

    def test_stale_reply_is_rejected(self):
        source = self.source(self.idle_script())
        write_message(source._worker.directory, "reply.json", {"request_id": 999, "status": "eof"})
        with self.assertRaises(SourceReadError) as failure:
            source.read()
        self.assertIn("stale", str(failure.exception.__cause__))
        self.assertFalse(source._worker.directory.exists())

    @staticmethod
    def frame_reply(**changes):
        return (
            dict(
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
            | changes
        )

    def test_bad_worker_payloads_never_escape_as_valid_frames(self):
        for changes, pixels in (
            (dict(status="failed"), b"abc"),
            (dict(size=4), b"abc"),
            (dict(sha256="0" * 64), b"abc"),
            (dict(size=True), b"abc"),
            (dict(size=4), b"abcd"),
            (dict(pixel_format="unsupported"), b"abc"),
            (dict(width=2), b"abc"),
            (dict(position_denominator=0), b"abc"),
        ):
            with self.subTest(changes=changes):
                source = self.source(self.idle_script(), max_frame_bytes=3)
                (source._worker.directory / "frame.bin").write_bytes(pixels)
                with patch.object(source._worker, "exchange", return_value=self.frame_reply(**changes)):
                    with self.assertRaises(SourceReadError):
                        source.read()
                self.assertIsNotNone(source._worker._process.poll())
                self.assertFalse(source._worker.directory.exists())

    def test_order_and_dimensions_are_checked_independently_of_worker(self):
        for changes in (
            dict(sequence=0, position_numerator=1),
            dict(sequence=1, position_numerator=0),
            dict(sequence=1, position_numerator=1, width=3, pixel_format="gray8"),
        ):
            source = self.source(self.idle_script())
            (source._worker.directory / "frame.bin").write_bytes(b"abc")
            with patch.object(
                source._worker, "exchange", side_effect=[self.frame_reply(), self.frame_reply(**changes)]
            ):
                self.assertEqual(source.read().pixels, b"abc")
                with self.assertRaises(SourceReadError):
                    source.read()

    def test_interrupt_stops_worker_and_preserves_interrupt(self):
        source = self.source(self.idle_script())
        with patch.object(source._worker, "exchange", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                source.read()
        self.assertIsNotNone(source._worker._process.poll())
        self.assertFalse(source._worker.directory.exists())

    def test_startup_interrupt_and_cleanup_error_preserve_the_owner(self):
        with patch.object(WorkerProcess, "start", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.source()
        owner = WorkerProcess("veyviz_source_recording.worker")
        self.addCleanup(owner.close)
        cleanup = WorkerCleanupError("stop unconfirmed", owner)
        with (
            patch("veyviz_source_recording.supervised.WorkerProcess", return_value=owner),
            patch.object(owner, "start", side_effect=RuntimeError("start failed")),
            patch.object(owner, "close", side_effect=cleanup),
        ):
            with self.assertRaises(SourceReadError) as failure:
                self.source()
        self.assertIs(failure.exception.__cause__.owner, owner)
        failure.exception.__cause__.owner.close()
        self.assertFalse(owner.directory.exists())


class WireAndWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_worker_entry_point_closes_source_and_reports_admission_failure(self):
        config = {
            "path": str(self.directory / "input"),
            "sha256": "0" * 64,
            "max_file_bytes": 100,
            "max_frame_bytes": 100,
        }
        write_message(self.directory, "config.json", config)
        with (
            patch.object(sys, "argv", ["worker", str(self.directory)]),
            patch.object(worker, "PyAvRecordingSource") as factory,
            patch.object(worker, "serve") as serve,
        ):
            worker.main()
            factory.return_value.close.assert_called_once()
            serve.assert_called_once_with(self.directory, factory.return_value)
            serve.side_effect = SourceReadError("bad request")
            with self.assertRaises(SourceReadError):
                worker.main()
            self.assertEqual(factory.return_value.close.call_count, 2)
            serve.side_effect = lambda directory, source: write_message(
                directory, "reply.json", {"request_id": 7, "status": "eof"}
            )
            factory.return_value.close.side_effect = SourceReadError("shutdown failed")
            with self.assertRaises(SourceReadError):
                worker.main()
            self.assertEqual(read_message(self.directory / "reply.json"), {"request_id": 7, "status": "eof"})
        write_message(self.directory, "config.json", {"path": None, "sha256": None})
        with patch.object(sys, "argv", ["worker", str(self.directory)]), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            runpy.run_module("veyviz_source_recording.worker", run_name="__main__")
        self.assertEqual(read_message(self.directory / "reply.json")["status"], "failed")
        self.assertEqual(json.loads((self.directory / "reply.json").read_text())["protocol_version"], 1)
