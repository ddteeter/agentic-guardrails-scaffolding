/**
 * Are the drift guards running inside this repository's OWN mutation run?
 *
 * The guards in this directory are live probes of third-party tooling: they
 * spawn real knip, load the real ESLint flat config, run real stryker. That is
 * the whole point of them — a schema or a banner or a runner integration cannot
 * be pinned by a fixture, only by asking the installed tool.
 *
 * It is also what makes them unrunnable inside a mutation run. Stryker copies
 * the project into `.stryker-tmp/sandbox-*` and drives the suite from worker
 * processes, and heavyweight tooling does not survive that nesting:
 *
 * - ESLint 10 + typescript-eslint's project service use worker threads, and
 *   loading `eslint.config.js` inside a stryker worker dies with
 *   `Cannot destructure property 'mod' of 'threads.workerData'`.
 * - `stryker-runner.test.ts` spawns a nested stryker + vitest, and a vitest
 *   inside a vitest inside a sandbox does not start.
 *
 * Either failure aborts stryker's dry run with "There were failed tests in the
 * initial test run", which the gate then reports as `analyzer-failed` — a
 * broken mutation gate, caused by tests that have nothing to say about mutants.
 *
 * Standing down here costs nothing. These guards assert facts about upstream
 * tools, not about any mutant in `guardrails-core/src`, so they have no verdict
 * to contribute. They still run in `npm test`, in CI, and at every gate rung
 * that runs the suite — which is every rung.
 *
 * Detected from the caller's own location rather than `globalThis.__stryker__`:
 * the namespace is planted by a setup file whose load order relative to a
 * module-scope read is not guaranteed, while the sandbox path is in
 * `import.meta.url` from the moment the module is evaluated.
 */
import path from 'node:path';

export function isUnderMutationRun(moduleDirectory: string): boolean {
  return moduleDirectory.includes(`${path.sep}.stryker-tmp${path.sep}`);
}
