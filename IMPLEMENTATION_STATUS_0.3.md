# Quadbridge Product Studio 0.3 — implementation status

This release is the first executable **whole-platform kernel** around the existing 0.2 Product Studio. It does not replace the tested composition/runtime core.

## What is implemented now

### 1. Studio UI
`apps/studio-web`

A new browser console shows the platform as one system rather than a module picker only. It has views for:

- Overview
- Products
- Modules
- UI
- Backend
- AI
- Data
- Builds
- Environments
- Deployments
- Operations

Run it with `npm run studio:full` after `npm run build` and open `http://127.0.0.1:4480`.

### 2. Control plane backend
`apps/control-plane` + `packages/control-plane`

Implemented control-plane state:

- product/version records
- build records
- environments
- deployment records
- AI pipeline definitions
- audit records

The local control plane uses SQLite. This is a real persistence layer, not browser sample state.

The full Studio operator is a paired, loopback-only local developer console. Startup imports the
maintained product catalogue and AI pipeline once; repeated reads do not write state. Product and
AI versions are immutable. Product preview and save use the canonical composition resolver. A
durable local worker can compile a saved version, assemble a private local export, verify its
release and complete inventory, and expose the verified result or bounded cancellation state.
Builds run only with the machine-specific ignored `.local/platform-build-host.json` profile
(`quadbridge.local-build-host.v1`) and the pinned compiler toolchain. If that profile or toolchain
is missing or unsupported, the paired console remains available and build admission reports the
executor as unavailable. Deployment requests remain admission-only; no deployment controller is
attached. The terminal pairing code, expiring local session, Host/Origin checks, bounded JSON requests
and explicit mutation confirmation protect the local console; they are not a production identity or
authorization service.

The **Artifacts** view registers an exact verified build snapshot into a retained local filesystem
registry, re-verifies the complete bounded inventory for inspection/download, and promotes the
matching immutable product version as a local release record. Downloads use opaque selectors and
`application/octet-stream` attachment headers with `nosniff`; exported HTML and JavaScript do not
run in the operator origin. Physical publication uses one reviewed no-overwrite helper and the
selected private Windows PowerShell 7 profile. Registry reads and release records remain usable
without that publisher. The local release record does not start a runtime, sign an artifact,
configure a deployment, or prove production acceptance.

The separate **Runtime** view starts an exact promoted local release. It copies the verified registry
snapshot into a private execution area, prepares one-time canonical local access enrollment, and starts
the web/backend role before a separate worker when the resolved plan requires one. Both role configs
have empty principal seeds. Restart reuses the same bound data without reseeding. The fixed Windows
PowerShell 7 helper owns the native process tree; `STOPPED` requires nonce-bound empty-tree proof,
matching helper close and verified execution cleanup. Uncertain ownership retains the durable runtime
slot and files as `UNKNOWN`, with no PID-based recovery. Runtime credentials stay in the private
`.local/platform-runtime-data/` directory. These controls are for local development, not remote hosting,
provider calls, deployment or production operation. Every derived Windows path must remain below 240
characters; the registered snapshot plus fixed helper/log overhead has a 128 MiB execution-area limit.

For a positively stopped instance, the paired Runtime view also supports a private same-instance backup,
verification and restore to a wholly absent canonical data root. Backup captures committed SQLite WAL
contents and verifies owner identity and migration history. Restore preserves existing enrollment,
principal and grant state without reseeding; restarting the restored instance is a separate confirmed
operation. This is local recovery, not remote backup retention or production disaster recovery.

### 3. Module SDK
`packages/module-sdk`

A module can now describe one vertical slice containing UI, backend, AI, data and deployment requirements without creating a second plugin catalogue.

`defineModule()` retains the existing `quadbridge.module.v1` ABI and validates the richer Studio metadata.

### 4. Full module contribution model
`packages/studio-model`

A module may declare:

- UI routes and extension points
- backend services, events and jobs
- AI pipelines, model capabilities and tools
- relational/object/vector/graph/cache/timeseries stores
- schemas
- processes
- CPU/memory/GPU/NPU requirements
- secrets and ports

Existing `knowledge`, `service-desk`, and `handoff` manifests now carry this metadata.

### 5. AI composition kernel
`packages/ai-core`

Implemented:

- AI pipeline schema
- DAG validation
- cycle rejection
- deterministic execution stages
- required model capability calculation
- required permission calculation
- pipeline digest
- cloud/edge model candidate routing
- placement and data-class policy fields

A `knowledge-rag` pipeline is seeded into the local control plane as an example of how the Knowledge module can declare AI requirements.

This is the **AI orchestration contract/planner**. It is not yet an LLM/VLM inference server.

Knowledge 0.2.1 now has a separate local document-answer path. Knowledge owns tenant-scoped FTS retrieval, bounded exact excerpts, body digests and citation checks; neutral ai-core supplies generic evidence chunks, a bounded executor and a local extractive selector. The UI labels this **Local extractive answer** and reports indexed-only coverage. It performs no model inference and does not use or replace the legacy `knowledge-rag` planning pipeline. The request boundary caps question length, records, excerpt bytes, answer text, provider time and actual concurrent calls; cancellation and original-session loss suppress late answers.

### 6. Existing construction/runtime kernel retained
The existing system is still authoritative for:

- product composition
- dependency resolution
- bindings
- frontend closure
- backend catalogue generation
- immutable release digests
- module runtime
- worker runtime
- local access control
- cross-product connections
- SQLite module ownership and job queues

Factory package copying and release verification now share a manifest-derived selected-workspace closure, including the exact `@quadbridge/ai-core` version when Knowledge is selected. The closure does not introduce package downloads or alter the captured dependency inventory of older immutable snapshots.

## What is NOT finished yet

These are next implementation layers, not hidden behind the UI:

1. Production Postgres control-plane adapter.
2. S3/MinIO content-addressed artifact registry.
3. Signed artifact supply-chain verification and remote object-storage registry.
4. Deployment controller and runtime agents for cloud and edge targets.
5. Kubernetes/ECS/Nomad/systemd/container drivers.
6. Secret manager integration.
7. OIDC/SAML organisation authentication and production RBAC administration.
8. Central logs, metrics and traces.
9. Real model-serving adapters (OpenAI/local vLLM/Ollama/Triton/OpenVINO/ONNX etc.).
10. Vector DB and graph DB adapters selected per product/module.
11. Visual drag/drop UI composition editor.
12. Visual backend/event workflow editor.
13. Visual AI-pipeline editor.
14. Schema/data migration visualisation and compatibility workflow.
15. Signed module and artifact supply chain.
16. Remote module registry and controlled installation lifecycle.
17. Production release promotion, health gates and automatic rollback.

## Current end-to-end shape

```text
Studio Web
    |
    v
Studio Control Plane
    |---------------- Module SDK / manifests
    |---------------- AI pipeline planner
    |---------------- Product/version state
    |---------------- Build/environment/deployment state
    |
    v
Existing Product Composer
    |
    v
Product Definition + Composition Plan
    |
    v
Existing Build / Frontend Closure
    |
    v
Existing Runtime + Workers + Connections
```

## Validation

Validation counts are recorded with the current source fingerprint in `.brain/evidence/` after the
full repository checks complete. Earlier Foundation and visual-edition counts above describe their
historical runs and are not current whole-platform acceptance evidence.

## Commands

```bash
npm install
npm run build
npm test
npm run studio:full
```

Windows:

```bat
START_FULL_STUDIO.cmd
```

Linux/macOS:

```bash
./START_FULL_STUDIO.sh
```

## Bounded source construction

The entity generator and `create-module` emit ordinary inspectable source. They share the platform's
2–48 character lowercase source-directory identity predicate, scan declared workspace package names,
and run new module manifests through the existing composition and Studio validators before creating
the output directory. Run `npm ci` and `npm run build` first; generation itself does not install
dependencies or mutate the lockfile. Generated optional booleans/enums retain a distinct “Not set”
state, and generated Studio metadata records the UI/backend/data/process declarations actually emitted.
Those declarations do not grant permissions or establish runtime readiness.

`node tools/construction-clean-install.mjs` is a separate source-copy acceptance recipe, not an
automatic part of either generator. It exercises generated workspaces, explicit temporary lockfile
reconciliation and a second clean install/build. The source has independent version identities:
repository package `0.2.0`, Studio program `0.3` (`studio-web` `0.3.0`), exact module/product SemVer,
`quadbridge.module.v1` ABI, operation contract versions, and entity/family/UI/local-snapshot schema
tags. No one value implies compatibility of the others. The entity profile remains a bounded record
starter without relationships, schema upgrades or cross-artifact data adoption.
