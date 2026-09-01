/**
 * Real-`git` proof for the Task-8 fix (plan.md "Solo -> team"): the
 * consumer-facing `.gitignore` block `mergeGitignore` writes must let a team
 * commit `.guardrails/state/recurrence.json` while every OTHER file directly
 * under `.guardrails/state/` (session tallies, violation manifests) stays
 * ignored.
 *
 * `merge.ts`'s own test suite (`merge.test.ts`) proves the exact STRING
 * `mergeGitignore` produces -- it is deliberately pure, no filesystem. That
 * proves the block has the right shape, not that git actually honors the
 * negation the way `.gitignore`'s documented semantics say it should (a
 * negated pattern is a no-op if its parent directory is itself excluded --
 * see the comment on `GITIGNORE_BLOCK` in `merge.ts`). This suite spawns a
 * real, throwaway `git` repo and asks `git check-ignore` the question
 * directly, so the claim is proven against git's actual behavior rather than
 * against this project's understanding of the gitignore spec.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeGitignore } from '../../src/scaffold/merge.js';

let root: string;

// Same rationale as `end-to-end.test.ts`: git exports GIT_DIR / GIT_WORK_TREE
// / GIT_INDEX_FILE into hook processes, which override `cwd`. Strip them so
// every `git` call here is pinned to the throwaway `root`, never the real
// repo this suite runs inside of under the pre-push/CI gate.
function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      env[key] = value;
    }
  }
  return env;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env: isolatedGitEnvironment(),
    encoding: 'utf8',
  });
}

/** `git check-ignore` exits 1 (not an error) for a tracked/un-ignored path --
 *  `execFileSync` throws on any non-zero exit, so that case is caught
 *  explicitly rather than treated as a real failure. */
function isIgnored(relativePath: string): boolean {
  try {
    git(['check-ignore', '--quiet', relativePath]);
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return false;
    }
    throw error;
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-gitignore-'));
  git(['init', '--quiet', '--initial-branch=main']);
  writeFileSync(path.join(root, '.gitignore'), mergeGitignore(undefined));
  mkdirSync(path.join(root, '.guardrails', 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mergeGitignore output, against real git', () => {
  it('does not ignore .guardrails/state/recurrence.json', () => {
    writeFileSync(
      path.join(root, '.guardrails', 'state', 'recurrence.json'),
      '{}\n',
    );

    expect(isIgnored('.guardrails/state/recurrence.json')).toBe(false);
  });

  it('still ignores a sibling session file in the same directory', () => {
    writeFileSync(
      path.join(root, '.guardrails', 'state', 'abc123.json'),
      '{}\n',
    );

    expect(isIgnored('.guardrails/state/abc123.json')).toBe(true);
  });

  it('lets recurrence.json actually be added to the index', () => {
    writeFileSync(
      path.join(root, '.guardrails', 'state', 'recurrence.json'),
      '{}\n',
    );

    // No `-f`: if the negation did not take effect, git would refuse this
    // with "The following paths are ignored by one of your .gitignore
    // files", and `execFileSync` would throw.
    git(['add', '.guardrails/state/recurrence.json']);

    const staged = git(['diff', '--cached', '--name-only']).trim();
    expect(staged).toBe('.guardrails/state/recurrence.json');
  });
});
