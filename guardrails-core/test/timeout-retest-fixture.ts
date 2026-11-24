/**
 * A repo whose stryker run leaves one timed-out mutant no test is named as
 * killing, for the tests that pin `mutationTimeouts.retestLimit`'s wiring
 * (#202). Stryker is faked by `timeoutFixtureExec`, which writes that report
 * on every run and counts the runs: two under the default limit (the run and
 * its re-test), one when the limit is 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Exec, ExecResult } from '../src/exec.js';

export function writeTimeoutFixture(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'loop.ts'), 'const a = 1;\n');
}

const REPORT = JSON.stringify({
  schemaVersion: '1.0',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/loop.ts': {
      language: 'typescript',
      source: 'const a = 1;\n',
      mutants: [
        {
          id: '0',
          mutatorName: 'UpdateOperator',
          replacement: 'index--',
          status: 'Timeout',
          coveredBy: ['0'],
          location: {
            start: { line: 1, column: 1 },
            end: { line: 1, column: 8 },
          },
        },
      ],
    },
  },
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/**
A git and stryker stand-in, and how many stryker runs it saw.
*/
export function timeoutFixtureExec(root: string): {
  exec: Exec;
  strykerRuns: () => number;
} {
  let runs = 0;
  const exec: Exec = (_command, args) => {
    if (args.includes('--name-only')) {
      return Promise.resolve(ok('src/loop.ts\n'));
    }
    if (args.includes('--mutate')) {
      runs += 1;
      mkdirSync(path.join(root, 'reports', 'mutation'), { recursive: true });
      writeFileSync(
        path.join(root, 'reports', 'mutation', 'mutation.json'),
        REPORT,
      );
    }
    return Promise.resolve(ok(''));
  };
  return { exec, strykerRuns: () => runs };
}
