/**
 * #202 through `runVerify`: a timed-out mutant no test is named as killing is
 * re-tested once, alone, in a second stryker run, and the gate scores what
 * that run found. The selection and merge rules are tested in
 * `timeout-retest.test.ts`; this pins the wiring — the second run's
 * arguments, the cache it reads, and the verdict that comes out.
 *
 * Stryker is faked: each call "writes" the next report in `reports` to the
 * report path and the incremental cache, the way stryker writes both.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { runCommitGate, runStopGate } from '../../src/gate.js';
import type { GateConfig } from '../../src/gate-decision.js';
import {
  computeFingerprint,
  serializeFingerprint,
} from '../../src/verify/cache-fingerprint.js';
import { parseIncrementalCache } from '../../src/verify/incremental-cache.js';
import { runVerify } from '../../src/verify/index.js';
import type { MutationRunRecord } from '../../src/verify/mutation-run.js';
import { RETESTED_REASON } from '../../src/verify/timeout-retest.js';
import {
  timeoutFixtureExec,
  writeTimeoutFixture,
} from '../timeout-retest-fixture.js';

const ROOT = '/repo';
const REPORT = path.join(ROOT, 'reports', 'mutation', 'mutation.json');
const CACHE = path.join(ROOT, 'reports', 'stryker-incremental.json');
const SIDECAR = path.join(
  ROOT,
  'reports',
  'stryker-incremental.fingerprint.json',
);
const STRYKER_CONFIG = '{"testRunner":"vitest"}';
const SUMMARY = path.join(ROOT, 'reports', 'guardrails-run.json');

function sidecar(): string {
  const fingerprint = computeFingerprint({
    strykerVersion: '10.0.0',
    config: STRYKER_CONFIG,
    dependencies: { lockfiles: [] },
  });
  return fingerprint === undefined ? '' : serializeFingerprint(fingerprint);
}

interface MutantSpec {
  status: string;
  line: number;
  killedBy?: string[];
  testsCompleted?: number;
}

function mutant(spec: MutantSpec): Record<string, unknown> {
  return {
    id: String(spec.line),
    mutatorName: 'UpdateOperator',
    replacement: 'index--',
    status: spec.status,
    coveredBy: ['0'],
    location: {
      start: { line: spec.line, column: 3 },
      end: { line: spec.line, column: 10 },
    },
    ...(spec.killedBy !== undefined && { killedBy: spec.killedBy }),
    ...(spec.testsCompleted !== undefined && {
      testsCompleted: spec.testsCompleted,
    }),
  };
}

function report(...mutants: MutantSpec[]): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: {
      'src/foo.ts': {
        language: 'typescript',
        source: '',
        mutants: mutants.map((spec) => mutant(spec)),
      },
    },
    testFiles: {
      'test/foo.test.ts': { source: '', tests: [{ id: '0', name: 'foo' }] },
    },
  });
}

const KILLED = { status: 'Killed', line: 7, killedBy: ['0'] };
const TIMED_OUT = { status: 'Timeout', line: 3 };

/**
What one stryker call does: the report it writes, or none, and its exit.
*/
interface StrykerCall {
  report?: string;
  /**
  The cache it writes, when not the report itself.
  */
  cache?: string;
  code?: number;
  /**
  The process could not be started.
  */
  spawnFailed?: true;
  /**
  The process was killed by this signal.
  */
  signal?: NodeJS.Signals;
  /**
  The progress plugin's run summary it writes, as an object.
  */
  summary?: Record<string, unknown>;
}

function gate(
  calls: StrykerCall[],
  options: {
    retestLimit?: number;
    cache?: string;
    lockPath?: string;
    /**
    The 1-based lock probe from which another gate holds the lock.
    */
    busyFromProbe?: number;
  } = {},
) {
  const files = new Map<string, string>([
    [path.join(ROOT, 'stryker.conf.json'), STRYKER_CONFIG],
  ]);
  if (options.cache !== undefined) {
    // A cache the gate keeps: its sidecar matches this checkout.
    files.set(CACHE, options.cache);
    files.set(SIDECAR, sidecar());
    files.set(
      path.join(
        ROOT,
        'node_modules',
        '@stryker-mutator',
        'core',
        'package.json',
      ),
      '{"version":"10.0.0"}',
    );
  }
  const strykerArguments: string[][] = [];
  const cacheAtCall: (string | undefined)[] = [];
  const stryker = (args: string[]): Promise<ExecResult> => {
    strykerArguments.push(args);
    cacheAtCall.push(files.get(CACHE));
    const call = calls[strykerArguments.length - 1] ?? {};
    if (call.report !== undefined) {
      files.set(REPORT, call.report);
      files.set(CACHE, call.cache ?? call.report);
    }
    if (call.summary !== undefined) {
      files.set(SUMMARY, JSON.stringify(call.summary));
    }
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: call.code ?? 0,
      ...(call.spawnFailed !== undefined && { spawnFailed: call.spawnFailed }),
      ...(call.signal !== undefined && { signal: call.signal }),
    });
  };
  let probes = 0;
  const exec: Exec = (command, args) => {
    if (command === 'stryker') {
      return stryker(args);
    }
    if (command === 'lockf' && args.at(-1) === 'true') {
      // Free for the first run, held by another gate by the re-test.
      probes += 1;
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: probes >= (options.busyFromProbe ?? 2) ? 75 : 0,
      });
    }
    if (command === 'lockf') {
      return stryker(args.slice(6));
    }
    return Promise.resolve<ExecResult>({
      stdout: args.includes('--name-only') ? 'src/foo.ts\n' : '',
      stderr: '',
      code: 0,
    });
  };
  const progress: string[] = [];
  const records: MutationRunRecord[] = [];
  const result = runVerify({
    repoRoot: ROOT,
    baseBranch: 'main',
    exec,
    ...(options.lockPath === undefined
      ? { profile: 'push' as const }
      : {
          profile: 'stop' as const,
          analyzerRungs: { stryker: 'stop' as const },
          mutationLock: {
            path: options.lockPath,
            config: {
              commitWaitSeconds: 60,
              pushWaitSeconds: 10_800,
              stopGraceSeconds: 30,
            },
          },
        }),
    resolveBin: (tool) => tool,
    analyzers: {
      eslint: 'off',
      tsc: 'off',
      knip: 'off',
      'npm-peers': 'off',
      'dependency-cruiser': 'off',
      stryker: 'required',
      dupes: 'off',
      complexity: 'off',
    },
    declaredProviders: new Set(['@stryker-mutator/core']),
    mutationScope: {
      lines: false,
      padding: 0,
      wholeFileAbove: 0,
      enclosing: false,
    },
    ...(options.retestLimit !== undefined && {
      mutationTimeoutRetestLimit: options.retestLimit,
    }),
    readFile: (filePath) => {
      const text = files.get(filePath);
      return text === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(text);
    },
    writeFile: (filePath, contents) => {
      files.set(filePath, contents);
      return Promise.resolve();
    },
    removeFile: (filePath) => {
      files.delete(filePath);
      return Promise.resolve();
    },
    // The cache is newer than every test, so the gate keeps its verdicts.
    fileModifiedTime: (filePath) => Promise.resolve(filePath === CACHE ? 2 : 1),
    progress: (line) => {
      progress.push(line);
    },
    onMutationRun: (record) => {
      records.push(record);
    },
  });
  return {
    result,
    strykerArgs: strykerArguments,
    cacheAtCall,
    progress,
    records,
    files,
  };
}

function mutantsAt(cacheText: string | undefined): unknown[] {
  return (
    parseIncrementalCache(cacheText ?? '')
      ?.files.get('src/foo.ts')
      ?.mutants.map((each) => [each.status, each.raw.id]) ?? []
  );
}

/**
A run summary whose timeouts are `costs`, the rest zero.
*/
function summaryWith(
  costs: Record<string, number>,
  mutatingMs = 0,
): Record<string, unknown> {
  return {
    startedAt: 1000,
    planReadyAt: 2000,
    reportReadyAt: 2000 + mutatingMs,
    total: 1,
    reused: 0,
    timeouts: {
      wallClock: 0,
      hitLimit: 0,
      budgetMs: 0,
      wallClockGapMs: 0,
      otherGapMs: 0,
      byFile: [],
      ...costs,
    },
  };
}

describe('a timed-out mutant is re-tested once, alone (#202)', () => {
  it('re-scores one that times out only under load as the survivor it is', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT) },
      {
        report: report(KILLED, {
          status: 'Survived',
          line: 3,
          testsCompleted: 1,
        }),
      },
    ]);
    const { violations } = await run.result;

    expect(run.strykerArgs).toHaveLength(2);
    expect(run.strykerArgs[1]).toEqual(
      expect.arrayContaining(['--incremental', '--concurrency', '1']),
    );
    const second = run.strykerArgs[1] ?? [];
    expect(second[second.indexOf('--mutate') + 1]).toBe('src/foo.ts:3-3');
    expect(mutantsAt(run.cacheAtCall[1])).toEqual([['Killed', '7']]);
    expect(violations).toEqual([
      expect.objectContaining({
        ruleId: 'stryker/survived',
        file: 'src/foo.ts',
        line: 3,
        message: expect.stringContaining(RETESTED_REASON),
      }),
    ]);
    expect(run.progress).toContain(
      'guardrails: re-testing 1 timed-out mutant alone, in one more stryker run, before counting it killed.',
    );
    expect(run.progress).toContain(
      'guardrails: re-test: 0 timed out again (killed), 1 re-scored.',
    );
    expect(run.records[0]?.stryker).toMatchObject({
      timeouts: 1,
      retested: 1,
      rescored: 1,
    });
  });

  it('keeps one that really hangs counted as killed', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT) },
      { report: report(KILLED, TIMED_OUT) },
    ]);
    const { violations } = await run.result;

    expect(run.strykerArgs).toHaveLength(2);
    expect(violations).toEqual([]);
    expect(mutantsAt(run.files.get(CACHE))).toEqual([
      ['Killed', '7'],
      ['Timeout', '3'],
    ]);
    expect(run.progress).toContain(
      'guardrails: re-test: 1 timed out again (killed), 0 re-scored.',
    );
    expect(run.records[0]?.stryker).toMatchObject({
      retested: 1,
      rescored: 0,
    });
  });

  it('records what the re-test measured, from its own summary (#236)', async () => {
    const run = gate([
      {
        report: report(KILLED, TIMED_OUT),
        summary: summaryWith({ wallClock: 1, budgetMs: 9000 }, 60_000),
      },
      {
        report: report(KILLED, TIMED_OUT),
        summary: summaryWith({ wallClock: 1, budgetMs: 4000 }, 7000),
      },
    ]);
    await run.result;
    expect(run.records[0]?.stryker).toMatchObject({
      mutatingMs: 60_000,
      timeoutCost: { wallClock: 1, budgetMs: 9000 },
      retested: 1,
      retestMutatingMs: 7000,
      retestBudgetMs: 4000,
      retestTimedOut: 1,
    });
  });

  it('records no re-test measurement from the first run’s summary', async () => {
    const run = gate([
      {
        report: report(KILLED, TIMED_OUT),
        summary: summaryWith({ wallClock: 1, budgetMs: 9000 }, 60_000),
      },
      { report: report(KILLED, TIMED_OUT) },
    ]);
    await run.result;
    const stryker = run.records[0]?.stryker;
    expect(stryker).toMatchObject({ retested: 1, mutatingMs: 60_000 });
    expect(stryker).not.toHaveProperty('retestMutatingMs');
    expect(stryker).not.toHaveProperty('retestBudgetMs');
    expect(stryker).not.toHaveProperty('retestTimedOut');
  });

  it('records no re-test measurement from a re-test stopped before its report', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT) },
      {
        report: report(KILLED, TIMED_OUT),
        summary: { startedAt: 1000, planReadyAt: 2000, total: 1, reused: 0 },
      },
    ]);
    await run.result;
    const stryker = run.records[0]?.stryker;
    expect(stryker).toMatchObject({ retested: 1 });
    expect(stryker).not.toHaveProperty('retestMutatingMs');
    expect(stryker).not.toHaveProperty('retestBudgetMs');
    expect(stryker).not.toHaveProperty('retestTimedOut');
  });

  it('runs stryker once when no timeout qualifies', async () => {
    const run = gate([
      { report: report(KILLED, { ...TIMED_OUT, killedBy: ['0'] }) },
    ]);
    const { violations } = await run.result;
    expect(run.strykerArgs).toHaveLength(1);
    expect(violations).toEqual([]);
    expect(run.records[0]?.stryker).not.toHaveProperty('retested');
  });

  it('runs stryker once for a Timeout the cache held before the run', async () => {
    const run = gate([{ report: report(KILLED, TIMED_OUT) }], {
      cache: report(TIMED_OUT),
    });
    await run.result;
    expect(mutantsAt(run.cacheAtCall[0])).toEqual([['Timeout', '3']]);
    expect(run.strykerArgs).toHaveLength(1);
  });

  it('runs stryker once when mutationTimeouts.retestLimit is 0', async () => {
    const run = gate([{ report: report(KILLED, TIMED_OUT) }], {
      retestLimit: 0,
    });
    await run.result;
    expect(run.strykerArgs).toHaveLength(1);
  });

  it('says how many it left counted as killed when the cap bites', async () => {
    const run = gate(
      [
        { report: report({ status: 'Timeout', line: 2 }, TIMED_OUT) },
        { report: report({ status: 'Timeout', line: 2 }, TIMED_OUT) },
      ],
      { retestLimit: 1 },
    );
    await run.result;
    expect(run.progress).toContain(
      'guardrails: re-testing 1 of 2 timed-out mutants alone, in one more ' +
        'stryker run (at most 1: mutationTimeouts.retestLimit); 1 stays ' +
        'counted as killed.',
    );
    const second = run.strykerArgs[1] ?? [];
    expect(second[second.indexOf('--mutate') + 1]).toBe('src/foo.ts:2-2');
  });

  it('re-tests without the cache when the run left one it cannot read', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT), cache: '{"files":' },
      { report: report(KILLED, TIMED_OUT) },
    ]);
    const { violations } = await run.result;
    expect(run.strykerArgs).toHaveLength(2);
    expect(run.cacheAtCall[1]).toBeUndefined();
    expect(violations).toEqual([]);
  });

  it('keeps a timeout the re-test’s report does not hold, and says so', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT) },
      { report: report(KILLED) },
    ]);
    const { violations } = await run.result;
    expect(violations).toEqual([]);
    expect(run.progress).toContain(
      'guardrails: re-test: 0 timed out again (killed), 0 re-scored. 1 ' +
        'missing from its report stays counted as killed.',
    );
  });

  it('keeps the timeouts as kills, and says so, when the re-test writes no report', async () => {
    const run = gate([{ report: report(KILLED, TIMED_OUT) }, { code: 1 }]);
    const { violations } = await run.result;
    expect(violations).toEqual([]);
    expect(run.progress).toContain(
      'guardrails: the re-test of 1 timed-out mutant did not finish ' +
        '(stryker exited 1 with no report), so it stays counted as killed.',
    );
    expect(run.files.get(REPORT)).toBe(report(KILLED, TIMED_OUT));
  });

  it('keeps the timeouts as kills, and says so, when another gate holds the lock by the re-test', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-retest-'));
    try {
      const run = gate([{ report: report(KILLED, TIMED_OUT) }], {
        lockPath: path.join(directory, 'gate.lock'),
      });
      const { violations } = await run.result;
      expect(run.strykerArgs).toHaveLength(1);
      expect(violations).toEqual([]);
      expect(run.progress).toContainEqual(
        expect.stringMatching(
          /^guardrails: the re-test of 1 timed-out mutant did not finish \(the mutation lock was busy: .+\), so it stays counted as killed\.$/,
        ),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const TWO_TIMED_OUT = [{ status: 'Timeout', line: 2 }, TIMED_OUT] as const;

  it('says "them" when it re-tests two and none are left out', async () => {
    const run = gate([
      { report: report(KILLED, ...TWO_TIMED_OUT) },
      { report: report(KILLED, ...TWO_TIMED_OUT) },
    ]);
    await run.result;
    expect(run.progress).toContain(
      'guardrails: re-testing 2 timed-out mutants alone, in one more ' +
        'stryker run, before counting them killed.',
    );
  });

  it('says "stay" when the cap leaves two out', async () => {
    const run = gate(
      [
        {
          report: report({ status: 'Timeout', line: 2 }, TIMED_OUT, {
            status: 'Timeout',
            line: 4,
          }),
        },
        { report: report({ status: 'Timeout', line: 2 }) },
      ],
      { retestLimit: 1 },
    );
    await run.result;
    expect(run.progress).toContain(
      'guardrails: re-testing 1 of 3 timed-out mutants alone, in one more ' +
        'stryker run (at most 1: mutationTimeouts.retestLimit); 2 stay ' +
        'counted as killed.',
    );
  });

  it('says "stay" when two are missing from the re-test’s report', async () => {
    const run = gate([
      { report: report(KILLED, ...TWO_TIMED_OUT) },
      { report: report(KILLED) },
    ]);
    await run.result;
    expect(run.progress).toContain(
      'guardrails: re-test: 0 timed out again (killed), 0 re-scored. 2 ' +
        'missing from its report stay counted as killed.',
    );
  });

  it('says "they stay" when a re-test of two leaves no report', async () => {
    const run = gate([
      { report: report(KILLED, ...TWO_TIMED_OUT) },
      { code: 1 },
    ]);
    await run.result;
    expect(run.progress).toContain(
      'guardrails: the re-test of 2 timed-out mutants did not finish ' +
        '(stryker exited 1 with no report), so they stay counted as killed.',
    );
    expect(run.records[0]?.stryker).toMatchObject({
      retested: 2,
      rescored: 0,
    });
  });

  it('says stryker could not be started when the re-test cannot spawn it', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT) },
      { spawnFailed: true, code: 1 },
    ]);
    await run.result;
    expect(run.progress).toContain(
      'guardrails: the re-test of 1 timed-out mutant did not finish ' +
        '(stryker could not be started), so it stays counted as killed.',
    );
  });

  it('names the signal that stopped the re-test', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT) },
      { signal: 'SIGTERM', code: 0 },
    ]);
    await run.result;
    expect(run.progress).toContain(
      'guardrails: the re-test of 1 timed-out mutant did not finish ' +
        '(stryker was stopped by SIGTERM), so it stays counted as killed.',
    );
  });

  it('does not re-test when the first run could not start stryker', async () => {
    const run = gate([
      { report: report(KILLED, TIMED_OUT), spawnFailed: true, code: 1 },
      { report: report(KILLED, TIMED_OUT) },
    ]);
    await run.result;
    expect(run.strykerArgs).toHaveLength(1);
    expect(run.progress).not.toContainEqual(
      expect.stringContaining('re-testing'),
    );
  });

  it('does not re-test when another gate holds the lock for the first run', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-retest-'));
    try {
      const run = gate([{ report: report(KILLED, TIMED_OUT) }], {
        lockPath: path.join(directory, 'gate.lock'),
        busyFromProbe: 1,
      });
      await run.result;
      expect(run.strykerArgs).toHaveLength(0);
      expect(run.progress).not.toContainEqual(
        expect.stringContaining('re-test'),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const GATE_CONFIG: GateConfig = {
  maxAttempts: 3,
  recurThreshold: 3,
  graduationThreshold: 3,
  fastFixer: 'guardrail-fixer',
  thoroughFixer: 'guardrail-fixer-thorough',
};

/**
 * `mutationTimeoutRetestLimit` reaches the re-test through both gates: a
 * limit of 0 leaves the fixture's timeout un-re-tested, one stryker run; the
 * default re-tests it, two. The CLI's half is in `cli-core.test.ts`.
 */
describe.each<[string, number | undefined, number]>([
  ['re-tested by default', undefined, 2],
  ['not re-tested at a limit of 0', 0, 1],
])('a gate’s timed-out mutant: %s', (_label, limit, runs) => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'guardrails-retest-gate-'));
    writeTimeoutFixture(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const policy = { mutationTimeoutRetestLimit: limit };

  it('in the stop gate', async () => {
    const { exec, strykerRuns } = timeoutFixtureExec(root);
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec,
      config: GATE_CONFIG,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      ...policy,
    });
    expect(strykerRuns()).toBe(runs);
  });

  it('in the commit gate', async () => {
    const { exec, strykerRuns } = timeoutFixtureExec(root);
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec,
      config: GATE_CONFIG,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      ...policy,
    });
    expect(strykerRuns()).toBe(runs);
  });
});
