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
