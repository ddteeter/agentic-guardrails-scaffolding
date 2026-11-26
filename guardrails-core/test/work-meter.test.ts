import { describe, expect, it } from 'vitest';

import { WorkMeter } from '../src/work-meter.js';

/**
A dry-run test result: the slice stryker's `TestResult` the meter reads.
*/
function test(fileName?: unknown): Record<string, unknown> {
  return fileName === undefined
    ? { id: 'a', name: 'a', timeSpentMs: 1 }
    : { id: 'a', name: 'a', timeSpentMs: 1, fileName };
}

describe('WorkMeter: the dry run (#200)', () => {
  it('counts the tests the dry run ran and the files they are in', () => {
    const meter = new WorkMeter();
    meter.dryRunCompleted({
      result: {
        status: 'complete',
        tests: [
          test('/r/a.test.ts'),
          test('/r/a.test.ts'),
          test('/r/b.test.ts'),
        ],
      },
      timing: { net: 1, overhead: 1 },
    });
    expect(meter.dryRun()).toEqual({ tests: 3, testFiles: 2 });
  });

  it('counts no files when no test names its file', () => {
    const meter = new WorkMeter();
    meter.dryRunCompleted({ result: { tests: [test(), test(7)] } });
    expect(meter.dryRun()).toEqual({ tests: 2 });
  });

  it('counts a file only for the tests that name one', () => {
    const meter = new WorkMeter();
    meter.dryRunCompleted({
      result: { tests: [test(), test('/r/a.test.ts')] },
    });
    expect(meter.dryRun()).toEqual({ tests: 2, testFiles: 1 });
  });

  it('knows nothing before the dry run', () => {
    expect(new WorkMeter().dryRun()).toBeUndefined();
  });

  it.each([
    ['not an event', 'event'],
    ['no result', {}],
    ['a result that is not an object', { result: 3 }],
    ['tests that are not a list', { result: { tests: {} } }],
  ])('counts nothing from %s', (_label, event) => {
    const meter = new WorkMeter();
    meter.dryRunCompleted(event);
    expect(meter.dryRun()).toBeUndefined();
  });

  it('skips entries that are not test results', () => {
    const meter = new WorkMeter();
    meter.dryRunCompleted({
      result: { tests: [null, 'test', test('/r/a.ts')] },
    });
    expect(meter.dryRun()).toEqual({ tests: 1, testFiles: 1 });
  });
});

/**
A Run plan for mutant `id`, as stryker's `MutantRunPlan` carries it.
*/
function runPlan(id: string): Record<string, unknown> {
  return { plan: 'Run', mutant: { id }, runOptions: { timeout: 1 } };
}

function result(
  id: string,
  mutatorName: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, mutatorName, status, fileName: '/r/src/a.ts', ...extra };
}

const NONE = {
  ran: 0,
  testsCompleted: 0,
  coveredBy: 0,
  withCoveredBy: 0,
  static: 0,
  byMutator: {},
};

describe('WorkMeter: the mutants stryker ran (#200)', () => {
  it('adds up tests run, coverage and static mutants, and counts by mutator and status', () => {
    const meter = new WorkMeter();
    meter.planReady({
      mutantPlans: [runPlan('1'), runPlan('2'), runPlan('3'), runPlan('4')],
    });
    meter.tested(
      result('1', 'ConditionalExpression', 'Killed', {
        testsCompleted: 2,
        coveredBy: ['a', 'b', 'c'],
      }),
    );
    meter.tested(
      result('2', 'ConditionalExpression', 'Survived', {
        testsCompleted: 3,
        coveredBy: ['a', 'b', 'c'],
      }),
    );
    meter.tested(
      result('3', 'StringLiteral', 'Killed', {
        testsCompleted: 40,
        coveredBy: [],
        static: true,
      }),
    );
    meter.tested(result('4', 'ConditionalExpression', 'Killed'));
    expect(meter.mutantRuns()).toEqual({
      ran: 4,
      testsCompleted: 45,
      coveredBy: 6,
      withCoveredBy: 3,
      static: 1,
      byMutator: {
        ConditionalExpression: { Killed: 2, Survived: 1 },
        StringLiteral: { Killed: 1 },
      },
    });
  });

  it('counts only the mutants stryker planned to run, each once', () => {
    const meter = new WorkMeter();
    meter.planReady({
      mutantPlans: [
        runPlan('1'),
        { plan: 'EarlyResult', mutant: { id: '2', status: 'Killed' } },
      ],
    });
    meter.tested(result('2', 'StringLiteral', 'Killed', { testsCompleted: 9 }));
    meter.tested(result('9', 'StringLiteral', 'Killed', { testsCompleted: 9 }));
    meter.tested(result('1', 'StringLiteral', 'Killed', { testsCompleted: 1 }));
    meter.tested(result('1', 'StringLiteral', 'Killed', { testsCompleted: 1 }));
    expect(meter.mutantRuns()).toEqual({
      ...NONE,
      ran: 1,
      testsCompleted: 1,
      byMutator: { StringLiteral: { Killed: 1 } },
    });
  });

  it('knows nothing before the plan, and nothing of a result that came before it', () => {
    const meter = new WorkMeter();
    meter.tested(result('1', 'StringLiteral', 'Killed'));
    expect(meter.mutantRuns()).toBeUndefined();
    meter.planReady({ mutantPlans: [runPlan('1')] });
    expect(meter.mutantRuns()).toEqual(NONE);
  });

  it.each([
    ['not a result', 'result'],
    ['null', null],
    ['no mutator', { id: '1', status: 'Killed' }],
    ['no status', { id: '1', mutatorName: 'StringLiteral' }],
    ['a mutator of the wrong kind', { id: '1', mutatorName: 3, status: 'x' }],
  ])('skips a result that is %s', (_label, tested) => {
    const meter = new WorkMeter();
    meter.planReady({ mutantPlans: [runPlan('1')] });
    meter.tested(tested);
    expect(meter.mutantRuns()).toEqual(NONE);
  });

  it('skips a test count, a coverage list or a static flag of the wrong kind', () => {
    const meter = new WorkMeter();
    meter.planReady({ mutantPlans: [runPlan('1')] });
    meter.tested(
      result('1', 'StringLiteral', 'Killed', {
        testsCompleted: '3',
        coveredBy: 'a',
        static: 'yes',
      }),
    );
    expect(meter.mutantRuns()).toEqual({
      ...NONE,
      ran: 1,
      byMutator: { StringLiteral: { Killed: 1 } },
    });
  });

  it('plans nothing from a plan that is not a list of plans', () => {
    for (const event of [undefined, 'plan', { mutantPlans: 5 }]) {
      const meter = new WorkMeter();
      meter.planReady(event);
      meter.tested(result('1', 'StringLiteral', 'Killed'));
      expect(meter.mutantRuns()).toEqual(NONE);
    }
  });

  it('keeps a mutator or status named like a prototype as a plain entry', () => {
    const meter = new WorkMeter();
    meter.planReady({ mutantPlans: [runPlan('1'), runPlan('2')] });
    meter.tested(result('1', '__proto__', 'Killed'));
    meter.tested(result('2', 'StringLiteral', '__proto__'));
    const runs = meter.mutantRuns();
    expect(Object.keys(runs?.byMutator ?? {})).toEqual([
      '__proto__',
      'StringLiteral',
    ]);
    expect(Object.getPrototypeOf(runs?.byMutator)).toBe(Object.prototype);
    expect(Object.entries(runs?.byMutator.StringLiteral ?? {})).toEqual([
      ['__proto__', 1],
    ]);
  });
});
