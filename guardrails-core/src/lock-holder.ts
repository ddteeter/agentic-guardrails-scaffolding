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

import type { JsonFileResult } from './json-file.js';
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
): Holder | undefined {
  const holder = toHolder(readJson(filePath).parsed);
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
export function describeHolder(holder: Holder, now: number): string {
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
  if (minutes < MINUTES_PER_HOUR) {
    return `~${String(minutes)}m left`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `~${String(hours)}h ${String(minutes % MINUTES_PER_HOUR)}m left`;
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
 * How many runs wait for `lockPath`, from `ps -Ao pid=,ppid=,command=`.
 * Every waiter is a `lockf`/`flock` process with the lock path in its argv;
 * the one holding the lock is the holder's parent, so it is left out.
 */
export function waitingCount(
  psOutput: string,
  lockPath: string,
  holderPid: number,
): number {
  const lines = parsePs(psOutput);
  const holdingLocker = lines.find((line) => line.pid === holderPid)?.ppid;
  return lines.filter(
    (line) => line.pid !== holdingLocker && isLockerOn(line.command, lockPath),
  ).length;
}
