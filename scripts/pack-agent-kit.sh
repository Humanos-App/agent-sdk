#!/bin/sh
# Maintainer script — works only inside the via-protocol checkout, where ../agent-kit exists.
# Packs this SDK and the vendored protocol SDK into agent-kit/vendor/, then regenerates the kit's
# lockfile from the NEW tarballs (a reused lockfile keeps the old integrity hashes and a fresh
# clone fails with EINTEGRITY — agent-kit b59705b) and proves it with `npm ci` and the kit's tests.
# Bump this package's version when its content changes, and point agent-kit at the new tarball.
set -e
cd "$(dirname "$0")/.."
[ -d ../agent-kit ] || { echo "../agent-kit not found: run this from the via-protocol checkout" >&2; exit 1; }
cp vendor/humanos-via-sdk-v03-*.tgz ../agent-kit/vendor/
npm pack --pack-destination ../agent-kit/vendor
cd ../agent-kit
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund
npm ci --no-audit --no-fund
npm test
