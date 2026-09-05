/**
 * Diff-scoping helpers. `verify` runs only over the files a turn actually
 * touched, so a Stop-boundary check stays cheap. The changed set is the union
 * of tracked changes since the base branch and untracked files — the agent's
 * edits are typically uncommitted, so a base-only diff would miss them.
 */

import path from 'node:path';

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
  /**
  The ref to diff against; absent when nothing resolved.
  */
  ref?: string;
  /**
  git could not be STARTED. Distinct from "the ref does not exist".
  */
  spawnFailed?: true;
}

/** git's "peel to a commit" suffix. Bound to a name because it reads as a
 *  botched template interpolation to `unicorn/no-incorrect-template-string-interpolation`,
 *  and because a reader who does not know gitrevisions(7) needs telling. */
const COMMIT_PEEL = '^{commit}';

export async function resolveBaseReference(
  exec: Exec,
  repoRoot: string,
  baseBranch: string,
): Promise<BaseReferenceResolution> {
  for (const ref of [baseBranch, `origin/${baseBranch}`]) {
    const result = await exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `${ref}${COMMIT_PEEL}`],
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

/**
 * True for a path inside an installed dependency tree, at any depth.
 *
 * `node_modules` is untracked but only ignored if the consumer's `.gitignore`
 * says so, and `init` writes that file from scratch on a greenfield repo — so
 * the changed set can legitimately arrive carrying every installed file.
 * Measured on a bare `npm init` adoption: 12,669 of 12,699 untracked paths were
 * dependencies, and eslint died walking up from one of them into
 * `node_modules/fast-uri/eslint.config.js`, reporting `analyzer-failed` on
 * every turn instead of linting.
 *
 * Filtering here rather than only seeding the `.gitignore` line is the same
 * two-layer answer nested worktrees get: the seed covers the common case, and
 * this covers a consumer who edits the seed back out. Matched as a whole path
 * SEGMENT — a `src/node_modules_shim/` directory is the repo's own code.
 */
export function isDependencyPath(file: string): boolean {
  return file.split('/').includes('node_modules');
}

export function mergeChangedFiles(
  trackedDiff: string,
  untracked: string,
): string[] {
  return [
    ...new Set([...parseFileList(trackedDiff), ...parseFileList(untracked)]),
  ].filter((file) => !isDependencyPath(file));
}

export function isTypeScriptFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
}

/**
 * Test material: a `*.test.ts`/`*.spec.ts` file, OR any file living under a
 * test directory.
 *
 * The directory half exists because a suite is not only its spec files. A
 * helper module a test imports -- a fixture builder, a harness, a shared
 * predicate -- carries no `.test.` in its name, so the extension rule alone
 * classed it as PRODUCTION and handed it to stryker, which then reported
 * `no-coverage` on a module no test asserts about directly and no fixer can
 * honestly do anything with. Found by dogfooding, on this repo's own
 * `test/drift/under-mutation.ts`.
 *
 * The segment must be the WHOLE directory name (`test/`, `tests/`,
 * `__tests__/`), not a substring: `src/testing/latest.ts` is production, and a
 * rule that swallowed it would silently stop mutating real code.
 */
export function isTestFile(file: string): boolean {
  if (/\.(test|spec)\.tsx?$/.test(file)) {
    return true;
  }
  return file
    .split(/[/\\]/)
    .slice(0, -1)
    .some((segment) => TEST_DIRECTORIES.has(segment));
}

const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
]);

/**
 * Config-as-TypeScript: `vitest.config.ts`, `eslint.config.mts`,
 * `playwright.config.ts`, and every other `*.config.*ts` a modern TypeScript
 * repo declares its tooling in.
 *
 * These are TypeScript and are not named `*.test.ts`, so a plain
 * "TypeScript minus tests" production filter classes them as mutable source.
 * Every mutant they yield is `NoCoverage` by construction — a config literal is
 * read by a tool at startup, never by a test — so mutation-testing them hands
 * the fixer violations no honest fix can clear, and the only exits left are a
 * sanctioned suppression or a stryker `mutate` exclusion the adopter has to
 * know to write. Excluded from MUTATION only: eslint and tsc still check these
 * files, which is where their real defects surface.
 */
export function isConfigFile(file: string): boolean {
  return /(^|\/)[^/]*\.config\.[cm]?tsx?$/.test(file);
}

const WORKTREE_PREFIX = 'worktree ';

/**
 * Repo-relative POSIX prefixes for every git worktree checked out INSIDE
 * `repoRoot`.
 *
 * A nested worktree is untracked but NOT ignored, so whole-graph analyzers
 * (knip, dependency-cruiser) walk into it and report a second checkout of the
 * repository as if it were part of this one. Claude Code creates worktrees
 * under `.claude/worktrees/` by default, so the recommended workflow produces
 * this state; measured here, it was 661 phantom violations and a commit gate
 * that refused every commit.
 *
 * Parsing is separated from running git so the record-shape rules — the first
 * record is always the main checkout, `HEAD`/`branch`/`locked` lines are noise
 * — are provable without a repository.
 */
export function parseNestedWorktrees(
  stdout: string,
  repoRoot: string,
): string[] {
  const root = path.resolve(repoRoot);
  const nested: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(WORKTREE_PREFIX)) {
      continue;
    }
    // `.trim()` earns its place on CRLF output: splitting on '\n' leaves a
    // trailing '\r' that would otherwise become part of the path.
    const absolute = line.slice(WORKTREE_PREFIX.length).trim();
    // git always emits an absolute path here. Resolving a relative one would
    // silently depend on the PROCESS's cwd, which in a hook is not necessarily
    // the repository being guarded -- so refuse rather than guess.
    if (!path.isAbsolute(absolute)) {
      continue;
    }
    const resolved = path.resolve(absolute);
    // One test carries three jobs, which is why there is no separate
    // `resolved === root` guard above it -- that case is already false here,
    // since `root` alone cannot start with `root` PLUS a separator:
    //   - the main checkout (always the first record) is excluded;
    //   - '/repo-other/wt' is excluded, which is what the separator is for;
    //   - '/repo/../evil' has already resolved to '/evil', so a path that only
    //     LOOKED like a child on the raw string is excluded too.
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      continue;
    }
    nested.push(path.relative(root, resolved).replaceAll('\\', '/'));
  }
  return nested;
}

/**
 * Is this repo-relative file inside one of `prefixes`?
 *
 * The `/` in the second test is load-bearing: without it, a worktree named
 * `feature` would also swallow a sibling directory named `feature-old`.
 */
export function isInsideNestedWorktree(
  file: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
}

/**
 * Nested worktrees for `repoRoot`, or none if git cannot answer.
 *
 * Degrading to `[]` is the STRICT choice here, not a fail-open: this list only
 * ever removes violations, so filtering nothing leaves the gate exactly as
 * strict as it is today. A genuinely missing git is already reported by
 * `changedTypeScriptFiles`, so this must not report it a second time.
 */
export async function nestedWorktreePaths(
  exec: Exec,
  repoRoot: string,
): Promise<string[]> {
  const result = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
  });
  if (result.spawnFailed === true || result.code !== 0) {
    return [];
  }
  return parseNestedWorktrees(result.stdout, repoRoot);
}
