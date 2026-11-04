import { defineConfig } from 'vitest/config';

// The live tier (test/live): the framework drivers on a real model against the dev platform. One file at a time and
// a retry, since a real model may not call the tool on the first ask. Needs its variables (test/live/live.ts).
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    globalSetup: ['test/frameworks/build.ts'],
    environment: 'node',
    fileParallelism: false,
    retry: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['verbose'],
  },
});
