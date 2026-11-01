# Skip the machine-wide gate lock when the push will not run stryker — implementation plan

Branch / worktree: `worktree-push-lock-skip` (`.claude/worktrees/push-lock-skip`).

## The problem

`.githooks/pre-push` (template: `guardrails-core/templates/githooks/pre-push`)
runs `gate --mode=push` under a machine-wide `lockf`/`flock` lock. The lock
exists because mutation testing runs on this rung ("mutation testing lives on
this rung"). Every push still queues, including pushes where stryker has
nothing to mutate, so a docs-only push can wait hours behind another
worktree's gate.

There is a second problem. This repo never takes the lock at all. Husky owns
`core.hooksPath` (`.husky/_`), so git ignores `.githooks/`, and
`.husky/pre-push` calls the bare `gate --mode=push` line. That is what
`foreignHooksPathWarning` (`src/scaffold/hooks-path.ts`) tells a husky user to
do, and the warning only mentions `pre-commit`. Every husky consumer who
follows the advice gets the gate without the lock.

## Design

**What decides "stryker will run" today.** In `runVerify`
(`src/verify/index.ts:2185`), stryker runs only if `selectAnalyzers` picks it
(mode not off, rung ≤ push, changed files present). Even then, `runStryker`
(`:1696`) returns early when `inScope` is empty. `inScope` is the changed TS
production files (not tests, not config, not executable entries) intersected
with the `mutate` positives in `stryker.conf.json`. All of that is git plus
file reads, which takes milliseconds.

**Probe.** A new pure-ish function, `pushLockDecision(options)`, lives in
`src/gate.ts`. It returns `{ needed: boolean; reason: string }`. The lock is
**not needed** when any of these hold:

1. the push-pass memo would hit (same `pushPassKey` + `loadPushPass` check as
   `runCommitGate`), so the gate will return `cached: true`;
2. stryker is not selected for the `push` profile (`selectAnalyzers` logic);
3. stryker's `inScope` is empty for the branch's changed files.

Any thrown error, or an unreadable diff, answers `needed: true`. Failing
toward the lock means a broken probe costs a wait, never a thrash.

**No second copy of the logic.** Two extractions keep the probe and the real
run from disagreeing:

- `strykerScope(options, files)` takes the `candidates` → `production` →
  `inScope`/`outOfScope` block out of `runStryker`. `runStryker` calls it.
- `isAnalyzerSelected(tool, …)` is a thin export over `selectAnalyzers`, so
  the probe asks the same question `runVerify` does.

**CLI.** A new top-level command, `guardrails gate-lock`, is used rather than
a flag on `gate --mode=push`. An older CLI that does not know a flag would
ignore it and **run the whole gate** inside the probe. An unknown command
falls to the usage `default:` and exits non-zero, which the hook reads as
"take the lock". Exit codes:

- `0` with one stderr line (`guardrails: no mutation testing on this push
(<reason>) — running the gate without the machine lock.`) means skip the
  lock;
- `1` means take the lock;
- anything else also means take the lock.

**Hook.** The template gains one branch after the install check and before
the locker selection:

```sh
if node "$cli" gate-lock; then
  /bin/sh -c "$gate"
  status=$?
elif command -v lockf >/dev/null 2>&1; then
  # … unchanged lockf / flock / unserialized branches …
```

Only exit 0 skips the lock. The probe writes its one line to stderr itself.
The skip path then falls through to the existing status handling, just like
the no-locker fallback.

**Accepted trade-offs:**

- **Probe-to-gate race.** If the tree changes between the probe and the gate,
  stryker can run unlocked once. The lock is about resources, not
  correctness, so this is accepted rather than closed. Closing it would mean
  the gate re-checking under an env flag and blocking.
- **Lighter analyzers run unserialized on a skip.** eslint, tsc, knip,
  depcruise and fallow are cheap next to mutation testing. That fits the
  template's stated reason for the lock.
- **This repo starts queuing.** Once `.husky/pre-push` chains the hook, this
  repo's stryker pushes share `~/.guardrails-gate.lock` with every other repo
  on the machine (e.g. dialed.run). That is the point, but it is a visible
  change. `GUARDRAILS_GATE_LOCK` gives the repo its own lock if wanted.
  `npm run test:coverage` and `check:graph` in `.husky/pre-push` stay
  outside the lock, as today.

## Steps

Each step is red → green → `guardrails verify` clean → commit.

1. **Extract `strykerScope`.** This is a pure refactor of `runStryker`, with
   no behaviour change. Its test, in `test/verify/` next to the existing
   stryker scope tests, pins that the scope is empty for test-only, config-only,
   out-of-glob and executable-entry change sets, and non-empty for an in-glob
   production file. **Done:** the existing stryker tests are unchanged and
   green, and the new tests are green.
2. **Export `isAnalyzerSelected`.** Tests: stryker `off` → false; stryker on
   with a rung override above push (`ci`) → false; no changed files → false;
   default → true. **Done:** `runVerify` still goes through `selectAnalyzers`
   (one source of truth) and the tests are green.
3. **`pushLockDecision` in `gate.ts`.** These tests go in
   `test/gate.test.ts` (or a sibling), with stubbed exec/readFile, as the
   push-memo tests already do. Each case pins its `reason`:
   - memo hit → not needed (`cached`);
   - stryker off → not needed;
   - empty scope → not needed;
   - in-scope file → needed;
   - unreadable diff → needed;
   - throwing readFile → needed.

   **Done:** all six are green, and mutation testing on `gate.ts` leaves no
   new survivors.

4. **`gate-lock` command + hook branch.**
   - `test/cli-core.test.ts`: exit 0 plus the stderr line when the lock is not
     needed, exit 1 when it is; it appears in the usage text.
   - `test/templates.test.ts`: the stub `cli.mjs` learns
     `FAKE_LOCK_EXIT`. Tests: the probe exiting 0 runs the gate even while the
     lock is **held** (reuses the `holder` pattern; the run must not print
     the waiting line); a probe exiting 1 or 2 behaves exactly like today
     (the existing timeout test, extended); and the probe is checked _after_
     the install check.
   - Run `npm run build` so `scripts/sync-agents.mjs` mirrors the template to
     `.githooks/pre-push`.

   **Done:** the hook tests pass on this machine's locker (lockf on macOS),
   and `.githooks/pre-push` is identical to the template.

5. **Foreign-hooksPath warning covers both hooks and chains the script.**
   `test/scaffold/hooks-path.test.ts`: the warning names both
   `.githooks/pre-commit` and `.githooks/pre-push`, and tells the user to
   add `sh .githooks/pre-commit` / `sh .githooks/pre-push` to their own
   hooks, not the bare `gate` lines. Check both call sites (`plan.ts:291`,
   `cli-core.ts:1685`) still read correctly. **Done:** the warning test is
   green and the init-command snapshot, if any, is updated.
6. **Dogfood: `.husky/pre-push` chains `sh .githooks/pre-push`.** It replaces
   the bare gate line and keeps `test:coverage` and `check:graph`. **Done:** a
   docs-only commit pushes with the skip line printed. A push touching a
   `src/` file prints the waiting line while another gate holds the lock
   (manual check, recorded in the PR).
7. **Record the finding.** Add an entry to `plan.md` → "Roadmap: fixer-loop
   hardening": this repo ran the push gate unlocked because the husky advice
   dropped the lock. Point to this plan.

## Decisions (2026-11-01)

- Command name: `gate-lock`.
- The lock stays machine-wide for every repo, this one included: the machine
  is the constrained resource, so a per-repo lock would bring back the
  contention it exists to prevent.
