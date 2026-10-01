#!/usr/bin/env sh
set -eu
npm run build
node apps/control-plane/dist/main.js
