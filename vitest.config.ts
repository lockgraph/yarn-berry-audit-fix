import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/ts/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './target/coverage',
      reporter: ['text', 'lcov'],
      include: ['src/main/**/*.ts'],
      reportOnFailure: true,
    },
  },
});
