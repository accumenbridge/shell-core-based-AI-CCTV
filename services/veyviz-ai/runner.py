"""One digest-bound recorded-video request; stdout is a single result proposal.

Launch using the installed environment's python -I and the trusted --profile.
The product retains authorization and final result acceptance authority.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time

MAX_REQUEST = 16 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
PROFILE_ID = "rfdetr-small-cpu-v1"
FIXTURE_ID = "mivia-vid0062"
MODEL_SHA = "0e0817f4cafa479ccba17662a142092932b0b10c98947e7cf60f3badd0f5c219"
RECORDING_SHA = "ea6b48e57c343027b169ee1357e6e85ea3b8d179ba70058c294d1b1ec8db2805"
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z", re.ASCII)
HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


class ProtocolError(ValueError):
    pass


class Cancelled(Exception):
    pass


def object_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("Duplicate JSON member")
        result[key] = value
    return result


def strict_json(data: bytes) -> object:
    def reject_constant(_value: str) -> None:
        raise ProtocolError("Nonfinite JSON number")
    return json.loads(data.decode("utf-8"), object_pairs_hook=object_pairs, parse_constant=reject_constant)


def exact_keys(value: object, keys: set[str]) -> dict:
    if type(value) is not dict or set(value) != keys:
        raise ProtocolError("Exact declared object fields required")
    return value


def validate_request(value: object) -> dict:
    request = exact_keys(value, {"schema", "jobId", "commandId", "scope", "sourceId", "sourceVersion",
                                 "fixtureId", "profileId", "frameCount", "sampleStride"})
    if request["schema"] != "veyviz.recorded-analysis.request.v1":
        raise ProtocolError("Unsupported request schema")
    scope = exact_keys(request["scope"], {"productId", "instanceId", "tenantId", "actorId", "actorKind"})
    for value in [request[key] for key in ("jobId", "commandId", "sourceId", "fixtureId", "profileId")] + [scope[key] for key in ("productId", "instanceId", "tenantId", "actorId")]:
        if type(value) is not str or IDENTIFIER.fullmatch(value) is None:
            raise ProtocolError("Invalid bounded identifier")
    if scope["actorKind"] not in ("user", "service"):
        raise ProtocolError("Invalid actor kind")
    for key, low, high in (("sourceVersion", 1, 9007199254740991), ("frameCount", 1, 6), ("sampleStride", 1, 30)):
        if type(request[key]) is not int or not low <= request[key] <= high:
            raise ProtocolError("Integer request bound exceeded")
    if request["profileId"] != PROFILE_ID or request["fixtureId"] != FIXTURE_ID:
        raise ProtocolError("Unadmitted execution profile")
    return request


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_file(path: Path, expected: str, size: int | None = None) -> None:
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ProtocolError("Required regular absolute file is unavailable")
    if size is not None and path.stat().st_size != size or sha256(path) != expected:
        raise ProtocolError("Companion integrity mismatch")


def load_profile(path: Path) -> dict:
    if not path.is_absolute() or path.stat().st_size > MAX_REQUEST:
        raise ProtocolError("Bounded absolute profile required")
    profile = exact_keys(strict_json(path.read_bytes()), {"schema", "profileId", "fixtureId", "modelPath",
                         "recordingPath", "modelSha256", "recordingSha256", "pythonExecutable", "runnerPath", "inventoryPath"})
    if profile["schema"] != "veyviz.recorded-profile.v1" or profile["profileId"] != PROFILE_ID or profile["fixtureId"] != FIXTURE_ID:
        raise ProtocolError("Unadmitted profile identity")
    if profile["modelSha256"] != MODEL_SHA or profile["recordingSha256"] != RECORDING_SHA:
        raise ProtocolError("Unadmitted assets")
    for key in ("modelPath", "recordingPath", "pythonExecutable", "runnerPath", "inventoryPath"):
        if type(profile[key]) is not str or len(profile[key]) > 4096 or not Path(profile[key]).is_absolute():
            raise ProtocolError("Absolute bounded profile file required")
    if Path(profile["runnerPath"]).resolve() != Path(__file__).resolve() or Path(profile["pythonExecutable"]).resolve() != Path(sys.executable).resolve():
        raise ProtocolError("Launched executable identity does not match profile")
    inventory_path = Path(profile["inventoryPath"])
    if inventory_path.stat().st_size > 16 * 1024 * 1024:
        raise ProtocolError("Inventory too large")
    inventory = exact_keys(strict_json(inventory_path.read_bytes()), {"schema", "createdAt", "source", "files", "versions"})
    if inventory["schema"] != "veyviz.recorded-inventory.v1" or type(inventory["files"]) is not list or not 1 <= len(inventory["files"]) <= 20000:
        raise ProtocolError("Invalid inventory")
    seen = set()
    runner_seen = python_seen = False
    for item in inventory["files"]:
        exact_keys(item, {"path", "sha256", "kind", "bytes"})
        if type(item["path"]) is not str or type(item["sha256"]) is not str or HASH.fullmatch(item["sha256"]) is None or type(item["bytes"]) is not int or item["bytes"] < 0:
            raise ProtocolError("Invalid inventory file record")
        if item["kind"] not in ("runner", "source", "wheel", "installed", "interpreter"):
            raise ProtocolError("Invalid inventory file kind")
        file = Path(item["path"])
        canonical = os.path.normcase(str(file.resolve()))
        if canonical in seen:
            raise ProtocolError("Duplicate inventory path")
        seen.add(canonical)
        checked_file(file, item["sha256"], item["bytes"])
        runner_seen |= file.resolve() == Path(__file__).resolve() and item["kind"] == "runner"
        python_seen |= file.resolve() == Path(sys.executable).resolve() and item["kind"] == "interpreter"
    if not runner_seen or not python_seen:
        raise ProtocolError("Executable closure is missing")
    checked_file(Path(profile["modelPath"]), MODEL_SHA)
    checked_file(Path(profile["recordingPath"]), RECORDING_SHA)
    return profile


def read_line(fd: int, maximum: int) -> bytes:
    # Unbuffered os.read permits a blocked daemon cancellation reader to exit
    # without holding the Python buffered-stdin lock at interpreter shutdown.
    data = bytearray()
    while len(data) <= maximum:
        try:
            byte = os.read(fd, 1)
        except BlockingIOError:
            # Python 3.13 supports nonblocking Windows pipes. Never hold the
            # Windows CRT stdin descriptor lock while a native child starts.
            time.sleep(0.01)
            continue
        if not byte:
            return bytes(data)
        if byte == b"\n":
            return bytes(data)
        data.extend(byte)
    raise ProtocolError("Control line exceeds bound")


class Cancellation:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.invalid = False

    def listen(self, job_id: str, fd: int = 0) -> None:
        try:
            data = read_line(fd, MAX_REQUEST)
            if not data:
                return
            message = exact_keys(strict_json(data), {"type", "jobId"})
            if message != {"type": "cancel", "jobId": job_id}:
                raise ProtocolError("Cancellation identity mismatch")
        except Exception:
            self.invalid = True
        self.event.set()

    def check(self) -> None:
        if self.event.is_set():
            if self.invalid:
                raise ProtocolError("Invalid cancellation control")
            raise Cancelled("Cancellation requested")


def thumbnail(frame, pixels) -> str | None:
    import cv2
    import numpy as np
    from veyviz_media_contracts import PixelFormat
    image = np.frombuffer(pixels, dtype=np.uint8).reshape(frame.height, frame.width, 3)
    if frame.pixel_format is PixelFormat.RGB24:
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    scale = min(1.0, 640 / max(frame.width, frame.height))
    image = cv2.resize(image, (max(1, int(frame.width * scale)), max(1, int(frame.height * scale))), interpolation=cv2.INTER_AREA)
    for quality in (75, 55, 35):
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and encoded.nbytes <= 96 * 1024:
            return base64.b64encode(encoded.tobytes()).decode("ascii")
    return None


def execute(request: dict, profile: dict, cancellation: Cancellation, cleanup: dict) -> dict:
    from veyviz_execution_lifecycle import ExecutorSlot, SlotState
    from veyviz_inference_onnxruntime import SupervisedOnnxCpuExecutor
    from veyviz_media import FramePool, RecordingTimeline
    from veyviz_media_contracts import CaptureClock, SourceScope, StreamSession
    from veyviz_model_rfdetr import RfDetrSmallPersonAdapter
    from veyviz_perception_contracts import Coverage
    from veyviz_source_recording import SupervisedRecordingSource

    sys.stderr.write("veyviz phase execution-imports-ready\n")
    sys.stderr.flush()
    cancellation.check()
    capture = executor = slot = owner = None
    started_at = datetime.now(timezone.utc).isoformat()
    samples = []
    decoded = 0
    try:
        adapter = RfDetrSmallPersonAdapter(confidence=0.5, execution_generation=1)
        # Mark uncertain before constructors, which can acquire native owners
        # before raising. Only successful close paths establish closure facts.
        cleanup["sourceClosed"] = False
        capture = SupervisedRecordingSource(Path(profile["recordingPath"]), expected_sha256=RECORDING_SHA,
                                             max_file_bytes=16 * 1024 * 1024, startup_timeout_ms=30000,
                                             read_timeout_ms=10000, stop_timeout_ms=3000)
        sys.stderr.write("veyviz phase source-ready\n")
        sys.stderr.flush()
        cancellation.check()
        owner = FramePool(max_bytes=64 * 1024 * 1024, max_frames=2, max_sources=1, max_leases=1)
        cleanup["inferenceClosed"] = False
        executor = SupervisedOnnxCpuExecutor(Path(profile["modelPath"]), expected_sha256=MODEL_SHA,
                                            max_model_bytes=128 * 1024 * 1024, threads=1,
                                            startup_timeout_ms=30000, run_timeout_ms=10000,
                                            stop_timeout_ms=3000)
        adapter.validate_executor(executor)
        slot = ExecutorSlot(executor, generation=1)
        sys.stderr.write("veyviz phase inference-ready\n")
        sys.stderr.flush()
        cancellation.check()
        # Recording PTS is the sample position. This virtual processing anchor is
        # used only for the source owner's bounded frame lease, never live time.
        scope = SourceScope(request["scope"]["tenantId"], request["scope"]["instanceId"], request["sourceId"])
        session = StreamSession(scope, RECORDING_SHA, request["jobId"], request["sourceVersion"],
                                "uncommissioned-full-frame", CaptureClock("recording-replay-ms", 0, 1_000_000, 0))
        owner.register_session(session)
        timeline = None
        virtual_now = 1_000_000
        for index in range((request["frameCount"] - 1) * request["sampleStride"] + 1):
            cancellation.check()
            source_frame = capture.read()
            if source_frame is None:
                raise ProtocolError("Recording ended before requested samples")
            decoded += 1
            if index % request["sampleStride"]:
                continue
            cancellation.check()
            if timeline is None:
                timeline = RecordingTimeline(session, source_frame.presentation_time, 60000)
            reference = timeline.reference(source_frame)
            virtual_now = max(virtual_now, reference.captured_at_ms)
            owner.offer(reference, source_frame.pixels, now_ms=virtual_now)
            lease = owner.acquire(session, now_ms=virtual_now)
            if lease is None:
                raise ProtocolError("Frame not admitted")
            try:
                before = time.perf_counter_ns()
                inputs = adapter.prepare(lease.frame, lease.pixels)
                output = slot.run(inputs, expected_generation=1)
                elapsed = (time.perf_counter_ns() - before) / 1_000_000
                completed = virtual_now + math.ceil(elapsed)
                cancellation.check()
                if not lease.result_valid(now_ms=completed):
                    raise ProtocolError("Frame lease expired")
                observed = adapter.decode(output, lease.frame, completed_at_ms=completed,
                                          coverage=Coverage.UNKNOWN, reason="uncommissioned_research_recording")
                if len(observed.detections) > 100:
                    raise ProtocolError("Detection response bound exceeded")
                detections = [{"confidence": item.confidence, "x1": item.bbox.x_min * reference.width,
                               "y1": item.bbox.y_min * reference.height, "x2": item.bbox.x_max * reference.width,
                               "y2": item.bbox.y_max * reference.height} for item in observed.detections]
                sample = {"frameIndex": index, "positionMs": float(source_frame.presentation_time * 1000),
                          "width": reference.width, "height": reference.height, "inferenceMs": elapsed,
                          "detections": detections}
                jpeg = thumbnail(lease.frame, lease.pixels)
                if jpeg:
                    sample["thumbnailJpegBase64"] = jpeg
                samples.append(sample)
                virtual_now = completed
            finally:
                lease.complete()
        cancellation.check()
    finally:
        errors = []
        try:
            if slot is not None:
                slot.close()
                cleanup["inferenceClosed"] = slot.state is SlotState.CLOSED
            elif executor is not None:
                executor.close()
                cleanup["inferenceClosed"] = True
        except Exception as exc:
            errors.append(exc)
        try:
            if owner is not None:
                owner.close()
                snapshot = owner.snapshot()
                cleanup["retainedBytes"] = snapshot.retained_bytes
                cleanup["outstandingLeases"] = snapshot.outstanding_leases
        except Exception as exc:
            cleanup["retainedBytes"] = -1
            cleanup["outstandingLeases"] = -1
            errors.append(exc)
        try:
            if capture is not None:
                capture.close()
                cleanup["sourceClosed"] = True
        except Exception as exc:
            errors.append(exc)
        if errors:
            raise ProtocolError("Native cleanup is unconfirmed") from errors[0]
    if cleanup != {"sourceClosed": True, "inferenceClosed": True, "retainedBytes": 0, "outstandingLeases": 0}:
        raise ProtocolError("Native cleanup is unconfirmed")
    cancellation.check()
    names = ("numpy", "av", "opencv-python-headless", "onnxruntime", "veyviz-model-rfdetr",
             "veyviz-inference-onnxruntime", "veyviz-execution-lifecycle", "veyviz-process-supervision",
             "veyviz-media", "veyviz-source-recording")
    return {"sourceSha256": RECORDING_SHA, "modelSha256": MODEL_SHA, "modelId": PROFILE_ID,
            "startedAt": started_at, "completedAt": datetime.now(timezone.utc).isoformat(),
            "decodedFrames": decoded, "samples": samples, "coverage": "UNCOMMISSIONED_RECORDING",
            "occupancy": "UNKNOWN", "versions": {name: importlib.metadata.version(name) for name in names}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    arguments = parser.parse_args()
    request = None
    cleanup = {"sourceClosed": True, "inferenceClosed": True, "retainedBytes": 0, "outstandingLeases": 0}
    status = "FAILED"
    result = {}
    exit_code = 2
    try:
        request = validate_request(strict_json(read_line(0, MAX_REQUEST)))
        sys.stderr.write("veyviz phase request-ready\n")
        sys.stderr.flush()
        os.set_blocking(0, False)
        cancellation = Cancellation()
        threading.Thread(target=cancellation.listen, args=(request["jobId"],), daemon=True,
                         name="veyviz-cancel-reader").start()
        cancellation.check()
        profile = load_profile(arguments.profile)
        sys.stderr.write("veyviz phase profile-ready\n")
        sys.stderr.flush()
        cancellation.check()
        result = execute(request, profile, cancellation, cleanup)
        status, exit_code = "SUCCEEDED", 0
    except Cancelled:
        status, exit_code = "CANCELLED", 3
        result = {"error": {"code": "CANCELLED", "message": "Analysis cancelled; inspect cleanup facts."}}
    except Exception as exc:
        code = "INVALID_PROTOCOL" if isinstance(exc, (ProtocolError, ValueError, json.JSONDecodeError)) else "EXECUTION_FAILED"
        result = {"error": {"code": code, "message": "Analysis did not complete; verify the admitted profile and cleanup facts."}}
        # Exception class is useful; arbitrary native error text can expose paths.
        sys.stderr.write(f"veyviz recorded runner: {type(exc).__name__}\n")
    response = {"schema": "veyviz.recorded-analysis.result.v1", "status": status,
                "request": request, **result, "cleanup": cleanup}
    encoded = json.dumps(response, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > MAX_RESPONSE:
        response = {"schema": "veyviz.recorded-analysis.result.v1", "status": "FAILED", "request": request,
                    "error": {"code": "OUTPUT_LIMIT", "message": "Analysis output exceeded the bounded response."}, "cleanup": cleanup}
        encoded = json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n"
        exit_code = 2
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
