"""Install assets into a separate private intelligence profile; never alter CPU companion."""
from __future__ import annotations
import argparse, hashlib, importlib.metadata, json, shutil, sys, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[2]
HOME = ROOT / '.local/veyviz-intelligence-runtime'
SIG_REV = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4'

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def asset(name, url):
    target = HOME / 'assets' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        temp = target.with_suffix(target.suffix + '.download')
        with urllib.request.urlopen(url, timeout=60) as response, temp.open('xb') as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        temp.rename(target)
    return {'path': str(target), 'sha256': digest(target), 'bytes': target.stat().st_size, 'origin': url}

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--assets-only', action='store_true'); args = parser.parse_args()
    names = ['onnx/vision_model_quantized.onnx', 'onnx/text_model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'README.md']
    with ThreadPoolExecutor(max_workers=3) as pool:
        sig = list(pool.map(lambda name: asset('siglip2/' + name, f'https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/{SIG_REV}/{name}'), names))
    # Resolve one concrete upstream revision and retain it; downloaded files are digest bound.
    revision_path = HOME / 'opencv-zoo-revision.txt'
    if revision_path.exists(): zoo = revision_path.read_text().strip()
    else:
        prior = HOME / 'profile.json'
        zoo = json.loads(prior.read_bytes())['provenance']['opencvZooRevision'] if prior.exists() else json.load(urllib.request.urlopen('https://api.github.com/repos/opencv/opencv_zoo/commits/main', timeout=30))['sha']
        revision_path.write_text(zoo + '\n')
    face = [asset('face/' + name, f'https://media.githubusercontent.com/media/opencv/opencv_zoo/{zoo}/models/{folder}/{name}') for folder, name in [
        ('face_detection_yunet', 'face_detection_yunet_2023mar.onnx'), ('face_recognition_sface', 'face_recognition_sface_2021dec.onnx')]]
    for folder in ['face_detection_yunet', 'face_recognition_sface']:
        face.append(asset('face/' + folder + '-LICENSE', f'https://raw.githubusercontent.com/opencv/opencv_zoo/{zoo}/models/{folder}/LICENSE'))
    legacy = Path('D:/Veyviz-code/veyviz-ai-cctv/models/ocr')
    ocr = []
    for name in ['paddle_det.onnx', 'paddle_rec_en.onnx', 'en_dict.txt']:
        source = legacy / name; target = HOME / 'assets/ocr' / name; target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists(): shutil.copyfile(source, target)
        if digest(target) != digest(source): raise ValueError('OCR asset copy mismatch')
        ocr.append({'path': str(target), 'sha256': digest(target), 'bytes': target.stat().st_size, 'origin': str(source)})
    models = {'detector': {'path': str(ROOT / '.local/veyviz-ai/assets/rfdetr-small.onnx'), 'sha256': '0e0817f4cafa479ccba17662a142092932b0b10c98947e7cf60f3badd0f5c219'},
              'vision': sig[0], 'text': sig[1], 'tokenizer': sig[2], 'tokenizerConfig': sig[3], 'preprocessor': sig[4], 'faceDetector': face[0], 'face': face[1], 'ocrDetector': ocr[0], 'ocr': ocr[1], 'ocrDictionary': ocr[2]}
    if args.assets_only:
        (HOME / 'assets.json').write_text(json.dumps(models, indent=2) + '\n'); return
    files = set()
    versions = {}
    for distribution in importlib.metadata.distributions():
        versions[distribution.metadata['Name']] = distribution.version
        for entry in distribution.files or []:
            path = Path(distribution.locate_file(entry)).resolve()
            if path.is_file() and path.suffix not in ('.pyc', '.pyo'): files.add(path)
    base = Path(sys.base_prefix)
    for directory in [base / 'Lib', base / 'DLLs']:
        files.update(p.resolve() for p in directory.rglob('*') if p.is_file() and 'site-packages' not in p.parts and '__pycache__' not in p.parts and p.suffix not in ('.pyc', '.pyo'))
    files.update(p.resolve() for p in [Path(sys.executable), base / 'python.exe', base / 'python313.dll', base / 'python3.dll', Path(sys.prefix) / 'pyvenv.cfg'] if p.exists())
    worker = Path(__file__).with_name('runtime_worker.py')
    files.add(worker)
    records = [{'path': str(p), 'sha256': digest(p), 'bytes': p.stat().st_size} for p in sorted(files)]
    profile = {'schema': 'veyviz.intelligence-runtime.v1', 'pythonExecutable': str(Path(sys.executable).resolve()), 'workerPath': str(worker), 'files': records, 'models': models, 'versions': versions,
               'provenance': {'siglipRevision': SIG_REV, 'opencvZooRevision': zoo, 'ocr': 'Captured local Paddle assets; redistribution provenance/license review remains required', 'rfDetr': 'Existing pinned Apache-2.0 companion model'}}
    path = HOME / 'profile.json'; path.write_text(json.dumps(profile, indent=2) + '\n')
    print(json.dumps({'profile': str(path), 'sha256': digest(path), 'files': len(records), 'versions': versions}))

if __name__ == '__main__': main()
