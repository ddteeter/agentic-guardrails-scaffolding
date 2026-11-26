import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec } from '../src/exec.js';
import {
  type GateRunInput,
  logGateRun,
  logLockRun,
  logShipRun,
  projectName,
  type RunClock,
  startRun,
} from '../src/gate-run-log.js';
import { parseRuns } from '../src/run-log.js';
import type { MutationRunRecord } from '../src/verify/mutation-run.js';

let directory: string;
let lockPath: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'guardrails-gate-run-log-'));
  lockPath = path.join(directory, 'gate.lock');
});

/**
Where a log path built from an undefined lock would land.
*/
const STRAY = path.resolve('undefined.runs.jsonl');

afterEach(() => {
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
  rmSync(STRAY, { force: true });
});

function collecting(): { warnings: string[]; warn: (line: string) => void } {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (line) => {
      warnings.push(line);
    },
  };
}

const CLOCK: RunClock = {
  now: () => new Date('2026-11-19T10:05:00.000Z'),
  sample: () => ({ load1: 7, freeMb: 1800 }),
  cores: () => 10,
};

const START = {
  startedAt: '2026-11-19T10:00:00.000Z',
  machine: { load1: 6, freeMb: 2100 },
};

/**
On `feat/x`, in a lane worktree of the `app-clone` clone.
*/
const onBranch: Exec = (_command, args) =>
  Promise.resolve({
    stdout: args.includes('--git-common-dir')
      ? '/work/app-clone/.git\n'
      : 'feat/x\n',
    stderr: '',
    code: 0,
  });

const RAN: MutationRunRecord = {
  didRun: true,
  lock: { queuedMs: 1000, heldMs: 4000, depthOnArrival: 0 },
  stryker: {
    files: 2,
    cache: { local: 'kept', seed: 'off' },
    mutants: 9,
    timeouts: 0,
    survivors: 1,
    noCoverage: 0,
    report: 'read',
  },
  concurrency: '3',
};

const QUEUED_ONLY: MutationRunRecord = {
  didRun: false,
  lock: {
    queuedMs: 60_000,
    heldMs: 0,
    holderOnArrival: 'app (push)',
    depthOnArrival: 1,
  },
  stryker: {
    files: 2,
    cache: { local: 'kept', seed: 'off' },
    report: 'missing',
  },
};

function ignoreWarning(line: string): void {
  expect(line).toBeTypeOf('string');
}

function input(over: Partial<GateRunInput> = {}): GateRunInput {
  return {
    lockPath,
    repoRoot: '/work/dialed.run',
    exec: onBranch,
    rung: 'push',
    start: START,
    mutationRun: RAN,
    isBlocked: false,
    environment: {},
    warn: ignoreWarning,
    clock: CLOCK,
    ...over,
  };
}

function rows() {
  const file = `${lockPath}.runs.jsonl`;
  return existsSync(file) ? parseRuns(readFileSync(file, 'utf8')) : [];
}

describe('logGateRun', () => {
  it('appends one row beside the lock, with every part', async () => {
    await logGateRun(input({ environment: { GUARDRAILS_SHIP_ID: 'ship-7' } }));
    expect(rows()).toEqual([
      {
        v: 1,
        kind: 'gate',
        rung: 'push',
        repo: 'dialed.run',
        project: 'app-clone',
        branch: 'feat/x',
        ship: 'ship-7',
        startedAt: '2026-11-19T10:00:00.000Z',
        finishedAt: '2026-11-19T10:05:00.000Z',
        outcome: 'pass',
        lock: RAN.lock,
        stryker: RAN.stryker,
        machine: {
          cores: 10,
          concurrency: '3',
          start: { load1: 6, freeMb: 2100 },
          end: { load1: 7, freeMb: 1800 },
        },
      },
    ]);
  });

  it.each<[string, MutationRunRecord | undefined, boolean, string]>([
    ['a block', RAN, true, 'block'],
    ['a deferral', QUEUED_ONLY, false, 'defer'],
    ['a lock timeout', QUEUED_ONLY, true, 'lock-timeout'],
    ['a pass with nothing to mutate', undefined, false, 'pass'],
    [
      'a pass whose stryker ran in no time and left no report',
      { ...QUEUED_ONLY, didRun: true },
      false,
      'pass',
    ],
    [
      'a block whose stryker ran in no time and left no report',
      { ...QUEUED_ONLY, didRun: true },
      true,
      'block',
    ],
  ])('records %s', async (_label, mutationRun, isBlocked, outcome) => {
    await logGateRun(input({ mutationRun, isBlocked, rung: 'commit' }));
    expect(rows()[0]).toMatchObject({ outcome });
  });

  it('writes a commit gate’s row with nothing to mutate, without lock or stryker parts', async () => {
    await logGateRun(input({ mutationRun: undefined, rung: 'commit' }));
    const [row] = rows();
    expect(row).not.toHaveProperty('lock');
    expect(row).not.toHaveProperty('stryker');
    expect(row?.machine?.concurrency).toBe('default');
  });

  it('writes no row for a stop turn with nothing to mutate', async () => {
    await logGateRun(input({ mutationRun: undefined, rung: 'stop' }));
    expect(rows()).toEqual([]);
  });

  it('writes a stop turn’s row when stryker had something in scope', async () => {
    await logGateRun(input({ rung: 'stop' }));
    expect(rows()).toHaveLength(1);
  });

  it('writes nothing without a gate lock to sit beside', async () => {
    const { warnings, warn } = collecting();
    await logGateRun(input({ lockPath: undefined, warn }));
    expect(existsSync(`${lockPath}.runs.jsonl`)).toBe(false);
    expect(existsSync(STRAY)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('warns nothing when the row is written', async () => {
    const { warnings, warn } = collecting();
    await logGateRun(input({ warn }));
    expect(rows()).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it.each<[string, Exec]>([
    [
      'git fails',
      () => Promise.resolve({ stdout: 'x', stderr: 'fatal', code: 128 }),
    ],
    [
      'git prints nothing',
      () => Promise.resolve({ stdout: '\n', stderr: '', code: 0 }),
    ],
  ])(
    'leaves out the branch, and names the project by its folder, when %s',
    async (_label, exec) => {
      await logGateRun(input({ exec }));
      expect(rows()[0]).not.toHaveProperty('branch');
      expect(rows()[0]).toMatchObject({
        repo: 'dialed.run',
        project: 'dialed.run',
      });
    },
  );

  it('asks git for the branch and the clone in the repository it gates', async () => {
    const asked: (string | undefined)[] = [];
    const exec: Exec = (command, args, options) => {
      asked.push([command, ...args, options?.cwd].join(' '));
      return onBranch(command, args);
    };
    await logGateRun(input({ exec }));
    expect(
      asked.toSorted((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    ).toEqual([
      'git rev-parse --abbrev-ref HEAD /work/dialed.run',
      'git rev-parse --git-common-dir /work/dialed.run',
    ]);
  });

  it('leaves out an empty ship id', async () => {
    await logGateRun(input({ environment: { GUARDRAILS_SHIP_ID: '' } }));
    expect(rows()[0]).not.toHaveProperty('ship');
  });

  it('warns, and does not throw, when the log cannot be written', async () => {
    chmodSync(directory, 0o500);
    const warnings: string[] = [];
    await logGateRun(
      input({
        warn: (line) => {
          warnings.push(line);
        },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^guardrails: could not write the run log \(/);
  });
});

describe('startRun', () => {
  it('records the start time and the machine', () => {
    expect(startRun(CLOCK)).toEqual({
      startedAt: '2026-11-19T10:05:00.000Z',
      machine: { load1: 7, freeMb: 1800 },
    });
  });

  it('reads the real clock and machine by default', () => {
    const start = startRun();
    expect(Date.parse(start.startedAt)).not.toBeNaN();
    expect(start.machine.freeMb).toBeGreaterThan(0);
  });
});

function gateRow(ship: string, seconds: number): string {
  return JSON.stringify({
    v: 1,
    kind: 'gate',
    rung: 'push',
    repo: 'r',
    ship,
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: new Date(
      Date.parse('2026-11-19T10:00:00.000Z') + seconds * 1000,
    ).toISOString(),
    outcome: 'pass',
  });
}

describe('logShipRun', () => {
  const STATUS = { state: 'green', branch: 'feat/x', pr: 9 };

  it('sums the time of every gate row with its id: ship’s gate and the hook’s (#204)', () => {
    writeFileSync(
      `${lockPath}.runs.jsonl`,
      `${[gateRow('ship-1', 10), gateRow('ship-2', 99), gateRow('ship-1', 40)].join('\n')}\n`,
    );
    logShipRun({
      lockPath,
      repoRoot: '/work/app',
      project: 'app-clone',
      shipId: 'ship-1',
      start: START,
      status: STATUS,
      pushMs: 5000,
      ciMs: undefined,
      warn: ignoreWarning,
      clock: CLOCK,
    });
    expect(rows().at(-1)).toMatchObject({
      kind: 'ship',
      repo: 'app',
      project: 'app-clone',
      gateMs: 50_000,
      pushMs: 5000,
    });
  });

  it('warns, and does not throw, when the log cannot be written', () => {
    chmodSync(directory, 0o500);
    const warnings: string[] = [];
    logShipRun({
      lockPath,
      repoRoot: '/work/app',
      project: 'app-clone',
      shipId: 'ship-1',
      start: START,
      status: STATUS,
      pushMs: undefined,
      ciMs: undefined,
      warn: (line) => {
        warnings.push(line);
      },
      clock: CLOCK,
    });
    expect(warnings[0]).toMatch(/^guardrails: could not write the run log \(/);
  });
});

describe('logShipRun, further', () => {
  const STATUS = { state: 'green', branch: 'feat/x', pr: 9 };

  function ship(over: Partial<Parameters<typeof logShipRun>[0]> = {}) {
    const { warnings, warn } = collecting();
    logShipRun({
      lockPath,
      repoRoot: '/work/app',
      project: 'app-clone',
      shipId: 'ship-1',
      start: START,
      status: STATUS,
      pushMs: 1000,
      ciMs: 2000,
      warn,
      clock: CLOCK,
      ...over,
    });
    return warnings;
  }

  it('warns nothing when the row is written', () => {
    expect(ship()).toEqual([]);
    expect(rows()).toHaveLength(1);
  });

  it('writes nothing, anywhere, without a gate lock', () => {
    expect(ship({ lockPath: undefined })).toEqual([]);
    expect(existsSync(`${lockPath}.runs.jsonl`)).toBe(false);
    expect(existsSync(STRAY)).toBe(false);
  });

  it('reads its gate time from a gate row, never from a ship row with its id', () => {
    const shipRow = JSON.stringify({
      v: 1,
      kind: 'ship',
      repo: 'r',
      ship: 'ship-1',
      startedAt: '2026-11-19T10:00:00.000Z',
      finishedAt: '2026-11-19T10:00:01.000Z',
      state: 'green',
      pushMs: 0,
    });
    writeFileSync(
      `${lockPath}.runs.jsonl`,
      `${[gateRow('ship-1', 40), gateRow('ship-2', 99), shipRow].join('\n')}\n`,
    );
    ship();
    expect(rows().at(-1)).toMatchObject({ kind: 'ship', gateMs: 40_000 });
  });

  it('records no gate time, not zero, when no gate row carries its id', () => {
    writeFileSync(`${lockPath}.runs.jsonl`, `${gateRow('ship-2', 99)}\n`);
    ship();
    expect(rows().at(-1)).not.toHaveProperty('gateMs');
  });
});

function logged(): unknown[] {
  return parseRuns(readFileSync(`${lockPath}.runs.jsonl`, 'utf8'));
}

describe('logLockRun (#201)', () => {
  const RUN = {
    command: 'npm',
    commandHash: '0123456789abcdef',
    exitCode: 0,
    outcome: 'ran',
  };

  it('appends one lock row beside the lock, with every part', () => {
    const { warnings, warn } = collecting();
    logLockRun({
      lockPath,
      repoRoot: '/dev/app',
      project: 'app-clone',
      branch: 'feat/x',
      start: START,
      run: {
        ...RUN,
        lock: { queuedMs: 5, heldMs: 7, depthOnArrival: 1 },
      },
      environment: { GUARDRAILS_SHIP_ID: 'ship-9' },
      warn,
      clock: CLOCK,
    });
    expect(logged()).toEqual([
      {
        v: 1,
        kind: 'lock',
        repo: 'app',
        project: 'app-clone',
        branch: 'feat/x',
        ship: 'ship-9',
        startedAt: '2026-11-19T10:00:00.000Z',
        finishedAt: '2026-11-19T10:05:00.000Z',
        ...RUN,
        lock: { queuedMs: 5, heldMs: 7, depthOnArrival: 1 },
        machine: {
          cores: 10,
          concurrency: 'default',
          start: { load1: 6, freeMb: 2100 },
          end: { load1: 7, freeMb: 1800 },
        },
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it('leaves out an empty ship id, an unknown branch and a missing signal', () => {
    logLockRun({
      lockPath,
      repoRoot: '/dev/app',
      project: 'app-clone',
      branch: undefined,
      start: START,
      run: RUN,
      environment: { GUARDRAILS_SHIP_ID: '' },
      warn: collecting().warn,
      clock: CLOCK,
    });
    const [row] = logged();
    expect(row).not.toHaveProperty('ship');
    expect(row).not.toHaveProperty('branch');
    expect(row).not.toHaveProperty('signal');
    expect(row).not.toHaveProperty('lock');
  });

  it('records the signal of a run that was killed', () => {
    logLockRun({
      lockPath,
      repoRoot: '/dev/app',
      project: 'app-clone',
      branch: undefined,
      start: START,
      run: { ...RUN, exitCode: 143, signal: 'SIGTERM', outcome: 'killed' },
      environment: {},
      warn: collecting().warn,
      clock: CLOCK,
    });
    expect(logged()).toMatchObject([
      { exitCode: 143, signal: 'SIGTERM', outcome: 'killed' },
    ]);
  });

  it('warns, and does not throw, when the log cannot be written', () => {
    chmodSync(directory, 0o500);
    const { warnings, warn } = collecting();
    logLockRun({
      lockPath,
      repoRoot: '/dev/app',
      project: 'app-clone',
      branch: undefined,
      start: START,
      run: RUN,
      environment: {},
      warn,
      clock: CLOCK,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^guardrails: could not write the run log \(.*(EACCES|permission).*\)\.$/i,
    );
  });
});

describe('projectName (#236)', () => {
  function commonDirectory(stdout: string, code = 0): Exec {
    return () => Promise.resolve({ stdout, stderr: '', code });
  }

  it.each<[string, Exec, string]>([
    ['an absolute .git', commonDirectory('/x/main/.git\n'), 'main'],
    [
      'a relative .git, resolved against the repository',
      commonDirectory('.git\n'),
      'app',
    ],
    ['a bare repository', commonDirectory('/x/foo.git\n'), 'foo'],
    [
      'a submodule’s modules folder',
      commonDirectory('/x/main/.git/modules/lib\n'),
      'lib',
    ],
    [
      'a relative submodule folder',
      commonDirectory('../.git/modules/lib\n'),
      'lib',
    ],
    ['git failing', commonDirectory('fatal: not a git repository', 128), 'app'],
    ['git printing nothing', commonDirectory('\n'), 'app'],
  ])('names the project from %s', async (_label, exec, name) => {
    await expect(projectName(exec, '/work/lanes/app')).resolves.toBe(name);
  });

  it('names a linked worktree by the clone it belongs to', async () => {
    const exec = commonDirectory('/work/main/.git\n');
    await expect(
      projectName(exec, '/work/main/.claude/worktrees/lane-1'),
    ).resolves.toBe('main');
  });

  it('asks git for the common directory in the repository it names', async () => {
    const asked: string[] = [];
    const exec: Exec = (command, args, options) => {
      asked.push([command, ...args, options?.cwd].join(' '));
      return Promise.resolve({ stdout: '.git\n', stderr: '', code: 0 });
    };
    await projectName(exec, '/work/app');
    expect(asked).toEqual(['git rev-parse --git-common-dir /work/app']);
  });

  it.each(['/x/a/b/.git', '/x/a/b.git', '.git', '/x/.git/modules/a', '/'])(
    'answers a name with no path separator for %s',
    async (stdout) => {
      const name = await projectName(commonDirectory(stdout), '/work/app');
      expect(name).not.toContain(path.sep);
      expect(name).not.toBe('');
    },
  );
});
