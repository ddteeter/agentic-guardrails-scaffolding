---
version: unreleased
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

## What to wire

Nothing, for a hook `guardrails init` scaffolded at 0.12.0 or later. A
`.githooks/pre-push` from before 0.12.0 wraps the gate in a shell `lockf` or
`flock` lock, which waits for the lock with the push's connection already
open, even when ship's own gate has passed. Refresh it with
`guardrails init --apply`.

Nothing for the timeout re-test either: it is on by default. Set
`mutationTimeouts.retestLimit` in `guardrails.config.json` only to change the
cap or, with `0`, to turn it off.
