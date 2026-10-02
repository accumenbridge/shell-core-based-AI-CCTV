# Generated mobile app shell

The mobile shell is a client presentation for products already composed by this platform. It reuses the maintained session, tenant, permission, and workspace controller; the mobile package contributes responsive phone navigation and visibility lifecycle handling. Workspace links and the selected module UI still come from the product's resolved plan.

## Same-origin preview

Install the pinned repository toolchain and rebuild before launching a preview:

```bash
npm ci
npm run build
npm run demo -- --product service-desk --mobile-preview --port 4350
```

The preview uses the existing local HTTP listener, login cookie, grants, tenant checks, and API. It adds no listener, proxy, credential, grant, or authentication mode. `--mobile-preview` is available only for the web role. The normal desktop shell remains the default. The preview is for local development and does not imply a hosted or production mobile profile.

## Client-only package

Build a current release and assemble the selected product:

```bash
npm run build
npm run mobile:assemble -- --product service-desk
```

The command writes an immutable candidate under `.local/mobile-001/generated/<product>/<candidate>/`. `mobile-manifest.json` identifies the exact plan, checked client closure, builder inputs, pinned template inputs, output file digests, and toolchain. Re-running the same candidate verifies and reuses the inventory; changed inputs produce a separate candidate. The generated `www/` tree contains only the bundled selected browser UI, declared public assets/styles, and fixed app entry. Capacitor core, CLI, Android, and iOS template dependencies are pinned at 8.5.2 in the isolated generated package. It is outside the root npm workspace.

The native template points at the bundled local `www` directory and has no remote server URL. It intentionally displays **Connection not configured** and performs no sign-in or API request. Identity, HTTPS API profile, native secure storage, device verification, signing, native SDK builds, and device tests are later work. A generated scaffold is not an Android/iOS binary or deployment qualification.

## Scope and verification

The bundler starts from the selected product's reviewed frontend closure and rejects imports outside it. Server implementations, owner stores, worker and solution code, local runtime configuration, and credentials are not client inputs. Runtime export manifests include the compiled mobile preview assets under `.artifacts/<product>/m`; JavaScript, CSS, and asset references use a shared deterministic compact map so the exact files stay within the managed snapshot path bound. Exported runtimes serve those hashed files from the fixed snapshot.

Build success and portable shell/assembly tests verify source and artifact behavior. They do not establish real phone rendering, browser keyboard/safe-area behavior, native lifecycle behavior, native SDK availability, or production security. Record those observations separately when the corresponding environment and identity/API profile exist.
