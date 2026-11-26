import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseJsonText } from '../src/json-file.js';
import { type Holder, readHolder } from '../src/lock-holder.js';
import {
  absorbRepeatStopSignals,
  defaultIo,
  GuardrailsProgressReporter,
  ProgressReporter,
  type ProgressIo,
  type SignalTarget,
  strykerPlugins,
  writeAtomically,
} from '../src/stryker-progress-plugin.js';

/**
 * A `process` stand-in for signal listeners. `emit` calls a COPY of the
 * listener list, as Node does -- which is what lets the first stop signal
 * still reach stryker while the absorber swaps the listeners out.
 */
class FakeSignals implements SignalTarget {
  readonly #listeners = new Map<string, (() => void)[]>();

  #of(event: string): (() => void)[] {
    return this.#listeners.get(event) ?? [];
  }

  on(event: string, listener: () => void): this {
    this.#listeners.set(event, [...this.#of(event), listener]);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.#listeners.set(
      event,
      this.#of(event).filter((other) => other !== listener),
    );
    return this;
  }

  removeAllListeners(event: string): this {
    this.#listeners.delete(event);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.#of(event)) {
      listener();
    }
  }

  listenerCount(event: string): number {
    return this.#of(event).length;
  }
}

const HOLDER_FILE = '/locks/gate.lock.holder.json';

const LOCK_ENV = {
  GUARDRAILS_LOCK_HOLDER_FILE: HOLDER_FILE,
  GUARDRAILS_LOCK_RUNG: 'push',
  GUARDRAILS_LOCK_REPO: '/dev/dialed-163',
};

interface Fake {
  io: ProgressIo;
  writes: Holder[];
  removed: string[];
  advance: (ms: number) => void;
  runExit: () => void;
  pendingTimers: () => number;
  exitListeners: () => number;
  signals: FakeSignals;
}

/**
Read back through the waiters' own parser, so what the plugin writes is proved
to be what `readHolder` accepts.
*/
function parseHolder(content: string): Holder {
  const holder = readHolder(HOLDER_FILE, () => parseJsonText(content), isAlive);
  expect(holder).toBeDefined();
  // The plugin writes a stryker holder, which has no `kind`.
  expect(holder).not.toHaveProperty('kind');
  return holder === undefined || 'kind' in holder
    ? expect.unreachable()
    : holder;
}

function isAlive(): boolean {
  return true;
}

function fake(
  environment: Record<string, string | undefined> = LOCK_ENV,
  overrides: Partial<ProgressIo> = {},
): Fake {
  let now = 1_000_000;
  const writes: Holder[] = [];
  const removed: string[] = [];
  let timers: { at: number; callback: () => void }[] = [];
  let listeners: (() => void)[] = [];
  const signals = new FakeSignals();
  const io: ProgressIo = {
    signals,
    environment,
    now: () => now,
    pid: 4242,
    write: (filePath, content) => {
      expect(filePath).toBe(HOLDER_FILE);
      writes.push(parseHolder(content));
    },
    remove: (filePath) => {
      removed.push(filePath);
    },
    schedule: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
    onExit: (listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((other) => other !== listener);
      };
    },
    ...overrides,
  };
  return {
    io,
    writes,
    removed,
    advance: (ms) => {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) {
        timer.callback();
      }
    },
    runExit: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    pendingTimers: () => timers.length,
    exitListeners: () => listeners.length,
    signals,
  };
}

function plans(
  run: number,
  reused: number,
): { mutantPlans: { plan: string }[] } {
  return {
    mutantPlans: [
      ...Array.from({ length: run }, () => ({ plan: 'Run' })),
      ...Array.from({ length: reused }, () => ({ plan: 'EarlyResult' })),
    ],
  };
}

const report = [{}, {}] as const;

function failing(): never {
  throw new Error('EACCES');
}

describe('ProgressReporter', () => {
  it('writes the holder on construction', () => {
    const f = fake();
    expect(new ProgressReporter(f.io)).toBeInstanceOf(ProgressReporter);
    expect(f.writes).toEqual([
      {
        repo: '/dev/dialed-163',
        rung: 'push',
        pid: 4242,
        startedAt: 1_000_000,
        phase: 'dry-run',
        tested: 0,
        total: 0,
        reused: 0,
        survived: 0,
      },
    ]);
  });

  it.each([
    [
      'the holder file',
      { ...LOCK_ENV, GUARDRAILS_LOCK_HOLDER_FILE: undefined },
    ],
    ['an empty holder file', { ...LOCK_ENV, GUARDRAILS_LOCK_HOLDER_FILE: '' }],
    ['the rung', { ...LOCK_ENV, GUARDRAILS_LOCK_RUNG: undefined }],
    ['a known rung', { ...LOCK_ENV, GUARDRAILS_LOCK_RUNG: 'deploy' }],
    ['the repo', { ...LOCK_ENV, GUARDRAILS_LOCK_REPO: undefined }],
    ['a non-empty repo', { ...LOCK_ENV, GUARDRAILS_LOCK_REPO: '' }],
  ])('does nothing without %s', (_missing, environment) => {
    const f = fake(environment);
    const reporter = new ProgressReporter(f.io);
    expect(f.exitListeners()).toBe(0);
    reporter.onMutationTestingPlanReady(plans(2, 0));
    reporter.onMutantTested({ status: 'Survived' });
    f.advance(10_000);
    expect(f.exitListeners()).toBe(0);
    reporter.onMutationTestReportReady(...report);
    f.runExit();
    expect(f.writes).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.exitListeners()).toBe(0);
  });

  it('records the plan: total, reused, and when mutating began', () => {
    const f = fake();
    const reporter = new ProgressReporter(f.io);
    f.advance(30_000);
    reporter.onMutationTestingPlanReady(plans(3, 2));
    expect(f.writes.at(-1)).toMatchObject({
      phase: 'mutating',
      total: 5,
      reused: 2,
      tested: 0,
      mutatingSince: 1_030_000,
      startedAt: 1_000_000,
    });
  });

  it('counts tested mutants and survivors', () => {
    const f = fake();
    const reporter = new ProgressReporter(f.io);
    f.advance(10_000);
    reporter.onMutationTestingPlanReady(plans(3, 0));
    reporter.onMutantTested({ status: 'Killed' });
    reporter.onMutantTested({ status: 'Survived' });
    reporter.onMutantTested({ status: 'NoCoverage' });
    f.advance(5000);
    expect(f.writes.at(-1)).toMatchObject({ tested: 3, survived: 1 });
  });

  it('writes at most once per 5s', () => {
    const f = fake();
    const reporter = new ProgressReporter(f.io);
    f.advance(10_000);
    reporter.onMutationTestingPlanReady(plans(10, 0));
    expect(f.writes).toHaveLength(2);
    f.advance(1000);
    reporter.onMutantTested({ status: 'Killed' });
    f.advance(1000);
    reporter.onMutantTested({ status: 'Killed' });
    expect(f.writes).toHaveLength(2);
    expect(f.pendingTimers()).toBe(1);
  });

  it('flushes the latest state when the throttle window ends', () => {
    const f = fake();
    const reporter = new ProgressReporter(f.io);
    f.advance(10_000);
    reporter.onMutationTestingPlanReady(plans(10, 0));
    f.advance(1000);
    reporter.onMutantTested({ status: 'Killed' });
    f.advance(1000);
    reporter.onMutantTested({ status: 'Survived' });
    f.advance(2999);
    expect(f.writes).toHaveLength(2);
    f.advance(1);
    expect(f.writes).toHaveLength(3);
    expect(f.writes.at(-1)).toMatchObject({ tested: 2, survived: 1 });
    expect(f.pendingTimers()).toBe(0);
  });

  it('writes straight away once the window has passed', () => {
    const f = fake();
    const reporter = new ProgressReporter(f.io);
    f.advance(5000);
    reporter.onMutationTestingPlanReady(plans(1, 0));
    expect(f.writes).toHaveLength(2);
    expect(f.pendingTimers()).toBe(0);
  });

  it('removes the file and stops when the report is ready', () => {
    const f = fake();
    const reporter = new ProgressReporter(f.io);
    f.advance(10_000);
    reporter.onMutationTestingPlanReady(plans(2, 0));
    f.advance(1000);
    reporter.onMutantTested({ status: 'Killed' });
    reporter.onMutationTestReportReady(...report);
    expect(f.removed).toEqual([HOLDER_FILE]);
    expect(f.pendingTimers()).toBe(0);
    expect(f.exitListeners()).toBe(0);
    const written = f.writes.length;
    reporter.onMutantTested({ status: 'Killed' });
    f.advance(10_000);
    expect(f.writes).toHaveLength(written);
  });

  it('removes the file on process exit', () => {
    const f = fake();
    expect(new ProgressReporter(f.io)).toBeInstanceOf(ProgressReporter);
    expect(f.exitListeners()).toBe(1);
    f.runExit();
    expect(f.removed).toEqual([HOLDER_FILE]);
  });

  it('swallows every fs error', () => {
    const f = fake(LOCK_ENV, { write: failing, remove: failing });
    const reporter = new ProgressReporter(f.io);
    f.advance(10_000);
    expect(() => {
      reporter.onMutationTestingPlanReady(plans(2, 0));
      reporter.onMutantTested({ status: 'Killed' });
      f.advance(10_000);
      reporter.onMutationTestReportReady(...report);
      f.runExit();
    }).not.toThrow();
  });
});

/**
Stryker's own handler, as `UnexpectedExitHandler` installs it: one listener on
each of the four signals it treats as a stop.
*/
const STOP_SIGNALS = ['SIGABRT', 'SIGHUP', 'SIGINT', 'SIGTERM'] as const;

function withStrykerHandler(signals: FakeSignals): string[] {
  const heard: string[] = [];
  for (const signal of STOP_SIGNALS) {
    signals.on(signal, () => {
      heard.push(signal);
    });
  }
  return heard;
}

describe('ProgressReporter: the run summary (#176)', () => {
  const SUMMARY_FILE = '/repo/reports/guardrails-run.json';

  /**
  The summaries written, and the path of every write to neither file.
  */
  function summaryFake(environment: Record<string, string | undefined>): {
    f: Fake;
    summaries: unknown[];
    elsewhere: string[];
  } {
    const summaries: unknown[] = [];
    const elsewhere: string[] = [];
    const f = fake(environment, {
      write: (filePath, content) => {
        if (filePath === SUMMARY_FILE) {
          summaries.push(JSON.parse(content));
        } else if (filePath !== HOLDER_FILE) {
          elsewhere.push(filePath);
        }
      },
    });
    return { f, summaries, elsewhere };
  }

  it('writes when the plan is ready and when the report is, with the start', () => {
    const { f, summaries } = summaryFake({
      ...LOCK_ENV,
      GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE,
    });
    const reporter = new ProgressReporter(f.io);
    expect(summaries).toEqual([]);
    f.advance(30_000);
    reporter.onMutationTestingPlanReady(plans(3, 2));
    f.advance(60_000);
    reporter.onMutationTestReportReady(...report);
    expect(summaries).toEqual([
      { startedAt: 1_000_000, planReadyAt: 1_030_000, total: 5, reused: 2 },
      {
        startedAt: 1_000_000,
        planReadyAt: 1_030_000,
        reportReadyAt: 1_090_000,
        total: 5,
        reused: 2,
        timeouts: {
          wallClock: 0,
          hitLimit: 0,
          budgetMs: 0,
          wallClockGapMs: 0,
          otherGapMs: 0,
          byFile: [],
        },
      },
    ]);
  });

  it.each([
    ['without its file', { ...LOCK_ENV }],
    ['with an empty file', { ...LOCK_ENV, GUARDRAILS_RUN_SUMMARY_FILE: '' }],
    [
      'when the run holds no lock',
      { GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE },
    ],
  ])('writes no summary %s', (_label, environment) => {
    const { f, summaries, elsewhere } = summaryFake(environment);
    const reporter = new ProgressReporter(f.io);
    reporter.onMutationTestingPlanReady(plans(1, 0));
    reporter.onMutationTestReportReady(...report);
    expect(summaries).toEqual([]);
    expect(elsewhere).toEqual([]);
  });

  it('writes the report’s summary once, however often the report is ready', () => {
    const { f, summaries } = summaryFake({
      ...LOCK_ENV,
      GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE,
    });
    const reporter = new ProgressReporter(f.io);
    reporter.onMutationTestReportReady(...report);
    f.advance(1000);
    reporter.onMutationTestReportReady(...report);
    expect(summaries).toEqual([
      { startedAt: 1_000_000, reportReadyAt: 1_000_000, total: 0, reused: 0 },
    ]);
  });

  it('never fails the run over a summary it cannot write', () => {
    const f = fake(
      { ...LOCK_ENV, GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE },
      {
        write: (filePath) => {
          if (filePath === SUMMARY_FILE) {
            failing();
          }
        },
      },
    );
    const reporter = new ProgressReporter(f.io);
    expect(() => {
      reporter.onMutationTestingPlanReady(plans(1, 0));
      reporter.onMutationTestReportReady(...report);
    }).not.toThrow();
  });
});

describe('ProgressReporter: what timeouts cost (#236)', () => {
  const SUMMARY_FILE = '/repo/reports/guardrails-run.json';
  const SUMMARY_ENV = {
    ...LOCK_ENV,
    GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE,
  };

  /**
  A reporter over a fake whose summaries are collected, with `options`.
  */
  function metered(options?: unknown): {
    f: Fake;
    reporter: ProgressReporter;
    summaries: Record<string, unknown>[];
  } {
    const summaries: Record<string, unknown>[] = [];
    const f = fake(SUMMARY_ENV, {
      write: (filePath, content) => {
        if (filePath === SUMMARY_FILE) {
          summaries.push(JSON.parse(content) as Record<string, unknown>);
        }
      },
    });
    return { f, reporter: new ProgressReporter(f.io, options), summaries };
  }

  /**
  A plan entry: the slice the reporter types, and what the meter reads.
  */
  type Plan = { plan: string } & Record<string, unknown>;

  function runPlan(id: string, timeout: number): Plan {
    return { plan: 'Run', mutant: { id }, runOptions: { timeout }, netTime: 1 };
  }

  function result(
    id: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): { status: string } & Record<string, unknown> {
    return {
      id,
      status,
      fileName: '/dev/dialed-163/src/table.ts',
      location: {
        start: { line: 10, column: 0 },
        end: { line: 10, column: 5 },
      },
      ...extra,
    };
  }

  function at(line: number): Record<string, unknown> {
    return { start: { line, column: 0 }, end: { line, column: 1 } };
  }

  it('records the dry run’s net time and overhead, from the plan on', () => {
    const { reporter, summaries } = metered();
    reporter.onDryRunCompleted({ timing: { net: 1200, overhead: 90_000 } });
    reporter.onMutationTestingPlanReady(plans(1, 0));
    reporter.onMutationTestReportReady(...report);
    for (const summary of summaries) {
      expect(summary.settings).toEqual({
        dryRunNetMs: 1200,
        dryRunOverheadMs: 90_000,
      });
    }
    expect(summaries).toHaveLength(2);
  });

  it('records the timeout settings stryker resolved', () => {
    const { reporter, summaries } = metered({
      timeoutMS: 5000,
      timeoutFactor: 1.5,
      concurrency: 4,
      mutate: ['src/a.ts'],
    });
    reporter.onMutationTestingPlanReady(plans(1, 0));
    expect(summaries.at(-1)?.settings).toEqual({
      timeoutMS: 5000,
      timeoutFactor: 1.5,
      concurrency: 4,
    });
  });

  it.each([
    ['no options', undefined],
    ['options that are not an object', 'options'],
    ['settings of the wrong kind', { timeoutMS: '5000', concurrency: '50%' }],
    ['settings that are not finite', { timeoutMS: NaN }],
  ])('records no settings from %s', (_label, options) => {
    const { reporter, summaries } = metered(options);
    reporter.onDryRunCompleted('not an event');
    reporter.onDryRunCompleted({ timing: { net: 'x' } });
    reporter.onMutationTestingPlanReady(plans(1, 0));
    reporter.onMutationTestReportReady(...report);
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('settings');
    }
  });

  it('adds up each kind of result: its budget and the time since the last', () => {
    const { f, reporter, summaries } = metered();
    reporter.onMutationTestingPlanReady({
      mutantPlans: [
        runPlan('1', 5000),
        runPlan('2', 6000),
        runPlan('3', 7000),
        runPlan('4', 8000),
        { plan: 'EarlyResult', mutant: { id: '5' } },
      ],
    });
    reporter.onMutantTested(result('5', 'Timeout'));
    f.advance(10_000);
    reporter.onMutantTested(result('1', 'Timeout'));
    f.advance(2000);
    reporter.onMutantTested(
      result('2', 'Timeout', { statusReason: 'Hit limit reached (9/8)' }),
    );
    f.advance(1000);
    reporter.onMutantTested(result('3', 'Killed'));
    f.advance(12_000);
    reporter.onMutantTested(
      result('4', 'Timeout', {
        fileName: '/dev/dialed-163/src/other.ts',
        location: at(3),
      }),
    );
    reporter.onMutationTestReportReady(...report);
    expect(summaries.at(-1)?.timeouts).toEqual({
      wallClock: 2,
      hitLimit: 1,
      budgetMs: 13_000,
      wallClockGapMs: 22_000,
      otherGapMs: 3000,
      byFile: [
        { file: 'src/other.ts', count: 1, firstLine: 3, lastLine: 3 },
        { file: 'src/table.ts', count: 1, firstLine: 10, lastLine: 10 },
      ],
    });
  });

  it('writes the timeouts at the report only', () => {
    const { reporter, summaries } = metered();
    reporter.onMutationTestingPlanReady(plans(1, 0));
    expect(summaries.at(-1)).not.toHaveProperty('timeouts');
  });

  it('counts wall-clock timeouts by file, most first, with the lines they span', () => {
    const { reporter, summaries } = metered();
    const files = ['a', 'b', 'c', 'd', 'e', 'f'];
    const ids = files.flatMap((file, index) =>
      Array.from({ length: index + 1 }, (_, each) => `${file}${String(each)}`),
    );
    reporter.onMutationTestingPlanReady({
      mutantPlans: ids.map((id) => runPlan(id, 1)),
    });
    for (const id of ids) {
      const line = 52 - Number(id.slice(1));
      reporter.onMutantTested(
        result(id, 'Timeout', {
          fileName: `/dev/dialed-163/src/${id.slice(0, 1)}.ts`,
          location: at(line),
        }),
      );
    }
    reporter.onMutationTestReportReady(...report);
    expect(summaries.at(-1)?.timeouts).toMatchObject({
      wallClock: ids.length,
      byFile: [
        { file: 'src/f.ts', count: 6, firstLine: 47, lastLine: 52 },
        { file: 'src/e.ts', count: 5, firstLine: 48, lastLine: 52 },
        { file: 'src/d.ts', count: 4, firstLine: 49, lastLine: 52 },
        { file: 'src/c.ts', count: 3, firstLine: 50, lastLine: 52 },
        { file: 'src/b.ts', count: 2, firstLine: 51, lastLine: 52 },
      ],
    });
  });

  it('breaks a tie between files by name', () => {
    const { reporter, summaries } = metered();
    reporter.onMutationTestingPlanReady({
      mutantPlans: [runPlan('1', 1), runPlan('2', 1)],
    });
    reporter.onMutantTested(
      result('1', 'Timeout', { fileName: '/dev/dialed-163/src/z.ts' }),
    );
    reporter.onMutantTested(
      result('2', 'Timeout', { fileName: '/dev/dialed-163/src/y.ts' }),
    );
    reporter.onMutationTestReportReady(...report);
    expect(summaries.at(-1)?.timeouts).toMatchObject({
      byFile: [{ file: 'src/y.ts' }, { file: 'src/z.ts' }],
    });
  });

  it('keeps a file stryker names relative to the repo as it is', () => {
    const { reporter, summaries } = metered();
    reporter.onMutationTestingPlanReady({ mutantPlans: [runPlan('1', 1)] });
    reporter.onMutantTested(
      result('1', 'Timeout', { fileName: 'src/x.ts', location: undefined }),
    );
    reporter.onMutationTestReportReady(...report);
    expect(summaries.at(-1)?.timeouts).toMatchObject({
      wallClock: 1,
      byFile: [{ file: 'src/x.ts', count: 1 }],
    });
  });

  it('ignores a result before the plan, one it did not plan, and garbage', () => {
    const { f, reporter, summaries } = metered();
    reporter.onMutantTested(result('1', 'Timeout'));
    f.advance(4000);
    reporter.onMutationTestingPlanReady({
      mutantPlans: [
        runPlan('1', 5000),
        { plan: 'Run', mutant: { id: '2' }, runOptions: { timeout: 'x' } },
        { plan: 'Run' },
      ],
    });
    f.advance(1000);
    reporter.onMutantTested(result('9', 'Timeout'));
    reporter.onMutantTested({ status: 'Timeout' });
    f.advance(1000);
    reporter.onMutantTested(result('2', 'Timeout', { fileName: 7 }));
    reporter.onMutationTestReportReady(...report);
    expect(summaries.at(-1)?.timeouts).toEqual({
      wallClock: 1,
      hitLimit: 0,
      budgetMs: 0,
      wallClockGapMs: 2000,
      otherGapMs: 0,
      byFile: [],
    });
  });

  it('counts a mutant once, however often it is reported', () => {
    const { f, reporter, summaries } = metered();
    reporter.onMutationTestingPlanReady({ mutantPlans: [runPlan('1', 5000)] });
    f.advance(1000);
    reporter.onMutantTested(result('1', 'Timeout'));
    f.advance(1000);
    reporter.onMutantTested(result('1', 'Timeout'));
    reporter.onMutationTestReportReady(...report);
    expect(summaries.at(-1)?.timeouts).toMatchObject({
      wallClock: 1,
      budgetMs: 5000,
      wallClockGapMs: 1000,
    });
  });

  it('measures nothing when the run holds no lock', () => {
    const summaries: unknown[] = [];
    const f = fake(
      { GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE },
      {
        write: (_filePath, content) => {
          summaries.push(content);
        },
      },
    );
    const reporter = new ProgressReporter(f.io, { timeoutMS: 1 });
    reporter.onDryRunCompleted({ timing: { net: 1, overhead: 1 } });
    reporter.onMutationTestingPlanReady({ mutantPlans: [runPlan('1', 1)] });
    reporter.onMutantTested(result('1', 'Timeout'));
    reporter.onMutationTestReportReady(...report);
    expect(summaries).toEqual([]);
  });
});

describe('ProgressReporter: what the dry run and each mutant run did (#200)', () => {
  const SUMMARY_FILE = '/repo/reports/guardrails-run.json';

  function metered(): {
    reporter: ProgressReporter;
    summaries: Record<string, unknown>[];
  } {
    const summaries: Record<string, unknown>[] = [];
    const f = fake(
      { ...LOCK_ENV, GUARDRAILS_RUN_SUMMARY_FILE: SUMMARY_FILE },
      {
        write: (filePath, content) => {
          if (filePath === SUMMARY_FILE) {
            summaries.push(JSON.parse(content) as Record<string, unknown>);
          }
        },
      },
    );
    return { reporter: new ProgressReporter(f.io), summaries };
  }

  it('records how many tests the dry run ran, and in how many files', () => {
    const { reporter, summaries } = metered();
    reporter.onDryRunCompleted({
      result: {
        tests: [
          { id: '1', name: 'one', timeSpentMs: 1, fileName: '/r/a.test.ts' },
          { id: '2', name: 'two', timeSpentMs: 1, fileName: '/r/a.test.ts' },
          { id: '3', name: 'three', timeSpentMs: 1, fileName: '/r/b.test.ts' },
        ],
      },
      timing: { net: 3, overhead: 10 },
    });
    reporter.onMutationTestingPlanReady(plans(1, 0));
    reporter.onMutationTestReportReady(...report);
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.dryRunCounts).toEqual({ tests: 3, testFiles: 2 });
    }
  });

  it('records no dry-run counts when the dry run said nothing', () => {
    const { reporter, summaries } = metered();
    reporter.onMutationTestingPlanReady(plans(1, 0));
    expect(summaries.at(-1)).not.toHaveProperty('dryRunCounts');
  });
});

describe('absorbRepeatStopSignals', () => {
  // Measured (plan.md, 2026-11-07): a tree-kill gives stryker two SIGTERMs
  // 7ms apart -- its own and the gate's forward -- and stryker's second-signal
  // branch exits before the partial incremental report is written
  // (stryker-js#6257). Only stryker's own process can tell a repeat apart.
  it('lets the first stop signal through to stryker', () => {
    const signals = new FakeSignals();
    const heard = withStrykerHandler(signals);
    absorbRepeatStopSignals(signals);
    signals.emit('SIGTERM');
    expect(heard).toEqual(['SIGTERM']);
  });

  it.each(STOP_SIGNALS)(
    'keeps every later stop signal from stryker once %s has arrived',
    (first) => {
      const signals = new FakeSignals();
      const heard = withStrykerHandler(signals);
      absorbRepeatStopSignals(signals);
      signals.emit(first);
      for (const signal of STOP_SIGNALS) {
        signals.emit(signal);
      }
      expect(heard).toEqual([first]);
    },
  );

  it('still listens for each repeat, so none falls to the default kill', () => {
    const signals = new FakeSignals();
    withStrykerHandler(signals);
    absorbRepeatStopSignals(signals);
    signals.emit('SIGINT');
    expect(STOP_SIGNALS.map((signal) => signals.listenerCount(signal))).toEqual(
      [1, 1, 1, 1],
    );
  });

  it('leaves stryker alone until a signal arrives', () => {
    const signals = new FakeSignals();
    withStrykerHandler(signals);
    absorbRepeatStopSignals(signals);
    expect(STOP_SIGNALS.map((signal) => signals.listenerCount(signal))).toEqual(
      [2, 2, 2, 2],
    );
  });

  it('can be undone after a stop signal, removing the listeners it swapped in', () => {
    const signals = new FakeSignals();
    withStrykerHandler(signals);
    const undo = absorbRepeatStopSignals(signals);
    signals.emit('SIGINT');
    undo();
    expect(STOP_SIGNALS.map((signal) => signals.listenerCount(signal))).toEqual(
      [0, 0, 0, 0],
    );
  });

  it('can be undone, leaving only what was there before', () => {
    const signals = new FakeSignals();
    const heard = withStrykerHandler(signals);
    const undo = absorbRepeatStopSignals(signals);
    undo();
    expect(STOP_SIGNALS.map((signal) => signals.listenerCount(signal))).toEqual(
      [1, 1, 1, 1],
    );
    signals.emit('SIGTERM');
    signals.emit('SIGTERM');
    expect(heard).toEqual(['SIGTERM', 'SIGTERM']);
  });
});

describe('ProgressReporter absorbs repeat stop signals for the run', () => {
  it('installs the absorber on a holder run, and removes it with the report', () => {
    const f = fake();
    withStrykerHandler(f.signals);
    const reporter = new ProgressReporter(f.io);
    expect(f.signals.listenerCount('SIGTERM')).toBe(2);
    reporter.onMutationTestReportReady(...report);
    expect(f.signals.listenerCount('SIGTERM')).toBe(1);
  });

  it('installs nothing when the env asks for no holder', () => {
    const f = fake({});
    new ProgressReporter(f.io).onMutantTested({ status: 'Killed' });
    expect(f.signals.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('writeAtomically', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'guardrails-progress-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates the directory it writes into', () => {
    const file = path.join(directory, 'reports', 'guardrails-run.json');
    writeAtomically(file, '{}');
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });

  it('writes the content and leaves no temp file behind', () => {
    const target = path.join(directory, 'gate.lock.holder.json');
    writeAtomically(target, '{"a":1}');
    writeAtomically(target, '{"a":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(directory)).toEqual(['gate.lock.holder.json']);
  });
});

describe('defaultIo', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'guardrails-progress-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('removes a file, and a missing one without throwing', () => {
    const target = path.join(directory, 'holder.json');
    writeAtomically(target, '{}');
    const { remove } = defaultIo();
    remove(target);
    expect(existsSync(target)).toBe(false);
    expect(() => {
      remove(target);
    }).not.toThrow();
  });

  it('runs a scheduled callback once, after the delay', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    defaultIo().schedule(callback, 100);
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled callback', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const cancel = defaultIo().schedule(callback, 100);
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not let a pending flush keep the process alive', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    defaultIo().schedule(vi.fn(), 100);
    expect(spy.mock.results[0]?.value.hasRef()).toBe(false);
  });

  it('listens for signals on the process itself', () => {
    expect(defaultIo().signals).toBe(process);
  });

  it('registers an exit listener and removes it again', () => {
    const before = process.listenerCount('exit');
    const stop = defaultIo().onExit(vi.fn());
    expect(process.listenerCount('exit')).toBe(before + 1);
    stop();
    expect(process.listenerCount('exit')).toBe(before);
  });
});

describe('GuardrailsProgressReporter', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'guardrails-progress-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is the plugin stryker loads, injecting the resolved options', () => {
    expect(strykerPlugins).toEqual([
      {
        kind: 'Reporter',
        name: 'guardrails-progress',
        injectableClass: GuardrailsProgressReporter,
      },
    ]);
    expect(GuardrailsProgressReporter.inject).toEqual(['options']);
  });

  it('writes and removes a real holder file from the env', () => {
    const target = path.join(directory, 'gate.lock.holder.json');
    vi.stubEnv('GUARDRAILS_LOCK_HOLDER_FILE', target);
    vi.stubEnv('GUARDRAILS_LOCK_RUNG', 'commit');
    vi.stubEnv('GUARDRAILS_LOCK_REPO', '/dev/app');
    const reporter = new GuardrailsProgressReporter({ timeoutMS: 5000 });
    expect(parseHolder(readFileSync(target, 'utf8'))).toMatchObject({
      repo: '/dev/app',
      rung: 'commit',
      pid: process.pid,
      phase: 'dry-run',
    });
    reporter.onMutationTestingPlanReady(plans(1, 0));
    reporter.onMutationTestReportReady(...report);
    expect(existsSync(target)).toBe(false);
  });
});
