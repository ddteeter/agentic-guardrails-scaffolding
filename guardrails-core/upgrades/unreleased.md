---
version: unreleased
supersedes:
  - search: 'ready to ship'
    because: 'lanes ship themselves now: `guardrails ship` in the background, one wake per ship, and the machine-wide lock queues the pushes'
  - search: 'only the coordinator pushes'
    because: 'lanes ship themselves now; a coordinator merges and cleans up'
  - search: 'does not push'
    because: 'lanes ship themselves now, with `guardrails ship` run in the background'
  - search: 'gh pr checks --watch'
    because: 'a foreground wait the PreToolUse hook denies; `guardrails ship` waits for CI as one background command'
  - search: 'gh pr comment'
    because: 'if it attaches media after shipping, `guardrails ship --attach=<file>` does it'
  - search: 'force-with-lease'
    because: 'if it is a manual push before `guardrails ship`, pass `--force-with-lease` to ship instead'
wire:
  - kind: script
    name: ship
    value: 'guardrails ship'
    because: 'gives lanes and docs one name for push, open the PR and wait for CI, run in the background'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **Lanes ship themselves.** Guardrails' own docs used to say a coordinator
  keeps lanes at "ready to ship" and runs every push itself. That rule only
  guarded against foreground waits re-paying a large context every ten
  minutes, and those are now denied by the PreToolUse hook and replaced by
  `guardrails ship`. A lane that is still active ships with
  `guardrails ship --body-file=<f>` under `run_in_background`, is woken once
  with one status, and fixes its own gate or CI failure. A coordinator merges
  and cleans up.
- **`guardrails ship --help`** prints usage and pushes nothing. The PreToolUse
  hook lets it through.
- **`guardrails ship --force-with-lease`** pushes a branch rebased since its
  last push. Without the flag, git's rejection comes back as `error`, and its
  tail ends with a line naming the flag.
- **`guardrails ship --attach=<file>[#alt text]`** (repeatable) attaches an
  image or video. It goes on a new PR as the PR opens, or on an open PR as
  one comment, posted again on each run.
- **`ship-status.json` has `warnings`**, always present. A failed upload goes
  there and on the printed line, and never changes `state`.

## Instructions this supersedes

- **"Lanes stop at ready to ship / only the coordinator pushes"** and its
  variants: replace with "a lane ships with `guardrails ship` in the
  background; a coordinator merges and cleans up". Keep any rule about _who
  merges_. Only _who pushes_ changed.
- **A follow-up `gh pr comment --attach` after shipping**: fold it into
  `ship --attach`. A `gh pr comment` for anything else stays.
- **A manual `git push --force-with-lease` before `ship`**: use
  `ship --force-with-lease`.

## What to wire

- A `ship` script in `package.json` running `guardrails ship`, if lanes or docs
  call it by script name. Leave it out if they call the CLI directly.
