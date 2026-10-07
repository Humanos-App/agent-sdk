#!/bin/sh
# Maintainer script — works only inside the via-protocol checkout, where ../sdk-v03 exists.
# Rebuilds the protocol SDK, repacks it into vendor/, and reinstalls so the lockfile matches.
set -e
cd "$(dirname "$0")/.."
[ -d ../sdk-v03 ] || { echo "../sdk-v03 not found: run this from the via-protocol checkout" >&2; exit 1; }
(cd ../sdk-v03 && npm run build && npm pack --pack-destination ../agent-sdk/vendor)
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund
npm ci --no-audit --no-fund
npm test
