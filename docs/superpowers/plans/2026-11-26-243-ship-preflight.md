# Plan #243 — `ship.preflight`: cheap checks before the push gate

Lane copies this to `docs/superpowers/plans/2026-11-26-243-ship-preflight.md`.

## Design

- Config: `"ship": { "preflight": ["npm run build", "npm test"] }` → `RepoConfig.ship.preflight: string[]`, default `[]`, parsed by a new `pickShip(raw.ship)` built on `pickNames` (config.ts). Missing key, a non-object `ship`, or a non-array value all give `[]`, and ship behaves exactly as today. A malformed entry is dropped and reported as a ship warning: `ship.preflight entry N is not a command; ignored`.
- Placement: in `shipOutcome` (ship.ts:1551), after the existing checks and before `pushStart` (:1562), so `pushMs` still measures only the gate and the push. Rename the existing `preflight()` (ship.ts:1492) to `prechecks()`, and update the test title at ship.test.ts:217.
- Execution: run each command as `exec('sh', ['-c', command], { cwd: repoRoot, env: gateEnvironment(options), input: '' })`, in order, and stop at the first failure. This matches seed-cache.ts:176. There is no timeout and no process group. Output is collected, not streamed.
- Verdict (mirrors `gateVerdict`):
  - exit 0 with no signal: next command;
  - non-zero exit: new state `preflight-failed`, with `failing: [command]` and the last 40 lines of its output plus `preflight "<cmd>" exited N. Nothing was pushed; the gate did not run.`;
  - killed by a signal, or failed to start: `error`.
  - Every stop goes through `withExistingPullRequest`.
- After all commands pass, call `headMoved` (ship.ts:634), so a command that commits can't lead into a gate on a different commit.
- There is no `--skip-preflight`. A matching `push-pass.json` does not skip preflight. `--rerun-failed` never runs preflight, as today. A retry after a dropped connection re-runs preflight.
- Run log: add `preflightMs` to `ShipTimes` if that's cheap; otherwise defer it.

## TDD steps (each green on its own)

0. Rename `preflight` to `prechecks`; no behaviour change.
1. Config key (config.test.ts): trims entries; missing key / `ship: 3` / a string value / `[1,"","x"]` give `[]` / `[]` / `[]` / `["x"]` plus malformed entries reported; `defaultConfig().ship` is `{preflight: []}`.
2. Passing preflight (ship.test.ts, describe "ship: preflight commands (#243)"): `sh -c` calls in order, after the conflicts check and before GATE_LINE, with cwd = root; the state is green.
3. Failing preflight: the state is `preflight-failed`, the failing command is named, the tail is 40 lines, there is no GATE_LINE, no `git push`, and the later commands never ran. Variant: an open PR is kept.
4. A signal or spawnFailed gives `error`, with no gate.
5. An empty or absent list makes no `sh` calls, and the calls match the baseline.
6. HEAD moved during preflight gives `error`, with no gate. Reword the `headMoved` message to cover both cases.
7. CLI (cli-core.test.ts): a config with `ship.preflight` runs the commands before the gate. `--help` lists `preflight-failed` and the key. `shipCommand` loads the config once. Fix the stale "five outcomes" comment (:1787).
8. Docs:
   - `docs/adoption.md`: the ship section's state list, a "Cheap checks before the gate (`ship.preflight`)" subsection that tells adopters to move cheap hook steps into it, and how a lane acts on `preflight-failed`.
   - `upgrades/unreleased.md`: the behaviour change, and what to wire. Hook steps stay for plain `git push`, so for now they run twice.
   - A `supersedes` entry that searches for agent instructions listing ship's states (`gate-blocked, lock-timeout, ci-red`).
9. Dogfood: in this repo, `guardrails.config.json` gets `"ship":{"preflight":["npm run check:graph"]}` (plus `test:coverage` if the owner agrees). `.husky/pre-push` is unchanged.

## Follow-up (file separately)

Pre-push hook skip: add a `guardrails preflight` subcommand with a pass record keyed like `push-pass.json`, and a hook template that calls it instead of listing the commands. That needs new record-safety reasoning and an upgrade path for hand-written hooks.

## Notes

- Any test that spawns a real `sh` or git must strip `GIT_*` from the environment (`cleanEnvironment()` in tree-fingerprint.test.ts:40).
- House rules: full names (`command`), no boolean compares, and keep `runPreflight` a small loop plus a `preflightVerdict` helper.
- `~/.claude/CLAUDE.md:40` lists ship's states. The owner edits it (it already lacks `behind` and `conflicting`).

## Owner decisions (2026-11-26)

- The hook skip is IN #243. It replaces the "Follow-up" section above.
- Dogfood `check:graph` only. Malformed entries are dropped and reported as a warning.

## Hook-skip half (steps H1–H8, after steps 0–8)

These steps change two things in steps 0–8. The runner lives in a new `src/preflight.ts` that ship imports. The scaffolded hook calls `guardrails preflight` itself.

### The pass record

- File: `.guardrails/state/preflight-pass.json` = `{fingerprint, base, commands}`, with no session scoping (a hook has no session).
- `fingerprint` and `base`: computed the way `pushPassKey` (gate.ts:951) computes them, minus the push-only check. `treeFingerprint` covers tracked and untracked files, the merge-base and the core version.
- `commands`: sha256 of `JSON.stringify(list)`.
- Write it only when every command passed, the fingerprint before the run equals the fingerprint after, and the list is non-empty. An undefined fingerprint means the commands run and nothing is written.

### The `guardrails preflight [--mode=hook]` command

- Exit 0: the commands passed, the list is empty, or (`--mode=hook` only) the record matched.
- Exit 1: a command failed, was killed, or could not start. A failure ends stderr on `guardrails: push stopped — preflight "<cmd>" failed` (`PREFLIGHT_FAILED_MARKER`); a kill or failed start on `guardrails: push stopped — no preflight verdict from "<cmd>"` (`PREFLIGHT_ERROR_MARKER`), which ship classifies as `error`. `<cmd>` is JSON-encoded.
- Without `--mode=hook`, it always runs the commands and refreshes the record.
- Malformed entries produce a warning on stderr.

### Steps

- H1. Create `src/preflight.ts`: the runner moves there, plus `preflightKey` and `isRememberedPreflight`.
  Tests: a match skips the run; a different list, fingerprint or base re-runs; a fingerprint that changes mid-run writes nothing; a failure writes nothing; an undefined fingerprint writes nothing.
- H2. `state-store.ts` gets `loadPreflightPass`/`savePreflightPass`; add the file to the state file list (~:484).
  Tests: round-trip, plus a malformed file and a file missing a field both read as undefined.
- H3. Ship writes the record and honours it, so a retry skips the commands.
  Tests: the record is written after a pass; a second ship on the same fingerprint makes no `sh -c` call; a failure leaves the record untouched.
- H4. `classifyPushFailure` (ship.ts:231) matches the marker and returns `preflight-failed`, with `failing` taken from the quoted command; a gate block still reads as `gate-blocked`.
- H5. Add a `preflight` entry to the cli-core command table, plus usage and help.
  Tests: a matching record with `--mode=hook` exits 0 and runs nothing; with no record the commands run and the record is written; a failure exits 1 with the marker; an empty list exits 0; a malformed entry warns on stderr.
- H6. `templates/githooks/pre-push`: put `node "$cli" preflight --mode=hook || exit 1` after the not-installed check and before the gate line. Copy it byte-for-byte to `.githooks/pre-push`.
  Tests (templates.test.ts stub CLI, :306): the line is present and comes before the gate; with `FAKE_EXIT=1` the hook exits 1 before reaching the gate.
- H7. `init`: the template is owned (scaffold/templates.ts:140), so `init --apply` refreshes it.
  Test: the planned `.githooks/pre-push` contains `preflight --mode=hook`.
- H8. Dogfood:
  - `guardrails.config.json` gets `"ship":{"preflight":["npm run check:graph"]}`.
  - `.husky/pre-push` becomes `sh .githooks/pre-push` then `npm run test:coverage`, with check:graph removed. The template now calls preflight, so it runs once.
  - Docs: adoption.md describes the record, `--mode=hook` and the exit codes.
  - Upgrade note, "What to wire":
    - move cheap lines chained after `sh .githooks/pre-push` into `ship.preflight` and delete them from the hook;
    - re-run `init --apply`;
    - a hand-written hook that doesn't chain `.githooks/pre-push` adds `node ./node_modules/guardrails-core/dist/cli.mjs preflight --mode=hook` before its gate line.
  - Supersedes entry: `search: 'sh .githooks/pre-push'`.

### Limits to document

- The record can't see env vars, the network, or tools outside the repo. Keep commands that depend on outside state out of preflight; CI stays authoritative.
- A message-only amend keeps the record (same tree). An amend that changes content invalidates it.

## Owner decisions, round 2 (2026-11-26)

- Ship honours the preflight record, so a retry skips commands that already passed.
- The record key includes `process.version`: `{fingerprint, base, commands, node}`.
- H-defaults (1)–(4) approved as written.
