/**
 * `ship.preflight` (#243): cheap checks run before the push gate, by
 * `guardrails ship` and by the pre-push hook (`guardrails preflight
 * --mode=hook`).
 *
 * The push gate queues behind a machine-wide lock and can take most of an
 * hour. A repository's own cheap checks -- a build, a fast test run, a graph
 * check -- used to run in the hook AFTER it, so a red build was found only
 * once the lane had paid for the wait. Run first, a failure costs seconds.
 *
 * A pass is remembered by the tree it ran on, like the push gate's own pass
 * (`push-pass.json`), so the hook that ship's push fires -- and a ship retried
 * after a dropped connection -- skips commands that already passed on this
 * tree. The record is written only when the tree was the same before and
 * after the run: a command that edits files has not checked what it left.
 * It cannot see the environment, the network, or tools outside the
 * repository, so commands that depend on those do not belong here; CI stays
 * authoritative.
 */

import { createHash } from 'node:crypto';
import process from 'node:process';

import type { Exec, ExecResult } from './exec.js';
import {
  loadPreflightPass,
  type PreflightPass,
  savePreflightPass,
  stateDirectory,
} from './state-store.js';
import { fingerprintAgainstBase } from './tree-fingerprint.js';

export interface PreflightOptions {
  exec: Exec;
  repoRoot: string;
  /**
  The configured base branch; resolved as the push gate resolves it.
  */
  baseBranch: string;
  commands: readonly string[];
  /**
  The environment the commands run in.
  */
  env: NodeJS.ProcessEnv;
  /**
   * Skip the commands when the pass record covers this tree. Off for a
   * `guardrails preflight` run by hand, which always runs and refreshes it.
   */
  remember: boolean;
}

/**
 * How a preflight ended: every command passed, the record covered the tree,
 * there was nothing to run, a command failed, or a command reached no
 * verdict (killed, or never started).
 */
export type PreflightRun =
  | { verdict: 'passed' | 'remembered' | 'empty' }
  | { verdict: 'failed'; command: string; result: ExecResult }
  | { verdict: 'error'; command: string; result: ExecResult; why: string };

/**
 * What the pass record is keyed by: the tree fingerprint against the
 * resolved base, that base, the command list, and the Node that runs it.
 * `undefined` when the tree could not be fingerprinted, which means "no
 * record": the commands run and nothing is written.
 */
export async function preflightKey(
  options: Pick<
    PreflightOptions,
    'exec' | 'repoRoot' | 'baseBranch' | 'commands'
  >,
): Promise<PreflightPass | undefined> {
  const tree = await fingerprintAgainstBase(
    options.exec,
    options.repoRoot,
    options.baseBranch,
  );
  return tree === undefined
    ? undefined
    : {
        ...tree,
        commands: createHash('sha256')
          .update(JSON.stringify(options.commands))
          .digest('hex'),
        node: process.version,
      };
}

/**
Does the record on disk cover the key?
*/
export function isRememberedPreflight(
  key: PreflightPass | undefined,
  remembered: PreflightPass | undefined,
): boolean {
  return (
    key !== undefined &&
    remembered?.fingerprint === key.fingerprint &&
    remembered.base === key.base &&
    remembered.commands === key.commands &&
    remembered.node === key.node
  );
}

/**
 * What one command's run says: `undefined` to go on, or how the preflight
 * ends. The signal is read BEFORE the exit code: the exec seam reports a
 * killed child as exit 0, and a command that never finished must never read
 * as a pass.
 */
function preflightVerdict(
  command: string,
  result: ExecResult,
): PreflightRun | undefined {
  if (result.signal !== undefined) {
    return {
      verdict: 'error',
      command,
      result,
      why: `was ended by ${result.signal} before it finished`,
    };
  }
  if (result.spawnFailed === true) {
    return { verdict: 'error', command, result, why: 'could not be started' };
  }
  return result.code === 0 ? undefined : { verdict: 'failed', command, result };
}

/**
Run each command in order, stopping at the first that does not pass.
*/
async function runCommands(
  options: PreflightOptions,
): Promise<PreflightRun | undefined> {
  for (const command of options.commands) {
    const result = await options.exec('sh', ['-c', command], {
      cwd: options.repoRoot,
      env: options.env,
      input: '',
    });
    const verdict = preflightVerdict(command, result);
    if (verdict !== undefined) {
      return verdict;
    }
  }
  return undefined;
}

/**
 * Run the preflight commands, or skip them when the record covers this tree
 * and `remember` is on. An empty list runs nothing and asks git nothing.
 */
export async function runPreflight(
  options: PreflightOptions,
): Promise<PreflightRun> {
  if (options.commands.length === 0) {
    return { verdict: 'empty' };
  }
  const directory = stateDirectory(options.repoRoot);
  const key = await preflightKey(options);
  if (
    options.remember &&
    isRememberedPreflight(key, loadPreflightPass(directory))
  ) {
    return { verdict: 'remembered' };
  }
  const stopped = await runCommands(options);
  if (stopped !== undefined) {
    return stopped;
  }
  if (
    key !== undefined &&
    isRememberedPreflight(await preflightKey(options), key)
  ) {
    savePreflightPass(directory, key);
  }
  return { verdict: 'passed' };
}

/**
 * The start of the line `guardrails preflight` prints when it stops a push,
 * which ship reads back out of a failed push (`classifyPushFailure`).
 */
export const PREFLIGHT_FAILED_MARKER = 'guardrails: push stopped — preflight';

export function preflightFailedLine(command: string): string {
  return `${PREFLIGHT_FAILED_MARKER} "${command}" failed`;
}

const FAILED_LINE_END = '" failed';

/**
The command a `preflightFailedLine` names, or `undefined` for any other line.
*/
export function preflightFailedCommand(line: string): string | undefined {
  const start = `${PREFLIGHT_FAILED_MARKER} "`;
  return line.startsWith(start) && line.endsWith(FAILED_LINE_END)
    ? line.slice(start.length, -FAILED_LINE_END.length)
    : undefined;
}
