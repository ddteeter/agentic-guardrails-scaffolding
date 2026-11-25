# Plan: #201 — `guardrails lock [--timeout=<s>] -- <cmd> [args…]`

Base: main @ ad3501e.

## Today

- `mutation-lock.ts:112` `lockerArgv`: macOS `lockf -k -s -t <wait> <lock> cmd…`, Linux `flock -w <wait> -E 75 <lock> cmd…`. `detectLocker` `:132`; `machineLockPath` `:519` (`GUARDRAILS_GATE_LOCK` or `~/.guardrails-gate.lock`).
- `runUnderLock` `:335-423`: bare run if no locker / unopenable lock (note); zero-wait probe; `watchTheWait` names the holder every minute; process-group exec; **re-runs bare on `isMissingCommand` (`:405`)** — wrong for `lock` (could run a build twice). Exit 75 = timeout (`LOCK_TIMEOUT_EXIT` `:56`); `LOCK_TIMEOUT_MARKER` is what ship classifies as `lock-timeout`.
- Holder record `<lock>.holder.json` (`lock-holder.ts:53`) is written only by the stryker progress plugin (temp + rename); `Holder` is stryker-shaped (rung/phase/counts required). Dead pid → "another checkout holds it".
- Run log `run-log.ts:94` `RunRow = GateRow | ShipRow`; `rowOf` `:357` drops unknown kinds (old versions ignore lock rows safely). `run-stats.ts` would count lock rows in `rows` and print an empty header — needs a `lock:` section.
- CLI: no `--` handling; `flag()` scans all of `rest`, so flags must be read only before `--`.
- `exec.ts`: SIGINT/SIGTERM forwarding to the process group exists; `spawnExec` collects output, can't stream — needs a `stream` option.
- No shipped file tells adopters to use raw `lockf`; adopters' own templates are reached via the upgrade note. Edit: crushing-mutants SKILL.md (hand-run stryker), adopting-guardrails SKILL.md:80 (baseline run), docs/adoption.md (lock section, run-log kinds), cli usage text.

## Design

- New `command-lock.ts` (`runCommandUnderLock`) reusing exported pieces of mutation-lock.ts (`lookAtLock`, `watchTheWait`, `canOpenForAppend`, `NO_LOCKER_NOTE`, `machineLockPath`); no bare re-run.
- Holder: the locker runs a tiny `sh` shim that writes `{kind:'lock', pid:$$, repo, startedAt, command, token}` (temp + mv) then `exec`s the command — written by the process that holds the lock. `describeHolder`: "`<repo>` is running `npm` under guardrails lock, 12m so far". Records without `kind` stay stryker holders. Parent deletes the holder file only if the token is its own; the token also distinguishes a real exit 75 from a lock timeout.
- Row: one `kind:'lock'` row at the end: base fields + `command` (basename of argv[0]), `commandHash` (sha256 of the argv JSON, 16 hex), `exitCode`, `signal?`, `outcome` (`ran|lock-timeout|unserialized|killed`), `lock: LockPart`. A signal handler registered before spawn writes the `killed` row before the exec layer exits.
- Exec gets `stream` (forward chunks live, stdin ignored).
- Exit: the command's own code; timeout → 75 + marker; signal → 130/143; missing command → 127; usage → 2.

## TDD steps

1. `parseLockArguments` — flags only before `--`; no `--`/empty command/bad timeout → usage error. (`test/command-lock.test.ts`)
2. `commandIdentity` — basename + stable hash; no argument values in output.
3. `holderShimArgv` — exact shape; real-locker integration test under a tmp `GUARDRAILS_GATE_LOCK` (holder holds the shim's pid; exit code passes through), gated on `detectLocker`.
4. Holder variant in `lock-holder.ts` (+ test): accepts `kind:'lock'`, rejects one without `command`; describes it; old records parse.
5. `LockRow` in run-log (+ round-trip, malformed dropped); `logLockRun` in gate-run-log.
6. run-stats: lock rows don't count toward rungs; `lock:` line; lock-only log isn't "no runs".
7. exec `stream` (real `node -e` child: chunks before close, stdout empty).
8. `runCommandUnderLock` with fake exec: free, busy (watcher), foreign-token 75 = timed-out, own-token 75 = ran, no locker = unserialized + note, own holder deleted / foreign kept.
9. CLI `lockCommand` in cli-core (split out to stay under complexity): child's code, one row, marker on timeout, default timeout from config, killed row on signal (injected exit/terminate); usage text.
10. Docs + `upgrades/unreleased.md` (`supersedes:` for `lockf`/`flock`/`.guardrails-gate.lock`; behaviour bullet; "What to wire: replace raw lockf wrappers in your own scripts and templates"). `npm run build` to sync generated guidance.

## Open questions (recommendation first)

1. Default `--timeout` → `mutationLock.pushWaitSeconds` (10800); `--timeout=0` = try once.
2. Nested `guardrails lock -- git push` (push gate would wait on its parent's lock) → set `GUARDRAILS_GATE_LOCK_HELD=<path>` for the child; gate and nested lock run directly and say so. Alternative: refuse.
3. No locker / unusable lock → run unserialized with a note (as the gate does).
4. Defaults: one row at the end (plus kill path); basename of argv[0] (no home-dir paths in a machine-wide log); sh shim rather than a Node wrapper.
