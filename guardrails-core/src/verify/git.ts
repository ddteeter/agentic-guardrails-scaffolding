/**
 * Diff-scoping helpers. `verify` runs only over the files a turn actually
 * touched, so a Stop-boundary check stays cheap. The changed set is the union
 * of tracked changes since the base branch and untracked files — the agent's
 * edits are typically uncommitted, so a base-only diff would miss them.
 */

import type { Exec } from '../exec.js';

/**
 * Resolve the configured base branch to a ref that actually exists, preferring
 * the local branch and falling back to its origin-qualified form.
 *
 * A CI checkout is the reason this is needed. GitHub Actions checks a pull
 * request out as a detached merge ref and populates `refs/remotes/origin/*`
 * without ever creating the base branch LOCALLY, so `git diff main` fails with
 * exit 128 "unknown revision" while `origin/main` resolves. Before this, that
 * failure was silent — no changed files meant every diff-scoped analyzer was
 * skipped and the run read clean — which is exactly the fail-open the
 * exit-code checks closed. Resolving here rather than in each consumer's
 * workflow keeps the fix with the tool: every repo running `verify` in Actions
 * has this problem.
 *
 * An empty `ref` means neither form resolves, which is a real misconfiguration
 * (wrong `baseBranch`, or a clone too shallow to contain it). `spawnFailed`
 * means git itself could not be started — a different failure with a different
 * remedy — reported separately so it never masquerades as a bad base branch.
 */
export interface BaseReferenceResolution {
  /** The ref to diff against; absent when nothing resolved. */
  ref?: string;
  /** git could not be STARTED. Distinct from "the ref does not exist". */
  spawnFailed?: true;
}

export async function resolveBaseReference(
  exec: Exec,
  repoRoot: string,
  baseBranch: string,
): Promise<BaseReferenceResolution> {
  for (const ref of [baseBranch, `origin/${baseBranch}`]) {
    const result = await exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { cwd: repoRoot },
    );
    if (result.spawnFailed === true) {
      return { spawnFailed: true };
    }
    if (result.code === 0) {
      return { ref };
    }
  }
  return {};
}

export function parseFileList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0);
}

export function mergeChangedFiles(
  trackedDiff: string,
  untracked: string,
): string[] {
  return [
    ...new Set([...parseFileList(trackedDiff), ...parseFileList(untracked)]),
  ];
}

export function isTypeScriptFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}
