# Local recorded-video AI companion

This product-owned runner uses captured, freshly built Veyviz source packages to decode an admitted recording and execute the pinned RF-DETR small CPU model. Quadbridge owns permissions, jobs and accepted results. Python returns a proposal over inherited pipes only. Its three sampled frames demonstrate actual model execution, not live-camera or detection-accuracy qualification; uncommissioned coverage and occupancy stay unknown.

The first setup reads the original source and copies only the transitive selected package source plus two digest-verified assets. It does not copy credentials, old environments, databases or the legacy application. `vendor/veyviz-ai/PROVENANCE.json` records source HEAD, selected current bytes, package versions and dirty source state. Model/media remain in ignored `.local/veyviz-ai/assets` and are not redistributed in wheels. Model source provenance is retained from the upstream source lock; publication/licensing review is a separate gate.

From the new product root, use the already installed, permitted Python 3.13:

```powershell
& 'C:/Users/Lenovo/AppData/Roaming/uv/python/cpython-3.13.7-windows-x86_64-none/python.exe' -I services/veyviz-ai/setup.py --capture-source 'D:/Veyviz-code/veyviz-ai-cctv-product-integration-review'
```

Subsequent setup calls without capture verify existing state and reuse it. They refuse drift instead of re-baselining it. `--rebuild` explicitly rebuilds the frozen source and republishes the runner/installed inventory after reviewed companion changes. Captured source itself cannot be silently replaced; a new capture requires a separately reviewed provenance change. A build environment holds build tools; the isolated runtime environment installs fresh package wheels from a local wheelhouse with pinned third-party hashes. Later runtime use has no import dependency on the original repository.

```powershell
& '.local/veyviz-ai/venv313/Scripts/python.exe' -I services/veyviz-ai/setup.py --verify
& '.local/veyviz-ai/venv313/Scripts/python.exe' -I services/veyviz-ai/test_runner.py --profile "$((Get-Location).Path)/.local/veyviz-ai/profile.json" -v
```

The runner receives one strict JSON request line on stdin, followed optionally by a matching cancellation line. It emits exactly one bounded JSON result after closure. Diagnostics go to stderr without private paths. After the request, cancellation reads use Python 3.13's nonblocking pipe mode, so a Windows CRT stdin lock cannot prevent native child startup while the parent keeps the channel open. Native decode and ONNX are supervised with bounded operation deadlines, owned process handles and actual close confirmation. Cancellation waits for the current bounded native operation and drains owners. Failure never becomes a successful result; uncertain native cleanup is explicitly false. No PID file or forceful termination of an unrelated process is used.

`profile.json` follows `contracts/veyviz-product-ai/v1/README.md`. `inventory.json` uses `veyviz.recorded-inventory.v1` with `createdAt`, `source` (`head`, `dirty`, `provenancePath`), `versions`, and `files`. Each file has an absolute `path`, `sha256`, byte length `bytes`, and `kind` (`runner`, `source`, `wheel`, `installed`, `interpreter`). The inventory includes the runner, copied source, built/resolved wheels, installed distribution files excluding mutable bytecode, interpreter executable and base standard-library files. Assets are hashed separately through the profile. This is a local integrity inventory, not a signature or adversarial supply-chain attestation. The parent also verifies the profile and inventory before dispatch.

Real tests save `.local/veyviz-ai/evidence/real-three-sample.json` only after successful inference and cleanup. Unit tests cover protocol bounds, missing/unknown keys, duplicate/nonfinite JSON and cancellation identity. Installed tests verify imports resolve inside the private environment. Real cancellation tests start both native owners before requesting cancellation and require observed closure. A skipped real test remains unqualified.
