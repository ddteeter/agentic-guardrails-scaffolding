/**
 * A repo with one line changed in a 300-line file, for the tests that pin
 * `mutationScope`'s wiring. Stryker is faked by `rangeFixtureExec`, which
 * records the `--mutate` argument the gate handed it, so a test can tell a
 * ranged run (`src/big.ts:145-155`) from a whole-file one (`src/big.ts`).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Exec, ExecResult } from '../src/exec.js';

export function writeRangeFixture(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'big.ts'), 'const a = 1;\n'.repeat(300));
}

const HUNK = [
  'diff --git a/src/big.ts b/src/big.ts',
  '--- a/src/big.ts',
  '+++ b/src/big.ts',
  '@@ -150 +150 @@',
].join('\n');

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/**
A git and stryker stand-in, and the `--mutate` arguments stryker was given.
*/
export function rangeFixtureExec(): { exec: Exec; mutated: string[] } {
  const mutated: string[] = [];
  const exec: Exec = (command, args) => {
    if (args.includes('--name-only')) {
      return Promise.resolve(ok('src/big.ts\n'));
    }
    if (args.includes('--unified=0')) {
      return Promise.resolve(ok(HUNK));
    }
    const mutate = args.indexOf('--mutate');
    if (mutate !== -1) {
      mutated.push(args[mutate + 1] ?? '');
    }
    return Promise.resolve(ok(''));
  };
  return { exec, mutated };
}

/**
What stryker mutates in each shape.
*/
export const RANGED = 'src/big.ts:145-155';
export const WHOLE = 'src/big.ts';
