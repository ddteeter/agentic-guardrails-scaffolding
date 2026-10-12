/**
 * Which test files exercise a violated file.
 *
 * The second half of the fixer-search fix (plan.md, "fixer-loop hardening").
 * `Grep` lets a fixer FIND the test; this means it usually does not have to
 * look. A violation carries the test files that import the file it is in, so
 * "where does the missing assertion go" is answered in the manifest the fixer
 * already reads — the same channel, and the same reasoning, as `guidance`.
 *
 * Resolution is by import specifier rather than by filename convention,
 * because convention is exactly what failed: this repo's tests for
 * `src/verify/index.ts` live in `test/verify/orchestrator.test.ts`, a name
 * containing neither the module's name nor the symbol's.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoSourceReader } from '../src/repo-source.js';
import {
  coveringTests,
  readTestCorpus,
  withCoveringTests,
} from '../src/covering-tests.js';

describe('coveringTests', () => {
  it('finds a test that imports the file, whatever the test is called', () => {
    // The #69 shape exactly: the importer is named after its subject area, so
    // no filename guess could reach it.
    expect(
      coveringTests(
        'guardrails-core/src/verify/index.ts',
        new Map([
          [
            'guardrails-core/test/verify/orchestrator.test.ts',
            `import { runVerify } from '../../src/verify/index.js';`,
          ],
        ]),
      ),
    ).toEqual(['guardrails-core/test/verify/orchestrator.test.ts']);
  });

  it('resolves a .js specifier to the .ts file it means', () => {
    // ESM TypeScript imports name the EMITTED file. A matcher comparing raw
    // specifiers would never match anything in a repo like this one.
    expect(
      coveringTests(
        'src/a.ts',
        new Map([['test/a.test.ts', `import { a } from '../src/a.js';`]]),
      ),
    ).toEqual(['test/a.test.ts']);
  });

  it('resolves a .tsx file from a .js specifier too', () => {
    expect(
      coveringTests(
        'src/ui/widget.tsx',
        new Map([
          ['test/widget.test.ts', `import { W } from '../src/ui/widget.js';`],
        ]),
      ),
    ).toEqual(['test/widget.test.ts']);
  });

  it('resolves .jsx, .mjs and .cjs specifiers to their TypeScript sources', () => {
    // One row of the ending table each. Only `.js` was exercised before, so
    // the other three rows could have been emptied with every test still
    // green — and a repo writing `.mjs` specifiers would have silently got no
    // hints at all.
    expect(
      coveringTests(
        'src/a.tsx',
        new Map([['test/a.test.ts', `import { a } from '../src/a.jsx';`]]),
      ),
    ).toEqual(['test/a.test.ts']);
    expect(
      coveringTests(
        'src/b.mts',
        new Map([['test/b.test.ts', `import { b } from '../src/b.mjs';`]]),
      ),
    ).toEqual(['test/b.test.ts']);
    expect(
      coveringTests(
        'src/c.cts',
        new Map([['test/c.test.ts', `const c = require('../src/c.cjs');`]]),
      ),
    ).toEqual(['test/c.test.ts']);
  });

  it('resolves an extensionless specifier to each extension it may mean', () => {
    for (const [target, name] of [
      ['src/a.tsx', 'a'],
      ['src/b.mts', 'b'],
      ['src/c.cts', 'c'],
      ['src/d.jsx', 'd'],
    ] as const) {
      expect(
        coveringTests(
          target,
          new Map([['test/x.test.ts', `import { x } from '../src/${name}';`]]),
        ),
      ).toEqual(['test/x.test.ts']);
    }
  });

  it('resolves an extensionless specifier', () => {
    expect(
      coveringTests(
        'src/a.ts',
        new Map([['test/a.test.ts', `import { a } from '../src/a';`]]),
      ),
    ).toEqual(['test/a.test.ts']);
  });

  it('resolves a directory specifier to its index file', () => {
    expect(
      coveringTests(
        'src/verify/index.ts',
        new Map([['test/v.test.ts', `import { x } from '../src/verify';`]]),
      ),
    ).toEqual(['test/v.test.ts']);
  });

  it('ignores a package specifier that merely looks similar', () => {
    // `vitest` and `node:path` are not relative, and nothing about them can
    // resolve to a repo file. A substring matcher would be fooled by a bare
    // specifier ending in the same name.
    expect(
      coveringTests(
        'src/path.ts',
        new Map([['test/a.test.ts', `import path from 'node:path';`]]),
      ),
    ).toEqual([]);
  });

  it('does not match a sibling whose name is a prefix', () => {
    // `src/a.ts` and `src/ab.ts` are different files; a `startsWith` check
    // would attribute one's tests to the other.
    expect(
      coveringTests(
        'src/a.ts',
        new Map([['test/ab.test.ts', `import { ab } from '../src/ab.js';`]]),
      ),
    ).toEqual([]);
  });

  it('lists every test that imports the file, in a stable order', () => {
    expect(
      coveringTests(
        'src/a.ts',
        new Map([
          ['test/z.test.ts', `import { a } from '../src/a.js';`],
          ['test/b.test.ts', `import { a } from '../src/a.js';`],
        ]),
      ),
    ).toEqual(['test/b.test.ts', 'test/z.test.ts']);
  });

  it('answers empty when nothing imports the file', () => {
    expect(
      coveringTests(
        'src/orphan.ts',
        new Map([['test/a.test.ts', `import { a } from '../src/a.js';`]]),
      ),
    ).toEqual([]);
  });

  it('reads a require and a dynamic import, not only static syntax', () => {
    expect(
      coveringTests(
        'src/a.ts',
        new Map([
          ['test/a.test.ts', `const { a } = require('../src/a.js');`],
          ['test/b.test.ts', `await import('../src/a.js');`],
        ]),
      ),
    ).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });
});

describe('withCoveringTests', () => {
  const base = {
    ruleId: 'stryker/survived',
    file: 'src/a.ts',
    message: 'm',
    severity: 'error' as const,
    fixable: false,
    tool: 'stryker',
  };

  const testFiles = new Map([
    ['test/a.test.ts', `import { a } from '../src/a.js';`],
  ]);

  it('attaches the covering tests to a violation', () => {
    expect(withCoveringTests([base], () => testFiles)).toEqual([
      { ...base, relatedTests: ['test/a.test.ts'] },
    ]);
  });

  it('adds no key when nothing imports the file', () => {
    // The manifest stays terse, exactly as `withGuidance` leaves an unknown
    // class untouched. An empty array would read as "searched and there is no
    // test", which is a different claim from "not computed".
    expect(
      withCoveringTests([{ ...base, file: 'src/orphan.ts' }], () => testFiles),
    ).toEqual([{ ...base, file: 'src/orphan.ts' }]);
  });

  it('leaves a violation that is already in a test file alone', () => {
    // Its own file IS the test. Naming it back would be noise, and naming the
    // files it imports would point the fixer at production code.
    const inTest = { ...base, file: 'test/a.test.ts' };
    expect(withCoveringTests([inTest], () => testFiles)).toEqual([inTest]);
  });

  it('reads the test corpus once for many violations in one file', () => {
    // The corpus is every test file in the repo. Re-reading it per violation
    // would turn a 30-mutant manifest into 30 full walks.
    let reads = 0;
    withCoveringTests(
      [base, { ...base, line: 2 }, { ...base, file: 'src/b.ts' }],
      () => {
        reads += 1;
        return testFiles;
      },
    );
    expect(reads).toBe(1);
  });

  it('resolves each file once, however many violations it has', () => {
    // Not a micro-optimisation: a 30-mutant manifest in one file would
    // otherwise walk the whole corpus 30 times, and the corpus is every test
    // file in the repository.
    let scans = 0;
    class CountingMap extends Map<string, string> {
      override [Symbol.iterator](): MapIterator<[string, string]> {
        scans += 1;
        return super[Symbol.iterator]();
      }
    }
    const counting = new CountingMap(testFiles);
    withCoveringTests(
      [base, { ...base, line: 2 }, { ...base, line: 3 }],
      () => counting,
    );
    expect(scans).toBe(1);
  });

  it('does not overwrite relatedTests already present', () => {
    const carried = { ...base, relatedTests: ['test/kept.test.ts'] };
    expect(withCoveringTests([carried], () => testFiles)).toEqual([carried]);
  });

  it('answers the violations unchanged when the corpus is empty', () => {
    // A repo with no test files, or one whose corpus exceeded the cap: the
    // enrichment degrades to doing nothing rather than to a wrong answer.
    expect(withCoveringTests([base], () => new Map())).toEqual([base]);
  });
});

describe('readTestCorpus', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'guardrails-corpus-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, contents: string): void {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  it('collects test files and ignores production ones', () => {
    write('src/a.ts', 'export const a = 1;');
    write('test/a.test.ts', `import { a } from '../src/a.js';`);
    expect(readTestCorpus(root).keys().toArray()).toEqual(['test/a.test.ts']);
  });

  it('finds a test nested several directories deep', () => {
    write('test/verify/deep/a.test.ts', 'x');
    expect(readTestCorpus(root).keys().toArray()).toEqual([
      'test/verify/deep/a.test.ts',
    ]);
  });

  it('never walks into node_modules', () => {
    // The difference between a walk and a hang: a dependency tree holds
    // hundreds of thousands of files, plenty of them named `*.test.ts`.
    write('node_modules/pkg/thing.test.ts', 'x');
    write('test/mine.test.ts', 'x');
    expect(readTestCorpus(root).keys().toArray()).toEqual([
      'test/mine.test.ts',
    ]);
  });

  it('skips a non-source file even inside a test directory', () => {
    // A fixture, a snapshot, a `.ts.txt` sample. The extension check is
    // anchored at the END for this reason — unanchored, `a.ts.txt` reads as a
    // source file.
    write('test/fixture.ts.txt', 'x');
    write('test/real.test.ts', 'x');
    expect(readTestCorpus(root).keys().toArray()).toEqual([
      'test/real.test.ts',
    ]);
  });

  it('reads a .mts helper in a test directory', () => {
    // Pins the `[cm]?` half of the extension pattern: `.mts` and `.cts` are
    // source files, and a pattern that rejected them would drop a whole
    // module system's worth of tests.
    write('test/helper.mts', 'x');
    expect(readTestCorpus(root).keys().toArray()).toEqual(['test/helper.mts']);
  });

  it('stops at the file ceiling', () => {
    write('test/a.test.ts', 'x');
    write('test/b.test.ts', 'x');
    write('test/c.test.ts', 'x');
    expect(readTestCorpus(root, { maxFiles: 2, maxBytes: 1000 }).size).toBe(2);
  });

  it('keeps a file exactly at the byte ceiling and drops the one past it', () => {
    write('test/small.test.ts', 'xxxxx');
    write('test/big.test.ts', 'xxxxxx');
    expect(
      readTestCorpus(root, { maxFiles: 10, maxBytes: 5 }).keys().toArray(),
    ).toEqual(['test/small.test.ts']);
  });

  it('skips a file it cannot read', () => {
    // A broken symlink is the portable version of an unreadable entry: it
    // appears in the directory listing and throws on read. The gate runs this
    // walk, so one bad entry must not take down the block the fixer waits for.
    write('test/fine.test.ts', 'x');
    symlinkSync(
      path.join(root, 'test', 'absent.ts'),
      path.join(root, 'test', 'broken.test.ts'),
    );
    expect(readTestCorpus(root).keys().toArray()).toEqual([
      'test/fine.test.ts',
    ]);
  });

  it('answers empty for a directory that does not exist', () => {
    // The gate runs this; an unreadable path must not throw out of it.
    expect(readTestCorpus(path.join(root, 'absent')).size).toBe(0);
  });
});

describe('coveringTests — one hop through the module a test imports', () => {
  /**
   * A helper extracted into its own file is exercised through its parent's
   * tests, which import the PARENT. Direct importers alone named no test for
   * it, so once the fixer scope-lock confined a fixer to its manifest's files
   * and their related tests, a fixer handed the helper's surviving mutants
   * could edit nothing that would kill them -- and extraction is the very fix
   * fixers reach for on a duplication finding.
   */
  const sources = new Map([
    ['src/parent.ts', `import { helper } from './helper.js';`],
    ['src/a.ts', `import { b } from './b.js';`],
    ['src/b.ts', `import { target } from './target.js';`],
  ]);
  const readSource = (file: string): string | undefined => sources.get(file);

  it('finds a test that reaches the file through a module it imports', () => {
    const testFiles = new Map([
      ['test/parent.test.ts', `import { parent } from '../src/parent.js';`],
    ]);
    expect(coveringTests('src/helper.ts', testFiles, readSource)).toEqual([
      'test/parent.test.ts',
    ]);
  });

  it('prefers direct importers when there are any', () => {
    // The hint stays as narrow as the evidence allows: a test that imports
    // the file itself is the one to strengthen.
    const testFiles = new Map([
      ['test/helper.test.ts', `import { helper } from '../src/helper.js';`],
      ['test/parent.test.ts', `import { parent } from '../src/parent.js';`],
    ]);
    expect(coveringTests('src/helper.ts', testFiles, readSource)).toEqual([
      'test/helper.test.ts',
    ]);
  });

  it('stops after one hop', () => {
    // Every further hop widens what the fixer may edit, for evidence that
    // gets weaker each time.
    const testFiles = new Map([
      ['test/a.test.ts', `import { a } from '../src/a.js';`],
    ]);
    expect(coveringTests('src/target.ts', testFiles, readSource)).toEqual([]);
  });

  it('stays direct-only without a source reader', () => {
    const testFiles = new Map([
      ['test/parent.test.ts', `import { parent } from '../src/parent.js';`],
    ]);
    expect(coveringTests('src/helper.ts', testFiles)).toEqual([]);
  });

  it('finds a test whose bridging import is not its only import', () => {
    const testFiles = new Map([
      [
        'test/mixed.test.ts',
        `import { x } from '../src/unrelated.js';\nimport { parent } from '../src/parent.js';`,
      ],
    ]);
    expect(coveringTests('src/helper.ts', testFiles, readSource)).toEqual([
      'test/mixed.test.ts',
    ]);
  });

  it('reads each module at most once, whether or not it bridges', () => {
    const reads: string[] = [];
    const countingReader = (file: string): string | undefined => {
      reads.push(file);
      return sources.get(file);
    };
    const testFiles = new Map([
      [
        'test/one.test.ts',
        `import { x } from '../src/unrelated.js';\nimport { parent } from '../src/parent.js';`,
      ],
      [
        'test/two.test.ts',
        `import { x } from '../src/unrelated.js';\nimport { parent } from '../src/parent.js';`,
      ],
    ]);
    coveringTests('src/helper.ts', testFiles, countingReader);
    expect(reads.filter((file) => file === 'src/parent.ts')).toEqual([
      'src/parent.ts',
    ]);
    expect(reads.filter((file) => file === 'src/unrelated.ts')).toEqual([
      'src/unrelated.ts',
    ]);
  });

  it('is wired through withCoveringTests', () => {
    const testFiles = new Map([
      ['test/parent.test.ts', `import { parent } from '../src/parent.js';`],
    ]);
    const violation = {
      ruleId: 'stryker/survived',
      file: 'src/helper.ts',
      message: 'm',
      severity: 'error' as const,
      fixable: false,
      tool: 'stryker',
    };
    expect(withCoveringTests([violation], () => testFiles, readSource)).toEqual(
      [{ ...violation, relatedTests: ['test/parent.test.ts'] }],
    );
  });
});

describe('coveringTests — specifiers that name a directory (#118)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'covering-dir-'));
    mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    mkdirSync(path.join(root, 'test'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(root, 'src', 'lib', 'index.ts'),
      `export * from '../a.js';\n`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reaches a file through a barrel directory a test imports', () => {
    // The issue's repro A: `../src/lib` means `../src/lib/index.ts`, and the
    // directory itself used to be read first and throw EISDIR.
    const testFiles = new Map([
      ['test/x.test.ts', `import { a } from '../src/lib';`],
    ]);
    expect(
      coveringTests('src/a.ts', testFiles, repoSourceReader(root)),
    ).toEqual(['test/x.test.ts']);
  });

  it('survives a "." produced by prose between two quoted strings', () => {
    // Repro B: `data-part="rail"` followed by `."The harness` puts a bare
    // `"."` between two quotes, which resolves to the test's own directory.
    const testFiles = new Map([
      [
        'test/y.test.ts',
        '// cards in `data-part="rail"` beside it. "The harness',
      ],
    ]);
    expect(
      coveringTests('src/a.ts', testFiles, repoSourceReader(root)),
    ).toEqual([]);
  });

  it('never reads an extensionless path, which is not a source file', () => {
    const reads: string[] = [];
    const reader = (file: string): string | undefined => {
      reads.push(file);
      return repoSourceReader(root)(file);
    };
    coveringTests(
      'src/a.ts',
      new Map([['test/x.test.ts', `import { a } from '../src/lib';`]]),
      reader,
    );
    expect(reads).not.toContain('src/lib');
    expect(reads).toContain('src/lib/index.ts');
    // Exactly the extension candidates and then the barrel, nothing else.
    expect(reads).toEqual([
      'src/lib.ts',
      'src/lib.tsx',
      'src/lib.mts',
      'src/lib.cts',
      'src/lib.js',
      'src/lib.jsx',
      'src/lib/index.ts',
    ]);
  });

  it('resolves a bare "." or ".." specifier to the directory index', () => {
    expect(
      coveringTests(
        'src/lib/index.ts',
        new Map([['src/lib/x.test.ts', `import { a } from '.';`]]),
      ),
    ).toEqual(['src/lib/x.test.ts']);
    expect(
      coveringTests(
        'src/index.ts',
        new Map([['src/lib/x.test.ts', `import { a } from '..';`]]),
      ),
    ).toEqual(['src/lib/x.test.ts']);
  });

  it('keeps a specifier written with its source extension', () => {
    expect(
      coveringTests(
        'src/a.ts',
        new Map([['test/x.test.ts', `import { a } from '../src/a.ts';`]]),
      ),
    ).toEqual(['test/x.test.ts']);
  });

  it('ignores a quoted dot-name that is not a relative path', () => {
    // `".a"` is a selector or a dotfile, never a relative specifier: those
    // start `./`, `../`, or are exactly `.` / `..`.
    const reads: string[] = [];
    coveringTests(
      'src/a.ts',
      new Map([['test/z.test.ts', `query(".a"); query('..ts');`]]),
      (file) => {
        reads.push(file);
      },
    );
    expect(reads).toEqual([]);
  });
});
