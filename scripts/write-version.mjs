// Writes src/version.ts from package.json, before every build, type check and test run. The release workflow sets the
// version from the tag on its runner only (`npm version`), then builds: this is how that version reaches the client
// (`clientInfo.version`) with no second number in the code to keep in step. The file is generated and git-ignored.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(
  new URL('../src/version.ts', import.meta.url),
  `/** Generated from package.json by scripts/write-version.mjs: never edit, never commit. */\nexport const SDK_VERSION = '${version}';\n`,
);
