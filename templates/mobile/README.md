# Generated product mobile app

This isolated Capacitor project contains one source-derived product bundle and the fixed local native API profile. The generated `www/` directory is bundled locally; the config has no remote `server.url` or live-reload address. Capacitor core, Android, iOS and CLI are pinned to 8.5.2, and `@capacitor/app` is pinned to 8.1.1.

For an independently assembled product candidate, install the captured lockfile, add and sync the platform, then apply the checked local qualification overlay:

```text
npm ci
npm run android:add
npm run android:sync
npm run android:prepare
```

The same managed-runtime workflow uses Studio's confirmed Android-client action and the repository commands `npm run local:android:build -- --client managed-mobile-<20-hex-reference>` and `npm run local:android:install -- --client managed-mobile-<20-hex-reference>`. These commands bind the client to the captured instance and generation, use a private immutable project copy, and target the already selected local Android device. For manual development of a separate candidate, the generated app uses fixed origin `http://127.0.0.1:4350`; for an emulator, forward that port with `adb reverse tcp:4350 tcp:4350`. Do not configure another host, remote URL or fallback authentication path.

The registered Android `NativeSession` plugin uses a non-exportable Android Keystore AES key and AES-GCM ciphertext under the app's `noBackupFilesDir`. UI logout calls the ordinary API and clears the encrypted token. Capacitor bridge logging is disabled. The local debug API is intended for emulator port forwarding, not public network exposure or production deployment.

The staged Android instrumentation test exercises the actual WebView, native session bridge, tenant and workspace flow, and writes private stage results only inside the app's sandbox. A source build does not establish an installed-device pass; use the candidate-specific USABILITY-CORE-001 evidence record for qualification. The iOS Keychain source is included, but a built or tested iOS app requires macOS.
