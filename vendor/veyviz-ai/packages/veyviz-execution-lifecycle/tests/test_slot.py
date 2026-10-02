import unittest
from threading import Event, Thread

from veyviz_execution_lifecycle import ExecutorSlot, SlotError, SlotState, StaleExecutionError


class Executor:
    def __init__(self):
        self.started = Event()
        self.release = Event()
        self.release.set()
        self.closing = Event()
        self.close_release = Event()
        self.close_release.set()
        self.failure = None
        self.close_failure = None
        self.closes = 0

    def run(self, inputs):
        self.started.set()
        if not self.release.wait(3):
            raise AssertionError("test did not release native work")
        if self.failure:
            raise self.failure
        return dict(inputs)

    def close(self):
        self.closes += 1
        self.closing.set()
        if not self.close_release.wait(3):
            raise AssertionError("test did not release native close")
        if self.close_failure:
            raise self.close_failure


class SlotTests(unittest.TestCase):
    def launch(self, call):
        results = []

        def target():
            try:
                results.append(call())
            except BaseException as exc:
                results.append(exc)

        thread = Thread(target=target, daemon=True)
        thread.start()
        return thread, results

    def finish(self, job):
        thread, results = job
        thread.join(3)
        self.assertFalse(thread.is_alive(), "test worker did not terminate")
        self.assertEqual(len(results), 1)
        return results[0]

    def test_admission_generation_and_terminal_close(self):
        for generation in (True, 0, -1, 1 << 63, "1"):
            with self.assertRaises(ValueError):
                ExecutorSlot(Executor(), generation=generation)
        executor = Executor()
        slot = ExecutorSlot(executor, generation=1)
        self.assertEqual(slot.run({}, expected_generation=1), {})
        for generation in (0, 2, True):
            with self.assertRaises(StaleExecutionError):
                slot.run({}, expected_generation=generation)
        with self.assertRaises(SlotError):
            slot.replace(executor, expected_generation=1)
        slot.close()
        slot.close()
        self.assertEqual(slot.state, SlotState.CLOSED)
        self.assertEqual(executor.closes, 1)
        with self.assertRaises(SlotError):
            slot.run({}, expected_generation=1)
        candidate = Executor()
        with self.assertRaises(SlotError):
            slot.replace(candidate, expected_generation=1)
        self.assertEqual(candidate.closes, 0)  # caller still owns it

    def test_exhausted_generation_retains_caller_candidate(self):
        slot = ExecutorSlot(Executor(), generation=(1 << 63) - 1)
        candidate = Executor()
        with self.assertRaises(SlotError):
            slot.replace(candidate, expected_generation=slot.generation)
        self.assertEqual(candidate.closes, 0)
        slot.close()

    def test_replacement_closes_previous_and_advances_once(self):
        old, candidate = Executor(), Executor()
        slot = ExecutorSlot(old, generation=7)
        self.assertEqual(slot.replace(candidate, expected_generation=7), 8)
        self.assertEqual(slot.generation, 8)
        self.assertEqual(old.closes, 1)
        with self.assertRaises(StaleExecutionError):
            slot.replace(Executor(), expected_generation=7)
        self.assertEqual(slot.run({}, expected_generation=8), {})
        slot.close()
        self.assertEqual((old.closes, candidate.closes), (1, 1))

    def test_concurrent_run_is_not_queued_and_delayed_result_is_fenced(self):
        old, candidate = Executor(), Executor()
        old.release.clear()
        old.close_release.clear()
        self.addCleanup(old.release.set)
        self.addCleanup(old.close_release.set)
        slot = ExecutorSlot(old, generation=1)
        running = self.launch(lambda: slot.run({}, expected_generation=1))
        self.assertTrue(old.started.wait(2))
        with self.assertRaises(SlotError):
            slot.run({}, expected_generation=1)
        changing = self.launch(lambda: slot.replace(candidate, expected_generation=1))
        self.assertTrue(old.closing.wait(2))
        self.assertEqual(slot.state, SlotState.DRAINING)
        with self.assertRaises(SlotError):
            slot.close()
        with self.assertRaises(SlotError):
            slot.run({}, expected_generation=1)
        old.release.set()
        self.assertIsInstance(self.finish(running), StaleExecutionError)
        old.close_release.set()
        self.assertEqual(self.finish(changing), 2)
        self.assertEqual(slot.run({}, expected_generation=2), {})
        slot.close()

    def test_native_failure_faults_until_cleanup_even_on_interrupt(self):
        for error in (RuntimeError("native failure"), KeyboardInterrupt()):
            executor = Executor()
            executor.failure = error
            slot = ExecutorSlot(executor, generation=1)
            with self.assertRaises(type(error)):
                slot.run({}, expected_generation=1)
            self.assertEqual(slot.state, SlotState.FAULTED)
            with self.assertRaises(SlotError):
                slot.run({}, expected_generation=1)
            slot.close()

    def test_failure_during_drain_does_not_reopen_or_override_transition(self):
        old = Executor()
        old.failure = RuntimeError("native failure")
        old.release.clear()
        old.close_release.clear()
        self.addCleanup(old.release.set)
        self.addCleanup(old.close_release.set)
        slot = ExecutorSlot(old, generation=1)
        running = self.launch(lambda: slot.run({}, expected_generation=1))
        self.assertTrue(old.started.wait(2))
        changing = self.launch(lambda: slot.replace(Executor(), expected_generation=1))
        self.assertTrue(old.closing.wait(2))
        old.release.set()
        self.assertIsInstance(self.finish(running), RuntimeError)
        self.assertEqual(slot.state, SlotState.DRAINING)
        old.close_release.set()
        self.assertEqual(self.finish(changing), 2)
        slot.close()

    def test_failed_replacement_retains_both_owners_for_retry(self):
        for error in (RuntimeError("uncertain close"), KeyboardInterrupt()):
            old, candidate = Executor(), Executor()
            old.close_failure = error
            slot = ExecutorSlot(old, generation=1)
            with self.assertRaises(type(error)):
                slot.replace(candidate, expected_generation=1)
            self.assertEqual(slot.state, SlotState.FAULTED)
            self.assertEqual(slot.generation, 1)
            with self.assertRaises(type(error)):
                slot.close()
            old.close_failure = None
            candidate.close_failure = RuntimeError("candidate close uncertain")
            with self.assertRaises(RuntimeError):
                slot.close()
            self.assertEqual(old.closes, 3)
            candidate.close_failure = None
            slot.close()
            self.assertEqual(old.closes, 3)  # confirmed owners are not closed again
            self.assertEqual(candidate.closes, 2)
            self.assertEqual(slot.state, SlotState.CLOSED)


if __name__ == "__main__":
    unittest.main()
