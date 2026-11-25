/**
 * Settles #180: does the push gate score a stryker `Timeout` as a survivor?
 *
 * It does not. A `Timeout` is a detected mutant — stryker's own score counts
 * it with the killed ones — and the adapter's failing statuses are `Survived`
 * and `NoCoverage` only. This test holds that against REAL stryker rather than
 * a hand-written report, because the belief that timeouts block came from
 * real gate runs, and a hand-written report cannot show what stryker writes
 * for a mutant that hangs.
 *
 * The fixture's loop has an `UpdateOperator` mutant (`index++` → `index--`)
 * that never ends, so stryker can only time it out. The branch changes the
 * file without touching the loop, and the gate judges it at the push rung
 * twice:
 *
 * - **cold**, with no cache and no seed, so stryker measures the timeout;
 * - **seeded**, from a report stryker wrote on `main` (the way CI's report
 *   reaches a lane through `mutationCache.seedFrom`), so the timeout verdict
 *   is reused, not re-measured.
 *
 * Both must report nothing, and both reports must hold the `Timeout`, so the
 * test cannot pass on a run whose loop mutant was never generated.
 *
 * Fixture written to a temp directory at run time, and skipped under this
 * repo's own mutation pass, for the reasons `stryker-runner.test.ts` gives.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { type Exec, spawnExec } from '../../src/exec.js';
import {
  holderEnvironment,
  parseRunSummary,
  PROGRESS_REPORTER,
  type RunSummary,
  runSummaryPath,
} from '../../src/lock-holder.js';
import { runVerify, writeMutationFingerprint } from '../../src/verify/index.js';
import { describeUnlessMutating } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const binDirectory = path.join(repoRoot, 'node_modules', '.bin');

const COUNT_SOURCE = `export function countUp(limit: number): number {
  let steps = 0;
  for (let index = 0; index < limit; index++) {
    steps += 1;
  }
  return steps;
}
`;

const COUNT_TEST = `import { describe, expect, it } from 'vitest';

import { countUp } from './src/count.js';

describe('countUp', () => {
  it('counts to its limit', () => {
    expect(countUp(3)).toBe(3);
    expect(countUp(0)).toBe(0);
  });
});
`;

const FIXTURE_MANIFEST = {
  name: 'stryker-timeout-fixture',
  private: true,
  type: 'module',
};

/**
 * A short `timeoutMS`, so the hanging mutant costs seconds, not the
 * default's tens of them.
 */
const STRYKER_CONFIG = {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['json'],
  vitest: { configFile: 'vitest.config.ts' },
  mutate: ['src/count.ts'],
  coverageAnalysis: 'perTest',
  timeoutMS: 1000,
};

/**
The fixture's stryker config with `change` applied, as file text.
*/
function strykerConfigWith(change: Record<string, unknown>): string {
  return `${JSON.stringify({ ...STRYKER_CONFIG, ...change })}\n`;
}

/**
Every analyzer but stryker off, so the verdict is stryker's alone.
*/
const ONLY_STRYKER = {
  eslint: 'off',
  tsc: 'off',
  knip: 'off',
  'npm-peers': 'off',
  'dependency-cruiser': 'off',
  stryker: 'required',
  dupes: 'off',
  complexity: 'off',
} as const;

/** Inherited GIT_* variables are stripped: under a git hook they point at the
 *  REAL repository, and this fixture's git calls would read or write it. The
 *  caller's own variables are kept: the seed command needs
 *  `GUARDRAILS_SEED_DIR`. */
function cleanEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
  );
}

const exec: Exec = (command, args, options) =>
  spawnExec(command, args, {
    ...options,
    env: cleanEnvironment(options?.env ?? process.env),
  });

async function run(
  directory: string,
  command: string,
  ...args: string[]
): Promise<void> {
  const result = await exec(command, args, { cwd: directory });
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
}

async function buildFixture(
  extra: Record<string, string> = {},
): Promise<string> {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'guardrails-stryker-timeout-'),
  );
  const files: Record<string, string> = {
    'src/count.ts': COUNT_SOURCE,
    'count.test.ts': COUNT_TEST,
    '.gitignore': 'node_modules\nreports\n.stryker-tmp\n',
    'package.json': `${JSON.stringify(FIXTURE_MANIFEST)}\n`,
    'vitest.config.ts': `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n`,
    'stryker.conf.json': strykerConfigWith({}),
    ...extra,
  };
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    'dir',
  );
  await run(directory, 'git', 'init', '-q', '-b', 'main');
  await run(directory, 'git', 'config', 'user.email', 'test@example.com');
  await run(directory, 'git', 'config', 'user.name', 'Test');
  await run(directory, 'git', 'add', '-A');
  await run(directory, 'git', 'commit', '-q', '-m', 'main');
  return directory;
}

interface ReportedMutant {
  status: string;
  mutatorName: string;
  statusReason?: string;
  killedBy?: string[];
}

function mutantsOf(reportJson: string, file: string): ReportedMutant[] {
  const report = JSON.parse(reportJson) as {
    files: Record<string, { mutants: ReportedMutant[] }>;
  };
  return report.files[file]?.mutants ?? [];
}

function statusesOf(reportJson: string, file: string): string[] {
  return mutantsOf(reportJson, file).map((mutant) => mutant.status);
}

function readReport(directory: string): Promise<string> {
  return readFile(
    path.join(directory, 'reports', 'mutation', 'mutation.json'),
    'utf8',
  );
}

/** The push rung's analyzer, over the whole file so the untouched loop is
 *  judged (line ranges would scope it out). */
function pushGate(
  directory: string,
  extra: Partial<Parameters<typeof runVerify>[0]> = {},
): ReturnType<typeof runVerify> {
  return runVerify({
    repoRoot: directory,
    baseBranch: 'main',
    exec,
    profile: 'push',
    analyzers: ONLY_STRYKER,
    resolveBin: (tool) => path.join(binDirectory, tool),
    mutationScope: {
      lines: false,
      padding: 0,
      wholeFileAbove: 0,
      enclosing: false,
    },
    ...extra,
  });
}

/** Runs stryker on `main`, as CI does, and returns a directory holding its
 *  report and fingerprint sidecar: what a seed command copies. */
async function seedFromMain(directory: string): Promise<string> {
  await run(directory, path.join(binDirectory, 'stryker'), 'run');
  const seedDirectory = mkdtempSync(
    path.join(tmpdir(), 'guardrails-stryker-timeout-seed-'),
  );
  const mainReport = await readReport(directory);
  expect(statusesOf(mainReport, 'src/count.ts')).toContain('Timeout');
  writeFileSync(path.join(seedDirectory, 'mutation.json'), mainReport);
  const sidecar = await writeMutationFingerprint(directory, exec, []);
  expect(sidecar).toBeDefined();
  cpSync(
    path.join(directory, String(sidecar)),
    path.join(seedDirectory, 'mutation.fingerprint.json'),
  );
  rmSync(path.join(directory, 'reports'), { recursive: true });
  return seedDirectory;
}

/**
The branch: count.ts changes, its loop does not; `files` change too.
*/
async function branch(
  directory: string,
  files: Record<string, string> = {},
): Promise<void> {
  await run(directory, 'git', 'checkout', '-q', '-b', 'feature');
  writeFileSync(
    path.join(directory, 'src', 'count.ts'),
    `${COUNT_SOURCE}// The loop above is unchanged on this branch.\n`,
  );
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, file), contents);
  }
  await run(directory, 'git', 'add', '-A');
  await run(directory, 'git', 'commit', '-q', '-m', 'feature');
}

/**
The push gate with the seed in `seedDirectory`, and its progress lines.
*/
async function seededPushGate(
  directory: string,
  seedDirectory: string,
): Promise<{ violations: unknown[]; progress: string }> {
  const lines: string[] = [];
  const result = await pushGate(directory, {
    mutationCacheSeed: {
      command: `cp "${seedDirectory}"/* "$GUARDRAILS_SEED_DIR"/`,
      timeoutSeconds: 60,
    },
    progress: (line) => {
      lines.push(line);
    },
  });
  return { violations: result.violations, progress: lines.join('\n') };
}

describeUnlessMutating(here)(
  'drift-guard: a stryker Timeout at the push gate',
  () => {
    it('blocks nothing, cold or seeded', async () => {
      const directory = await buildFixture();
      const seedDirectory = await seedFromMain(directory);
      await branch(directory);

      const coldLines: string[] = [];
      const cold = await pushGate(directory, {
        progress: (line) => {
          coldLines.push(line);
        },
      });
      expect(cold.violations).toEqual([]);
      const timeouts = mutantsOf(
        await readReport(directory),
        'src/count.ts',
      ).filter((mutant) => mutant.status === 'Timeout');
      expect(timeouts).not.toEqual([]);
      // #202 re-tests no hit-limit Timeout, and knows one by this reason:
      // stryker counted the mutant's own executions past its limit, which a
      // loaded machine cannot cause. A changed wording would re-test them.
      for (const timeout of timeouts) {
        expect(timeout.statusReason).toMatch(
          /^Hit limit reached \(\d+\/\d+\)$/,
        );
      }
      expect(coldLines.join('\n')).not.toContain('re-testing');

      rmSync(path.join(directory, 'reports'), { recursive: true });
      const seeded = await seededPushGate(directory, seedDirectory);
      expect(seeded.progress).toContain('seeded the mutation cache from 1');
      expect(seeded.violations).toEqual([]);
      expect(statusesOf(await readReport(directory), 'src/count.ts')).toContain(
        'Timeout',
      );
    }, 600_000);
  },
);

/**
 * #177: a seed survives what cannot change a verdict, through the real gate.
 * The branch adds a `mutate` entry for another module, changes the reporters,
 * adds a formatter devDependency and writes a lockfile -- each of which threw
 * every seed away when the fingerprint hashed the whole config and lockfile.
 * A change to an option that judges mutants still does.
 */
describeUnlessMutating(here)('drift-guard: the seed fingerprint (#177)', () => {
  it('keeps the seed across changes that cannot change a verdict', async () => {
    const directory = await buildFixture();
    const seedDirectory = await seedFromMain(directory);
    await branch(directory, {
      'stryker.conf.json': strykerConfigWith({
        mutate: ['src/count.ts', 'src/other.ts'],
        reporters: ['json', 'clear-text'],
      }),
      'package.json': `${JSON.stringify({ ...FIXTURE_MANIFEST, devDependencies: { prettier: '*' } })}\n`,
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
    });
    const seeded = await seededPushGate(directory, seedDirectory);
    expect(seeded.progress).toContain('seeded the mutation cache from 1');
    expect(seeded.violations).toEqual([]);
  }, 600_000);

  it('rejects the seed when an option that judges mutants changed', async () => {
    const directory = await buildFixture();
    const seedDirectory = await seedFromMain(directory);
    await branch(directory, {
      'stryker.conf.json': strykerConfigWith({ timeoutMS: 2000 }),
    });
    const seeded = await seededPushGate(directory, seedDirectory);
    expect(seeded.progress).toContain(
      'was measured under different stryker options from this checkout',
    );
  }, 600_000);
});

/**
 * A module only `settle.ts` calls, kept out of `mutate`: its loop spins on
 * the clock and runs no mutant, so nothing but stryker's timer can stop it.
 */
const SPIN_SOURCE = `export function spinFor(milliseconds: number): number {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Spin.
  }
  return milliseconds;
}
`;

/**
 * Its one hanging mutant is `Math.min` → `Math.max`: a 60-second spin that
 * evaluates no mutant while it spins, so stryker's hit counter never trips
 * and only the wall clock times it out -- the kind of Timeout #202 re-tests.
 */
const SETTLE_SOURCE = `import { spinFor } from './spin.js';

export function settle(budget: number): number {
  return spinFor(Math.min(budget, 5));
}
`;

const SETTLE_TEST = `import { describe, expect, it } from 'vitest';

import { settle } from './src/settle.js';

describe('settle', () => {
  it('spins for at most five milliseconds', () => {
    expect(settle(60_000)).toBe(5);
  });
});
`;

/**
The branch: settle.ts changes, its code does not.
*/
async function settleBranch(directory: string): Promise<void> {
  await run(directory, 'git', 'checkout', '-q', '-b', 'feature');
  writeFileSync(
    path.join(directory, 'src', 'settle.ts'),
    `${SETTLE_SOURCE}// Unchanged on this branch.\n`,
  );
  await run(directory, 'git', 'add', '-A');
  await run(directory, 'git', 'commit', '-q', '-m', 'feature');
}

/**
 * #202 against real stryker: a wall-clock Timeout that really hangs is
 * re-tested once, alone, times out again, and stays a kill.
 */
describeUnlessMutating(here)(
  'drift-guard: a wall-clock Timeout is re-tested (#202)',
  () => {
    it('re-tests a mutant that really hangs, and keeps it killed', async () => {
      const directory = await buildFixture({
        'src/spin.ts': SPIN_SOURCE,
        'src/settle.ts': SETTLE_SOURCE,
        'settle.test.ts': SETTLE_TEST,
        'stryker.conf.json': strykerConfigWith({ mutate: ['src/settle.ts'] }),
      });
      await settleBranch(directory);

      const lines: string[] = [];
      const result = await pushGate(directory, {
        progress: (line) => {
          lines.push(line);
        },
      });

      expect(result.violations).toEqual([]);
      expect(lines).toContain(
        'guardrails: re-testing 1 timed-out mutant alone, in one more ' +
          'stryker run, before counting it killed.',
      );
      expect(lines).toContain(
        'guardrails: re-test: 1 timed out again (killed), 0 re-scored.',
      );
      // The premise the selection rests on: a wall-clock Timeout carries no
      // reason and names no killing test.
      const hang = mutantsOf(await readReport(directory), 'src/settle.ts').find(
        (mutant) => mutant.status === 'Timeout',
      );
      expect(hang).toMatchObject({ mutatorName: 'MethodExpression' });
      expect(hang?.statusReason).toBeUndefined();
      expect(hang?.killedBy ?? []).toEqual([]);
      expect(result.mutationRun?.stryker).toMatchObject({
        retested: 1,
        rescored: 0,
      });
    }, 600_000);
  },
);

/**
The BUILT progress plugin, as a locked gate loads it.
*/
const builtPlugin = path.resolve(
  here,
  '../../dist/stryker-progress-plugin.mjs',
);

/**
 * Three functions whose `Math.min` → `Math.max` mutant spins for a minute on
 * the clock, evaluating no mutant while it spins, so only stryker's wall
 * clock can stop it: three wall-clock Timeouts. Every other mutant here dies
 * fast. `spin.ts` is not mutated.
 */
const HANG_SOURCE = `import { spinFor } from './spin.js';

export function first(budget: number): number {
  return spinFor(Math.min(budget, 5));
}

export function second(budget: number): number {
  return spinFor(Math.min(budget, 5));
}

export function third(budget: number): number {
  return spinFor(Math.min(budget, 5));
}

export function isPositive(value: number): boolean {
  return value > 0;
}
`;

const HANG_TEST = `import { describe, expect, it } from 'vitest';

import { first, isPositive, second, third } from './src/hang.js';

describe('hang', () => {
  it('first spins for at most five milliseconds', () => {
    expect(first(60_000)).toBe(5);
  });

  it('second spins for at most five milliseconds', () => {
    expect(second(60_000)).toBe(5);
  });

  it('third spins for at most five milliseconds', () => {
    expect(third(60_000)).toBe(5);
  });

  it('tells positive from not', () => {
    expect(isPositive(1)).toBe(true);
    expect(isPositive(0)).toBe(false);
    expect(isPositive(-1)).toBe(false);
  });
});
`;

/**
The line stryker's timeout decorator logs, at debug level, before it restarts.
*/
const RESTART_LINE = 'Timeout expired, restarting the process';

/**
How much one timeout may cost beyond its budget before the guard calls it news.
*/
const RESTART_ALLOWANCE_MS = 20_000;

interface MeasuredRun {
  summary: RunSummary;
  restarts: number;
}

/**
 * Real stryker over `directory` at concurrency 1, with the built plugin
 * loaded as a locked gate loads it, and a debug log to count restarts in.
 */
async function measuredRun(directory: string): Promise<MeasuredRun> {
  expect(
    existsSync(builtPlugin),
    `no built plugin at ${builtPlugin} -- run npm run build`,
  ).toBe(true);
  const result = await spawnExec(
    path.join(binDirectory, 'stryker'),
    [
      'run',
      '--reporters',
      `json,${PROGRESS_REPORTER}`,
      '--appendPlugins',
      builtPlugin,
      '--concurrency',
      '1',
      '--fileLogLevel',
      'debug',
    ],
    {
      cwd: directory,
      env: {
        ...cleanEnvironment(),
        ...holderEnvironment(
          path.join(directory, 'gate.lock'),
          'push',
          directory,
        ),
      },
    },
  );
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  const summary = parseRunSummary(
    await readFile(runSummaryPath(directory), 'utf8'),
  );
  const log = await readFile(path.join(directory, 'stryker.log'), 'utf8');
  return {
    summary: summary ?? expect.unreachable('the plugin wrote no run summary'),
    restarts: log.split('\n').filter((line) => line.includes(RESTART_LINE))
      .length,
  };
}

/**
 * #236 against real stryker: what a wall-clock Timeout costs, against the
 * budget stryker gave it, and whether stryker restarts its test runner after
 * one. Pins the Stryker internals the run log's timeout figures rest on: the
 * budget formula, the restart and its log line, and that a hit-limit Timeout
 * restarts nothing.
 */
describeUnlessMutating(here)(
  'drift-guard: what a stryker Timeout costs (#236)',
  () => {
    it('restarts the runner once per wall-clock timeout, costing its budget and a bounded restart', async () => {
      const directory = await buildFixture({
        'src/spin.ts': SPIN_SOURCE,
        'src/hang.ts': HANG_SOURCE,
        'hang.test.ts': HANG_TEST,
        'stryker.conf.json': strykerConfigWith({ mutate: ['src/hang.ts'] }),
      });
      const { summary, restarts } = await measuredRun(directory);
      const { timeouts, settings } = summary;

      expect(timeouts).toMatchObject({ wallClock: 3, hitLimit: 0 });
      expect(restarts).toBe(3);
      expect(timeouts?.byFile).toEqual([
        { file: 'src/hang.ts', count: 3, firstLine: 4, lastLine: 12 },
      ]);
      // The settings stryker resolved: the config's timeoutMS, its default
      // factor, the command line's concurrency.
      expect(settings).toMatchObject({
        timeoutMS: 1000,
        timeoutFactor: 1.5,
        concurrency: 1,
        dryRunNetMs: expect.any(Number),
        dryRunOverheadMs: expect.any(Number),
      });
      const net = settings?.dryRunNetMs ?? NaN;
      const overhead = settings?.dryRunOverheadMs ?? NaN;
      const budget = timeouts?.budgetMs ?? NaN;
      const gap = timeouts?.wallClockGapMs ?? NaN;
      // Each budget is timeoutFactor × netTime + timeoutMS + the dry run's
      // overhead, where a mutant's netTime is its covering tests' share of
      // the dry run's net time.
      expect(budget).toBeGreaterThanOrEqual(3 * (1000 + overhead));
      expect(budget).toBeLessThanOrEqual(3 * (1000 + overhead + 1.5 * net));
      // At concurrency 1 a timeout's gap is what it cost: its budget, then
      // the restart.
      expect(gap).toBeGreaterThanOrEqual(budget);
      expect(gap).toBeLessThanOrEqual(budget + 3 * RESTART_ALLOWANCE_MS);
      process.stdout.write(
        `#236 measured: budget ${String(Math.round(budget / 3))}ms per ` +
          `timeout (dry-run overhead ${String(overhead)}ms, net ` +
          `${String(net)}ms), actual ${String(Math.round(gap / 3))}ms, ` +
          `excess ${String(Math.round((gap - budget) / 3))}ms; ` +
          `${String(restarts)} restarts; other results ` +
          `${String(timeouts?.otherGapMs)}ms\n`,
      );
    }, 600_000);

    it('restarts nothing for a hit-limit timeout', async () => {
      const directory = await buildFixture();
      const { summary, restarts } = await measuredRun(directory);

      expect(summary.timeouts?.wallClock).toBe(0);
      expect(summary.timeouts?.hitLimit).toBeGreaterThan(0);
      expect(restarts).toBe(0);
    }, 600_000);
  },
);
