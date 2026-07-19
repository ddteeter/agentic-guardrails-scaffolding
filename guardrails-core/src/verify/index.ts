/**
 * The verify orchestrator (§2.2). Determines the TypeScript files a turn
 * touched, dispatches the adapters, and aggregates their output into one
 * normalized `Violation[]`. Pure Node; every shell-out goes through the
 * injected `Exec`, and tool binaries are resolved through `resolveBin` so the
 * CLI can point at the repo-local `node_modules/.bin`.
 *
 * Scoping is per-tool: **ESLint is diff-scoped** to the changed files, but
 * **`tsc` runs project-wide** (`-p tsconfig`) because TypeScript checking is
 * inherently cross-file — a change in one file can surface an error in another.
 * A consequence: `verify` assumes a clean type-check baseline. If the branch
 * already has pre-existing `tsc` errors, every turn will escalate on them until
 * they're fixed (see README — run `guardrails verify` clean before relying on
 * the gate).
 */

import type { Exec } from '../exec.js';
import type { Violation } from '../violation.js';
import { parseDepcruiseJson } from './depcruise-adapter.js';
import { parseEslintJson } from './eslint-adapter.js';
import { isTypeScriptFile, mergeChangedFiles } from './git.js';
import { parseKnipJson } from './knip-adapter.js';
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

async function runEslintAndTsc(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  if (files.length === 0) {
    return [];
  }
  const { exec, repoRoot, packageId } = options;
  const tsconfig = options.tsconfig ?? 'tsconfig.json';
  const violations: Violation[] = [];

  const eslint = await exec(
    resolveBin('eslint'),
    ['--format', 'json', '--no-warn-ignored', ...files],
    { cwd: repoRoot },
  );
  violations.push(...parseEslintJson(eslint.stdout, repoRoot, packageId));

  const tsc = await exec(
    resolveBin('tsc'),
    ['--noEmit', '--pretty', 'false', '-p', tsconfig],
    { cwd: repoRoot },
  );
  violations.push(...parseTscOutput(tsc.stdout, repoRoot, packageId));

  return violations;
}

type Rung = NonNullable<VerifyOptions['profile']>;
const RUNG_ORDER: Record<Rung, number> = { stop: 0, commit: 1, ci: 2 };

interface Analyzer {
  tool: string;
  minRung: Rung;
  run: (
    options: VerifyOptions,
    resolveBin: (tool: string) => string,
  ) => Promise<Violation[]>;
}

/** Whole-graph analyzers, each gated by its minimum cadence rung. ESLint/tsc are
 *  NOT here — they are diff-scoped (gated on changed files, run at every rung),
 *  so they stay the special case in runVerify below. When semgrep (the first
 *  diff-scopable / possibly stop-rung analyzer) and stryker (CI-only) arrive,
 *  re-evaluate whether minRung alone suffices or this table must graduate to a
 *  fuller per-analyzer abstraction (bin + adapter + diff-scope policy), and
 *  reconsider parallel execution under a measured commit-gate budget. */
const ANALYZERS: Analyzer[] = [
  { tool: 'knip', minRung: 'commit', run: runKnip },
  { tool: 'dependency-cruiser', minRung: 'commit', run: runDepcruise },
];

export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const files = await changedTypeScriptFiles(options);
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  const profile = options.profile ?? 'stop';

  const violations: Violation[] = [];
  for (const analyzer of ANALYZERS) {
    if (RUNG_ORDER[profile] >= RUNG_ORDER[analyzer.minRung]) {
      violations.push(...(await analyzer.run(options, resolveBin)));
    }
  }
  violations.push(...(await runEslintAndTsc(options, resolveBin, files)));
  return { violations };
}
