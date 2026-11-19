/**
 * `guardrails stats` (#176): what the machine-wide run log says about a
 * window of gates and ships. Pure: the command reads the log and the clock,
 * and this turns rows into a summary and a summary into text.
 *
 * What it answers is what the dialed.run throughput review had to rebuild
 * from transcripts: how long gates queue for the lock and hold it, how often
 * stryker runs seeded and why it runs cold, where a ship's time goes, and
 * whether dry runs slow down as more runs queue or the machine loads up.
 */
import type { GateRow, RunRow, ShipRow } from './run-log.js';

export interface Spread {
  median: number;
  p90: number;
}

interface RungSummary {
  runs: number;
  outcomes: Record<string, number>;
  queuedMs?: Spread | undefined;
  heldMs?: Spread | undefined;
  dryRunMs?: Spread | undefined;
  mutatingMs?: Spread | undefined;
  /**
  Runs that mutated anything, and how many of those started warm.
  */
  mutated: number;
  warm: number;
  /**
  Why runs went cold, most common first.
  */
  coldReasons: [string, number][];
}

interface ShipSummary {
  runs: number;
  states: Record<string, number>;
  pushMs?: Spread | undefined;
  gateMs?: Spread | undefined;
  ciMs?: Spread | undefined;
}

interface Bucket {
  bucket: string;
  runs: number;
  dryRunMs?: Spread | undefined;
}

export interface RunStats {
  from: string;
  to: string;
  rows: number;
  rungs: Record<string, RungSummary>;
  ships: ShipSummary;
  /**
  Dry-run time by how many runs were queued ahead on arrival.
  */
  byDepth: Bucket[];
  /**
  Dry-run time by the 1-minute load per core at the start.
  */
  byLoad: Bucket[];
}

export interface StatsWindow {
  now: Date;
  sinceMs: number;
  repo?: string | undefined;
}

/**
The value at `share` of the way through `sorted` (nearest rank).
*/
function rank(sorted: readonly number[], share: number): number {
  const index = Math.ceil(share * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function spreadOf(values: readonly number[]): Spread | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = values.toSorted((left, right) => left - right);
  return { median: rank(sorted, 0.5), p90: rank(sorted, 0.9) };
}

function present<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function tally(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
Did this gate's stryker start from a usable cache?
*/
function isWarm(row: GateRow): boolean {
  const cache = row.stryker?.cache;
  return cache?.local === 'kept' || cache?.seed === 'used';
}

function coldReason(row: GateRow): string {
  const cache = row.stryker?.cache;
  if (cache?.why !== undefined) {
    return cache.why;
  }
  return `local cache ${cache?.local ?? 'unknown'}, seed ${cache?.seed ?? 'unknown'}`;
}

function rungSummary(rows: readonly GateRow[]): RungSummary {
  const mutated = rows.filter((row) => row.stryker !== undefined);
  const cold = mutated.filter((row) => !isWarm(row));
  return {
    runs: rows.length,
    outcomes: tally(rows.map((row) => row.outcome)),
    queuedMs: spreadOf(present(rows.map((row) => row.lock?.queuedMs))),
    heldMs: spreadOf(present(rows.map((row) => row.lock?.heldMs))),
    dryRunMs: spreadOf(present(rows.map((row) => row.stryker?.dryRunMs))),
    mutatingMs: spreadOf(present(rows.map((row) => row.stryker?.mutatingMs))),
    mutated: mutated.length,
    warm: mutated.length - cold.length,
    coldReasons: Object.entries(
      tally(cold.map((row) => coldReason(row))),
    ).toSorted(([, left], [, right]) => right - left),
  };
}

function shipSummary(rows: readonly ShipRow[]): ShipSummary {
  return {
    runs: rows.length,
    states: tally(rows.map((row) => row.state)),
    pushMs: spreadOf(rows.map((row) => row.pushMs)),
    gateMs: spreadOf(present(rows.map((row) => row.gateMs))),
    ciMs: spreadOf(present(rows.map((row) => row.ciMs))),
  };
}

const DEPTHS = ['0', '1', '2', '3+'] as const;

function depthBucket(row: GateRow): string | undefined {
  const depth = row.lock?.depthOnArrival;
  if (depth === undefined) {
    return undefined;
  }
  return depth >= 3 ? '3+' : String(depth);
}

const LOADS = ['under 0.5 per core', '0.5–1 per core', 'over 1 per core'];

function loadBucket(row: GateRow): string | undefined {
  const machine = row.machine;
  if (machine === undefined || machine.cores <= 0) {
    return undefined;
  }
  const perCore = machine.start.load1 / machine.cores;
  if (perCore < 0.5) {
    return LOADS[0];
  }
  return perCore <= 1 ? LOADS[1] : LOADS[2];
}

function buckets(
  rows: readonly GateRow[],
  names: readonly string[],
  bucketOf: (row: GateRow) => string | undefined,
): Bucket[] {
  return names.map((bucket) => {
    const inBucket = rows.filter(
      (row) => row.stryker?.dryRunMs !== undefined && bucketOf(row) === bucket,
    );
    return {
      bucket,
      runs: inBucket.length,
      dryRunMs: spreadOf(present(inBucket.map((row) => row.stryker?.dryRunMs))),
    };
  });
}

/**
What the rows inside the window say.
*/
export function summarizeRuns(
  rows: readonly RunRow[],
  window: StatsWindow,
): RunStats {
  const to = window.now.getTime();
  const from = to - window.sinceMs;
  const inWindow = rows.filter((row) => {
    const at = Date.parse(row.startedAt);
    return (
      at >= from &&
      at <= to &&
      (window.repo === undefined || row.repo === window.repo)
    );
  });
  const gates = inWindow.filter((row): row is GateRow => row.kind === 'gate');
  const ships = inWindow.filter((row): row is ShipRow => row.kind === 'ship');
  const rungs: Record<string, RungSummary> = {};
  const rungNames = new Set(gates.map((row) => row.rung));
  for (const rung of rungNames) {
    rungs[rung] = rungSummary(gates.filter((row) => row.rung === rung));
  }
  return {
    from: new Date(from).toISOString(),
    to: window.now.toISOString(),
    rows: inWindow.length,
    rungs,
    ships: shipSummary(ships),
    byDepth: buckets(gates, DEPTHS, depthBucket),
    byLoad: buckets(gates, LOADS, loadBucket),
  };
}

/**
`ms` as minutes and seconds, or seconds alone under a minute.
*/
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function spreadText(label: string, spread: Spread | undefined): string[] {
  return spread === undefined
    ? []
    : [
        `  ${label}: median ${duration(spread.median)}, p90 ${duration(spread.p90)}`,
      ];
}

function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, count]) => `${key} ${String(count)}`)
    .join(', ');
}

function rungText(rung: string, summary: RungSummary): string[] {
  return [
    `${rung}: ${String(summary.runs)} run(s) (${countsText(summary.outcomes)})`,
    ...spreadText('queued for the lock', summary.queuedMs),
    ...spreadText('held the lock', summary.heldMs),
    ...spreadText('dry run', summary.dryRunMs),
    ...spreadText('mutating', summary.mutatingMs),
    ...(summary.mutated === 0
      ? []
      : [
          `  started warm: ${String(summary.warm)} of ${String(summary.mutated)}`,
          ...summary.coldReasons.map(
            ([why, count]) => `    cold ${String(count)}×: ${why}`,
          ),
        ]),
  ];
}

function bucketText(title: string, rows: readonly Bucket[]): string[] {
  const filled = rows.filter((row) => row.dryRunMs !== undefined);
  return filled.length === 0
    ? []
    : [
        title,
        ...filled.map(
          (row) =>
            `  ${row.bucket}: ${String(row.runs)} run(s), median ${duration(row.dryRunMs?.median ?? 0)}`,
        ),
      ];
}

/**
The summary as the lines `guardrails stats` prints.
*/
export function formatStats(stats: RunStats): string {
  if (stats.rows === 0) {
    return `guardrails stats: no gate or ship runs logged from ${stats.from} to ${stats.to}.\n`;
  }
  const { ships } = stats;
  const lines = [
    `guardrails stats: ${String(stats.rows)} run(s) from ${stats.from} to ${stats.to}`,
    ...Object.entries(stats.rungs).flatMap(([rung, summary]) =>
      rungText(rung, summary),
    ),
    ...(ships.runs === 0
      ? []
      : [
          `ship: ${String(ships.runs)} run(s) (${countsText(ships.states)})`,
          ...spreadText('push, gate included', ships.pushMs),
          ...spreadText('gate', ships.gateMs),
          ...spreadText('CI', ships.ciMs),
        ]),
    ...bucketText('dry run by queue depth on arrival:', stats.byDepth),
    ...bucketText('dry run by load at start:', stats.byLoad),
  ];
  return `${lines.join('\n')}\n`;
}

/**
`7d`, `24h` or `90m` as milliseconds, or `undefined` for anything else.
*/
export function parseSince(text: string): number | undefined {
  const match = /^(\d+)([dhm])$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[
    match[2] as 'd' | 'h' | 'm'
  ];
  return Number(match[1]) * unit;
}
