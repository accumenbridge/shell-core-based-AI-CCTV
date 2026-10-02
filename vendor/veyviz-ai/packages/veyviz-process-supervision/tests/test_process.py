import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from veyviz_process_supervision import (
    MAX_CONTROL_BYTES,
    WorkerCleanupError,
    WorkerError,
    WorkerProcess,
    integer,
    read_bytes,
    read_message,
    retry_file_access,
    write_message,
)

ECHO = """import sys,time
from pathlib import Path
from veyviz_process_supervision import read_message,write_message
directory=Path(sys.argv[1])
(directory/'owned.bin').write_bytes(b'owned')
write_message(directory,'reply.json',{'request_id':0,'status':'ready'})
while True:
    path=directory/'request.json'
    if not path.exists():
        time.sleep(0.005)
        continue
    request=read_message(path)
    path.unlink()
    write_message(directory,'reply.json',{'request_id':request['request_id'],'status':'ok'})
"""


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def owner(self, script=ECHO, start=True, **options):
        worker = WorkerProcess("json.tool", **options)
        self.addCleanup(worker.close)
        if script is not None:
            path = self.directory / "controlled_worker.py"
            path.write_text(script, encoding="utf-8")
            worker._command = lambda: [sys.executable, "-I", str(path), str(worker.directory)]
        if start:
            worker.start({})
        return worker

    def test_serial_exchange_close_and_restart_rejection(self):
        worker = self.owner(start=False)
        with self.assertRaises(AttributeError):
            worker.directory = self.directory
        self.assertIsNone(worker.pid)
        self.assertFalse(worker.exit_confirmed)
        with self.assertRaises(WorkerError):
            worker.exchange({})
        with self.assertRaisesRegex(WorkerError, "exited"):
            worker._wait_reply(1, 100)
        worker.start({})
        self.assertFalse(worker.exit_confirmed)
        self.assertIsInstance(worker.pid, int)
        self.assertEqual(worker.exchange({}), {"request_id": 1, "status": "ok"})
        self.assertEqual(worker.exchange({"request_id": 999})["request_id"], 2)
        with self.assertRaises(WorkerError):
            worker.start({})
        worker.close()
        worker.close()
        self.assertTrue(worker.exit_confirmed)
        self.assertFalse(worker.directory.exists())
        with self.assertRaises(WorkerError):
            worker.exchange({})
        closed = self.owner(start=False)
        closed.close()
        with self.assertRaises(WorkerError):
            closed.start({})

    def test_admission_validation_and_unexpected_real_executable_exit(self):
        for module in (None, "", "wrong module", "single"):
            with self.assertRaises(ValueError):
                WorkerProcess(module)
        for changes in (
            dict(startup_timeout_ms=True),
            dict(request_timeout_ms=120001),
            dict(stop_timeout_ms=0),
        ):
            with self.assertRaises(ValueError):
                WorkerProcess("json.tool", **changes)
        worker = self.owner(script=None, start=False)
        self.assertEqual(worker._command()[1:4], ["-I", "-m", "json.tool"])
        with self.assertRaisesRegex(WorkerError, "exited"):
            worker.start({})
        worker.close()
        self.assertTrue(worker.exit_confirmed)
        self.assertFalse(worker.directory.exists())
        worker = self.owner(ECHO.replace("'status':'ready'", "'status':'failed'"), start=False)
        with self.assertRaisesRegex(WorkerError, "admission"):
            worker.start({})

    def test_startup_and_request_hangs_are_bounded_and_fenced(self):
        worker = self.owner(
            ECHO.replace(
                "write_message(directory,'reply.json',{'request_id':0,'status':'ready'})",
                "# no ready message",
            ),
            start=False,
            startup_timeout_ms=200,
        )
        with self.assertRaisesRegex(WorkerError, "deadline"):
            worker.start({})
        with self.assertRaises(WorkerError):
            worker.exchange({})
        worker.close()
        self.assertTrue(worker.exit_confirmed)
        self.assertFalse(worker.directory.exists())
        worker = self.owner(ECHO.split("while True:")[0] + "time.sleep(60)\n", request_timeout_ms=40)
        with self.assertRaisesRegex(WorkerError, "deadline"):
            worker.exchange({})
        with self.assertRaises(WorkerError):
            worker.exchange({})
        self.assertTrue((worker.directory / "owned.bin").exists())
        worker.close()
        self.assertTrue(worker.exit_confirmed)
        self.assertFalse(worker.directory.exists())

    def test_stale_reply_and_real_worker_loss_are_not_success(self):
        worker = self.owner(ECHO.split("while True:")[0] + "time.sleep(60)\n")
        write_message(worker.directory, "reply.json", {"request_id": 99, "status": "ok"})
        with self.assertRaisesRegex(WorkerError, "stale"):
            worker.exchange({})
        worker.close()
        worker = self.owner()
        worker._process.kill()
        worker._process.wait(timeout=5)
        with self.assertRaisesRegex(WorkerError, "exited"):
            worker.exchange({})
        worker.close()

    @unittest.skipIf(sys.platform == "win32", "Windows terminate is forceful")
    def test_sigterm_ignoring_child_requires_sigkill(self):
        worker = self.owner(
            "import signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n" + ECHO, stop_timeout_ms=30
        )
        worker.close()
        self.assertEqual(worker._process.returncode, -9)
        self.assertFalse(worker.directory.exists())

    def test_uncertain_stop_retains_owner_and_files_for_retry(self):
        worker = self.owner()
        process = worker._process
        fake = Mock()
        fake.poll.return_value = None
        fake.wait.side_effect = subprocess.TimeoutExpired("worker", 1)
        worker._process = fake
        try:
            with self.assertRaises(WorkerCleanupError) as failure:
                worker.close()
            self.assertIs(failure.exception.owner, worker)
            self.assertIn("termination unconfirmed", str(failure.exception.__cause__))
            self.assertTrue((worker.directory / "owned.bin").exists())
            fake.terminate.assert_called_once()
            fake.kill.assert_called_once()
        finally:
            worker._process = process
        failure.exception.owner.close()
        self.assertTrue(worker.exit_confirmed)
        self.assertFalse(worker.directory.exists())

    def test_interrupted_cleanup_exposes_owner_without_converting_interrupt(self):
        for interruption in (KeyboardInterrupt(), SystemExit(17)):
            worker = self.owner()
            try:
                with patch.object(worker, "_stop", side_effect=interruption):
                    with self.assertRaises(BaseExceptionGroup) as failure:
                        worker.close()
                self.assertNotIsInstance(failure.exception, Exception)
                self.assertIs(failure.exception.exceptions[0], interruption)
                cleanup = failure.exception.exceptions[1]
                self.assertIsInstance(cleanup, WorkerCleanupError)
                self.assertIs(cleanup.owner, worker)
                self.assertFalse(worker.exit_confirmed)
                self.assertTrue((worker.directory / "owned.bin").exists())
                with self.assertRaises(WorkerError):
                    worker.exchange({})
                cleanup.owner.close()
                self.assertTrue(worker.exit_confirmed)
                self.assertFalse(worker.directory.exists())
            finally:
                worker.close()  # Also clean up if an old implementation leaks the interruption.

    def test_exit_races_and_kill_escalation_confirm_death(self):
        for race in (False, True):
            worker = self.owner()
            real = worker._process
            real.kill()
            real.wait(timeout=5)
            fake = Mock()
            fake.poll.return_value = None
            fake.wait.side_effect = [subprocess.TimeoutExpired("worker", 1), 0]
            if race:
                fake.terminate.side_effect = ProcessLookupError
                fake.kill.side_effect = ProcessLookupError
            worker._process = fake
            worker.close()
            self.assertEqual(fake.wait.call_count, 2)
            self.assertFalse(worker.directory.exists())
            worker._process = real

    def test_cleanup_refuses_redirected_or_nested_directory(self):
        worker = self.owner()
        with patch.object(Path, "resolve", return_value=self.directory):
            with self.assertRaises(WorkerCleanupError):
                worker.close()
        child = worker.directory / "unexpected"
        child.mkdir()
        with self.assertRaises(WorkerCleanupError):
            worker.close()
        self.assertTrue(child.exists())
        child.rmdir()
        worker.close()

    def test_windows_file_and_directory_retry_after_confirmed_exit(self):
        for method, code in (("unlink", 32), ("rmdir", 145)):
            worker = self.owner()
            original = getattr(Path, method)
            error = OSError("transient cleanup error")
            error.winerror = code
            attempts = []

            def remove(path, **kwargs):
                self.assertTrue(worker.exit_confirmed)
                attempts.append(path)
                if len(attempts) == 1:
                    raise error
                return original(path, **kwargs)

            with patch.object(Path, method, remove):
                worker.close()
            self.assertGreater(len(attempts), 1)
            self.assertFalse(worker.directory.exists())
        for code in (145, 5):
            worker = self.owner()
            error = OSError("permanent cleanup error")
            error.winerror = code
            with (
                patch.object(Path, "rmdir", side_effect=error),
                patch("veyviz_process_supervision.process.time.monotonic", side_effect=[0, 2]),
            ):
                with self.assertRaises(WorkerCleanupError) as failure:
                    worker.close()
            self.assertTrue(worker.exit_confirmed)
            failure.exception.owner.close()

    def test_windows_access_retry_is_bounded_and_does_not_hide_other_errors(self):
        transient = Mock(side_effect=[PermissionError("temporarily busy"), 7])
        with patch("veyviz_process_supervision.files.sys.platform", "win32"):
            self.assertEqual(retry_file_access(transient), 7)
        self.assertEqual(transient.call_count, 2)
        for platform in ("linux", "win32"):
            with (
                patch("veyviz_process_supervision.files.sys.platform", platform),
                patch("veyviz_process_supervision.files.time.monotonic", side_effect=[0, 2]),
            ):
                with self.assertRaises(PermissionError):
                    retry_file_access(Mock(side_effect=PermissionError("persistent denial")))
        with self.assertRaises(FileNotFoundError):
            retry_file_access(Mock(side_effect=FileNotFoundError("missing file")))
        for limit in (True, 0, 64 * 1024 * 1024 + 2):
            with self.assertRaises(ValueError):
                read_bytes(self.directory / "anything", limit)

    def test_reply_that_becomes_readable_after_deadline_is_rejected(self):
        worker = self.owner(ECHO.split("while True:")[0] + "time.sleep(60)\n")
        write_message(worker.directory, "reply.json", {"request_id": 1, "status": "ok"})
        clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 0, 1]), sleep=time.sleep)
        with patch("veyviz_process_supervision.process.time", clock):
            with self.assertRaisesRegex(WorkerError, "deadline"):
                worker._wait_reply(1, 50)

    def test_wire_budgets_version_and_integer_validation(self):
        path = self.directory / "reply.json"
        write_message(self.directory, "reply.json", {"request_id": 4})
        self.assertEqual(read_message(path), {"request_id": 4})
        self.assertEqual(integer({"n": 7}, "n"), 7)
        for value in (None, True, -1, 1 << 63, "1"):
            with self.assertRaises(WorkerError):
                integer({"n": value}, "n")
        with self.assertRaises(WorkerError):
            write_message(self.directory, "reply.json", {"oversized": "a" * MAX_CONTROL_BYTES})
        for payload in (
            b"a" * (MAX_CONTROL_BYTES + 1),
            b"{",
            b"\xff",
            b"[]",
            b"{}",
            b'{"protocol_version":true,"body":{}}',
            b'{"protocol_version":2,"body":{}}',
            b'{"protocol_version":1,"body":[]}',
        ):
            path.write_bytes(payload)
            with self.assertRaises(WorkerError):
                read_message(path)
