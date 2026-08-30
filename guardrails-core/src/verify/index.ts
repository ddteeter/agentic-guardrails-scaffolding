/**
 * The verify orchestrator (§2.2). Determines the TypeScript files a turn
 * touched, dispatches the adapters, and aggregates their output into one
 * normalized `Violation[]`. Pure Node; every shell-out goes through the
 * injected `Exec`, and tool binaries are resolved through `resolveBin` so the
 * CLI can point at the repo-local `node_modules/.bin`.
 *
 * Every analyzer declares a `scope` (see `ANALYZERS`); run-trigger and
 * check-extent are independent axes:
 *
 * - **`changed-files`** — runs only when the turn touched >=1 TS file. **ESLint**
 *   is genuinely diff-scoped: it receives the file list and lints only those.
 *   **`tsc` is changed-files-_triggered_ but whole-project-_checked_**
 *   (`-p tsconfig`), because TypeScript checking is inherently cross-file — a
 *   change in one file can surface an error in another.
 * - **`whole-project`** — runs whenever the rung is active, regardless of which
 *   files changed. knip and dependency-cruiser are whole-graph, and a
 *   dependency-only change (e.g. a `package.json` bump) still needs their
 *   hygiene checks.
 *
 * A consequence of the whole-project checks: `verify` assumes a clean baseline.
 * If the branch already has pre-existing `tsc` / knip / dependency-cruiser
 * errors, every turn will escalate on them until they're fixed (see README —
 * run `guardrails verify` clean before relying on the gate).
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import type { Exec } from '../exec.js';
import type { Violation } from '../violation.js';
import { loadWorkspaceResolver, withPackages } from '../workspaces.js';
import { parseDepcruiseJson } from './depcruise-adapter.js';
import { parseEslintJson } from './eslint-adapter.js';
import { isTestFile, isTypeScriptFile, mergeChangedFiles } from './git.js';
import { parseKnipJson } from './knip-adapter.js';
import { parseStrykerJson } from './stryker-adapter.js';
import { parseTscOutput } from './tsc-adapter.js';

export interface VerifyOptions {
  repoRoot: string;
  baseBranch: string;
  exec: Exec;
  packageId?: string;
  tsconfig?: string;
  resolveBin?: (tool: string) => string;
  /** Cadence rung. Heavy whole-graph analyzers (knip, dependency-cruiser) run
   *  only at commit/ci; the per-turn stop gate stays fast. Defaults to 'stop'. */
  profile?: 'stop' | 'commit' | 'ci';
  /** File reader seam (stryker writes its JSON report to disk, not stdout).
   *  Defaults to node:fs/promises readFile; injected in tests. */
  readFile?: (filePath: string) => Promise<string>;
}

export interface VerifyResult {
  violations: Violation[];
}

async function changedTypeScriptFiles(
  options: VerifyOptions,
): Promise<string[]> {
  const { exec, repoRoot, baseBranch } = options;
  const tracked = await exec(
    'git',
    ['diff', '--name-only', '--diff-filter=ACM', baseBranch],
    { cwd: repoRoot },
  );
  const untracked = await exec(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: repoRoot },
  );
  return mergeChangedFiles(tracked.stdout, untracked.stdout).filter((file) =>
    isTypeScriptFile(file),
  );
}

/** knip is whole-graph (not diff-scoped) and seconds-scale, so it runs only at
 *  the commit/ci rungs — never on the per-turn stop gate — but independent of
 *  whether any `.ts` file changed (a dependency-only change, e.g. a
 *  `package.json` bump, still needs the dependency-hygiene checks). It
 *  assumes a knip-clean baseline, like tsc (see this file's header). */
async function runKnip(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const knip = await exec(resolveBin('knip'), ['--reporter', 'json'], {
    cwd: repoRoot,
  });
  return parseKnipJson(knip.stdout, repoRoot, packageId);
}

/** dependency-cruiser is whole-graph (not diff-scoped); like knip it runs at
 *  the commit/ci rungs only, independent of whether any `.ts` file changed. It
 *  assumes a dependency-cruiser-clean baseline, like tsc/knip. */
async function runDepcruise(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  // Config-agnostic and layout-generic, exactly as runKnip: no `--config` (DC
  // auto-detects the consumer repo's own `.dependency-cruiser.{cjs,js,json}` /
  // `package.json#dependency-cruiser`) and no hardcoded target (cruise `.` from
  // repoRoot; the consumer's config `forbidden[].from/to` matchers + `exclude`/
  // `doNotFollow` do the scoping). A repo-specific target here would silently
  // break — a consumer repo has no `guardrails-core/src` directory.
  const result = await exec(
    resolveBin('depcruise'),
    ['--output-type', 'json', '.'],
    { cwd: repoRoot },
  );
  return parseDepcruiseJson(result.stdout, repoRoot, packageId);
}

async function runEslint(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const eslint = await exec(
    resolveBin('eslint'),
    ['--format', 'json', '--no-warn-ignored', ...files],
    { cwd: repoRoot },
  );
  return parseEslintJson(eslint.stdout, repoRoot, packageId);
}

/** `tsc` is changed-files-TRIGGERED but whole-project-CHECKED: it takes no file
 *  list (`-p tsconfig`), so a change in one file can surface an error in
 *  another. It assumes a clean type-check baseline (see this file's header). */
async function runTsc(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const tsconfig = options.tsconfig ?? 'tsconfig.json';
  const tsc = await exec(
    resolveBin('tsc'),
    ['--noEmit', '--pretty', 'false', '-p', tsconfig],
    { cwd: repoRoot },
  );
  return parseTscOutput(tsc.stdout, repoRoot, packageId);
}

/** stryker is diff-scoped (changed production files) and CI/commit-only (mutation
 *  testing reruns the suite per mutant). Consumer-generic: no `--configFile` (stryker
 *  auto-detects the consumer's stryker.conf.json), the `--mutate` list is the
 *  consumer's own changed files. Forces `--reporters json` and reads stryker's default
 *  report path (reports/mutation/mutation.json). A missing/failed report yields [] —
 *  a stryker crash must not falsely block the gate. */
async function runStryker(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const production = files.filter(
    (file) => isTypeScriptFile(file) && !isTestFile(file),
  );
  if (production.length === 0) {
    return [];
  }
  const { exec, repoRoot, packageId } = options;
  const readFile =
    options.readFile ?? ((filePath) => fsReadFile(filePath, 'utf8'));

  await exec(
    resolveBin('stryker'),
    [
      'run',
      '--incremental',
      '--reporters',
      'json',
      '--mutate',
      production.join(','),
    ],
    { cwd: repoRoot },
  );

  // Equivalent mutants: emptying either block leaves `report` undefined, and
  // parseStrykerJson's own JSON.parse guard then returns [] — the same result.
  // A range directive is required: `disable next-line` only attaches to a
  // statement-LEADING comment, which a `} catch {` line does not have.
  // Stryker disable BlockStatement
  let report: string;
  try {
    report = await readFile(
      path.join(repoRoot, 'reports', 'mutation', 'mutation.json'),
    );
  } catch {
    return [];
  }
  // Stryker restore BlockStatement
  return parseStrykerJson(report, production, packageId);
}

type Rung = NonNullable<VerifyOptions['profile']>;
const RUNG_ORDER: Record<Rung, number> = { stop: 0, commit: 1, ci: 2 };

type Scope = 'whole-project' | 'changed-files';

interface Analyzer {
  tool: string;
  /** npm package providing the binary — named in the missing-analyzer message
   *  and kept in sync with peerDependencies by a test. */
  provider: string;
  minRung: Rung;
  /** Run-trigger: 'changed-files' runs only when the turn changed >=1 TS file
   *  (and receives the list); 'whole-project' runs whenever the rung is active. */
  scope: Scope;
  run: (
    options: VerifyOptions,
    resolveBin: (tool: string) => string,
    files: string[],
  ) => Promise<Violation[]>;
}

/** The full analyzer registry, each entry gated by a minimum cadence rung and a
 *  run-trigger scope. Entries run serially in listed order, and that order is
 *  the order violations appear in the aggregated result. Adding an analyzer is
 *  a table entry plus its runner — no branching in `runVerify`.
 *
 *  Still open (deferred once more, now with a measurement in hand): running the
 *  commit-rung entries in parallel under a measured commit-gate budget. */
const ANALYZERS: Analyzer[] = [
  {
    tool: 'eslint',
    provider: 'eslint',
    minRung: 'stop',
    scope: 'changed-files',
    run: runEslint,
  },
  {
    tool: 'tsc',
    provider: 'typescript',
    minRung: 'stop',
    scope: 'changed-files',
    run: runTsc,
  },
  {
    tool: 'knip',
    provider: 'knip',
    minRung: 'commit',
    scope: 'whole-project',
    run: runKnip,
  },
  {
    tool: 'dependency-cruiser',
    provider: 'dependency-cruiser',
    minRung: 'commit',
    scope: 'whole-project',
    run: runDepcruise,
  },
  {
    tool: 'stryker',
    provider: '@stryker-mutator/core',
    minRung: 'commit',
    scope: 'changed-files',
    run: runStryker,
  },
];

/** The npm packages a consumer repo must provide. Exported so a test can hold it
 *  against guardrails-core's peerDependencies — an analyzer added without its
 *  declaration would surface as a runtime error instead of an install warning. */
export const ANALYZER_PROVIDERS: readonly string[] = ANALYZERS.map(
  (analyzer) => analyzer.provider,
);

/**
 * A guard that could not RUN must never look like a guard that passed. Exit code
 * cannot carry that distinction — eslint exits 1 on findings, tsc on type errors
 * — so `spawnExec` flags the could-not-start case and this wrapper records which
 * commands hit it. See plan.md "Roadmap: analyzer opt-in" for making a pack tool
 * optional rather than required.
 */
function trackSpawnFailures(exec: Exec): { exec: Exec; failures: string[] } {
  const failures: string[] = [];
  const tracked: Exec = async (command, args, execOptions) => {
    const result = await exec(command, args, execOptions);
    if (result.spawnFailed === true) {
      failures.push(command);
    }
    return result;
  };
  return { exec: tracked, failures };
}

function missingToolViolation(tool: string, provider: string): Violation {
  return {
    ruleId: 'guardrails/analyzer-missing',
    file: 'package.json',
    message:
      `${tool} could not be started — it is not installed in this repo, so its ` +
      `checks did NOT run. Install it: \`npm install --save-dev ${provider}\`. ` +
      `A missing analyzer is a failed gate, not a clean one.`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const { exec, failures } = trackSpawnFailures(options.exec);
  const tracked = { ...options, exec };
  const files = await changedTypeScriptFiles(tracked);
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  const profile = options.profile ?? 'stop';

  const violations: Violation[] = [];
  // git failing to start is catastrophic and was equally silent: no changed
  // files means every diff-scoped analyzer is skipped, and the gate passes.
  if (failures.length > 0) {
    violations.push(missingToolViolation('git', 'git'));
  }
  for (const analyzer of ANALYZERS) {
    if (RUNG_ORDER[profile] < RUNG_ORDER[analyzer.minRung]) {
      continue;
    }
    if (analyzer.scope === 'changed-files' && files.length === 0) {
      continue;
    }
    const before = failures.length;
    violations.push(...(await analyzer.run(tracked, resolveBin, files)));
    if (failures.length > before) {
      violations.push(missingToolViolation(analyzer.tool, analyzer.provider));
    }
  }
  // Attribution is per-file, so it happens here rather than inside any adapter.
  // Built once per run: the resolver reads the filesystem at construction and is
  // pure thereafter.
  return {
    violations: withPackages(
      violations,
      loadWorkspaceResolver(options.repoRoot),
    ),
  };
}
