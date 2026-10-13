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

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  coveringTests,
  readTestCorpus,
  withCoveringTests,
} from '../src/covering-tests.js';
import {
  createImportResolver,
  type ImportResolver,
} from '../src/import-graph.js';
import { repoSourceReader } from '../src/repo-source.js';

/**
 * An import graph declared outright: what each file imports, whatever its
 * text says. Which files a text imports is `import-graph.ts`'s question, and
 * its own tests answer it against real TypeScript; these tests are about what
 * the lookup does with the answer.
 */
/**
A reader or loader with nothing to give: an unreadable file, or no TypeScript.
*/
function nothing(): undefined {
  return;
}

function textOf(file: string): string {
  return `text of ${file}`;
}

function graph(edges: Record<string, readonly string[]>): ImportResolver {
  const table = new Map(Object.entries(edges));
  return (fromFile) => [...(table.get(fromFile) ?? [])];
}

describe('coveringTests', () => {
  it('finds a test that imports the file, whatever the test is called', () => {
    // The #69 shape exactly: the importer is named after its subject area, so
    // no filename guess could reach it.
    expect(
      coveringTests(
        'guardrails-core/src/verify/index.ts',
        new Map([['guardrails-core/test/verify/orchestrator.test.ts', '']]),
        graph({
          'guardrails-core/test/verify/orchestrator.test.ts': [
            'guardrails-core/src/verify/index.ts',
          ],
        }),
      ),
    ).toEqual(['guardrails-core/test/verify/orchestrator.test.ts']);
  });

  it('asks about each test with that test’s own text', () => {
    const asked: [string, string][] = [];
    coveringTests(
      'src/a.ts',
      new Map([
        ['test/a.test.ts', 'text of a'],
        ['test/b.test.ts', 'text of b'],
      ]),
      (fromFile, text) => {
        asked.push([fromFile, text]);
        return [];
      },
    );
    expect(asked).toEqual([
      ['test/a.test.ts', 'text of a'],
      ['test/b.test.ts', 'text of b'],
    ]);
  });

  it('does not match a sibling whose name is a prefix', () => {
    // `src/a.ts` and `src/ab.ts` are different files; a `startsWith` check
    // would attribute one's tests to the other.
    expect(
      coveringTests(
        'src/a.ts',
        new Map([['test/ab.test.ts', '']]),
        graph({ 'test/ab.test.ts': ['src/ab.ts'] }),
      ),
    ).toEqual([]);
  });

  it('lists every test that imports the file, in a stable order', () => {
    expect(
      coveringTests(
        'src/a.ts',
        new Map([
          ['test/z.test.ts', ''],
          ['test/b.test.ts', ''],
        ]),
        graph({
          'test/z.test.ts': ['src/a.ts'],
          'test/b.test.ts': ['src/other.ts', 'src/a.ts'],
        }),
      ),
    ).toEqual(['test/b.test.ts', 'test/z.test.ts']);
  });

  it('answers empty when nothing imports the file', () => {
    expect(
      coveringTests(
        'src/orphan.ts',
        new Map([['test/a.test.ts', '']]),
        graph({ 'test/a.test.ts': ['src/a.ts'] }),
      ),
    ).toEqual([]);
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
  const imports = graph({
    'test/parent.test.ts': ['src/parent.ts'],
    'test/helper.test.ts': ['src/helper.ts'],
    'test/a.test.ts': ['src/a.ts'],
    'test/mixed.test.ts': ['src/unrelated.ts', 'src/parent.ts'],
    'src/parent.ts': ['src/helper.ts'],
    'src/a.ts': ['src/b.ts'],
    'src/b.ts': ['src/target.ts'],
  });

  it('finds a test that reaches the file through a module it imports', () => {
    expect(
      coveringTests(
        'src/helper.ts',
        new Map([['test/parent.test.ts', '']]),
        imports,
        textOf,
      ),
    ).toEqual(['test/parent.test.ts']);
  });

  it('asks about the bridging module with the module’s own text', () => {
    const asked: [string, string][] = [];
    coveringTests(
      'src/helper.ts',
      new Map([['test/parent.test.ts', '']]),
      (fromFile, text) => {
        asked.push([fromFile, text]);
        return imports(fromFile, text);
      },
      textOf,
    );
    expect(asked).toContainEqual(['src/parent.ts', 'text of src/parent.ts']);
  });

  it('prefers direct importers when there are any', () => {
    // The hint stays as narrow as the evidence allows: a test that imports
    // the file itself is the one to strengthen.
    expect(
      coveringTests(
        'src/helper.ts',
        new Map([
          ['test/helper.test.ts', ''],
          ['test/parent.test.ts', ''],
        ]),
        imports,
        textOf,
      ),
    ).toEqual(['test/helper.test.ts']);
  });

  it('stops after one hop', () => {
    // Every further hop widens what the fixer may edit, for evidence that
    // gets weaker each time.
    expect(
      coveringTests(
        'src/target.ts',
        new Map([['test/a.test.ts', '']]),
        imports,
        textOf,
      ),
    ).toEqual([]);
  });

  it('stays direct-only without a source reader', () => {
    expect(
      coveringTests(
        'src/helper.ts',
        new Map([['test/parent.test.ts', '']]),
        imports,
      ),
    ).toEqual([]);
  });

  it('treats a module it cannot read as no bridge', () => {
    expect(
      coveringTests(
        'src/helper.ts',
        new Map([['test/parent.test.ts', '']]),
        imports,
        nothing,
      ),
    ).toEqual([]);
  });

  it('finds a test whose bridging import is not its only import', () => {
    expect(
      coveringTests(
        'src/helper.ts',
        new Map([['test/mixed.test.ts', '']]),
        imports,
        textOf,
      ),
    ).toEqual(['test/mixed.test.ts']);
  });

  it('reads each module at most once, whether or not it bridges', () => {
    const reads: string[] = [];
    const countingReader = (file: string): string => {
      reads.push(file);
      return textOf(file);
    };
    coveringTests(
      'src/helper.ts',
      new Map([
        ['test/one.test.ts', ''],
        ['test/two.test.ts', ''],
      ]),
      graph({
        'test/one.test.ts': ['src/unrelated.ts', 'src/parent.ts'],
        'test/two.test.ts': ['src/unrelated.ts', 'src/parent.ts'],
        'src/parent.ts': ['src/helper.ts'],
      }),
      countingReader,
    );
    expect(reads.toSorted((left, right) => left.localeCompare(right))).toEqual([
      'src/parent.ts',
      'src/unrelated.ts',
    ]);
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

  const testFiles = new Map([['test/a.test.ts', '']]);
  const imports = graph({ 'test/a.test.ts': ['src/a.ts'] });

  it('attaches the covering tests to a violation', () => {
    expect(
      withCoveringTests(
        [base],
        () => testFiles,
        () => imports,
      ),
    ).toEqual([{ ...base, relatedTests: ['test/a.test.ts'] }]);
  });

  it('adds no key when nothing imports the file', () => {
    // The manifest stays terse, exactly as `withGuidance` leaves an unknown
    // class untouched. An empty array would read as "searched and there is no
    // test", which is a different claim from "not computed".
    expect(
      withCoveringTests(
        [{ ...base, file: 'src/orphan.ts' }],
        () => testFiles,
        () => imports,
      ),
    ).toEqual([{ ...base, file: 'src/orphan.ts' }]);
  });

  it('adds no key anywhere without a resolver (no TypeScript installed)', () => {
    // The same degradation as a corpus past the cap: no hint, and the fixer
    // searches for itself. Never a guess.
    expect(
      withCoveringTests(
        [base, { ...base, file: 'src/b.ts' }],
        () => testFiles,
        nothing,
      ),
    ).toEqual([base, { ...base, file: 'src/b.ts' }]);
  });

  it('leaves a violation that is already in a test file alone', () => {
    // Its own file IS the test. Naming it back would be noise, and naming the
    // files it imports would point the fixer at production code.
    const inTest = { ...base, file: 'test/a.test.ts' };
    expect(
      withCoveringTests(
        [inTest],
        () => testFiles,
        () => imports,
      ),
    ).toEqual([inTest]);
  });

  it('loads neither the corpus nor TypeScript when every violation is in a test', () => {
    // A clean gate, or one blocking only on test files, never pays for
    // loading TypeScript.
    let loads = 0;
    withCoveringTests(
      [{ ...base, file: 'test/a.test.ts' }],
      () => {
        loads += 1;
        return testFiles;
      },
      () => {
        loads += 1;
        return imports;
      },
    );
    expect(loads).toBe(0);
  });

  it('reads no corpus when there is no resolver to ask', () => {
    // A JS-only repo blocks without TypeScript; reading up to 800 test files
    // only to discard them is the whole cost with none of the answer.
    let corpusLoads = 0;
    withCoveringTests(
      [base],
      () => {
        corpusLoads += 1;
        return testFiles;
      },
      nothing,
    );
    expect(corpusLoads).toBe(0);
  });

  it('loads the corpus and the resolver once for many violations', () => {
    // The corpus is every test file in the repo, and the resolver loads
    // TypeScript. Re-loading either per violation would turn a 30-mutant
    // manifest into 30 of each.
    const loads: string[] = [];
    withCoveringTests(
      [base, { ...base, line: 2 }, { ...base, file: 'src/b.ts' }],
      () => {
        loads.push('corpus');
        return testFiles;
      },
      () => {
        loads.push('imports');
        return imports;
      },
    );
    expect(loads).toEqual(['imports', 'corpus']);
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
      () => imports,
    );
    expect(scans).toBe(1);
  });

  it('does not overwrite relatedTests already present', () => {
    const carried = { ...base, relatedTests: ['test/kept.test.ts'] };
    expect(
      withCoveringTests(
        [carried],
        () => testFiles,
        () => imports,
      ),
    ).toEqual([carried]);
  });

  it('answers the violations unchanged when the corpus is empty', () => {
    // A repo with no test files, or one whose corpus exceeded the cap: the
    // enrichment degrades to doing nothing rather than to a wrong answer.
    expect(
      withCoveringTests(
        [base],
        () => new Map(),
        () => imports,
      ),
    ).toEqual([base]);
  });

  it('passes the source reader through for the one-hop lookup', () => {
    expect(
      withCoveringTests(
        [{ ...base, file: 'src/helper.ts' }],
        () => new Map([['test/parent.test.ts', '']]),
        () =>
          graph({
            'test/parent.test.ts': ['src/parent.ts'],
            'src/parent.ts': ['src/helper.ts'],
          }),
        () => '',
      ),
    ).toEqual([
      {
        ...base,
        file: 'src/helper.ts',
        relatedTests: ['test/parent.test.ts'],
      },
    ]);
  });
});

describe('coveringTests — end to end on a real repo', () => {
  /**
   * The issues this replaced a regex for, through the real resolver and the
   * real reader: #118's barrel import and prose, and #120's alias.
   */
  let root: string;

  function write(file: string, contents: string): void {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }

  function lookup(target: string, testFile: string, text: string): string[] {
    const imports = createImportResolver(root, () => ts);
    if (imports === undefined) {
      throw new Error('typescript did not load');
    }
    return coveringTests(
      target,
      new Map([[testFile, text]]),
      imports,
      repoSourceReader(root),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'covering-e2e-'));
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@/*': ['./src/*'] },
        },
      }),
    );
    write('src/a.ts', 'export const a = 1;\n');
    write('src/lib/index.ts', `export * from '../a';\n`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reaches a file through a barrel directory a test imports', () => {
    expect(
      lookup('src/a.ts', 'test/x.test.ts', `import { a } from '../src/lib';`),
    ).toEqual(['test/x.test.ts']);
  });

  it('reaches a file through an alias, directly and through a barrel', () => {
    expect(
      lookup('src/a.ts', 'test/x.test.ts', `import { a } from '@/a';`),
    ).toEqual(['test/x.test.ts']);
    expect(
      lookup('src/a.ts', 'test/y.test.ts', `import { a } from '@/lib';`),
    ).toEqual(['test/y.test.ts']);
  });

  it('survives a "." produced by prose between two quoted strings', () => {
    // #118's repro B: this crashed the commit gate with EISDIR.
    expect(
      lookup(
        'src/a.ts',
        'test/y.test.ts',
        '// cards in `data-part="rail"` beside it. "The harness',
      ),
    ).toEqual([]);
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
