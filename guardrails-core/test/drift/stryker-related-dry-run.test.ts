/**
 * #200's spike: what does stryker's `--testFiles` buy the dry run, and what
 * does it cost the verdicts?
 *
 * The push gate's dry run is already related-only: the vitest runner's
 * `related` option defaults on, and stryker hands it the files to mutate. So
 * vitest runs only the specs whose import graph reaches them -- but to find
 * those it walks EVERY spec's graph first. Naming the covering spec files
 * with `--testFiles` would skip that walk. The question is how much it saves,
 * and whether it is safe: any test filter makes stryker activate mutants at
 * runtime (in a `beforeAll`), after module-level code has already run, so a
 * STATIC mutant -- one only module-level code reaches -- may never be active
 * while its tests run, and survive though they would kill it.
 *
 * The fixture: a target with one static mutant and runtime ones; six spec
 * files, two reaching the target (one through a helper) and four that do not,
 * each of those with an import chain of its own and a top-level await. Real
 * stryker runs it twice, without and with `--testFiles` naming the two that
 * reach it, and the guard records both answers whichever way they come out:
 *
 * - how much the dry run's overhead shrinks;
 * - whether the static mutant falsely survives under `--testFiles`.
 *
 * It pins what stryker 10.0 does. Where an assertion pins a stryker bug, it
 * says so, so the guard failing there is the news that stryker fixed it.
 *
 * Fixture written to a temp directory at run time, and skipped under this
 * repo's own mutation pass, for the reasons `stryker-runner.test.ts` gives.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import {
  holderEnvironment,
  parseRunSummary,
  PROGRESS_REPORTER,
  type RunSummary,
  runSummaryPath,
} from '../../src/lock-holder.js';
import { describeUnlessMutating } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const binDirectory = path.join(repoRoot, 'node_modules', '.bin');

/**
The BUILT progress plugin, as a locked gate loads it.
*/
const builtPlugin = path.resolve(
  here,
  '../../dist/stryker-progress-plugin.mjs',
);

/**
 * `GREETING` is evaluated once, when the module loads: its `StringLiteral`
 * mutant is static. `isPositive`'s mutants are reached from inside a test.
 */
const TARGET_SOURCE = `export const GREETING = 'hello';

export function isPositive(value: number): boolean {
  return value > 0;
}
`;

/**
Not mutated: the second spec reaches the target only through this.
*/
const HELPER_SOURCE = `import { GREETING, isPositive } from './target.js';

export function greet(): string {
  return \`\${GREETING}!\`;
}

export function signOf(value: number): string {
  return isPositive(value) ? 'positive' : 'not positive';
}
`;

const TARGET_TEST = `import { describe, expect, it } from 'vitest';

import { GREETING, isPositive } from './src/target.js';

describe('target', () => {
  it('greets', () => {
    expect(GREETING).toBe('hello');
  });

  it('tells positive from not', () => {
    expect(isPositive(1)).toBe(true);
    expect(isPositive(0)).toBe(false);
    expect(isPositive(-1)).toBe(false);
  });
});
`;

const HELPER_TEST = `import { describe, expect, it } from 'vitest';

import { greet, signOf } from './src/helper.js';

describe('helper', () => {
  it('greets loudly', () => {
    expect(greet()).toBe('hello!');
  });

  it('names a sign', () => {
    expect(signOf(2)).toBe('positive');
    expect(signOf(0)).toBe('not positive');
  });
});
`;

/**
The specs that do not reach the target, and the length of each one's chain.
*/
const UNRELATED_SPECS = 4;
const CHAIN_LENGTH = 40;
const TOP_LEVEL_AWAIT_MS = 300;

/**
`src/unrelated-<spec>/m<index>.ts`: one link of a spec's own import chain.
*/
function chainLink(index: number): string {
  return index + 1 < CHAIN_LENGTH
    ? `import { depth as next } from './m${String(index + 1)}.js';\n\nexport const depth = next + 1;\n`
    : 'export const depth = 1;\n';
}

function unrelatedTest(spec: number): string {
  return `import { describe, expect, it } from 'vitest';

import { depth } from './src/unrelated-${String(spec)}/m0.js';

await new Promise((resolve) => setTimeout(resolve, ${String(TOP_LEVEL_AWAIT_MS)}));

describe('unrelated ${String(spec)}', () => {
  it('walks its chain', () => {
    expect(depth).toBe(${String(CHAIN_LENGTH)});
  });
});
`;
}

function unrelatedFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let spec = 1; spec <= UNRELATED_SPECS; spec += 1) {
    files[`unrelated-${String(spec)}.test.ts`] = unrelatedTest(spec);
    for (let index = 0; index < CHAIN_LENGTH; index += 1) {
      files[`src/unrelated-${String(spec)}/m${String(index)}.ts`] =
        chainLink(index);
    }
  }
  return files;
}

const STRYKER_CONFIG = {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['json'],
  vitest: { configFile: 'vitest.config.ts' },
  mutate: ['src/target.ts'],
  coverageAnalysis: 'perTest',
  concurrency: 1,
};

/**
The specs that reach the target: what a scope planner would name.
*/
const COVERING_SPECS = ['target.test.ts', 'helper.test.ts'];

/** Inherited GIT_* variables are stripped: under a git hook they point at the
 *  REAL repository. Nothing here runs git, but stryker's children inherit
 *  this environment. */
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

async function buildFixture(): Promise<string> {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'guardrails-stryker-related-'),
  );
  const files: Record<string, string> = {
    'src/target.ts': TARGET_SOURCE,
    'src/helper.ts': HELPER_SOURCE,
    'target.test.ts': TARGET_TEST,
    'helper.test.ts': HELPER_TEST,
    ...unrelatedFiles(),
    'package.json': `${JSON.stringify({ name: 'stryker-related-fixture', private: true, type: 'module' })}\n`,
    'vitest.config.ts': `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n`,
    'stryker.conf.json': `${JSON.stringify(STRYKER_CONFIG)}\n`,
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
  return directory;
}

interface ReportedMutant {
  status: string;
  mutatorName: string;
  static?: boolean;
  location: { start: { line: number; column: number } };
}

interface StrykerRun {
  summary: RunSummary;
  mutants: ReportedMutant[];
}

/**
 * Real stryker over `directory`, with the built plugin loaded as a locked
 * gate loads it, and `extra` on its command line. Answers the plugin's run
 * summary and the report's mutants.
 */
async function strykerRun(
  directory: string,
  extra: readonly string[],
): Promise<StrykerRun> {
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
      ...extra,
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
  const report = JSON.parse(
    await readFile(
      path.join(directory, 'reports', 'mutation', 'mutation.json'),
      'utf8',
    ),
  ) as { files: Record<string, { mutants: ReportedMutant[] }> };
  return {
    summary: summary ?? expect.unreachable('the plugin wrote no run summary'),
    mutants: report.files['src/target.ts']?.mutants ?? [],
  };
}

/**
Each mutant as `<line>:<column> <mutator> <status>`, in a stable order.
*/
function verdicts(mutants: readonly ReportedMutant[]): string[] {
  return mutants
    .map(
      ({ location, mutatorName, status }) =>
        `${String(location.start.line)}:${String(location.start.column)} ${mutatorName} ${status}`,
    )
    .toSorted((left, right) => left.localeCompare(right));
}

/**
The static mutant: `GREETING`'s string, on the target's first line.
*/
function staticMutant(mutants: readonly ReportedMutant[]): ReportedMutant {
  const found = mutants.find(
    (mutant) =>
      mutant.mutatorName === 'StringLiteral' &&
      mutant.location.start.line === 1,
  );
  return found ?? expect.unreachable('no StringLiteral mutant on line 1');
}

function overheadOf(run: StrykerRun): number {
  return run.summary.settings?.dryRunOverheadMs ?? NaN;
}

/**
The lowest dry-run overhead of `runs`: the run least disturbed by load.
*/
function leastOverhead(runs: readonly StrykerRun[]): number {
  return Math.min(...runs.map((run) => overheadOf(run)));
}

/**
Every verdict but the static mutant's, which is on line 1.
*/
function runtimeVerdicts(run: StrykerRun): string[] {
  return verdicts(run.mutants).filter((verdict) => !verdict.startsWith('1:'));
}

/**
What the unrelated specs' top-level awaits would add, had any of them run.
*/
const UNRELATED_EXECUTION_MS = UNRELATED_SPECS * TOP_LEVEL_AWAIT_MS;

function spikeReport(
  related: readonly StrykerRun[],
  restricted: readonly StrykerRun[],
): string {
  const relatedMs = leastOverhead(related);
  const restrictedMs = leastOverhead(restricted);
  const saved = relatedMs - restrictedMs;
  const lines = [
    `#200 spike: dry-run overhead ${relatedMs.toFixed(0)}ms related-only, ` +
      `${restrictedMs.toFixed(0)}ms with --testFiles (${saved.toFixed(0)}ms, ` +
      `${((saved / relatedMs) * 100).toFixed(0)}% less, over ` +
      `${String(UNRELATED_SPECS * CHAIN_LENGTH)} modules only unrelated specs import)`,
    ...[...related.slice(0, 1), ...restricted.slice(0, 1)].map(
      (run, index) =>
        `  ${index === 0 ? 'related' : 'restricted'}: ` +
        `${verdicts(run.mutants).join(', ')}; ` +
        `work ${JSON.stringify(run.summary.mutantRuns)}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

describeUnlessMutating(here)(
  'drift-guard: a dry run restricted with --testFiles (#200)',
  () => {
    it('records what --testFiles saves the dry run, and what it does to a static mutant', async () => {
      const directory = await buildFixture();
      const restrict = ['--testFiles', COVERING_SPECS.join(',')];
      // Alternated, twice each, so neither mode always meets a cold cache.
      const related: StrykerRun[] = [];
      const restricted: StrykerRun[] = [];
      for (let round = 0; round < 2; round += 1) {
        related.push(await strykerRun(directory, []));
        restricted.push(await strykerRun(directory, restrict));
      }
      process.stdout.write(spikeReport(related, restricted));
      const [relatedRun] = related;
      const [restrictedRun] = restricted;
      if (relatedRun === undefined || restrictedRun === undefined) {
        expect.unreachable('two runs of each mode');
      }

      // (a) The dry run is related-only already: every run ran the two
      // specs that reach the target, and none ran an unrelated one, whose
      // top-level await would show in the overhead. What --testFiles saves
      // is vitest's walk of the unrelated specs' import graphs.
      for (const run of [...related, ...restricted]) {
        expect(run.summary.dryRunCounts).toEqual({ tests: 4, testFiles: 2 });
        expect(overheadOf(run)).toBeLessThan(UNRELATED_EXECUTION_MS);
      }
      expect(leastOverhead(restricted)).toBeLessThan(leastOverhead(related));

      // (b) The static mutant. Related-only, stryker runs every test with
      // the mutant active as modules load, and the greeting test kills it.
      // With --testFiles, stryker 10.0 activates it at runtime instead (any
      // test filter does), in a `beforeAll` -- after the module has set
      // GREETING -- so no test sees it, and it SURVIVES. That is a stryker
      // bug: the same tests kill it. When this expectation fails because
      // the mutant is Killed, stryker has fixed it.
      expect(staticMutant(relatedRun.mutants)).toMatchObject({
        status: 'Killed',
        static: true,
      });
      expect(staticMutant(restrictedRun.mutants)).toMatchObject({
        status: 'Survived',
        static: true,
      });

      // (c) Every other verdict is the same either way.
      expect(runtimeVerdicts(restrictedRun)).toEqual(
        runtimeVerdicts(relatedRun),
      );
      expect(runtimeVerdicts(relatedRun)).not.toEqual([]);

      // The plugin's tallies, against the report: every mutant ran, one of
      // them static, and the static mutant's verdict is the report's.
      for (const run of [...related, ...restricted]) {
        expect(run.summary.mutantRuns).toMatchObject({
          ran: run.mutants.length,
          static: 1,
        });
      }
      expect(relatedRun.summary.mutantRuns?.byMutator.StringLiteral).toEqual({
        Killed: 1,
      });
      expect(restrictedRun.summary.mutantRuns?.byMutator.StringLiteral).toEqual(
        { Survived: 1 },
      );
    }, 600_000);
  },
);
