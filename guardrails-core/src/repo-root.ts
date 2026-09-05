/**
 * Resolve the repository root from any working directory inside it.
 *
 * Every handler currently computes `repoRoot = input.cwd ?? deps.cwd`, so
 * running the CLI from a subdirectory anchors `.guardrails/state` somewhere
 * else and `recurrence.json` — the repeat-offender ledger that drives
 * loose-routing and graduation — silently fragments and undercounts. It also
 * lets nested `.guardrails/` directories escape the root-anchored `.gitignore`
 * pattern. Invisible in this repo, which is one package at the root; certain to
 * bite a monorepo adopter.
 *
 * Failure falls back to `cwd` rather than throwing: a non-git directory or a
 * missing git binary should degrade to today's behaviour, not break every
 * command. The gate reports a missing git separately (`analyzer-missing`).
 *
 * Resolution is filesystem-first as of the CLI-resolution work: walking up for
 * `.git` gives the same answer as `git rev-parse --show-toplevel` with no
 * subprocess, and `findGitRoot` exposes the undecided case the git form cannot
 * express, which the CLI's out-of-repo check needs.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Exec } from './exec.js';
import { upwardFrom } from './path-walk.js';

/**
 * The repository root, found by walking up for `.git`, or `undefined` when
 * there is none above `from`.
 *
 * Returning `undefined` rather than falling back is the point: it is the only
 * way a caller can tell "the repo root is X" from "there is no repo here", and
 * the CLI's out-of-repo self-check must skip in the second case rather than
 * reject a directory it cannot bound.
 *
 * `.git` is matched as a plain existence check because a linked worktree's
 * `.git` is a FILE containing `gitdir: <path>`, not a directory. Testing for a
 * directory would silently skip every worktree.
 */
export function findGitRoot(
  from: string,
  isPresent: (candidate: string) => boolean = existsSync,
): string | undefined {
  for (const directory of upwardFrom(from)) {
    if (isPresent(path.join(directory, '.git'))) {
      return directory;
    }
  }
  return undefined;
}

export async function resolveRepoRoot(
  exec: Exec,
  cwd: string,
  isPresent: (candidate: string) => boolean = existsSync,
): Promise<string> {
  // Filesystem first: it returns exactly what `git rev-parse --show-toplevel`
  // returns, including inside a linked worktree, without a subprocess on the
  // hot path — and without requiring git to be installed at all.
  const walked = findGitRoot(cwd, isPresent);
  if (walked !== undefined) {
    return walked;
  }
  // Kept for the cases a `.git` walk cannot see: GIT_DIR pointing elsewhere,
  // and anything else git knows that the filesystem does not say.
  const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.spawnFailed === true || result.code !== 0) {
    return cwd;
  }
  const toplevel = result.stdout.trim();
  return toplevel === '' ? cwd : toplevel;
}
