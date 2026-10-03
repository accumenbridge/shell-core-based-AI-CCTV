# Veyviz local video review

This independent repository combines Quadbridge's real product runtime with selected Veyviz video-decoding and RF-DETR CPU packages. The selected profile is a local recorded-video review application. It does not qualify continuous live CCTV or production deployment.

## Start locally

Run from this repository in PowerShell with Node 24.19 and the permitted Python 3.13 runtime:

```powershell
npm ci
npm run build
& 'C:/Users/Lenovo/AppData/Roaming/uv/python/cpython-3.13.7-windows-x86_64-none/python.exe' -I services/veyviz-ai/setup.py --verify
npm run veyviz
```

The launcher prints the loopback URL and the path to a private generated credentials file. Read that file locally and sign in as `admin`. It does not print passwords. `viewer` has read access to tenant `alpha`; `admin` can operate in `alpha` and `beta`. These are explicit local developer identities. Existing stores are never reseeded.

In Recordings, add the admitted MIVIA sample to your library. In Video analysis, open New analysis, choose the recording and start analysis. The workspace selects the new request and shows its actual processing state. When it completes, inspect the central frame and choose samples from the strip or previous/next controls. Findings and saved review decisions stay beside the frame; detailed model provenance is available in the Analysis engine disclosure below. This is sampled-frame inspection, not full video playback. The configured RF-DETR model runs on the CPU; its boxes and confidence are model observations. A zero detector count does not prove an empty site. Research footage remains uncommissioned and occupancy stays unknown.

Ctrl+C requests graceful shutdown and waits for owned work to close. Restarting the same generation retains sources, jobs, results and reviews. A different product or companion fingerprint selects a separate data generation and leaves previous generations on disk. Incomplete enrollment or a missing access owner requires explicit repair; the launcher will not reconstruct grants against retained business data.

Stop the developer instance before rebuilding this checkout. The development launcher loads the selected build from this repository; use a separately exported product root when you need runtime files isolated from checkout changes. An export still needs the separately verified local Python companion for inference.

The first companion setup has already captured the selected original sources and private assets on this machine. For another local checkout, use the setup procedure in [the companion guide](../../services/veyviz-ai/README.md). Model/media are private ignored assets, not part of the Git repository. Their licensing and redistribution require a separate review before publication. Runtime imports do not depend on the original Veyviz checkout.

## Verify the application

```powershell
npm run veyviz:verify
npm run veyviz:e2e
npm test
& '.local/veyviz-ai/venv313/Scripts/python.exe' -I services/veyviz-ai/test_runner.py --profile "$((Get-Location).Path)/.local/veyviz-ai/profile.json" -v
```

The HTTP end-to-end check creates a private test generation, performs actual inference, verifies authority/idempotency boundaries, persists and reviews a result, restarts and cancels another job. It writes actual results under `.local/e2e`. Browser execution is a separate check; HTTP checks do not claim browser coverage. See [STATUS.md](STATUS.md) for the current results, failures and remaining gates.

## Product structure and extension

| Location | Responsibility |
|---|---|
| `modules/veyviz-sources` | Authorized recording references and source versions |
| `modules/veyviz-analysis` | Original commands, queued jobs, accepted results and review UI |
| `modules/veyviz-rfdetr` | Verified local AI adapter and read-only provenance contribution |
| `products/veyviz-review` | Full review composition |
| `products/veyviz-catalog` | Source-only composition, without inference selection |
| `solutions/veyviz` | Explicit public-port and UI-slot bindings |
| `services/veyviz-ai` | Fixed Python setup, protocol runner and installed tests |
| `vendor/veyviz-ai` | Selected, traceable source capture used to build fresh wheels |
| `tools/veyviz-*.mjs` | Product enrollment, lifecycle, input inventories and end-to-end verification |

Run the second product with `npm run veyviz -- --product veyviz-catalog --port 4481`. Products select trusted modules at build time; user/tenant grants independently control their use. A new capability should own its data and public contract in a new module, then be selected through a product and explicitly bound through a solution. Reviewed UI contributions use the framework's existing slots. No maintained host changes are required for these two products.

This is extensibility through reviewed source composition. Arbitrary downloaded plugins, hot installation, an OpenAI MCP adapter, hosted identity, live cameras, uploads and production operations are not implemented by this local profile.

The [architecture](ARCHITECTURE.md), [acceptance criteria](ACCEPTANCE.md) and [provenance](PROVENANCE.md) explain the design. The generated `.brain/atlas/PROJECT_ATLAS.html` is the read-only project map; `.brain/CURRENT.md` is the canonical execution checkpoint.

