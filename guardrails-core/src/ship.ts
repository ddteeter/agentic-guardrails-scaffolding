/**
 * `guardrails ship`: push the branch, find or open its pull request, wait for
 * its checks, and write down how it went -- as ONE command an agent can run
 * with `run_in_background` and be woken by once.
 *
 * The three waits this replaces were the expensive part of shipping. The
 * pre-push gate queues behind a machine-wide lock and can take most of an hour;
 * CI takes as long again. An agent that watched either in the foreground woke
 * every ten minutes on the tool timeout and re-paid its whole context each time
 * (see `foreground-wait.ts`). Backgrounded as one command, it is woken once,
 * reads one status file, and acts on one of five states.
 *
 * Every git and gh call goes through the injected `Exec`, so the outcome
 * classification is tested without a network.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Exec, ExecResult } from './exec.js';
import { isRecord } from './is-record.js';
import { parseJsonText } from './json-file.js';

type ShipState = 'green' | 'gate-blocked' | 'lock-timeout' | 'ci-red' | 'error';

export interface ShipStatus {
  state: ShipState;
  branch: string;
  pr: number | null;
  url: string | null;
  /**
  The checks that failed or were cancelled, on `ci-red`.
  */
  failing: string[];
  /**
  The last lines of the output that decided the state.
  */
  tail: string;
  finishedAt: string;
}

export interface ShipOptions {
  exec: Exec;
  repoRoot: string;
  /**
  The branch a new pull request targets.
  */
  baseBranch: string;
  /**
  A pull request body to open with; otherwise `gh pr create --fill`.
  */
  bodyFile?: string | undefined;
  now?: () => Date;
  /**
  Waits between looks for checks that have not registered; a seam for tests.
  */
  delay?: (ms: number) => Promise<void>;
}

/**
 * What the scaffolded pre-push hook prints when it gave up waiting for the
 * machine-wide gate lock. Exported so the template and this classifier are
 * pinned to one string by a test, not by memory.
 */
export const LOCK_TIMEOUT_MARKER =
  'guardrails: gave up waiting for the gate lock';

/**
 * What the scaffolded pre-push hook prints when guardrails-core is missing
 * from the checkout. It shares the push-blocked prefix, but no gate ran: the
 * fix is `npm ci`, not a code change, so it is reported as an error.
 */
export const NOT_INSTALLED_MARKER =
  'guardrails-core is not installed in this checkout';

/**
What the scaffolded hooks print when the gate itself blocked the push.
*/
const GATE_BLOCK_MARKER = 'guardrails: push blocked';

const TAIL_LINES = 40;

/**
 * How long a freshly pushed pull request may show no checks before "none" is
 * believed: CI registers its checks a few seconds after the push, and a watch
 * started before that reports nothing to wait for.
 */
const NO_CHECKS_RETRIES = 8;
const NO_CHECKS_YET = 'no checks reported';
const NO_CHECKS_DELAY_MS = 15_000;

function output(result: ExecResult): string {
  return [result.stdout, result.stderr]
    .filter((text) => text.trim() !== '')
    .join('\n');
}

function tailOf(text: string): string {
  return text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}

/**
 * Why a push failed, from what the hook printed. A lock timeout is checked
 * first: the hook that timed out also says the push was blocked. An
 * uninstalled checkout says so too, but no gate ran, so it is an error.
 */
export function classifyPushFailure(
  result: ExecResult,
): 'gate-blocked' | 'lock-timeout' | 'error' {
  const text = output(result);
  if (text.includes(LOCK_TIMEOUT_MARKER)) {
    return 'lock-timeout';
  }
  if (text.includes(NOT_INSTALLED_MARKER)) {
    return 'error';
  }
  return text.includes(GATE_BLOCK_MARKER) ? 'gate-blocked' : 'error';
}

interface PullRequest {
  number: number;
  url: string;
}

function parsePullRequest(text: string): PullRequest | undefined {
  const { parsed } = parseJsonText(text);
  return isRecord(parsed) &&
    typeof parsed.number === 'number' &&
    typeof parsed.url === 'string'
    ? { number: parsed.number, url: parsed.url }
    : undefined;
}

interface Check {
  name: string;
  bucket: string;
}

/**
 * The checks `gh pr checks --json name,bucket` printed, or `undefined` when
 * it printed no list. A malformed row is dropped, not trusted.
 */
function parseChecks(text: string): Check[] | undefined {
  const { parsed } = parseJsonText(text);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.flatMap((row: unknown) =>
    isRecord(row) &&
    typeof row.name === 'string' &&
    typeof row.bucket === 'string'
      ? [{ name: row.name, bucket: row.bucket }]
      : [],
  );
}

/**
`gh pr checks` buckets that mean the check did not pass.
*/
const RED_BUCKETS: ReadonlySet<string> = new Set(['fail', 'cancel']);

type Outcome = Omit<ShipStatus, 'branch' | 'finishedAt'>;

function failure(state: ShipState, tail: string): Outcome {
  return { state, pr: null, url: null, failing: [], tail: tailOf(tail) };
}

async function findOrOpenPullRequest(
  options: ShipOptions,
  branch: string,
): Promise<PullRequest | string> {
  const run = (command: string, args: string[]) =>
    options.exec(command, args, { cwd: options.repoRoot });
  const viewArguments = ['pr', 'view', branch, '--json', 'number,url'];
  const viewed = await run('gh', viewArguments);
  const existing = parsePullRequest(viewed.stdout);
  if (existing !== undefined) {
    return existing;
  }
  let body = ['--fill'];
  if (options.bodyFile !== undefined) {
    const lastCommit = await run('git', ['log', '-1', '--format=%s']);
    const title = lastCommit.stdout.trim();
    body = ['--title', title, '--body-file', options.bodyFile];
  }
  const created = await run('gh', [
    'pr',
    'create',
    '--base',
    options.baseBranch,
    ...body,
  ]);
  if (created.code !== 0) {
    return output(created);
  }
  const opened = await run('gh', viewArguments);
  return parsePullRequest(opened.stdout) ?? output(opened);
}

async function watchChecks(
  options: ShipOptions,
  pr: PullRequest,
): Promise<Outcome> {
  const delay =
    options.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const number = String(pr.number);
  const found = { pr: pr.number, url: pr.url };
  for (let attempt = 0; ; attempt += 1) {
    const watch = await options.exec(
      'gh',
      ['pr', 'checks', number, '--watch'],
      {
        cwd: options.repoRoot,
      },
    );
    const listed = await options.exec(
      'gh',
      ['pr', 'checks', number, '--json', 'name,bucket'],
      { cwd: options.repoRoot },
    );
    // Before CI registers, gh does not print an empty list: it exits 1 with
    // this sentence on stderr. That is "none yet", not "unreadable".
    const checks = output(listed).includes(NO_CHECKS_YET)
      ? []
      : parseChecks(listed.stdout);
    const tail = tailOf(output(watch));
    if (checks === undefined) {
      return {
        ...found,
        state: 'error',
        failing: [],
        tail: tailOf(output(listed)),
      };
    }
    if (checks.length === 0 && attempt < NO_CHECKS_RETRIES) {
      await delay(NO_CHECKS_DELAY_MS);
      continue;
    }
    if (checks.length === 0) {
      return {
        ...found,
        state: 'green',
        failing: [],
        tail: 'no checks reported',
      };
    }
    const failing = checks
      .filter((check) => RED_BUCKETS.has(check.bucket))
      .map((check) => check.name);
    if (failing.length > 0) {
      return { ...found, state: 'ci-red', failing, tail };
    }
    const isSettled = checks.every((check) => check.bucket !== 'pending');
    return { ...found, state: isSettled ? 'green' : 'error', failing, tail };
  }
}

async function shipOutcome(
  options: ShipOptions,
  branch: string,
): Promise<Outcome> {
  const pushed = await options.exec('git', ['push', '-u', 'origin', 'HEAD'], {
    cwd: options.repoRoot,
  });
  if (pushed.code !== 0) {
    return failure(classifyPushFailure(pushed), output(pushed));
  }
  const pr = await findOrOpenPullRequest(options, branch);
  return typeof pr === 'string'
    ? failure('error', pr)
    : watchChecks(options, pr);
}

/**
Ship the current branch, and say how it went.
*/
export async function ship(options: ShipOptions): Promise<ShipStatus> {
  const head = await options.exec(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    {
      cwd: options.repoRoot,
    },
  );
  const branch = head.stdout.trim();
  // A detached HEAD has no branch to open a pull request from, and shipping
  // the base branch would push straight to it.
  const isShippable =
    branch !== 'HEAD' && branch !== options.baseBranch && head.code === 0;
  const outcome = isShippable
    ? await shipOutcome(options, branch)
    : failure(
        'error',
        `guardrails ship: not on a branch that can be shipped (HEAD is ` +
          `${branch || 'unknown'}; base is ${options.baseBranch}).\n` +
          output(head),
      );
  return {
    ...outcome,
    branch,
    finishedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function writeShipStatus(file: string, status: ShipStatus): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`);
}

/**
The one line `guardrails ship` prints, for the agent woken by its exit.
*/
export function shipSummary(status: ShipStatus, statusPath: string): string {
  const pr =
    status.pr === null ? 'no PR' : `PR #${status.pr} ${status.url ?? ''}`;
  const failing =
    status.failing.length > 0 ? `; failing: ${status.failing.join(', ')}` : '';
  return (
    `guardrails ship: ${status.state} — ${status.branch}, ${pr}${failing} ` +
    `(status: ${statusPath})`
  );
}
