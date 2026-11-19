#!/usr/bin/env node
/**
 * A release installs `@humanos-ai/via-sdk` from npm at an exact version. While the v0.4 SDK is unpublished, the `v04`
 * branch installs it from a local file (`file:../.local-packages/…`), which exists on one machine. This refuses to
 * publish, or to pass a release check, with anything but an exact npm version.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pinned = pkg.dependencies?.["@humanos-ai/via-sdk"];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(pinned))) {
  console.error(`✗ @humanos-ai/via-sdk is ${JSON.stringify(pinned)}: a release pins an exact version from npm.`);
  console.error("  Publish the via-sdk it was built against, pin that version, and run this again.");
  process.exit(1);
}
console.log(`✓ @humanos-ai/via-sdk pinned to ${pinned}`);
