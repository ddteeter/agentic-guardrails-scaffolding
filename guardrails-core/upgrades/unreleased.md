---
version: unreleased
supersedes:
  - search: '.guardrails-gate.lock'
    because: 'if it tells agents to take the gate lock by hand around a stryker run, a build or a benchmark, `guardrails lock -- <cmd>` now takes the same lock, names the command to every gate queued behind it, and logs the run'
  - search: 'lockf -'
    because: 'if it wraps a command in `lockf` on the gate lock, use `guardrails lock -- <cmd>`: a hand-rolled holder reads to every waiting gate as "another checkout holds it"'
  - search: 'flock -'
    because: 'if it wraps a command in `flock` on the gate lock, use `guardrails lock -- <cmd>`: a hand-rolled holder reads to every waiting gate as "another checkout holds it"'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **`guardrails ship` runs the push gate before `git push` (#204).** It runs
  `gate --mode=push` itself, through the repo's own guardrails-core and with
  the hook's exact arguments, so the gate's wait for the machine-wide lock no
  longer holds the push's connection to the remote open. The pre-push hook
  then finds the gate's pass record (`cached: true`) and returns at once. If
  the record misses, the hook still gates in full; nothing tells it to skip.
- **The gate's exit decides the ship's state.** A block is `gate-blocked`
  and `failing` now lists each finding as `<file>:<line> <rule>` or
  `<file>:<line> added <kind>` (it was always empty). A lock timeout is
  `lock-timeout`. A gate that was killed, could not start or exited with any
  other code is `error`. Nothing is pushed on any of them.
- **A dropped connection after a green gate** is still `error`, and its tail
  now says the gate passed and to ship again.
- **ship stops with `error` if HEAD moves while the gate runs**, and warns in
  `warnings` when the working tree has uncommitted or untracked paths: the
  gate checks the working tree, but HEAD is what is pushed.
- **A ship's run-log `gateMs` sums both gates**, ship's own and the hook's.
- Known limit: with `enforcement: "warn"`, or a skipped analyzer, the gate
  records no pass, so the hook gates the push again in full.
- **A timed-out mutant is re-tested once, alone, before it counts as killed
  (#202).** After each stryker run, every `Timeout` that run measured with no
  killing test named (hit-limit timeouts excepted) is re-run in one more
  stryker run with `--concurrency 1`. One that times out again stays a kill;
  one that finishes takes the re-run's verdict. So a mutant that only timed
  out because the machine was busy can now block as `stryker/survived`, with
  a message saying it first timed out — write the test that kills it, as for
  any survivor. A run with such timeouts costs one more stryker run, dry run
  included, and its progress lines say how many were re-tested. At most
  `mutationTimeouts.retestLimit` (default 10) are re-tested per run; `0`
  turns it off. If the re-test cannot run, the timeouts stay kills and the
  gate says so.
- **`guardrails lock [--timeout=<seconds>] -- <cmd> [args…]` (#201)** runs
  any command under the machine-wide gate lock: it waits for the lock
  (`mutationLock.pushWaitSeconds` by default; `--timeout=0` tries once), runs
  the command with its output streamed, and exits with its code — or 75, with
  the gate's `gave up waiting for the gate lock` line, when the wait runs out.
  While it holds the lock, a gate queued behind it names it
  (`app is running npm under guardrails lock, 12m so far`) rather than
  `another checkout holds it`. With no `lockf`/`flock`, or a lock file it
  cannot open, it runs the command unserialized and says so.
- **A command under `guardrails lock` runs with `GUARDRAILS_GATE_LOCK_HELD`**
  set to the lock's path. A gate inside it (`guardrails lock -- git push`
  runs the pre-push gate) or a nested `guardrails lock` runs at once and says
  so, instead of queueing behind its own parent until it times out.
- **The run log has `kind: "lock"` rows**: the command's basename and a hash
  of its whole command line (not the argument values), exit code, signal,
  outcome (`ran`, `lock-timeout`, `unserialized`, `already-held`, `killed`)
  and the lock's queue and hold times. `guardrails stats` prints a `lock:`
  section for them. A tool that reads the log itself must skip kinds it does
  not know.

## Instructions this supersedes

- **Taking the gate lock by hand** — `lockf -k -t … ~/.guardrails-gate.lock
<cmd>`, `flock -w … ~/.guardrails-gate.lock <cmd>`, or a script or template
  (a pr-ready script, a mutation-baseline script) that does so: replace the
  wrapper with `guardrails lock -- <cmd>`, run in the background when the
  wait can be long.

## What to wire

Nothing, for a hook `guardrails init` scaffolded at 0.12.0 or later. A
`.githooks/pre-push` from before 0.12.0 wraps the gate in a shell `lockf` or
`flock` lock, which waits for the lock with the push's connection already
open, even when ship's own gate has passed. Refresh it with
`guardrails init --apply`.

Nothing for the timeout re-test either: it is on by default. Set
`mutationTimeouts.retestLimit` in `guardrails.config.json` only to change the
cap or, with `0`, to turn it off.

For `guardrails lock`: replace raw `lockf`/`flock` wrappers on the gate lock
in your own scripts and templates with
`node ./node_modules/guardrails-core/dist/cli.mjs lock -- <cmd>` (the
`supersedes` searches above find them). Nothing else to wire.
