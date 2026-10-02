# Quadbridge Product Studio — integration 1

**The same visual design, now connected to a real local product-building workflow.**
This complete project includes Foundation 0.2 source and compiled output, the dynamic visual Studio,
reviewed developer-profile setup, an opt-in local builder, and regression tests.
It is a local developer release, not a production deployment system.

Version values belong to different layers: the repository package remains `0.2.0`, the full Studio
program is described as `0.3`, modules and products carry their own exact three-part versions, and
`quadbridge.module.v1` is the module ABI. Operation contract suffixes, entity/family/UI schema tags,
and exported-artifact formats are separate compatibility identities; changing one does not imply
another changed.

## Open it

Double-click **OPEN_PLATFORM.html** for the self-contained offline explorer. Its examples are sample-only.
It can validate and export definitions, but it cannot write source or start processes.

For the **full local Product Studio console**—including paired Products, Builds, Artifacts, and Runtime views—extract to a new directory and use the repository's Node 24.19.0 baseline from `.nvmrc`:

```text
npm ci
npm run setup
npm run build
npm run studio:full
```

On Windows, double-click **START_FULL_STUDIO.cmd**; it builds and starts the same full console.
Open the address printed in the terminal (default `http://127.0.0.1:4480`), click **Connect local Studio**,
and enter the printed pairing code. `npm run studio` and **START_STUDIO.cmd** remain the legacy standalone
Studio launcher; use the full-console entry above for the complete product-building and managed-runtime workflow.
The Windows launchers are supplied; the execution note in the historical Studio record refers to an
earlier Linux/Node 22.16.0 run. See the current local qualification record separately; a launcher file
or workflow definition alone is not evidence of Windows execution.

## Create and run a product

In the paired Studio, **Products → New composition starter** creates an editable starting point only.
Review the complete ProductDefinition JSON, preview its exact source-derived plan, then explicitly save
the immutable `id@version`. Choose a new version for changed content. The saved version can then be
compiled, registered, promoted and explicitly started from the corresponding local views.

Install the pinned development tools before building source:

```text
npm ci
```

Builds run fixed local build/export commands. There is no automatic package installation, arbitrary command
field, customer credential editor or production deployment action. A successful build is not a passed
workflow. The application still needs its ordinary login and permissions.

A running managed application uses an exported immutable snapshot. Rebuilding source does not change its
served files. Stopping and restarting the same instance and artifact retains local records. A different
artifact receives a separate data directory; migration/adoption of previous data is not automatic. The
standalone `npm run demo` launcher is a separate legacy path that prints its generated developer passwords.
The paired Runtime view stores its generated credentials privately under `.local/platform-runtime-data/`
and does not return them through Studio responses or print them in the terminal.

## Preview and package a product for mobile

The local mobile preview uses the same-origin runtime, login cookie, tenant scope, permissions, and selected workspace UI:

```bash
npm run build
npm run demo -- --product service-desk --mobile-preview --port 4350
```

To generate a client-only Capacitor scaffold from a built product snapshot:

```bash
npm run mobile:assemble -- --product service-desk
```

The generated candidate is stored under `.local/mobile-001/generated/`. It uses a local bundled `www` directory and shows **Connection not configured** without contacting a server. Mobile identity/API setup and native build or device qualification are later work. See [`docs/MOBILE_APP_SHELL.md`](docs/MOBILE_APP_SHELL.md) for the exact scope and checks.

## Register and promote a verified local build

The paired operator can register a successful verified build by its exact snapshot digest, inspect its
bounded file inventory, download files as attachments, and promote that artifact once for a product
version. The registry stores immutable local metadata and never starts the application. Deployment remains
request-only; registration does not qualify a runtime, provider, hosted release, or production deployment.

On Windows, physical publication requires the ignored machine-local
`.local/platform-build-host.json` profile. Its JSON fields are `schema` (`quadbridge.local-build-host.v1`),
`kind` (`powershell7-file-host`), `path`, `sha256`, `version`, and `policy`. Set `path` to the selected
PowerShell 7 executable, `sha256` to that executable's SHA-256, `version` to its reported version, and
`policy` to `RemoteSigned` as confirmed by the normal preflight. The host runs the reviewed fixed helper
with ordinary `-File`; do not change execution policy or add a fallback. If the host or helper is missing,
the paired console and verified-artifact reads/promotions remain available while new physical publication
is unavailable.

Registry bounds are 8 MiB per file, 64 MiB per artifact, 4096 files, 2 MiB per manifest, 128 MiB staging,
512 MiB total registry material, 256 object directories, and a separate scan ceiling of 16384 entries,
depth 32, directory buffers of 32, and a 2000 ms monotonic metadata budget. Uncertain publication remains
reserved for explicit recovery; restart or process age does not prove ownership ended. Artifact downloads
are reverified and sent as `application/octet-stream` attachments with `nosniff` and `no-store`.

## Add a new module

The developer supplies reviewed source; the visual Studio does not invent business logic.

```text
npm run factory -- create-module checklist
npm run build
```

Refresh the Studio catalogue. Checklist appears without editing the Studio's JavaScript. Select it with
other supported modules and choose a new product ID. The example generator creates a scoped item list,
not a finished checklist business domain. Review/update the lockfile after changing the workspace set.

## Generate a bounded record module

For a simple tenant-scoped record with fixed fields, the source builder accepts a reviewed JSON spec and
writes a new, ordinary module owner and workspace. It refuses an existing module directory; generated
source must be reviewed and versioned like any other module.

```text
npm run factory -- generate-entity examples/entities/asset-register.json
npm run factory -- create-product maintenance-assets --modules asset-register --version 1.0.0
npm run build
```

The spec supports bounded text, integer, boolean and enum fields, defaults, a module-owned SQLite table,
fixed list/get/create/edit operations and matching routes, plus a list/detail/create/edit workspace.
Run `npm ci` and `npm run build` before either source generator: generation uses the compiled canonical
composition and Studio validators as a preflight and does not install or build implicitly. Module and
product source identities use two to 48 lowercase letters/digits/hyphens beginning with a letter.
Commands carry stable receipts, and edits require the version that was read. Optional booleans and
enums have a “Not set” choice; absent no-default values stay omitted, while explicit `false` remains
distinct. Generated Studio metadata describes the generated owner and declares requirements; it does
not grant access or assert that deployment resources are running. See
[`docs/ENTITY_BUILDER.md`](docs/ENTITY_BUILDER.md) for limits and the independent Room Inspection example.
This does not generate relations, approvals, attachments, schema upgrades/data migrations or a universal business model.

The bounded clean-install acceptance driver is separate from routine tests. It creates two temporary
source copies, generates the examples, explicitly reconciles the temporary lockfile, then verifies a
fresh `npm ci` and build from source without inherited `node_modules`, compiled output or artifacts:

```text
node tools/construction-clean-install.mjs
```

It uses the current ordinary npm configuration and retains private logs and source roots if a step fails.
It does not alter the repository lockfile or install dependencies during generation.

A terminal-only path uses the same catalogue and resolver:

```text
npm run factory -- create-product facility --modules checklist,handoff
npm run build
npm run demo -- --product facility --port 4350
```

To use an offline-exported definition:

```text
npm run factory -- import-product ./facility.product.json
npm run build
npm run demo -- --product facility --port 4350
```

## What is corrected

**Custom products:** the reviewed local service seed is selected by the provided contract, not names such
as `combined`. Existing access stores are reused without reseeding missing identities or widening grants.

**Dynamic catalogue:** modules/products/versions/workspaces come from the source manifests. Presentation
labels have fallbacks. There is no second hand-written allowed-module list. Browser and CLI drafting call
the same compiled pure composition code.

**Connections:** the composer explains required modules and local/connected choices from reviewed solution
metadata. Unknown ports need a real approved adapter; strings do not generate its behavior. The managed
Studio launcher supports **local bindings only**. Connected definitions can be validated/exported/built,
but require the reviewed CLI configuration and an independently running destination. The included
`npm run demo` still runs the four reference products including their connected example.

**Real operations:** Handoff has a permitted document picker, visible prerequisite checks, readable
outcomes and expandable technical details. Missing destination authority blocks a new submission; an
existing committed receipt is not erased. The user and destination owners remain authoritative.

## Verification and boundaries

```text
npm run verify          # full source build + all automated tests
npm run test:compiled   # compiled framework subset; no compilation
npm run test:studio-browser
```

Read **evidence/last_run.json**, **evidence/studio-journey.json** and **evidence/VALIDATION.md** for actual
execution and exclusions. Browser tests are not marked passed when navigation is blocked. No existing
Veyviz code, tenant, camera, model, migration or production environment is modified by this project.

The pinned portable CI runs `npm ci` and `npm test` on Ubuntu. `npm test` performs a fresh build and
runs every test file one at a time; each test retains its own in-file concurrency. A separate manual
Windows workflow runs the same suite only after the selected PowerShell 7 executable passes the normal
`-File` build-host preflight. An unsupported policy is reported as `BLOCKED_HOST_PROFILE`; CI never
changes execution policy or treats that host as qualified. The portable workflow reports Windows native
coverage as `NOT_QUALIFIED`, and workflow configuration alone is not evidence of a hosted pass. See
[docs/CI.md](docs/CI.md) for the bounded summary and workflow details.

Current guide: [docs/STUDIO_INTEGRATION.md](docs/STUDIO_INTEGRATION.md).
Original 0.1-to-0.2 compatibility cautions remain in [docs/UPGRADE_FROM_0_1.md](docs/UPGRADE_FROM_0_1.md).
Do not overlay this folder onto active source or reuse old application data without deliberate review.

## Product Studio 0.3 full-platform kernel

The repository now contains an additional whole-platform construction surface around the original 0.2 runtime/composition core.

```bash
npm run build
npm run studio:full
```

Open `http://127.0.0.1:4480`.

The new Studio separates the major construction layers—UI, backend, AI, data, build, environments and deployments—while retaining the original resolver/runtime as the authority for executable product composition.

See [`IMPLEMENTATION_STATUS_0.3.md`](IMPLEMENTATION_STATUS_0.3.md), [`FULL_PLATFORM_BUILD_MAP.md`](FULL_PLATFORM_BUILD_MAP.md), and [`docs/STATUS.md`](docs/STATUS.md) for the current source map and implemented/pending boundaries. The retained local journeys cover bounded Entity source generation, source-derived product families, richer static UI contributions, and the mobile same-origin client shell; none implies native mobile, production deployment or cross-artifact data migration. Accepted scoped evidence is indexed in the local `.brain/evidence/` records for [Capability](.brain/evidence/capability-result.md), [Family](.brain/evidence/family-result.md), [UI contributions](.brain/evidence/ui-slots-result.md), and [Entity generation](.brain/evidence/entity-builder-result.md).

The paired local console supports a bounded **Products → preview → save → Builds → compile/export → Artifacts → register → inspect/download → promote local release** journey. Builds use an immutable saved version, a frozen reviewed source copy, the pinned local compiler toolchain and the fixed factory recipe. Successful exports are checked against the admitted plan and a complete private inventory before the result is recorded. Registration copies that exact verified snapshot into a local immutable registry; file downloads remain attachments and never execute in the operator origin. Promotion records an immutable local product-version release. Registry publication itself does not launch the application or qualify deployment.

The **Products** editor treats the complete ProductDefinition as its source of truth. Import a bounded
`product.json`, load an exact saved version, or start from the reviewed composition helper; then edit
description, identity, version, layout, exact module references, bindings and wiring. A read-only preview
derives the plan and graph from current manifests and reviewed solutions. Unsupported declarations stay
visible with diagnostics and cannot be saved or built. Save confirmation is tied to the exact `id@version`;
equal content is idempotent, changed content at that version conflicts, and a new version is explicit.
Export preserves the validated definition. The standalone offline editor uses the same pure helpers and
file import/download only; it cannot save to source, call the network, build or start an application.

The separate **Runtime** view can start the exact promoted product version on the selected local Windows profile. It runs the registered snapshot under a fixed native process-tree supervisor, with one durable local runtime slot, separate retained data and private local credentials. The web process starts first; a separate worker starts only when the verified plan requires it. Both roles receive an empty seed list; canonical local access enrollment happens once, before role launch, and later starts reuse the bound data without reseeding. Stop and restart require explicit confirmation. A runtime becomes `STOPPED` only after the owned process tree reports empty, the helper closes and owned execution files are verified clean. If any of those facts is unavailable, the runtime remains `UNKNOWN`, its slot and data stay reserved, and the operator does not recover processes by saved PID. Incomplete enrollment is repair-required. Every derived Windows path must remain below 240 characters; the registered snapshot plus fixed helper/log overhead must fit the 128 MiB runtime execution-area limit. This is a local developer runtime, not a deployment or production service.

For a positively stopped instance, the Runtime view can create and verify a private local backup, then restore it only to that same instance when its data directory is wholly absent. Backups cover the bound enrollment files and owner SQLite databases, including committed WAL data, and are checked against the immutable runtime identity and migration history. Restore never reseeds users or grants. After restoration, restart remains an explicit action. Recovery metadata is available through the paired console; database bytes, credentials and private paths are not exposed as downloads.

Knowledge also offers an explicitly local **Ask from indexed documents** workflow. It searches only the signed-in tenant's indexed, ready documents, returns exact source excerpts with version and range citations, and labels its deterministic extractive result **Local extractive answer**. It does not invoke a model. Requests are bounded to 1000 question characters, five records, 16 KiB of source excerpts, 8 KiB of answer text, a five-second provider deadline and four actual concurrent calls. Cancelling or losing the original application session suppresses the answer; cancelled provider work keeps its capacity reservation until it actually settles. Handoff continues to consume the unchanged document-read contract. Exported package closure now follows the selected package manifests, including the actual local ai-core version, and immutable older snapshots retain their captured package inventory.

On Windows, physical artifact publication requires the selected private PowerShell 7 build-host profile and the pinned fixed publisher. Registry metadata, verification, retrieval and local promotion remain available when that publisher profile is unavailable. The registry enforces per-file, per-artifact, file-count, staging, total-storage, object-directory and bounded metadata-scan limits; the Artifacts view reports current capacity and unresolved operation history. Published objects are retained, and an interrupted or uncertain publication keeps its reservation until positively reconciled.

On Windows, the build executor is enabled only when the private, ignored `.local/platform-build-host.json` profile is present and passes its pinned executable/version/policy checks. Create the profile for an already installed PowerShell 7 host; the normal `RemoteSigned` policy and all higher-precedence scopes must pass the checked preflight. From the repository root, inspect the selected executable with `Get-Command pwsh.exe`, run `& <selected-executable> -NoLogo -NoProfile -NonInteractive -File tools/build-host-preflight.ps1`, and obtain its SHA-256 with `Get-FileHash -LiteralPath <selected-executable> -Algorithm SHA256`. Use the exact executable path, hash, and version reported by those checks:

```json
{
  "schema": "quadbridge.local-build-host.v1",
  "kind": "powershell7-file-host",
  "path": "C:/path/to/the/selected/pwsh.exe",
  "sha256": "<64 lowercase hexadecimal characters from Get-FileHash>",
  "version": "7.x.y",
  "policy": "RemoteSigned"
}
```

The placeholders must be replaced with the values from the actual host before the profile is usable. Do not change execution policy to make a host pass. Without a supported Windows profile or pinned toolchain, the paired console remains available and build requests return an unavailable response. The restricted Windows PowerShell 5.1 host remains unsupported. POSIX builds use the local Node process runner and do not read this Windows profile.
