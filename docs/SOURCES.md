# Source basis and new work

## Supplied source

Veyviz Platform Architecture Authority v1.6, supplied in this conversation, is copied unchanged in `reference/Veyviz_Authority_v1.6.md`. Relevant sections: §4 (non-CCTV products do not inherit CCTV concepts), §5.2 (small neutral foundation), §7 (owner boundaries), §18.14 (structurally different proof consumers), §19.1 (compatibility), and §25 (avoid mandatory infrastructure).

The user's subsequent platform-first clarification and approval define this deliverable's expanded purpose. The new module ABI, names, reference domains, local implementation, product definitions, tests and code are newly authored here; they are not reported as extracted or already deployed Veyviz components. Prior source correction bundles are left unchanged.

## Technical documentation consulted

- Node.js v22.16.0 SQLite API: https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html — actual local-profile API, synchronous operations and experimental status.
- Node HTTP API: https://nodejs.org/api/http.html — underlying HTTP server implementation.
- React createRoot: https://react.dev/reference/react-dom/client/createRoot — consumer renderer integration boundary; no React execution claim.
- Nest dynamic modules: https://docs.nestjs.com/fundamentals/dynamic-modules — future host integration reference, not an implemented adapter in this package.

These sources support implementation mechanisms. They do not establish product performance or production qualification. A registry network request was unavailable; development dependencies were installed from the existing permitted local npm cache. No blocked browser policy was bypassed.
