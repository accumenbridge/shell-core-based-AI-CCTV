"""Installed-model qualification; opt in with VEYVIZ_INTELLIGENCE_PROFILE."""
import base64, hashlib, importlib.util, json, os, time, unittest
from pathlib import Path

def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded); return loaded

@unittest.skipUnless(os.environ.get('VEYVIZ_INTELLIGENCE_PROFILE'), 'No installed intelligence profile selected')
class InstalledRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = module('runtime_worker'); cls.profile = Path(os.environ['VEYVIZ_INTELLIGENCE_PROFILE'])
        cls.digest = hashlib.sha256(cls.profile.read_bytes()).hexdigest()
        cls.runtime = cls.worker.Runtime(cls.worker.load_profile(cls.profile, cls.digest))
        cls.evidence = {}

    @classmethod
    def tearDownClass(cls):
        destination = os.environ.get('VEYVIZ_RUNTIME_TEST_EVIDENCE')
        if destination: Path(destination).write_text(json.dumps(cls.evidence, indent=2) + '\n')
        cls.runtime.sessions.clear()

    def frame(self):
        clip = os.environ.get('VEYVIZ_RUNTIME_TEST_CLIP')
        self.assertTrue(clip, 'Select the authorized qualification clip')
        cap = self.runtime.cv.VideoCapture(clip)
        try: cap.set(self.runtime.cv.CAP_PROP_POS_MSEC, 10000); ok, image = cap.read(); self.assertTrue(ok); return image
        finally: cap.release()

    def tensor(self, image):
        np, cv = self.runtime.np, self.runtime.cv
        resized = cv.resize(cv.cvtColor(image, cv.COLOR_BGR2RGB), (512,512)).astype(np.float32) / 255
        normalized = (resized - np.array([.485,.456,.406],np.float32)) / np.array([.229,.224,.225],np.float32)
        return np.ascontiguousarray(normalized.transpose(2,0,1)[None])

    def test_01_actual_cuda_matches_cpu_and_profiles_nodes(self):
        import tempfile
        np = self.runtime.np; tensor = self.tensor(self.frame()); timings = {}; outputs = {}
        for mode in ['CPU', 'CUDA']:
            session = self.runtime.session('detector', mode)
            session.run(None, {'input': tensor})
            start = time.perf_counter()
            for _ in range(4): outputs[mode] = session.run(None, {'input': tensor})
            timings[mode] = (time.perf_counter() - start) * 1000 / 4
        # RF-DETR's top-k query order can change for near-tied background proposals.
        # Compare accepted objects by category and geometry, not unused query positions.
        temporal = module('temporal'); names = [s.name for s in self.runtime.session('detector').get_outputs()]
        cpu_detections = temporal.decode_categories(dict(zip(names, outputs['CPU'])), ['person','vehicle','animal'])
        cuda_detections = temporal.decode_categories(dict(zip(names, outputs['CUDA'])), ['person','vehicle','animal'])
        self.assertEqual(len(cpu_detections),len(cuda_detections))
        remaining=list(cuda_detections)
        for detection in cpu_detections:
            compatible=[d for d in remaining if d['label']==detection['label']]
            self.assertTrue(compatible)
            match=max(compatible,key=lambda d:temporal.iou(d['bbox'],detection['bbox']))
            self.assertGreater(temporal.iou(match['bbox'],detection['bbox']),.95); self.assertLess(abs(match['confidence']-detection['confidence']),.02); remaining.remove(match)
        self.evidence['detector']={'meanWarmMs':timings,'speedup':timings['CPU']/timings['CUDA'],'acceptedObjectsMatch':True,'matchedObjects':len(cpu_detections)}
        with tempfile.TemporaryDirectory() as directory:
            options = self.runtime.ort.SessionOptions(); options.enable_profiling = True; options.profile_file_prefix = str(Path(directory)/'cuda'); options.intra_op_num_threads = 2
            session = self.runtime.ort.InferenceSession(self.runtime.models['detector']['path'], sess_options=options, providers=['CUDAExecutionProvider'])
            session.disable_fallback()
            session.run(None, {'input': tensor}); profile = json.loads(Path(session.end_profiling()).read_text())
            cuda_nodes = sum(row.get('args', {}).get('provider') == 'CUDAExecutionProvider' for row in profile)
            self.assertGreater(cuda_nodes, 0)
        self.evidence['detector']['cudaNodes']=cuda_nodes

    def test_02_paired_semantic_model_on_actual_person_crop(self):
        temporal = module('temporal'); image = self.frame(); tensor = self.tensor(image)
        session = self.runtime.session('detector'); values = session.run(None, {'input': tensor})
        detections = temporal.decode_categories(dict(zip([s.name for s in session.get_outputs()], values)), ['person'])
        self.assertTrue(detections, 'The qualification frame should contain a detected person')
        box = max(detections, key=lambda x: x['confidence'])['bbox']; h,w = image.shape[:2]
        crop = image[int(box[1]*h):int(box[3]*h),int(box[0]*w):int(box[2]*w)]
        visual = self.runtime.visual(crop); person = self.runtime.text('a person walking'); vehicle = self.runtime.text('a red car')
        self.assertEqual(visual['model'], person['model']); self.assertEqual(len(visual['values']), 768)
        similarity = lambda a,b: float(self.runtime.np.dot(a['values'], b['values']))
        self.assertGreater(similarity(visual, person), similarity(visual, vehicle))
        self.evidence['retrieval'] = {'personScore': similarity(visual, person), 'carScore': similarity(visual, vehicle), 'dimensions':768, 'pairedModel':visual['model']}
        encoded = base64.b64encode(self.runtime.cv.imencode('.jpg', crop)[1]).decode()
        features = self.runtime.run({'operation':'features','image':encoded,'visual':True,'face':True,'plate':False})
        self.assertIn('visualVector', features)
        self.evidence['faceInClip'] = 'faceVector' in features

    def test_03_plate_ocr_on_controlled_reference_and_no_face(self):
        cv,np = self.runtime.cv,self.runtime.np
        image = np.full((100,360,3),255,np.uint8); cv.putText(image,'KA01AB1234',(12,68),cv.FONT_HERSHEY_SIMPLEX,1.3,(0,0,0),2,cv.LINE_AA)
        text, confidence = self.runtime.recognize(image)
        self.assertEqual(text.replace(' ',''), 'KA01AB1234'); self.assertGreaterEqual(confidence,.6)
        candidates = self.runtime.plates(image); self.assertTrue(any(p['text']=='KA01AB1234' for p in candidates))
        with self.assertRaisesRegex(ValueError,'exactly one'): self.runtime.face(image, strict=True)
        self.evidence['plate'] = {'reference':'CONTROLLED_RENDERED_TEXT','text':text,'confidence':confidence,'detectedCandidate':True}

    def test_04_supervised_worker_closes_and_echoes_intent(self):
        bridge = module('runtime_bridge'); intent={'scope':{'tenantId':'qualification'},'commandId':'native-qualification'}
        worker = bridge.AdvancedWorker(self.profile,self.digest,intent)
        try:
            result = worker.exchange({'operation':'text','text':'a person'})
            self.assertEqual(result['intent'],intent); self.assertEqual(len(result['vector']['values']),768)
        finally: worker.close()
        self.assertTrue(worker.closed); self.assertEqual(worker.child.returncode,0)

    def test_05_drift_is_rejected_before_execution(self):
        with self.assertRaisesRegex(ValueError,'drift'): self.worker.load_profile(self.profile,'0'*64)
        with self.assertRaises(ValueError): self.runtime.image(base64.b64encode(b'not an image').decode())

    @unittest.skipUnless(os.environ.get('VEYVIZ_FACE_TEST_IMAGE'), 'No public qualification reference selected')
    def test_06_face_reference_matches_resized_reference_without_identity_claim(self):
        image = self.runtime.cv.imread(os.environ['VEYVIZ_FACE_TEST_IMAGE']); self.assertIsNotNone(image)
        first = self.runtime.face(image,strict=True)
        second = self.runtime.face(self.runtime.cv.resize(image,(384,384)),strict=True)
        self.assertEqual(first['model'],second['model']); self.assertEqual(len(first['values']),128)
        similarity=float(self.runtime.np.dot(first['values'],second['values'])); self.assertGreater(similarity,.8)
        self.evidence['faceReference']={'source':'OPENCV_PUBLIC_TEST_IMAGE','dimensions':128,'resizedSimilarity':similarity,'identityEstablished':False}

if __name__ == '__main__': unittest.main()
