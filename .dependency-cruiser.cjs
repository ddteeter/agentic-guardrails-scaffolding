const { resolve } = require('node:path');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies within the module graph.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-test-from-src',
      severity: 'error',
      comment: 'Production src must not import test/spec/fixture modules.',
      from: {
        path: '^guardrails-core/src',
        pathNot: '\\.(test|spec)\\.ts$',
      },
      to: {
        path: '(\\.(test|spec)\\.ts$|/test/)',
      },
    },
    {
      name: 'exec-seam',
      severity: 'error',
      comment:
        'Only src/exec.ts may import node:child_process (the injected Exec seam every shell-out routes through).',
      from: {
        path: '^guardrails-core/src',
        pathNot: '^guardrails-core/src/exec\\.ts$',
      },
      to: {
        path: '^(node:)?child_process$',
        dependencyTypes: ['core'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Must be an ABSOLUTE path here, not the relative 'guardrails-core/tsconfig.json'
    // it looks like it should be. With a relative fileName, TypeScript's own
    // config-extends resolution (typescript.js's getExtendsConfigPathOrArray ->
    // directoryOfCombinedPath) combines the relative configFileName with the
    // already-absolute basePath dependency-cruiser computes, doubling the
    // "guardrails-core" path segment and making the resolved "extends":
    // "../tsconfig.base.json" land one directory short (at
    // guardrails-core/tsconfig.base.json instead of the real repo-root
    // tsconfig.base.json) -> TS5083/TS18003 and depcruise exits 1 with 0
    // modules cruised, before any forbidden-rule ever runs. An absolute
    // fileName short-circuits that join (TypeScript's getNormalizedAbsolutePath
    // uses an already-rooted path as-is), so the extends chain resolves
    // correctly. Verified against dependency-cruiser 18.1.0 + typescript 5.9.3.
    tsConfig: { fileName: resolve(__dirname, 'guardrails-core/tsconfig.json') },
    tsPreCompilationDeps: true,
  },
};
