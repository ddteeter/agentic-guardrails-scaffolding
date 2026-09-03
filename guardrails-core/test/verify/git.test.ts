import { describe, expect, it } from 'vitest';

import type { Exec } from '../../src/exec.js';
import {
  isTestFile,
  isTypeScriptFile,
  mergeChangedFiles,
  parseFileList,
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
