/**
 * Drift guard for the one piece of stryker OUTPUT TEXT guardrails parses.
 *
 * `isZeroMutantRun` reads stryker's instrumenter banner to decide that
 * a change set had nothing to mutate — the reading that keeps a commit touching
 * only interfaces or a barrel of re-exports from being blocked as a crashed
 * analyzer. The banner is upstream-owned prose, so a stryker upgrade can change
 * it silently, and the failure mode is invisible: the excuse stops applying,
 * every zero-mutant change set starts failing the commit gate again, and
 * nothing says why.
 *
 * The rest of the registry probes id EXISTENCE against schemas and configs.
 * This one cannot: there is no schema for a log line. So it runs real stryker
 * over a real zero-mutant file and asserts guardrails still reads a zero out of
 * what comes back.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import {
  instrumentedMutantCount,
  isZeroMutantRun,
} from '../../src/verify/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');

/**
 * The `command` runner is deliberate. The framework runners are what THROW on a
 * zero-mutant run, and that throw is the symptom; the banner is the signal, and
 * it prints either way. Probing it through the runner that does not throw keeps
 * this test about the text guardrails parses, and keeps it fast.
 */
async function strykerOutputForZeroMutants(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'guardrails-stryker-banner-'),
  );
  await writeFile(
    path.join(directory, 'types.ts'),
    'export interface Probe { readonly id: string }\n',
  );
  await writeFile(
    path.join(directory, 'stryker.conf.json'),
    JSON.stringify({
      testRunner: 'command',
      commandRunner: { command: 'node --eval ""' },
      reporters: ['json'],
    }),
  );
  const result = await spawnExec(
    strykerBin,
    ['run', '--reporters', 'json', '--mutate', 'types.ts'],
    { cwd: directory },
  );
  return `${result.stdout}\n${result.stderr}`;
}

describe('drift-guard: stryker instrumenter banner', () => {
  it('still reports a mutant count guardrails can read as zero', async () => {
    const output = await strykerOutputForZeroMutants();
    expect(
      isZeroMutantRun(output),
      'stryker changed the instrumenter banner that `isZeroMutantRun` ' +
        '(guardrails-core/src/verify/index.ts) parses. Until it is reconciled, ' +
        'every change set with nothing to mutate fails the commit gate as a ' +
        'crashed analyzer. Output was:\n' +
        output,
    ).toBe(true);
  }, 60_000);

  it('does not read a zero out of a run that DID instrument mutants', () => {
    // The guard is only worth anything if the count is actually being read.
    // A banner match that ignored the number would pass the test above and
    // silently excuse every genuine dry-run failure.
    const output =
      'INFO Instrumenter Instrumented 3 source file(s) with 16 mutant(s)';
    expect(isZeroMutantRun(output)).toBe(false);
  });

  it('reads the MUTANT count, not the file count', () => {
    // Both numbers are on the same line. A pattern that captured the first one
    // would call every single-file run zero-mutant — which is most runs — and
    // excuse a genuinely broken test suite on all of them.
    expect(
      isZeroMutantRun('Instrumented 0 source file(s) with 4 mutant(s)'),
    ).toBe(false);
    expect(
      isZeroMutantRun('Instrumented 4 source file(s) with 0 mutant(s)'),
    ).toBe(true);
  });

  it('fails closed on output that carries no banner at all', () => {
    // The excuse must require positive evidence. An unrecognised crash — a heap
    // limit, a killed process, a reworked banner — has to stay a failed
    // analyzer, never a clean gate.
    expect(isZeroMutantRun('')).toBe(false);
    expect(isZeroMutantRun('FATAL ERROR: Reached heap limit\nAborted')).toBe(
      false,
    );
    expect(isZeroMutantRun('with 0 mutant(s)')).toBe(false);
    expect(isZeroMutantRun('Instrumented source files')).toBe(false);
  });

  it('reads a multi-digit mutant count', () => {
    // Pins the `+` on the mutant group. Without it the pattern cannot match a
    // two-digit count at all, and every such run falls through to "no banner" —
    // which reads the same as zero-mutants=false, so the boolean alone can
    // never see the difference. The count can.
    expect(
      instrumentedMutantCount(
        'Instrumented 3 source file(s) with 16 mutant(s)',
      ),
    ).toBe(16);
  });

  it('reads past a multi-digit FILE count to the mutant count', () => {
    // Pins the `+` on the file group, which is the more dangerous of the two:
    // a repo whose change set touches ten or more files would stop matching
    // entirely, and every one of those runs would lose the zero-mutant excuse.
    expect(
      instrumentedMutantCount(
        'Instrumented 12 source file(s) with 0 mutant(s)',
      ),
    ).toBe(0);
    expect(
      isZeroMutantRun('Instrumented 12 source file(s) with 0 mutant(s)'),
    ).toBe(true);
  });

  it('answers undefined for output with no banner', () => {
    expect(
      instrumentedMutantCount('FATAL ERROR: Reached heap limit'),
    ).toBeUndefined();
  });
});
