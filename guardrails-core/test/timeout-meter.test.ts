import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TimeoutMeter } from '../src/timeout-meter.js';

/**
The meter runs inside stryker on events it does not type: garbage must cost
nothing but the garbage. The plugin's own tests cover the real shapes.
*/
describe('TimeoutMeter on events that are not what stryker sends', () => {
  it('measures nothing before a plan', () => {
    const meter = new TimeoutMeter('/repo', undefined);
    meter.tested({ id: '1', status: 'Timeout' }, 5);
    expect(meter.costs()).toBeUndefined();
  });

  it('plans nothing from a plan that is not a list of plans', () => {
    for (const event of [undefined, 'plan', { mutantPlans: 5 }]) {
      const meter = new TimeoutMeter('/repo', undefined);
      meter.planReady(event, 0);
      meter.tested({ id: '1', status: 'Timeout' }, 5);
      expect(meter.costs()).toMatchObject({ wallClock: 0 });
    }
  });

  it('skips entries that are not plans, and results that are not results', () => {
    const meter = new TimeoutMeter('/repo', undefined);
    meter.planReady(
      {
        mutantPlans: [
          'not a plan',
          null,
          { plan: 'Run', mutant: 'not a mutant' },
          { plan: 'Run', mutant: null },
          { plan: 'Run', mutant: { id: 1 } },
          { plan: 'EarlyResult', mutant: { id: '2' } },
          { plan: 'Run', mutant: { id: '3' }, runOptions: null },
        ],
      },
      0,
    );
    meter.tested('not a result', 1);
    meter.tested(null, 1);
    meter.tested({ id: 1, status: 'Timeout' }, 2);
    meter.tested({ id: '2', status: 'Timeout' }, 3);
    meter.tested(
      { id: '3', status: 'Timeout', fileName: '/repo/a.ts', location: null },
      4,
    );
    expect(meter.costs()).toEqual({
      wallClock: 1,
      hitLimit: 0,
      budgetMs: 0,
      wallClockGapMs: 4,
      otherGapMs: 0,
      byFile: [{ file: 'a.ts', count: 1, firstLine: 0, lastLine: 0 }],
    });
  });

  it('reads a location only when its start is there', () => {
    const meter = new TimeoutMeter('/repo', undefined);
    meter.planReady({ mutantPlans: [{ plan: 'Run', mutant: { id: '1' } }] }, 0);
    meter.tested(
      {
        id: '1',
        status: 'Timeout',
        fileName: '/repo/a.ts',
        location: { start: null },
      },
      1,
    );
    expect(meter.costs()?.byFile).toEqual([
      { file: 'a.ts', count: 1, firstLine: 0, lastLine: 0 },
    ]);
  });

  it('makes a file relative to the repo reached through a symlink', () => {
    // Stryker names files by their real path; the repo may be named through a
    // symlink (macOS's /var is /private/var), found live by the drift guard.
    const real = mkdtempSync(path.join(tmpdir(), 'guardrails-meter-'));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      const meter = new TimeoutMeter(link, undefined);
      meter.planReady(
        { mutantPlans: [{ plan: 'Run', mutant: { id: '1' } }] },
        0,
      );
      meter.tested(
        {
          id: '1',
          status: 'Timeout',
          fileName: path.join(realpathSync(real), 'src', 'a.ts'),
        },
        1,
      );
      expect(meter.costs()?.byFile).toMatchObject([{ file: 'src/a.ts' }]);
    } finally {
      rmSync(link);
      rmSync(real, { recursive: true });
    }
  });

  it('keeps the root as given when it cannot be resolved', () => {
    const meter = new TimeoutMeter('/no/such/repo', undefined);
    meter.planReady({ mutantPlans: [{ plan: 'Run', mutant: { id: '1' } }] }, 0);
    meter.tested(
      { id: '1', status: 'Timeout', fileName: '/no/such/repo/src/a.ts' },
      1,
    );
    expect(meter.costs()?.byFile).toMatchObject([{ file: 'src/a.ts' }]);
  });

  it('keeps no dry-run timing from an event without one', () => {
    const meter = new TimeoutMeter('/repo', undefined);
    meter.dryRunCompleted({ timing: null });
    meter.dryRunCompleted(undefined);
    expect(meter.settings()).toBeUndefined();
  });

  it('reads only the timeout settings from the options', () => {
    const meter = new TimeoutMeter('/repo', {
      timeoutMS: 1,
      dryRunNetMs: 9,
      concurrency: 2,
    });
    expect(meter.settings()).toEqual({ timeoutMS: 1, concurrency: 2 });
  });
});
