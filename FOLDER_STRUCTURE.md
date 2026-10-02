# Quadbridge Product Studio — historical Foundation 0.2 / Studio integration 1 tree

Studio integration 1 extends Foundation 0.2. Compiled runtime files are included separately under dist/ and .artifacts/. Repository package, Studio program, module/product, ABI, operation, schema and artifact versions are separate dimensions; see [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md).

The long inventory below is retained as that historical tree snapshot; it is not a complete current
file listing. The current source map is: `apps/control-plane` owns the paired local operator and
runtime/recovery APIs; `apps/studio-web` owns the paired console; `apps/runtime` composes product
owners; `packages/contracts`, `composition`, `backend-host`, `web-shell` and the other `packages/*`
provide neutral mechanisms; `modules/*` own their domain data and migrations; `products/*` select
exact module versions and bindings; `tools/factory.mjs`, `tools/entity-builder.mjs` and the source
preflight/link helpers generate or validate inert source; `tools/mobile/assemble.mjs` creates the
client-only mobile shell. Product-family drafting and static UI contribution contracts live in
`packages/composition` and `packages/contracts`, with their renderers under `apps/studio-web` and
`packages/web-shell`. See the current [build map](FULL_PLATFORM_BUILD_MAP.md) and
[implementation status](IMPLEMENTATION_STATUS_0.3.md) for current boundaries.

```text
.gitignore
.nvmrc
AGENTS.md
CODEX_START.md
DOCUMENTATION.html
FOLDER_STRUCTURE.md
OPEN_PLATFORM.html
PLATFORM_ARCHITECTURE.md
README.md
START_APPS.cmd
START_APPS.sh
START_STUDIO.cmd
apps/runtime/package.json
apps/runtime/src/index.ts
apps/runtime/src/main.ts
apps/runtime/tsconfig.json
docs/DECISIONS.md
docs/DEVELOPER_GUIDE.md
docs/REMEDIATION.md
docs/SECURITY_AND_LIFECYCLE.md
docs/SOURCES.md
docs/STATUS.md
docs/STUDIO_INTEGRATION.md
docs/UPGRADE_FROM_0_1.md
docs/VEYVIZ_ADOPTION.md
docs/VISUAL_EDITION.md
docs/diagrams/construction.mmd
docs/diagrams/cross-product.mmd
docs/diagrams/job-lifecycle.mmd
docs/diagrams/neutrality.mmd
modules/handoff/module.json
modules/handoff/package.json
modules/handoff/src/index.ts
modules/handoff/src/ui.ts
modules/handoff/tsconfig.json
modules/knowledge/module.json
modules/knowledge/package.json
modules/knowledge/src/index.ts
modules/knowledge/src/ui.ts
modules/knowledge/tsconfig.json
modules/service-desk/module.json
modules/service-desk/package.json
modules/service-desk/src/index.ts
modules/service-desk/src/ui/overview.css
modules/service-desk/src/ui/overview.ts
modules/service-desk/src/ui.ts
modules/service-desk/tsconfig.json
package-lock.json
package.json
packages/backend-host/package.json
packages/backend-host/src/http.ts
packages/backend-host/src/index.ts
packages/backend-host/tsconfig.json
packages/composition/package.json
packages/composition/src/index.ts
packages/composition/src/studio.ts
packages/composition/tsconfig.json
packages/connections/package.json
packages/connections/src/index.ts
packages/connections/tsconfig.json
packages/contracts/package.json
packages/contracts/src/index.ts
packages/contracts/tsconfig.json
packages/local-access/package.json
packages/local-access/src/index.ts
packages/local-access/tsconfig.json
packages/sqlite/package.json
packages/sqlite/src/index.ts
packages/sqlite/tsconfig.json
packages/web-shell/package.json
packages/web-shell/src/dom.ts
packages/web-shell/src/index.ts
packages/web-shell/src/react-adapter.ts
packages/web-shell/src/shell.css
packages/web-shell/tsconfig.json
packages/worker-host/package.json
packages/worker-host/src/index.ts
packages/worker-host/tsconfig.json
products/combined/product.json
products/knowledge/product.json
products/neutral/product.json
products/service-desk/product.json
profiles/local-developer.json
solutions/knowledge-to-desk/solution.json
solutions/knowledge-to-desk/wiring.mjs
start-studio.sh
templates/module-backend.ts.txt
templates/module-ui.ts.txt
tests/adapter-replacement.test.mjs
tests/composition.test.mjs
tests/data-worker.test.mjs
tests/factory-lifecycle.test.mjs
tests/fixtures/memory-execution-store.ts
tests/frontend-assembly.test.mjs
tests/hardening.test.mjs
tests/helpers.mjs
tests/http-cross-product.test.mjs
tests/shell-regressions.test.mjs
tests/studio-integration.test.mjs
tests/support/shell-harness.mjs
tests/visual-edition.test.mjs
tools/browser_test.py
tools/build-visual.mjs
tools/build.mjs
tools/demo.mjs
tools/factory.mjs
tools/format.mjs
tools/frontend-closure.mjs
tools/link-workspaces.mjs
tools/local-profile.mjs
tools/product-source.mjs
tools/studio-browser-test.py
tools/studio-catalogue.mjs
tools/studio-manager.mjs
tools/studio.mjs
tools/verify-checksums.mjs
tools/verify.mjs
tools/version-isolation.mjs
tools/visual-browser-test.py
tsconfig.base.json
tsconfig.json
visual/data.json
visual/studio.css
visual/studio.js
```

Local data, paired sessions, generated credentials and operator snapshots are created only under .local/ at run time. They are not part of the archive.
