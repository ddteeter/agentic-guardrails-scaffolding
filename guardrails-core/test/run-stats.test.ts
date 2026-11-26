import { describe, expect, it } from 'vitest';

import type { GateRow, LockRow, RunRow, ShipRow } from '../src/run-log.js';
import {
  duration,
  formatStats,
  parseSince,
  spreadOf,
  summarizeRuns,
} from '../src/run-stats.js';
import { summarizeTimeouts, timeoutLines } from '../src/timeout-stats.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const WEEK = 7 * 86_400_000;

function gate(over: Partial<GateRow> = {}): GateRow {
  return {
    v: 1,
    kind: 'gate',
    rung: 'push',
    repo: 'app',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T10:10:00.000Z',
    outcome: 'pass',
    lock: { queuedMs: 60_000, heldMs: 300_000, depthOnArrival: 0 },
    stryker: {
      files: 2,
      cache: { local: 'kept', seed: 'off' },
      dryRunMs: 90_000,
      mutatingMs: 200_000,
      report: 'read',
    },
    machine: {
      cores: 10,
      concurrency: 'default',
      start: { load1: 2, freeMb: 4000 },
      end: { load1: 3, freeMb: 3500 },
    },
    ...over,
  };
}

function ship(over: Partial<ShipRow> = {}): ShipRow {
  return {
    v: 1,
    kind: 'ship',
    repo: 'app',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T11:00:00.000Z',
    pr: 7,
    state: 'green',
    pushMs: 600_000,
    gateMs: 590_000,
    ciMs: 1_200_000,
    ...over,
  };
}

/**
A gate that ran cold, for `why`.
*/
function coldFor(why: string): GateRow {
  return gate({
    stryker: {
      files: 1,
      cache: { local: 'none', seed: 'refused', why },
      report: 'read',
    },
  });
}

describe('spreadOf', () => {
  it('gives the median and the 90th percentile by nearest rank', () => {
    expect(spreadOf([5, 1, 4, 2, 3, 10, 9, 8, 7, 6])).toEqual({
      median: 5,
      p90: 9,
    });
    expect(spreadOf([42])).toEqual({ median: 42, p90: 42 });
  });

  it('has none for no values', () => {
    expect(spreadOf([])).toBeUndefined();
  });
});

describe('summarizeRuns', () => {
  const cold = gate({
    stryker: {
      files: 1,
      cache: {
        local: 'discarded',
        seed: 'refused',
        why: 'different stryker options',
      },
      dryRunMs: 300_000,
      report: 'read',
    },
    lock: { queuedMs: 900_000, heldMs: 600_000, depthOnArrival: 3 },
    machine: {
      cores: 10,
      concurrency: 'default',
      start: { load1: 12, freeMb: 900 },
      end: { load1: 11, freeMb: 900 },
    },
    outcome: 'block',
  });
  const seeded = gate({
    stryker: {
      files: 1,
      cache: { local: 'none', seed: 'used' },
      dryRunMs: 100_000,
      report: 'read',
    },
    lock: { queuedMs: 0, heldMs: 200_000, depthOnArrival: 1 },
  });
  const rows: RunRow[] = [
    gate(),
    cold,
    seeded,
    gate({ rung: 'commit', stryker: undefined, lock: undefined }),
    gate({ repo: 'other' }),
    gate({ startedAt: '2026-11-01T00:00:00.000Z' }),
    ship(),
    ship({ state: 'ci-red', gateMs: undefined, ciMs: 300_000 }),
  ];

  // Summarized inside each test, not here: a throw at collection is a file
  // error, which stryker's runner does not count as a failing test.
  const appStats = (): ReturnType<typeof summarizeRuns> =>
    summarizeRuns(rows, { now: NOW, sinceMs: WEEK, repo: 'app' });

  it('keeps the rows inside the window and the repo', () => {
    expect(appStats().rows).toBe(6);
    expect(appStats().from).toBe('2026-11-12T12:00:00.000Z');
    expect(appStats().to).toBe('2026-11-19T12:00:00.000Z');
  });

  it('takes every repo when none is named', () => {
    expect(summarizeRuns(rows, { now: NOW, sinceMs: WEEK }).rows).toBe(7);
  });

  it('summarizes each rung: outcomes, lock and phase times, warm share and cold reasons', () => {
    expect(appStats().rungs.push).toEqual({
      runs: 3,
      outcomes: { pass: 2, block: 1 },
      queuedMs: { median: 60_000, p90: 900_000 },
      heldMs: { median: 300_000, p90: 600_000 },
      dryRunMs: { median: 100_000, p90: 300_000 },
      mutatingMs: { median: 200_000, p90: 200_000 },
      mutated: 3,
      warm: 2,
      coldReasons: [['different stryker options', 1]],
      work: { share: { dryRunMs: 490_000, heldMs: 1_100_000, runs: 3 } },
    });
    expect(appStats().rungs.commit).toMatchObject({
      runs: 1,
      mutated: 0,
      warm: 0,
    });
  });

  it('names a cold run with no reason by its cache and seed', () => {
    const plain = gate({
      stryker: {
        files: 1,
        cache: { local: 'none', seed: 'off' },
        report: 'read',
      },
    });
    expect(
      summarizeRuns([plain], { now: NOW, sinceMs: WEEK }).rungs.push
        ?.coldReasons,
    ).toEqual([['local cache none, seed off', 1]]);
  });

  it('summarizes ships: states and where their time went', () => {
    expect(appStats().ships).toEqual({
      runs: 2,
      states: { green: 1, 'ci-red': 1 },
      pushMs: { median: 600_000, p90: 600_000 },
      gateMs: { median: 590_000, p90: 590_000 },
      ciMs: { median: 300_000, p90: 1_200_000 },
    });
  });

  it('buckets dry-run time by queue depth on arrival', () => {
    expect(appStats().byDepth).toEqual([
      { bucket: '0', runs: 1, dryRunMs: { median: 90_000, p90: 90_000 } },
      { bucket: '1', runs: 1, dryRunMs: { median: 100_000, p90: 100_000 } },
      { bucket: '2', runs: 0 },
      { bucket: '3+', runs: 1, dryRunMs: { median: 300_000, p90: 300_000 } },
    ]);
  });

  it('buckets dry-run time by load per core at the start', () => {
    expect(appStats().byLoad).toEqual([
      {
        bucket: 'under 0.5 per core',
        runs: 2,
        dryRunMs: { median: 90_000, p90: 100_000 },
      },
      { bucket: '0.5–1 per core', runs: 0 },
      {
        bucket: 'over 1 per core',
        runs: 1,
        dryRunMs: { median: 300_000, p90: 300_000 },
      },
    ]);
  });

  it('includes a run that started exactly at either edge of the window, and none after it', () => {
    const edges = [
      gate({ startedAt: '2026-11-12T12:00:00.000Z' }),
      gate({ startedAt: '2026-11-19T12:00:00.000Z' }),
      gate({ startedAt: '2026-11-19T12:00:00.001Z' }),
      gate({ startedAt: '2026-11-12T11:59:59.999Z' }),
    ];
    expect(summarizeRuns(edges, { now: NOW, sinceMs: WEEK }).rows).toBe(2);
  });

  it('lists cold reasons most common first', () => {
    const reasons = summarizeRuns(
      [
        coldFor('once'),
        coldFor('thrice'),
        coldFor('twice'),
        coldFor('thrice'),
        coldFor('twice'),
        coldFor('thrice'),
      ],
      { now: NOW, sinceMs: WEEK },
    ).rungs.push?.coldReasons;
    expect(reasons).toEqual([
      ['thrice', 3],
      ['twice', 2],
      ['once', 1],
    ]);
  });

  it('counts a run with no cache record as cold, for an unknown reason', () => {
    const uncached = gate({ stryker: { files: 1, report: 'missing' } });
    expect(
      summarizeRuns([uncached], { now: NOW, sinceMs: WEEK }).rungs.push,
    ).toMatchObject({
      mutated: 1,
      warm: 0,
      coldReasons: [['local cache unknown, seed unknown', 1]],
    });
  });

  it('buckets no run without a lock record by depth, nor one without a usable machine by load', () => {
    const unbucketed = [
      gate({ lock: undefined, machine: undefined }),
      gate({
        lock: undefined,
        machine: {
          cores: 0,
          concurrency: 'default',
          start: { load1: 2, freeMb: 1 },
          end: { load1: 2, freeMb: 1 },
        },
      }),
    ];
    const stats = summarizeRuns(unbucketed, { now: NOW, sinceMs: WEEK });
    expect(stats.byDepth.map((bucket) => bucket.runs)).toEqual([0, 0, 0, 0]);
    expect(stats.byLoad.map((bucket) => bucket.runs)).toEqual([0, 0, 0]);
  });

  it('puts a load of exactly half a core in the middle bucket', () => {
    const atHalf = gate({
      machine: {
        cores: 4,
        concurrency: 'default',
        start: { load1: 2, freeMb: 1 },
        end: { load1: 2, freeMb: 1 },
      },
    });
    expect(
      summarizeRuns([atHalf], { now: NOW, sinceMs: WEEK }).byLoad.map(
        (bucket) => bucket.runs,
      ),
    ).toEqual([0, 1, 0]);
  });

  it('buckets a gate that mutated nothing without a dry run', () => {
    const quiet = summarizeRuns([gate({ stryker: undefined })], {
      now: NOW,
      sinceMs: WEEK,
    });
    expect(quiet.byDepth[0]).toEqual({ bucket: '0', runs: 0 });
    expect(quiet.byLoad[0]).toEqual({ bucket: 'under 0.5 per core', runs: 0 });
  });

  it('puts a load of exactly one per core in the middle bucket', () => {
    const atOne = gate({
      machine: {
        cores: 4,
        concurrency: 'default',
        start: { load1: 4, freeMb: 1 },
        end: { load1: 4, freeMb: 1 },
      },
    });
    expect(
      summarizeRuns([atOne], { now: NOW, sinceMs: WEEK }).byLoad[1],
    ).toMatchObject({ runs: 1 });
  });
});

describe('one project, across its lanes (#236)', () => {
  const rows: RunRow[] = [
    gate({ repo: 'main', project: 'main' }),
    gate({ repo: 'lane-1', project: 'main' }),
    gate({ repo: 'main' }),
    ship({ repo: 'lane-2', project: 'main' }),
    gate({ repo: 'small', project: 'small' }),
    gate({ repo: 'lane-1', project: 'small' }),
  ];

  it('narrows to a project’s rows, lanes and a row from before projects alike', () => {
    const stats = summarizeRuns(rows, {
      now: NOW,
      sinceMs: WEEK,
      project: 'main',
    });
    expect(stats.rows).toBe(4);
    expect(stats.ships.runs).toBe(1);
  });

  it('narrows by project and folder together when both are named', () => {
    expect(
      summarizeRuns(rows, {
        now: NOW,
        sinceMs: WEEK,
        project: 'small',
        repo: 'lane-1',
      }).rows,
    ).toBe(1);
  });
});

describe('formatStats', () => {
  it('says so when the window holds nothing', () => {
    expect(formatStats(summarizeRuns([], { now: NOW, sinceMs: WEEK }))).toBe(
      'guardrails stats: no gate, ship or lock runs logged from 2026-11-12T12:00:00.000Z to 2026-11-19T12:00:00.000Z.\n',
    );
  });

  it('prints each rung, the ships and the buckets', () => {
    const text = formatStats(
      summarizeRuns(
        [
          gate(),
          gate({
            stryker: {
              files: 1,
              cache: { local: 'discarded', seed: 'off', why: 'a reason' },
              dryRunMs: 30_000,
              report: 'read',
            },
          }),
          ship(),
        ],
        { now: NOW, sinceMs: WEEK },
      ),
    );
    expect(text).toBe(
      [
        'guardrails stats: 3 run(s) from 2026-11-12T12:00:00.000Z to 2026-11-19T12:00:00.000Z',
        'push: 2 run(s) (pass 2)',
        '  queued for the lock: median 1m00s, p90 1m00s',
        '  held the lock: median 5m00s, p90 5m00s',
        '  dry run: median 30s, p90 1m30s',
        '  mutating: median 3m20s, p90 3m20s',
        '  dry run’s share of the lock held: 20% over 2 run(s)',
        '  started warm: 1 of 2',
        '    cold 1×: a reason',
        'ship: 1 run(s) (green 1)',
        '  push, gate included: median 10m00s, p90 10m00s',
        '  gate: median 9m50s, p90 9m50s',
        '  CI: median 20m00s, p90 20m00s',
        'dry run by queue depth on arrival:',
        '  0: 2 run(s), median 30s',
        'dry run by load at start:',
        '  under 0.5 per core: 2 run(s), median 30s',
        '',
      ].join('\n'),
    );
  });

  it('prints nothing for a rung’s missing times, mutation or buckets, nor for no ships', () => {
    const bare = gate({
      rung: 'commit',
      lock: undefined,
      stryker: undefined,
      machine: undefined,
    });
    expect(
      formatStats(summarizeRuns([bare], { now: NOW, sinceMs: WEEK })),
    ).toBe(
      [
        'guardrails stats: 1 run(s) from 2026-11-12T12:00:00.000Z to 2026-11-19T12:00:00.000Z',
        'commit: 1 run(s) (pass 1)',
        '',
      ].join('\n'),
    );
  });
});

function lockRun(over: Partial<LockRow> = {}): LockRow {
  return {
    v: 1,
    kind: 'lock',
    repo: 'app',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T10:30:00.000Z',
    command: 'npm',
    commandHash: '0123456789abcdef',
    exitCode: 0,
    outcome: 'ran',
    lock: { queuedMs: 120_000, heldMs: 1_200_000, depthOnArrival: 0 },
    ...over,
  };
}

describe('lock runs in the stats (#201)', () => {
  const rows: RunRow[] = [
    gate(),
    lockRun(),
    lockRun({ command: 'make', lock: undefined, outcome: 'unserialized' }),
    lockRun({
      outcome: 'lock-timeout',
      exitCode: 75,
      lock: { queuedMs: 600_000, heldMs: 0, depthOnArrival: 2 },
    }),
  ];

  it('counts lock runs apart from the rungs, by outcome and command', () => {
    const stats = summarizeRuns(rows, { now: NOW, sinceMs: WEEK });
    expect(stats.rows).toBe(4);
    expect(Object.keys(stats.rungs)).toEqual(['push']);
    expect(stats.rungs.push?.runs).toBe(1);
    expect(stats.locks).toEqual({
      runs: 3,
      outcomes: { ran: 1, unserialized: 1, 'lock-timeout': 1 },
      queuedMs: { median: 120_000, p90: 600_000 },
      heldMs: { median: 0, p90: 1_200_000 },
      commands: [
        ['npm', 2],
        ['make', 1],
      ],
    });
  });

  it('leaves lock runs out of the dry-run buckets', () => {
    const stats = summarizeRuns(rows, { now: NOW, sinceMs: WEEK });
    expect(stats.byDepth.map((bucket) => bucket.runs)).toEqual([1, 0, 0, 0]);
  });

  it('prints a lock section', () => {
    expect(
      formatStats(summarizeRuns(rows.slice(1), { now: NOW, sinceMs: WEEK })),
    ).toBe(
      [
        'guardrails stats: 3 run(s) from 2026-11-12T12:00:00.000Z to 2026-11-19T12:00:00.000Z',
        'lock: 3 run(s) (ran 1, unserialized 1, lock-timeout 1)',
        '  queued for the lock: median 2m00s, p90 10m00s',
        '  held the lock: median 0s, p90 20m00s',
        '  commands: npm 2, make 1',
        '',
      ].join('\n'),
    );
  });

  it('prints no lock section with no lock runs', () => {
    expect(
      formatStats(summarizeRuns([gate()], { now: NOW, sinceMs: WEEK })),
    ).not.toMatch(/^(lock:| {2}commands:)/m);
  });
});

describe('what timeouts cost, in the stats (#236)', () => {
  type StrykerPart = NonNullable<GateRow['stryker']>;

  function costs(
    over: Partial<NonNullable<StrykerPart['timeoutCost']>>,
  ): NonNullable<StrykerPart['timeoutCost']> {
    return {
      wallClock: 0,
      hitLimit: 0,
      budgetMs: 0,
      wallClockGapMs: 0,
      otherGapMs: 0,
      byFile: [],
      ...over,
    };
  }

  function timed(over: Partial<StrykerPart>): GateRow {
    return gate({
      stryker: { files: 1, report: 'read', mutatingMs: 100_000, ...over },
    });
  }

  /**
  A run at concurrency 4 with many timeouts in one table, mostly overhead.
  */
  const LOADED = timed({
    mutatingMs: 6_000_000,
    timeoutCost: costs({
      wallClock: 80,
      budgetMs: 80 * 190_000,
      byFile: [
        { file: 'src/table.ts', count: 80, firstLine: 12, lastLine: 940 },
      ],
    }),
    timeoutSettings: {
      timeoutMS: 5000,
      timeoutFactor: 1.5,
      concurrency: 4,
      dryRunOverheadMs: 180_000,
    },
  });

  /**
  A run at concurrency 1 whose timeouts were re-tested alone.
  */
  const ALONE = timed({
    timeoutCost: costs({
      wallClock: 2,
      hitLimit: 1,
      budgetMs: 20_000,
      wallClockGapMs: 30_000,
      byFile: [{ file: 'src/b.ts', count: 2, firstLine: 3, lastLine: 3 }],
    }),
    timeoutSettings: {
      timeoutMS: 5000,
      timeoutFactor: 1.5,
      concurrency: 1,
      dryRunOverheadMs: 4000,
    },
    retestMutatingMs: 40_000,
    retestBudgetMs: 24_000,
    retestTimedOut: 2,
  });

  /**
  The timeout lines the stats print for `rows`, exactly.
  */
  function linesFor(rows: GateRow[]): string[] {
    return timeoutLines(
      summarizeTimeouts(
        rows.map((row) => row.stryker ?? { files: 0, report: 'missing' }),
      ),
      duration,
    );
  }

  const HEADER_TAIL =
    'stryker restarts its test runner after each wall-clock one';

  it('prints them under the rung, after its warm and cold lines', () => {
    const text = formatStats(
      summarizeRuns([LOADED], { now: NOW, sinceMs: WEEK }),
    );
    expect(text).toContain(
      `    cold 1×: local cache unknown, seed unknown\n  timeouts: 80 wall-clock and 0 hit-limit in 1 run(s); ${HEADER_TAIL}\n`,
    );
  });

  it('says where a wall-clock timeout’s time goes, estimating above concurrency 1', () => {
    expect(linesFor([LOADED, ALONE, gate()])).toEqual([
      `  timeouts: 82 wall-clock and 1 hit-limit in 2 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 3m06s on average, 2m56s (95%) of it the dry run’s overhead',
      '    share of mutating time: 63% (estimated from budgets: a run above concurrency 1)',
      '    re-tested alone: 20s per timeout against a budget of 12s, 8s over',
      '    settings: timeoutMS 5000, timeoutFactor 1.5 in 2 run(s)',
      '    most wall-clock timeouts: src/table.ts 80 (lines 12–940), src/b.ts 2 (line 3)',
    ]);
  });

  it('measures the share at concurrency 1, and adds up a file across runs', () => {
    const later = timed({
      timeoutCost: costs({
        wallClock: 1,
        budgetMs: 5000,
        wallClockGapMs: 10_000,
        byFile: [{ file: 'src/b.ts', count: 1, firstLine: 9, lastLine: 9 }],
      }),
      timeoutSettings: { concurrency: 1, timeoutFactor: 2 },
    });
    expect(linesFor([ALONE, later])).toEqual([
      `  timeouts: 3 wall-clock and 1 hit-limit in 2 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 8s on average, 4s (40%) of it the dry run’s overhead',
      '    share of mutating time: 20% (measured: every run at concurrency 1)',
      '    re-tested alone: 20s per timeout against a budget of 12s, 8s over',
      '    settings: timeoutMS 5000, timeoutFactor 1.5 in 1 run(s); timeoutMS default, timeoutFactor 2 in 1 run(s)',
      '    most wall-clock timeouts: src/b.ts 3 (lines 3–9)',
    ]);
  });

  /**
  A run of `count` wall-clock timeouts, all in `file`, under `timeoutMS`.
  */
  function ranked(file: string, timeoutMS: number, count: number): GateRow {
    return timed({
      timeoutCost: costs({
        wallClock: count,
        budgetMs: count * 1000,
        byFile: [{ file, count, firstLine: 1, lastLine: 1 }],
      }),
      timeoutSettings: { timeoutMS },
    });
  }

  it('ranks settings and files by how often they come up, not by order', () => {
    expect(
      linesFor([
        ranked('src/a.ts', 1, 1),
        ranked('src/c.ts', 2, 2),
        ranked('src/c.ts', 2, 2),
      ]),
    ).toEqual([
      `  timeouts: 5 wall-clock and 0 hit-limit in 3 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 1s on average',
      '    settings: timeoutMS 2, timeoutFactor default in 2 run(s); timeoutMS 1, timeoutFactor default in 1 run(s)',
      '    most wall-clock timeouts: src/c.ts 4 (line 1), src/a.ts 1 (line 1)',
    ]);
  });

  it('names at most five files', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => ({
      file: `src/${name}.ts`,
      count: 6 - index,
      firstLine: 1,
      lastLine: 1,
    }));
    const line = linesFor([
      timed({ timeoutCost: costs({ wallClock: 21, byFile: files }) }),
    ]).find((each) => each.includes('most wall-clock'));
    expect(line).toContain('src/e.ts 2');
    expect(line).not.toContain('src/f.ts');
  });

  it('leaves the overhead out when no run with wall-clock timeouts knows it', () => {
    expect(
      linesFor([
        timed({
          timeoutCost: costs({ hitLimit: 1 }),
          timeoutSettings: { dryRunOverheadMs: 4000 },
        }),
        timed({ timeoutCost: costs({ wallClock: 1, budgetMs: 5000 }) }),
      ]),
    ).toEqual([
      `  timeouts: 1 wall-clock and 1 hit-limit in 2 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 5s on average',
      '    settings: timeoutMS default, timeoutFactor default in 1 run(s)',
    ]);
  });

  it('says a re-test came in under its budget, and leaves out what no run knows', () => {
    const under = timed({
      timeoutCost: costs({ wallClock: 1, budgetMs: 5000 }),
      retestMutatingMs: 4000,
      retestBudgetMs: 5000,
      retestTimedOut: 1,
    });
    expect(linesFor([under])).toEqual([
      `  timeouts: 1 wall-clock and 0 hit-limit in 1 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 5s on average',
      '    re-tested alone: 4s per timeout against a budget of 5s, 1s under',
    ]);
  });

  it('says a re-test that cost exactly its budget is not under it', () => {
    const exact = timed({
      timeoutCost: costs({ wallClock: 1, budgetMs: 5000 }),
      retestMutatingMs: 5000,
      retestBudgetMs: 5000,
      retestTimedOut: 1,
    });
    expect(linesFor([exact])).toContain(
      '    re-tested alone: 5s per timeout against a budget of 5s, 0s over',
    );
  });

  it.each<[string, Partial<StrykerPart>]>([
    ['its time', { retestBudgetMs: 5000, retestTimedOut: 1 }],
    ['its budget', { retestMutatingMs: 5000, retestTimedOut: 1 }],
    ['its timeouts', { retestMutatingMs: 5000, retestBudgetMs: 5000 }],
    [
      'any timeout timed out again',
      { retestMutatingMs: 5000, retestBudgetMs: 0, retestTimedOut: 0 },
    ],
  ])('prints no re-test without %s', (_label, retest) => {
    expect(
      linesFor([
        timed({
          timeoutCost: costs({ wallClock: 1, budgetMs: 5000 }),
          ...retest,
        }),
      ]),
    ).toEqual([
      `  timeouts: 1 wall-clock and 0 hit-limit in 1 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 5s on average',
    ]);
  });

  it('estimates no share for a run that does not know its mutating time', () => {
    expect(
      linesFor([
        timed({
          mutatingMs: undefined,
          timeoutCost: costs({ wallClock: 1, budgetMs: 5000 }),
          timeoutSettings: { concurrency: 1 },
        }),
      ]),
    ).toEqual([
      `  timeouts: 1 wall-clock and 0 hit-limit in 1 run(s); ${HEADER_TAIL}`,
      '    budget per wall-clock timeout: 5s on average',
      '    settings: timeoutMS default, timeoutFactor default in 1 run(s)',
    ]);
  });

  it('caps an estimated share at the run’s whole mutating time', () => {
    expect(
      linesFor([
        timed({
          mutatingMs: 1000,
          timeoutCost: costs({ wallClock: 1, budgetMs: 8000 }),
          timeoutSettings: { concurrency: 2 },
        }),
      ]),
    ).toContain(
      '    share of mutating time: 100% (estimated from budgets: a run above concurrency 1)',
    );
  });

  it('says there were none in the runs that measured them', () => {
    expect(linesFor([timed({ timeoutCost: costs({}) }), gate()])).toEqual([
      '  timeouts: none in 1 run(s) that measured them',
    ]);
  });

  it('says nothing of timeouts when no run measured them', () => {
    expect(linesFor([gate()])).toEqual([]);
    expect(
      formatStats(summarizeRuns([gate()], { now: NOW, sinceMs: WEEK })),
    ).not.toContain('timeouts');
  });

  it('counts hit-limit timeouts alone, with no budget to split', () => {
    expect(linesFor([timed({ timeoutCost: costs({ hitLimit: 3 }) })])).toEqual([
      `  timeouts: 0 wall-clock and 3 hit-limit in 1 run(s); ${HEADER_TAIL}`,
    ]);
  });
});

describe('duration', () => {
  it.each([
    [0, '0s'],
    [59_400, '59s'],
    [59_600, '1m00s'],
    [61_000, '1m01s'],
    [3_725_000, '62m05s'],
  ])('prints %i ms as %s', (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});

describe('parseSince', () => {
  it.each([
    ['7d', WEEK],
    ['24h', 86_400_000],
    ['90m', 5_400_000],
  ])('reads %s', (text, ms) => {
    expect(parseSince(text)).toBe(ms);
  });

  it.each(['7', 'd', '7w', ' 7d', '7d ', '-1d', '1.5h'])(
    'rejects %j',
    (text) => {
      expect(parseSince(text)).toBeUndefined();
    },
  );
});
