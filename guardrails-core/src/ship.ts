import { randomUUID } from 'node:crypto';
/**
 * `guardrails ship`: push the branch, find or open its pull request, wait for
 * its checks, and write down how it went -- as ONE command an agent can run
 * with `run_in_background` and be woken by once.
 *
 * The three waits this replaces were the expensive part of shipping. The
 * push gate queues behind a machine-wide lock and can take most of an hour;
 * CI takes as long again. An agent that watched either in the foreground woke
 * every ten minutes on the tool timeout and re-paid its whole context each time
 * (see `foreground-wait.ts`). Backgrounded as one command, it is woken once,
 * reads one status file, and acts on one of five states.
 *
 * ship runs the push gate itself, before `git push` (#204). Run from inside
 * the pre-push hook, the gate's wait for the lock held the push's connection
 * open, and a remote that closed it as idle turned a gate verdict into a
 * transport error. Now the gate waits with no connection open, its exit
 * decides the outcome, and the hook's own gate finds this tree's pass record
 * and returns at once. No marker or variable tells the hook to skip: any
 * miss -- the tree changed, the base moved -- runs the full gate in the hook,
 * as before.
 *
 * Every git and gh call goes through the injected `Exec`, so the outcome
 * classification is tested without a network.
 */

import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { Exec, ExecResult } from './exec.js';
import { isRecord } from './is-record.js';
import { parseJsonText } from './json-file.js';
import {
  logShipRun,
  projectName,
  type RunClock,
  startRun,
} from './gate-run-log.js';
import { LOCK_TIMEOUT_EXIT, LOCK_TIMEOUT_MARKER } from './mutation-lock.js';
import {
  PREFLIGHT_FAILED_MARKER,
  preflightFailedCommand,
  type PreflightRun,
  runPreflight,
} from './preflight.js';
import {
  splitTitleLine,
  titleTypeMismatch,
  type TypeMismatch,
} from './pr-title.js';

type ShipState =
  | 'green'
  | 'gate-blocked'
  | 'preflight-failed'
  | 'lock-timeout'
  | 'ci-red'
  | 'behind'
  | 'conflicting'
  | 'error';

export interface ShipStatus {
  state: ShipState;
  branch: string;
  pr: number | null;
  url: string | null;
  /**
  The checks that failed or were cancelled, on `ci-red`; the files that
  conflict with the base, on `conflicting`; the command that failed, on
  `preflight-failed`.
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
  /**
  What to do next, on `ci-red`; `null` in every other state.
  */
  diagnosis: Diagnosis | null;
}

/**
 * What can be done about a `ci-red`, from evidence only. Whether a failure
 * is flaky is never guessed: ship says only whether the base moved since the
 * commit was tested, and which workflow runs have failed jobs to re-run.
 */
interface Diagnosis {
  /**
  Whether the pushed commit still contains `origin/<base>`, asked after CI.
  */
  base: 'contains' | 'moved' | 'unknown';
  /**
  The `gh run list` ids of the runs `--rerun-failed` would re-run.
  */
  rerunnable: number[];
  advice: 'rebase' | 'rerun-failed' | 'fix';
  /**
  The advice as one line, for the summary.
  */
  next: string;
}

/**
How to run the push gate: a command and its arguments.
*/
export interface PushGate {
  command: string;
  args: readonly string[];
}

export interface ShipOptions {
  exec: Exec;
  repoRoot: string;
  /**
  The push gate exactly as the pre-push hook runs it, which ship runs itself
  before `git push` so the hook finds this tree's pass and returns at once
  (#204).
  */
  pushGate: PushGate;
  /**
  The branch a new pull request targets.
  */
  baseBranch: string;
  /**
  A pull request body to open with; otherwise `gh pr create --fill`.
  */
  bodyFile?: string | undefined;
  /**
  The title a new pull request opens with. Otherwise the body file's leading
  `# <title>` line, else the last commit's subject (#175).
  */
  title?: string | undefined;
  /**
  Push with `--force-with-lease`, for a branch rewritten since its last push.
  */
  forceWithLease?: boolean | undefined;
  /**
  Push nothing: re-run the failed jobs of the pushed commit's red runs, then
  wait for them as a ship waits for CI.
  */
  rerunFailed?: boolean | undefined;
  /**
  Media to attach to the pull request, each `<file>[#<alt text>]` as gh takes
  it: on a new PR through `gh pr create`, on an open one as a comment.
  */
  attach?: readonly string[] | undefined;
  /**
   * `ship.preflight` (#243): commands run before the push gate, each from the
   * repository root, stopping at the first to fail. `baseBranch` is the
   * configured one, which the pre-push hook's `guardrails preflight` keys its
   * pass record by too; `warnings` are the entries the config dropped.
   */
  preflight?:
    | {
        commands: readonly string[];
        baseBranch: string;
        warnings: readonly string[];
      }
    | undefined;
  now?: () => Date;
  /**
  Waits between looks for checks that have not registered; a seam for tests.
  */
  delay?: (ms: number) => Promise<void>;
  /**
  The gate lock's path; the ship's row goes in the run log beside it (#176).
  */
  lockPath?: string | undefined;
  /**
  This ship's id in the run log; a fresh one by default.
  */
  shipId?: string;
  runClock?: RunClock;
}

/**
When ship pushed and watched CI, epoch milliseconds, for its run-log row.
*/
interface ShipTimes {
  pushMs?: number;
  ciMs?: number;
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
 * Why a push failed, from what the hook printed. ship's own gate has passed
 * by the time it pushes, so this is reached only when the hook's gate missed
 * that pass and ran in full (or when git failed for another reason). A lock
 * timeout is checked first: the hook that timed out also says the push was
 * blocked. An uninstalled checkout says so too, but no gate ran, so it is an
 * error.
 *
 * Only the hook's own last `push blocked` line says whether the checkout was
 * uninstalled (#178). The gate's output runs the project's tests, and text
 * from anywhere in it once turned a gate block into an `error`.
 */
export function classifyPushFailure(
  result: ExecResult,
): 'gate-blocked' | 'preflight-failed' | 'lock-timeout' | 'error' {
  const text = output(result);
  if (text.includes(LOCK_TIMEOUT_MARKER)) {
    return 'lock-timeout';
  }
  const verdict = text
    .split('\n')
    .findLast(
      (line) =>
        line.startsWith(GATE_BLOCK_MARKER) ||
        line.startsWith(PREFLIGHT_FAILED_MARKER),
    );
  if (verdict === undefined || verdict.includes(NOT_INSTALLED_MARKER)) {
    return 'error';
  }
  return verdict.startsWith(PREFLIGHT_FAILED_MARKER)
    ? 'preflight-failed'
    : 'gate-blocked';
}

/**
 * A preflight-failed outcome read out of a failed push's `text`: the hook's
 * `guardrails preflight` named the command it stopped on (#243).
 */
function hookPreflightFailed(text: string): Outcome {
  const command = text
    .split('\n')
    .map((line) => preflightFailedCommand(line))
    .findLast((named) => named !== undefined);
  return {
    ...failure('preflight-failed', text),
    failing: command === undefined ? [] : [command],
  };
}

/**
 * The lines a blocked gate prints for what blocked it (`printGateDetail`): a
 * violation, `<file>:<line> [<rule>] <message> (<tool>)`, and an added
 * suppression, `<file>:<line> added <kind>: <text>`. Anchored, with classes
 * that cannot overlap the separators after them, so a match never
 * backtracks.
 */
const VIOLATION_LINE = /^([^\s:]+):(\d+|\?) \[([^\]\s]+)\](?: |$)/;
const SUPPRESSION_LINE = /^([^\s:]+):(\d+) added ([^\s:]+):/;

/**
One line of the gate's output as an entry of `failing`, when it is one.
*/
function gateFailure(line: string): string[] {
  const violation = VIOLATION_LINE.exec(line);
  if (violation !== null) {
    const [, file = '', at = '', rule = ''] = violation;
    return [`${file}:${at} ${rule}`];
  }
  const suppression = SUPPRESSION_LINE.exec(line);
  if (suppression !== null) {
    const [, file = '', at = '', kind = ''] = suppression;
    return [`${file}:${at} added ${kind}`];
  }
  return [];
}

/**
 * What a blocked gate printed as blocking it, each `<file>:<line> <rule>` or
 * `<file>:<line> added <kind>`, in the order it printed them.
 */
export function gateFailures(text: string): string[] {
  return text.split('\n').flatMap((line) => gateFailure(line));
}

/**
A gate-blocked outcome, with what blocked it read out of `text`.
*/
function gateBlocked(text: string): Outcome {
  return { ...failure('gate-blocked', text), failing: gateFailures(text) };
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
 * One row of `gh pr checks`, with the name of the workflow whose run it is
 * part of: `''` for a check no workflow ran, or a gh too old to say.
 */
interface Check extends Listed {
  workflow: string;
}

/**
 * The rows of a `gh pr checks --json name,bucket[,workflow]` listing, or
 * `undefined` when gh printed no list. A malformed row is dropped, not
 * trusted.
 */
export function parseChecks(text: string): Check[] | undefined {
  const { parsed } = parseJsonText(text);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.flatMap((row: unknown): Check[] => {
    const fields = isRecord(row) ? row : {};
    const { name, bucket, workflow } = fields;
    return typeof name === 'string' && typeof bucket === 'string'
      ? [
          {
            name,
            outcome: bucket,
            workflow: typeof workflow === 'string' ? workflow : '',
          },
        ]
      : [];
  });
}

/**
 * One row of `gh run list`: a workflow run, the event that started it, its
 * id, which grows with each run, whether it is still going, and which attempt
 * it is on. A re-run keeps the id and bumps the attempt.
 */
interface Run extends Listed {
  event: string;
  id: number;
  status: string;
  attempt: number;
}

/**
A `gh run list` row with every field ship reads, each of the right type.
*/
function isRunRow(row: unknown): row is {
  workflowName: string;
  conclusion: string;
  event: string;
  databaseId: number;
  status: string;
  attempt: number;
} {
  return (
    isRecord(row) &&
    typeof row.workflowName === 'string' &&
    typeof row.conclusion === 'string' &&
    typeof row.event === 'string' &&
    typeof row.databaseId === 'number' &&
    typeof row.status === 'string' &&
    typeof row.attempt === 'number'
  );
}

function runKey(run: Run): string {
  return `${run.name}\n${run.event}`;
}

/**
 * The latest run of each workflow and event, in listed order (#199). A
 * re-triggered workflow leaves its older run on the commit, and the newer run
 * is the one that says how the workflow went: an older failure under a newer
 * pending run is not red. A malformed row is dropped, not trusted.
 */
function parseRuns(text: string): Run[] | undefined {
  const { parsed } = parseJsonText(text);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const rows: Run[] = parsed.filter(isRunRow).map((row) => ({
    name: row.workflowName,
    outcome: row.conclusion,
    event: row.event,
    id: row.databaseId,
    status: row.status,
    attempt: row.attempt,
  }));
  const latest = new Map<string, number>();
  for (const run of rows) {
    const key = runKey(run);
    latest.set(key, Math.max(latest.get(key) ?? 0, run.id));
  }
  return rows.filter((run) => latest.get(runKey(run)) === run.id);
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
  checks: readonly Check[];
  runs: readonly Run[];
  /**
  The names of the checks the base branch requires.
  */
  required: readonly string[];
}

/**
What the checks and runs of the pushed commit say, without the required list.
*/
type Listing = Omit<Evidence, 'required'>;

type Outcome = Omit<
  ShipStatus,
  'branch' | 'finishedAt' | 'warnings' | 'diagnosis'
>;

/**
An outcome with what was warned on the way, and the diagnosis of a `ci-red`.
*/
type Finished = Outcome & {
  warnings: string[];
  diagnosis: Diagnosis | null;
};

/**
An outcome reached before CI said anything: no warnings, nothing to diagnose.
*/
function stopped(outcome: Outcome): Finished {
  return { ...outcome, warnings: [], diagnosis: null };
}

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
 * How a connection to a remote reads when it drops, from ssh, git or the
 * transport under them. No host is named: a remote can be anywhere.
 */
const TRANSPORT_FAILURE =
  /Connection (?:to \S+ )?closed by|Connection reset by peer|Connection timed out|the remote end hung up unexpectedly|Broken pipe/;

const TRANSPORT_HINT =
  'guardrails ship: the push gate passed, but the connection to the remote ' +
  'dropped during the push. Ship again: the pass is remembered, so the ' +
  'gate returns at once.';

/**
 * What to tell the agent about a failed push, when there is something: git
 * refused it as a rewrite (ship never forces on its own), or the connection
 * dropped after the gate passed. A block is not a dropped connection, even
 * when the remote closed it while the hook's gate ran.
 */
function pushHint(text: string, state: ShipState): string | undefined {
  if (REWRITTEN_BRANCH.test(text)) {
    return REWRITTEN_BRANCH_HINT;
  }
  return state === 'error' && TRANSPORT_FAILURE.test(text)
    ? TRANSPORT_HINT
    : undefined;
}

/**
A failed push's output, with its hint appended when it has one.
*/
function pushFailureText(pushed: ExecResult, state: ShipState): string {
  const text = output(pushed);
  const hint = pushHint(text, state);
  return hint === undefined ? text : `${text}\n${hint}`;
}

/**
 * An outcome that stopped the ship before anything was pushed, still naming
 * the pull request the branch already has: a blocked gate or a failed push
 * does not make an open PR disappear (deferred from #122).
 */
async function withExistingPullRequest(
  options: ShipOptions,
  branch: string,
  outcome: Outcome,
): Promise<Outcome> {
  const { pr } = await viewPullRequest(options, branch);
  return pr === undefined
    ? outcome
    : { ...outcome, pr: pr.number, url: pr.url };
}

/**
A failed push, with the pull request the branch already has.
*/
function pushFailure(
  options: ShipOptions,
  branch: string,
  pushed: ExecResult,
): Promise<Outcome> {
  const state = classifyPushFailure(pushed);
  const text = pushFailureText(pushed, state);
  return withExistingPullRequest(options, branch, pushOutcome(state, text));
}

/**
A failed push's outcome, with what failed read out of its text.
*/
function pushOutcome(state: ShipState, text: string): Outcome {
  if (state === 'gate-blocked') {
    return gateBlocked(text);
  }
  return state === 'preflight-failed'
    ? hookPreflightFailed(text)
    : failure(state, text);
}

/**
The environment a ship's gate runs in, push hook included.
*/
function gateEnvironment(options: ShipOptions): NodeJS.ProcessEnv {
  // The gate stamps this id on its run-log row, which is how this ship finds
  // its gate's time afterwards (#176). A label only: nothing reads it to
  // decide whether to gate.
  return { ...process.env, GUARDRAILS_SHIP_ID: shipIdOf(options) };
}

/**
 * Run the push gate the way the pre-push hook does, from the repository
 * root. It takes the machine-wide lock while no connection to the remote is
 * open, which is the point (#204).
 */
function runPushGate(options: ShipOptions): Promise<ExecResult> {
  return options.exec(options.pushGate.command, [...options.pushGate.args], {
    cwd: options.repoRoot,
    env: gateEnvironment(options),
  });
}

const NOTHING_PUSHED = 'Nothing was pushed.';

/**
 * What the push gate's run says about pushing: `undefined` to push, or the
 * outcome to stop on. The signal is read BEFORE the exit code: the exec seam
 * reports a killed child as exit 0, and a gate that never reached a verdict
 * must never read as a pass.
 */
function gateVerdict(gated: ExecResult): Outcome | undefined {
  const text = output(gated);
  if (gated.signal !== undefined) {
    return failure(
      'error',
      `${text}\nguardrails ship: the push gate was ended by ${gated.signal} ` +
        `before it reached a verdict. ${NOTHING_PUSHED}`,
    );
  }
  if (gated.spawnFailed === true) {
    return failure(
      'error',
      `${text}\nguardrails ship: the push gate could not be started. ` +
        NOTHING_PUSHED,
    );
  }
  if (gated.code === 0) {
    return undefined;
  }
  if (gated.code === LOCK_TIMEOUT_EXIT) {
    return failure('lock-timeout', text);
  }
  if (gated.code === 1) {
    return gateBlocked(text);
  }
  return failure(
    'error',
    `${text}\nguardrails ship: the push gate exited ` +
      `${String(gated.code)}, which is neither a pass nor a block. ` +
      NOTHING_PUSHED,
  );
}

/**
 * The outcome to stop on when HEAD is no longer `sha` after the gate, or
 * `undefined` when it still is. The gate checked one commit; pushing another
 * would push what it never checked.
 */
async function headMoved(
  options: ShipOptions,
  sha: string,
): Promise<Outcome | undefined> {
  const now = await headCommit(options);
  if (typeof now !== 'string') {
    return now;
  }
  return now === sha
    ? undefined
    : failure(
        'error',
        `guardrails ship: HEAD moved from ${sha} to ${now} while preflight ` +
          `or the push gate ran, so they did not check what would be ` +
          `pushed. Ship again. ${NOTHING_PUSHED}`,
      );
}

const PREFLIGHT_STOPPED = 'Nothing was pushed; the gate did not run.';

/**
 * What a preflight run says about going on to the gate: `undefined` to go
 * on, or the outcome to stop on. A command that exited non-zero is
 * `preflight-failed`; one that reached no verdict is an `error`.
 */
function preflightOutcome(run: PreflightRun): Outcome | undefined {
  if (run.verdict === 'failed') {
    const { command, result } = run;
    return {
      ...failure(
        'preflight-failed',
        `${output(result)}\nguardrails ship: preflight "${command}" exited ` +
          `${String(result.code)}. ${PREFLIGHT_STOPPED}`,
      ),
      failing: [command],
    };
  }
  if (run.verdict === 'error') {
    return failure(
      'error',
      `${output(run.result)}\nguardrails ship: preflight "${run.command}" ` +
        `${run.why}. ${PREFLIGHT_STOPPED}`,
    );
  }
  return undefined;
}

/**
 * Run `ship.preflight` before the gate (#243): `undefined` to go on to the
 * gate, or the outcome to stop on. Nothing configured asks nothing. A pass
 * is followed by the HEAD check, so a command that commits cannot lead into
 * a gate of another commit.
 */
async function preflightStop(
  options: ShipOptions,
  branch: string,
  sha: string,
): Promise<Outcome | undefined> {
  const { preflight } = options;
  if (preflight === undefined || preflight.commands.length === 0) {
    return undefined;
  }
  const run = await runPreflight({
    exec: options.exec,
    repoRoot: options.repoRoot,
    baseBranch: preflight.baseBranch,
    commands: preflight.commands,
    env: gateEnvironment(options),
    remember: true,
  });
  const verdict = preflightOutcome(run) ?? (await headMoved(options, sha));
  return verdict === undefined
    ? undefined
    : withExistingPullRequest(options, branch, verdict);
}

/**
 * Run the push gate, then push only on its pass, and only the commit it
 * gated: the warnings to carry on with, or the outcome to stop on.
 */
async function gateThenPush(
  options: ShipOptions,
  branch: string,
  sha: string,
): Promise<Outcome | string[]> {
  const verdict =
    gateVerdict(await runPushGate(options)) ?? (await headMoved(options, sha));
  return verdict === undefined
    ? pushHead(options, branch, sha)
    : withExistingPullRequest(options, branch, verdict);
}

/**
 * The commit `origin` has for the branch, or `''` when it has no such branch
 * (or could not be asked).
 */
async function remoteHead(
  options: ShipOptions,
  branch: string,
): Promise<string> {
  const reference = `refs/heads/${branch}`;
  const listed = await options.exec('git', ['ls-remote', 'origin', reference], {
    cwd: options.repoRoot,
  });
  // ls-remote matches the END of a ref, so another branch's line can come
  // back too: only the line for this exact ref counts.
  return listed.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([, name]) => name === reference)
    .map(([commit]) => commit)
    .join('');
}

/**
How a push that exited 0 without pushing ended, for the warning.
*/
function endingOf(pushed: ExecResult): string {
  return pushed.signal === undefined
    ? 'no signal reported'
    : `ended by ${pushed.signal}`;
}

/**
 * Push HEAD and confirm `origin` has it: the warnings to carry on when it
 * does, or the outcome when it does not.
 *
 * git's exit code is not enough. The exec seam reports a push ended by a
 * signal as exit 0, and three ships whose push gate ran cold ended that way
 * with nothing on the remote (#170). On a branch with an open pull request
 * the old commit's checks were then read as this commit's. So the remote is
 * asked, and a push that did not land is made once more: the gate has passed
 * by then, so the second push is quick.
 */
async function pushHead(
  options: ShipOptions,
  branch: string,
  sha: string,
): Promise<Outcome | string[]> {
  const force = options.forceWithLease === true ? ['--force-with-lease'] : [];
  const push = (): Promise<ExecResult> =>
    options.exec('git', ['push', ...force, '-u', 'origin', 'HEAD'], {
      cwd: options.repoRoot,
      env: gateEnvironment(options),
    });
  const first = await push();
  if (first.code !== 0) {
    return pushFailure(options, branch, first);
  }
  if ((await remoteHead(options, branch)) === sha) {
    return [];
  }
  const second = await push();
  if (second.code !== 0) {
    return pushFailure(options, branch, second);
  }
  const remote = await remoteHead(options, branch);
  if (remote === sha) {
    return [
      `the first git push exited 0 without updating origin/${branch} ` +
        `(${endingOf(first)}); pushed again`,
    ];
  }
  return failure(
    'error',
    `guardrails ship: git push exited 0 twice, but origin/${branch} is at ` +
      `${remote || 'nothing'}, not at ${sha} (HEAD). Nothing was checked.\n` +
      `${output(first)}\n${output(second)}`,
  );
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

/**
What `gh pr create` is given for the title and body.
*/
interface Opening {
  args: string[];
  /**
  How the last commit's subject, when nobody chose a title, disagrees with
  the branch.
  */
  mismatch?: TypeMismatch | undefined;
}

/**
 * The title and body a new pull request opens with: `--title`, else the body
 * file's `# <title>` line (stripped from the body), else the last commit's
 * subject. Without a body file gh fills the body. The file is read here, as
 * gh read it before, so an edit made while the gate ran is what opens.
 */
async function openingOf(
  options: ShipOptions,
  branch: string,
): Promise<Opening | string> {
  const given = options.title?.trim() ?? '';
  const named = given === '' ? [] : ['--title', given];
  const { bodyFile } = options;
  if (bodyFile === undefined) {
    return { args: [...named, '--fill'] };
  }
  let text: string;
  try {
    text = readFileSync(bodyFile, 'utf8');
  } catch {
    return (
      `guardrails ship: --body-file ${bodyFile} could not be read after the ` +
      'push, so no pull request was opened. Restore it and ship again.'
    );
  }
  const split = splitTitleLine(text);
  const body =
    split === undefined ? ['--body-file', bodyFile] : ['--body', split.body];
  if (named.length > 0) {
    return { args: [...named, ...body] };
  }
  if (split !== undefined) {
    return { args: ['--title', split.title, ...body] };
  }
  const lastCommit = await options.exec('git', ['log', '-1', '--format=%s'], {
    cwd: options.repoRoot,
  });
  const subject = lastCommit.stdout.trim();
  return {
    args: ['--title', subject, ...body],
    mismatch: titleTypeMismatch(branch, subject),
  };
}

/**
 * The warning for a pull request titled by a last commit whose type is not
 * the branch's, which a squash merge would carry onto the base (#175).
 */
function titleWarnings(
  pr: PullRequest,
  mismatch: TypeMismatch | undefined,
): string[] {
  if (mismatch === undefined) {
    return [];
  }
  const number = String(pr.number);
  return [
    `PR #${number} is titled by the last commit, "${mismatch.subject}", ` +
      `whose type (${mismatch.found}) is not the branch's ` +
      `(${mismatch.wanted}): retitle it with gh pr edit ${number} --title, ` +
      'and pass --title or start the body file with "# <title>" next time',
  ];
}

async function findOrOpenPullRequest(
  options: ShipOptions,
  branch: string,
): Promise<FoundPullRequest | string> {
  const existing = await viewPullRequest(options, branch);
  if (existing.pr !== undefined) {
    return {
      pr: existing.pr,
      warnings: await commentAttachments(options, existing.pr),
    };
  }
  const opening = await openingOf(options, branch);
  if (typeof opening === 'string') {
    return opening;
  }
  const attach = attachArguments(options);
  const created = await gh(options, [
    'pr',
    'create',
    '--base',
    options.baseBranch,
    ...opening.args,
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
    warnings: [
      ...(created.code === 0 ? [] : [attachWarning(created)]),
      ...titleWarnings(opened.pr, opening.mismatch),
    ],
  };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
What gh says when it is older than the `workflow` field of `gh pr checks`.
*/
const UNKNOWN_WORKFLOW_FIELD = 'Unknown JSON field: "workflow"';

/**
 * The checks as `gh pr checks --json` lists them right now, with the listing's
 * text for the error tail. `checks` is `undefined` when the listing was
 * unreadable. A gh too old to name each check's workflow is asked without it,
 * which loses only the run a still-running failed check is in.
 */
async function readChecks(
  options: ShipOptions,
  number: string,
): Promise<{ checks: Check[] | undefined; listing: string }> {
  const list = (fields: string): Promise<ExecResult> =>
    gh(options, ['pr', 'checks', number, '--json', fields]);
  const first = await list('name,bucket,workflow');
  const listed = output(first).includes(UNKNOWN_WORKFLOW_FIELD)
    ? await list('name,bucket')
    : first;
  // Before CI registers, gh does not print an empty list: it exits 1 with
  // this sentence on stderr. That is "none yet", not "unreadable".
  const checks = output(listed).includes(NO_CHECKS_YET)
    ? []
    : parseChecks(listed.stdout);
  return { checks, listing: output(listed) };
}

/**
 * The workflow runs on the pushed commit, with the listing's text for the
 * error tail. `runs` is `undefined` when the listing was unreadable.
 */
async function readRuns(
  options: ShipOptions,
  sha: string,
): Promise<{ runs: Run[] | undefined; listing: string }> {
  const listed = await gh(options, [
    'run',
    'list',
    '--commit',
    sha,
    // gh lists 20 runs unless told otherwise, and a red run past the cut
    // would not be seen.
    '--limit',
    '100',
    '--json',
    'workflowName,conclusion,event,databaseId,status,attempt',
  ]);
  return {
    runs: parseRuns(listed.stdout),
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
        '--paginate',
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
 * The runs that did not pass. A cancelled run is left out when another run of
 * its workflow on the commit was not cancelled: `concurrency:
 * cancel-in-progress` leaves the run it replaced behind, and the run that
 * replaced it is the one that says how the workflow went.
 */
function redRuns<T extends Listed>(runs: readonly T[]): T[] {
  const outlived = new Set(
    runs.filter((run) => run.outcome !== 'cancelled').map((run) => run.name),
  );
  return runs.filter(
    (run) =>
      RED_CONCLUSIONS.has(run.outcome) &&
      !(run.outcome === 'cancelled' && outlived.has(run.name)),
  );
}

/**
The red checks by name, then the red runs by workflow and conclusion.
*/
function failingOf(evidence: Evidence): string[] {
  return [
    ...evidence.checks
      .filter((check) => RED_BUCKETS.has(check.outcome))
      .map((check) => check.name),
    ...redRuns(evidence.runs).map((run) => `${run.name} (${run.outcome})`),
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

/**
What gh says when it is older than a flag ship passes.
*/
const UNKNOWN_FLAG = 'unknown flag: --fail-fast';

/**
 * Watch the checks until they settle or one fails (#178). Without
 * `--fail-fast` the watch ends only with the slowest check, which can be the
 * better part of an hour after the first one went red; the checks still
 * running are left to run. A gh that predates the flag is watched without it.
 */
async function watchUntilFirstFailure(
  options: ShipOptions,
  number: string,
): Promise<ExecResult> {
  const watch = (flags: readonly string[]): Promise<ExecResult> =>
    gh(options, ['pr', 'checks', number, '--watch', ...flags]);
  const fast = await watch(['--fail-fast']);
  return output(fast).includes(UNKNOWN_FLAG) ? watch([]) : fast;
}

/**
 * What CI says about the pushed commit right now, or the listing's text when
 * the checks or the runs could not be read.
 */
async function readEvidence(
  options: ShipOptions,
  number: string,
  sha: string,
): Promise<Listing | string> {
  const { checks, listing } = await readChecks(options, number);
  if (checks === undefined) {
    return listing;
  }
  const listed = await readRuns(options, sha);
  return listed.runs === undefined
    ? listed.listing
    : { checks, runs: listed.runs };
}

/**
How a watch ended, and the evidence that made it red, when it was red.
*/
interface Watched {
  outcome: Outcome;
  red: Evidence | undefined;
}

async function watchChecks(
  options: ShipOptions,
  pr: PullRequest,
  sha: string,
): Promise<Watched> {
  const delay = options.delay ?? defaultDelay;
  const number = String(pr.number);
  const found = { pr: pr.number, url: pr.url };
  const required = await requiredChecks(options);
  for (let attempt = 0; ; attempt += 1) {
    const watch = await watchUntilFirstFailure(options, number);
    const listing = await readEvidence(options, number, sha);
    const evidence =
      typeof listing === 'string' ? listing : { ...listing, required };
    if (typeof evidence === 'string') {
      return {
        outcome: {
          ...found,
          state: 'error',
          failing: [],
          tail: tailOf(evidence),
        },
        red: undefined,
      };
    }
    const verdict = judgeChecks(
      evidence,
      output(watch),
      attempt < NO_CHECKS_RETRIES,
    );
    if (verdict !== undefined) {
      return {
        outcome: { ...found, ...verdict },
        red: verdict.state === 'ci-red' ? evidence : undefined,
      };
    }
    await delay(NO_CHECKS_DELAY_MS);
  }
}

/**
 * The runs `--rerun-failed` would re-run: each red run that has jobs to re-run
 * (a run that failed to start has none), and each run still going whose
 * workflow a failed check belongs to -- `--fail-fast` ends the watch at the
 * first failed check, before its run has concluded. Ids come only from
 * `gh run list`, never from a check's link, whose ids are not run ids.
 */
function rerunnableOf(evidence: Listing): Run[] {
  const failedIn = new Set(
    evidence.checks
      .filter((check) => RED_BUCKETS.has(check.outcome))
      .map((check) => check.workflow)
      .filter((workflow) => workflow !== ''),
  );
  const ended = redRuns(evidence.runs).filter(
    (run) => run.outcome !== 'startup_failure',
  );
  const going = evidence.runs.filter(
    (run) => run.status !== 'completed' && failedIn.has(run.name),
  );
  return [...ended, ...going];
}

type BaseAnswer = Diagnosis['base'];

/**
 * Whether the base moved since `sha` was tested, with the warning to carry
 * when that could not be told. It never changes the state: only the advice.
 */
async function baseSinceTested(
  options: ShipOptions,
  sha: string,
): Promise<{ base: BaseAnswer; warnings: string[] }> {
  const base = `origin/${options.baseBranch}`;
  const containment = await baseContainment(options, sha);
  if (containment === 'contains') {
    return { base: 'contains', warnings: [] };
  }
  if (containment === 'missing') {
    return { base: 'moved', warnings: [] };
  }
  return {
    base: 'unknown',
    warnings: [
      containment === 'unfetched'
        ? `could not fetch ${base} after CI, so whether it moved since this ` +
          'commit was tested was not checked'
        : `could not tell whether ${base} moved since this commit was tested`,
    ],
  };
}

const RERUN_ADVICE =
  're-run the failed jobs with guardrails ship --rerun-failed, or fix them ' +
  'and ship again';

/**
The advice, from the evidence, and the line that says it.
*/
function adviceOf(
  options: ShipOptions,
  base: BaseAnswer,
  rerunnable: readonly number[],
): Pick<Diagnosis, 'advice' | 'next'> {
  const origin = `origin/${options.baseBranch}`;
  if (base === 'moved') {
    return {
      advice: 'rebase',
      next:
        `rebase onto ${origin}, which moved after this commit was tested, ` +
        'and ship again',
    };
  }
  if (rerunnable.length === 0) {
    return {
      advice: 'fix',
      next:
        'fix the failing checks and ship again: no failed workflow run can ' +
        'be re-run',
    };
  }
  return {
    advice: 'rerun-failed',
    next:
      base === 'contains'
        ? `${origin} has not moved since this commit was tested: ${RERUN_ADVICE}`
        : RERUN_ADVICE,
  };
}

/**
What can be done about a red watch, with the warnings asking it raised.
*/
async function diagnoseRed(
  options: ShipOptions,
  sha: string,
  evidence: Evidence,
): Promise<{ diagnosis: Diagnosis; warnings: string[] }> {
  const { base, warnings } = await baseSinceTested(options, sha);
  const rerunnable = rerunnableOf(evidence).map((run) => run.id);
  return {
    diagnosis: { base, rerunnable, ...adviceOf(options, base, rerunnable) },
    warnings,
  };
}

/**
 * Watch the checks, and diagnose them when they are red: how CI ended, with
 * the warnings the diagnosis raised.
 */
async function settle(
  options: ShipOptions,
  pr: PullRequest,
  sha: string,
): Promise<Finished> {
  const { outcome, red } = await watchChecks(options, pr, sha);
  return red === undefined
    ? stopped(outcome)
    : { ...outcome, ...(await diagnoseRed(options, sha, red)) };
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

/**
 * Whether `commit` contains `origin/<base>`, after fetching it: `unfetched`
 * when the fetch failed or was killed, `unknown` when git could not say.
 */
type Containment = 'contains' | 'missing' | 'unfetched' | 'unknown';

async function baseContainment(
  options: ShipOptions,
  commit: string,
): Promise<Containment> {
  const git = (args: string[]): Promise<ExecResult> =>
    options.exec('git', args, { cwd: options.repoRoot });
  const fetched = await git(['fetch', '--quiet', 'origin', options.baseBranch]);
  if (fetched.code !== 0 || fetched.signal !== undefined) {
    return 'unfetched';
  }
  const base = `origin/${options.baseBranch}`;
  const contained = await git(['merge-base', '--is-ancestor', base, commit]);
  if (contained.signal === undefined && contained.code === 0) {
    return 'contains';
  }
  // A kill reports exit 0, so the check above already passed it over.
  return contained.code === 1 ? 'missing' : 'unknown';
}

/**
The files HEAD conflicts in with `base`, by merge-tree.
*/
async function conflictsWith(
  options: ShipOptions,
  base: string,
): Promise<string[]> {
  const merged = await options.exec(
    'git',
    [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      'HEAD',
      base,
    ],
    { cwd: options.repoRoot },
  );
  // Exit 1 is a conflict; the tree id comes first, then one file per line.
  return merged.code === 1
    ? merged.stdout
        .split('\n')
        .slice(1)
        .filter((line) => line !== '')
    : [];
}

/**
 * Whether the branch can merge into its base, asked BEFORE the push and so
 * before the gate lock (#178): a branch that is behind fails its required
 * checks or goes CONFLICTING mid-gate, after the lane has paid for the gate.
 *
 * Answers an outcome to stop on, or the warnings to carry on with. A branch
 * that contains `origin/<base>` cannot conflict with it, so merge-tree runs
 * only for one that does not. Anything git cannot answer -- an offline fetch,
 * a missing ref, a kill -- ships as before with a warning: this check saves a
 * gate, and must never be the reason a push did not happen.
 */
async function baseCheck(
  options: ShipOptions,
  branch: string,
): Promise<Outcome | string[]> {
  const base = `origin/${options.baseBranch}`;
  const containment = await baseContainment(options, 'HEAD');
  if (containment === 'contains') {
    return [];
  }
  if (containment === 'unfetched') {
    return [
      `could not fetch ${base}, so whether ${branch} is behind it was not checked`,
    ];
  }
  if (containment === 'unknown') {
    return [
      `could not tell whether ${branch} contains ${base}, so it was not checked`,
    ];
  }
  const conflicted = await conflictsWith(options, base);
  if (conflicted.length > 0) {
    return {
      ...failure(
        'conflicting',
        `guardrails ship: ${branch} conflicts with ${base} in ` +
          `${String(conflicted.length)} file(s). Rebase it onto ${base} and ` +
          'resolve them, then ship again. Nothing was pushed.',
      ),
      failing: conflicted,
    };
  }
  return failure(
    'behind',
    `guardrails ship: ${branch} does not contain ${base}. Rebase it onto ` +
      `${base} (or merge ${base} into it), then ship again. Nothing was pushed.`,
  );
}

function shipIdOf(options: ShipOptions): string {
  return options.shipId ?? 'unset';
}

function clockOf(options: ShipOptions): () => number {
  const clock = options.runClock;
  return clock === undefined ? Date.now : () => clock.now().getTime();
}

/**
 * The commit HEAD names, or the outcome to stop on when git named none: a
 * push could not then be confirmed.
 */
async function headCommit(options: ShipOptions): Promise<string | Outcome> {
  const head = await options.exec('git', ['rev-parse', 'HEAD'], {
    cwd: options.repoRoot,
  });
  const sha = head.stdout.trim();
  return sha === ''
    ? failure(
        'error',
        'guardrails ship: git rev-parse HEAD named no commit, so a push ' +
          `could not be confirmed. Nothing was pushed.\n${output(head)}`,
      )
    : sha;
}

/**
 * The commit HEAD names, when gh can be used and nothing else is `unusable`;
 * otherwise the outcome to stop on, gh's first.
 */
async function usableHead(
  options: ShipOptions,
  unusable?: string,
): Promise<string | Outcome> {
  const unavailable = (await ghUnavailable(options)) ?? unusable;
  return unavailable === undefined
    ? headCommit(options)
    : failure('error', unavailable);
}

/**
 * Everything asked before the push: whether gh and the body file can be
 * used, the commit to push, and the base. The commit and the warnings to
 * carry on with, or the outcome to stop on.
 */
async function prechecks(
  options: ShipOptions,
  branch: string,
): Promise<Outcome | { sha: string; warnings: string[] }> {
  const sha = await usableHead(options, bodyFileUnreadable(options));
  if (typeof sha !== 'string') {
    return sha;
  }
  const based = await baseCheck(options, branch);
  return Array.isArray(based)
    ? { sha, warnings: [...based, ...(await treeWarnings(options))] }
    : based;
}

/**
 * The warning for a working tree that is not HEAD. The push gate checks the
 * working tree, untracked files included, but git pushes HEAD, so a gate
 * that passed did not check exactly what was pushed. A warning only: CI
 * checks what was pushed.
 */
async function treeWarnings(options: ShipOptions): Promise<string[]> {
  const status = await options.exec('git', ['status', '--porcelain'], {
    cwd: options.repoRoot,
  });
  // A kill reports exit 0 with nothing printed, which reads as clean.
  if (status.signal !== undefined || status.code !== 0) {
    return [
      'could not tell whether the working tree matches HEAD, which is what ' +
        'was pushed after the gate checked the working tree',
    ];
  }
  const paths = status.stdout.split('\n').filter((line) => line !== '');
  return paths.length === 0
    ? []
    : [
        `the working tree has ${String(paths.length)} uncommitted or ` +
          'untracked path(s): the push gate checked the working tree, but ' +
          'only HEAD was pushed',
      ];
}

/**
 * `settle`, with how long it took kept for the run log, and the warnings
 * gathered before the watch put ahead of the watch's own.
 */
async function settleWithWarnings(
  options: ShipOptions,
  pr: PullRequest,
  sha: string,
  times: ShipTimes,
  earlier: readonly string[],
): Promise<Finished> {
  const now = clockOf(options);
  const watchStart = now();
  const settled = await settle(options, pr, sha);
  times.ciMs = now() - watchStart;
  return { ...settled, warnings: [...earlier, ...settled.warnings] };
}

/**
 * A ship of the branch, with the `ship.preflight` entries the config
 * dropped warned of first, however it ended.
 */
async function shipOutcome(
  options: ShipOptions,
  branch: string,
  times: ShipTimes,
): Promise<Finished> {
  const finished = await pushAndWatch(options, branch, times);
  return {
    ...finished,
    warnings: [...(options.preflight?.warnings ?? []), ...finished.warnings],
  };
}

async function pushAndWatch(
  options: ShipOptions,
  branch: string,
  times: ShipTimes,
): Promise<Finished> {
  const ready = await prechecks(options, branch);
  if (!('sha' in ready)) {
    return stopped(ready);
  }
  const { sha } = ready;
  const preflightStopped = await preflightStop(options, branch, sha);
  if (preflightStopped !== undefined) {
    return stopped(preflightStopped);
  }
  const now = clockOf(options);
  const pushStart = now();
  const pushed = await gateThenPush(options, branch, sha);
  times.pushMs = now() - pushStart;
  if (!Array.isArray(pushed)) {
    return stopped(pushed);
  }
  const found = await findOrOpenPullRequest(options, branch);
  if (typeof found === 'string') {
    return stopped(failure('error', found));
  }
  return settleWithWarnings(options, found.pr, sha, times, [
    ...ready.warnings,
    ...pushed,
    ...found.warnings,
  ]);
}

/**
How many times, and how far apart, ship looks for a re-run's new attempt
before it watches the checks: watched too early, the old attempt's failure
reports red at once.
*/
const RERUN_START_LOOKS = 8;
const RERUN_START_DELAY_MS = 15_000;

const RERUN = 'guardrails ship --rerun-failed';

/**
What a re-run is of: the pushed commit, its pull request, and the runs to
re-run, with the warnings asking raised.
*/
interface RerunPlan {
  sha: string;
  pr: PullRequest;
  targets: Run[];
  warnings: string[];
}

/**
 * The commit origin has for the branch and its pull request, when HEAD is
 * that commit; otherwise the outcome to stop on. A re-run is only of what
 * was pushed: the runs on any other commit did not test this one.
 */
async function pushedPullRequest(
  options: ShipOptions,
  branch: string,
): Promise<Outcome | { sha: string; pr: PullRequest }> {
  const sha = await usableHead(options);
  if (typeof sha !== 'string') {
    return sha;
  }
  const remote = await remoteHead(options, branch);
  if (remote !== sha) {
    return failure(
      'error',
      `${RERUN}: HEAD (${sha}) is not the commit origin/${branch} has ` +
        `(${remote || 'nothing'}), so the runs there did not test it. Ship ` +
        'it instead. Nothing was re-run.',
    );
  }
  const { pr } = await viewPullRequest(options, branch);
  return pr === undefined
    ? failure(
        'error',
        `${RERUN}: ${branch} has no pull request. Ship it instead. Nothing ` +
          'was re-run.',
      )
    : { sha, pr };
}

/**
 * What to re-run, derived afresh from gh -- never from the status file, which
 * may be another ship's -- or the outcome to stop on. A base that moved since
 * the commit was tested is `behind`: re-running would test it against the
 * old base, and only a rebase answers that.
 */
async function rerunPlan(
  options: ShipOptions,
  branch: string,
): Promise<Outcome | RerunPlan> {
  const pushed = await pushedPullRequest(options, branch);
  if (!('sha' in pushed)) {
    return pushed;
  }
  const { sha, pr } = pushed;
  const found = { pr: pr.number, url: pr.url };
  const { base, warnings } = await baseSinceTested(options, sha);
  const origin = `origin/${options.baseBranch}`;
  if (base === 'moved') {
    return {
      ...failure(
        'behind',
        `${RERUN}: ${origin} moved after ${sha} was tested, and a re-run ` +
          `would test it against the old base. Rebase onto ${origin} and ` +
          'ship again. Nothing was re-run.',
      ),
      ...found,
    };
  }
  const evidence = await readEvidence(options, String(pr.number), sha);
  if (typeof evidence === 'string') {
    return { ...failure('error', evidence), ...found };
  }
  const targets = rerunnableOf(evidence);
  if (targets.length === 0) {
    return {
      ...failure(
        'error',
        `${RERUN}: no failed workflow run on ${sha} has jobs to re-run. Fix ` +
          'the failing checks and ship again. Nothing was re-run.',
      ),
      ...found,
    };
  }
  return { sha, pr, targets, warnings };
}

/**
 * Re-run the failed jobs of each target, or say what gh refused. A run still
 * going is waited for first: GitHub re-runs only a run that has concluded,
 * and `--fail-fast` reports a failed check before its run has.
 */
async function rerunTargets(
  options: ShipOptions,
  targets: readonly Run[],
): Promise<string | undefined> {
  for (const run of targets) {
    const id = String(run.id);
    if (run.status !== 'completed') {
      await gh(options, ['run', 'watch', id]);
    }
    const asked = await gh(options, ['run', 'rerun', id, '--failed']);
    if (asked.code !== 0) {
      return output(asked);
    }
  }
  return undefined;
}

/**
 * Whether every target has started a new attempt, looked for a bounded
 * number of times. A re-run keeps its run's id and bumps its attempt.
 */
async function haveNewAttemptsStarted(
  options: ShipOptions,
  sha: string,
  targets: readonly Run[],
): Promise<boolean> {
  const delay = options.delay ?? defaultDelay;
  for (let look = 0; look < RERUN_START_LOOKS; look += 1) {
    const { runs } = await readRuns(options, sha);
    const haveStarted =
      runs !== undefined &&
      targets.every((target) =>
        runs.some(
          (run) => run.id === target.id && run.attempt > target.attempt,
        ),
      );
    if (haveStarted) {
      return true;
    }
    await delay(RERUN_START_DELAY_MS);
  }
  return false;
}

/**
 * `ship --rerun-failed`: re-run the failed jobs of the pushed commit, wait for
 * the new attempts, then watch and diagnose the checks as a ship does. It
 * pushes nothing and is only ever asked for: ship never re-runs on its own.
 */
async function rerunOutcome(
  options: ShipOptions,
  branch: string,
  times: ShipTimes,
): Promise<Finished> {
  const plan = await rerunPlan(options, branch);
  return 'targets' in plan
    ? rerunAndWatch(options, plan, times)
    : stopped(plan);
}

async function rerunAndWatch(
  options: ShipOptions,
  plan: RerunPlan,
  times: ShipTimes,
): Promise<Finished> {
  const found = { pr: plan.pr.number, url: plan.pr.url };
  const refused = await rerunTargets(options, plan.targets);
  if (refused !== undefined) {
    return stopped({ ...failure('error', refused), ...found });
  }
  if (!(await haveNewAttemptsStarted(options, plan.sha, plan.targets))) {
    const ids = plan.targets.map((run) => String(run.id)).join(', ');
    return stopped({
      ...failure(
        'error',
        `${RERUN}: gh accepted the re-run, but run(s) ${ids} did not start ` +
          'a new attempt in time, so the checks were not watched.',
      ),
      ...found,
    });
  }
  return settleWithWarnings(options, plan.pr, plan.sha, times, plan.warnings);
}

/**
Ship the current branch, and say how it went.
*/
export async function ship(given: ShipOptions): Promise<ShipStatus> {
  const options = { ...given, shipId: given.shipId ?? randomUUID() };
  const start = startRun(options.runClock);
  const times: ShipTimes = {};
  const status = await shipStatus(options, times);
  // No lock, no log: git is asked for the clone only when there is a row.
  if (options.lockPath === undefined) {
    return status;
  }
  logShipRun({
    lockPath: options.lockPath,
    repoRoot: options.repoRoot,
    project: await projectName(options.exec, options.repoRoot),
    shipId: options.shipId,
    start,
    status,
    pushMs: times.pushMs,
    ciMs: times.ciMs,
    warn: (line) => {
      process.stderr.write(`${line}\n`);
    },
    clock: options.runClock,
  });
  return status;
}

async function shipStatus(
  options: ShipOptions,
  times: ShipTimes,
): Promise<ShipStatus> {
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
  const settle = options.rerunFailed === true ? rerunOutcome : shipOutcome;
  const outcome = isShippable
    ? await settle(options, branch, times)
    : stopped(
        failure(
          'error',
          `guardrails ship: not on a branch that can be shipped (HEAD is ` +
            `${branch || 'unknown'}; base is ${options.baseBranch}).\n` +
            output(head),
        ),
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
  const next =
    status.diagnosis === null ? '' : `; next: ${status.diagnosis.next}`;
  const warnings = status.warnings
    .map((warning) => `; warning: ${warning}`)
    .join('');
  return (
    `guardrails ship: ${status.state} — ${status.branch}, ${pr}${failing}${next}${warnings} ` +
    `(status: ${statusPath})`
  );
}

export { LOCK_TIMEOUT_MARKER } from './mutation-lock.js';
