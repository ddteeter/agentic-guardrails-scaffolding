# #204 — ship runs the push gate before `git push`

## Today

- `shipOutcome` (`guardrails-core/src/ship.ts`): preflight (gh, body file, HEAD,
  `baseCheck`) → `pushHead` (`git push -u origin HEAD`, `GUARDRAILS_SHIP_ID` env,
  `remoteHead` confirm) → PR → checks. The gate runs inside the pre-push hook
  (`templates/githooks/pre-push`: `node "$cli" gate --mode=push`; exit 75 → lock
  wording, other non-zero → "push blocked"), so the SSH connection stays open for
  the whole lock wait. `classifyPushFailure` reads the hook's output; `failing` is
  always `[]` on gate-blocked.
- The lock is inside the gate, around stryker only (`mutation-lock.ts`,
  `LOCK_TIMEOUT_EXIT = 75`).
- **A pass record already exists** (`gate.ts`): `pushPassKey` = `treeFingerprint`
  (working tree incl. untracked via a throwaway index + merge-base + package
  version) + resolved base; `rememberPushPass` writes `push-pass.json` only after an
  unblocked run with no skipped analyzers; `isRememberedPass` makes a repeat push
  gate return `cached: true`. Serves retried pushes since 0.9.0 (#122).

## Design

- ship spawns `gate --mode=push` itself, through `Exec`, before `git push`, using
  the repo's own CLI (`process.execPath` + `resolveCliFrom(repoRoot).cli`, fallback
  `selfLocation`), cwd `repoRoot`, **no `--base`** — identical to the hook, so the
  hook's gate then hits the pass record and returns at once.
- **No env var or new marker** (that would be a bypass: `X=1 git push`). Any record
  miss (tree edited mid-ship, base/version mismatch) → the hook runs the full gate
  during the push, as today. Fails closed.
- Verdict from the gate's exit: signal or spawn failure → `error` (checked BEFORE the
  code: the exec seam reports a killed child as exit 0 — the one fail-open route);
  0 → push; 75 → `lock-timeout`; 1 → `gate-blocked` with `failing` parsed from the
  gate output; other → `error`. Nothing pushed on any non-pass.
- After a green gate, a transport failure during the push → `error` with a hint
  ("the gate passed; the connection dropped; ship again — the pass is remembered").

## TDD steps (red → green → touched test files + gate each)

1. `ShipOptions.pushGate` (required) + `runPushGate` + `gateThenPush` called from
   `shipOutcome`; call-order test: gate after preflight, before the first push.
2. `gateVerdict(result)`: exit 1 / 75 / signal-with-code-0 / spawnFailed / 2, each
   with no push; existing PR still named. Generalise `pushFailure` into
   `withExistingPullRequest`.
3. `gateFailures(text)` fills `failing` (`file:line ruleId`, `file:line added kind`),
   anchored non-backtracking regexes; a `cli-core.test.ts` test pins it to what
   `printViolations` / `printGateDetail` print; push-path gate-blocked fills it too.
4. The issue's done-when: (a) gate ok → push shows `cached: true` → green;
   (b) gate blocked + transport drop → `gate-blocked`, no push; record-miss variant
   (hook block line + "Connection … closed") → `gate-blocked`; (c) gate ok, push
   drops → `error` + hint. Generic `TRANSPORT_FAILURE` regex, no host.
5. CLI wiring in `shipCommand`; tests pin args to `['gate','--mode=push']`, no
   `--base` even with `ship --base=x`, and to the template hook's line (`PUSH_GATE`
   in `push-hook.ts`).
6. `gateMsOf` (`gate-run-log.ts`) sums every gate row with the ship id;
   `pushMs` spans gate start → push end.
7. HEAD must not move while the gate runs: re-read after the gate → `error`, no push.
8. Docs: ship.ts header, `classifyPushFailure` doc, `SHIP_HELP`, `docs/adoption.md`;
   `upgrades/unreleased.md` "Behaviour that changed" + "What to wire" (refresh a
   pre-0.12 `lockf`/`flock` `.githooks/pre-push` with `init --apply`).

## Decisions (owner)

Approved 2026-11-24.

- Q1: **always** pre-gate, in every repo; no opt-out.
- Q2: **no `--base`**; mirror the hook exactly.
- Q3: `failing` as `file:line ruleId` / `file:line added kind`.
- Q4: **warn** in `warnings` when `git status --porcelain` is non-empty at ship
  time (the gate verifies the working tree, HEAD is pushed); the real fix is a
  follow-up issue the coordinator files. Add this as a step (with a test) after
  step 7.
- Q5: `enforcement: warn` / skipped analyzers write no pass record → hook re-gates:
  documented as a known limit.

## Risks

- A killed gate reading as exit 0 (step 2 test). Wrong CLI/args → only a record miss.
- `push-pass.json` is forgeable by anything that can write `.guardrails/state` —
  predates this; ship adds no writer but a real pass; CI authoritative.
- Duplicate gate runs on a record miss. Stale pre-0.12 hooks still hold the
  connection (lock in the shell wrapper).
- Repos whose own husky pre-push adds slow steps (this repo: `test:coverage`,
  `check:graph`) still run those during the push — out of scope.
