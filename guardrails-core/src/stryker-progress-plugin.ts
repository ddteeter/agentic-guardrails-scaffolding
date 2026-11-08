/**
 * A stryker reporter that writes the mutation lock's holder file (spec:
 * docs/superpowers/specs/2026-11-01-mutation-lock-design.md, "Progress and the
 * queue are visible").
 *
 * Loaded with `--appendPlugins <this file>` on a locked run only. It runs
 * inside stryker, and stryker only starts once the lock is held, so what it
 * writes belongs to the holder by construction -- no separate writer is
 * needed to say who holds the lock.
 *
 * It must never fail a run: every fs error is swallowed, and with its env
 * vars unset it does nothing at all. It imports nothing from
 * `@stryker-mutator/api` at runtime -- a plugin is the plain object stryker's
 * `declareClassPlugin` would return -- so it loads in any consumer that has
 * stryker, whatever else it has installed.
 *
 * It also keeps a SECOND stop signal from reaching stryker
 * (`absorbRepeatStopSignals`): stryker saves a partial incremental report on
 * the first, and exits without one on the second.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { type Holder, PROGRESS_REPORTER } from './lock-holder.js';
import { isRung } from './verify/analyzer-policy.js';

/**
The slice of stryker's `MutationTestingPlanReadyEvent` this reporter reads.
*/
interface PlanReadyEvent {
  mutantPlans: readonly { plan: string }[];
}

/**
The slice of stryker's `MutantResult` this reporter reads.
*/
interface TestedMutant {
  status: string;
}

/**
The signals stryker's `UnexpectedExitHandler` treats as a stop.
*/
const STOP_SIGNALS = ['SIGABRT', 'SIGHUP', 'SIGINT', 'SIGTERM'] as const;

/**
The slice of `process` that signal handling needs.
*/
export interface SignalTarget {
  on: (event: string, listener: () => void) => unknown;
  off: (event: string, listener: () => void) => unknown;
  removeAllListeners: (event: string) => unknown;
}

/**
A repeat stop signal: stryker is already saving and exiting.
*/
function ignoreRepeatStop(): void {
  // Deliberately nothing.
}

/**
 * After the first stop signal, keep every later one from reaching stryker.
 *
 * Stryker 10 saves a partial incremental report when a run is stopped
 * (stryker-js#5986), but a second signal while it shuts down forces an exit
 * without one (#6257). Measured (plan.md, 2026-11-07): stopping a gate by
 * signalling its whole process tree delivers exactly that -- stryker's own
 * SIGTERM and the gate's forward, 7ms apart -- and a run stopped 1h40m in
 * left `reports/` empty. Nothing outside stryker can tell the two apart.
 *
 * On the first stop signal every stop listener is replaced with one that does
 * nothing, so repeats neither reach stryker nor fall to the default kill.
 * Node hands that first signal to a copy of the listener list, so stryker's
 * own handler still runs for it, saves, and exits. A run that hangs instead
 * is the gate's to end: it SIGKILLs the group after
 * `mutationLock.stopGraceSeconds`. Returns the function that undoes it.
 */
export function absorbRepeatStopSignals(target: SignalTarget): () => void {
  const firstStop = (): void => {
    for (const signal of STOP_SIGNALS) {
      target.removeAllListeners(signal);
      target.on(signal, ignoreRepeatStop);
    }
  };
  for (const signal of STOP_SIGNALS) {
    target.on(signal, firstStop);
  }
  return () => {
    for (const signal of STOP_SIGNALS) {
      target.off(signal, firstStop);
      target.off(signal, ignoreRepeatStop);
    }
  };
}

/**
 * Everything the reporter touches outside itself, so tests can drive it with
 * a fake clock and writer. `write` must be atomic; `schedule` and `onExit`
 * return the function that undoes them.
 */
export interface ProgressIo {
  environment: Readonly<Record<string, string | undefined>>;
  now: () => number;
  pid: number;
  write: (filePath: string, content: string) => void;
  remove: (filePath: string) => void;
  schedule: (callback: () => void, ms: number) => () => void;
  onExit: (listener: () => void) => () => void;
  signals: SignalTarget;
}

/**
At most one write per this many ms. The latest state is always flushed.
*/
const WRITE_INTERVAL_MS = 5000;

/**
 * Write `content` to `filePath` through a temp file and a rename, so a waiter
 * reading the holder file never sees half of it.
 */
export function writeAtomically(filePath: string, content: string): void {
  const temporary = `${filePath}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, filePath);
}

export function defaultIo(): ProgressIo {
  return {
    environment: process.env,
    now: () => Date.now(),
    pid: process.pid,
    write: writeAtomically,
    remove: (filePath) => {
      rmSync(filePath, { force: true });
    },
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      // A pending flush must not keep stryker alive after it is done.
      timer.unref();
      return () => {
        clearTimeout(timer);
      };
    },
    onExit: (listener) => {
      process.once('exit', listener);
      return () => {
        process.off('exit', listener);
      };
    },
    signals: process,
  };
}

interface Target {
  file: string;
  holder: Holder;
}

/**
The holder this run writes, or `undefined` when the env does not ask for one.
*/
function targetFrom(io: ProgressIo): Target | undefined {
  const {
    GUARDRAILS_LOCK_HOLDER_FILE: file,
    GUARDRAILS_LOCK_RUNG: rung,
    GUARDRAILS_LOCK_REPO: repo,
  } = io.environment;
  if (
    file === undefined ||
    file === '' ||
    repo === undefined ||
    repo === '' ||
    !isRung(rung)
  ) {
    return undefined;
  }
  return {
    file,
    holder: {
      repo,
      rung,
      pid: io.pid,
      startedAt: io.now(),
      // No event marks the dry run's start. The reporter is built just before
      // stryker instruments and dry-runs, and the dry run is the long part.
      phase: 'dry-run',
      tested: 0,
      total: 0,
      reused: 0,
      survived: 0,
    },
  };
}

/**
 * The reporter itself, with its outside world injected. Stryker constructs
 * `GuardrailsProgressReporter`, which is this with the real one.
 */
export class ProgressReporter {
  readonly #io: ProgressIo;
  readonly #target: Target | undefined;
  #lastWrite = 0;
  #cancelFlush: (() => void) | undefined;
  #stopListening: (() => void) | undefined;
  #removeFile: (() => void) | undefined;
  #stopAbsorbing: (() => void) | undefined;
  #done = false;

  constructor(io: ProgressIo) {
    this.#io = io;
    const target = targetFrom(io);
    this.#target = target;
    if (target === undefined) {
      return;
    }
    this.#flush(target);
    const remove = (): void => {
      try {
        io.remove(target.file);
      } catch {
        // Never fail a run over a label.
      }
    };
    this.#removeFile = remove;
    this.#stopListening = io.onExit(remove);
    this.#stopAbsorbing = absorbRepeatStopSignals(io.signals);
  }

  #update(change: (holder: Holder) => void): void {
    const target = this.#target;
    if (target === undefined || this.#done) {
      return;
    }
    change(target.holder);
    const sinceWrite = this.#io.now() - this.#lastWrite;
    if (sinceWrite >= WRITE_INTERVAL_MS) {
      this.#flush(target);
      return;
    }
    this.#cancelFlush ??= this.#io.schedule(() => {
      this.#flush(target);
    }, WRITE_INTERVAL_MS - sinceWrite);
  }

  #flush(target: Target): void {
    this.#cancelFlush?.();
    this.#cancelFlush = undefined;
    this.#lastWrite = this.#io.now();
    try {
      this.#io.write(target.file, JSON.stringify(target.holder));
    } catch {
      // Never fail a run over a label.
    }
  }

  onMutationTestingPlanReady(event: PlanReadyEvent): void {
    this.#update((holder) => {
      holder.phase = 'mutating';
      holder.total = event.mutantPlans.length;
      holder.reused = event.mutantPlans.filter(
        (plan) => plan.plan === 'EarlyResult',
      ).length;
      holder.mutatingSince = this.#io.now();
    });
  }

  onMutantTested(result: TestedMutant): void {
    this.#update((holder) => {
      holder.tested += 1;
      if (result.status === 'Survived') {
        holder.survived += 1;
      }
    });
  }

  /**
  The run is over: the holder file goes, and nothing writes it again.
  */
  onMutationTestReportReady(_report: unknown, _metrics: unknown): void {
    this.#done = true;
    this.#cancelFlush?.();
    this.#cancelFlush = undefined;
    this.#stopListening?.();
    this.#stopListening = undefined;
    this.#stopAbsorbing?.();
    this.#stopAbsorbing = undefined;
    this.#removeFile?.();
  }
}

/**
The class stryker constructs: zero-arg, injecting nothing.
*/
export class GuardrailsProgressReporter extends ProgressReporter {
  static readonly inject = [] as const;

  constructor() {
    super(defaultIo());
  }
}

/**
What `--appendPlugins` loads: the object `declareClassPlugin` would return.
*/
export const strykerPlugins = [
  {
    kind: 'Reporter',
    name: PROGRESS_REPORTER,
    injectableClass: GuardrailsProgressReporter,
  },
] as const;
