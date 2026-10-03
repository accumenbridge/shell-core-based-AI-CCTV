import importlib.util, json, os, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('ingest',Path(__file__).with_name('ingest.py')); ingest=importlib.util.module_from_spec(spec); spec.loader.exec_module(ingest)

class IngestTests(unittest.TestCase):
    def profile(self, path):
        return {'schema':'veyviz.ingest-profile.v1','kind':'file','source':str(path),'tenantId':'qualification','prefix':'segment-','segmentSeconds':5,'durationSeconds':15,'encoder':'cpu'}

    def test_bounds_and_unmeasured_live_clock(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root)/'clip.mp4'; source.write_bytes(b'fixture'); profile=self.profile(source)
            self.assertEqual(ingest.validate(profile),profile)
            for key,value in [('durationSeconds',86401),('segmentSeconds',4),('tenantId','../other'),('encoder','shell')]:
                with self.assertRaises(ValueError): ingest.validate({**profile,key:value})
            with self.assertRaises(ValueError): ingest.validate({**profile,'durationSeconds':1000})
            with self.assertRaises(ValueError): ingest.validate({**profile,'kind':'rtsp','source':'rtsp://camera/live','captureStartUtc':'2026-10-02T06:20:00Z','clockUncertaintyMs':1000})

    @unittest.skipUnless(os.environ.get('VEYVIZ_RUNTIME_TEST_CLIP'),'No authorized local recording selected')
    def test_closed_segments_are_digest_admitted_with_original_clock_offsets(self):
        with tempfile.TemporaryDirectory() as root:
            profile=self.profile(Path(os.environ['VEYVIZ_RUNTIME_TEST_CLIP'])); profile.update(captureStartUtc='2026-10-02T06:20:00Z',clockUncertaintyMs=1000)
            proof=ingest.ingest(profile,directory=Path(root)/'output',catalog_directory=Path(root)/'catalog')
            self.assertEqual(proof['status'],'COMPLETED'); self.assertTrue(proof['nativeClosed']); self.assertEqual(len(proof['segments']),3)
            catalog=json.loads((Path(root)/'catalog/catalog.json').read_text())
            for segment,admission in zip(proof['segments'],catalog['recordings']):
                self.assertEqual(segment['sha256'],admission['sha256']); self.assertEqual(ingest.sha(admission['path']),admission['sha256'])
                self.assertTrue(admission['captureStartUtc'].startswith('2026-10-02T06:20:'))
            self.assertGreater(proof['segments'][1]['startSeconds'],proof['segments'][0]['startSeconds'])

if __name__=='__main__': unittest.main()
