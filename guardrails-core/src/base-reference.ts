/**
 * Which ref a branch is verified AGAINST (#104).
 *
 * The scope of every diff-scoped analyzer is `merge-base(base, HEAD)..HEAD`,
 * and `base` was a single repo-wide `baseBranch`. On a **stacked** branch — one
 * whose pull request targets another open pull request rather than `main` —
 * that range contains the parent branch's entire diff as well as the child's,
 * so every analyzer re-runs over work that is already verified and already
 * green in the parent's own PR. Measured on an adopting repo: ~3 changed files
 * mutation-tested in 27-39s, the same branch stacked (55 parent files + 15 of
 * its own) still running when it was killed at 33 minutes. Stryker's cost is
 * dominated by a fixed per-invocation dry run, so the scope size decides
 * everything, and `verify` stops being usable as an inner-loop check exactly
 * when a stack makes it most valuable.
 *
 * Three sources, in this order:
 *
 *   1. `--base <ref>`, when the caller says so. Explicit, costs nothing, and is
 *      the answer for any situation the other two get wrong.
 *   2. The pull request's own base, read from `gh`. A stacked PR knows what it
 *      targets; nothing in the local repository does.
 *   3. The configured `baseBranch`. Today's behaviour, and the fallback for
 *      everything else.
 *
 * **The upstream tracking branch (`@{u}`) is deliberately NOT one of them**,
 * although it was the first suggestion. For a pushed branch `@{u}` is
 * `origin/<that same branch>`, so `merge-base(@{u}, HEAD)` is the branch's own
 * pushed tip and the scope collapses to unpushed commits only — on a branch
 * that is pushed and current, to nothing at all. That is fast because it checks
 * nothing, which is the precise failure this package exists to prevent.
 *
 * The fallback is silent but never narrowing. Every failure path here — no
 * `gh`, no authentication, no pull request, a detached HEAD, an unparseable
 * answer — lands on the configured base, which is WIDER than the PR base. A
 * wrong answer therefore costs time, never coverage. The one thing this must
 * never do is return a ref that scopes to less than the truth, which is why a
 * blank or missing `baseRefName` is treated as no answer at all.
 *
 * Cost is bounded by caching, because the Stop rung runs this on every turn.
 * One host call per branch per TTL, and a MISS is cached too: a branch with no
 * pull request must not pay a network round-trip once a turn to rediscover
 * that.
 */

import { parseJsonText } from './json-file.js';
import { isRecord } from './is-record.js';
import type { Exec } from './exec.js';

/**
A resolved base, and which of the three sources answered.
*/
type BaseSource = 'flag' | 'pr' | 'config';

export interface EffectiveBase {
  base: string;
  source: BaseSource;
}

/**
 * One remembered answer. `base: null` is a remembered MISS — this branch has no
 * pull request base — which is as worth caching as a hit.
 */
export interface BaseReferenceEntry {
  base: string | null;
  at: number;
}

export interface BaseReferenceCache {
  read: () => Readonly<Record<string, BaseReferenceEntry>>;
  write: (branch: string, entry: BaseReferenceEntry) => void;
}

/**
 * How long a remembered base stays good. A pull request's base changes rarely
 * (a retarget), and the cost of being an hour stale is one over-wide run, so
 * this is tuned for the Stop rung's every-turn cadence rather than for freshness.
 */
export const BASE_REFERENCE_TTL_MS = 60 * 60 * 1000;

export interface EffectiveBaseOptions {
  exec: Exec;
  repoRoot: string;
  configBase: string;
  /**
   * `--base <ref>`; wins outright when present.
   *
   * Typed `| undefined` and passed straight through rather than conditionally
   * spread at the call site: a conditional spread there is a provably
   * equivalent mutant, since `{ explicit: undefined }` and no key at all are
   * indistinguishable to the guard below. Same reasoning, and the same fix, as
   * `StopGateOptions.analyzerRungs`.
   */
  explicit?: string | undefined;
  cache?: BaseReferenceCache;
  now?: number;
}

/**
 * The current branch, or `undefined` on a detached HEAD (where git answers the
 * literal string `HEAD`).
 *
 * Detached is not an error case to report: a CI checkout of a pull request is
 * detached by design, and there the configured base is already correct.
 */
async function currentBranch(
  exec: Exec,
  repoRoot: string,
): Promise<string | undefined> {
  const result = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
  });
  if (result.spawnFailed === true || result.code !== 0) {
    return undefined;
  }
  const branch = result.stdout.trim();
  return branch === '' || branch === 'HEAD' ? undefined : branch;
}

/**
 * The pull request's base branch, or `undefined` when nothing can say.
 *
 * Every failure is the same answer on purpose. "gh is not installed", "not
 * authenticated", "this branch has no PR" and "the answer did not parse" differ
 * in cause and not in consequence: none of them narrows the scope, and none of
 * them is worth a message on a rung that runs every turn.
 */
async function pullRequestBase(
  exec: Exec,
  repoRoot: string,
): Promise<string | undefined> {
  const result = await exec('gh', ['pr', 'view', '--json', 'baseRefName'], {
    cwd: repoRoot,
  });
  if (result.spawnFailed === true || result.code !== 0) {
    return undefined;
  }
  const { parsed } = parseJsonText(result.stdout);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { baseRefName } = parsed;
  if (typeof baseRefName !== 'string') {
    return undefined;
  }
  // A blank ref would make the diff scope to nothing. Treated as no answer.
  const trimmed = baseRefName.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isFresh(entry: BaseReferenceEntry, now: number): boolean {
  return now - entry.at < BASE_REFERENCE_TTL_MS;
}

export async function resolveEffectiveBase(
  options: EffectiveBaseOptions,
): Promise<EffectiveBase> {
  const { exec, repoRoot, configBase, explicit, cache } = options;
  if (explicit !== undefined && explicit.trim() !== '') {
    return { base: explicit.trim(), source: 'flag' };
  }
  const now = options.now ?? Date.now();
  const branch = await currentBranch(exec, repoRoot);
  if (branch === undefined) {
    return { base: configBase, source: 'config' };
  }
  const remembered = cache?.read()[branch];
  if (remembered !== undefined && isFresh(remembered, now)) {
    // `null` is a remembered MISS -- this branch had no pull request when we
    // last asked -- which answers with the configured base just as a fresh
    // miss does.
    return remembered.base === null
      ? { base: configBase, source: 'config' }
      : { base: remembered.base, source: 'pr' };
  }
  const found = await pullRequestBase(exec, repoRoot);
  cache?.write(branch, { base: found ?? null, at: now });
  return found === undefined
    ? { base: configBase, source: 'config' }
    : { base: found, source: 'pr' };
}
