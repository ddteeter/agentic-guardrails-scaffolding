import { describe, expect, it } from 'vitest';

import type { GateRow, RunRow, ShipRow } from '../src/run-log.js';
import {
  duration,
  formatStats,
  parseSince,
  spreadOf,
  summarizeRuns,
} from '../src/run-stats.js';

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

  const stats = summarizeRuns(rows, { now: NOW, sinceMs: WEEK, repo: 'app' });

  it('keeps the rows inside the window and the repo', () => {
    expect(stats.rows).toBe(6);
    expect(stats.from).toBe('2026-11-12T12:00:00.000Z');
    expect(stats.to).toBe('2026-11-19T12:00:00.000Z');
  });

  it('takes every repo when none is named', () => {
    expect(summarizeRuns(rows, { now: NOW, sinceMs: WEEK }).rows).toBe(7);
  });

  it('summarizes each rung: outcomes, lock and phase times, warm share and cold reasons', () => {
    expect(stats.rungs.push).toEqual({
      runs: 3,
      outcomes: { pass: 2, block: 1 },
      queuedMs: { median: 60_000, p90: 900_000 },
      heldMs: { median: 300_000, p90: 600_000 },
      dryRunMs: { median: 100_000, p90: 300_000 },
      mutatingMs: { median: 200_000, p90: 200_000 },
      mutated: 3,
      warm: 2,
      coldReasons: [['different stryker options', 1]],
    });
    expect(stats.rungs.commit).toMatchObject({ runs: 1, mutated: 0, warm: 0 });
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
    expect(stats.ships).toEqual({
      runs: 2,
      states: { green: 1, 'ci-red': 1 },
      pushMs: { median: 600_000, p90: 600_000 },
      gateMs: { median: 590_000, p90: 590_000 },
      ciMs: { median: 300_000, p90: 1_200_000 },
    });
  });

  it('buckets dry-run time by queue depth on arrival', () => {
    expect(stats.byDepth).toEqual([
      { bucket: '0', runs: 1, dryRunMs: { median: 90_000, p90: 90_000 } },
      { bucket: '1', runs: 1, dryRunMs: { median: 100_000, p90: 100_000 } },
      { bucket: '2', runs: 0 },
      { bucket: '3+', runs: 1, dryRunMs: { median: 300_000, p90: 300_000 } },
    ]);
  });

  it('buckets dry-run time by load per core at the start', () => {
    expect(stats.byLoad).toEqual([
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

describe('formatStats', () => {
  it('says so when the window holds nothing', () => {
    expect(formatStats(summarizeRuns([], { now: NOW, sinceMs: WEEK }))).toBe(
      'guardrails stats: no gate or ship runs logged from 2026-11-12T12:00:00.000Z to 2026-11-19T12:00:00.000Z.\n',
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
