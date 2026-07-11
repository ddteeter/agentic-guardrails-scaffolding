import { defineConfig } from 'tsup';

// Ships pure-Node ESM with .mjs extension so a target repo's hooks can invoke
// the CLI with a single cross-platform `node`/`guardrails` command — no bash,
// no loader. Entries are added here as modules are built (TDD).
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node24',
  dts: true,
  clean: true,
  sourcemap: true,
  shims: false,
});
