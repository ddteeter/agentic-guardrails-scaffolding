import { defineConfig } from 'tsup';

// Ships pure-Node ESM with .mjs extension so a target repo's hooks can invoke
// the CLI with a single cross-platform `node`/`guardrails` command — no bash,
// no loader. Entries are added here as modules are built (TDD).
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node24',
  // Declarations come from `tsc -p tsconfig.build.json` in the `build` script,
  // not from here: tsup's dts pass cannot parse TypeScript 6, and 8.5.1 is the
  // latest release. Emitting one .d.ts per module rather than a bundle.
  dts: false,
  clean: true,
  sourcemap: true,
  shims: false,
});
