/**
 * Who holds the mutation lock, how far along it is, and how many wait behind
 * it (spec: docs/superpowers/specs/2026-11-01-mutation-lock-design.md).
 *
 * The holder file only LABELS the lock. The advisory lock in
 * `mutation-lock.ts` stays the one authority on who may run: a file that is
 * missing, unreadable, or left behind by a dead pid reads as "no holder
 * known", and the caller words that as "another checkout".
 *
 * Everything here is pure. The file read, the liveness check and the `ps`
 * call are the caller's, so the decisions can be proved without any of them.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type JsonFileResult, parseJsonText } from './json-file.js';
import { isRung, type Rung } from './verify/analyzer-policy.js';
import { isRecord } from './verify/report-shape.js';

/**
What the lock holder is doing. The progress plugin begins at `dry-run`: no
stryker event marks the dry run's start. `starting` is for a holder named
before stryker has reported anything.
*/
type HolderPhase = 'starting' | 'dry-run' | 'mutating';

/**
 * The mutant counts, as the plugin has seen them so far. `tested` and `total`
 * both include `reused`: the mutants whose result came from the incremental
 * cache rather than a run.
 */
type HolderCounts = Record<'tested' | 'total' | 'reused' | 'survived', number>;

/**
 * The contents of `<lock>.holder.json`, written by the stryker progress
 * plugin running inside the holder. Times are epoch milliseconds; `repo` is
 * shown by its basename; `pid` is the stryker process, whose parent is the
 * locker holding the lock; `mutatingSince` is when the plan was ready.
 */
export type Holder = HolderCounts & {
  repo: string;
  rung: Rung;
  pid: number;
  startedAt: number;
  phase: HolderPhase;
  mutatingSince?: number;
};

/**
 * The holder file as a `guardrails lock -- <cmd>` run writes it (#201): from
 * the process that holds the lock, which then becomes the command, so `pid`
 * is the command's. `command` is its program's basename only. The file also
 * carries the run's token, which only the run that wrote it reads.
 */
export interface LockCommandHolder {
  kind: 'lock';
  repo: string;
  pid: number;
  startedAt: number;
  command: string;
}

/**
Where the holder file for `lockPath` lives: beside the lock.
*/
export function holderPath(lockPath: string): string {
  return `${lockPath}.holder.json`;
}

/**
The reporter name the progress plugin registers, and `--reporters` asks for.
*/
export const PROGRESS_REPORTER = 'guardrails-progress';

/**
 * What the progress plugin reads to know it runs for the lock's holder: the
 * holder file beside `lockPath`, the rung, and the repo. Set only on the run
 * that holds the lock, so a plugin that finds them is the holder.
 */
export function holderEnvironment(
  lockPath: string,
  rung: Rung,
  repo: string,
): Record<string, string> {
  return {
    GUARDRAILS_LOCK_HOLDER_FILE: holderPath(lockPath),
    GUARDRAILS_LOCK_RUNG: rung,
    GUARDRAILS_LOCK_REPO: repo,
    GUARDRAILS_RUN_SUMMARY_FILE: runSummaryPath(repo),
  };
}

/**
 * Where the progress plugin leaves its run summary (#176): in the repo's
 * `reports/`, beside stryker's own report, for the gate to read after the
 * run.
 */
export function runSummaryPath(repoRoot: string): string {
  return path.join(repoRoot, 'reports', 'guardrails-run.json');
}

/**
 * When a locked stryker run reached each point, epoch milliseconds, and its
 * plan's counts. `startedAt` is when stryker started, which is when the lock
 * was taken; `planReadyAt` ends the dry run; `reportReadyAt` ends mutation.
 */
export interface RunSummary {
  startedAt: number;
  planReadyAt?: number | undefined;
  reportReadyAt?: number | undefined;
  total: number;
  reused: number;
  /**
  What this run's timeouts cost (#236); written with the report only.
  */
  timeouts?: TimeoutCosts | undefined;
  /**
  The settings a timeout budget is made of (#236), those that were known.
  */
  settings?: TimeoutSettings | undefined;
}

/**
 * One file's wall-clock timeouts, and the first and last line they start on:
 * many in a narrow span are likely one cause.
 */
export interface TimeoutFile {
  /**
  Relative to the repo.
  */
  file: string;
  count: number;
  firstLine: number;
  lastLine: number;
}

/**
 * What a run's timeouts cost (#236), counting only the mutants stryker ran.
 *
 * A **wall-clock** Timeout is one stryker's timer stopped; stryker restarts
 * the test runner process after each. A **hit-limit** one ran its own code
 * past the limit the dry run set, and is returned as an ordinary result.
 *
 * `budgetMs` adds up the timeout stryker gave each wall-clock Timeout: its
 * `timeoutFactor × netTime + timeoutMS + the dry run's overhead`. A mutant's
 * **gap** is the time from the result before it (or the plan) to its own: at
 * concurrency 1 that is what it cost, restart included; above it, results
 * interleave and a gap says little about one mutant.
 */
export interface TimeoutCosts {
  wallClock: number;
  hitLimit: number;
  budgetMs: number;
  wallClockGapMs: number;
  /**
  Every other result's gaps, hit-limit timeouts included.
  */
  otherGapMs: number;
  /**
  The files with the most wall-clock timeouts, at most five.
  */
  byFile: TimeoutFile[];
}

/**
 * What stryker resolved for this run -- defaults, config and command line
 * alike -- and what its dry run measured.
 */
export interface TimeoutSettings {
  timeoutMS?: number;
  timeoutFactor?: number;
  concurrency?: number;
  dryRunNetMs?: number;
  dryRunOverheadMs?: number;
}

const SETTINGS = [
  'timeoutMS',
  'timeoutFactor',
  'concurrency',
  'dryRunNetMs',
  'dryRunOverheadMs',
] as const;

function timeoutFileOf(value: unknown): TimeoutFile[] {
  if (!isRecord(value)) {
    return [];
  }
  const { file, count, firstLine, lastLine } = value;
  return typeof file === 'string' &&
    isCount(count) &&
    isCount(firstLine) &&
    isCount(lastLine)
    ? [{ file, count, firstLine, lastLine }]
    : [];
}

/**
 * Timeout costs with every count there, or `undefined`. Bad file entries go.
 * The run log reads its copy of them with this too.
 */
export function timeoutCostsOf(value: unknown): TimeoutCosts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { wallClock, hitLimit, budgetMs, wallClockGapMs, otherGapMs, byFile } =
    value;
  if (
    !Array.isArray(byFile) ||
    !isCount(wallClock) ||
    !isCount(hitLimit) ||
    !isCount(budgetMs) ||
    !isCount(wallClockGapMs) ||
    !isCount(otherGapMs)
  ) {
    return undefined;
  }
  const files: unknown[] = byFile;
  return {
    wallClock,
    hitLimit,
    budgetMs,
    wallClockGapMs,
    otherGapMs,
    byFile: files.flatMap((each) => timeoutFileOf(each)),
  };
}

/**
 * The settings in `value` that are numbers, or `undefined` for none: the
 * same reader takes stryker's options in the plugin and the summary here.
 */
export function timeoutSettingsOf(value: unknown): TimeoutSettings | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const settings: TimeoutSettings = {};
  for (const key of SETTINGS) {
    const setting = value[key];
    if (isCount(setting)) {
      settings[key] = setting;
    }
  }
  return Object.keys(settings).length === 0 ? undefined : settings;
}

/**
The run summary in `text`, or `undefined` when it holds no start and counts.
*/
export function parseRunSummary(text: string): RunSummary | undefined {
  const { parsed } = parseJsonText(text);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { startedAt, planReadyAt, reportReadyAt, total, reused } = parsed;
  if (!isCount(startedAt) || !isCount(total) || !isCount(reused)) {
    return undefined;
  }
  return {
    startedAt,
    ...(isCount(planReadyAt) && { planReadyAt }),
    ...(isCount(reportReadyAt) && { reportReadyAt }),
    total,
    reused,
    timeouts: timeoutCostsOf(parsed.timeouts),
    settings: timeoutSettingsOf(parsed.settings),
  };
}

/**
 * The built progress plugin beside the module at `moduleUrl`, or `undefined`
 * when there is none. Stryker loads it by path, so it must be a file; from
 * `dist/` it is a sibling of the bundle running this, and from `src/` (tests,
 * a checkout before its build) there is none and the run simply goes without.
 */
export function progressPluginBeside(
  moduleUrl: string,
  isFile: (filePath: string) => boolean = existsSync,
): string | undefined {
  const plugin = fileURLToPath(
    new URL('stryker-progress-plugin.mjs', moduleUrl),
  );
  return isFile(plugin) ? plugin : undefined;
}

/**
 * The holder named in `filePath`, or `undefined` when no holder is known: the
 * file is missing or garbage, or its pid is no longer alive (a stale file
 * left behind by a holder that was killed). Production passes
 * `readJsonFile`; missing and malformed files both arrive as `parsed:
 * undefined`.
 */
export function readHolder(
  filePath: string,
  readJson: (filePath: string) => JsonFileResult,
  isAlive: (pid: number) => boolean,
): Holder | LockCommandHolder | undefined {
  const holder = toAnyHolder(readJson(filePath).parsed);
  if (holder === undefined || !isAlive(holder.pid)) {
    return undefined;
  }
  return holder;
}

const PHASES: ReadonlySet<unknown> = new Set<HolderPhase>([
  'starting',
  'dry-run',
  'mutating',
]);

function isPhase(value: unknown): value is HolderPhase {
  return PHASES.has(value);
}

function isCount(value: unknown): value is number {
  // `Number.isFinite` does not coerce, so it is false for every non-number.
  return Number.isFinite(value);
}

/**
 * A holder of either kind: `kind: 'lock'` for a `guardrails lock` run, and no
 * `kind` for the stryker progress plugin's, which predates the field.
 */
function toAnyHolder(value: unknown): Holder | LockCommandHolder | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.kind === 'lock') {
    return toLockCommandHolder(value);
  }
  return value.kind === undefined ? toHolder(value) : undefined;
}

function toLockCommandHolder(
  value: Record<string, unknown>,
): LockCommandHolder | undefined {
  const { repo, pid, startedAt, command } = value;
  if (
    typeof repo !== 'string' ||
    typeof command !== 'string' ||
    !isCount(pid) ||
    !isCount(startedAt)
  ) {
    return undefined;
  }
  return { kind: 'lock', repo, pid, startedAt, command };
}

/**
 * Field by field, so the result is a `Holder` because every field was
 * checked -- not because a cast said so -- and unknown fields are dropped.
 */
function toHolder(value: unknown): Holder | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { repo, rung, pid, startedAt, phase, tested, total, reused, survived } =
    value;
  const { mutatingSince } = value;
  if (
    typeof repo !== 'string' ||
    !isRung(rung) ||
    !isPhase(phase) ||
    !isCount(pid) ||
    !isCount(startedAt) ||
    !isCount(tested) ||
    !isCount(total) ||
    !isCount(reused) ||
    !isCount(survived) ||
    !(mutatingSince === undefined || isCount(mutatingSince))
  ) {
    return undefined;
  }
  const holder: Holder = {
    repo,
    rung,
    pid,
    startedAt,
    phase,
    tested,
    total,
    reused,
    survived,
  };
  return mutatingSince === undefined ? holder : { ...holder, mutatingSince };
}

/**
 * One line naming the holder and its progress, e.g.
 * `dialed-163 (push) is mutating, 62% (160/258), ~4m left`. The time-left
 * clause appears only once there is a rate to estimate from.
 */
export function describeHolder(
  holder: Holder | LockCommandHolder,
  now: number,
): string {
  if ('kind' in holder) {
    return (
      `${path.basename(holder.repo)} is running ${holder.command} under ` +
      `guardrails lock, ${minutesText(now - holder.startedAt)} so far`
    );
  }
  const who = `${path.basename(holder.repo)} (${holder.rung})`;
  if (holder.phase === 'starting') {
    return `${who} is starting mutation testing`;
  }
  if (holder.phase === 'dry-run') {
    return `${who} is running the dry run`;
  }
  if (holder.total <= 0) {
    return `${who} is mutating`;
  }
  const percent = Math.floor((holder.tested / holder.total) * 100);
  const progress = `${who} is mutating, ${String(percent)}% (${String(holder.tested)}/${String(holder.total)})`;
  const left = timeLeft(holder, now);
  return left === undefined ? progress : `${progress}, ${left}`;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/**
 * The rate since `mutatingSince`, applied to the mutants remaining. Reused
 * mutants arrive all at once when the plan is ready, so they are left out of
 * the rate -- counting them would make an incremental run look fast.
 */
function timeLeft(holder: Holder, now: number): string | undefined {
  const { mutatingSince } = holder;
  const run = holder.tested - holder.reused;
  if (mutatingSince === undefined || run <= 0 || now <= mutatingSince) {
    return undefined;
  }
  const perMutant = (now - mutatingSince) / run;
  const minutes = Math.round(
    ((holder.total - holder.tested) * perMutant) / MS_PER_MINUTE,
  );
  if (minutes < 1) {
    return '<1m left';
  }
  return `~${hoursAndMinutes(minutes)} left`;
}

/**
`12m`, `2h 5m`: whole minutes, with hours from sixty.
*/
function hoursAndMinutes(minutes: number): string {
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${String(hours)}h ${String(minutes % MINUTES_PER_HOUR)}m`;
}

/**
`ms` as whole minutes so far: `<1m` under one, a clock behind included.
*/
function minutesText(ms: number): string {
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  return minutes < 1 ? '<1m' : hoursAndMinutes(minutes);
}

interface PsLine {
  pid: number;
  ppid: number;
  command: string;
}

function parsePs(psOutput: string): PsLine[] {
  return psOutput.split('\n').flatMap((line) => {
    const [pidText = '', ppidText = '', ...words] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) {
      return [];
    }
    return [{ pid, ppid, command: words.join(' ') }];
  });
}

const LOCKERS: ReadonlySet<string> = new Set(['lockf', 'flock']);

/**
 * Is this `ps` line a locker on `lockPath` that is, or could be, holding a
 * stryker run? The lock path must be a whole argv word, so a lock whose path
 * merely starts with this one is not counted, and a zero-wait probe (`… true`)
 * is not a queued run.
 */
function isLockerOn(command: string, lockPath: string): boolean {
  const [program] = command.split(' ', 1);
  return (
    LOCKERS.has(path.basename(program ?? '')) &&
    command.includes(` ${lockPath} `) &&
    !command.endsWith(' true')
  );
}

/**
Is `pid` in this `ps -Ao pid=,ppid=,command=` listing -- is it still running?
*/
export function isListed(psOutput: string, pid: number): boolean {
  return parsePs(psOutput).some((line) => line.pid === pid);
}

/**
What `ps` says about the queue for one lock, as seen from one process.
*/
export interface LockQueue {
  /**
  Runs waiting for the lock, not counting the holder or this process's own.
  */
  waiting: number;
  /**
  This process's own locker holds the lock: its run has started.
  */
  isHeldBySelf: boolean;
}

/**
 * The queue for `lockPath`, from `ps -Ao pid=,ppid=,command=`, as `selfPid`
 * sees it. Every party is a `lockf`/`flock` process with the lock path in its
 * argv. The one HOLDING it is the one with a child -- a waiting locker has not
 * started its command yet -- which needs no holder file, so it reads a lock
 * held by any gate, old or new. A locker whose parent is `selfPid` is ours.
 */
export function lockQueue(
  psOutput: string,
  lockPath: string,
  selfPid: number,
): LockQueue {
  const lines = parsePs(psOutput);
  const parents = new Set(lines.map((line) => line.ppid));
  const lockers = lines.filter((line) => isLockerOn(line.command, lockPath));
  const isHolding = (line: PsLine): boolean => parents.has(line.pid);
  const isOurs = (line: PsLine): boolean => line.ppid === selfPid;
  return {
    waiting: lockers.filter((line) => !isHolding(line) && !isOurs(line)).length,
    isHeldBySelf: lockers.some((line) => isHolding(line) && isOurs(line)),
  };
}
