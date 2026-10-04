import importlib.util
from pathlib import Path
import unittest
import argparse
import json
import subprocess
import queue
import threading
import time
import hashlib

spec = importlib.util.spec_from_file_location('temporal_test_module', Path(__file__).with_name('temporal.py'))
temporal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(temporal)
PROFILE = CATALOG = None


class TemporalTests(unittest.TestCase):
    zone = {'id': 'entry', 'points': [[.4, .1], [.9, .1], [.9, .95], [.4, .95]]}

    def det(self, x):
        return {'bbox': [x, .2, x + .3, .7], 'confidence': .9}

    def test_motion_heartbeat_retains_explicit_observation_opportunities(self):
        import numpy as np
        gate = temporal.MotionGate(.002,2000); dark=np.zeros((90,160,3),np.uint8)
        self.assertTrue(gate.admit(0,dark.tobytes(),160,90)); self.assertFalse(gate.admit(1000,dark.tobytes(),160,90)); self.assertTrue(gate.admit(2000,dark.tobytes(),160,90))
        changed=dark.copy(); changed[20:30,20:30]=255
        self.assertTrue(gate.admit(3000,changed.tobytes(),160,90))

    def test_explicit_coco_classes_and_category_qualified_tracks(self):
        import numpy as np
        boxes=np.zeros((1,300,4),np.float32); logits=np.full((1,300,91),-20,np.float32)
        for index,label in enumerate([1,3,18]): boxes[0,index]=[.5,.5,.2,.2]; logits[0,index,label]=5
        detections=temporal.decode_categories({'pred_boxes':boxes,'pred_logits':logits},['person','vehicle','animal'])
        self.assertEqual([d['category'] for d in detections],['person','vehicle','animal'])
        tracker=temporal.Tracker([]); tracker.observe(0,detections); tracker.observe(1000,list(reversed(detections)))
        self.assertEqual(len(tracker.appearances),3); self.assertEqual([a['observations'] for a in tracker.appearances],[2,2,2])

    def test_continuous_track_and_debounced_zone_visit(self):
        tracker = temporal.Tracker([self.zone])
        for at, x in [(0, .1), (500, .2), (1000, .3), (1500, .3), (2000, .2), (2500, .1), (3000, .1)]:
            tracker.observe(at, [self.det(x)])
        self.assertEqual(len(tracker.appearances), 1)
        self.assertEqual([e['type'] for e in tracker.events], ['presence', 'zone_entered', 'zone_exited'])
        self.assertEqual(tracker.visits[0]['state'], 'CLOSED')
        self.assertEqual(tracker.visits[0]['enteredMs'], 1500)
        self.assertEqual(tracker.visits[0]['exitedMs'], 2500)

    def test_initial_inside_is_presence_without_invented_entry(self):
        tracker = temporal.Tracker([self.zone])
        tracker.observe(0, [self.det(.3)])
        self.assertEqual([e['type'] for e in tracker.events], ['presence'])
        self.assertIsNone(tracker.visits[0]['enteredMs'])

    def test_gap_does_not_fabricate_exit_or_same_identity(self):
        tracker = temporal.Tracker([self.zone])
        tracker.observe(0, [self.det(.3)])
        tracker.observe(3000, [self.det(.3)])
        self.assertEqual(len(tracker.appearances), 2)
        self.assertEqual(tracker.visits[0]['state'], 'UNCERTAIN')
        self.assertIsNone(tracker.visits[0]['exitedMs'])
        self.assertNotIn('zone_exited', [e['type'] for e in tracker.events])

    def test_matching_is_one_to_one(self):
        tracker = temporal.Tracker([])
        tracker.observe(0, [self.det(.1), self.det(.6)])
        tracker.observe(500, [self.det(.12), self.det(.62)])
        self.assertEqual([a['observations'] for a in tracker.appearances], [2, 2])

    def test_boundary_flicker_does_not_create_entry(self):
        tracker = temporal.Tracker([self.zone])
        for at, x in [(0, .2), (500, .3), (1000, .2), (1500, .3), (2000, .2)]:
            tracker.observe(at, [self.det(x)])
        self.assertEqual([e['type'] for e in tracker.events], ['presence'])

    def test_spatial_motion_matches_without_box_overlap(self):
        tracker = temporal.Tracker([])
        tracker.observe(0, [{'bbox': [.1, .2, .15, .35], 'confidence': .9}])
        tracker.observe(500, [{'bbox': [.17, .2, .22, .35], 'confidence': .9}])
        self.assertEqual(len(tracker.appearances), 1)
        tracker.observe(1000, [{'bbox': [.8, .2, .85, .35], 'confidence': .9}])
        self.assertEqual(len(tracker.appearances), 2)

    def test_colour_description_is_from_pixels(self):
        import numpy as np
        blue = np.full((20, 20, 3), [255, 0, 0], dtype=np.uint8).tobytes()
        self.assertIn('blue', temporal.describe_colour(blue, 20, 20, [0, 0, 1, 1]))

    def test_vehicle_colour_uses_lower_crop_and_does_not_claim_paint_identity(self):
        import numpy as np
        image = np.full((100, 100, 3), [255, 0, 0], dtype=np.uint8)
        image[45:85] = [0, 0, 255]
        description = temporal.describe_colour(image.tobytes(), 100, 100, [0, 0, 1, 1], 'vehicle', 'car')
        self.assertEqual(description, 'Car appearance; crop colour estimate: red; identity unknown')
        self.assertIn('upper-body colour estimate: blue', temporal.describe_colour(image.tobytes(), 100, 100, [0, 0, 1, 1]))


class NativeCancellationTests(unittest.TestCase):
    def test_cancel_after_both_native_owners_started(self):
        if PROFILE is None or CATALOG is None: self.skipTest('Supply installed --profile and admitted --catalog')
        profile = json.loads(PROFILE.read_text())
        recording = json.loads(CATALOG.read_text())['recordings'][0]
        request = {'schema': 'veyviz.temporal-recording.request.v1', 'jobId': 'cancel-native', 'runId': 'cancel-run',
                   'commandId': 'cancel-command', 'scope': {'productId': 'veyviz-review', 'instanceId': 'native-test',
                   'tenantId': recording['tenantId'], 'actorId': 'admin', 'actorKind': 'user'}, 'sourceId': 'native-source',
                   'sourceVersion': 1, 'recordingId': recording['id'], 'sourceSha256': recording['sha256'], 'pipelineSha256': hashlib.sha256(Path(__file__).with_name('temporal.py').read_bytes()).hexdigest(), 'startMs': 0,
                   'endMs': 22000, 'sampleIntervalMs': 500, 'geometry': {'version': 1, 'zones': []}}
        process = subprocess.Popen([profile['pythonExecutable'], '-I', str(Path(__file__).with_name('temporal.py')),
                                    '--profile', str(PROFILE), '--recording', recording['path']],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        phases = queue.Queue()
        def collect():
            for line in process.stderr:
                phases.put(line.strip())
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        process.stdin.write(json.dumps(request) + '\n')
        process.stdin.flush()
        seen = set()
        deadline = time.monotonic() + 60
        while 'temporal phase inference-ready' not in seen and time.monotonic() < deadline:
            try:
                seen.add(phases.get(timeout=1))
            except queue.Empty:
                if process.poll() is not None:
                    break
        process.stdin.write(json.dumps({'type': 'cancel', 'jobId': request['jobId']}) + '\n')
        process.stdin.flush()
        response = json.loads(process.stdout.readline())
        process.wait(timeout=30)
        reader.join(timeout=3)
        process.stdin.close(); process.stdout.close(); process.stderr.close()
        self.assertIn('temporal phase source-ready', seen)
        self.assertIn('temporal phase inference-ready', seen)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(response['request'], request)
        self.assertEqual(response['cleanup'], {'sourceClosed': True, 'inferenceClosed': True, 'retainedBytes': 0, 'outstandingLeases': 0})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--catalog', type=Path)
    args = parser.parse_args()
    PROFILE, CATALOG = args.profile, args.catalog
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(TemporalTests)
    if PROFILE and CATALOG:
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(NativeCancellationTests))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
