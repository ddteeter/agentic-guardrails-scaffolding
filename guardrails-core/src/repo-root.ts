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
 */
import type { Exec } from './exec.js';

export async function resolveRepoRoot(
  exec: Exec,
  cwd: string,
): Promise<string> {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.spawnFailed === true || result.code !== 0) {
    return cwd;
  }
  const toplevel = result.stdout.trim();
  return toplevel === '' ? cwd : toplevel;
}
