import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'guardrails-core/test/**/*.test.ts',
      'guardrails-core/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['guardrails-core/src/**/*.ts'],
    },
  },
});
