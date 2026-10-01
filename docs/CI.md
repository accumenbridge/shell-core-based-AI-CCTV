# Kernel CI

The supported CI baseline is Node 24.19.0, pinned in `.nvmrc`. `npm ci` installs the lockfile, and
`npm test` builds the maintained source before running every `tests/*.test.mjs` file with test-file
concurrency set to one. Test concurrency inside a file is unchanged. `npm run verify` uses the same
serial file schedule.

`.github/workflows/kernel-ci.yml` runs the portable baseline on Ubuntu for pushes and pull requests.
Windows-native coverage is explicitly `NOT_QUALIFIED` in that job; its summary lists named skipped tests.

`.github/workflows/kernel-native.yml` is a manual Windows qualification workflow. It selects the first
`pwsh.exe` from the runner's normal command search, hashes that executable, and invokes
`tools/build-host-preflight.ps1` with ordinary `-NoLogo -NoProfile -NonInteractive -File` arguments.
The existing profile rules remain in force: effective and LocalMachine policy must be `RemoteSigned`,
and MachinePolicy, UserPolicy, Process and CurrentUser must be `Undefined`. The workflow creates the
ignored `.local/platform-build-host.json` only after that check passes. If not, it emits
`BLOCKED_HOST_PROFILE` and fails before the suite. There is no policy override, alternate shell host,
fallback profile or automatically failing Windows job on each pull request.

Both workflows upload `.local/ci-host-preflight.json` when present, `.local/ci-test-summary.json`, and
the extracted Node test TAP report from the runner's temporary directory. The summary contains the commit SHA,
TAP digest, runner platform/architecture, Node version, TAP counts, skipped test names, and failed
test names when present. Application-owned output remains subject to the existing redaction in the test
and build owners. The local PowerShell executable path and private build-host profile are never uploaded.
CI definitions are not a hosted run result or a production qualification.
