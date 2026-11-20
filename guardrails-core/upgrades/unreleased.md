---
version: unreleased
supersedes:
  - search: 'local main'
    because: 'if it tells an agent to fast-forward or pull local main before a push so the gate scopes correctly, the gate now measures from the merge-base and local main no longer matters'
  - search: 'CONFLICTING'
    because: 'if it checks that the branch is up to date with, or not conflicting with, the base before `guardrails ship`, ship now refuses a branch that is behind or conflicting itself, before the push'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **The gate's changed files are measured from the branch's merge-base, not
  from local `main` (#179).** It diffed the working tree against the base
  ref, so a local `main` behind the commit the branch forked from added every
  upstream change the branch inherited, and one that had pulled since added
  every change `main` gained. Stryker's scope grew to files the branch never
  touched. The gate now diffs against `git merge-base HEAD <base>
origin/<base>`: the newest commit HEAD shares with either form of the base.
  Uncommitted edits and untracked files are still in the set. If no merge-base
  can be found (a shallow clone with no common history), the gate diffs
  against the base ref as before. Line-range planning for Stryker measures
  from the same commit.

- **`guardrails ship` reports `ci-red` at the first failed check (#178).**
  The watch is `gh pr checks --watch --fail-fast`, so ship returns as soon as
  any check fails, naming it in `failing`, and leaves the slower checks
  running. Before, it waited for every check to finish, which could be the
  better part of an hour after the first one went red. A `gh` too old for
  `--fail-fast` is watched without it.
- **`guardrails ship` refuses a branch that is behind its base, before the
  push and so before the gate lock.** It fetches `origin/<base>`. If HEAD does
  not contain it, the state is `conflicting` when the two would not merge
  cleanly (`failing` names the files, from `git merge-tree`) and `behind`
  when they would. Nothing is pushed. Rebase onto the base and ship again,
  with `--force-with-lease` if the branch was pushed before. If the base
  cannot be fetched or the ancestry cannot be read, ship pushes as before and
  says so in `warnings`.
- **A gate block is no longer misreported as `error`.** Ship looked for the
  "not installed" text anywhere in the push output, and the gate's own test
  output can contain it. Only the hook's last `push blocked` line decides it
  now.

- **The mutation-cache fingerprint counts only what can change a verdict
  (#177).** A local cache or a `seedFrom` seed was thrown away when anything
  in the stryker config or any lockfile differed, so a formatter bump or a
  `mutate` entry for another module made the next push gate cold. The
  fingerprint is now the stryker version, the stryker options without the
  keys that judge no mutant (`mutate`, reporters, thresholds, concurrency,
  logging and the like), and the installed versions of the runtime
  dependencies and the test stack, followed transitively. A refused seed's
  line now says which part differed. `mutationCache.verdictDependencies`
  adds packages to the dependency part. See docs/adoption.md ("The mutation
  cache between runs").
- **The first gate after upgrading runs cold once,** and seeds match again
  only once CI runs this version's `guardrails mutation-fingerprint`. The
  sidecar's fields were renamed, so one an older version wrote reads as no
  fingerprint.

- **A machine-wide run log, and `guardrails stats` (#176).** Every commit
  and push gate, every stop turn that mutated something, and every
  `guardrails ship` appends one JSON line to `<gate lock>.runs.jsonl`
  (`$HOME/.guardrails-gate.lock.runs.jsonl` by default): lock queue and hold
  times, whether stryker started warm and why not, dry-run and mutating
  times, mutant counts, ship push/gate/CI times, and the machine's load.
  `guardrails stats [--since=7d] [--repo=<name>] [--json]` summarizes it.
  See docs/adoption.md ("Agents and slow work").
- **Ship passes `GUARDRAILS_SHIP_ID` to `git push`,** so the pre-push gate's
  row names the ship that ran it.

## Instructions this supersedes

- Any step that fast-forwards or pulls local `main` before a push so that the
  push gate's scope is right.

- Any step that rebases or checks that the branch is up to date with the
  base before running `guardrails ship`. Ship refuses a branch that is
  behind with a state of its own; act on that instead.
- Any handling of the `guardrails ship` states that treats an unknown state
  as `error`: `behind` and `conflicting` are new, and both mean "rebase, then
  ship again".

- Any step that rebuilds gate, lock or ship timings from transcripts or by
  hand. `guardrails stats` reads them from the run log.
- Any step that avoids editing `stryker.conf.json`'s `mutate` array, or
  holds back a dependency bump, to keep other branches' mutation seeds
  usable. Neither invalidates a seed now unless the bump is to a runtime or
  test-stack dependency.

## What to wire

- CI that uploads mutation seeds must run this version's
  `guardrails mutation-fingerprint`, as before; nothing else changes.
