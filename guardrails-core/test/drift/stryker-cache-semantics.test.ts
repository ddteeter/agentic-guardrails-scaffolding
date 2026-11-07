/**
 * Drift guards for the facts the incremental-cache REWRITER rests on (#156).
 *
 * `runStryker` no longer keeps or deletes stryker's incremental cache whole: it
 * reads it, drops the verdicts it cannot vouch for, and writes the rest back
 * for `--incremental` to reuse. That rewriter trusts three things about real
 * stryker that no hand-written report can establish, and each `it` below pins
 * one of them against a live run over a fixture whose verdicts are known:
 *
 * 1. **Report shape.** A Killed mutant's `killedBy` names test ids, and each id
 *    resolves to exactly one test under `testFiles[<file>].tests` — which is
 *    how the rewriter learns which FILE killed a mutant. The vitest runner
 *    gives tests an id and a name and nothing else (no `location`), so the
 *    file is known only from the `testFiles` key.
 * 2. **The upstream gap (#67, stryker-js#6119).** A module-level ("static")
 *    mutant that survived is reused on the next run even after a killing test
 *    is added, because static mutants have no per-test coverage for stryker's
 *    differ to compare. This is the bug the rewriter's "always drop Survived"
 *    rule closes, and the test documents it rather than tolerating it: if it
 *    stops reproducing upstream, the failure is the notice.
 * 3. **Ranges fold back (#155's premise).** A `--mutate file:a-b` run reuses
 *    only in-range mutants, but the report it writes carries EVERY cached
 *    verdict — out-of-range mutants in the same file and whole other files —
 *    and the cache it writes keeps them too. So a line-range gate must filter
 *    its own verdicts by range; stryker will not do it for it.
 *
 * Measured on @stryker-mutator/core 10.0.0 with the vitest runner. Fixtures
 * are written to a temp directory and skipped under this repo's own mutation
 * pass, for the reasons `stryker-runner.test.ts` gives.
 */

import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import { isRecord } from '../../src/is-record.js';
import { isUnderMutationRun } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');

/** One boundary the weak test never asserts (`>=` → `>` survives at line 2);
 *  every other mutant is killed. Lines 3 and 5 hold the two return literals. */
const TIER_SOURCE = `export function tier(spend: number): string {
  if (spend >= 1000) {
    return 'gold';
  }
  return 'bronze';
}
`;

const TIER_TEST = `import { describe, expect, it } from 'vitest';

import { tier } from './src/tier.js';

describe('tier', () => {
  it('names the tiers either side of the boundary', () => {
    expect(tier(2000)).toBe('gold');
    expect(tier(0)).toBe('bronze');
  });
});
`;

/** Evaluated at import, so every mutant in it is static. The weak test checks
 *  only the TYPE of the literal, which leaves the `'item'` → `''` mutant
 *  standing; the strong one pins the value, which kills it. */
const UNIT_SOURCE = `export const UNIT = { one: 'item' };
`;

const WEAK_UNIT_TEST = `import { describe, expect, it } from 'vitest';

import { UNIT } from './src/unit.js';

describe('unit', () => {
  it('names one item', () => {
    expect(typeof UNIT.one).toBe('string');
  });
});
`;

/** Same `it` name as the weak test: the fixer strengthens the test in place,
 *  which is the loop #67 reported (see `stryker-incremental.test.ts`). */
const STRONG_UNIT_TEST = `import { describe, expect, it } from 'vitest';

import { UNIT } from './src/unit.js';

describe('unit', () => {
  it('names one item', () => {
    expect(UNIT.one).toBe('item');
  });
});
`;

const MUTATED = ['src/tier.ts', 'src/unit.ts'];

async function buildFixture(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'guardrails-stryker-cache-'),
  );
  await mkdir(path.join(directory, 'src'), { recursive: true });
  const files: Record<string, string> = {
    'src/tier.ts': TIER_SOURCE,
    'src/unit.ts': UNIT_SOURCE,
    'tier.test.ts': TIER_TEST,
    'unit.test.ts': WEAK_UNIT_TEST,
    'package.json': `${JSON.stringify({ name: 'stryker-cache-fixture', private: true, type: 'module' })}\n`,
    'vitest.config.ts': `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n`,
    'stryker.conf.json': `${JSON.stringify({
      testRunner: 'vitest',
      plugins: ['@stryker-mutator/vitest-runner'],
      reporters: ['json'],
      vitest: { configFile: 'vitest.config.ts' },
      mutate: MUTATED,
      coverageAnalysis: 'perTest',
      incremental: true,
    })}\n`,
  };
  await Promise.all(
    Object.entries(files).map(([file, contents]) =>
      writeFile(path.join(directory, file), contents),
    ),
  );
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    'dir',
  );
  return directory;
}

/**
The fields of one mutant this guard reads, validated off disk.
*/
interface ObservedMutant {
  file: string;
  status: string;
  mutatorName: string;
  line: number;
  isStatic: boolean;
  killedBy: unknown;
  coveredBy: unknown;
}

interface ObservedReport {
  mutants: ObservedMutant[];
  /**
  Test id → the `testFiles` key it sits under.
  */
  testFileOf: Map<string, string>;
  /**
  Every test entry's own keys, to pin what the vitest runner records.
  */
  testKeys: string[][];
}

function observedMutant(file: string, value: unknown): ObservedMutant {
  if (!isRecord(value) || !isRecord(value.location)) {
    throw new Error(`not a mutant: ${JSON.stringify(value)}`);
  }
  const start = value.location.start;
  return {
    file,
    status: String(value.status),
    mutatorName: String(value.mutatorName),
    line: isRecord(start) ? Number(start.line) : NaN,
    isStatic: value.static === true,
    killedBy: value.killedBy,
    coveredBy: value.coveredBy,
  };
}

/** `[key, record[key][listKey]]` for each entry of a report section, with a
 *  missing or malformed list read as empty. */
function listsUnder(section: unknown, listKey: string): [string, unknown[]][] {
  if (!isRecord(section)) {
    return [];
  }
  return Object.entries(section).map(([key, entry]) => {
    const list = isRecord(entry) ? entry[listKey] : undefined;
    return [key, Array.isArray(list) ? list : []];
  });
}

async function readObserved(filePath: string): Promise<ObservedReport> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.files)) {
    throw new Error(`not a report: ${filePath}`);
  }
  const mutants = listsUnder(parsed.files, 'mutants').flatMap(([file, list]) =>
    list.map((mutant) => observedMutant(file, mutant)),
  );
  const tests = listsUnder(parsed.testFiles, 'tests').flatMap(([file, list]) =>
    list.filter((test) => isRecord(test)).map((test) => ({ file, test })),
  );
  return {
    mutants,
    testFileOf: new Map(tests.map(({ file, test }) => [String(test.id), file])),
    testKeys: tests.map(({ test }) =>
      Object.keys(test).toSorted((a, b) => a.localeCompare(b)),
    ),
  };
}

async function runStrykerIn(
  directory: string,
  extra: readonly string[] = [],
): Promise<string> {
  const result = await spawnExec(strykerBin, ['run', ...extra], {
    cwd: directory,
  });
  const diagnostic = `stryker exit ${result.code}\n${result.stdout}\n${result.stderr}`;
  expect(result.code, diagnostic).toBe(0);
  return diagnostic;
}

const cachePath = (directory: string): string =>
  path.join(directory, 'reports', 'stryker-incremental.json');
const reportPath = (directory: string): string =>
  path.join(directory, 'reports', 'mutation', 'mutation.json');

const survivorsIn = (report: ObservedReport, file: string): ObservedMutant[] =>
  report.mutants.filter(
    (mutant) => mutant.file === file && mutant.status === 'Survived',
  );

describe.skipIf(isUnderMutationRun(here))(
  'drift-guard: the facts the incremental-cache rewriter rests on',
  () => {
    it('resolves every killing test id to exactly one test file', async () => {
      const directory = await buildFixture();
      const diagnostic = await runStrykerIn(directory);
      const cache = await readObserved(cachePath(directory));

      const killed = cache.mutants.filter(
        (mutant) => mutant.status === 'Killed',
      );
      // The fixture's premise: both modules have kills to attribute.
      expect(new Set(killed.map((mutant) => mutant.file)), diagnostic).toEqual(
        new Set(MUTATED),
      );
      for (const mutant of killed) {
        expect(mutant.killedBy, diagnostic).toEqual([expect.any(String)]);
      }
      // Each kill resolves to the test file that exercises its module — the
      // mapping the rewriter's "was the killing test's file changed?" rule
      // reads. A test id appearing under two files would make it ambiguous.
      const killerFiles = new Set(
        killed.flatMap((mutant) =>
          Array.isArray(mutant.killedBy)
            ? mutant.killedBy.map((id) => cache.testFileOf.get(String(id)))
            : [],
        ),
      );
      expect(killerFiles).toEqual(new Set(['tier.test.ts', 'unit.test.ts']));
      expect(cache.testFileOf.size).toBe(cache.testKeys.length);
      // What a test records under the vitest runner: an id and a name. No
      // `location` and no per-test `file`, so the `testFiles` key is the only
      // source of a test's file.
      expect(cache.testKeys).toEqual([
        ['id', 'name'],
        ['id', 'name'],
      ]);
      // Survivors carry no `killedBy` and do carry `coveredBy` — the shape the
      // coverage rule (a cache with no `coveredBy` anywhere is rejected) reads.
      expect(survivorsIn(cache, 'src/tier.ts'), diagnostic).toEqual([
        expect.objectContaining({
          mutatorName: 'EqualityOperator',
          line: 2,
          isStatic: false,
          killedBy: undefined,
          coveredBy: [expect.any(String)],
        }),
      ]);
    }, 600_000);

    it('reuses a cached STATIC survivor after its killing test lands (stryker-js#6119)', async () => {
      const directory = await buildFixture();
      await runStrykerIn(directory);
      const first = await readObserved(cachePath(directory));
      // Static mutants record no per-test coverage: `coveredBy` is empty, which
      // is why stryker's differ has nothing to compare when the test changes.
      expect(survivorsIn(first, 'src/unit.ts')).toEqual([
        expect.objectContaining({
          mutatorName: 'StringLiteral',
          isStatic: true,
          coveredBy: [],
        }),
      ]);

      await writeFile(path.join(directory, 'unit.test.ts'), STRONG_UNIT_TEST);
      const diagnostic = await runStrykerIn(directory);
      expect(
        survivorsIn(await readObserved(reportPath(directory)), 'src/unit.ts'),
        'stryker re-tested a cached static survivor once its test changed. ' +
          'That is stryker-js#6119 FIXED upstream — welcome, but re-read ' +
          '`dropUntrusted`: its "always drop Survived" rule was written for ' +
          'this gap, and the gate may be paying for a re-run it no longer ' +
          'needs.\n' +
          diagnostic,
      ).toEqual([expect.objectContaining({ isStatic: true })]);
    }, 600_000);

    it('folds out-of-range cached verdicts back into a ranged run’s report', async () => {
      const directory = await buildFixture();
      await runStrykerIn(directory);
      const full = await readObserved(cachePath(directory));

      // Lines 3–5 hold the return literals; the cached survivor is on line 2,
      // outside the range, and `src/unit.ts` is outside it entirely.
      const diagnostic = await runStrykerIn(directory, [
        '--mutate',
        'src/tier.ts:3-5',
      ]);
      const ranged = await readObserved(reportPath(directory));
      expect(
        survivorsIn(ranged, 'src/tier.ts'),
        'a ranged run no longer reports the out-of-range cached survivor. ' +
          'Phase 2 filters verdicts by range on the premise that stryker ' +
          'does not; if it now does, that filter is redundant — re-check it.\n' +
          diagnostic,
      ).toEqual([expect.objectContaining({ line: 2, status: 'Survived' })]);
      expect(
        ranged.mutants.some((mutant) => mutant.file === 'src/unit.ts'),
      ).toBe(true);
      // And nothing was lost from the cache: every mutant of the full run is
      // still there for the next one.
      const rangedCache = await readObserved(cachePath(directory));
      expect(rangedCache.mutants).toHaveLength(full.mutants.length);
    }, 600_000);
  },
);
