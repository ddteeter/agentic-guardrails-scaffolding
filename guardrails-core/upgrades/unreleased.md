---
version: unreleased
supersedes:
  - search: 'local main'
    because: 'if it tells an agent to fast-forward or pull local main before a push so the gate scopes correctly, the gate now measures from the merge-base and local main no longer matters'
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

## Instructions this supersedes

- Any step that fast-forwards or pulls local `main` before a push so that the
  push gate's scope is right.

## What to wire

- Nothing.
