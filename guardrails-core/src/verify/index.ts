/**
 * The verify orchestrator (§2.2). Diff-scopes to the files a turn touched,
 * dispatches the TypeScript adapters, and aggregates their output into one
 * normalized `Violation[]`. Pure Node; every shell-out goes through the
 * injected `Exec`, and tool binaries are resolved through `resolveBin` so the
 * CLI can point at the repo-local `node_modules/.bin`.
 */

import type { Exec } from '../exec.js';
import type { Violation } from '../violation.js';
import { parseEslintJson } from './eslint-adapter.js';
import { isTypeScriptFile, mergeChangedFiles } from './git.js';
import { parseTscOutput } from './tsc-adapter.js';

export interface VerifyOptions {
  repoRoot: string;
  baseBranch: string;
  exec: Exec;
  packageId?: string;
  tsconfig?: string;
  resolveBin?: (tool: string) => string;
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

  return { violations };
}
