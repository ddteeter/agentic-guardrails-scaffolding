/**
 * Run one guardrails command against a fixture the way a consumer's hook
 * does: `runCommand` from the CLI, real `spawnExec`, real analyzers.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { runCommand } from '../../src/cli-core.js';
import { type Exec, spawnExec } from '../../src/exec.js';
import { cleanEnvironment } from './fixture.js';
import { normalise } from './normalise.js';

export interface ParityOutcome {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  /**
   * Every violations manifest the command left in the state directory, by
   * file name. The printed lines do not carry a violation's package, related
   * tests or guidance; the manifest a fixer is pointed at does.
   */
  manifests: Record<string, unknown>;
}

/**
The four commands a golden holds, each as the argv a hook would pass.
*/
export const PARITY_COMMANDS: readonly (readonly string[])[] = [
  ['gate', '--mode=commit'],
  ['gate', '--mode=push'],
  ['gate', '--mode=ci'],
  ['verify'],
];

export function commandKey(argv: readonly string[]): string {
  return argv.join(' ');
}

function lines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

const MANIFEST_SUFFIX = '.last.json';

function readManifests(root: string): Record<string, unknown> {
  const directory = path.join(root, '.guardrails', 'state');
  if (!existsSync(directory)) {
    return {};
  }
  return Object.fromEntries(
    readdirSync(directory)
      .filter((file) => file.endsWith(MANIFEST_SUFFIX))
      .toSorted((left, right) => left.localeCompare(right))
      .map((file) => [
        file,
        JSON.parse(
          normalise(readFileSync(path.join(directory, file), 'utf8'), [root]),
        ) as unknown,
      ]),
  );
}

export async function runParityCommand(
  root: string,
  argv: readonly string[],
): Promise<ParityOutcome> {
  let stdout = '';
  let stderr = '';
  // A call that passes its own environment keeps it: the gate points git at
  // a private index through GIT_INDEX_FILE.
  const exec: Exec = (command, args, options) =>
    spawnExec(command, args, {
      ...options,
      env: options?.env ?? cleanEnvironment(),
    });
  const [command, ...rest] = argv;
  const exitCode = await runCommand(command, rest, {
    exec,
    readStdin: () => Promise.resolve(''),
    cwd: root,
    // Inside the fixture, as an installed copy would be.
    selfPath: path.join(root, 'node_modules', 'guardrails-core', 'cli.mjs'),
    env: cleanEnvironment(),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return {
    exitCode,
    stdout: lines(normalise(stdout, [root])),
    stderr: lines(normalise(stderr, [root])),
    manifests: readManifests(root),
  };
}
