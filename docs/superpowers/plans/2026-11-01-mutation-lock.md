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

## Part B: who holds the lock, and what the agent is told

6. **Holder file.**
   - Once the lock is acquired, the holder writes `<lock>.holder.json`
     (repo, rung, pid, startedAt), atomically. It is removed on exit.
   - The write happens INSIDE the locked command, so only the holder ever
     writes it: the locker runs a tiny `node <dist>/lock-holder.mjs` wrapper
     that writes the file and then execs stryker.
   - `readHolder(lock)` returns the holder, or `unknown` when the file is
     missing, stale (dead pid) or unparseable.
   - Tests: write/read/stale/garbage, plus the wrapper's live round trip.
7. **Advice wording, one message per outcome.**
   - All lock messages are built in `mutation-lock.ts`, with `<holder>` and
     `<n>` filled in.
   - `abandonGate` gains the "was waiting for the mutation lock" clause when
     a lock wait was in progress.
   - The wording is consumer-generic: no host tool names.
   - Tests: one per spec table row.
   - Add one line about `mutation-deferred` to the `crushing-mutants` skill
     and to the fixer prompts in `guardrails-plugin/agents/`, then rebuild
     and commit the regenerated `.github/agents/`.

## Part C: progress and the queue

8. **Reporter plugin.**
   - `src/stryker-progress-plugin.ts` builds to `dist/stryker-progress-plugin.mjs`.
   - It implements the four reporter events and writes progress into the
     holder file, atomically, at most every 5s. It never throws.
   - `runStryker` passes `--appendPlugins <dist path>` and adds its reporter
     to `--reporters json,…`.
   - Unit tests drive the events directly.
   - The drift guard (`test/drift/stryker-runner.test.ts`) asserts that the
     progress file appears on a real run.
9. **Queue count.**
   - `waitingCount(exec, lock, holderPid)` uses
     `ps -Ao pid=,command=` and counts lines containing the locker and the
     lock path, excluding the holder.
   - Tests use canned `ps` output, including another lock's waiters, which
     must not be counted.
10. **Live progress while waiting.**
    - While the lock wait is pending, `runStryker` prints
      `still waiting (<k> ahead): <holder> (<rung>) is <phase>, <pct>%
(<tested>/<total>), ~<eta> left` every 60s (an interval that can be
      injected in tests), and clears the timer on settle.
    - The holder prints its own progress lines.
    - Tests use a fake clock.
11. **`guardrails lock-status`.**
    - Prints the holder, rung, progress, ETA and number waiting, or "free".
      Exits 0.
    - Listed in the usage text.
    - Tests are CLI tests over a temporary lock path.

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
