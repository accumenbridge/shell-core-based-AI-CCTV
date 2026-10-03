"""Owned, bounded recorded-person tracking; no identity or occupancy assertion."""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import threading
import time

COCO = {1: ('person', 'person'), 2: ('vehicle', 'bicycle'), 3: ('vehicle', 'car'), 4: ('vehicle', 'motorcycle'),
        5: ('vehicle', 'airplane'), 6: ('vehicle', 'bus'), 7: ('vehicle', 'train'), 8: ('vehicle', 'truck'), 9: ('vehicle', 'boat'),
        16: ('animal', 'bird'), 17: ('animal', 'cat'), 18: ('animal', 'dog'), 19: ('animal', 'horse'), 20: ('animal', 'sheep'),
        21: ('animal', 'cow'), 22: ('animal', 'elephant'), 23: ('animal', 'bear'), 24: ('animal', 'zebra'), 25: ('animal', 'giraffe')}

def decode_categories(outputs, categories):
    import numpy as np
    boxes, logits = outputs['pred_boxes'][0], outputs['pred_logits'][0]
    if boxes.shape != (300, 4) or logits.shape != (300, 91) or not np.isfinite(boxes).all() or not np.isfinite(logits).all(): raise ValueError('Detector tensor mismatch')
    scores = 1 / (1 + np.exp(-np.clip(logits, -80, 80)))
    detections = []
    for query in range(300):
        label = int(scores[query].argmax()); confidence = float(scores[query, label])
        if label not in COCO or COCO[label][0] not in categories or confidence < .5: continue
        cx, cy, w, h = (float(x) for x in boxes[query])
        if w < 0 or h < 0: raise ValueError('Negative box')
        box = [min(1, max(0, x)) for x in [cx-w/2, cy-h/2, cx+w/2, cy+h/2]]
        if box[2] <= box[0] or box[3] <= box[1]: continue
        detections.append({'bbox': box, 'confidence': confidence, 'category': COCO[label][0], 'label': COCO[label][1]})
    return detections

class MotionGate:
    def __init__(self, threshold, heartbeat): self.threshold, self.heartbeat, self.previous, self.last = threshold, heartbeat, None, None
    def admit(self, at, pixels, width, height):
        import cv2, numpy as np
        image = np.frombuffer(pixels, np.uint8).reshape(height, width, 3)
        grey = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (160, 90))
        changed = self.previous is None or float((cv2.absdiff(grey, self.previous) >= 18).mean()) >= self.threshold
        admitted = changed or self.last is None or at - self.last >= self.heartbeat
        if admitted: self.previous, self.last = grey, at
        return admitted


def inside(point, polygon):
    x, y = point
    result = False
    for i, (ax, ay) in enumerate(polygon):
        bx, by = polygon[(i + 1) % len(polygon)]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            result = not result
    return result


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0


def match_score(a, b):
    overlap = iou(a, b)
    if overlap >= .15:
        return .5 + overlap / 2
    ah, bh = a[3] - a[1], b[3] - b[1]
    if min(ah, bh) <= 0 or max(ah, bh) / min(ah, bh) > 3:
        return 0
    distance = math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2)
    scale = max(ah, bh, a[2] - a[0], b[2] - b[0])
    return .49 * (1 - distance / (scale * 1.2)) if distance < scale * 1.2 else 0


def describe_colour(pixels, width, height, box, category='person', label='Person'):
    import cv2
    import numpy as np
    image = np.frombuffer(pixels, dtype=np.uint8).reshape(height, width, 3)
    x1, y1, x2, y2 = box
    left, right = int((x1 + (x2 - x1) * .25) * width), int((x1 + (x2 - x1) * .75) * width)
    start, end = (.25, .55) if category == 'person' else (.45, .85)
    top, bottom = int((y1 + (y2 - y1) * start) * height), int((y1 + (y2 - y1) * end) * height)
    prefix = 'Person appearance; upper-body' if category == 'person' else f'{label.capitalize()} appearance; crop'
    crop = image[max(0, top):min(height, bottom), max(0, left):min(width, right)]
    if crop.size == 0:
        return f'{prefix} colour unknown; identity unknown'
    hue, saturation, value = np.median(cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3), axis=0)
    if value < 65:
        colour = 'dark'
    elif saturation < 45:
        colour = 'light' if value > 165 else 'grey'
    elif hue < 10 or hue >= 170:
        colour = 'red'
    elif hue < 25:
        colour = 'orange/brown'
    elif hue < 35:
        colour = 'yellow'
    elif hue < 85:
        colour = 'green'
    elif hue < 135:
        colour = 'blue'
    else:
        colour = 'purple'
    return f'{prefix} colour estimate: {colour}; identity unknown'


class Tracker:
    def __init__(self, zones, max_gap_ms=1500):
        self.zones = zones
        self.max_gap = max_gap_ms
        self.tracks = {}
        self.appearances = []
        self.events = []
        self.visits = []

    def event(self, track_id, kind, at, zone=None):
        self.events.append({"id": f"event-{len(self.events) + 1}", "appearanceId": track_id,
                            "category": self.tracks[track_id]['appearance']['category'], "type": kind, "positionMs": at, "zoneId": zone})
        if len(self.events) > 512:
            raise ValueError("Event budget exceeded")

    def observe(self, at, detections, thumbnail=None, enrich=None):
        for tid, track in list(self.tracks.items()):
            if at - track["appearance"]["lastMs"] > self.max_gap:
                for state in track["zones"].values():
                    if state.get("visit"):
                        state["visit"]["state"] = "UNCERTAIN"
                del self.tracks[tid]
        edges = sorted(((match_score(track["bbox"], det["bbox"]), tid, n)
                        for tid, track in self.tracks.items() for n, det in enumerate(detections)
                        if track['appearance']['category'] == det.get('category', 'person')), reverse=True)
        assigned = {}
        used_tracks = set()
        for score, tid, n in edges:
            if score >= .1 and tid not in used_tracks and n not in assigned:
                assigned[n] = tid
                used_tracks.add(tid)
        for n, detection in enumerate(detections):
            tid = assigned.get(n)
            if tid is None:
                if len(self.appearances) >= 32:
                    raise ValueError("Appearance budget exceeded")
                tid = f"track-{len(self.appearances) + 1}"
                appearance = {"id": tid, "category": detection.get('category', 'person'), "firstMs": at, "lastMs": at,
                              "observations": 0, "confidence": detection["confidence"],
                              "description": detection.get("description", "Person appearance; identity unknown")}
                if thumbnail:
                    appearance["thumbnailJpegBase64"] = thumbnail
                if 'label' in detection: appearance['label'] = detection['label']
                self.appearances.append(appearance)
                self.tracks[tid] = {"appearance": appearance, "bbox": detection["bbox"], "zones": {}}
                self.event(tid, "presence", at)
            track = self.tracks[tid]
            appearance = track["appearance"]
            appearance["lastMs"] = at
            appearance["observations"] += 1
            appearance["confidence"] = max(appearance["confidence"], detection["confidence"])
            track["bbox"] = detection["bbox"]
            box = detection["bbox"]
            area = (box[2] - box[0]) * (box[3] - box[1])
            if enrich is not None and area > track.get('featureArea', 0) * 2 and track.get('enrichments', 0) < 4:
                appearance.update(enrich(detection)); track['featureArea'] = area; track['enrichments'] = track.get('enrichments', 0) + 1
            foot = ((box[0] + box[2]) / 2, box[3])
            for zone in self.zones:
                present = inside(foot, zone["points"])
                state = track["zones"].get(zone["id"])
                if state is None:
                    state = {"inside": present, "pending": None, "support": 0, "visit": None}
                    track["zones"][zone["id"]] = state
                    if present:
                        state["visit"] = self.new_visit(tid, zone["id"], None, at)
                elif present != state["inside"]:
                    state["support"] = state["support"] + 1 if state["pending"] == present else 1
                    state["pending"] = present
                    if state["support"] >= 2:
                        state["inside"] = present
                        state["pending"] = None
                        state["support"] = 0
                        self.event(tid, "zone_entered" if present else "zone_exited", at, zone["id"])
                        if present:
                            state["visit"] = self.new_visit(tid, zone["id"], at, at)
                        elif state["visit"]:
                            state["visit"].update(exitedMs=at, state="CLOSED")
                            state["visit"] = None
                else:
                    state["pending"] = None
                    state["support"] = 0
                if present and state["visit"]:
                    state["visit"]["lastMs"] = at

    def new_visit(self, tid, zone, entered, at):
        if len(self.visits) >= 256:
            raise ValueError("Visit budget exceeded")
        visit = {"id": f"visit-{len(self.visits) + 1}", "appearanceId": tid, "zoneId": zone,
                 "enteredMs": entered, "lastMs": at, "exitedMs": None, "state": "OPEN"}
        self.visits.append(visit)
        return visit


def validate_request(request):
    keys = {"schema", "jobId", "runId", "commandId", "scope", "sourceId", "sourceVersion", "recordingId",
            "sourceSha256", "pipelineSha256", "startMs", "endMs", "sampleIntervalMs", "geometry"}
    if type(request) is not dict or set(request) - {'processing'} != keys or request["schema"] != "veyviz.temporal-recording.request.v1":
        raise ValueError("Invalid temporal request")
    if type(request["scope"]) is not dict or set(request["scope"]) != {"productId", "instanceId", "tenantId", "actorId", "actorKind"}:
        raise ValueError("Invalid scope")
    for key in ("startMs", "endMs", "sampleIntervalMs", "sourceVersion"):
        if type(request[key]) is not int:
            raise ValueError("Invalid integer")
    if not (0 <= request["startMs"] < request["endMs"] <= 86400000 and request["endMs"] - request["startMs"] <= 120000
            and 250 <= request["sampleIntervalMs"] <= 2000 and math.ceil((request["endMs"] - request["startMs"]) / request["sampleIntervalMs"]) <= 240):
        raise ValueError("Temporal window exceeds budget")
    if request["sourceVersion"] < 1 or request["scope"]["actorKind"] not in ("user", "service"):
        raise ValueError("Invalid identity")
    import re
    for value in [request[k] for k in ("jobId", "runId", "commandId", "sourceId", "recordingId")] + [request["scope"][k] for k in ("productId", "instanceId", "tenantId", "actorId")]:
        if type(value) is not str or re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", value) is None:
            raise ValueError("Invalid identifier")
    if any(type(request[key]) is not str or re.fullmatch(r"[a-f0-9]{64}", request[key]) is None for key in ('sourceSha256', 'pipelineSha256')):
        raise ValueError("Invalid source digest")
    if 'processing' in request:
        p = request['processing']
        if type(p) is not dict or set(p) != {'categories', 'execution', 'motion', 'visual', 'face', 'plate', 'runtimeSha256'}: raise ValueError('Invalid processing')
        if type(p['categories']) is not list or not 1 <= len(p['categories']) <= 3 or len(set(p['categories'])) != len(p['categories']) or any(x not in ('person', 'vehicle', 'animal') for x in p['categories']): raise ValueError('Invalid categories')
        if p['execution'] not in ('CPU', 'CUDA') or any(type(p[k]) is not bool for k in ['visual', 'face', 'plate']) or re.fullmatch('[a-f0-9]{64}', p['runtimeSha256']) is None: raise ValueError('Invalid processing selection')
        m = p['motion']
        if type(m) is not dict or set(m) != {'enabled', 'threshold', 'heartbeatMs'} or type(m['enabled']) is not bool or type(m['threshold']) not in (int, float) or not .0001 <= m['threshold'] <= .5 or type(m['heartbeatMs']) is not int or not 500 <= m['heartbeatMs'] <= 5000: raise ValueError('Invalid motion policy')
    geometry = request["geometry"]
    if type(geometry) is not dict or set(geometry) != {"version", "zones"} or type(geometry["version"]) is not int or geometry["version"] < 1 or type(geometry["zones"]) is not list or len(geometry["zones"]) > 8:
        raise ValueError("Invalid geometry")
    seen = set()
    for zone in geometry["zones"]:
        if type(zone) is not dict or set(zone) != {"id", "points"} or type(zone["id"]) is not str or re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", zone["id"]) is None or zone["id"] in seen or type(zone["points"]) is not list or not 3 <= len(zone["points"]) <= 16:
            raise ValueError("Invalid zone")
        seen.add(zone["id"])
        if any(type(p) is not list or len(p) != 2 or any(type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 1 for x in p) for p in zone["points"]):
            raise ValueError("Invalid points")
    return request


def execute(request, profile, recording, helper, cancellation, cleanup):
    from veyviz_execution_lifecycle import ExecutorSlot, SlotState
    from veyviz_inference_onnxruntime import SupervisedOnnxCpuExecutor
    from veyviz_media import FramePool, RecordingTimeline
    from veyviz_media_contracts import CaptureClock, SourceScope, StreamSession
    from veyviz_model_rfdetr import RfDetrSmallPersonAdapter
    from veyviz_perception_contracts import Coverage
    from veyviz_source_recording import SupervisedRecordingSource

    capture = executor = slot = owner = advanced = None
    decoded = 0
    observed = []
    processing = request.get('processing')
    motion = MotionGate(processing['motion']['threshold'], processing['motion']['heartbeatMs']) if processing and processing['motion']['enabled'] else None
    considered, skipped = [], []
    tracker = Tracker(request["geometry"]["zones"], max_gap_ms=max(1500, request["sampleIntervalMs"] * 2, processing['motion']['heartbeatMs'] * 2 if motion else 0))
    origin = None
    next_sample = request["startMs"]
    end_reason = "WINDOW_END"
    try:
        cancellation.check()
        cleanup["sourceClosed"] = False
        capture = SupervisedRecordingSource(recording, expected_sha256=request["sourceSha256"], max_file_bytes=128 * 1024 * 1024,
                                            startup_timeout_ms=30000, read_timeout_ms=10000, stop_timeout_ms=3000)
        sys.stderr.write('temporal phase source-ready\n'); sys.stderr.flush()
        owner = FramePool(max_bytes=64 * 1024 * 1024, max_frames=2, max_sources=1, max_leases=1)
        cleanup["inferenceClosed"] = False
        if processing:
            import importlib.util
            bridge_path = Path(__file__).with_name('runtime_bridge.py')
            if helper.sha256(bridge_path) != os.environ['VEYVIZ_RUNTIME_BRIDGE_SHA256']: raise ValueError('Advanced bridge drift')
            bridge_spec = importlib.util.spec_from_file_location('veyviz_advanced_bridge', bridge_path); bridge = importlib.util.module_from_spec(bridge_spec); bridge_spec.loader.exec_module(bridge)
            advanced = bridge.AdvancedWorker(os.environ['VEYVIZ_INTELLIGENCE_PROFILE'], processing['runtimeSha256'], {key: request[key] for key in ['scope', 'jobId', 'runId', 'commandId']})
            if processing['execution'] == 'CUDA':
                warmup = advanced.exchange({'operation': 'warmup', 'execution': 'CUDA'}, timeout=180)
                if warmup.get('execution') != 'CUDA' or warmup.get('warmed') is not True: raise ValueError('GPU warmup selection changed')
        executor = bridge.AdvancedExecutor(advanced, 'CUDA') if processing and processing['execution'] == 'CUDA' else SupervisedOnnxCpuExecutor(Path(profile["modelPath"]), expected_sha256=helper.MODEL_SHA,
                                             max_model_bytes=128 * 1024 * 1024, threads=1, startup_timeout_ms=30000,
                                             run_timeout_ms=10000, stop_timeout_ms=3000)
        adapter = RfDetrSmallPersonAdapter(confidence=.5, execution_generation=1)
        adapter.validate_executor(executor)
        slot = ExecutorSlot(executor, generation=1)
        sys.stderr.write('temporal phase inference-ready\n'); sys.stderr.flush()
        scope = SourceScope(request["scope"]["tenantId"], request["scope"]["instanceId"], request["sourceId"])
        session = StreamSession(scope, request["sourceSha256"], request["runId"], request["sourceVersion"],
                                "uncommissioned-temporal-full-frame", CaptureClock("recording-replay-ms", 0, 1000000, 0))
        owner.register_session(session)
        timeline = None
        virtual_now = 1000000
        while decoded < 20000:
            cancellation.check()
            frame = capture.read()
            if frame is None:
                end_reason = "RECORDING_END"
                break
            decoded += 1
            pts = frame.presentation_time * 1000
            if origin is None:
                origin = pts
            exact_at = pts - origin
            if exact_at >= request["endMs"]:
                break
            if exact_at < next_sample:
                continue
            next_sample = exact_at + request["sampleIntervalMs"]
            at = float(exact_at)
            considered.append(at)
            if len(considered) > 240:
                raise ValueError("Sample budget exceeded")
            if motion and not motion.admit(at, frame.pixels, frame.width, frame.height):
                skipped.append(at); continue
            if timeline is None:
                timeline = RecordingTimeline(session, frame.presentation_time, 60000)
            reference = timeline.reference(frame)
            virtual_now = max(virtual_now, reference.captured_at_ms)
            owner.offer(reference, frame.pixels, now_ms=virtual_now)
            lease = owner.acquire(session, now_ms=virtual_now)
            if lease is None:
                raise ValueError("Frame not admitted")
            try:
                started = time.perf_counter_ns()
                outputs = slot.run(adapter.prepare(lease.frame, lease.pixels), expected_generation=1)
                completed = virtual_now + math.ceil((time.perf_counter_ns() - started) / 1000000)
                cancellation.check()
                if not lease.result_valid(now_ms=completed):
                    raise ValueError("Expired frame lease")
                if processing:
                    detections = decode_categories(outputs, processing['categories'])
                    for detection in detections:
                        detection['description'] = describe_colour(lease.pixels, reference.width, reference.height, detection['bbox'], detection['category'], detection['label'])
                else:
                    facts = adapter.decode(outputs, lease.frame, completed_at_ms=completed, coverage=Coverage.UNKNOWN, reason="uncommissioned_temporal_recording")
                    detections = [{'bbox': [d.bbox.x_min, d.bbox.y_min, d.bbox.x_max, d.bbox.y_max], 'confidence': d.confidence, 'description': describe_colour(lease.pixels, reference.width, reference.height, [d.bbox.x_min, d.bbox.y_min, d.bbox.x_max, d.bbox.y_max])} for d in facts.detections]
                if len(detections) > 100:
                    raise ValueError("Detection budget exceeded")
                jpeg = helper.thumbnail(lease.frame, lease.pixels) if detections else None
                def enrich(detection):
                    import cv2, numpy as np, base64
                    image = np.frombuffer(lease.pixels, np.uint8).reshape(reference.height, reference.width, 3)
                    x1, y1, x2, y2 = detection['bbox']; crop = image[int(y1*reference.height):int(y2*reference.height), int(x1*reference.width):int(x2*reference.width)]
                    if crop.size == 0: return {}
                    scale = min(1, 640 / max(crop.shape[:2])); crop = cv2.resize(crop, (max(1, int(crop.shape[1]*scale)), max(1, int(crop.shape[0]*scale))))
                    ok, encoded = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 75])
                    if not ok or len(encoded) > 96*1024: return {}
                    image64 = base64.b64encode(encoded).decode()
                    features = advanced.exchange({'operation': 'features', 'image': image64, 'visual': processing['visual'], 'face': processing['face'] and detection['category'] == 'person', 'plate': processing['plate'] and detection['category'] == 'vehicle'})
                    features.pop('status', None); features.pop('intent', None); return {'thumbnailJpegBase64': image64, **features}
                tracker.observe(at, detections, jpeg, enrich if processing else None)
                observed.append(at)
                virtual_now = completed
            finally:
                lease.complete()
        else:
            raise ValueError("Decode budget exhausted before completion")
        if not observed:
            raise ValueError("Requested interval has no observed frames")
        # Lost tracks and recording endings leave uncertain visit ends.
        for visit in tracker.visits:
            if visit["state"] == "OPEN" and (end_reason == "RECORDING_END" or observed[-1] - visit["lastMs"] > tracker.max_gap):
                visit["state"] = "UNCERTAIN"
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
            if advanced is not None and not advanced.closed: advanced.close()
        except Exception as exc:
            cleanup['inferenceClosed'] = False; errors.append(exc)
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
            raise ValueError("Native cleanup unconfirmed") from errors[0]
    cancellation.check()
    if cleanup != {"sourceClosed": True, "inferenceClosed": True, "retainedBytes": 0, "outstandingLeases": 0}:
        raise ValueError("Native cleanup unconfirmed")
    result = {"sourceSha256": request["sourceSha256"], "modelSha256": helper.MODEL_SHA, "pipelineSha256": request['pipelineSha256'], "originPtsMs": float(origin),
            "decodedFrames": decoded, "coverage": {"policy": "SAMPLED_UNCOMMISSIONED", "observedMs": observed, "endReason": end_reason},
            "appearances": tracker.appearances, "events": tracker.events, "visits": tracker.visits}
    if processing: result['processingEvidence'] = {'runtimeSha256': processing['runtimeSha256'], 'execution': processing['execution'], 'consideredMs': considered, 'motionSkippedMs': skipped, 'featureModels': advanced.models}
    return result


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--profile", type=Path, required=True)
    args.add_argument("--recording", type=Path, required=True)
    options = args.parse_args()
    # Fixed, verified companion helper; isolated Python never imports a legacy checkout.
    spec = importlib.util.spec_from_file_location("veyviz_recorded_helper", Path(__file__).with_name("runner.py"))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    cleanup = {"sourceClosed": True, "inferenceClosed": True, "retainedBytes": 0, "outstandingLeases": 0}
    request = None
    try:
        request = validate_request(helper.strict_json(helper.read_line(0, 16384)))
        os.set_blocking(0, False)
        cancellation = helper.Cancellation()
        threading.Thread(target=cancellation.listen, args=(request["jobId"],), daemon=True).start()
        profile = helper.load_profile(options.profile)
        if helper.sha256(Path(__file__)) != request['pipelineSha256']:
            raise ValueError('Temporal execution fingerprint changed')
        helper.checked_file(options.recording, request["sourceSha256"])
        result = execute(request, profile, options.recording, helper, cancellation, cleanup)
        response = {"schema": "veyviz.temporal-recording.result.v1", "status": "SUCCEEDED", "request": request, **result, "cleanup": cleanup}
        encoded = json.dumps(response, allow_nan=False, separators=(",", ":")).encode() + b"\n"
        if len(encoded) > 4 * 1024 * 1024:
            raise ValueError("Output budget exceeded")
        sys.stdout.buffer.write(encoded)
        return 0
    except Exception as exc:
        sys.stderr.write(f"temporal runner: {type(exc).__name__}\n")
        sys.stdout.write(json.dumps({"schema": "veyviz.temporal-recording.result.v1", "status": "FAILED", "request": request, "cleanup": cleanup}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
