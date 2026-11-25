import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRun,
  concurrencyOf,
  type GateRow,
  parseRuns,
  runLogPath,
  sampleMachine,
  type ShipRow,
} from '../src/run-log.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'guardrails-run-log-'));
});

afterEach(() => {
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
});

const MACHINE = {
  cores: 10,
  concurrency: 'default',
  start: { load1: 6.1, freeMb: 2100 },
  end: { load1: 7.4, freeMb: 1800 },
};

const GATE: GateRow = {
  v: 1,
  kind: 'gate',
  rung: 'push',
  repo: 'dialed.run',
  branch: 'w15-sec-l23',
  ship: 'ship-1',
  startedAt: '2026-11-19T10:00:00.000Z',
  finishedAt: '2026-11-19T10:40:00.000Z',
  outcome: 'pass',
  lock: {
    queuedMs: 812_000,
    heldMs: 1_460_000,
    holderOnArrival: 'dialed.run (push), mutating 120/400',
    depthOnArrival: 2,
  },
  stryker: {
    files: 3,
    cache: { local: 'none', seed: 'refused', why: 'different stryker options' },
    dryRunMs: 95_000,
    mutatingMs: 1_300_000,
    mutants: 412,
    reused: 380,
    timeouts: 6,
    survivors: 0,
    noCoverage: 0,
    retested: 4,
    rescored: 1,
    report: 'read',
  },
  machine: MACHINE,
};

const SHIP: ShipRow = {
  v: 1,
  kind: 'ship',
  repo: 'dialed.run',
  branch: 'w15-sec-l23',
  ship: 'ship-1',
  startedAt: '2026-11-19T10:00:00.000Z',
  finishedAt: '2026-11-19T11:00:00.000Z',
  pr: 885,
  state: 'green',
  pushMs: 2_400_000,
  gateMs: 2_390_000,
  ciMs: 1_200_000,
  machine: MACHINE,
};

describe('runLogPath', () => {
  it('sits beside the gate lock', () => {
    expect(runLogPath('/home/u/.guardrails-gate.lock')).toBe(
      '/home/u/.guardrails-gate.lock.runs.jsonl',
    );
  });
});

describe('appendRun and parseRuns', () => {
  it('round-trips rows one line each, oldest first', () => {
    const file = path.join(directory, 'runs.jsonl');
    expect(appendRun(file, GATE)).toBeUndefined();
    expect(appendRun(file, SHIP)).toBeUndefined();
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRuns(text)).toEqual([GATE, SHIP]);
  });

  it('answers an error, rather than throwing, when the log cannot be written', () => {
    chmodSync(directory, 0o500);
    const error = appendRun(path.join(directory, 'runs.jsonl'), GATE);
    expect(error).toMatch(/EACCES|permission/i);
  });

  it('skips a line that is malformed, of another version, or of no known kind', () => {
    const text = [
      JSON.stringify(GATE),
      '{"v":1,"kind":"gate"',
      JSON.stringify({ ...GATE, v: 2 }),
      JSON.stringify({ ...GATE, kind: 'other' }),
      JSON.stringify({ ...GATE, repo: 3 }),
      JSON.stringify({ ...GATE, startedAt: undefined }),
      JSON.stringify({ ...SHIP, finishedAt: 1 }),
      '',
      JSON.stringify(SHIP),
    ].join('\n');
    expect(parseRuns(text)).toEqual([GATE, SHIP]);
  });

  it('keeps a row but drops a part that is malformed', () => {
    const row = {
      ...GATE,
      lock: { queuedMs: 'long' },
      stryker: { ...GATE.stryker, dryRunMs: '95s' },
      machine: { cores: 'ten' },
    };
    const [parsed] = parseRuns(JSON.stringify(row));
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty('lock');
    expect(parsed).not.toHaveProperty('machine');
    expect(parsed?.kind === 'gate' && parsed.stryker).toEqual({
      ...GATE.stryker,
      dryRunMs: undefined,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['without a rung', { ...GATE, rung: undefined }],
    ['without an outcome', { ...GATE, outcome: 7 }],
    ['without a state', { ...SHIP, state: undefined }],
    ['without a push time', { ...SHIP, pushMs: '40m' }],
    ['of a ship row’s fields but another kind', { ...SHIP, kind: 'other' }],
  ])('skips a row %s', (_label, row) => {
    const text = [JSON.stringify(row), JSON.stringify(SHIP)].join('\n');
    expect(parseRuns(text)).toEqual([SHIP]);
  });

  it('skips a ship row whose push time overflows to infinity', () => {
    const text = JSON.stringify(SHIP).replace(
      '"pushMs":2400000',
      '"pushMs":1e999',
    );
    expect(text).toContain('1e999');
    expect(parseRuns(`${text}\n${JSON.stringify(GATE)}`)).toEqual([GATE]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['its cores', { ...MACHINE, cores: 'ten' }],
    ['its concurrency', { ...MACHINE, concurrency: undefined }],
    ['its start', { ...MACHINE, start: { load1: 6.1 } }],
    ['its end', { ...MACHINE, end: 'later' }],
  ])('drops a machine part missing %s', (_label, machine) => {
    const [parsed] = parseRuns(JSON.stringify({ ...SHIP, machine }));
    expect(parsed).toEqual({ ...SHIP, machine: undefined });
    expect(parsed).not.toHaveProperty('machine');
  });

  it.each<[string, Record<string, unknown>]>([
    ['without a file count', { ...GATE.stryker, files: undefined }],
    ['with a report of no known state', { ...GATE.stryker, report: 'lost' }],
    ['without a report state', { ...GATE.stryker, report: undefined }],
  ])('drops a stryker part %s', (_label, stryker) => {
    const [parsed] = parseRuns(JSON.stringify({ ...GATE, stryker }));
    expect(parsed).toEqual({ ...GATE, stryker: undefined });
    expect(parsed).not.toHaveProperty('stryker');
  });

  it('keeps a stryker part whose report went missing', () => {
    const stryker = { files: 2, report: 'missing' };
    expect(parseRuns(JSON.stringify({ ...GATE, stryker }))).toEqual([
      { ...GATE, stryker },
    ]);
  });

  it('reads a ship row with no PR, gate or CI time', () => {
    const row: ShipRow = {
      ...SHIP,
      pr: null,
      state: 'gate-blocked',
      gateMs: undefined,
      ciMs: undefined,
    };
    const file = path.join(directory, 'runs.jsonl');
    writeFileSync(file, `${JSON.stringify(row)}\n`);
    const [parsed] = parseRuns(readFileSync(file, 'utf8'));
    expect(parsed).toEqual(row);
    expect(parsed).not.toHaveProperty('gateMs');
    expect(parsed).not.toHaveProperty('ciMs');
  });
});

describe('sampleMachine', () => {
  it('reads the 1-minute load and free memory in MB, rounded', () => {
    expect(
      sampleMachine({
        loadavg: () => [6.123, 5, 4],
        freemem: () => 2.5 * 1024 * 1024 * 1024,
      }),
    ).toEqual({ load1: 6.12, freeMb: 2560 });
  });

  it('reads the real machine', () => {
    const sample = sampleMachine();
    expect(sample.load1).toBeGreaterThanOrEqual(0);
    expect(sample.freeMb).toBeGreaterThan(0);
  });
});

describe('concurrencyOf', () => {
  it.each([
    ['{"concurrency":4}', '4'],
    ['{"concurrency":"50%"}', '50%'],
    ['{"testRunner":"vitest"}', 'default'],
    ['{"concurrency":true}', 'default'],
    ['not json', 'default'],
  ])('reads %s as %s', (config, expected) => {
    expect(concurrencyOf(config)).toBe(expected);
  });
});
