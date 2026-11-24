/**
 * Which cached tests import a changed test-support file (#197), directly or
 * through other modules. The mutation cache drops the kills those tests vouch
 * for and keeps the rest, so every answer here that could be short is
 * `undefined` instead — refuse everything — rather than a smaller set.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createImportersOf,
  importersOf,
  type ImportGraphSource,
} from '../../src/verify/importing-tests.js';

/**
 * A graph source over `graph` (module → the modules it imports), counting
 * reads. A module missing from `graph` cannot be read.
 */
function source(
  graph: Record<string, readonly string[] | 'untraceable'>,
  maxModules = 100,
): ImportGraphSource & { reads: string[] } {
  const reads: string[] = [];
  const modules = new Map(Object.entries(graph));
  return {
    reads,
    maxModules,
    read: (file) => {
      reads.push(file);
      return Promise.resolve(modules.has(file) ? file : undefined);
    },
    trace: (file) => {
      const imports = modules.get(file);
      return imports === 'untraceable' ? undefined : imports;
    },
  };
}

/**
The answer as plain arrays, for `toEqual`.
*/
function plain(
  answer: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): Record<string, string[]> | undefined {
  return (
    answer &&
    Object.fromEntries(
      [...answer].map(([file, tests]) => [
        file,
        [...tests].toSorted((a, b) => a.localeCompare(b)),
      ]),
    )
  );
}

describe('importersOf', () => {
  it('names the tests that import a support file directly', async () => {
    const graph = source({
      'a.test.ts': ['test/helper.ts'],
      'b.test.ts': [],
      'test/helper.ts': [],
    });
    expect(
      plain(
        await importersOf(
          graph,
          ['test/helper.ts'],
          ['a.test.ts', 'b.test.ts'],
        ),
      ),
    ).toEqual({ 'test/helper.ts': ['a.test.ts'] });
  });

  it('names the tests that reach a support file through other modules', async () => {
    const graph = source({
      'a.test.ts': ['test/harness.ts'],
      'b.test.ts': ['src/b.ts'],
      'test/harness.ts': ['test/builders.ts'],
      'test/builders.ts': ['test/helper.ts'],
      'test/helper.ts': [],
      'src/b.ts': [],
    });
    expect(
      plain(
        await importersOf(
          graph,
          ['test/helper.ts'],
          ['a.test.ts', 'b.test.ts'],
        ),
      ),
    ).toEqual({ 'test/helper.ts': ['a.test.ts'] });
  });

  it('answers for each support file separately', async () => {
    const graph = source({
      'a.test.ts': ['test/one.ts'],
      'b.test.ts': ['test/two.ts'],
      'test/one.ts': [],
      'test/two.ts': [],
    });
    expect(
      plain(
        await importersOf(
          graph,
          ['test/one.ts', 'test/two.ts'],
          ['a.test.ts', 'b.test.ts'],
        ),
      ),
    ).toEqual({ 'test/one.ts': ['a.test.ts'], 'test/two.ts': ['b.test.ts'] });
  });

  it('answers "no importers" for a support file no test reaches', async () => {
    const graph = source({ 'a.test.ts': [], 'test/helper.ts': [] });
    expect(
      plain(await importersOf(graph, ['test/helper.ts'], ['a.test.ts'])),
    ).toEqual({ 'test/helper.ts': [] });
  });

  it('terminates on an import cycle', async () => {
    const graph = source({
      'a.test.ts': ['test/x.ts'],
      'test/x.ts': ['test/y.ts'],
      'test/y.ts': ['test/x.ts', 'test/helper.ts'],
      'test/helper.ts': [],
    });
    expect(
      plain(await importersOf(graph, ['test/helper.ts'], ['a.test.ts'])),
    ).toEqual({ 'test/helper.ts': ['a.test.ts'] });
  });

  it('reads each module once, however many tests reach it', async () => {
    const graph = source({
      'a.test.ts': ['test/shared.ts'],
      'b.test.ts': ['test/shared.ts'],
      'test/shared.ts': ['test/helper.ts'],
      'test/helper.ts': [],
    });
    await importersOf(graph, ['test/helper.ts'], ['a.test.ts', 'b.test.ts']);
    expect(graph.reads.filter((file) => file === 'test/shared.ts')).toEqual([
      'test/shared.ts',
    ]);
  });

  it('skips a test file that cannot be read, which runs nothing', async () => {
    const graph = source({
      'a.test.ts': ['test/helper.ts'],
      'test/helper.ts': [],
    });
    expect(
      plain(
        await importersOf(
          graph,
          ['test/helper.ts'],
          ['a.test.ts', 'gone.test.ts'],
        ),
      ),
    ).toEqual({ 'test/helper.ts': ['a.test.ts'] });
  });

  it('is undefined when a module a test reaches cannot be read', async () => {
    const graph = source({
      'a.test.ts': ['test/missing.ts'],
      'test/helper.ts': [],
    });
    expect(
      await importersOf(graph, ['test/helper.ts'], ['a.test.ts']),
    ).toBeUndefined();
  });

  it('is undefined when a changed support file no longer exists', async () => {
    const graph = source({ 'a.test.ts': [] });
    expect(
      await importersOf(graph, ['test/deleted.ts'], ['a.test.ts']),
    ).toBeUndefined();
  });

  it('is undefined when a module cannot be traced', async () => {
    const graph = source({
      'a.test.ts': ['test/odd.ts'],
      'test/odd.ts': 'untraceable',
      'test/helper.ts': [],
    });
    expect(
      await importersOf(graph, ['test/helper.ts'], ['a.test.ts']),
    ).toBeUndefined();
  });

  it('is undefined when a test’s own imports cannot be traced', async () => {
    // Unlike an unreadable test, which runs nothing, this one runs — and
    // what it reaches is unknown.
    const graph = source({
      'a.test.ts': 'untraceable',
      'test/helper.ts': [],
    });
    expect(
      await importersOf(graph, ['test/helper.ts'], ['a.test.ts']),
    ).toBeUndefined();
  });

  it('counts a test as reaching itself', async () => {
    const graph = source({ 'a.test.ts': [], 'b.test.ts': [] });
    expect(
      plain(
        await importersOf(graph, ['a.test.ts'], ['a.test.ts', 'b.test.ts']),
      ),
    ).toEqual({ 'a.test.ts': ['a.test.ts'] });
  });

  it('lets an unexpected failure through rather than answering undefined', async () => {
    const graph = {
      ...source({ 'a.test.ts': [], 'test/helper.ts': [] }),
      trace: () => {
        throw new Error('tracer blew up');
      },
    };
    await expect(
      importersOf(graph, ['test/helper.ts'], ['a.test.ts']),
    ).rejects.toThrow('tracer blew up');
  });

  it('is undefined past the module cap, and answers at it', async () => {
    const graph = {
      'a.test.ts': ['test/x.ts'],
      'test/x.ts': ['test/helper.ts'],
      'test/helper.ts': [],
    };
    // Three modules traced: the test, test/x.ts and the helper.
    expect(
      plain(
        await importersOf(source(graph, 3), ['test/helper.ts'], ['a.test.ts']),
      ),
    ).toEqual({ 'test/helper.ts': ['a.test.ts'] });
    expect(
      await importersOf(source(graph, 2), ['test/helper.ts'], ['a.test.ts']),
    ).toBeUndefined();
  });
});

describe('createImportersOf — a real repo, traced by TypeScript', () => {
  let root = '';

  function write(file: string, contents: string): void {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('follows a tsconfig paths alias from the repo root', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'importing-tests-'));
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@test/*': ['./test/*'] },
        },
      }),
    );
    write('test/helper.ts', 'export const h = 1;\n');
    write('test/harness.ts', `export { h } from '@test/helper';\n`);
    write('src/a.test.ts', `import { h } from '@test/harness';\n`);
    write('src/b.test.ts', `import { readFile } from 'node:fs';\n`);
    const importers = createImportersOf(root, 100, () => ts);
    expect(
      plain(
        await importers(['test/helper.ts'], ['src/a.test.ts', 'src/b.test.ts']),
      ),
    ).toEqual({ 'test/helper.ts': ['src/a.test.ts'] });
  });

  it('is undefined when typescript cannot be loaded', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'importing-tests-'));
    write('test/helper.ts', 'export const h = 1;\n');
    const importers = createImportersOf(root, 100, () => {
      throw new Error('Cannot find module typescript');
    });
    expect(await importers(['test/helper.ts'], [])).toBeUndefined();
  });

  it('loads typescript only when it is asked', () => {
    let loads = 0;
    createImportersOf('/nowhere', 100, () => {
      loads += 1;
      return ts;
    });
    expect(loads).toBe(0);
  });
});
