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
import { LOCK_TIMEOUT_MARKER } from './mutation-lock.js';

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
  /**
  What went wrong without changing the outcome -- attachments that were not
  posted. Always present, empty when nothing did.
  */
  warnings: string[];
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
  /**
  Push with `--force-with-lease`, for a branch rewritten since its last push.
  */
  forceWithLease?: boolean | undefined;
  /**
  Media to attach to the pull request, each `<file>[#<alt text>]` as gh takes
  it: on a new PR through `gh pr create`, on an open one as a comment.
  */
  attach?: readonly string[] | undefined;
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

/**
 * One row of a gh listing: a check and its bucket from `gh pr checks`, or a
 * workflow and its conclusion from `gh run list`.
 */
interface Listed {
  name: string;
  outcome: string;
}

/**
 * The rows of a `gh ... --json <name>,<outcome>` listing, or `undefined` when
 * gh printed no list. A malformed row is dropped, not trusted.
 */
function parseRows(
  text: string,
  name: string,
  outcome: string,
): Listed[] | undefined {
  const { parsed } = parseJsonText(text);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.flatMap((row: unknown): Listed[] => {
    const fields = isRecord(row) ? row : {};
    const named = fields[name];
    const ended = fields[outcome];
    return typeof named === 'string' && typeof ended === 'string'
      ? [{ name: named, outcome: ended }]
      : [];
  });
}

/**
`gh pr checks` buckets that mean the check did not pass.
*/
const RED_BUCKETS: ReadonlySet<string> = new Set(['fail', 'cancel']);

/**
 * Workflow run conclusions that mean the run did not pass. `startup_failure`
 * is why runs are read at all: a workflow that fails to start creates no
 * check runs, so `gh pr checks` shows nothing wrong (#172).
 */
const RED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'startup_failure',
  'failure',
  'timed_out',
  'cancelled',
]);

/**
What CI says about the pushed commit, from every place ship reads it.
*/
interface Evidence {
  checks: readonly Listed[];
  runs: readonly Listed[];
  /**
  The names of the checks the base branch requires.
  */
  required: readonly string[];
}

type Outcome = Omit<ShipStatus, 'branch' | 'finishedAt' | 'warnings'>;

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
 * git's refusal of a push that would drop commits the remote has: the branch
 * was rebased or amended since it was last pushed, or someone else pushed.
 */
const REWRITTEN_BRANCH =
  /\[rejected\][^\n]*\((?:non-fast-forward|stale info|fetch first)\)/;

const REWRITTEN_BRANCH_HINT =
  'guardrails ship: the branch was rewritten since its last push ' +
  '(rebased?); re-run with --force-with-lease';

/**
 * A failed push's output, with the fix appended when git refused it as a
 * rewrite: ship never forces on its own, so the agent has to be told how.
 */
function pushFailureText(pushed: ExecResult): string {
  const text = output(pushed);
  return REWRITTEN_BRANCH.test(text)
    ? `${text}\n${REWRITTEN_BRANCH_HINT}`
    : text;
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
  const outcome = failure(classifyPushFailure(pushed), pushFailureText(pushed));
  const { pr } = await viewPullRequest(options, branch);
  return pr === undefined
    ? outcome
    : { ...outcome, pr: pr.number, url: pr.url };
}

interface FoundPullRequest {
  pr: PullRequest;
  warnings: string[];
}

/**
 * The warning for attachments gh did not post: its last line of output, which
 * is where gh says what failed, on one line so the summary stays one line.
 */
function attachWarning(result: ExecResult): string {
  const last = output(result).trimEnd().split('\n').at(-1) ?? '';
  return `attachments not posted: ${last}`;
}

function attachArguments(options: ShipOptions): string[] {
  return (options.attach ?? []).flatMap((file) => ['--attach', file]);
}

/**
 * Post the attachments on a pull request that was already open. A failure is
 * a warning: the push happened and CI still decides the outcome.
 */
async function commentAttachments(
  options: ShipOptions,
  pr: PullRequest,
): Promise<string[]> {
  const attach = attachArguments(options);
  if (attach.length === 0) {
    return [];
  }
  const commented = await gh(options, [
    'pr',
    'comment',
    String(pr.number),
    ...attach,
  ]);
  return commented.code === 0 ? [] : [attachWarning(commented)];
}

async function findOrOpenPullRequest(
  options: ShipOptions,
  branch: string,
): Promise<FoundPullRequest | string> {
  const run = (command: string, args: string[]) =>
    options.exec(command, args, { cwd: options.repoRoot });
  const existing = await viewPullRequest(options, branch);
  if (existing.pr !== undefined) {
    return {
      pr: existing.pr,
      warnings: await commentAttachments(options, existing.pr),
    };
  }
  let body = ['--fill'];
  if (options.bodyFile !== undefined) {
    const lastCommit = await run('git', ['log', '-1', '--format=%s']);
    const title = lastCommit.stdout.trim();
    body = ['--title', title, '--body-file', options.bodyFile];
  }
  const attach = attachArguments(options);
  const created = await run('gh', [
    'pr',
    'create',
    '--base',
    options.baseBranch,
    ...body,
    ...attach,
  ]);
  // gh still opens the PR when an upload fails, and says so with a failing
  // exit, so with attachments a failed create is only an error once the PR
  // is not there to read back.
  if (created.code !== 0 && attach.length === 0) {
    return output(created);
  }
  const opened = await viewPullRequest(options, branch);
  if (opened.pr === undefined) {
    return output(created.code === 0 ? opened.result : created);
  }
  return {
    pr: opened.pr,
    warnings: created.code === 0 ? [] : [attachWarning(created)],
  };
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
): Promise<{ checks: Listed[] | undefined; listing: string }> {
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
    : parseRows(listed.stdout, 'name', 'bucket');
  return { checks, listing: output(listed) };
}

/**
 * The workflow runs on the pushed commit, with the listing's text for the
 * error tail. `runs` is `undefined` when the listing was unreadable.
 */
async function readRuns(
  options: ShipOptions,
  sha: string,
): Promise<{ runs: Listed[] | undefined; listing: string }> {
  const listed = await gh(options, [
    'run',
    'list',
    '--commit',
    sha,
    '--json',
    'workflowName,conclusion',
  ]);
  return {
    runs: parseRows(listed.stdout, 'workflowName', 'conclusion'),
    listing: output(listed),
  };
}

/**
The repository being shipped, as gh fills it in for `gh api`.
*/
const REPOSITORY_API = 'repos/{owner}/{repo}';

/**
 * Where the base branch's required check names are, each a path under the
 * repository and the jq filter that prints one name per line: rulesets, then
 * classic branch protection. A repository may use either.
 */
const REQUIRED_CHECK_SOURCES: readonly (readonly [string, string])[] = [
  [
    'rules/branches',
    '.[] | select(.type == "required_status_checks") | ' +
      '.parameters.required_status_checks[].context',
  ],
  ['branches', '.protection.required_status_checks.contexts[]?'],
];

/**
 * The names of the checks the base branch requires. A source gh could not
 * read requires nothing: a token may lack access to it, and ship then judges
 * by the checks and runs it can see.
 */
async function requiredChecks(options: ShipOptions): Promise<string[]> {
  const answers = await Promise.all(
    REQUIRED_CHECK_SOURCES.map(([source, filter]) =>
      gh(options, [
        'api',
        [REPOSITORY_API, source, options.baseBranch].join('/'),
        '--jq',
        filter,
      ]),
    ),
  );
  return answers
    .filter((answer) => answer.code === 0)
    .flatMap((answer) => answer.stdout.split('\n'))
    .filter((name) => name !== '');
}

type Verdict = Omit<Outcome, 'pr' | 'url'>;

/**
The red checks by name, then the red runs by workflow and conclusion.
*/
function failingOf(evidence: Evidence): string[] {
  return [
    ...evidence.checks
      .filter((check) => RED_BUCKETS.has(check.outcome))
      .map((check) => check.name),
    ...evidence.runs
      .filter((run) => RED_CONCLUSIONS.has(run.outcome))
      .map((run) => `${run.name} (${run.outcome})`),
  ];
}

/**
The required checks that no check run reported for.
*/
function unreportedOf(evidence: Evidence): string[] {
  const reported = new Set(evidence.checks.map((check) => check.name));
  return evidence.required
    .filter((name) => !reported.has(name))
    .map((name) => `${name} (required, not reported)`);
}

/**
 * What one watch-then-list round says, or `undefined` when it is too early to
 * say and the caller should wait and watch again. `canWait` is false once the
 * registration window has run out.
 */
function judgeChecks(
  evidence: Evidence,
  watchText: string,
  canWait: boolean,
): Verdict | undefined {
  const { checks } = evidence;
  const tail = tailOf(watchText);
  const failing = failingOf(evidence);
  if (failing.length > 0) {
    return { state: 'ci-red', failing, tail };
  }
  const unreported = unreportedOf(evidence);
  if (unreported.length > 0) {
    return canWait ? undefined : { state: 'ci-red', failing: unreported, tail };
  }
  if (checks.length === 0) {
    return canWait
      ? undefined
      : { state: 'green', failing: [], tail: 'no checks reported' };
  }
  const isSettled = checks.every((check) => check.outcome !== 'pending');
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
  const head = await options.exec('git', ['rev-parse', 'HEAD'], {
    cwd: options.repoRoot,
  });
  const required = await requiredChecks(options);
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
    const listed = await readRuns(options, head.stdout.trim());
    if (listed.runs === undefined) {
      return {
        ...found,
        state: 'error',
        failing: [],
        tail: tailOf(listed.listing),
      };
    }
    const verdict = judgeChecks(
      { checks, runs: listed.runs, required },
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
): Promise<Outcome & { warnings: string[] }> {
  const unavailable =
    (await ghUnavailable(options)) ?? bodyFileUnreadable(options);
  if (unavailable !== undefined) {
    return { ...failure('error', unavailable), warnings: [] };
  }
  const force = options.forceWithLease === true ? ['--force-with-lease'] : [];
  const pushed = await options.exec(
    'git',
    ['push', ...force, '-u', 'origin', 'HEAD'],
    { cwd: options.repoRoot },
  );
  if (pushed.code !== 0) {
    return { ...(await pushFailure(options, branch, pushed)), warnings: [] };
  }
  const found = await findOrOpenPullRequest(options, branch);
  if (typeof found === 'string') {
    return { ...failure('error', found), warnings: [] };
  }
  return {
    ...(await watchChecks(options, found.pr)),
    warnings: found.warnings,
  };
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
    : {
        warnings: [],
        ...failure(
          'error',
          `guardrails ship: not on a branch that can be shipped (HEAD is ` +
            `${branch || 'unknown'}; base is ${options.baseBranch}).\n` +
            output(head),
        ),
      };
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
  const warnings = status.warnings
    .map((warning) => `; warning: ${warning}`)
    .join('');
  return (
    `guardrails ship: ${status.state} — ${status.branch}, ${pr}${failing}${warnings} ` +
    `(status: ${statusPath})`
  );
}

export { LOCK_TIMEOUT_MARKER } from './mutation-lock.js';
