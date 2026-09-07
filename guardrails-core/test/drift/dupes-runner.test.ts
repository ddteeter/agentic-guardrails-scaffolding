/**
 * Drift guard for the clone DETECTOR, not for its rule id.
 *
 * `registry.test.ts` proves `fallow/code-duplication` still exists upstream and
 * is still a free rule. This one proves what an id check cannot: that fallow,
 * driven by the config `guardrails init` actually seeds, still FINDS a
 * cross-file clone and still reports it in the JSON shape the adapter reads.
 *
 * That is the third failure mode CLAUDE.md names — an analyzer that still runs,
 * still exits 0, and still reports, wrongly. Every other test of this analyzer
 * feeds the adapter a hand-written report, so a fallow upgrade that changed its
 * tokenizer, renamed `clone_groups`, or quietly stopped matching across files
 * would leave the whole suite green and the gate blind. It is not hypothetical
 * for this class of tool: issue #40 documents jscpd 5 silently turning
 * `--mode strict` into a no-op on TypeScript by swapping its lexer.
 *
 * The fixture is the SEEDED config, deliberately. Pinning the detector against
 * `FALLOW_SEED` means an upgrade that makes those exact values stop finding an
 * obvious clone — a raised default `minTokens`, a renamed `semantic` mode —
 * fails here rather than in an adopter's repo.
 *
 * Written to a temp directory at run time rather than checked in, like the
 * stryker guards: a clone fixture inside this repository would be found by the
 * repo's own `fallow dupes` run, and by knip, eslint and tsc besides.
 *
 * Both halves of the scoping assertion matter. The positive case proves the
 * detector works; the negative case proves the diff filter is what suppressed
 * the finding — and it is checked against the SAME stdout, so a fallow that
 * found nothing at all cannot satisfy it vacuously.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import { FALLOW_SEED } from '../../src/scaffold/seeds.js';
import { parseFallowDupesJson } from '../../src/verify/fallow-adapter.js';
import { isUnderMutationRun } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fallowBin = path.join(repoRoot, 'node_modules', '.bin', 'fallow');

/**
 * The clone, in two files, with the parameter renamed between them. Renaming is
 * the point: it is what an agent does when it copies a helper into a second
 * module, and it is exactly what `sonarjs/no-identical-functions` would miss
 * even if ESLint could see across files. Comfortably over the seed's
 * `minTokens: 50` and `minLines: 5`, so the guard fails on a real regression
 * rather than on a threshold it sits next to.
 */
function guardSource(parameter: string): string {
  return `export function requireUserId(${parameter}: {
  userId?: string;
  expiresAt?: number;
}): string {
  if (${parameter}.expiresAt !== undefined && ${parameter}.expiresAt < Date.now()) {
    throw new Error('session expired');
  }
  const { userId } = ${parameter};
  if (userId === undefined || userId === '') {
    throw new Error('unauthenticated');
  }
  return userId;
}
`;
}

/**
A file with no clone in it, used as the negative control's changed set.
*/
const UNRELATED_SOURCE = `export const RETRY_LIMIT = 3;\n`;

async function buildFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'guardrails-dupes-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'dupes-probe', version: '1.0.0', type: 'module' }, undefined, 2)}\n`,
  );
  // The config `guardrails init` seeds, verbatim -- see this file's header.
  await writeFile(path.join(root, '.fallowrc.jsonc'), FALLOW_SEED);
  await writeFile(path.join(root, 'src', 'session.ts'), guardSource('session'));
  await writeFile(path.join(root, 'src', 'request.ts'), guardSource('request'));
  await writeFile(path.join(root, 'src', 'limits.ts'), UNRELATED_SOURCE);
  return root;
}

describe.skipIf(isUnderMutationRun(here))('fallow dupes runner', () => {
  it('still finds a renamed cross-file clone through the seeded config', async () => {
    const root = await buildFixture();
    const result = await spawnExec(
      fallowBin,
      ['dupes', '--format', 'json', '--quiet'],
      { cwd: root },
    );

    const reported = parseFallowDupesJson(result.stdout, [
      'src/session.ts',
      'src/request.ts',
    ]);

    // Both sides of the pair, which is what makes one violation actionable.
    expect(
      reported
        .map((violation) => violation.file)
        .toSorted((a, b) => a.localeCompare(b)),
      `fallow reported no cross-file clone. stdout: ${result.stdout.slice(0, 500)}`,
    ).toEqual(['src/request.ts', 'src/session.ts']);
    expect(reported[0]?.ruleId).toBe('fallow/code-duplication');

    // Same stdout, different changed set: the finding must disappear because
    // the diff filter dropped it, not because fallow found nothing. Asserting
    // this against the SAME report is what makes it non-vacuous.
    expect(parseFallowDupesJson(result.stdout, ['src/limits.ts'])).toEqual([]);
  }, 60_000);
});
