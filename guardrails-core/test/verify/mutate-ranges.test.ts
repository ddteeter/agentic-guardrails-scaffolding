import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import {
  DEFAULT_MUTATION_SCOPE,
  type LineRange,
  changedLineRanges,
  countLines,
  isLocationInRanges,
  mutateEntries,
  parseDiffHunks,
  planFileRanges,
  planMutateRanges,
  planRunRanges,
} from '../../src/verify/mutate-ranges.js';

/**
A `git diff --unified=0` file section, built so each case names only its hunks.
*/
function section(file: string, hunks: string[], from = `a/${file}`): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- ${from}`,
    `+++ b/${file}`,
    ...hunks,
  ].join('\n');
}

describe('parseDiffHunks', () => {
  it('reads each hunk’s new-side range, with several per file', () => {
    const diff = section('src/a.ts', [
      '@@ -3,2 +3,4 @@ function a() {',
      '-gone',
      '-gone',
      '+one',
      '+two',
      '+three',
      '+four',
      '@@ -40 +42 @@',
      '-old',
      '+new',
    ]);
    expect(parseDiffHunks(diff)).toEqual(
      new Map([
        [
          'src/a.ts',
          [
            { start: 3, end: 6 },
            { start: 42, end: 42 },
          ],
        ],
      ]),
    );
  });

  it('turns a pure deletion into the lines either side of the cut', () => {
    // `+7,0` names the line BEFORE the cut; the code that closed over the
    // deleted lines is that line and the one after it.
    const diff = section('src/a.ts', ['@@ -8,3 +7,0 @@', '-a', '-b', '-c']);
    expect(parseDiffHunks(diff).get('src/a.ts')).toEqual([
      { start: 7, end: 8 },
    ]);
  });

  it('keeps a deletion at the top of the file on line 1', () => {
    const diff = section('src/a.ts', ['@@ -1,2 +0,0 @@', '-a', '-b']);
    expect(parseDiffHunks(diff).get('src/a.ts')).toEqual([
      { start: 1, end: 1 },
    ]);
  });

  it('leaves a file added since the base out, so it is mutated whole', () => {
    const diff = section(
      'src/new.ts',
      ['@@ -0,0 +1,3 @@', '+a', '+b', '+c'],
      '/dev/null',
    );
    expect(parseDiffHunks(diff).has('src/new.ts')).toBe(false);
  });

  it('leaves a deleted file out', () => {
    const diff = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
    ].join('\n');
    expect(parseDiffHunks(diff).size).toBe(0);
  });

  it('files a renamed file’s hunks under its new name', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual(
      new Map([['src/new.ts', [{ start: 5, end: 5 }]]]),
    );
  });

  it('reads CRLF output', () => {
    const diff = section('src/a.ts', [
      '@@ -3 +3,2 @@',
      '-old',
      '+one',
      '+two',
    ]).replaceAll('\n', '\r\n');
    expect(parseDiffHunks(diff)).toEqual(
      new Map([['src/a.ts', [{ start: 3, end: 4 }]]]),
    );
  });

  it('reads a path git ended with a tab because it holds a space', () => {
    const diff = [
      'diff --git a/src/my file.ts b/src/my file.ts',
      '--- a/src/my file.ts\t',
      '+++ b/src/my file.ts\t',
      '@@ -2 +2 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff).keys().toArray()).toEqual(['src/my file.ts']);
  });

  it('drops only the tab that ends a path, not one inside it', () => {
    const diff = [
      'diff --git a/src/a\tb.ts b/src/a\tb.ts',
      '--- a/src/a\tb.ts\t',
      '+++ b/src/a\tb.ts\t',
      '@@ -2 +2 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff).keys().toArray()).toEqual(['src/a\tb.ts']);
  });

  it('reads a file whose name looks like a hunk header', () => {
    const name = 'src/@@ -1 +1 @@.ts';
    const diff = [
      `diff --git a/${name} b/${name}`,
      'index 1111111..2222222 100644',
      `--- a/${name}\t`,
      `+++ b/${name}\t`,
      '@@ -5 +5 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual(
      new Map([[name, [{ start: 5, end: 5 }]]]),
    );
  });

  it('leaves a quoted path out, which would never match a changed-file name', () => {
    const diff = [
      String.raw`diff --git "a/src/\303\251.ts" "b/src/\303\251.ts"`,
      String.raw`--- "a/src/\303\251.ts"`,
      String.raw`+++ "b/src/\303\251.ts"`,
      '@@ -2 +2 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff).size).toBe(0);
  });

  it('does not credit one file’s hunks to a binary file after it', () => {
    const diff = [
      section('src/a.ts', ['@@ -1 +1 @@', '-old', '+new']),
      'diff --git a/src/b.bin b/src/b.bin',
      'index 1111111..2222222 100644',
      'Binary files a/src/b.bin and b/src/b.bin differ',
      '@@ -9 +9 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual(
      new Map([['src/a.ts', [{ start: 1, end: 1 }]]]),
    );
  });

  it('reads a section that has no diff line of its own', () => {
    const diff = [
      section('src/a.ts', ['@@ -1 +1 @@', '-old', '+new']),
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -7 +7 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual(
      new Map([
        ['src/a.ts', [{ start: 1, end: 1 }]],
        ['src/b.ts', [{ start: 7, end: 7 }]],
      ]),
    );
  });

  it('ignores a removed or added line that looks like a header', () => {
    // `-- not a header` removed and `++ b/src/other.ts` added.
    const diff = section('src/a.ts', [
      '@@ -1,2 +1,2 @@',
      '--- not a header',
      '-plain',
      '+plain',
      '+++ b/src/other.ts',
      '@@ -9 +9 @@',
      '-old',
      '+new',
    ]);
    expect(parseDiffHunks(diff)).toEqual(
      new Map([
        [
          'src/a.ts',
          [
            { start: 1, end: 2 },
            { start: 9, end: 9 },
          ],
        ],
      ]),
    );
  });

  it('does not count a no-newline marker as a line of the hunk', () => {
    // The old side's last line had no newline; the new side adds a line
    // whose text is `++ b/fake.ts` after it.
    const diff = section('src/a.ts', [
      '@@ -3 +3,2 @@',
      '-last',
      String.raw`\ No newline at end of file`,
      '+last',
      '+++ b/fake.ts',
      '@@ -9 +10 @@',
      '-old',
      '+new',
    ]);
    expect(parseDiffHunks(diff)).toEqual(
      new Map([
        [
          'src/a.ts',
          [
            { start: 3, end: 4 },
            { start: 10, end: 10 },
          ],
        ],
      ]),
    );
  });

  it('skips a hunk body by two-digit old and new counts', () => {
    const diff = section('src/a.ts', [
      '@@ -20,12 +20,15 @@',
      ...Array.from({ length: 12 }, () => '-old'),
      ...Array.from({ length: 14 }, () => '+new'),
      // The last body line, which an under-count would read as a header.
      '+++ b/fake.ts',
      '@@ -60 +63 @@',
      '-old',
      '+new',
    ]);
    expect(parseDiffHunks(diff)).toEqual(
      new Map([
        [
          'src/a.ts',
          [
            { start: 20, end: 34 },
            { start: 63, end: 63 },
          ],
        ],
      ]),
    );
  });

  it('is empty for no diff at all', () => {
    expect(parseDiffHunks('').size).toBe(0);
  });
});

describe('countLines', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo', 2],
    ['one\ntwo\n', 2],
    ['one\r\ntwo\r\n', 2],
  ])('counts %j as %i lines', (text, lines) => {
    expect(countLines(text)).toBe(lines);
  });
});

const settings = { lines: true, padding: 2, wholeFileAbove: 0.5 };

describe('planFileRanges', () => {
  it.each<[string, LineRange[], number, LineRange[] | undefined]>([
    [
      'pads a hunk on both sides',
      [{ start: 50, end: 50 }],
      100,
      [{ start: 48, end: 52 }],
    ],
    [
      'clamps padding at the top of the file',
      [{ start: 1, end: 1 }],
      100,
      [{ start: 1, end: 3 }],
    ],
    [
      'clamps padding at the end of the file',
      [{ start: 100, end: 100 }],
      100,
      [{ start: 98, end: 100 }],
    ],
    [
      'keeps hunks apart when their padding does not meet',
      [
        { start: 10, end: 10 },
        { start: 16, end: 16 },
      ],
      100,
      [
        { start: 8, end: 12 },
        { start: 14, end: 18 },
      ],
    ],
    [
      'merges hunks whose padding touches',
      [
        { start: 10, end: 10 },
        { start: 15, end: 15 },
      ],
      100,
      [{ start: 8, end: 17 }],
    ],
    [
      'merges overlapping hunks given out of order',
      [
        { start: 30, end: 40 },
        { start: 20, end: 35 },
      ],
      100,
      [{ start: 18, end: 42 }],
    ],
    [
      'keeps the earlier end when a later hunk sits inside it',
      [
        { start: 20, end: 40 },
        { start: 25, end: 26 },
      ],
      100,
      [{ start: 18, end: 42 }],
    ],
  ])('%s', (_label, ranges, lineCount, expected) => {
    expect(planFileRanges(ranges, lineCount, settings)).toEqual(expected);
  });

  it('mutates the whole file once the ranges cover more than the threshold', () => {
    // 1–11 of 20 lines is 55%, above 50%.
    expect(
      planFileRanges([{ start: 3, end: 9 }], 20, settings),
    ).toBeUndefined();
  });

  it('keeps ranges at exactly the threshold', () => {
    // 1–10 of 20 lines is 50%, not above it.
    expect(planFileRanges([{ start: 3, end: 8 }], 20, settings)).toEqual([
      { start: 1, end: 10 },
    ]);
  });

  it('mutates the whole file when line ranges are off', () => {
    expect(
      planFileRanges([{ start: 50, end: 50 }], 100, {
        ...settings,
        lines: false,
      }),
    ).toBeUndefined();
  });

  it('mutates the whole file when it has no hunks to go on', () => {
    expect(planFileRanges([], 100, settings)).toBeUndefined();
  });

  it('mutates the whole file when its length is unknown or zero', () => {
    expect(planFileRanges([{ start: 1, end: 1 }], 0, settings)).toBeUndefined();
  });

  it('keeps a hunk past the end of the file inside it', () => {
    expect(planFileRanges([{ start: 120, end: 130 }], 100, settings)).toEqual([
      { start: 100, end: 100 },
    ]);
  });

  it('defaults to five lines of padding and whole files above 40%', () => {
    expect(DEFAULT_MUTATION_SCOPE).toEqual({
      lines: true,
      padding: 5,
      wholeFileAbove: 0.4,
    });
  });
});

describe('planMutateRanges', () => {
  const hunks = new Map([
    ['src/big.ts', [{ start: 150, end: 150 }]],
    ['src/small.ts', [{ start: 2, end: 2 }]],
    ['src/unread.ts', [{ start: 2, end: 2 }]],
  ]);
  const lines = new Map([
    ['src/big.ts', 300],
    ['src/small.ts', 4],
    ['src/new.ts', 300],
  ]);

  it('plans ranges only for the files that earn them', () => {
    const plan = planMutateRanges(
      ['src/big.ts', 'src/small.ts', 'src/new.ts', 'src/unread.ts'],
      hunks,
      (file) => lines.get(file) ?? 0,
      settings,
    );
    expect(plan).toEqual(new Map([['src/big.ts', [{ start: 148, end: 152 }]]]));
  });

  it('plans nothing for a file outside the mutate set', () => {
    const plan = planMutateRanges([], hunks, () => 300, settings);
    expect(plan.size).toBe(0);
  });
});

describe('mutateEntries', () => {
  it('names every file once at least, as ranges or whole', () => {
    const plan = new Map([
      [
        'src/big.ts',
        [
          { start: 10, end: 20 },
          { start: 40, end: 41 },
        ],
      ],
    ]);
    expect(mutateEntries(['src/big.ts', 'src/new.ts'], plan)).toEqual([
      'src/big.ts:10-20',
      'src/big.ts:40-41',
      'src/new.ts',
    ]);
  });
});

describe('isLocationInRanges', () => {
  const ranges = [{ start: 10, end: 20 }];

  it.each([
    ['wholly inside', 10, 20, true],
    ['inside, on one line', 15, 15, true],
    ['starting before the range', 9, 12, false],
    ['ending after the range', 18, 21, false],
    ['after the range', 30, 30, false],
  ])('is %s → %s', (_label, start, end, inside) => {
    expect(isLocationInRanges({ start, end }, ranges)).toBe(inside);
  });

  it('is in any one of several ranges', () => {
    expect(
      isLocationInRanges({ start: 41, end: 41 }, [
        ...ranges,
        { start: 40, end: 42 },
      ]),
    ).toBe(true);
  });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

function recordingExec(answer: (args: readonly string[]) => ExecResult): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = (_command, args) => {
    calls.push(args);
    return Promise.resolve(answer(args));
  };
  return { exec, calls };
}

const hunkDiff = section('src/a.ts', ['@@ -3 +3 @@']);

describe('changedLineRanges', () => {
  it('diffs the working tree against the base, as the changed-file list does', async () => {
    const { exec, calls } = recordingExec((args) =>
      ok(args[0] === 'rev-parse' ? 'abc\n' : hunkDiff),
    );
    const ranges = await changedLineRanges(exec, '/repo', {
      baseBranch: 'main',
    });
    expect(ranges).toEqual(new Map([['src/a.ts', [{ start: 3, end: 3 }]]]));
    const diff = calls.find((args) => args[0] === 'diff') ?? [];
    expect(diff.at(-1)).toBe('main');
    expect(diff).toEqual(
      expect.arrayContaining([
        '--unified=0',
        '--diff-filter=ACM',
        '--no-color',
        '--no-ext-diff',
        '--src-prefix=a/',
        '--dst-prefix=b/',
      ]),
    );
    expect(diff).not.toContain('--cached');
  });

  it('diffs the index alone for a staged run, with no base needed', async () => {
    const { exec, calls } = recordingExec(() => ok(hunkDiff));
    const ranges = await changedLineRanges(exec, '/repo', {
      baseBranch: 'main',
      changedScope: 'staged',
    });
    expect(ranges.has('src/a.ts')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--cached');
    expect(calls[0]).not.toContain('main');
  });

  it('falls back to the origin base like the changed-file list', async () => {
    const { exec, calls } = recordingExec((args) => {
      if (args[0] !== 'rev-parse') {
        return ok(hunkDiff);
      }
      return args.at(-1)?.startsWith('origin/') === true
        ? ok('abc\n')
        : { stdout: '', stderr: '', code: 1 };
    });
    await changedLineRanges(exec, '/repo', { baseBranch: 'main' });
    expect(calls.find((args) => args[0] === 'diff')?.at(-1)).toBe(
      'origin/main',
    );
  });

  it('knows no ranges when no base resolves, so every file goes whole', async () => {
    const { exec, calls } = recordingExec(() => ({
      stdout: '',
      stderr: '',
      code: 1,
    }));
    const ranges = await changedLineRanges(exec, '/repo', {
      baseBranch: 'main',
    });
    expect(ranges.size).toBe(0);
    expect(calls.some((args) => args[0] === 'diff')).toBe(false);
  });

  it.each<[string, ExecResult]>([
    ['exits non-zero', { stdout: hunkDiff, stderr: 'boom', code: 128 }],
    ['is killed', { stdout: hunkDiff, stderr: '', code: 0, signal: 'SIGTERM' }],
    [
      'cannot start',
      { stdout: hunkDiff, stderr: '', code: 1, spawnFailed: true },
    ],
  ])('knows no ranges when the diff %s', async (_label, failed) => {
    const { exec } = recordingExec((args) =>
      args[0] === 'rev-parse' ? ok('abc\n') : failed,
    );
    const ranges = await changedLineRanges(exec, '/repo', {
      baseBranch: 'main',
    });
    expect(ranges.size).toBe(0);
  });
});

const bigDiff = section('src/a.ts', ['@@ -150 +150 @@']);

function runSources(readFile: (filePath: string) => Promise<string>): {
  exec: Exec;
  repoRoot: string;
  readFile: (filePath: string) => Promise<string>;
} {
  const { exec } = recordingExec((args) =>
    ok(args[0] === 'diff' ? bigDiff : 'abc\n'),
  );
  return { exec, repoRoot: '/repo', readFile };
}

describe('planRunRanges', () => {
  it('plans from the diff and each changed file’s length on disk', async () => {
    const read: string[] = [];
    const plan = await planRunRanges(
      runSources((filePath) => {
        read.push(filePath);
        return Promise.resolve('x\n'.repeat(300));
      }),
      { baseBranch: 'main' },
      ['src/a.ts', 'src/b.ts'],
      settings,
    );
    expect(plan).toEqual(new Map([['src/a.ts', [{ start: 148, end: 152 }]]]));
    expect(read).toEqual(['/repo/src/a.ts']);
  });

  it('mutates a file it cannot read whole', async () => {
    const plan = await planRunRanges(
      runSources(() => Promise.reject(new Error('ENOENT'))),
      { baseBranch: 'main' },
      ['src/a.ts'],
      settings,
    );
    expect(plan.size).toBe(0);
  });

  it('mutates an unread file whole even when no share is too large', async () => {
    // At `wholeFileAbove: 1` only a file of unknown length goes whole: any
    // length it were given would put one padded line at or below 100%.
    const plan = await planRunRanges(
      runSources(() => Promise.reject(new Error('EACCES'))),
      { baseBranch: 'main' },
      ['src/a.ts'],
      { lines: true, padding: 0, wholeFileAbove: 1 },
    );
    expect(plan.size).toBe(0);
  });

  it('asks git nothing when line ranges are off', async () => {
    const { exec, calls } = recordingExec(() => ok(bigDiff));
    const plan = await planRunRanges(
      { exec, repoRoot: '/repo', readFile: () => Promise.resolve('x\n') },
      { baseBranch: 'main' },
      ['src/a.ts'],
      { ...settings, lines: false },
    );
    expect(plan.size).toBe(0);
    expect(calls).toEqual([]);
  });
});
