"""Parent-side ownership of exactly one fingerprinted native feature worker."""
from __future__ import annotations
import base64, hashlib, json, os, queue, subprocess, threading, time
from pathlib import Path

class AdvancedWorker:
    def __init__(self, path, expected, intent=None):
        self.child = None; self.closed = False; self.messages = queue.Queue(maxsize=4); self.models = {}; self.intent = intent
        profile_path = Path(path)
        if hashlib.sha256(profile_path.read_bytes()).hexdigest() != expected: raise ValueError('Advanced profile changed')
        profile = json.loads(profile_path.read_bytes())
        if profile['schema'] != 'veyviz.intelligence-runtime.v1': raise ValueError('Advanced profile schema mismatch')
        self.child = subprocess.Popen([profile['pythonExecutable'], '-I', profile['workerPath'], '--profile', str(profile_path), '--sha256', expected], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.error = ''
        def drain():
            for block in iter(lambda: self.child.stderr.read(4096), b''): self.error = (self.error + block.decode(errors='replace'))[-256:]
        def read():
            while True:
                raw = self.child.stdout.readline(32 * 1024 * 1024 + 1)
                if not raw: self.messages.put(None); return
                if len(raw) > 32 * 1024 * 1024: self.messages.put({'status': 'FAILED'}); return
                try: self.messages.put(json.loads(raw))
                except Exception: self.messages.put({'status': 'FAILED'}); return
        threading.Thread(target=drain, daemon=True).start(); threading.Thread(target=read, daemon=True).start()
        try:
            ready = self.receive(120)
            if ready.get('status') != 'READY': raise ValueError('Feature worker unavailable')
            self.models = ready['models']
        except BaseException:
            self.close(); raise

    def receive(self, timeout=30):
        value = self.messages.get(timeout=timeout)
        if value is None: raise ValueError('Feature worker exited unexpectedly')
        return value

    def exchange(self, value, timeout=60):
        if self.closed: raise ValueError('Feature worker closed')
        self.child.stdin.write(json.dumps({**value, 'intent': self.intent}, allow_nan=False, separators=(',', ':')).encode() + b'\n'); self.child.stdin.flush()
        result = self.receive(timeout)
        if result.get('intent') != self.intent: raise ValueError('Native feature intent changed')
        if result.get('status') != 'RESULT': raise ValueError(result.get('error', 'Native feature execution failed'))
        return result

    def close(self):
        if self.closed: return
        if self.child is None: self.closed = True; return
        confirmed = False
        try:
            self.child.stdin.write(b'{"operation":"close"}\n'); self.child.stdin.flush()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                reply = self.receive(max(.01, deadline - time.monotonic()))
                if reply.get('status') == 'CLOSED':
                    confirmed = self.child.wait(timeout=max(.01, deadline - time.monotonic())) == 0; break
        except Exception:
            if self.child.poll() is None:
                self.child.terminate()
                try: self.child.wait(timeout=5)
                except subprocess.TimeoutExpired: pass
        finally:
            if not confirmed and self.child.poll() is None:
                self.child.terminate()
                try: self.child.wait(timeout=5)
                except subprocess.TimeoutExpired: pass
            for stream in [self.child.stdin, self.child.stdout, self.child.stderr]:
                if stream is not None: stream.close()
        self.closed = confirmed
        if not confirmed: raise ValueError('Advanced native cleanup unconfirmed')

class AdvancedExecutor:
    def __init__(self, worker, execution):
        from veyviz_execution_contracts import TensorSpec
        self.worker, self.execution = worker, execution
        self.model_sha256 = worker.models['detector']
        self.inputs = (TensorSpec('input', (1, 3, 512, 512)),)
        self.outputs = (TensorSpec('pred_boxes', (1, 300, 4)), TensorSpec('pred_logits', (1, 300, 91)))

    def run(self, inputs):
        import numpy as np
        self.inputs[0].validate(inputs['input'])
        response = self.worker.exchange({'operation': 'tensor', 'execution': self.execution, 'data': base64.b64encode(inputs['input'].tobytes()).decode()})
        if response['execution'] != self.execution: raise ValueError('Native execution selection changed')
        outputs = {}
        for spec in self.outputs:
            value = response['outputs'][spec.name]
            if value['shape'] != list(spec.shape): raise ValueError('Tensor response shape mismatch')
            tensor = np.frombuffer(base64.b64decode(value['data'], validate=True), np.float32).reshape(spec.shape).copy()
            spec.validate(tensor); outputs[spec.name] = tensor
        return outputs

    def close(self): self.worker.close()
