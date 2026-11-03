import { defineConfig } from 'vitest/config';

// The framework tests (test/frameworks): every adapter in its real framework, against the scripted model and the
// fake connector (test/harness). Their frameworks live in test/frameworks/package.json, so `npm test` stays fast
// and installs nothing heavy; run `npm ci` in test/frameworks, then `npm run test:frameworks`.
export default defineConfig({
  test: {
    include: ['test/frameworks/**/*.test.ts'],
    globalSetup: ['test/frameworks/build.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
