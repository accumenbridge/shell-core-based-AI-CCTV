"""Fixed supervised native worker for GPU tensors and bounded retrieval features."""
from __future__ import annotations
import argparse, base64, hashlib, json, os, sys
from pathlib import Path

MAX_LINE = 32 * 1024 * 1024

def sha(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

def load_profile(path, expected):
    if sha(path) != expected: raise ValueError('Runtime profile drift')
    profile = json.loads(Path(path).read_bytes())
    if profile['schema'] != 'veyviz.intelligence-runtime.v1' or Path(profile['pythonExecutable']).resolve() != Path(sys.executable).resolve(): raise ValueError('Runtime identity mismatch')
    if not 1 <= len(profile['files']) <= 20000: raise ValueError('Runtime closure exceeds bound')
    for item in profile['files']:
        file = Path(item['path'])
        if not file.is_absolute() or file.is_symlink() or file.stat().st_size != item['bytes'] or sha(file) != item['sha256']: raise ValueError('Runtime closure drift')
    for item in profile['models'].values():
        if sha(item['path']) != item['sha256']: raise ValueError('Model drift')
    return profile

class Runtime:
    def __init__(self, profile):
        import cv2, numpy as np, onnxruntime as ort
        self.cv, self.np, self.ort, self.models = cv2, np, ort, profile['models']
        self.sessions = {}; self.face_detector = self.face_recognizer = self.tokenizer = None
        ort.preload_dlls(directory='')
        self.features = {key: value['sha256'] for key, value in self.models.items()}
        self.features['visualSpace'] = hashlib.sha256(json.dumps(['siglip2-pooled-l2-v1'] + [self.features[k] for k in ['vision', 'text', 'tokenizer', 'tokenizerConfig', 'preprocessor']], separators=(',', ':')).encode()).hexdigest()

    def session(self, name, execution='CPU'):
        key = (name, execution)
        if key not in self.sessions:
            options = self.ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
            if execution == 'CUDA':
                if 'CUDAExecutionProvider' not in self.ort.get_available_providers(): raise ValueError('CUDA unavailable')
                providers = [('CUDAExecutionProvider', {'device_id': 0, 'gpu_mem_limit': 2 * 1024**3, 'cudnn_conv_algo_search': 'HEURISTIC'})]
            else: providers = ['CPUExecutionProvider']
            session = self.ort.InferenceSession(self.models[name]['path'], sess_options=options, providers=providers)
            if execution == 'CUDA' and session.get_providers()[0] != 'CUDAExecutionProvider': raise ValueError('CUDA did not activate')
            session.disable_fallback()
            self.sessions[key] = session
        return self.sessions[key]

    def vector(self, output, model):
        vector = self.np.asarray(output, dtype=self.np.float32).reshape(-1)
        norm = float(self.np.linalg.norm(vector))
        if not 1 <= len(vector) <= 2048 or not self.np.isfinite(vector).all() or norm < 1e-9: raise ValueError('Invalid feature vector')
        return {'model': self.features['visualSpace'] if model == 'vision' else self.models[model]['sha256'], 'values': (vector / norm).tolist()}

    def image(self, encoded):
        if not isinstance(encoded, str) or len(encoded) > 512 * 1024: raise ValueError('Image exceeds bound')
        data = base64.b64decode(encoded, validate=True)
        # Inspect encoded dimensions before native image decode.
        from PIL import Image
        from io import BytesIO
        try:
            with Image.open(BytesIO(data)) as header:
                if header.format not in ('JPEG', 'PNG') or min(header.size) < 1 or max(header.size) > 2048 or header.width * header.height > 4 * 1024**2: raise ValueError('Image dimensions exceed bound')
        except (OSError, Image.DecompressionBombError) as exc: raise ValueError('Invalid bounded reference image') from exc
        image = self.cv.imdecode(self.np.frombuffer(data, self.np.uint8), self.cv.IMREAD_COLOR)
        if image is None: raise ValueError('Image decode failed')
        return image

    def visual(self, image):
        from PIL import Image
        config = json.loads(Path(self.models['preprocessor']['path']).read_bytes())
        rgb = self.cv.cvtColor(image, self.cv.COLOR_BGR2RGB)
        resized = Image.fromarray(rgb).resize((224, 224), Image.Resampling(config['resample']))
        pixel = self.np.asarray(resized, dtype=self.np.float32) / 255
        pixel = (pixel - self.np.array(config['image_mean'], dtype=self.np.float32)) / self.np.array(config['image_std'], dtype=self.np.float32)
        session = self.session('vision'); outputs = session.run(None, {'pixel_values': self.np.ascontiguousarray(pixel.transpose(2, 0, 1)[None])})
        names = [x.name for x in session.get_outputs()]; index = names.index('pooler_output') if 'pooler_output' in names else 0
        return self.vector(outputs[index], 'vision')

    def text(self, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 512: raise ValueError('Text query exceeds bound')
        from tokenizers import Tokenizer
        if self.tokenizer is None:
            self.tokenizer = Tokenizer.from_file(self.models['tokenizer']['path'])
            cfg = json.loads(Path(self.models['tokenizerConfig']['path']).read_bytes())
            pad = cfg.get('pad_token', '</s>'); pad = pad.get('content') if isinstance(pad, dict) else pad
            self.tokenizer.enable_truncation(max_length=64)
            self.tokenizer.enable_padding(length=64, pad_id=self.tokenizer.token_to_id(pad), pad_token=pad)
        tokens = self.tokenizer.encode(text).ids
        session = self.session('text'); outputs = session.run(None, {'input_ids': self.np.asarray([tokens], dtype=self.np.int64)})
        names = [x.name for x in session.get_outputs()]; index = names.index('pooler_output') if 'pooler_output' in names else 0
        # Paired text/vision model identity, not the text model hash alone.
        vector = self.vector(outputs[index], 'vision'); return vector

    def face(self, image, strict=False):
        if self.face_detector is None:
            self.face_detector = self.cv.FaceDetectorYN.create(self.models['faceDetector']['path'], '', (320, 320), .85, .3, 500)
            self.face_recognizer = self.cv.FaceRecognizerSF.create(self.models['face']['path'], '')
        self.face_detector.setInputSize((image.shape[1], image.shape[0]))
        _, faces = self.face_detector.detect(image)
        if faces is None or len(faces) != 1:
            if strict: raise ValueError('Reference image must contain exactly one detectable face')
            return None
        face = faces[0]
        if min(face[2], face[3]) < 24:
            if strict: raise ValueError('Reference face too small')
            return None
        aligned = self.face_recognizer.alignCrop(image, face)
        return self.vector(self.face_recognizer.feature(aligned), 'face')

    def recognize(self, image):
        session = self.session('ocr'); height = 48
        width = min(640, max(32, int(height * image.shape[1] / image.shape[0])))
        resized = self.cv.resize(image, (width, height)).astype(self.np.float32) / 255
        input_value = ((resized - .5) / .5).transpose(2, 0, 1)[None]
        output = session.run(None, {session.get_inputs()[0].name: self.np.ascontiguousarray(input_value)})[0][0]
        chars = [''] + Path(self.models['ocrDictionary']['path']).read_text(encoding='utf-8').splitlines() + [' ']
        if output.shape[-1] != len(chars): raise ValueError('OCR dictionary mismatch')
        previous = 0; text = ''; confidence = []
        for row in output:
            index = int(row.argmax())
            if index and index != previous: text += chars[index]; confidence.append(float(row[index]))
            previous = index
        return text, sum(confidence) / len(confidence) if confidence else 0

    def plates(self, image):
        import re
        session = self.session('ocrDetector')
        height, width = image.shape[:2]; scale = min(1, 640 / max(height, width))
        h, w = max(32, round(height * scale / 32) * 32), max(32, round(width * scale / 32) * 32)
        pixel = self.cv.resize(image, (w, h)).astype(self.np.float32) / 255
        pixel = (pixel - self.np.array([.485, .456, .406], dtype=self.np.float32)) / self.np.array([.229, .224, .225], dtype=self.np.float32)
        output = session.run(None, {session.get_inputs()[0].name: self.np.ascontiguousarray(pixel.transpose(2, 0, 1)[None])})[0][0, 0]
        mask = (output > .3).astype(self.np.uint8) * 255
        contours, _ = self.cv.findContours(mask, self.cv.RETR_LIST, self.cv.CHAIN_APPROX_SIMPLE)
        results = []
        for contour in sorted(contours, key=self.cv.contourArea, reverse=True)[:16]:
            x, y, cw, ch = self.cv.boundingRect(contour)
            if cw < 8 or ch < 4: continue
            pad = max(2, ch // 4)
            x1, y1 = max(0, int((x-pad)*width/w)), max(0, int((y-pad)*height/h))
            x2, y2 = min(width, int((x+cw+pad)*width/w)), min(height, int((y+ch+pad)*height/h))
            if x2 <= x1 or y2 <= y1: continue
            text, confidence = self.recognize(image[y1:y2, x1:x2])
            text = re.sub('[^A-Z0-9]', '', text.upper())
            if 6 <= len(text) <= 16 and sum(x.isdigit() for x in text) >= 3 and sum(x.isalpha() for x in text) >= 1 and confidence >= .6:
                if not any(r['text'] == text for r in results): results.append({'text': text, 'confidence': confidence})
        return results[:4]

    def run(self, request):
        operation = request['operation']
        if operation == 'warmup':
            session = self.session('detector', request['execution'])
            session.run(None, {'input': self.np.zeros((1,3,512,512), self.np.float32)})
            return {'execution': request['execution'], 'warmed': True}
        if operation == 'tensor':
            data = base64.b64decode(request['data'], validate=True)
            if len(data) != 3 * 512 * 512 * 4: raise ValueError('Invalid detector input size')
            tensor = self.np.frombuffer(data, dtype=self.np.float32).reshape(1, 3, 512, 512)
            if not self.np.isfinite(tensor).all(): raise ValueError('Invalid tensor')
            session = self.session('detector', request['execution'])
            values = session.run(None, {'input': tensor})
            return {'outputs': {spec.name: {'shape': list(value.shape), 'data': base64.b64encode(value.astype(self.np.float32).tobytes()).decode()} for spec, value in zip(session.get_outputs(), values)}, 'execution': request['execution']}
        if operation == 'text': return {'vector': self.text(request['text'])}
        image = self.image(request['image'])
        if operation == 'image': return {'vector': self.visual(image)}
        if operation == 'face': return {'vector': self.face(image, strict=True)}
        if operation == 'features':
            result = {}
            if request.get('visual'): result['visualVector'] = self.visual(image)
            if request.get('face'):
                face = self.face(image)
                if face: result['faceVector'] = face
            if request.get('plate'): result['plateCandidates'] = self.plates(image)
            return result
        raise ValueError('Unknown operation')

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--profile', required=True); parser.add_argument('--sha256', required=True); args = parser.parse_args()
    runtime = Runtime(load_profile(args.profile, args.sha256))
    print(json.dumps({'status': 'READY', 'models': runtime.features}), flush=True)
    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not raw: raise ValueError('Control pipe ended without closure')
        if len(raw) > MAX_LINE or not raw.endswith(b'\n'): raise ValueError('Control budget exceeded')
        request = json.loads(raw)
        if request.get('operation') == 'close':
            runtime.sessions.clear(); runtime.face_detector = runtime.face_recognizer = runtime.tokenizer = None
            del runtime
            print(json.dumps({'status': 'CLOSED'}), flush=True); return 0
        try: response = {'status': 'RESULT', **runtime.run(request)}
        except Exception as exc:
            sys.stderr.write(type(exc).__name__ + '\n'); response = {'status': 'FAILED', 'error': str(exc)[:120] if isinstance(exc, ValueError) else 'Native feature execution failed'}
        response['intent'] = request.get('intent')
        print(json.dumps(response, allow_nan=False, separators=(',', ':')), flush=True)

if __name__ == '__main__': raise SystemExit(main())
