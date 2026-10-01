# Building a product with this framework

## A normal new product

Run the factory's `create-module` and `create-product` commands in the root README. Generated files belong to the product/module. The shell and hosts remain shared package dependencies. `npm run build` generates static registrations from reviewed local manifests; no runtime file discovery occurs from customer input.

The module generator implements a real scoped item table, migration, GET, idempotent POST and UI. It does not decide your domain: replace the sample business behavior, add invariants/retention, and write acceptance tests before shipping it.

## A module's actual entry point

```ts
export function register(env: ModuleEnvironment): HostedModule {
  // Construct only this owner's repository and supported ports.
  return { manifest: env.manifest, services, routes, close };
}
```

Routes must match the manifest's method/path/permission/kind. Unknown routes, duplicate contributions, host-auth route collisions and missing declared implementations fail startup/build. A typed manifest requirement is not an IAM grant.

Do not start tenant business work in `register()`. Registration sets up repositories and handlers. A public operation or admitted worker starts scope-specific work.

## Backend operations

Use module-specific input parsing. The helper `object()` rejects unknown fields, but it is not a replacement for domain validation. Keep conditional updates and invariants under the owner. Use the receipt/transaction helper only where its semantics fit. Do not return an ORM entity merely because the example uses a small matching DTO.

Do not await inside `SqliteOwner.transaction()` or its command callback. Obtain external results before the transaction, then check current applicability while committing. Another module's database handle is never a public integration API.

## Public capability and solution adapter

Declare the provided/required contract in `module.json`. A product binds the consumer to an exact implementation/instance. Local eager bindings add startup dependencies automatically and must be acyclic; HTTP bindings retain a remote provider. Its selected solution contributes the actual typed translation, currently illustrated by `solutions/knowledge-to-desk/wiring.mjs`.

A new capability needs a real adapter. The resolver does not pretend that matching strings generate its behavior. Put a new adapter in product/solution-owned code, not a giant switch in `packages/backend-host`.

## Scope and identity

`RequestContext` is created after authentication and supplies tenant, product/instance and actor. `assertAllowed` is rechecked at consequential operations. A tenant header is only a selector. Reference rows have compound tenant/record identity.

For cross-product calls, use an explicit product/instance/tenant map and a destination-authorized service identity. The configured identity is validated against the actual destination and checked again at mutation. New reference Handoffs use `desk.requests.create.v2` with an explicit committed receipt. Do not accept an HTTP 202 job ID as a committed record. Original receipt retrieval is a separate operation and permission. Source-user identity is not a forwarded grant. Dedicated service permissions and immutable request IDs make retries explicit. Do not hard-code production endpoints or credentials in a module.

## UI contribution

```ts
export const workspace: Workspace = {
  mount(ctx) {
    // Build content inside ctx.root using your renderer.
    // Reads and subscriptions use ctx.signal.
    return () => { /* dispose this view's resources */ };
  }
};
```

Each declared workspace names its actual export, for example `workspace` or `overviewWorkspace`. The shell loads that exact export from the statically selected module and validates `mount`. Several workspaces can coexist in one module; they need distinct paths/IDs and correct permissions.

The supported native-ESM profile follows relative static imports and literal `import('./ui/detail.js')`. Declare non-code browser assets in `module.json`, for example `"browserAssets": ["ui/detail.css", "ui/icon.svg"]`; files are copied from the module's `src/` tree. Literal `new URL('./icon.svg', import.meta.url)` is supported for tracked assets. CSS dependency files must exist in the declared/copied tree. Do not use Node libraries, arbitrary dynamic import strings or undeclared browser packages. A different third-party bundler/React build profile is not implemented by this scanner.

The module is statically known; code loads only when the selected workspace is mounted. Generic host API calls are restricted to that contribution's declared own-module operations. Additional public capabilities must receive a deliberate host adapter, not an unrestricted `fetch` object.

A workspace context and its API are bound to one accepted scope. After abort, do not submit new calls; late results and notices cannot update another generation. Requested tenant selection is not an accepted scope.

Do not mutate another workspace's state. Do not equate unmount with cancelling a durable server job. Add separate backend cancellation only when its operation semantics require it.

## React integration

```tsx
import { createRoot } from 'react-dom/client';
import { reactWorkspace } from '@quadbridge/web-shell/react-adapter';
export const workspace = reactWorkspace(createRoot, ctx => <YourWorkspace context={ctx} />);
```

This is a consumer integration example. Install/build the consumer's real React packages using its toolchain. The neutral foundation does not bundle a React version. The provided port-lifecycle checks are not React runtime proof.

## Worker handler

Worker registrations use `JobExecutionStore` from the neutral contracts package. The host does not import SQLite. Implement `claim`, `renew`, `assertCurrent`, `finish` and `fail`, retaining the adapter-owned atomic completion relationship. These calls may be async; the local reference adapter stays synchronous. The independent memory adapter under `tests/fixtures` is ephemeral conformance code, not a replacement production database.

Prepare expensive work outside the transaction. Return a short `commit()` callback that applies its owner-local result. The worker verifies its current lease and authority before that callback. Use stable identities for external effects that may occur before commit; never claim a database transaction can undo a remote operation. The handler receives a current job/attempt check; invoke it immediately before an external dispatch and durably mark uncertainty. Record received external facts separately before a source business completion that may be refused. Read-only reconciliation must not submit another effect.

The reference scheduler rotates modules and tenant partitions with bounded advancing eligibility scans. This prevents the reviewed starvation but does not preempt a long-running handler or guarantee latency under arbitrary load.

The reference index is bounded text processing. Long native tasks require a supported execution adapter with physical resource admission and confirmed cleanup; the generic worker's lease alone is insufficient.

## Reference HTTP operations

All requests use the local identity profile. Domain requests require `X-QB-Tenant`; writes require `Idempotency-Key`, JSON content and same-origin cookies or an approved service bearer identity.

| Operation | Contract |
|---|---|
| POST `/api/session` | `{username,password}` → local session cookie |
| GET `/api/bootstrap` | permitted scope, modules, workspaces and exposed operations |
| POST `/api/modules/mode` | `{moduleId,mode}`; requires platform module-management grant |
| GET/POST `/api/requests` | list or create Service Desk request |
| POST `/api/requests/close` | `{id,expectedVersion}` |
| GET/POST `/api/documents` | list metadata or submit `{title,body}` with an indexing job |
| GET `/api/documents/search?q=...` | scoped indexed results; not an exhaustive-world search |
| POST `/api/documents/cancel-index` | `{documentId}`; reports actual job cancellation state |
| GET/POST `/api/handoffs` | list or request `{documentId,reason}`; acceptance, job and source state remain separate |
| POST `/api/requests/commit` | v2 create → validated COMMITTED receipt; requires `desk.create` |
| GET `/api/requests/receipt?commandId=...` | lookup original actor-scoped receipt; requires `desk.receipts.read`; never creates |
| POST `/api/handoffs/reconcile` | `{id}`; requires `handoff.reconcile`; look up existing dispatch and adopt under owner authority |

## Release adoption

Edit maintained source, rebuild, review the product plan and test applicable consumers. An exported directory is an immutable candidate artifact. Do not edit its shared package source and call that a framework upgrade. Published-package distribution, multiple supported release families and production rollout remain separate work.

## Legacy integration warning

Do not retarget an old pending v1 handoff to v2. See `UPGRADE_FROM_0_1.md`. A protocol-compatible field shape is not proof of identical deduplication or completion meaning. Existing grants remain unchanged until explicitly migrated.
