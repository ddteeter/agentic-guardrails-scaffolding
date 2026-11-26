/**
 * What a rung's timeouts cost, for `guardrails stats` (#236): the part of a
 * run's lock time its timed-out mutants took, and what that time was made of.
 *
 * Read from the run-log rows' `timeoutCost` and `timeoutSettings`, which the
 * progress plugin measured. Nothing observes a worker restart directly --
 * stryker logs one only at debug level -- so the restart is stated as what
 * stryker does after every wall-clock timeout, which
 * `test/drift/stryker-timeout.test.ts` pins against the real tool.
 */
import type { TimeoutFile } from './lock-holder.js';
import type { GateRow } from './run-log.js';

type StrykerPart = NonNullable<GateRow['stryker']>;

/**
A run that measured its timeouts.
*/
type MeasuredRun = StrykerPart & {
  timeoutCost: NonNullable<StrykerPart['timeoutCost']>;
};

/**
At most this many files are named.
*/
const TOP_FILES = 5;

/**
Added-up time and the timeouts it was spent on.
*/
interface PerTimeout {
  ms: number;
  timeouts: number;
}

export interface TimeoutSummary {
  /**
  Runs that measured their timeouts.
  */
  runs: number;
  wallClock: number;
  hitLimit: number;
  /**
  The budget stryker gave every wall-clock timeout, added up.
  */
  budgetMs: number;
  /**
  The dry run's overhead in those budgets, over the runs that know it.
  */
  overhead?: Spent | undefined;
  /**
  Time in wall-clock timeouts against mutating time, where it can be told.
  */
  share?: { ms: number; mutatingMs: number; isEstimate: boolean } | undefined;
  /**
  What re-tests alone measured: their time, budget and timeouts.
  */
  retest?: Spent | undefined;
  /**
  Each run's timeout settings, as text, most common first.
  */
  settings: [string, number][];
  /**
  The files with the most wall-clock timeouts across the runs.
  */
  files: TimeoutFile[];
}

function isMeasured(run: StrykerPart): run is MeasuredRun {
  return run.timeoutCost !== undefined;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
Time, timeouts and budget, each added up.
*/
type Spent = PerTimeout & { budgetMs: number };

function addUp(parts: readonly Spent[]): Spent | undefined {
  return parts.length === 0
    ? undefined
    : {
        ms: sum(parts.map((part) => part.ms)),
        timeouts: sum(parts.map((part) => part.timeouts)),
        budgetMs: sum(parts.map((part) => part.budgetMs)),
      };
}

/**
The dry run's overhead in each wall-clock timeout's budget, where it is known.
*/
function overheadOf(runs: readonly MeasuredRun[]): Spent | undefined {
  return addUp(
    runs.flatMap((run) => {
      const overheadMs = run.timeoutSettings?.dryRunOverheadMs;
      const { wallClock, budgetMs } = run.timeoutCost;
      return overheadMs === undefined || wallClock === 0
        ? []
        : [{ ms: overheadMs * wallClock, timeouts: wallClock, budgetMs }];
    }),
  );
}

/**
 * The time a run's wall-clock timeouts took: measured at concurrency 1, and
 * above it estimated as their budget shared by the workers, at most the
 * whole mutating time. `undefined` when the run cannot say.
 */
function timeoutTime(
  run: MeasuredRun,
): { ms: number; mutatingMs: number; isEstimate: boolean } | undefined {
  const concurrency = run.timeoutSettings?.concurrency;
  const { mutatingMs } = run;
  if (concurrency === undefined || mutatingMs === undefined) {
    return undefined;
  }
  if (concurrency <= 1) {
    return {
      ms: run.timeoutCost.wallClockGapMs,
      mutatingMs,
      isEstimate: false,
    };
  }
  return {
    ms: Math.min(run.timeoutCost.budgetMs / concurrency, mutatingMs),
    mutatingMs,
    isEstimate: true,
  };
}

function shareOf(runs: readonly MeasuredRun[]): TimeoutSummary['share'] {
  const times = runs
    .map((run) => timeoutTime(run))
    .filter((time) => time !== undefined);
  const mutatingMs = sum(times.map((time) => time.mutatingMs));
  if (mutatingMs <= 0) {
    return undefined;
  }
  return {
    ms: sum(times.map((time) => time.ms)),
    mutatingMs,
    isEstimate: times.some((time) => time.isEstimate),
  };
}

function retestOf(runs: readonly MeasuredRun[]): Spent | undefined {
  return addUp(
    runs.flatMap((run) => {
      const { retestMutatingMs, retestBudgetMs, retestTimedOut } = run;
      return retestMutatingMs === undefined ||
        retestBudgetMs === undefined ||
        retestTimedOut === undefined ||
        retestTimedOut <= 0
        ? []
        : [
            {
              ms: retestMutatingMs,
              timeouts: retestTimedOut,
              budgetMs: retestBudgetMs,
            },
          ];
    }),
  );
}

function settingsText(run: MeasuredRun): string | undefined {
  const settings = run.timeoutSettings;
  if (settings === undefined) {
    return undefined;
  }
  const { timeoutMS, timeoutFactor } = settings;
  return (
    `timeoutMS ${timeoutMS === undefined ? 'default' : String(timeoutMS)}, ` +
    `timeoutFactor ${timeoutFactor === undefined ? 'default' : String(timeoutFactor)}`
  );
}

function tallied(keys: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].toSorted(([, left], [, right]) => right - left);
}

function filesOf(runs: readonly MeasuredRun[]): TimeoutFile[] {
  const files = new Map<string, TimeoutFile>();
  const entries = runs.flatMap((run) => run.timeoutCost.byFile);
  for (const each of entries) {
    const seen = files.get(each.file);
    files.set(
      each.file,
      seen === undefined
        ? each
        : {
            file: each.file,
            count: seen.count + each.count,
            firstLine: Math.min(seen.firstLine, each.firstLine),
            lastLine: Math.max(seen.lastLine, each.lastLine),
          },
    );
  }
  return files
    .values()
    .toArray()
    .toSorted((left, right) => right.count - left.count)
    .slice(0, TOP_FILES);
}

/**
What the rung's runs say about their timeouts, or `undefined` if none says.
*/
export function summarizeTimeouts(
  runs: readonly StrykerPart[],
): TimeoutSummary | undefined {
  const measured = runs.filter((run) => isMeasured(run));
  if (measured.length === 0) {
    return undefined;
  }
  return {
    runs: measured.length,
    wallClock: sum(measured.map((run) => run.timeoutCost.wallClock)),
    hitLimit: sum(measured.map((run) => run.timeoutCost.hitLimit)),
    budgetMs: sum(measured.map((run) => run.timeoutCost.budgetMs)),
    overhead: overheadOf(measured),
    share: shareOf(measured),
    retest: retestOf(measured),
    settings: tallied(
      measured
        .map((run) => settingsText(run))
        .filter((text) => text !== undefined),
    ),
    files: filesOf(measured),
  };
}

function percent(part: number, whole: number): string {
  return `${String(Math.round((part / whole) * 100))}%`;
}

function budgetLine(
  summary: TimeoutSummary,
  duration: (ms: number) => string,
): string {
  const average = `    budget per wall-clock timeout: ${duration(summary.budgetMs / summary.wallClock)} on average`;
  const { overhead } = summary;
  if (overhead === undefined) {
    return average;
  }
  return (
    `${average}, ${duration(overhead.ms / overhead.timeouts)} ` +
    `(${percent(overhead.ms, overhead.budgetMs)}) of it the dry run’s overhead`
  );
}

function shareLine(share: NonNullable<TimeoutSummary['share']>): string {
  const how = share.isEstimate
    ? 'estimated from budgets: a run above concurrency 1'
    : 'measured: every run at concurrency 1';
  return `    share of mutating time: ${percent(share.ms, share.mutatingMs)} (${how})`;
}

function retestLine(
  retest: NonNullable<TimeoutSummary['retest']>,
  duration: (ms: number) => string,
): string {
  const cost = retest.ms / retest.timeouts;
  const budget = retest.budgetMs / retest.timeouts;
  const excess = cost - budget;
  return (
    `    re-tested alone: ${duration(cost)} per timeout against a budget of ` +
    `${duration(budget)}, ${duration(Math.abs(excess))} ${excess < 0 ? 'under' : 'over'}`
  );
}

function fileText({ file, count, firstLine, lastLine }: TimeoutFile): string {
  const lines =
    firstLine === lastLine
      ? `line ${String(firstLine)}`
      : `lines ${String(firstLine)}–${String(lastLine)}`;
  return `${file} ${String(count)} (${lines})`;
}

/**
The summary as `guardrails stats` prints it under a rung.
*/
export function timeoutLines(
  summary: TimeoutSummary | undefined,
  duration: (ms: number) => string,
): string[] {
  if (summary === undefined) {
    return [];
  }
  const runs = `${String(summary.runs)} run(s)`;
  if (summary.wallClock === 0 && summary.hitLimit === 0) {
    return [`  timeouts: none in ${runs} that measured them`];
  }
  const { share, retest } = summary;
  return [
    `  timeouts: ${String(summary.wallClock)} wall-clock and ` +
      `${String(summary.hitLimit)} hit-limit in ${runs}; stryker restarts ` +
      `its test runner after each wall-clock one`,
    ...(summary.wallClock === 0 ? [] : [budgetLine(summary, duration)]),
    ...(share === undefined ? [] : [shareLine(share)]),
    ...(retest === undefined ? [] : [retestLine(retest, duration)]),
    ...(summary.settings.length === 0
      ? []
      : [
          `    settings: ${summary.settings
            .map(([text, count]) => `${text} in ${String(count)} run(s)`)
            .join('; ')}`,
        ]),
    ...(summary.files.length === 0
      ? []
      : [
          `    most wall-clock timeouts: ${summary.files.map((each) => fileText(each)).join(', ')}`,
        ]),
  ];
}
