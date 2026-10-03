"""Bounded operator recording/live ingestion into immutable Product segments.

URLs and SSH credentials come only from a private local profile. No deletion,
camera configuration change, shell-supplied command or browser URL is supported.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, os, re, shlex, shutil, subprocess, threading, time, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]

def sha(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

def validate(profile):
    allowed = {'schema', 'kind', 'source', 'tenantId', 'prefix', 'segmentSeconds', 'durationSeconds', 'encoder', 'captureStartUtc', 'clockUncertaintyMs', 'ssh'}
    if type(profile) is not dict or set(profile) - allowed or profile.get('schema') != 'veyviz.ingest-profile.v1': raise ValueError('Invalid ingest profile')
    if profile.get('kind') not in ('file', 'rtsp', 'tcp', 'ssh-rtsp'): raise ValueError('Unsupported ingest kind')
    for key in ['tenantId', 'prefix']:
        if type(profile.get(key)) is not str or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}', profile[key]): raise ValueError('Bounded tenant/prefix required')
    for key, low, high in [('segmentSeconds', 5, 120), ('durationSeconds', 5, 86400)]:
        if type(profile.get(key)) is not int or not low <= profile[key] <= high: raise ValueError('Invalid capture duration')
    if profile['durationSeconds'] / profile['segmentSeconds'] > 90: raise ValueError('At most 90 segments per capture')
    if profile.get('encoder') not in ('cpu', 'nvenc'): raise ValueError('Select CPU or NVENC explicitly')
    source = profile.get('source')
    if type(source) is not str or len(source) > 4096 or '\0' in source: raise ValueError('Invalid operator source')
    if profile['kind'] == 'file':
        path = Path(source)
        if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024**3: raise ValueError('Admit a regular local recording up to 8 GiB')
    elif urlsplit(source).scheme != ('tcp' if profile['kind'] == 'tcp' else 'rtsp'): raise ValueError('Private source protocol mismatch')
    start, uncertainty = profile.get('captureStartUtc'), profile.get('clockUncertaintyMs')
    if (start is None) != (uncertainty is None): raise ValueError('Supply first-frame UTC and uncertainty together')
    if start is not None:
        if not isinstance(start, str) or not start.endswith('Z') or type(uncertainty) is not int or not 0 <= uncertainty <= 86400000: raise ValueError('Invalid source clock')
        datetime.fromisoformat(start.replace('Z', '+00:00'))
    if profile['kind'] != 'file' and start is not None: raise ValueError('Live capture needs a measured clock adapter; guessed connection time is not a frame clock')
    if profile['kind'] == 'ssh-rtsp':
        ssh = profile.get('ssh')
        if type(ssh) is not dict or set(ssh) != {'host', 'username', 'passwordFile', 'knownHosts'}: raise ValueError('Explicit SSH profile required')
        if not re.fullmatch('[a-zA-Z0-9_.:-]{1,128}', ssh['host']) or not re.fullmatch('[a-zA-Z0-9_.-]{1,64}', ssh['username']): raise ValueError('Invalid SSH target')
        for key in ['passwordFile', 'knownHosts']:
            path = Path(ssh[key])
            if not path.is_absolute() or not path.is_file() or path.is_symlink(): raise ValueError('Private regular credential/known-host file required')
    return profile

def ingest(profile, *, directory, catalog_directory, node='node', ffmpeg='ffmpeg'):
    profile = validate(profile); home = Path(directory).resolve(); home.mkdir(parents=True, exist_ok=False)
    index = home / 'segments.csv'; pattern = home / 'segment-%05d.mp4'
    identity = uuid.uuid4().hex[:12]
    binary = Path(shutil.which(ffmpeg) or ffmpeg).resolve()
    proof = {'schema': 'veyviz.ingest-evidence.v1', 'id': identity, 'sourceKind': profile['kind'], 'sourceFingerprint': sha(profile['source']) if profile['kind'] == 'file' else hashlib.sha256(profile['source'].encode()).hexdigest(), 'segments': [], 'status': 'RUNNING', 'nativeClosed': False, 'clock': 'ADMITTED_FIRST_FRAME' if profile.get('captureStartUtc') else 'UNKNOWN', 'encoder': profile['encoder'], 'ffmpegSha256': sha(binary), 'ingestSha256': sha(__file__)}
    def publish(): (home / 'evidence.json').write_text(json.dumps(proof, indent=2) + '\n')
    publish()
    args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin']
    if profile['kind'] == 'rtsp': args += ['-rtsp_transport', 'tcp', '-timeout', '15000000']
    if profile['kind'] == 'tcp': args += ['-rw_timeout', '15000000']
    args += ['-i', 'pipe:0' if profile['kind'] == 'ssh-rtsp' else profile['source'], '-t', str(profile['durationSeconds']), '-an', '-vf', 'setpts=PTS-STARTPTS,fps=12', '-c:v', 'h264_nvenc' if profile['encoder'] == 'nvenc' else 'libx264', '-preset', 'p4' if profile['encoder'] == 'nvenc' else 'veryfast', '-b:v', '2M', '-maxrate', '3M', '-bufsize', '6M', '-bf', '0', '-g', '24', '-force_key_frames', f"expr:gte(t,n_forced*{profile['segmentSeconds']})", '-f', 'segment', '-segment_time', str(profile['segmentSeconds']), '-segment_list', str(index), '-segment_list_type', 'csv', '-reset_timestamps', '1', str(pattern)]
    child = None; ssh_client = None; remote_channel = None; remote_code = None; relay_error = []; admitted = set(); stopping = False
    def inspect_segments(final=False):
        if not index.exists(): return
        contents = index.read_text()
        # A reader can race FFmpeg's final CSV write. Only complete lines establish closure.
        for row in csv.reader(contents[:contents.rfind('\n') + 1].splitlines()):
            if len(row) != 3: continue
            name, start, end = row; file = Path(name)
            if not file.is_absolute(): file = home / file
            if file.parent.resolve() != home or file.name in admitted: continue
            # FFmpeg writes the list entry when the segment closes. Never admit its active output.
            if file.stat().st_size < 1 or file.stat().st_size > 128 * 1024**2: raise ValueError('Closed segment exceeds admission bounds')
            recording_id = f"{profile['prefix']}{identity}-{file.stem.split('-')[-1]}"
            command = [node, str(ROOT / 'tools/veyviz-recording-admit.mjs'), '--file', str(file), '--tenant', profile['tenantId'], '--id', recording_id, '--name', f"{profile['prefix']} segment {file.stem.split('-')[-1]}", '--directory', str(catalog_directory)]
            if profile.get('captureStartUtc'):
                clock = datetime.fromisoformat(profile['captureStartUtc'].replace('Z', '+00:00')) + timedelta(seconds=float(start))
                command += ['--capture-start-utc', clock.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), '--clock-uncertainty-ms', str(profile['clockUncertaintyMs'] + 84)]
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            admitted.add(file.name); proof['segments'].append({'recordingId': recording_id, 'startSeconds': float(start), 'endSeconds': float(end), 'sha256': sha(file), 'bytes': file.stat().st_size, 'derived': True}); publish()
    try:
        child = subprocess.Popen(args, stdin=subprocess.PIPE if profile['kind'] == 'ssh-rtsp' else subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        stderr_tail = bytearray()
        def drain():
            for block in iter(lambda: child.stderr.read(4096), b''):
                stderr_tail.extend(block); del stderr_tail[:-1024]
        threading.Thread(target=drain, daemon=True).start()
        if profile['kind'] == 'ssh-rtsp':
            import paramiko
            ssh = profile['ssh']; ssh_client = paramiko.SSHClient(); ssh_client.load_host_keys(ssh['knownHosts']); ssh_client.set_missing_host_key_policy(paramiko.RejectPolicy())
            password = Path(ssh['passwordFile']).read_text().strip()
            if len(password) > 256: raise ValueError('Credential exceeds bound')
            ssh_client.connect(ssh['host'], username=ssh['username'], password=password, look_for_keys=False, allow_agent=False, timeout=15, auth_timeout=15)
            remote = f"timeout {profile['durationSeconds'] + 30}s ffmpeg -nostdin -hide_banner -loglevel error -rtsp_transport tcp -i {shlex.quote(profile['source'])} -t {profile['durationSeconds']} -an -c copy -f mpegts pipe:1"
            _, output, error = ssh_client.exec_command(remote, timeout=profile['durationSeconds'] + 60); remote_channel = output.channel
            def relay():
                nonlocal remote_code
                try:
                    forwarding = True
                    while True:
                        block = output.read(128 * 1024)
                        if not block: break
                        if forwarding:
                            try: child.stdin.write(block); child.stdin.flush()
                            except (BrokenPipeError, OSError):
                                forwarding = False
                                # Local -t may finish before the remote copy drains its last packets.
                                # Keep draining to receive actual remote closure; never invent success.
                                if child.poll() not in (None, 0): relay_error.append('Local receiver failed')
                    remote_code = output.channel.recv_exit_status()
                except Exception: relay_error.append('SSH relay interrupted')
                finally:
                    try: child.stdin.close()
                    except Exception: pass
            def drain_remote():
                for _ in iter(lambda: error.read(4096), b''): pass
            threading.Thread(target=drain_remote, daemon=True).start(); relay_thread = threading.Thread(target=relay, daemon=True); relay_thread.start()
        deadline = time.monotonic() + (profile['durationSeconds'] * 4 + 60 if profile['kind'] == 'file' else profile['durationSeconds'] + 90)
        while child.poll() is None:
            inspect_segments()
            if time.monotonic() >= deadline: raise TimeoutError('Capture deadline exceeded')
            time.sleep(.5)
        code = child.wait(); inspect_segments(final=True)
        proof['nativeClosed'] = True
        if profile['kind'] == 'ssh-rtsp':
            relay_thread.join(timeout=5)
            if remote_code != 0 or relay_error: raise ValueError('Remote capture closure or relay is unconfirmed')
        if code != 0: raise ValueError('Local capture/transcode failed')
        if not proof['segments']: raise ValueError('No closed segments were admitted')
        proof['status'] = 'COMPLETED'; publish(); return proof
    except BaseException as exc:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: pass
        proof['nativeClosed'] = bool(child is not None and child.poll() is not None and (profile['kind'] != 'ssh-rtsp' or remote_code == 0))
        proof['status'] = 'FAILED' if proof['nativeClosed'] else 'CLEANUP_UNCONFIRMED'; proof['error'] = type(exc).__name__; publish(); raise
    finally:
        if remote_channel is not None: remote_channel.close()
        if ssh_client is not None: ssh_client.close()
        if child is not None:
            for stream in [child.stdin, child.stderr]:
                if stream is not None:
                    try: stream.close()
                    except Exception: pass

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--profile', type=Path, required=True); parser.add_argument('--output', type=Path, required=True); parser.add_argument('--catalog-directory', type=Path, default=ROOT / '.local/veyviz-intelligence'); parser.add_argument('--ffmpeg', default='ffmpeg'); parser.add_argument('--node', default='node'); args = parser.parse_args()
    if args.profile.is_symlink() or args.profile.stat().st_size > 16384: raise ValueError('Bounded private regular profile required')
    profile = json.loads(args.profile.read_bytes())
    proof = ingest(profile, directory=args.output, catalog_directory=args.catalog_directory, node=args.node, ffmpeg=args.ffmpeg)
    print(json.dumps({'status': proof['status'], 'segments': len(proof['segments']), 'nativeClosed': proof['nativeClosed']}))

if __name__ == '__main__': main()
