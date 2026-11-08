/**
 * Several stryker reports merged into one incremental cache (#157), for a
 * seed fetched from a CI run that mutated in shards.
 *
 * Test ids are the hard part. Stryker numbers the tests of each run from
 * `"0"`, so an id means something only inside the report that wrote it: two
 * shards' `"1"` are usually different tests, and the same test is usually a
 * different id in each. A union that kept the ids would point a kill at
 * whatever test the other shard happened to number the same, and the
 * targeted rule would then trust or distrust it on the wrong file's history.
 * So every id is re-keyed into one numbering, and a test both shards ran (a
 * shard runs the whole suite) becomes one test: matched by its file, its name
 * and location, and how many tests before it in that file share them.
 *
 * Everything this cannot vouch for refuses the whole merge, and the caller
 * runs cold: a report that does not parse, a production file two reports both
 * mutated (two verdicts, nothing to choose between them), a test file run at
 * two different sources, and a test id one report declares twice. An id a
 * mutant names that no test declares stays unresolvable, in a namespace no
 * re-keyed id can reach, so the targeted rule drops its verdict as it would
 * in a local cache.
 */

import { parseIncrementalCache } from './incremental-cache.js';
import type { IncrementalCache } from './incremental-cache.js';

type Fields = Readonly<Record<string, unknown>>;

interface MergedTestFile {
  readonly raw: Fields;
  readonly tests: Fields[];
  /**
  Test key → its id in the merge.
  */
  readonly idOf: Map<string, string>;
}

/**
 * What a test file held at two different sources does to the merge.
 *
 * - `refuse`: shards of one CI run ran one checkout, so two sources mean the
 *   reports are not what they claim, and the merge is refused.
 * - `unresolve`: a local cache and a seed were measured at different
 *   checkouts, so differing sources are expected. The first input's copy is
 *   kept, and a later input's tests in that file map to nothing: their kills
 *   stop resolving, which the targeted rule drops like any untraceable kill.
 */
type SourceConflict = 'refuse' | 'unresolve';

/**
 * What makes two reports' tests the same test. The occurrence count tells
 * apart two tests of one file that share a name: the n-th of them in one
 * report is the n-th in another.
 */
function testKey(test: Fields, occurrence: number): string {
  return JSON.stringify([test.name, test.location, occurrence]);
}

/**
Merges reports one at a time into a single numbering.
*/
class ReportMerge {
  private readonly files = new Map<string, Fields>();
  private readonly testFiles = new Map<string, MergedTestFile>();
  private nextTestId = 0;
  private nextMutantId = 0;
  /**
   * Set by anything the merge cannot vouch for. The merge carries on — what
   * it builds afterwards is discarded — so refusing needs no early exit.
   */
  isRefused = false;

  constructor(private readonly onSourceConflict: SourceConflict) {}

  /**
  This report's test id → its id in the merge.
  */
  private addTests(report: IncrementalCache): Map<string, string> {
    const idOf = new Map<string, string>();
    const declared = new Set<string>();
    for (const [file, entry] of report.testFiles) {
      const merged = this.testFileFor(file, entry.raw);
      this.mapTests(entry.tests, merged, idOf, declared);
    }
    return idOf;
  }

  /**
   * Record each of one test file's tests in `idOf`, unless `merged` is
   * `undefined` (its tests map to nothing). Every id goes into `declared`
   * either way: one report declaring an id twice refuses the merge.
   */
  private mapTests(
    tests: readonly { readonly id: string; readonly raw: Fields }[],
    merged: MergedTestFile | undefined,
    idOf: Map<string, string>,
    declared: Set<string>,
  ): void {
    for (const [index, test] of tests.entries()) {
      if (declared.has(test.id)) {
        this.isRefused = true;
      }
      declared.add(test.id);
      if (merged !== undefined) {
        const name = testKey(test.raw, 0);
        const occurrence = tests
          .slice(0, index)
          .filter((earlier) => testKey(earlier.raw, 0) === name).length;
        idOf.set(test.id, this.mergedId(merged, test.raw, occurrence));
      }
    }
  }

  /**
  The merged entry for `file`, or `undefined` when its tests map to nothing.
  */
  private testFileFor(file: string, raw: Fields): MergedTestFile | undefined {
    const existing = this.testFiles.get(file);
    if (existing === undefined) {
      const created = { raw, tests: [], idOf: new Map<string, string>() };
      this.testFiles.set(file, created);
      return created;
    }
    if (existing.raw.source === raw.source) {
      return existing;
    }
    if (this.onSourceConflict === 'refuse') {
      this.isRefused = true;
    }
    return undefined;
  }

  private mergedId(
    merged: MergedTestFile,
    test: Fields,
    occurrence: number,
  ): string {
    const key = testKey(test, occurrence);
    const known = merged.idOf.get(key);
    if (known !== undefined) {
      return known;
    }
    const id = String(this.nextTestId++);
    merged.idOf.set(key, id);
    merged.tests.push({ ...test, id });
    return id;
  }

  add(report: IncrementalCache, index: number): void {
    const idOf = this.addTests(report);
    const resolve = (id: string): string =>
      idOf.get(id) ?? `unresolved:${String(index)}:${id}`;
    for (const [file, entry] of report.files) {
      if (this.files.has(file)) {
        this.isRefused = true;
      }
      this.files.set(file, {
        ...entry.raw,
        mutants: entry.mutants.map((each) => ({
          ...each.raw,
          id: String(this.nextMutantId++),
          ...('killedBy' in each.raw && {
            killedBy: each.killedBy.map((id) => resolve(id)),
          }),
          ...('coveredBy' in each.raw && {
            coveredBy: each.coveredBy.map((id) => resolve(id)),
          }),
        })),
      });
    }
  }

  serialize(first: IncrementalCache): string {
    return JSON.stringify({
      ...first.raw,
      files: Object.fromEntries(this.files),
      testFiles: Object.fromEntries(
        [...this.testFiles].map(([file, entry]) => [
          file,
          { ...entry.raw, tests: entry.tests },
        ]),
      ),
    });
  }
}

function mergeParsed(
  texts: readonly string[],
  onSourceConflict: SourceConflict,
): string | undefined {
  const reports = texts
    .map((text) => parseIncrementalCache(text))
    .filter((report) => report !== undefined);
  const [first] = reports;
  if (first === undefined || reports.length !== texts.length) {
    return undefined;
  }
  const merge = new ReportMerge(onSourceConflict);
  for (const [index, report] of reports.entries()) {
    merge.add(report, index);
  }
  if (merge.isRefused) {
    return undefined;
  }
  return merge.serialize(first);
}

/**
 * The reports in `texts` as one cache's JSON, or `undefined` when they cannot
 * be merged safely (see the module comment). Everything but `files` and
 * `testFiles` — `schemaVersion`, `thresholds` — is taken from the first.
 */
export function mergeReports(texts: readonly string[]): string | undefined {
  return mergeParsed(texts, 'refuse');
}

/**
 * A local cache and a seed for the files it lacks, as one cache's JSON, or
 * `undefined` when they cannot be merged safely (#157).
 *
 * The same union as `mergeReports`, with the local cache first — its
 * report-level fields win — and one rule relaxed: a test file the two hold at
 * different sources keeps the local copy, and the seed's kills by its tests
 * stop resolving (`SourceConflict`). A production file in both still refuses
 * the merge; the caller cuts the seed to the files the local cache lacks.
 */
export function mergeSeedInto(local: string, seed: string): string | undefined {
  return mergeParsed([local, seed], 'unresolve');
}
