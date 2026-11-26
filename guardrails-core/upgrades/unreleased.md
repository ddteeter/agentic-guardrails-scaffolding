---
version: unreleased
supersedes:
  - search: 'gate-blocked, lock-timeout, ci-red'
    because: 'if it lists the states `guardrails ship` can end in, add `preflight-failed`: a `ship.preflight` command that exits non-zero now stops the ship before the gate, naming the command in `failing`'
  - search: 'sh .githooks/pre-push'
    because: "if a hook chains cheap checks (a build, a fast test run) after `sh .githooks/pre-push`, they run only after the gate's wait for the lock; move them into `ship.preflight` in `guardrails.config.json`, which the scaffolded hook and `guardrails ship` both run before the gate"
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **`ship.preflight` runs cheap checks before the push gate (#243).** A new
  `guardrails.config.json` key, `"ship": { "preflight": ["npm run build",
"npm test"] }`, lists shell commands that `guardrails ship` runs after its
  own checks and before the gate, each with `sh -c` from the repository
  root, stopping at the first to fail. One that exits non-zero ends the ship
  in a new state, `preflight-failed`, with the command in `failing`, the last
  40 lines of its output in `tail`, and nothing pushed or gated. One that is
  killed or cannot start is `error`. An entry that is not a non-blank string
  is dropped and named in `warnings`. With the key missing or empty, ship
  behaves exactly as before. `--rerun-failed` never runs the commands.
- **`guardrails preflight [--mode=hook]`** runs the same list. The scaffolded
  `.githooks/pre-push` now calls it with `--mode=hook` before its gate line,
  so a plain `git push` runs the list too. A pass is recorded in
  `.guardrails/state/preflight-pass.json`, keyed by the tree fingerprint, the
  base ref, a hash of the list and the Node version, and only when the tree
  did not change while the commands ran. In hook mode, and in ship, a
  matching record skips the commands: the hook that ship's push fires does
  not run them a second time, and a ship retried on the same tree skips them.
  It exits 1 on a failure, ending with
  `guardrails: push stopped — preflight "<cmd>" failed`, which ship reads as
  `preflight-failed` when the hook stops a push.
- **ship's HEAD check now also covers the preflight commands**: a command
  that moves HEAD stops the ship with `error` before the gate.
- Known limit: the record cannot see environment variables, the network, or
  tools outside the repository. Keep commands whose result depends on them
  out of the list; CI stays authoritative.

## Instructions this supersedes

- **A list of ship's states** (`green`, `gate-blocked`, `lock-timeout`,
  `ci-red`, …) in an agent instruction file: add `preflight-failed`, and tell
  the lane to treat it like `gate-blocked` -- fix what the command reported,
  commit, and ship again.
- **Cheap checks chained after `sh .githooks/pre-push`** in a hand-written
  pre-push hook: move them into `ship.preflight`, and delete them from the
  hook, so they run once, before the gate. Leave a step that reads output a
  hook step before it writes (a coverage report from the test run, say) where
  it is.

## What to wire

- Re-run `guardrails init --apply`. `.githooks/pre-push` is owned, so an
  unedited copy is refreshed to the one that calls `guardrails preflight`.
- Move the cheap lines chained after `sh .githooks/pre-push` in your own
  hook into `ship.preflight`, and delete them from the hook.
- A hand-written pre-push hook that does not chain `.githooks/pre-push` adds
  `node ./node_modules/guardrails-core/dist/cli.mjs preflight --mode=hook || exit 1`
  before its gate line.
- Nothing, if you set no `ship.preflight`: the hook's `preflight` call then
  runs nothing and exits 0.
