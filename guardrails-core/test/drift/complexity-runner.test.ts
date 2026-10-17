/**
 * Drift guard for the complexity MEASUREMENT, not for its rule ids.
 *
 * `registry.test.ts` proves the three `fallow/high-*-complexity` ids still
 * exist upstream and are still free. This one proves what an id check cannot:
 * that real `fallow health --complexity` still flags an over-threshold
 * function, still exits 1 when it does, and still prints the JSON shape
 * `parseFallowHealthJson` reads — `findings[].exceeded` and the thresholds in
 * `summary`. Every other test of this analyzer feeds the adapter a hand-written
 * report, so a fallow upgrade that renamed a field would leave the suite green
 * and the gate reading every tree as clean. That is the third failure mode
 * CLAUDE.md names.
 *
 * No fallow config is written: the fixture runs on fallow's own default
 * thresholds (cyclomatic 20, cognitive 15), which is what an adopter who
 * never tuned them gets.
 *
 * Built in a temp directory at run time, like `dupes-runner.test.ts`: an
 * over-threshold function checked into this repository would be found by the
 * repo's own `fallow health`, and by eslint's sonarjs rules besides.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import { parseFallowHealthJson } from '../../src/verify/fallow-adapter.js';
import { isUnderMutationRun } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fallowBin = path.join(repoRoot, 'node_modules', '.bin', 'fallow');

/**
 * Nested loops and branches, well past cognitive 15 (nesting is what
 * cognitive complexity charges for), so the guard fails on a real regression
 * rather than on a threshold it sits next to.
 */
const TANGLED_SOURCE = `export function tangled(rows: number[][], limit: number): number {
  let total = 0;
  for (const row of rows) {
    if (row.length > 0) {
      for (const cell of row) {
        if (cell > limit) {
          if (cell % 2 === 0) {
            total += cell;
          } else if (cell % 3 === 0) {
            total -= cell;
          } else {
            while (total > limit) {
              total = total > 0 && cell > 0 ? total - 1 : total + 1;
            }
          }
        } else if (cell < 0 || cell === limit) {
          total = 0;
        }
      }
    }
  }
  return total;
}
`;

const SIMPLE_SOURCE = `export function double(value: number): number {
  return value * 2;
}
`;

async function buildFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'guardrails-complexity-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'complexity-probe', version: '1.0.0', type: 'module', main: 'src/index.ts' }, undefined, 2)}\n`,
  );
  await writeFile(path.join(root, 'src', 'tangled.ts'), TANGLED_SOURCE);
  await writeFile(path.join(root, 'src', 'simple.ts'), SIMPLE_SOURCE);
  await writeFile(
    path.join(root, 'src', 'index.ts'),
    `export { tangled } from './tangled.js';\nexport { double } from './simple.js';\n`,
  );
  return root;
}

describe.skipIf(isUnderMutationRun(here))('fallow health runner', () => {
  it('still flags an over-threshold function, and only that one', async () => {
    const root = await buildFixture();
    const result = await spawnExec(
      fallowBin,
      ['health', '--complexity', '--format', 'json', '--quiet'],
      { cwd: root },
    );

    const { violations, isReport } = parseFallowHealthJson(result.stdout, [
      'src/tangled.ts',
      'src/simple.ts',
      'src/index.ts',
    ]);

    expect(
      isReport,
      `fallow health printed no report. stdout: ${result.stdout.slice(0, 500)}`,
    ).toBe(true);
    // Exit 1 on findings is what runComplexity's report check is built on.
    expect(result.code).toBe(1);
    expect(violations.map((violation) => violation.file)).toEqual([
      'src/tangled.ts',
    ]);
    expect(violations[0]?.ruleId).toMatch(/^fallow\/high-.*complexity$/u);
    expect(violations[0]?.message).toContain('`tangled`');
  }, 60_000);
});
