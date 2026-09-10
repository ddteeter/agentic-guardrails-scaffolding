/**
 * Drift guard for stryker's INCREMENTAL REUSE semantics.
 *
 * `runStryker` now keeps stryker's incremental cache whenever
 * `canReuseIncrementalCache` says the cache proves itself (#59). That
 * predicate rests on two things this repo does not control, and which no
 * hand-written report can test:
 *
 * 1. A real `@stryker-mutator/vitest-runner` cache records `coveredBy`, so the
 *    predicate's coverage rule can ever answer `true`. If it stopped, reuse
 *    would silently switch off for every consumer and the flag would go back to
 *    being the no-op #59 reported — a performance regression nothing else here
 *    would notice.
 * 2. Stryker re-runs a cached `Survived` mutant once the test covering it
 *    changes. This is the load-bearing one: if it stopped, a cached survivor
 *    would outlive the very test written to kill it, the fixer loop could never
 *    go green, and the gate would report a violation that no longer exists.
 *
 * So this runs REAL stryker twice over a fixture whose expected verdicts are
 * known: once with an under-asserting test that leaves exactly one survivor,
 * then again — cache kept, exactly as the gate keeps it — with that test
 * strengthened. The survivor must come back killed, and the untouched second
 * module's results must come back reused.
 *
 * Fixture written to a temp directory at run time, and skipped under this
 * repo's own mutation pass, for the reasons `stryker-runner.test.ts` gives.
 */

import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import {
  canReuseIncrementalCache,
  parseStrykerJson,
} from '../../src/verify/stryker-adapter.js';
import { isUnderMutationRun } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');

/** Both mutated files, named as stryker reports them: relative to the run's
 *  cwd, which is the fixture directory. */
const MUTATED = ['src/tier.ts', 'src/label.ts'];

/** The `>=` boundary is the whole fixture: `EqualityOperator` mutates it to
 *  `>`, which only a test asserting the boundary VALUE itself can kill. */
const TIER_SOURCE = `export function tier(spend: number): string {
  if (spend >= 1000) {
    return 'gold';
  }
  return 'bronze';
}
`;

/** Covers every line and kills every mutant except the `>=` → `>` boundary:
 *  1000 itself is never asserted, so that one survives. */
const WEAK_TIER_TEST = `import { describe, expect, it } from 'vitest';

import { tier } from './src/tier.js';

describe('tier', () => {
  it('names the tiers either side of the boundary', () => {
    expect(tier(2000)).toBe('gold');
    expect(tier(0)).toBe('bronze');
  });
});
`;

/** The fix a fixer would write: the boundary value itself, which kills the
 *  surviving mutant. Production code is untouched, so the cached verdict is
 *  overturned only if stryker re-runs the mutant on the strengthened test. */
const STRONG_TIER_TEST = `import { describe, expect, it } from 'vitest';

import { tier } from './src/tier.js';

describe('tier', () => {
  it('names the tiers either side of the boundary, and the boundary', () => {
    expect(tier(2000)).toBe('gold');
    expect(tier(1000)).toBe('gold');
    expect(tier(0)).toBe('bronze');
  });
});
`;

/** A second module, fully killed and never edited between the two runs. Its
 *  results are what the second run has left to REUSE — without it, editing the
 *  only test file would invalidate everything and the reuse count would be
 *  zero for an honest reason, making that half of the guard vacuous. */
const LABEL_SOURCE = `export function label(count: number): string {
  return count === 1 ? 'item' : 'items';
}
`;

const LABEL_TEST = `import { describe, expect, it } from 'vitest';

import { label } from './src/label.js';

describe('label', () => {
  it('pins both branches and both literals', () => {
    expect(label(1)).toBe('item');
    expect(label(0)).toBe('items');
    expect(label(2)).toBe('items');
  });
});
`;

/** Stryker's incremental summary, e.g. `3 of 11 mutant result(s) are reused.`
 *  Hardcoded upstream text, and asserting on it is the point: this file IS the
 *  drift guard, so a reworded summary failing here is the loud notice that the
 *  reuse this feature depends on can no longer be observed. */
const REUSE_SUMMARY = /(\d{1,9}) of \d{1,9} mutant result\(s\) are reused/;

async function buildFixture(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'guardrails-stryker-incremental-'),
  );
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await writeFile(path.join(directory, 'src', 'tier.ts'), TIER_SOURCE);
  await writeFile(path.join(directory, 'src', 'label.ts'), LABEL_SOURCE);
  await writeFile(path.join(directory, 'tier.test.ts'), WEAK_TIER_TEST);
  await writeFile(path.join(directory, 'label.test.ts'), LABEL_TEST);
  await writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'stryker-incremental-fixture', private: true, type: 'module' }, undefined, 2)}\n`,
  );
  await writeFile(
    path.join(directory, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n`,
  );
  await writeFile(
    path.join(directory, 'stryker.conf.json'),
    `${JSON.stringify(
      {
        testRunner: 'vitest',
        plugins: ['@stryker-mutator/vitest-runner'],
        reporters: ['json'],
        vitest: { configFile: 'vitest.config.ts' },
        mutate: MUTATED,
        coverageAnalysis: 'perTest',
        incremental: true,
      },
      undefined,
      2,
    )}\n`,
  );
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    'dir',
  );
  return directory;
}

describe.skipIf(isUnderMutationRun(here))(
  'drift-guard: stryker incremental reuse',
  () => {
    it('re-runs a cached survivor once its covering test is strengthened', async () => {
      const directory = await buildFixture();
      const readReport = () =>
        readFile(
          path.join(directory, 'reports', 'mutation', 'mutation.json'),
          'utf8',
        );

      const first = await spawnExec(strykerBin, ['run'], { cwd: directory });
      const firstDiagnostic = `stryker exit ${first.code}\n${first.stdout}\n${first.stderr}`;
      expect(first.code, firstDiagnostic).toBe(0);
      // The fixture's premise: one survivor, at the boundary the weak test
      // never asserts. A different count means the fixture stopped exercising
      // what the rest of this test claims to prove.
      const firstViolations = parseStrykerJson(await readReport(), MUTATED);
      expect(firstViolations, firstDiagnostic).toEqual([
        expect.objectContaining({
          ruleId: 'stryker/survived',
          file: 'src/tier.ts',
        }),
      ]);

      // Half one: a real vitest-runner cache satisfies the gate's own predicate.
      // If this fails, `runStryker` deletes the cache on every run and
      // `--incremental` is the no-op #59 reported.
      const cache = await readFile(
        path.join(directory, 'reports', 'stryker-incremental.json'),
        'utf8',
      );
      expect(
        canReuseIncrementalCache(cache, MUTATED),
        'a real stryker cache no longer records the per-test coverage that ' +
          'makes reuse safe, so guardrails will now take a cold mutation run ' +
          'on every gate. Check the runner plugin against the installed ' +
          'stryker before releasing.',
      ).toBe(true);

      // Strengthen the covering test, exactly as a fixer would. The cache is
      // left in place, exactly as `discardUnusableIncrementalCache` leaves it.
      await writeFile(path.join(directory, 'tier.test.ts'), STRONG_TIER_TEST);
      const second = await spawnExec(strykerBin, ['run'], { cwd: directory });
      const secondDiagnostic = `stryker exit ${second.code}\n${second.stdout}\n${second.stderr}`;
      expect(second.code, secondDiagnostic).toBe(0);

      // Half two, the load-bearing one: the cached `Survived` verdict did not
      // outlive the test written to kill it.
      expect(
        parseStrykerJson(await readReport(), MUTATED),
        'stryker reused a cached survivor whose covering test changed. A ' +
          'fixer could no longer clear that mutant, so the guardrail loop ' +
          'would never go green — reuse must be switched off (delete the ' +
          'incremental cache unconditionally) until this is understood.',
      ).toEqual([]);

      // And the run genuinely reused something, so the first half is not
      // passing on a cache stryker quietly ignored.
      const reused = Number(
        REUSE_SUMMARY.exec(`${second.stdout}\n${second.stderr}`)?.[1] ?? '0',
      );
      expect(reused, secondDiagnostic).toBeGreaterThan(0);
    }, 600_000);
  },
);
