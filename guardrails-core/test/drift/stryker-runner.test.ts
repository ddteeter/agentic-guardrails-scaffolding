/**
 * Drift guard for the mutation RUNNER, not for its output text.
 *
 * `stryker-banner.test.ts` proves we still read stryker's instrumenter banner
 * correctly. This one proves something the banner cannot: that the configured
 * test runner still KILLS a mutant a test genuinely catches.
 *
 * The failure this exists for is silent and inverted. On vitest 5,
 * `@stryker-mutator/vitest-runner`'s per-test filter matches nothing
 * (stryker-js#6210 — vitest changed `testNamePattern` to join the name chain
 * with `' > '`), so every mutant run executes zero tests and every covered
 * mutant comes back `Survived`. The mutation gate then MANUFACTURES violations
 * instead of missing them, and no other test in this repo notices, because
 * every one of them feeds the adapter a hand-written report.
 *
 * So this runs REAL stryker through the vitest runner — the one
 * `adopting-guardrails` tells consumers to use — over code whose single test
 * kills every mutant, and asserts we read kills back. It is the only test here
 * that would have failed on a `vitest@5` bump, and it is deliberately slow.
 *
 * The fixture is written to a temp directory at run time rather than checked in
 * next to this file, for the same reason the banner guard does it: a fixture
 * inside the repository gets copied into stryker's sandbox when the repo runs
 * its OWN mutation pass, and the nested run cannot resolve a test runner plugin
 * from there. `node_modules` is symlinked in so vitest and the runner plugin
 * resolve normally.
 *
 * Both halves of the assertion matter. `unrunSurvivedMutants` catches the
 * broken-runner shape; `parseStrykerJson` returning `[]` catches a runner that
 * reported nothing at all, which would satisfy the first check vacuously.
 */

import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import {
  parseStrykerJson,
  unrunSurvivedMutants,
} from '../../src/verify/stryker-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');

/** How stryker names the mutated file in its report — relative to the run's
 *  cwd, which is the fixture directory. */
const MUTATED = ['src/tier.ts'];

const TIER_SOURCE = `export function tier(spend: number): string {
  if (spend >= 1000) {
    return 'gold';
  }
  if (spend >= 100) {
    return 'silver';
  }
  return 'bronze';
}
`;

/** Asserts both sides of every boundary, so every mutant stryker generates on
 *  `tier` is genuinely killable. A weaker test here would make the guard pass
 *  for the wrong reason. */
const TIER_TEST = `import { describe, expect, it } from 'vitest';

import { tier } from './src/tier.js';

describe('tier', () => {
  it('pins every boundary, so every mutant is killable', () => {
    expect(tier(1000)).toBe('gold');
    expect(tier(999)).toBe('silver');
    expect(tier(100)).toBe('silver');
    expect(tier(99)).toBe('bronze');
    expect(tier(0)).toBe('bronze');
  });
});
`;

async function buildFixture(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'guardrails-stryker-runner-'),
  );
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await writeFile(path.join(directory, 'src', 'tier.ts'), TIER_SOURCE);
  await writeFile(path.join(directory, 'tier.test.ts'), TIER_TEST);
  await writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'stryker-runner-fixture', private: true, type: 'module' }, undefined, 2)}\n`,
  );
  await writeFile(
    path.join(directory, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n`,
  );
  // No `incremental`: a cached verdict would let this guard pass on a runner
  // that has since broken.
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

describe('drift-guard: stryker vitest runner', () => {
  it('still kills the mutants the fixture tests genuinely catch', async () => {
    const directory = await buildFixture();
    const result = await spawnExec(strykerBin, ['run'], { cwd: directory });
    const report = await readFile(
      path.join(directory, 'reports', 'mutation', 'mutation.json'),
      'utf8',
    );

    const diagnostic =
      'stryker’s vitest runner stopped killing mutants that its own ' +
      'tests catch. This is the stryker-js#6210 shape: the mutation gate ' +
      'now MANUFACTURES violations, so every covered mutant in a consumer ' +
      'repo is reported as survived. Check the installed vitest major ' +
      'against @stryker-mutator/vitest-runner before releasing.\n' +
      `stryker exit ${result.code}\n${result.stdout}\n${result.stderr}`;

    expect(result.code, diagnostic).toBe(0);
    // The invariant `unrunSurvivedMutants` encodes, asserted against a real
    // runner rather than a hand-written report: non-zero here means the runner
    // executed no tests, whatever its verdicts claim.
    expect(unrunSurvivedMutants(report, MUTATED), diagnostic).toBe(0);
    // The positive half: these tests kill every mutant, so a working runner
    // leaves nothing for us to raise. Without this, a runner that reported no
    // mutants at all would satisfy the check above vacuously.
    expect(parseStrykerJson(report, MUTATED), diagnostic).toEqual([]);
  }, 300_000);
});
