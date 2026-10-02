# Generated product mobile shell

This is an isolated Capacitor dependency template. `tools/mobile/assemble.mjs` copies it beside one fixed, source-derived product bundle and writes a local `capacitor.config.json` with `webDir: "www"`. It is not a root npm workspace and the platform build does not install Android or iOS SDKs.

From a generated product directory:

```text
npm ci
npm run android:add
npm run android:sync
```

The installed project serves the bundled files in `www/`. The generated config has no remote `server.url` or live-reload address. The first packaged screen says **Connection not configured** and performs no sign-in or API request. Do not add a localhost fallback or copy a developer session into the app. Phone authentication and the HTTPS API profile require a separately reviewed adapter and deployment target.

`npm run ios:add` and `npm run ios:sync` create an iOS project when run on an appropriate build host. Creating a project is not device, signing, distribution, or production qualification.
