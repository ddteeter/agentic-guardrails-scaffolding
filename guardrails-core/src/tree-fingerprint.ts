/**
 * A content fingerprint of the working tree, so the Stop gate can tell "nothing
 * changed since the last clean verify" without running verify (F5 in the
 * 2026-10-09 worktree plan).
 *
 * The Stop gate runs at the end of EVERY turn, including the many turns that
 * edit nothing: an orchestrating session in the dialed.run adoption ran it
 * about 750 times at a median of 26 seconds, and 583 of the 586 decisions it
 * logged were clean.
 *
 * The fingerprint is the tree git WOULD commit if everything were staged:
 * tracked edits, untracked files, and nothing `.gitignore` excludes -- exactly
 * the set the Stop gate verifies. It is built in a throwaway copy of the index
 * (`GIT_INDEX_FILE`), so the real index -- what the developer has staged -- is
 * never touched. `git add` does write loose blobs into the object store; that
 * is the same footprint as `git stash create`, and `git gc` collects them.
 *
 * The merge-base is part of the key because the gate's changed set is a diff
 * against it, and the package version because a new guardrails-core can find
 * what an old one did not. Any failure yields `undefined`, which means "no
 * cache": the gate then runs verify, as it always did.
 */

import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { Exec } from './exec.js';
import { packageVersion } from './package-root.js';

/**
 * The inherited environment minus every `GIT_*` variable. A hook process can
 * inherit `GIT_DIR`/`GIT_INDEX_FILE` from git itself, which would point these
 * calls at whatever repository invoked the hook rather than at `repoRoot`.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

export async function treeFingerprint(
  exec: Exec,
  repoRoot: string,
  baseBranch: string,
): Promise<string | undefined> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'guardrails-tree-'));
  try {
    const temporaryIndex = path.join(scratch, 'index');
    // Asked WITHOUT the private index in the environment: `--git-path index`
    // honours GIT_INDEX_FILE, and would answer with the private index itself.
    const indexPath = await exec('git', ['rev-parse', '--git-path', 'index'], {
      cwd: repoRoot,
      env: cleanEnvironment(),
    });
    const indexName = indexPath.stdout.trim();
    if (indexName === '' || indexPath.code !== 0) {
      return undefined;
    }
    const realIndex = path.resolve(repoRoot, indexName);
    if (statSync(realIndex, { throwIfNoEntry: false })?.isFile() === true) {
      // A copy, not a fresh index: starting from the real one keeps git's stat
      // cache, so `add -A` only hashes what actually changed.
      copyFileSync(realIndex, temporaryIndex);
    }
    const environment = {
      ...cleanEnvironment(),
      GIT_INDEX_FILE: temporaryIndex,
    };
    const added = await exec('git', ['add', '-A'], {
      cwd: repoRoot,
      env: environment,
    });
    const tree = await exec('git', ['write-tree'], {
      cwd: repoRoot,
      env: environment,
    });
    const treeId = tree.stdout.trim();
    if (treeId === '' || added.code !== 0 || tree.code !== 0) {
      return undefined;
    }
    const base = await exec('git', ['merge-base', baseBranch, 'HEAD'], {
      cwd: repoRoot,
      env: environment,
    });
    return [treeId, base.stdout.trim(), packageVersion()].join('|');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
