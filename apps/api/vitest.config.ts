import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
