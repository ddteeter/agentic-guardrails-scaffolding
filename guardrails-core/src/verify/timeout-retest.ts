/**
 * Re-test a timed-out mutant once, alone, before counting it killed (#202).
 *
 * Stryker scores a `Timeout` as detected, and the gate keeps it as a kill
 * (#180). On a loaded machine a mutant can time out because the machine was
 * slow rather than because the mutant hangs: a kill no test earned. So after
 * the run, the timeouts this run MEASURED and no test is named as killing are
 * run once more, in one extra stryker run with no sibling workers, and only
 * one that times out again stays killed. Everything else takes the re-run's
 * verdict.
 *
 * Left out of the re-test, on purpose:
 *
 * - **A Timeout a test is named as killing** — a test failed on it.
 * - **A hit-limit Timeout** (`statusReason: "Hit limit reached (n/limit)"`):
 *   stryker counted the mutant's own executions past the limit its dry run
 *   set. Load changes how long a run takes, not how many times a line runs.
 * - **A Timeout the cache held before this run** — reused, not measured, so
 *   a real hang is not re-paid by every run after the one that found it. A
 *   reused Timeout whose lines moved keys differently and is re-tested once;
 *   the cache stryker writes afterwards holds it at its new lines.
 *
 * Mutants are matched by stryker's own identifying key (file, span, mutator,
 * replacement — `mutantToIdentifyingKey` in its incremental differ), which is
 * also how its cache decides what it can reuse. Pure: the caller reads and
 * writes the files and runs stryker.
 */
import { isRecord } from '../is-record.js';
import {
  type IncrementalCache,
  parseIncrementalCache,
  serializeIncrementalCache,
} from './incremental-cache.js';
import type { LineRange } from './line-range.js';
import { isLocationInRanges } from './mutate-ranges.js';

/**
 * What a re-scored mutant's `statusReason` says, and so what its violation
 * message says (`stryker-adapter.ts`).
 */
export const RETESTED_REASON =
  'it timed out in the full run but not when re-tested alone, so that ' +
  'timeout was the machine’s load, not this mutant';

const HIT_LIMIT_PREFIX = 'Hit limit reached';

/**
A position as stryker's report writes it.
*/
function positionOf(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    typeof value.line !== 'number' ||
    typeof value.column !== 'number'
  ) {
    return undefined;
  }
  return `${String(value.line)}:${String(value.column)}`;
}

/**
 * Stryker's identifying key for a mutant of `file`, or `undefined` for one
 * whose location or replacement is not all there.
 */
function mutantKey(
  file: string,
  raw: Readonly<Record<string, unknown>>,
): string | undefined {
  const { location, mutatorName, replacement } = raw;
  if (
    typeof mutatorName !== 'string' ||
    typeof replacement !== 'string' ||
    !isRecord(location)
  ) {
    return undefined;
  }
  const start = positionOf(location.start);
  const end = positionOf(location.end);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return `${file}@${start}-${end}\n${mutatorName}: ${replacement}`;
}

/**
The line span a keyed mutant covers.
*/
function spanOf(raw: Readonly<Record<string, unknown>>): LineRange {
  // Only called for a mutant `mutantKey` keyed, whose location has both.
  const { location } = raw;
  const lineOf = (end: 'start' | 'end'): number => {
    const position = isRecord(location) ? location[end] : undefined;
    return isRecord(position) && typeof position.line === 'number'
      ? position.line
      : 0;
  };
  return { start: lineOf('start'), end: lineOf('end') };
}

/**
One mutant of a parsed report, with its file and key.
*/
interface KeyedMutant {
  readonly file: string;
  readonly key: string;
  readonly status: string;
  readonly killedBy: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

function keyedMutants(cache: IncrementalCache | undefined): KeyedMutant[] {
  if (cache === undefined) {
    return [];
  }
  return [...cache.files].flatMap(([file, entry]) =>
    entry.mutants.flatMap((each) => {
      const key = mutantKey(file, each.raw);
      return key === undefined ? [] : [{ ...each, file, key }];
    }),
  );
}

/**
 * The key of every `Timeout` in a cache's text: what this run could reuse
 * rather than measure. Empty for no cache.
 */
export function timeoutKeys(cacheJson: string): Set<string> {
  return new Set(
    keyedMutants(parseIncrementalCache(cacheJson))
      .filter((each) => each.status === 'Timeout')
      .map((each) => each.key),
  );
}

function isHitLimit(raw: Readonly<Record<string, unknown>>): boolean {
  const reason = raw.statusReason;
  return typeof reason === 'string' && reason.startsWith(HIT_LIMIT_PREFIX);
}

interface RetestScope {
  /**
  The files this run mutates.
  */
  inScope: readonly string[];
  /**
  The planned ranges of the files mutated by line range.
  */
  lineRanges: ReadonlyMap<string, readonly LineRange[]>;
  /**
  `timeoutKeys` of the cache as it stood before the run.
  */
  cachedTimeouts: ReadonlySet<string>;
  /**
  At most this many are re-tested; `0` re-tests none.
  */
  limit: number;
}

export interface RetestPlan {
  /**
  The mutants to re-test, by key.
  */
  keys: ReadonlySet<string>;
  /**
  The `--mutate` entries naming their lines, one per distinct span.
  */
  mutate: string[];
  /**
  How many qualified before the cap.
  */
  candidates: number;
}

function isCandidate(each: KeyedMutant, scope: RetestScope): boolean {
  if (
    each.status !== 'Timeout' ||
    each.killedBy.length > 0 ||
    isHitLimit(each.raw) ||
    scope.cachedTimeouts.has(each.key)
  ) {
    return false;
  }
  const planned = scope.lineRanges.get(each.file);
  return planned === undefined || isLocationInRanges(spanOf(each.raw), planned);
}

function byFileThenLine(left: KeyedMutant, right: KeyedMutant): number {
  return (
    left.file.localeCompare(right.file) ||
    spanOf(left.raw).start - spanOf(right.raw).start
  );
}

/**
 * Which of a finished run's timeouts to re-test: in scope, unattributed, not
 * hit-limit, measured this run — the first `limit` of them by file and line.
 */
export function planRetest(reportJson: string, scope: RetestScope): RetestPlan {
  const inScope = new Set(scope.inScope);
  const candidates = keyedMutants(parseIncrementalCache(reportJson))
    .filter((each) => inScope.has(each.file) && isCandidate(each, scope))
    .toSorted(byFileThenLine);
  const picked = candidates.slice(0, scope.limit);
  const mutate = picked.map((each) => {
    const { start, end } = spanOf(each.raw);
    return `${each.file}:${String(start)}-${String(end)}`;
  });
  return {
    keys: new Set(picked.map((each) => each.key)),
    mutate: [...new Set(mutate)],
    candidates: candidates.length,
  };
}

/**
`cache` with every mutant `isKept` refuses removed.
*/
function filterMutants(
  cache: IncrementalCache,
  isKept: (file: string, raw: Readonly<Record<string, unknown>>) => boolean,
): IncrementalCache {
  return {
    ...cache,
    files: new Map(
      [...cache.files].map(([file, entry]) => [
        file,
        {
          ...entry,
          mutants: entry.mutants.filter((each) => isKept(file, each.raw)),
        },
      ]),
    ),
  };
}

/**
 * The cache's text with exactly the keyed mutants removed, so stryker's
 * `--incremental` re-tests them and reuses everything else; `undefined` for
 * a cache that cannot be read.
 */
export function dropMutants(
  cacheJson: string,
  keys: ReadonlySet<string>,
): string | undefined {
  const cache = parseIncrementalCache(cacheJson);
  if (cache === undefined) {
    return undefined;
  }
  return serializeIncrementalCache(
    filterMutants(cache, (file, raw) => {
      const key = mutantKey(file, raw);
      return key === undefined || !keys.has(key);
    }),
  );
}

export interface Rescored {
  /**
  The first run's report with each re-tested mutant's new verdict.
  */
  report: string;
  /**
  Re-tested mutants that did not time out again.
  */
  rescored: number;
  /**
  Re-tested mutants that timed out again, and stay killed.
  */
  timedOutAgain: number;
  /**
  Re-tested mutants the re-run's report does not hold; they stay killed.
  */
  missing: number;
}

/**
The fields of a verdict, beside its status, that the re-run's replace.
*/
const RESCORED_FIELDS: ReadonlySet<string> = new Set([
  'testsCompleted',
  'killedBy',
  'coveredBy',
]);

/**
The first run's mutant with the re-run's verdict on it.
*/
function rescoredMutant(
  first: Readonly<Record<string, unknown>>,
  second: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const verdict = (from: Readonly<Record<string, unknown>>) =>
    Object.entries(from).filter(([field]) => RESCORED_FIELDS.has(field));
  return {
    ...Object.fromEntries(
      Object.entries(first).filter(([field]) => !RESCORED_FIELDS.has(field)),
    ),
    ...Object.fromEntries(verdict(second)),
    status: second.status,
    statusReason: RETESTED_REASON,
  };
}

/**
 * The first run's report with each re-tested mutant scored as the re-run
 * scored it. A mutant that timed out again, or that the re-run's report does
 * not hold, keeps its `Timeout`: a re-test that did not happen is no
 * evidence against the first verdict.
 */
export function rescore(
  firstReport: string,
  secondReport: string,
  keys: ReadonlySet<string>,
): Rescored {
  const first = parseIncrementalCache(firstReport);
  const second = new Map(
    keyedMutants(parseIncrementalCache(secondReport)).map((each) => [
      each.key,
      each,
    ]),
  );
  const counts = { rescored: 0, timedOutAgain: 0, missing: 0 };
  const verdicts = new Map<string, Readonly<Record<string, unknown>>>();
  for (const key of keys) {
    const again = second.get(key);
    if (again === undefined) {
      counts.missing += 1;
    } else if (again.status === 'Timeout') {
      counts.timedOutAgain += 1;
    } else {
      counts.rescored += 1;
      verdicts.set(key, again.raw);
    }
  }
  if (first === undefined || verdicts.size === 0) {
    return { report: firstReport, ...counts };
  }
  return { report: replaceVerdicts(first, verdicts), ...counts };
}

function replaceVerdicts(
  first: IncrementalCache,
  verdicts: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): string {
  const files = new Map(
    [...first.files].map(([file, entry]) => [
      file,
      {
        ...entry,
        mutants: entry.mutants.map((each) => {
          const key = mutantKey(file, each.raw);
          const verdict = key === undefined ? undefined : verdicts.get(key);
          return verdict === undefined
            ? each
            : { ...each, raw: rescoredMutant(each.raw, verdict) };
        }),
      },
    ]),
  );
  return serializeIncrementalCache({ ...first, files });
}
