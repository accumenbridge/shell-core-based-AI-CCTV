#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node tools/link-workspaces.mjs
exec node tools/demo.mjs
