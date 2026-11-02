import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every gate a test runs takes the mutation lock (`machineLock`), and its
    // default is a file in the developer's home directory. A test must never
    // touch -- or queue behind -- the real machine-wide lock.
    env: {
      GUARDRAILS_GATE_LOCK: path.join(tmpdir(), 'guardrails-test-gate.lock'),
    },
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
