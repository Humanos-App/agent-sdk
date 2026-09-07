import { defineConfig } from 'vitest/config';

// The SDK's OWN tests. Until 2026-09-08 its coverage lived in agent2 (the test agent), which meant
// a package whose correctness depended on a consumer's suite — the same defect the tsconfig note
// records for typechecking. The pure unit specs moved here; agent2 keeps the integration runs
// against the mini-platform. sdk-v03 is imported as SOURCE (see package.json "//boundary").
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
});
