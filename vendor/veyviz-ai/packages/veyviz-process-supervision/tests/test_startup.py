import io
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from veyviz_process_supervision import WorkerCleanupError, WorkerError, WorkerProcess
from veyviz_process_supervision.startup import StartupInput


class StartupTests(unittest.TestCase):
    def test_real_pipe_delivers_exact_bytes_and_eof_without_persisting_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / "receive.py"
            script.write_text(
                "import hashlib,sys,time\n"
                "from pathlib import Path\n"
                "from veyviz_process_supervision import write_message\n"
                "data=sys.stdin.buffer.read(4097)\n"
                "write_message(Path(sys.argv[1]),'reply.json',"
                "{'request_id':0,'status':'ready','length':len(data),'sha256':hashlib.sha256(data).hexdigest()})\n"
                "time.sleep(60)\n",
                encoding="utf-8",
            )
            worker = WorkerProcess("json.tool")
            self.addCleanup(worker.close)
            command = [sys.executable, "-I", str(script), str(worker.directory)]
            worker._command = lambda: command
            payload = bytes(range(256)) * 16
            import hashlib

            reply = worker.start({"public": "metadata"}, startup_input=payload)
            self.assertEqual(reply["length"], 4096)
            self.assertEqual(reply["sha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(set(p.name for p in worker.directory.iterdir()), {"config.json"})
            self.assertNotIn(payload, (worker.directory / "config.json").read_bytes())
            self.assertEqual(worker._command(), command)
            worker.close()
            self.assertTrue(worker.exit_confirmed)
            self.assertFalse(worker.directory.exists())

    def test_validation_precedes_start_and_delivery_failures_stay_failed(self):
        worker = WorkerProcess("json.tool")
        self.addCleanup(worker.close)
        for value in (b"", b"x" * 4097, "secret", bytearray(b"secret"), True):
            with self.assertRaises(ValueError):
                worker.start({}, startup_input=value)
        self.assertIsNone(worker.pid)
        sender = Mock(failed=True)
        with patch("veyviz_process_supervision.process.StartupInput", return_value=sender):
            with self.assertRaisesRegex(WorkerError, "delivery failed"):
                worker.start({}, startup_input=b"test")
        worker._process.stdin.close()
        with self.assertRaises(WorkerError):
            worker.exchange({})
        with patch.object(sender, "wait", side_effect=WorkerError("sender still running")):
            with self.assertRaises(WorkerCleanupError) as failure:
                worker.close()
        self.assertIs(failure.exception.owner, worker)
        self.assertTrue(worker.directory.exists())
        worker.close()

    def test_spawn_time_consumes_startup_budget(self):
        worker = WorkerProcess("json.tool")
        self.addCleanup(worker.close)
        with patch(
            "veyviz_process_supervision.process.time", SimpleNamespace(monotonic=Mock(side_effect=[0, 31]))
        ):
            with self.assertRaisesRegex(WorkerError, "startup deadline"):
                worker.start({})

    def test_sender_failure_timeout_and_start_interruption(self):
        for stream in (Mock(write=Mock(return_value=0)), Mock(write=Mock(side_effect=OSError("private")))):
            stream.__enter__ = Mock(return_value=stream)
            stream.__exit__ = Mock(return_value=False)
            sender = StartupInput(stream, b"secret")
            sender.wait(2)
            self.assertTrue(sender.failed)
        stream = io.BytesIO()
        with patch("veyviz_process_supervision.startup.Thread.start", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                StartupInput(stream, b"secret")
        self.assertTrue(stream.closed)
        release = threading.Event()
        entered = threading.Event()

        class SlowPipe(io.BytesIO):
            def write(self, data):
                entered.set()
                release.wait(5)
                return super().write(data)

        stream = SlowPipe()
        sender = StartupInput(stream, b"secret")
        try:
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(WorkerError, "unconfirmed"):
                sender.wait(0.001)
        finally:
            release.set()
            sender.wait(2)
        self.assertTrue(stream.closed)
        self.assertFalse(sender.failed)


if __name__ == "__main__":
    unittest.main()
