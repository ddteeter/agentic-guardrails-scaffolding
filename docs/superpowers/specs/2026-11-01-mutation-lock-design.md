# Hold the machine lock around mutation testing, on every rung — design

Status: draft for review. Supersedes the shell lock and the `gate-lock` probe
on PR #146 (held for this). Queue ordering is out of scope (#147).

## Problem

The machine-wide lock exists because concurrent stryker runs thrash the
machine. It wraps the wrong thing in two ways:

1. **Too narrow: it only covers the push rung.** Stryker's floor is `commit`,
   so every agent commit mutates its staged files without the lock. On
   2026-11-01 two dialed.run worktrees ran stryker at the same time (load
   around 34) while five pushes waited on the lock. Adopters have seen the
   same thing.
2. **Too wide: it covers the whole push gate.** eslint, tsc, knip and the
   graph checks hold the lock with stryker. #146 worked around this with a
   probe, `gate-lock`, that skips the lock when stryker will not run. That
   is a second copy of a decision `runStryker` already makes.

## Design

**The lock moves into `runStryker`.** The stryker spawn itself runs under the
locker:

`lockf -k -s -t <wait> <lock> <stryker> run …` (BSD/macOS), or
`flock -w <wait> -E 75 <lock> <stryker> run …` (util-linux).

These are the same tools, flags and lock file (`GUARDRAILS_GATE_LOCK`,
default `~/.guardrails-gate.lock`) the hook uses today. The lock is held for
exactly the stryker run, on whichever rung runs it. A push or commit with
nothing in mutate scope never touches it, which removes the need for a probe
by construction.

**How long each rung waits:**

| Rung   | Wait for the lock                              | If the wait runs out                                                     |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| stop   | 0s: try once                                   | **defer** to commit (`guardrails/mutation-deferred`, non-blocking)       |
| commit | `mutationLock.commitWaitSeconds` (default 60)  | **defer** to push (same warning)                                         |
| push   | `mutationLock.pushWaitSeconds` (default 10800) | **block**, with the existing "gave up waiting" wording that `ship` reads |
| ci     | no lock                                        | n/a                                                                      |

- **Where the waits are set.** `guardrails.config.json`, under a
  `mutationLock` object. These are per-repo policy, so they live in the
  repo's checked-in policy file.
  - The lock **path** stays the `GUARDRAILS_GATE_LOCK` env var. Which lock
    to share is a fact about the machine, not the repo, and a repo-level
    path would split the one queue the lock exists for.
  - `GUARDRAILS_GATE_LOCK_TIMEOUT` is read as a fallback for
    `pushWaitSeconds`, with a note saying so, so existing setups keep
    working.
- **Stop never waits.** Stryker is off this rung by default. A consumer who
  moves it here wants per-turn mutation feedback, but a busy machine should
  not hold up every turn. Waiting would stall the agent and race the 240s
  hook deadline, which ends in "turn not checked", a worse outcome than a
  clean deferral. The commit rung picks the files up next. The deferral is
  a warning, not a violation, so it never writes a manifest or names a
  fixer.
- **Why deferring a commit is safe.** Push and CI re-run mutation testing
  over the whole branch, so a deferred commit escapes nothing. A commit also
  cannot afford to wait: the PreToolUse gate is abandoned at
  `hookDeadlineSeconds` (240), which happened twice in this session under
  load.
- **CI has no lock.** A runner has no other gates to contend with, and a
  locker may not be installed there.

**Messages.** Both lockers stay silent while they wait, so `runStryker`
first tries the lock with a zero wait. If that fails, it prints the
existing "another checkout is running the gate — waiting…" line, and only
then waits for real. That is the same order the hook uses today, moved into
Node. With no locker installed, stryker runs unserialized with the existing
note.

**Every lock outcome tells the agent what to do next.** An agent that is
just told "lock busy" retries in a loop, waits in the foreground, or reaches
for `--no-verify`. So each outcome has one message, pinned by a test, that
names the next action.

| Outcome                         | Rungs        | What the agent is told                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Got the lock straight away      | all          | Nothing.                                                                                                                                                                                                                                                                                                         |
| Waited, then got it             | commit, push | `waited <n>s for the mutation lock (held by <holder>).` Informational.                                                                                                                                                                                                                                           |
| Deferred                        | stop, commit | `mutation testing deferred: <holder> holds the machine lock. <files> will be mutation-tested at <next rung>. Nothing to do — do not retry to force it, and do not wait for the lock.`                                                                                                                            |
| Push gave up waiting            | push         | The existing `ship` marker, plus `<holder> still holds it. Re-run the push to re-queue — in the background if your harness supports it. Never --no-verify. If <holder> is not running, the lock is free on its own (it is held on a file descriptor) — report it rather than deleting <lock>.`                   |
| No locker installed             | all          | `no lockf or flock — mutation testing runs unserialized. Install util-linux (flock) to serialize.` Once per run.                                                                                                                                                                                                 |
| Lock file unusable              | all          | A locker error that is not a timeout (unwritable `$HOME`, a sandbox). Stryker runs **unserialized** with `could not open <lock> (<error>) — running unserialized; set GUARDRAILS_GATE_LOCK to a writable path.` A broken lock must never read as a stryker failure or a block.                                   |
| Hook deadline hit while waiting | stop, commit | The existing abandon message gains: `it was waiting for the mutation lock (held by <holder>); <n>s commit wait plus the run exceeded hookDeadlineSeconds.` This should only happen when `commitWaitSeconds` is set close to the deadline. A config check warns when `commitWaitSeconds` ≥ `hookDeadlineSeconds`. |

- **`<holder>`.** The run that gets the lock writes
  `<lock>.holder.json` (repo path, rung, pid, start time) and removes it when
  it finishes. A waiter reads it to name who it is waiting on.
  - If the pid is dead, the file is stale. The waiter reports it as
    "unknown holder" and does not trust it.
  - Never trusted for locking: the advisory lock itself stays the only
    authority. The file only labels it.
- **The wording is consumer-generic.** No Claude Code tool names. "In the
  background if your harness supports it" covers Codex and Copilot as well.
- **The skills and fixers learn the deferral.** `crushing-mutants` and the
  fixer prompts get one line each: a `mutation-deferred` warning is not
  theirs to act on.

**Progress and the queue are visible.** Other agents are often left
wondering how far along the lock holder is.

- **A guardrails stryker reporter plugin** lives in `dist/` and is loaded
  with `--appendPlugins`, which adds to a consumer's plugin list rather than
  replacing it. It uses stryker 10's reporter events:
  `onDryRunCompleted`, `onMutationTestingPlanReady` (how many mutants will
  run versus be reused from the incremental cache), `onMutantTested` and
  `onMutationTestReportReady`.
  - It writes phase, tested/total, survivors so far, elapsed time and an
    estimate of time left into `<lock>.holder.json`. Writes are atomic
    (temp file + rename) and happen at most every 5s.
  - It never fails a run: every write error is swallowed.
  - It does not parse stryker's built-in text progress output, which can
    change between versions.
- **Queue count from `ps`.** Every waiter is a `lockf`/`flock` process with
  the lock path in its argv. Once the lock wraps only stryker, every one of
  them is a stryker run, so counting them (minus the holder's pid) is exact
  and needs no registration.
- **Waiters print a line every 60s** while their background lock wait runs,
  e.g. `still waiting (2 ahead): dialed-163 (push) is mutating, 62%
(160/258), ~4m left`. The holder prints its own progress lines to stderr.
- **`guardrails lock-status`** prints the holder, its rung, progress, time
  left and the number waiting. The advice says to run it once when an
  estimate is needed, not to poll it.
- **Drift guard.** `test/drift/stryker-runner.test.ts` also asserts the
  plugin's progress file appears. If a stryker upgrade breaks the plugin
  API, the build fails rather than going quiet.

**What is removed:**

- The `gate-lock` command, `push-lock.ts`, and the lock branches in
  `.githooks/pre-push`. None of these has shipped in a release, so there is
  no deprecation.
- Kept: `strykerScope`, `isAnalyzerSelected` and `isRememberedPass`. They
  are good seams anyway. Cut whichever is left unused, since knip will flag
  them.
- The hook returns to "install check, then gate". It keeps the exit-75 →
  lock-timeout wording, because `ship` reads it.

**Kept from #146:** the husky advice (chain `sh .githooks/<hook>`), the hook
header fixes, `.husky/pre-push` chaining the script, and the `plan.md`
entry. The entry gets updated, since the commit-rung finding is now fixed.

## Risks to measure before relying on them

1. **An abandoned gate leaves an orphaned stryker. MEASURED 2026-11-01: it
   does, and the lock is freed.** I sent SIGTERM to `lockf -k … sh -c
'sleep 30'`. The child survived, and the lock was immediately free, so a
   killed gate would leave stryker running unlocked. That is the worst case.
   **Fix:** spawn the locker in its own process group (`detached: true`) and
   kill the group (`process.kill(-pid)`). A detached group no longer gets
   the terminal's Ctrl-C, so the CLI must forward SIGINT/SIGTERM to the
   groups it owns. There is a live test for both.
2. **An agent commit may run commit-rung stryker twice**, once at PreToolUse
   and once in husky's pre-commit. Incremental mode should make the second
   run cheap, but under the lock it also queues twice. To check on a real
   commit. Fixing it (e.g. a commit-rung memo) is a separate item unless it
   turns out to be cheap.
3. **`STRYKER_*` / exec plumbing.** `resolveBin('stryker')` gives a path,
   and the locker is a prefix command. `spawnFailed` must still mean
   "stryker missing", not "lockf missing". That needs locker detection up
   front.

## Tests (outline)

- **Pure:** the rung → wait/timeout-behaviour mapping, and the locker argv
  builders for lockf and flock.
- **`runStryker` with a stub exec:**
  - the stryker invocation is wrapped in the locker on push and commit, and
    not on ci;
  - a 75 from a commit run gives the deferred warning, and the run is not
    blocked;
  - a 75 from a push run gives the timeout wording.
- **Live, with a real locker** (the pattern from `templates.test.ts`): while
  another process holds the lock, a commit-rung run defers within its wait,
  and a push-rung run waits.
- **Risk 1** as a live test: kill the gate and assert no stryker survives. Ctrl-C is forwarded.
- **One test per row of the outcomes table.** Each pins the message's
  next-action clause, not just that a message appears. The push timeout row
  also pins the `ship` marker.
- **The config check.** It warns when `commitWaitSeconds` ≥
  `hookDeadlineSeconds`.

## Decisions (2026-11-01)

- The commit wait is set in `guardrails.config.json` (`mutationLock`), not
  an env var. The lock path stays an env var, because it is a property of
  the machine.
- The stop rung tries the lock once and then defers. It never waits.
