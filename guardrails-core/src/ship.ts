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

import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
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

/**
Run gh in the repository being shipped.
*/
function gh(options: ShipOptions, args: string[]): Promise<ExecResult> {
  return options.exec('gh', args, { cwd: options.repoRoot });
}

/**
 * The branch's pull request, or `undefined` when gh names none. Read-only:
 * it never opens one.
 */
async function viewPullRequest(
  options: ShipOptions,
  branch: string,
): Promise<{ pr: PullRequest | undefined; result: ExecResult }> {
  const result = await gh(options, [
    'pr',
    'view',
    branch,
    '--json',
    'number,url',
  ]);
  return { pr: parsePullRequest(result.stdout), result };
}

/**
 * A failed push, still naming the pull request the branch already has: the
 * push failing does not make an open PR disappear (deferred from #122).
 */
async function pushFailure(
  options: ShipOptions,
  branch: string,
  pushed: ExecResult,
): Promise<Outcome> {
  const outcome = failure(classifyPushFailure(pushed), output(pushed));
  const { pr } = await viewPullRequest(options, branch);
  return pr === undefined
    ? outcome
    : { ...outcome, pr: pr.number, url: pr.url };
}

async function findOrOpenPullRequest(
  options: ShipOptions,
  branch: string,
): Promise<PullRequest | string> {
  const run = (command: string, args: string[]) =>
    options.exec(command, args, { cwd: options.repoRoot });
  const existing = await viewPullRequest(options, branch);
  if (existing.pr !== undefined) {
    return existing.pr;
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
  const opened = await viewPullRequest(options, branch);
  return opened.pr ?? output(opened.result);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The checks as `gh pr checks --json` lists them right now, with the listing's
 * text for the error tail. `checks` is `undefined` when the listing was
 * unreadable.
 */
async function readChecks(
  options: ShipOptions,
  number: string,
): Promise<{ checks: Check[] | undefined; listing: string }> {
  const listed = await gh(options, [
    'pr',
    'checks',
    number,
    '--json',
    'name,bucket',
  ]);
  // Before CI registers, gh does not print an empty list: it exits 1 with
  // this sentence on stderr. That is "none yet", not "unreadable".
  const checks = output(listed).includes(NO_CHECKS_YET)
    ? []
    : parseChecks(listed.stdout);
  return { checks, listing: output(listed) };
}

type Verdict = Omit<Outcome, 'pr' | 'url'>;

/**
 * What one watch-then-list round says, or `undefined` when it is too early to
 * say and the caller should wait and watch again. `canWait` is false once the
 * registration window has run out.
 */
function judgeChecks(
  checks: readonly Check[],
  watchText: string,
  canWait: boolean,
): Verdict | undefined {
  if (checks.length === 0) {
    return canWait
      ? undefined
      : { state: 'green', failing: [], tail: 'no checks reported' };
  }
  const tail = tailOf(watchText);
  const failing = checks
    .filter((check) => RED_BUCKETS.has(check.bucket))
    .map((check) => check.name);
  if (failing.length > 0) {
    return { state: 'ci-red', failing, tail };
  }
  const isSettled = checks.every((check) => check.bucket !== 'pending');
  // A watch that exited with "no checks reported" never watched: CI
  // registered between it and the listing. Pending then means "watch now",
  // not "the watch broke" -- the race seen on dialed.run #191.
  const isWatchEmpty = watchText.includes(NO_CHECKS_YET);
  if (!isSettled && isWatchEmpty && canWait) {
    return undefined;
  }
  return { state: isSettled ? 'green' : 'error', failing, tail };
}

async function watchChecks(
  options: ShipOptions,
  pr: PullRequest,
): Promise<Outcome> {
  const delay = options.delay ?? defaultDelay;
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
    const { checks, listing } = await readChecks(options, number);
    if (checks === undefined) {
      return { ...found, state: 'error', failing: [], tail: tailOf(listing) };
    }
    const verdict = judgeChecks(
      checks,
      output(watch),
      attempt < NO_CHECKS_RETRIES,
    );
    if (verdict !== undefined) {
      return { ...found, ...verdict };
    }
    await delay(NO_CHECKS_DELAY_MS);
  }
}

/**
 * Why `gh` cannot ship from here, or `undefined` when it can. Asked BEFORE the
 * push: everything after the push needs `gh`, and a branch pushed with no pull
 * request and no watch is a half-done ship that reports only a shell error.
 */
async function ghUnavailable(
  options: ShipOptions,
): Promise<string | undefined> {
  const auth = await options.exec('gh', ['auth', 'status'], {
    cwd: options.repoRoot,
  });
  if (auth.spawnFailed === true) {
    return (
      'guardrails ship: gh (GitHub CLI) is not installed, and ship needs it ' +
      'to open the pull request and watch its checks. Install it ' +
      '(https://cli.github.com), run `gh auth login`, then ship again. ' +
      'Nothing was pushed.'
    );
  }
  if (auth.code !== 0) {
    return (
      'guardrails ship: gh is not logged in. Run `gh auth login`, then ship ' +
      `again. Nothing was pushed.\n${output(auth)}`
    );
  }
  return undefined;
}

/**
 * Why the `--body-file` cannot be used, or `undefined` when it can (or none
 * was given). Asked BEFORE the push for the same reason as `ghUnavailable`:
 * `gh pr create` reads it only after the gate has run, and a missing file
 * then leaves a pushed branch with no pull request (dialed.run #194).
 */
function bodyFileUnreadable(options: ShipOptions): string | undefined {
  const { bodyFile } = options;
  if (bodyFile === undefined) {
    return undefined;
  }
  try {
    accessSync(bodyFile, constants.R_OK);
    return undefined;
  } catch {
    return (
      `guardrails ship: --body-file ${bodyFile} does not exist (or is not ` +
      'readable). Nothing was pushed.'
    );
  }
}

async function shipOutcome(
  options: ShipOptions,
  branch: string,
): Promise<Outcome> {
  const unavailable =
    (await ghUnavailable(options)) ?? bodyFileUnreadable(options);
  if (unavailable !== undefined) {
    return failure('error', unavailable);
  }
  const pushed = await options.exec('git', ['push', '-u', 'origin', 'HEAD'], {
    cwd: options.repoRoot,
  });
  if (pushed.code !== 0) {
    return pushFailure(options, branch, pushed);
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
