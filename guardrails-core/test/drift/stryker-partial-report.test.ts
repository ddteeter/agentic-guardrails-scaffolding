/**
 * Drift guard for stryker's PARTIAL incremental report on a stopped run
 * (#156; plan `docs/superpowers/plans/2026-11-07-stryker-incrementals.md`,
 * task 0.4 and Phase 4).
 *
 * Stryker 10 saves what it has tested so far when a run is interrupted
 * (stryker-js#5986), and loses it when a second signal arrives while it shuts
 * down (#6257). Measured on 2026-11-07 (plan.md, "Roadmap: fixer-loop
 * hardening"): a gate stopped by a signal to its whole process tree hands
 * stryker exactly that second signal -- its own, then the gate's forward --
 * and a dialed.run gate stopped 1h40m in left `reports/` empty.
 *
 * So this runs REAL stryker through the gate's real spawn chain --
 * `runUnderLock` over a temp lock, the machine's real `lockf` or `flock`, the
 * resolved bin -- and stops it part-way, two ways:
 *
 * 1. the gate stops it (`terminateChildren`: one SIGINT to the group);
 * 2. stryker is signalled directly AND the gate stops it, the tree-kill shape.
 *    This one appends the BUILT progress plugin, which is what absorbs the
 *    repeat -- so it needs `npm run build`, as CI and the pre-push gate do.
 *
 * Either way the cache left behind must parse and hold Killed results the
 * next run can reuse. Skipped under this repo's own mutation pass, for the
 * reasons `under-mutation.ts` gives.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec, terminateChildren } from '../../src/exec.js';
import { PROGRESS_REPORTER } from '../../src/lock-holder.js';
import { type LockedRun, runUnderLock } from '../../src/mutation-lock.js';
import { isUnderMutationRun } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');
const builtPlugin = path.resolve(
  here,
  '../../dist/stryker-progress-plugin.mjs',
);

/** Functions in the fixture, one test each. Every test naps, so the dry run
 *  and each mutant take long enough to stop the run part-way through. */
const FUNCTIONS = 12;

/**
 * A fixture whose every test run appends a line to `runLog`, an absolute path
 * outside stryker's sandbox. More lines than tests means the dry run is over
 * and mutants are being tested -- the window in which a partial report has
 * something in it.
 */
async function buildFixture(): Promise<{ directory: string; runLog: string }> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'guardrails-stryker-partial-'),
  );
  const runLog = path.join(directory, 'runs.log');
  await mkdir(path.join(directory, 'src'), { recursive: true });
  const indices = Array.from({ length: FUNCTIONS }, (_, index) => index);
  await writeFile(
    path.join(directory, 'src', 'calc.ts'),
    indices
      .map(
        (index) =>
          `export function f${String(index)}(a: number, b: number): number {\n  return a > b ? a + b : a - b;\n}\n`,
      )
      .join(''),
  );
  await writeFile(
    path.join(directory, 'calc.test.ts'),
    [
      "import { appendFileSync } from 'node:fs';",
      "import { expect, it } from 'vitest';",
      "import * as calc from './src/calc.js';",
      `const runLog = ${JSON.stringify(runLog)};`,
      'const nap = () => new Promise((resolve) => setTimeout(resolve, 300));',
      ...indices.map(
        (index) =>
          String.raw`it('f${String(index)}', async () => { appendFileSync(runLog, 'run\n'); await nap(); expect(calc.f${String(index)}(3, 2)).toBe(5); expect(calc.f${String(index)}(1, 2)).toBe(-1); expect(calc.f${String(index)}(2, 2)).toBe(0); });`,
      ),
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(directory, 'package.json'),
    '{"name":"stryker-partial-fixture","private":true,"type":"module"}\n',
  );
  await writeFile(
    path.join(directory, 'vitest.config.ts'),
    "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n",
  );
  await writeFile(
    path.join(directory, 'stryker.conf.json'),
    `${JSON.stringify({
      testRunner: 'vitest',
      plugins: ['@stryker-mutator/vitest-runner'],
      reporters: ['json'],
      vitest: { configFile: 'vitest.config.ts' },
      mutate: ['src/calc.ts'],
      coverageAnalysis: 'perTest',
      incremental: true,
      concurrency: 2,
    })}\n`,
  );
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    'dir',
  );
  return { directory, runLog };
}

function testRuns(runLog: string): number {
  return existsSync(runLog)
    ? readFileSync(runLog, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

async function untilMutating(runLog: string): Promise<void> {
  const deadline = Date.now() + 240_000;
  // A few mutants past the dry run, so there are results to save.
  while (testRuns(runLog) < FUNCTIONS + 6) {
    if (Date.now() > deadline) {
      throw new Error('stryker never got past its dry run');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
The pid of stryker itself: the process whose parent is the locker on `lock`.
*/
function strykerPid(lock: string): number {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='])
    .toString()
    .split('\n')
    .map((row) => {
      const [pid = '', ppid = '', ...command] = row.trim().split(/\s+/);
      return { pid, ppid, command: command.join(' ') };
    });
  const locker = rows.find(
    (row) =>
      (row.command.startsWith('lockf ') || row.command.startsWith('flock ')) &&
      row.command.includes(lock),
  );
  const child = rows.find((row) => row.ppid === locker?.pid);
  expect(child, 'no stryker under the locker').toBeDefined();
  return Number(child?.pid);
}

/**
The gate's stryker arguments, with `reporters`.
*/
function withReporters(reporters: string): string[] {
  return ['run', '--incremental', '--reporters', reporters];
}

/**
 * Start the fixture's stryker under the lock, as the gate starts it. With
 * `plugin`, the run appends it the way the gate appends the progress plugin
 * on a run that holds the lock.
 */
function startLocked(
  directory: string,
  lock: string,
  plugin?: string,
): Promise<LockedRun> {
  const args = withReporters('json');
  return runUnderLock({
    exec: spawnExec,
    rung: 'push',
    lock: {
      path: lock,
      config: {
        commitWaitSeconds: 60,
        pushWaitSeconds: 600,
        stopGraceSeconds: 60,
      },
    },
    command: strykerBin,
    args,
    ...(plugin !== undefined && {
      locked: {
        // As the gate asks on a held lock: the reporter is what stryker
        // constructs, so naming it is what loads the plugin's absorber.
        args: [
          ...withReporters(`json,${PROGRESS_REPORTER}`),
          '--appendPlugins',
          plugin,
        ],
        env: {
          ...process.env,
          GUARDRAILS_LOCK_HOLDER_FILE: `${lock}.holder.json`,
          GUARDRAILS_LOCK_RUNG: 'push',
          GUARDRAILS_LOCK_REPO: directory,
        },
      },
    }),
    cwd: directory,
    progress: () => {
      // The lock is free; nothing to say.
    },
  });
}

/**
How many mutants of each status the cache in `directory` holds.
*/
function cachedStatuses(directory: string): Record<string, number> {
  const report: unknown = JSON.parse(
    readFileSync(
      path.join(directory, 'reports', 'stryker-incremental.json'),
      'utf8',
    ),
  );
  const counts: Record<string, number> = {};
  const files = isRecord(report) && isRecord(report.files) ? report.files : {};
  for (const file of Object.values(files)) {
    const mutants =
      isRecord(file) && Array.isArray(file.mutants) ? file.mutants : [];
    for (const mutant of mutants) {
      const status = isRecord(mutant) ? String(mutant.status) : 'unknown';
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return counts;
}

/**
How the locked run ended: its signal, its exit code, or that it never ran.
*/
function ending(run: LockedRun): string | number {
  return run.kind === 'ran' ? (run.result.signal ?? run.result.code) : run.kind;
}

/**
Stryker's incremental summary, as `stryker-incremental.test.ts` reads it.
*/
const REUSE_SUMMARY = /(\d{1,9}) of \d{1,9} mutant result\(s\) are reused/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe.skipIf(isUnderMutationRun(here))(
  'drift-guard: a stopped stryker run leaves a partial incremental report',
  () => {
    it('saves one when the gate stops it, and the next run reuses it', async () => {
      const { directory, runLog } = await buildFixture();
      const lock = path.join(directory, 'gate.lock');
      const run = startLocked(directory, lock);
      await untilMutating(runLog);
      terminateChildren();
      const stopped = await run;
      const diagnostic = JSON.stringify(stopped);

      // Stopped, not finished: a run that completed would prove nothing.
      expect(ending(stopped), diagnostic).not.toBe(0);
      expect(cachedStatuses(directory).Killed ?? 0, diagnostic).toBeGreaterThan(
        0,
      );

      const again = await spawnExec(strykerBin, ['run', '--incremental'], {
        cwd: directory,
      });
      const output = `${again.stdout}\n${again.stderr}`;
      expect(again.code, output).toBe(0);
      const reused = Number(REUSE_SUMMARY.exec(output)?.[1] ?? '0');
      expect(reused, output).toBeGreaterThan(0);
    }, 600_000);

    it('saves one when stryker is signalled directly and by the gate', async () => {
      expect(
        existsSync(builtPlugin),
        'run `npm run build`: this guard needs the built progress plugin',
      ).toBe(true);
      const { directory, runLog } = await buildFixture();
      const lock = path.join(directory, 'gate.lock');
      const run = startLocked(directory, lock, builtPlugin);
      await untilMutating(runLog);
      // The tree-kill shape: stryker's own SIGTERM, then the gate's forward.
      // Without the plugin's absorber this second signal is stryker's
      // "Forced exit", and no report is written.
      process.kill(strykerPid(lock), 'SIGTERM');
      terminateChildren();
      const stopped = await run;
      const diagnostic = JSON.stringify(stopped);

      expect(ending(stopped), diagnostic).not.toBe(0);
      expect(cachedStatuses(directory).Killed ?? 0, diagnostic).toBeGreaterThan(
        0,
      );
    }, 300_000);
  },
);
