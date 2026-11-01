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

| Rung   | Wait for the lock                                       | If the wait runs out                                                                                     |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| push   | `GUARDRAILS_GATE_LOCK_TIMEOUT` (default 10800s, as now) | block, with the existing "gave up waiting" wording that `ship` reads                                     |
| commit | `GUARDRAILS_GATE_LOCK_COMMIT_TIMEOUT` (default 60s)     | **defer**: skip stryker for this commit and report a non-blocking `guardrails/mutation-deferred` warning |
| ci     | no lock                                                 | —                                                                                                        |

- **Why deferring a commit is safe.** Push and CI re-run mutation testing
  over the whole branch, so a deferred commit escapes nothing. The commit
  also can't afford to wait: the PreToolUse gate is abandoned at
  `hookDeadlineSeconds` (240), which happened twice in this session under
  load. The 60s default leaves room for the run itself.
- **Not silent.** The warning names the lock and says the push will check
  these files.
- **CI has no lock.** A runner has no other gates to contend with, and a
  locker may not be installed there.

**Messages.** Both lockers stay silent while they wait, so `runStryker`
first tries the lock with a zero wait. If that fails, it prints the
existing "another checkout is running the gate — waiting…" line, and only
then waits for real. That is the same order the hook uses today, moved into
Node. With no locker installed, stryker runs unserialized with the existing
note.

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

1. **An abandoned gate leaves an orphaned stryker.** `abandonGate` sends
   SIGTERM to its direct children, which is now the locker rather than
   stryker. Does `lockf`/`flock` pass the signal on, or does stryker keep
   running unlocked? To check: spawn under each locker, SIGTERM the locker,
   and see whether stryker survives. If it does, spawn the locker in its own
   process group and kill the group.
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
- **Risk 1** as a live test once the fix exists.

## Open questions

1. The 60s commit wait: should it be configurable in
   `guardrails.config.json` rather than an env var? Env matches the
   existing lock knobs, so the plan uses env.
2. Should the Stop rung ever run stryker? Today it never does (floor is
   `commit`), but a consumer can move it with `analyzerRungs`. Proposal:
   treat it like commit (short wait, then defer).
