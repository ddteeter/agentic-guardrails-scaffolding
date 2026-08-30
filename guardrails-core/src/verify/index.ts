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
 *
 * A guard that RAN and then FAILED must never look like a guard that passed
 * either: eslint/tsc/knip/dependency-cruiser use a non-zero exit to report
 * *findings* (which parse into violations), so the one signal that separates a
 * crash/misconfiguration from a clean run is "non-zero exit, yet nothing
 * parsed" — `withExitCodeCheck` applies that rule uniformly. `stryker` is
 * different: absent a configured `break` threshold (this pack sets none), it
 * exits 0 even with surviving mutants, so ANY non-zero exit from it is a crash,
 * and its report is read from an explicit per-run path rather than its
 * (gitignored, cross-run-persistent) default location — see `runStryker`.
 */

import { randomUUID } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import type { Exec, ExecResult } from '../exec.js';
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

/** First non-blank line of a tool's stderr, for a violation message that names
 *  *why* the tool failed rather than just that it did. `undefined` when stderr
 *  carried nothing useful. */
function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** A guard that ran and then crashed/misconfigured, distinct from
 *  `guardrails/analyzer-missing` (which means the binary never started). Named
 *  after the tool, its exit code, and — when present — the first line of
 *  stderr, so a consumer can tell why without re-running it. */
function analyzerFailedViolation(
  tool: string,
  code: number,
  stderr: string,
): Violation {
  const stderrLine = firstNonEmptyLine(stderr);
  const detail =
    stderrLine === undefined ? '' : ` First line of stderr: "${stderrLine}"`;
  return {
    ruleId: 'guardrails/analyzer-failed',
    file: 'package.json',
    message:
      `${tool} exited with code ${code} and produced no parseable violations — ` +
      `it started but did not complete cleanly (a bad config, a crash, or an ` +
      `unexpected flag). A failed analyzer is a failed gate, not a clean one.` +
      detail,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

/**
 * eslint/tsc/knip/dependency-cruiser all use a non-zero exit to report
 * *findings* — that is the normal case and would have parsed into violations.
 * So the failure signal is the conjunction: non-zero exit AND nothing parsed.
 * `spawnFailed` is excluded because that case is reported separately as
 * `guardrails/analyzer-missing` by the caller's spawn tracking.
 */
function withExitCodeCheck(
  tool: string,
  execResult: ExecResult,
  violations: Violation[],
): Violation[] {
  if (
    execResult.spawnFailed !== true &&
    execResult.code !== 0 &&
    violations.length === 0
  ) {
    return [
      ...violations,
      analyzerFailedViolation(tool, execResult.code, execResult.stderr),
    ];
  }
  return violations;
}

/** `true` when a git invocation neither could not be started (that is tracked
 *  separately) nor exited zero. */
function gitCallFailed(result: ExecResult): boolean {
  return result.spawnFailed !== true && result.code !== 0;
}

async function changedTypeScriptFiles(
  options: VerifyOptions,
): Promise<{ files: string[]; violations: Violation[] }> {
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
  // A missing/unfetched base branch exits non-zero with empty stdout; treated
  // as zero changed files that would silently skip every diff-scoped analyzer
  // and read clean. Neither invocation's exit code carries a "findings" case
  // (unlike the analyzers above) — a non-zero git exit is always a failure.
  const failedGitCall = [tracked, untracked].find((result) =>
    gitCallFailed(result),
  );
  if (failedGitCall !== undefined) {
    return {
      files: [],
      violations: [
        analyzerFailedViolation(
          'git',
          failedGitCall.code,
          failedGitCall.stderr,
        ),
      ],
    };
  }
  const files = mergeChangedFiles(tracked.stdout, untracked.stdout).filter(
    (file) => isTypeScriptFile(file),
  );
  return { files, violations: [] };
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
  const { exec, repoRoot } = options;
  const knip = await exec(resolveBin('knip'), ['--reporter', 'json'], {
    cwd: repoRoot,
  });
  return withExitCodeCheck('knip', knip, parseKnipJson(knip.stdout, repoRoot));
}

/** dependency-cruiser is whole-graph (not diff-scoped); like knip it runs at
 *  the commit/ci rungs only, independent of whether any `.ts` file changed. It
 *  assumes a dependency-cruiser-clean baseline, like tsc/knip. */
async function runDepcruise(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
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
  return withExitCodeCheck(
    'dependency-cruiser',
    result,
    parseDepcruiseJson(result.stdout, repoRoot),
  );
}

async function runEslint(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
  const eslint = await exec(
    resolveBin('eslint'),
    ['--format', 'json', '--no-warn-ignored', ...files],
    { cwd: repoRoot },
  );
  return withExitCodeCheck(
    'eslint',
    eslint,
    parseEslintJson(eslint.stdout, repoRoot),
  );
}

/** `tsc` is changed-files-TRIGGERED but whole-project-CHECKED: it takes no file
 *  list (`-p tsconfig`), so a change in one file can surface an error in
 *  another. It assumes a clean type-check baseline (see this file's header). */
async function runTsc(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
  const tsconfig = options.tsconfig ?? 'tsconfig.json';
  const tsc = await exec(
    resolveBin('tsc'),
    ['--noEmit', '--pretty', 'false', '-p', tsconfig],
    { cwd: repoRoot },
  );
  return withExitCodeCheck('tsc', tsc, parseTscOutput(tsc.stdout, repoRoot));
}

/** A fresh, repo-relative report path on every call. Consumer-generic (no
 *  absolute path, no assumption about this repo's layout — still lands under
 *  stryker's own default `reports/mutation/` directory, which every consumer
 *  already gitignores) and collision-proof across runs: stryker's DEFAULT path
 *  is fixed and gitignored, so it persists between runs, and a crashed run can
 *  silently leave a PRIOR run's report there for the next read to pick up. A
 *  unique filename per call makes that impossible — there is nothing stale at
 *  this path because nothing else has ever written to it. */
function strykerReportPath(): string {
  return path.join('reports', 'mutation', `mutation-${randomUUID()}.json`);
}

function strykerReportMissingViolation(reportPath: string): Violation {
  return {
    ruleId: 'guardrails/analyzer-failed',
    file: 'package.json',
    message:
      `stryker exited 0 but its mutation report was not found at ` +
      `"${reportPath}" — treating the mutation check as failed, not clean.`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

/** stryker is diff-scoped (changed production files) and CI/commit-only
 *  (mutation testing reruns the suite per mutant). Consumer-generic: no
 *  `--configFile` (stryker auto-detects the consumer's stryker.conf.json), and
 *  the `--mutate` list is the consumer's own changed files. The report path is
 *  passed explicitly via `--jsonReporter.fileName` and read back from that same
 *  path (see `strykerReportPath`) rather than stryker's default location,
 *  which is gitignored and persists between runs.
 *
 *  Unlike the analyzers above, stryker exits 0 even with surviving mutants
 *  unless a `break` threshold is configured (this pack sets none) — so ANY
 *  non-zero exit here means a crash, never "findings", and is always a
 *  failure. A missing report file after a zero exit is also a failure: the
 *  report is the only channel mutation results reach this process through. */
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
  const { exec, repoRoot } = options;
  const readFile =
    options.readFile ?? ((filePath) => fsReadFile(filePath, 'utf8'));
  const reportPath = strykerReportPath();

  const result = await exec(
    resolveBin('stryker'),
    [
      'run',
      '--incremental',
      '--reporters',
      'json',
      '--jsonReporter.fileName',
      reportPath,
      '--mutate',
      production.join(','),
    ],
    { cwd: repoRoot },
  );
  if (result.spawnFailed === true) {
    // Reported separately as guardrails/analyzer-missing by the caller.
    return [];
  }
  if (result.code !== 0) {
    return [analyzerFailedViolation('stryker', result.code, result.stderr)];
  }

  let report: string;
  try {
    report = await readFile(path.join(repoRoot, reportPath));
  } catch {
    return [strykerReportMissingViolation(reportPath)];
  }
  return parseStrykerJson(report, production);
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
  const { files, violations: gitViolations } =
    await changedTypeScriptFiles(tracked);
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  const profile = options.profile ?? 'stop';

  const violations: Violation[] = [...gitViolations];
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
