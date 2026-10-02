"""Capture, build, install and verify the private local AI companion.

The first capture reads selected source only. Later builds use the captured
closure and a digest-locked local wheelhouse; the original checkout is never a
runtime import path. Existing profiles are verified, never silently refreshed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / ".local" / "veyviz-ai"
VENDOR = ROOT / "vendor" / "veyviz-ai"
PROFILE = PRIVATE / "profile.json"
INVENTORY = PRIVATE / "inventory.json"
MODEL_SHA = "0e0817f4cafa479ccba17662a142092932b0b10c98947e7cf60f3badd0f5c219"
RECORDING_SHA = "ea6b48e57c343027b169ee1357e6e85ea3b8d179ba70058c294d1b1ec8db2805"
ROOT_PACKAGES = (
    "veyviz-source-recording", "veyviz-model-rfdetr", "veyviz-inference-onnxruntime",
    "veyviz-execution-lifecycle", "veyviz-media",
)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".new")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def execute(args: list[str], *, cwd: Path = ROOT) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def file_record(path: Path, kind: str) -> dict:
    return {"path": str(path.resolve(strict=True)), "sha256": digest(path),
            "bytes": path.stat().st_size, "kind": kind}


def capture(source: Path) -> dict:
    if (VENDOR / "PROVENANCE.json").exists():
        raise ValueError("Source capture already exists; verify it instead of replacing its provenance")
    source = source.resolve(strict=True)
    if source == ROOT or ROOT in source.parents or source in ROOT.parents:
        raise ValueError("Independent source and destination required")
    # Only package roots, selected from explicitly owned source areas.
    available = {}
    for top in ("contracts", "modules", "adapters"):
        for project in (source / top).rglob("pyproject.toml"):
            if any(part.startswith(".") for part in project.relative_to(source).parts):
                continue
            document = tomllib.loads(project.read_text(encoding="utf-8"))
            name = document.get("project", {}).get("name", "")
            if name.startswith("veyviz-"):
                available[name] = (project.parent, document)
    closure: dict[str, tuple[Path, dict]] = {}
    pending = list(ROOT_PACKAGES)
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        if name not in available:
            raise ValueError(f"Missing source distribution {name}")
        directory, document = available[name]
        closure[name] = (directory, document)
        for requirement in document["project"].get("dependencies", []):
            if requirement.startswith("veyviz-"):
                dependency, exact = requirement.split("==")
                if available[dependency][1]["project"]["version"] != exact:
                    raise ValueError("Local dependency does not match exact source version")
                pending.append(dependency)
    captured = []
    distributions = []
    for name, (directory, document) in sorted(closure.items()):
        target = VENDOR / "packages" / name
        for path in sorted(directory.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(directory)
            if not (relative.parts[0] in ("src", "tests") or len(relative.parts) == 1 and
                    (path.name in ("pyproject.toml", "README.md", "PROVENANCE.md") or
                     path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")))):
                continue
            if "__pycache__" in relative.parts or path.suffix in (".pyc", ".pyo"):
                continue
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            before = digest(path)
            shutil.copyfile(path, destination)
            if digest(destination) != before or digest(path) != before:
                raise ValueError("Source changed during capture")
            captured.append({"sourcePath": path.relative_to(source).as_posix(),
                             "path": destination.relative_to(ROOT).as_posix(), "sha256": before})
        distributions.append({"name": name, "version": document["project"]["version"],
                              "path": target.relative_to(ROOT).as_posix(),
                              "dependencies": document["project"].get("dependencies", [])})
    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "models/rfdetr-source.lock.json"):
        path = source / name
        if path.is_file():
            destination = VENDOR / "upstream" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            captured.append({"sourcePath": name, "path": destination.relative_to(ROOT).as_posix(),
                             "sha256": digest(destination)})
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    status = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"],
                                     cwd=source, text=True)
    provenance = {"schema": "veyviz.selected-source.v1", "capturedAt": datetime.now(timezone.utc).isoformat(),
                  "sourceRoot": str(source), "head": head, "dirty": bool(status.strip()),
                  "dirtyTrackedPaths": status.splitlines(), "rootPackages": list(ROOT_PACKAGES),
                  "distributions": distributions, "files": captured,
                  "note": "Exact captured bytes, including selected uncommitted changes, are identified by per-file hashes; HEAD alone is not their identity. Private model/media are excluded from Git source and package wheels."}
    write_json(VENDOR / "PROVENANCE.json", provenance)
    return provenance


def verify_capture() -> dict:
    provenance = json.loads((VENDOR / "PROVENANCE.json").read_text(encoding="utf-8"))
    for item in provenance["files"]:
        path = (ROOT / item["path"]).resolve(strict=True)
        if VENDOR not in path.parents or digest(path) != item["sha256"]:
            raise ValueError("Captured source drift; refresh requires a reviewed new source capture")
    return provenance


def copy_asset(source: Path, target: Path, expected: str) -> None:
    if target.exists():
        if digest(target) != expected:
            raise ValueError("Existing private asset has drifted")
        return
    if digest(source) != expected:
        raise ValueError("Asset digest does not match admitted profile")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    if digest(target) != expected:
        raise ValueError("Copied asset digest mismatch")


def environment_python(directory: Path) -> Path:
    return directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def build_install(provenance: dict, python: Path) -> Path:
    if sys.version_info[:2] != (3, 13):
        raise ValueError("Run this local profile setup using Python 3.13")
    build_env = PRIVATE / "build-env313"
    run_env = PRIVATE / "venv313"
    wheels = PRIVATE / "wheels"
    wheels.mkdir(parents=True, exist_ok=True)
    if not environment_python(build_env).exists():
        execute([str(python), "-I", "-m", "venv", str(build_env)])
    build_python = environment_python(build_env)
    execute([str(build_python), "-I", "-m", "pip", "install", "--disable-pip-version-check",
             "build==1.2.2.post1", "hatchling==1.27.0"])
    for distribution in provenance["distributions"]:
        execute([str(build_python), "-I", "-m", "build", "--wheel", "--no-isolation",
                 "--outdir", str(wheels), str(ROOT / distribution["path"])])
    third_party = sorted({dependency for distribution in provenance["distributions"]
                          for dependency in distribution["dependencies"]
                          if not dependency.startswith("veyviz-")})
    wheel_lock = PRIVATE / "wheels.lock.json"
    if wheel_lock.exists():
        lock = json.loads(wheel_lock.read_text(encoding="utf-8"))
        for item in lock["thirdParty"]:
            if digest(wheels / item["name"]) != item["sha256"]:
                raise ValueError("Locked third-party wheel drift")
    else:
        execute([str(build_python), "-I", "-m", "pip", "download", "--disable-pip-version-check",
                 "--only-binary=:all:", "--dest", str(wheels), *third_party])
        lock = {"schema": "veyviz.wheel-lock.v1", "requirements": third_party,
                "thirdParty": [{"name": path.name, "sha256": digest(path)}
                               for path in sorted(wheels.glob("*.whl")) if not path.name.startswith("veyviz_")]}
        write_json(wheel_lock, lock)
    if not environment_python(run_env).exists():
        execute([str(python), "-I", "-m", "venv", str(run_env)])
    runtime_python = environment_python(run_env)
    execute([str(runtime_python), "-I", "-m", "pip", "install", "--disable-pip-version-check",
             "--no-index", "--find-links", str(wheels),
             *[f"{item['name']}=={item['version']}" for item in provenance["distributions"]]])
    execute([str(runtime_python), "-I", "-m", "pip", "check"])
    return runtime_python


def installed_inventory(python: Path) -> tuple[list[dict], dict]:
    script = r'''
import importlib.metadata as m,json,pathlib,sys
files=set(); versions={}
for distribution in m.distributions():
    versions[distribution.metadata['Name']]=distribution.version
    for entry in distribution.files or []:
        path=pathlib.Path(distribution.locate_file(entry)).resolve()
        if path.is_file() and path.suffix not in ('.pyc','.pyo'):
            files.add(str(path))
base=pathlib.Path(sys.base_prefix)
core={str(path.resolve()) for directory in (base/'Lib',base/'DLLs') if directory.exists()
      for path in directory.rglob('*') if path.is_file() and '__pycache__' not in path.parts
      and 'site-packages' not in path.parts and path.suffix not in ('.pyc','.pyo')}
for path in [pathlib.Path(sys.executable),base/'python.exe',base/f'python{sys.version_info.major}{sys.version_info.minor}.dll',base/'python3.dll',base/'vcruntime140.dll',base/'vcruntime140_1.dll',pathlib.Path(sys.prefix)/'pyvenv.cfg']:
    if path.is_file():core.add(str(path.resolve()))
print(json.dumps({'files':sorted(files),'core':sorted(core),'versions':versions}))
'''
    result = json.loads(subprocess.check_output([str(python), "-I", "-c", script], text=True))
    records = [file_record(Path(path), "installed") for path in result["files"]]
    known = {item["path"] for item in records}
    records += [file_record(Path(path), "interpreter") for path in result["core"] if path not in known]
    return records, result["versions"]


def publish(provenance: dict, runtime_python: Path) -> None:
    records, versions = installed_inventory(runtime_python)
    records += [file_record(ROOT / item["path"], "source") for item in provenance["files"]]
    records += [file_record(path, "wheel") for path in sorted((PRIVATE / "wheels").glob("*.whl"))]
    records += [file_record(path, "runner") for path in sorted(Path(__file__).parent.glob("*"))
                if path.is_file() and path.suffix in (".py", ".md")]
    records += [file_record(VENDOR / "PROVENANCE.json", "source"),
                file_record(PRIVATE / "wheels.lock.json", "wheel")]
    if len(records) > 20000:
        raise ValueError("Inventory file bound exceeded")
    inventory = {"schema": "veyviz.recorded-inventory.v1", "createdAt": datetime.now(timezone.utc).isoformat(),
                 "source": {"head": provenance["head"], "dirty": provenance["dirty"],
                            "provenancePath": str(VENDOR / "PROVENANCE.json")},
                 "files": sorted(records, key=lambda item: item["path"]), "versions": versions}
    write_json(INVENTORY, inventory)
    write_json(PROFILE, {"schema": "veyviz.recorded-profile.v1", "profileId": "rfdetr-small-cpu-v1",
                        "fixtureId": "mivia-vid0062", "modelPath": str(PRIVATE / "assets/rfdetr-small.onnx"),
                        "recordingPath": str(PRIVATE / "assets/vid0062.mp4"), "modelSha256": MODEL_SHA,
                        "recordingSha256": RECORDING_SHA, "pythonExecutable": str(runtime_python),
                        "runnerPath": str(Path(__file__).with_name("runner.py")),
                        "inventoryPath": str(INVENTORY)})


def verify() -> dict:
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    if inventory.get("schema") != "veyviz.recorded-inventory.v1" or not 1 <= len(inventory["files"]) <= 20000:
        raise ValueError("Invalid companion inventory")
    for item in inventory["files"]:
        path = Path(item["path"])
        if not path.is_absolute() or path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError("Companion file drift; rebuild explicitly after reviewing changes")
    for path_key, hash_key in (("modelPath", "modelSha256"), ("recordingPath", "recordingSha256")):
        if digest(Path(profile[path_key])) != profile[hash_key]:
            raise ValueError("Private asset drift")
    verify_capture()
    return {"status": "VERIFIED", "profile": str(PROFILE), "files": len(inventory["files"]),
            "modelSha256": profile["modelSha256"], "recordingSha256": profile["recordingSha256"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-source", type=Path)
    parser.add_argument("--assets-from", type=Path, help="Read-only source checkout holding admitted local assets")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--rebuild", action="store_true", help="Explicitly rebuild captured source and publish a reviewed new runner/installed inventory")
    args = parser.parse_args()
    if args.verify or PROFILE.exists() and not args.rebuild:
        print(json.dumps(verify()))
        return
    PRIVATE.mkdir(parents=True, exist_ok=True)
    provenance = capture(args.capture_source) if args.capture_source else verify_capture()
    asset_source = args.assets_from or args.capture_source
    if asset_source:
        copy_asset(asset_source / "models/rfdetr-small.onnx", PRIVATE / "assets/rfdetr-small.onnx", MODEL_SHA)
        copy_asset(asset_source / "local-test/mivia-labelled/train/vid0062.mp4", PRIVATE / "assets/vid0062.mp4", RECORDING_SHA)
    for name, expected in (("rfdetr-small.onnx", MODEL_SHA), ("vid0062.mp4", RECORDING_SHA)):
        if digest(PRIVATE / "assets" / name) != expected:
            raise ValueError("Admitted private asset required")
    runtime_python = build_install(provenance, Path(sys.executable))
    publish(provenance, runtime_python)
    print(json.dumps(verify()))


if __name__ == "__main__":
    main()
