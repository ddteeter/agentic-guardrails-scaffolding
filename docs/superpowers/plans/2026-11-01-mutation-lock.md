# Mutation lock on every rung — implementation plan

Spec: `docs/superpowers/specs/2026-11-01-mutation-lock-design.md`. Lands on
`worktree-push-lock-skip` (PR #146, held as draft for this). Follow-ups:
#147 (queue ordering), #148 (early abort).

Every step: failing test first → green → `guardrails verify` clean → commit.
Run `npm run build` after any `src/` change before trusting the gate. The
hook source is `.githooks/pre-push`; the build copies it into the template.

## Part A: the lock moves into `runStryker`

1. **`mutationLock` config.**
   - Add `mutationLock: { commitWaitSeconds, pushWaitSeconds }` to
     `RepoConfig` (`src/config.ts`). Defaults are 60 and 10800, read with
     `pickPositive` like `hookDeadlineSeconds`.
   - `GUARDRAILS_GATE_LOCK_TIMEOUT` is the fallback for `pushWaitSeconds`
     when the key is absent.
   - Config check: a warning when `commitWaitSeconds` ≥
     `hookDeadlineSeconds`.
   - Tests in `test/config.test.ts`: the defaults, overrides, the env
     fallback, junk values, and the warning.
   - **Done when:** `loadConfig` returns the new object.
2. **`src/mutation-lock.ts`, the pure part.**
   - `waitFor(rung, lockConfig)` returns `{ waitSeconds, onTimeout:
'defer' | 'block' } | undefined`. The answers are: stop → 0/defer,
     commit → n/defer, push → n/block, ci → undefined.
   - `lockerArgv(tool, lock, wait, command, args)` builds the lockf form
     (`-k -s -t`) and the flock form (`-w -E 75`).
   - `detectLocker(exec)` returns `'lockf' | 'flock' | undefined`.
   - **Done when:** each is tested for every rung and tool.
3. **Process-group spawn and kill (measured risk 1).**
   - `ExecOptions.processGroup` spawns with `detached: true`.
   - `terminateChildren` kills `-pid` for group children.
   - The CLI forwards SIGINT/SIGTERM to the groups it owns.
   - Live test with a real locker (skipped when none is installed): spawn
     `locker … sleep 30` as a group, call `terminateChildren`, and assert
     the grandchild is gone and the lock is free.
   - **Done when:** that test passes. The same test against today's code
     would fail.
4. **`runStryker` spawns under the lock.**
   - It wraps the stryker exec with `lockerArgv` when `waitFor` says to,
     with `processGroup: true`.
   - Before the real wait, it tries the lock with a zero wait and prints
     the existing waiting line if that fails. Progress lines go to a new
     `VerifyOptions.progress` sink (default stderr).
   - Exit 75 means timeout. On defer it returns a `guardrails/mutation-deferred`
     **warning**. On block it returns a violation that carries the `ship`
     marker wording.
   - Any other non-zero exit from the locker before stryker starts means
     "lock unusable": stryker runs unlocked, with the warning. Telling this
     apart from a stryker exit uses the holder file (step 6). Until step 6
     lands, it uses a pre-check that the lock file can be opened.
   - No locker means stryker runs unlocked, with a single note.
   - `spawnFailed` stays "stryker missing": locker detection happens first,
     so a missing `lockf` never looks like a missing stryker.
   - Tests use a stub exec, one per outcome-table row of the spec, and each
     pins the next-action clause.
   - **Done when:** all of those pass, and the existing stryker tests pass
     unchanged (ci has no lock, so their argv is unchanged).
5. **Remove the shell lock and the probe.**
   - Delete `gate-lock`, `push-lock.ts` and their tests. From
     `.githooks/pre-push`, delete the probe and the locker branches. Keep
     the install check, the gate, the exit-75 → timeout wording and the
     block wording.
   - Update `templates.test.ts`. The lock tests move to step 4's live test,
     and the hook tests keep only the pass/block/timeout-wording checks.
   - knip decides whether `isRememberedPass` and `isAnalyzerSelected` stay.
     Remove whichever is no longer used.
   - **Done when:** the build mirror is identical and the suite is green.

## Part B+C: who holds the lock, its progress, the queue, and the advice

**Revised 2026-11-01.** One mechanism replaces the plan's separate
holder-writer wrapper (old step 6) and progress plugin (old step 8): the
progress reporter plugin also writes the holder file. The plugin runs inside
stryker, and stryker only starts once the lock is held, so what it writes
belongs to the holder by construction.

Verified against stryker 10.0.0: `--appendPlugins` accepts an absolute path
and loads it with `import()`. A plugin is the plain object
`{ kind: 'Reporter', name, injectableClass }` (that is all
`declareClassPlugin` returns), exported as `strykerPlugins`. The plugin
therefore needs no runtime import of `@stryker-mutator/api`. The reporter
events are:

- `onDryRunCompleted`
- `onMutationTestingPlanReady({ mutantPlans })`: each plan is `'Run'` or
  `'EarlyResult'`
- `onMutantTested(result)`: `result.status` is `'Survived'`,
  `'NoCoverage'`, …
- `onMutationTestReportReady`

6. **`src/lock-holder.ts`, pure.**
   - `holderPath(lockPath)` returns `<lock>.holder.json`.
   - `Holder` has the fields `{ repo, rung, pid, startedAt, phase:
'starting'|'dry-run'|'mutating', tested, total, reused, survived,
mutatingSince? }`.
   - `readHolder(path, readFile, isAlive)` returns `Holder | undefined`.
     Missing, garbage, or a dead pid all give `undefined`, which callers
     word as "another checkout".
   - `describeHolder(holder, now)` gives e.g. `dialed-163 (push) is
mutating, 62% (160/258), ~4m left`. The estimate is the rate since
     `mutatingSince` applied to the mutants remaining. With no estimate yet,
     the time-left clause is omitted.
   - Tests cover each phase, the estimate, the repo label (basename of the
     repo path), stale, and garbage.
7. **`src/stryker-progress-plugin.ts` → `dist/stryker-progress-plugin.mjs`**
   (add it as a tsup entry and a knip entry, and reconcile fallow).
   - Reads `GUARDRAILS_LOCK_HOLDER_FILE`, `GUARDRAILS_LOCK_RUNG` and
     `GUARDRAILS_LOCK_REPO` from the env. Unset means it does nothing.
   - Writes the holder file on construction, then updates it on each event,
     throttled to one write per 5s (the last write is always flushed).
     Writes are atomic (temp file + rename). It removes the file on
     `onMutationTestReportReady` and on process `exit`.
   - Every fs error is swallowed: the plugin never fails a run.
   - The class takes an injectable writer and clock for tests, and its
     `static inject` is `[]`.
   - Unit tests drive the events.
8. **`runStryker` loads the plugin when the run is locked.**
   - `runUnderLock` gains an optional `holder` (plugin path, repo, rung). For
     the locked spawn only, it appends `--appendPlugins <plugin>`, adds the
     reporter to `--reporters json,guardrails-progress`, and sets the three
     env vars (`env: { ...process.env, … }`).
   - The plugin path resolves next to the running module
     (`new URL('./stryker-progress-plugin.mjs', import.meta.url)`). Tests
     stub exec.
   - The drift guard (`test/drift/stryker-runner.test.ts`) runs real stryker
     with the BUILT plugin and asserts that the holder file appeared during
     the run (and is gone after). It uses a config with a `plugins` entry.
9. **Queue count.** `waitingCount(exec, lockPath, holderPid)` runs
   `ps -Ao pid=,ppid=,command=` and counts `lockf`/`flock` lines that
   contain the lock path. It excludes the holder's own locker (the holder
   pid's ppid) and the zero-wait probes (`… true`). Tests use canned `ps`
   output, including another lock's waiters, which must not be counted.
10. **Messages name the holder and the queue.**
    - The deferred, waiting and timeout messages use `describeHolder` and
      fall back to "another checkout".
    - While the real wait is pending, `runUnderLock` prints `still waiting
(<k> ahead): <describeHolder>` every 60s. The interval and clock are
      injectable. The timer is cleared on settle.
    - `abandonGate` gains "it was waiting for the mutation lock (held by
      …)" when a wait was in progress.
    - A config warning when `commitWaitSeconds` ≥ `hookDeadlineSeconds`.
    - The skills and fixer prompts get one line each on `mutation-deferred`:
      `crushing-mutants`, and `guardrails-plugin/agents/` → rebuild → commit
      `.github/agents/`.
11. **`guardrails lock-status`.**
    - Prints the holder description and the number waiting, or `the
mutation lock is free`. Exits 0.
    - Says to run it once for an estimate and not to poll it.
    - Listed in the usage text, with CLI tests over a temporary lock path.

## Part D: dogfood and record

12. **Docs and the finding.**
    - Update the `plan.md` entry: commit-rung serialization is now fixed,
      along with the measured orphan risk. Link #147 and #148.
    - Update `docs/live-loop-verification.md` if it describes the shell
      lock.
13. **Live check on this machine**, recorded in the PR:
    - two worktrees commit at once, and one defers with the advice;
    - a push waits, and its progress lines name the holder;
    - `lock-status` shows the queue;
    - Ctrl-C on a waiting push leaves no stryker behind.

## Risks carried into execution

- **The commit gate may run stryker twice per agent commit** (PreToolUse
  plus husky). Check it during step 13. If confirmed, file it; don't fix it
  here unless it's trivial.
- **`--appendPlugins` with a consumer whose config already lists plugins.**
  The drift guard should use a config that has a `plugins` entry.
