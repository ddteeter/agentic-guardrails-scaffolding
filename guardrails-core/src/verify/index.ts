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
  /** Cadence rung. Heavy whole-graph analyzers (knip) run only at commit/ci;
   *  the per-turn stop gate stays fast. Defaults to 'stop'. */
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

export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const files = await changedTypeScriptFiles(options);
  if (files.length === 0) {
    return { violations: [] };
  }

  const { exec, repoRoot, packageId } = options;
  const resolveBin = options.resolveBin ?? ((tool) => tool);
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

  // knip is whole-graph (not diff-scoped) and seconds-scale, so it runs only at
  // the commit/ci rungs — never on the per-turn stop gate. It assumes a
  // knip-clean baseline, like tsc (see this file's header).
  const profile = options.profile ?? 'stop';
  if (profile !== 'stop') {
    const knip = await exec(resolveBin('knip'), ['--reporter', 'json'], {
      cwd: repoRoot,
    });
    violations.push(...parseKnipJson(knip.stdout, repoRoot, packageId));
  }

  return { violations };
}
