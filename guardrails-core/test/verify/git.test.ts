import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import {
  isDependencyPath,
  isInsideNestedWorktree,
  isConfigFile,
  isTestFile,
  isTypeScriptFile,
  mergeChangedFiles,
  nestedWorktreePaths,
  parseFileList,
  parseNestedWorktrees,
  resolveBaseReference,
} from '../../src/verify/git.js';

describe('parseFileList', () => {
  it('splits, trims, and drops blank lines', () => {
    expect(parseFileList('src/a.ts\nsrc/b.ts\n\n')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('is empty for empty output', () => {
    expect(parseFileList('')).toEqual([]);
  });
});

describe('mergeChangedFiles', () => {
  it('unions tracked-diff and untracked files, de-duplicating', () => {
    const merged = mergeChangedFiles(
      'src/a.ts\nsrc/b.ts',
      'src/b.ts\nsrc/c.ts',
    );
    expect(merged.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('de-duplicates across a stray leading ./ prefix', () => {
    expect(mergeChangedFiles('./src/a.ts', 'src/a.ts')).toEqual(['src/a.ts']);
  });

  // A greenfield repo whose `.gitignore` does not cover `node_modules/` reports
  // every installed file as untracked -- measured at 12,669 paths -- and eslint
  // dies loading a dependency's own flat config. The filter belongs here rather
  // than only in the seeded `.gitignore` because a consumer can delete that line.
  it('drops dependency paths, however the union reaches it', () => {
    expect(
      mergeChangedFiles(
        'node_modules/left-pad/index.ts',
        'src/a.ts\n./node_modules/fast-uri/types.ts\npackages/web/node_modules/x/y.ts',
      ),
    ).toEqual(['src/a.ts']);
  });
});

describe('isDependencyPath', () => {
  it('flags an installed path at the root and inside a workspace member', () => {
    expect(isDependencyPath('node_modules/fast-uri/types.ts')).toBe(true);
    expect(isDependencyPath('packages/web/node_modules/x/y.ts')).toBe(true);
  });

  // The guard is a path-SEGMENT test on purpose: a source directory whose name
  // merely starts with the segment is the repo's own code and must still lint.
  it('does not flag a source path that only looks like one', () => {
    expect(isDependencyPath('src/node_modules_shim/index.ts')).toBe(false);
    expect(isDependencyPath('src/a.ts')).toBe(false);
  });
});

describe('isTypeScriptFile', () => {
  it('accepts .ts and .tsx', () => {
    expect(isTypeScriptFile('src/a.ts')).toBe(true);
    expect(isTypeScriptFile('src/a.tsx')).toBe(true);
  });

  it('rejects declaration files and non-TS files', () => {
    expect(isTypeScriptFile('src/a.d.ts')).toBe(false);
    expect(isTypeScriptFile('README.md')).toBe(false);
    expect(isTypeScriptFile('src/a.js')).toBe(false);
  });
});

describe('isTestFile', () => {
  it('flags test and spec files, not production sources', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.tsx')).toBe(true);
    expect(isTestFile('test/bar.test.ts')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
    expect(isTestFile('src/testing.ts')).toBe(false);
  });
});

describe('isConfigFile', () => {
  it('flags config-as-TypeScript at the root and in a package', () => {
    expect(isConfigFile('vitest.config.ts')).toBe(true);
    expect(isConfigFile('eslint.config.mts')).toBe(true);
    expect(isConfigFile('tailwind.config.cts')).toBe(true);
    expect(isConfigFile('playwright.config.tsx')).toBe(true);
    expect(isConfigFile('packages/web/vite.config.ts')).toBe(true);
  });

  it('does not flag ordinary sources that merely mention config', () => {
    // The exclusion removes a file from MUTATION, so a match too wide silently
    // stops mutation-testing real code — the failure mode worth pinning.
    expect(isConfigFile('src/config.ts')).toBe(false);
    expect(isConfigFile('src/configure.ts')).toBe(false);
    expect(isConfigFile('src/load-config.ts')).toBe(false);
    expect(isConfigFile('src/config/index.ts')).toBe(false);
  });

  it('anchors both ends of the pattern', () => {
    // Kills the `$` anchor mutant: a suffixed backup would otherwise match and
    // silently leave a real source out of the mutation set.
    expect(isConfigFile('vitest.config.ts.bak')).toBe(false);
    // Kills the `(^|\/)` anchor mutant: the segment has to BE the config file,
    // not merely end with the name of one.
    expect(isConfigFile('src/notvitest.config.ts')).toBe(true);
    expect(isConfigFile('vitest.config.js')).toBe(false);
    expect(isConfigFile('vitest.config.json')).toBe(false);
  });
});

describe('git helpers mutation-hardening', () => {
  it('trims each entry and strips only a leading ./', () => {
    // Kills the dropped `.trim().replace()` chain: without it the padded entry
    // keeps its spaces and the whitespace-only line survives the length filter.
    expect(parseFileList('  src/a.ts  \n   \n./src/b.ts')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    // Kills the `^` anchor mutant: unanchored, this would rewrite the interior
    // `./` segment into `docs/guide.md`.
    expect(parseFileList('docs/./guide.md')).toEqual(['docs/./guide.md']);
  });

  it('anchors the TypeScript extension at end-of-name', () => {
    // Kills the `$` anchor mutants: unanchored, a suffixed backup file matches.
    expect(isTypeScriptFile('src/a.ts.bak')).toBe(false);
    expect(isTestFile('src/a.test.ts.bak')).toBe(false);
  });
});

// A GitHub Actions PR checkout leaves the base branch un-created LOCALLY: the
// fetch populates refs/remotes/origin/*, and HEAD is a detached merge ref. So
// `git diff main` fails with exit 128 "unknown revision" while `origin/main`
// resolves fine. Every consumer running verify in CI hits this, so the
// resolution belongs in the tool, not in each repo's workflow.
function execFor(resolvable: readonly string[]): {
  exec: Exec;
  asked: string[];
} {
  const asked: string[] = [];
  const exec: Exec = (_command, args) => {
    const reference = args.at(-1) ?? '';
    asked.push(reference);
    return Promise.resolve(
      resolvable.some((candidate) => reference.startsWith(candidate))
        ? { stdout: 'abc123', stderr: '', code: 0 }
        : { stdout: '', stderr: 'fatal: Needed a single revision', code: 128 },
    );
  };
  return { exec, asked };
}

const spawnFailedExec: Exec = () =>
  Promise.resolve({
    stdout: '',
    stderr: 'spawn git ENOENT',
    code: 1,
    spawnFailed: true as const,
  });

describe('resolveBaseReference', () => {
  it('uses the base branch as given when it resolves locally', async () => {
    const { exec, asked } = execFor(['main']);
    expect(await resolveBaseReference(exec, '/repo', 'main')).toEqual({
      ref: 'main',
    });
    // The local ref resolving must short-circuit: no remote probe follows.
    expect(asked.some((ref) => ref.startsWith('origin/'))).toBe(false);
  });

  it('falls back to the origin-qualified ref when only that resolves', async () => {
    const { exec } = execFor(['origin/main']);
    expect(await resolveBaseReference(exec, '/repo', 'main')).toEqual({
      ref: 'origin/main',
    });
  });

  it('returns undefined when neither the local nor the remote ref resolves', async () => {
    const { exec } = execFor([]);
    expect(await resolveBaseReference(exec, '/repo', 'main')).toEqual({});
  });

  it('honors a non-default base branch name in both candidates', async () => {
    // Paired with the case above so a resolver that hardcoded "main" would
    // fail here rather than silently pass.
    const { exec, asked } = execFor(['origin/develop']);
    expect(await resolveBaseReference(exec, '/repo', 'develop')).toEqual({
      ref: 'origin/develop',
    });
    expect(asked.some((ref) => ref.startsWith('develop'))).toBe(true);
  });

  it('does not treat a spawn failure as an unresolvable ref', async () => {
    // git missing entirely is a different failure with a different remedy; it
    // must not be reported as "your base branch is wrong".
    expect(
      await resolveBaseReference(spawnFailedExec, '/repo', 'main'),
    ).toEqual({
      spawnFailed: true,
    });
  });
});

/**
 * Every rejection case below is paired with a worktree that MUST be kept.
 * Asserting `[]` alone would pass even against a parser that accepted the bad
 * input and then dropped it for some unrelated reason -- the kept entry is
 * what proves the parser is still working at all.
 */
const KEPT = 'worktree /repo/.claude/worktrees/feature';
const KEPT_RESULT = ['.claude/worktrees/feature'];

function parse(...lines: string[]): string[] {
  return parseNestedWorktrees([...lines, ''].join('\n'), '/repo');
}

describe('parseNestedWorktrees', () => {
  it('keeps only worktrees nested inside the repo root', () => {
    expect(
      parse(
        'worktree /repo',
        'HEAD f25ba66',
        'branch refs/heads/main',
        '',
        'worktree /elsewhere/outside',
        'HEAD 9f5d753',
        '',
        KEPT,
        'HEAD 37a3a2d',
        'branch refs/heads/worktree-feature',
        'locked claude session feature (pid 49674)',
      ),
    ).toEqual(KEPT_RESULT);
  });

  it('never treats the main checkout as nested', () => {
    // The first porcelain record is always the repo itself. An empty prefix
    // here would match every file in the repo and filter the whole run away.
    expect(parse('worktree /repo', KEPT)).toEqual(KEPT_RESULT);
  });

  it('ignores worktrees outside the repo root', () => {
    expect(parse('worktree /elsewhere', KEPT)).toEqual(KEPT_RESULT);
  });

  it('does not treat a sibling repo as nested', () => {
    // '/repo-other' shares '/repo' as a string prefix but is not inside it.
    expect(parse('worktree /repo-other/wt', KEPT)).toEqual(KEPT_RESULT);
  });

  it('keeps a nested directory whose name merely starts with two dots', () => {
    // '..cache' is an ordinary child, not a parent traversal.
    expect(parse('worktree /repo/..cache/wt')).toEqual(['..cache/wt']);
  });

  it('excludes a path that traverses back out of the repo', () => {
    // '/repo/../evil' resolves to '/evil'. A parser that compared the raw
    // string would see a '/repo/' prefix and wrongly keep it.
    expect(parse('worktree /repo/../evil', KEPT)).toEqual(KEPT_RESULT);
  });

  it('ignores a line that is not a worktree record', () => {
    // `prunable` is a real porcelain field, and its payload here is a path
    // that WOULD be accepted if the prefix check stopped rejecting it.
    expect(parse('prunable /repo/decoy', KEPT)).toEqual(KEPT_RESULT);
  });

  it('ignores a worktree record with a relative path', () => {
    // Resolving this would depend on the process's cwd rather than the repo.
    expect(parse('worktree relative/path', KEPT)).toEqual(KEPT_RESULT);
  });

  it('refuses a relative path even when it would resolve inside the repo', () => {
    // The case above passes for a weak reason: with repoRoot '/repo' and the
    // suite's cwd elsewhere, a relative path resolves outside the repo and the
    // containment check drops it regardless. Here repoRoot IS the cwd, so
    // 'relative/path' resolves to a genuine child -- and only the isAbsolute
    // guard stops it. Without that guard the parser would quietly answer for
    // the process's directory instead of the repository it was handed.
    const root = process.cwd();
    expect(
      parseNestedWorktrees(
        `worktree relative/path\nworktree ${root}/kept\n`,
        root,
      ),
    ).toEqual(['kept']);
  });

  it('strips the carriage return left by CRLF output', () => {
    expect(parseNestedWorktrees(`${KEPT}\r\n`, '/repo')).toEqual(KEPT_RESULT);
  });

  it('is empty for empty output', () => {
    expect(parseNestedWorktrees('', '/repo')).toEqual([]);
  });
});

describe('isInsideNestedWorktree', () => {
  const prefixes = ['.claude/worktrees/feature'];

  it('matches a file under the worktree', () => {
    expect(
      isInsideNestedWorktree('.claude/worktrees/feature/src/a.ts', prefixes),
    ).toBe(true);
  });

  it('matches the worktree path itself', () => {
    expect(isInsideNestedWorktree('.claude/worktrees/feature', prefixes)).toBe(
      true,
    );
  });

  it('does not match a sibling whose name shares the prefix', () => {
    // '.claude/worktrees/feature-old' must not be swallowed by 'feature'.
    expect(
      isInsideNestedWorktree(
        '.claude/worktrees/feature-old/src/a.ts',
        prefixes,
      ),
    ).toBe(false);
  });

  it('does not match a file outside every worktree', () => {
    expect(isInsideNestedWorktree('src/a.ts', prefixes)).toBe(false);
  });

  it('matches nothing when there are no nested worktrees', () => {
    expect(isInsideNestedWorktree('src/a.ts', [])).toBe(false);
  });
});

/**
 * Parseable output holding exactly one nested worktree.
 *
 * Every failure case below feeds git this SAME stdout on purpose. A blank
 * stdout would make `[]` the right answer either way -- the happy path
 * produces `[]` for it too -- so the assertion could not tell a working guard
 * from a broken one. Pairing the failure with output that WOULD parse means a
 * guard that stops short-circuiting emits `['wt']` and the test fails.
 */
const NESTED_PORCELAIN = 'worktree /repo\n\nworktree /repo/wt\n';

interface WorktreeCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

function worktreeExec(result: ExecResult): {
  exec: Exec;
  calls: WorktreeCall[];
} {
  const calls: WorktreeCall[] = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    return Promise.resolve(result);
  };
  return { exec, calls };
}

describe('nestedWorktreePaths', () => {
  it('asks git for the porcelain worktree list, rooted at the repo', async () => {
    const { exec, calls } = worktreeExec({
      stdout: NESTED_PORCELAIN,
      stderr: '',
      code: 0,
    });
    expect(await nestedWorktreePaths(exec, '/repo')).toEqual(['wt']);
    // Asserting the exact argv and cwd, not just the result: without `cwd`,
    // git answers for whatever directory the process happens to be in, which
    // in a hook is not necessarily the repository being guarded.
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['worktree', 'list', '--porcelain'],
        cwd: '/repo',
      },
    ]);
  });

  it('honors spawnFailed even when the exit code looks clean', async () => {
    // code 0 isolates the spawnFailed clause from the exit-code clause, and
    // pins the contract `ExecResult.spawnFailed` exists for: the flag is the
    // signal that git never ran, and the exit code cannot carry it.
    const { exec } = worktreeExec({
      stdout: NESTED_PORCELAIN,
      stderr: 'spawn git ENOENT',
      code: 0,
      spawnFailed: true,
    });
    expect(await nestedWorktreePaths(exec, '/repo')).toEqual([]);
  });

  it('ignores the output of a git that exited non-zero', async () => {
    // No spawnFailed here, so the exit-code clause alone decides -- which is
    // what makes a `||` -> `&&` mutation observable.
    const { exec } = worktreeExec({
      stdout: NESTED_PORCELAIN,
      stderr: 'fatal',
      code: 128,
    });
    expect(await nestedWorktreePaths(exec, '/repo')).toEqual([]);
  });
});
