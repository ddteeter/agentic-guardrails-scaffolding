/**
 * Which tests import a changed test-support file, directly or through other
 * modules (#197) — so the mutation cache can drop only the verdicts those
 * tests vouch for, rather than every verdict it holds.
 *
 * Every uncertainty answers `undefined`, which the cache reads as "refuse
 * everything": a module that cannot be read or traced, an import nothing
 * resolves (`createImportTracer`), a changed support file that no longer
 * exists, or a graph past the module cap. A short answer here would keep a
 * verdict nothing re-checked; `undefined` costs only a cold run.
 *
 * The tests asked about come from the cache's own `testFiles`, so no
 * directory is walked and no test-file naming is assumed.
 */

import { createImportTracer, type ImportTracer } from '../import-graph.js';
import { repoSourceReader } from '../repo-source.js';

export interface ImportGraphSource {
  /**
  A repo-relative file's text, or `undefined` when it cannot be read.
  */
  read: (file: string) => Promise<string | undefined>;
  trace: ImportTracer;
  /**
  How many modules may be traced before the answer is `undefined`.
  */
  maxModules: number;
}

/**
 * Each support file mapped to the tests that reach it, or `undefined`.
 */
export type Importers = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The cache's question, as a seam: `supportFiles` against `testFiles`, both
 * repo-relative.
 */
export type ImportersOf = (
  supportFiles: readonly string[],
  testFiles: readonly string[],
) => Promise<Importers | undefined>;

/**
 * Raised inside the walk to end it with `undefined`; never escapes
 * `importersOf`.
 */
class Untraceable extends Error {}

/**
 * The imports of one module, each module read and traced once however many
 * tests reach it, with the cap counted over distinct modules: `undefined` for
 * a module that cannot be read, and `Untraceable` thrown for one that cannot
 * be traced or one past the cap.
 */
function memoisedImports(
  source: ImportGraphSource,
): (file: string) => Promise<readonly string[] | undefined> {
  const answered = new Map<string, Promise<readonly string[] | undefined>>();
  return (file) => {
    const known = answered.get(file);
    if (known !== undefined) {
      return known;
    }
    if (answered.size >= source.maxModules) {
      throw new Untraceable(`more than ${String(source.maxModules)} modules`);
    }
    const imports = traceOne(source, file);
    answered.set(file, imports);
    return imports;
  };
}

async function traceOne(
  source: ImportGraphSource,
  file: string,
): Promise<readonly string[] | undefined> {
  const text = await source.read(file);
  if (text === undefined) {
    return text;
  }
  const traced = source.trace(file, text);
  if (traced === undefined) {
    throw new Untraceable(`${file} could not be traced`);
  }
  return traced;
}

/**
 * Every module `test` reaches, itself included; `undefined` when the test
 * cannot be read, which runs nothing.
 */
async function reachableFrom(
  test: string,
  importsOf: (file: string) => Promise<readonly string[] | undefined>,
): Promise<ReadonlySet<string> | undefined> {
  const rootImports = await importsOf(test);
  if (rootImports === undefined) {
    return undefined;
  }
  const seen = new Set([test]);
  let frontier = [...rootImports];
  while (frontier.length > 0) {
    const fresh = frontier.filter((file) => !seen.has(file));
    for (const file of fresh) {
      seen.add(file);
    }
    const next = await Promise.all(fresh.map(async (file) => importsOf(file)));
    frontier = next.flatMap((imports) => {
      if (imports === undefined) {
        throw new Untraceable('a module a test imports could not be read');
      }
      return imports;
    });
  }
  return seen;
}

/**
 * The tests among `testFiles` that reach each of `supportFiles`, or
 * `undefined` when that cannot be told for certain.
 */
export async function importersOf(
  source: ImportGraphSource,
  supportFiles: readonly string[],
  testFiles: readonly string[],
): Promise<Importers | undefined> {
  const present = await Promise.all(
    supportFiles.map(async (file) => (await source.read(file)) !== undefined),
  );
  if (present.includes(false)) {
    return undefined;
  }
  const importsOf = memoisedImports(source);
  const importers = new Map(
    supportFiles.map((file) => [file, new Set<string>()]),
  );
  try {
    for (const test of testFiles) {
      const reached = await reachableFrom(test, importsOf);
      for (const [file, tests] of importers) {
        if (reached?.has(file) === true) {
          tests.add(test);
        }
      }
    }
  } catch (error) {
    if (error instanceof Untraceable) {
      return undefined;
    }
    throw error;
  }
  return importers;
}

/**
 * `importersOf` over the repo at `repoRoot`, traced by its own TypeScript —
 * loaded only on the first question, since most runs change no support file.
 * No TypeScript answers `undefined`.
 */
export function createImportersOf(
  repoRoot: string,
  maxModules: number,
  load?: () => unknown,
): ImportersOf {
  const read = repoSourceReader(repoRoot);
  return (supportFiles, testFiles) => {
    const trace = createImportTracer(repoRoot, load);
    return trace === undefined
      ? Promise.resolve(undefined)
      : importersOf(
          {
            read: (file) => Promise.resolve(read(file)),
            trace,
            maxModules,
          },
          supportFiles,
          testFiles,
        );
  };
}
