# Greenfield deps, cadence rungs, and agent identity — Design

Three changes that share one goal: make the loop usable by an agent building a
greenfield project, rather than merely correct.

- **A. Dependencies** — the greenfield blocker. An agent assembling a strict
  TypeScript stack today cannot install one.
- **B. Cadence rungs** — the commit gate re-checks the whole branch on every
  commit, so commits get slower the longer a branch runs.
- **C. Agent identity** — the fixer's scope-lock confines the main agent and
  every sibling subagent, because it can only see a session id.

Every claim below was measured, not inferred. Where a measurement contradicted
an earlier assumption, the assumption is corrected here explicitly.

## A. Dependencies — what actually breaks

### The correction

An earlier draft of this work claimed `guardrails-core`'s peer ranges
(`typescript: ">=5"`, `eslint: ">=9"`) "claim support that does not exist."
**That was wrong.** Measured against the packed tarball:

- **TypeScript 7.0.2** — the `tsc` adapter parses its diagnostics correctly
  (`src/bad.ts:1 [TS2322] …`).
- **ESLint 10.9.1** — the `eslint` adapter parses `--format json` and reports
  rule violations correctly.

So the peer ranges are accurate and **are not changed**. Tightening them would
assert a limitation guardrails does not have.

### The real constraint

It is one peer range, and it belongs to somebody else:

```
typescript-eslint@8.69.0 (latest)
  eslint:     ^8.57.0 || ^9.0.0 || ^10.0.0     ← fine
  typescript: >=4.8.4 <6.1.0                   ← caps TypeScript below 6.1
```

`npm i -D typescript` installs **7.0.2**. That single fact is the entire
greenfield failure: the strict stack cannot be assembled unless TypeScript is
pinned below 6.1, and nothing tells the adopting agent so — it just gets an
`ERESOLVE` wall.

A stack verified to install cleanly and lint correctly:

| package                 | range  | why                                  |
| ----------------------- | ------ | ------------------------------------ |
| `eslint`                | `^10`  |                                      |
| `typescript`            | `~5.9` | **must be <6.1** — typescript-eslint |
| `typescript-eslint`     | `^8`   | sets the TypeScript ceiling          |
| `@eslint/js`            | `^10`  |                                      |
| `eslint-plugin-unicorn` | `^74`  | current major needs `eslint >=10.4`  |
| `eslint-plugin-sonarjs` | `^4`   |                                      |

Note this repo is itself behind that (`eslint ^9`, `unicorn ^56`), which is
worth a follow-up but is not this change.

### A1. Make `adopting-guardrails` step 5 prescriptive

The skill already owns "author the configs `init` does not own." It gains the
dependency set, stated as a **rule** rather than a version list, because a
version list rots and this repo's own guidance says so:

> TypeScript's upper bound is set by `typescript-eslint`'s `peerDependencies`,
> not by guardrails. Read that range and pin accordingly — never assume `latest`
> works. `npm i -D typescript` today installs a major no released
> typescript-eslint accepts.

The verified table above ships as a worked example, explicitly dated and marked
as an example rather than a contract.

### A2. A generic peer-range preflight

The obvious implementation — a hardcoded table of supported analyzer versions
plus a drift guard — is exactly the "hardcoded third-party knowledge rots
silently" trap `CLAUDE.md` warns about. It is rejected.

Instead the check is **computed**: `npm ls --json --all` already reports, per
installed package, which peer ranges its installed version violates:

```
typescript@7.0.2  invalid: ">=4.8.4 <6.1.0" from node_modules/typescript-eslint, …
```

That message is the whole diagnostic, produced by the package manager. No
version table, no `semver` dependency (guardrails-core has **zero** runtime
dependencies and keeps them), and no maintenance as the ecosystem moves.

Three properties the measurement forced:

- **Report `invalid` only, never `missing`.** A missing peer is frequently
  legitimate (optional peers), while `invalid` means a package IS installed at a
  version that violates a range — precisely the greenfield failure, and a
  low-false-positive signal.
- **De-duplicate.** The dependency tree repeats the same problem once per path
  to it; one fixture produced the same `typescript@7.0.2` finding a dozen times.
  The violation is keyed by package name and reported once.
- **Do not trust the exit code.** `npm ls` exited **0** on a graph with
  problems. The `problems`/`invalid` fields are the signal, consistent with this
  project's existing rule that a non-zero exit is not the only failure signal.

**Why it earns its place when npm already checks peers at install time:** npm's
check is bypassed by `--legacy-peer-deps` and `--force` — which is exactly what
a stuck agent reaches for — and by monorepo hoisting. Those produce a silently
incoherent graph that installs fine and misbehaves later. This catches that.

Rung: **commit** (whole-graph, like knip). Scope: whole repo. Degrades to
skipped when `npm ls` cannot run, since it is a diagnostic, not a gate of last
resort.

## B. Cadence rungs — three, not two

`gate --mode=commit` scopes diff-based analyzers to everything changed since the
**merge-base**. Stryker therefore re-mutates every production file the branch
has touched, on every commit, so cost grows monotonically along a branch —
several commits in this repo exceeded ten minutes.

The fix is to make the local rungs mean what their names say:

| rung            | runs                 | scope                        |
| --------------- | -------------------- | ---------------------------- |
| Stop (per turn) | eslint, tsc          | changed files                |
| **pre-commit**  | `gate --mode=commit` | **staged files**             |
| **pre-push**    | `gate --mode=push`   | **branch diff (merge-base)** |
| CI              | `gate --mode=ci`     | branch diff (merge-base)     |

The plumbing exists: `branchDiff` in `gate.ts` already falls back to
`git diff --cached`, and the shipped CI template already anticipates the split —
"no analyzer currently declares `minRung: 'ci'` … the day one does, this
workflow needs a `--mode=ci` step too."

**Why per-commit scoping is still sound.** Every file is mutation-gated in the
commit that changes it, so nothing escapes entirely. What narrower scoping
misses is an _interaction_: commit 2 deletes the test that was killing a mutant
in a file only commit 1 touched. The new **pre-push** rung catches exactly that,
locally, before the code leaves the machine — and CI catches it again. This is
the same fast-local/thorough-later tiering the rung design already uses.

`init` scaffolds `.githooks/pre-push` alongside `.githooks/pre-commit`, so
consumers get all three rungs. `install-hooks` already points `core.hooksPath`
at `.githooks`, so no new activation step is needed.

## C. Agent identity — tiered, because the surfaces differ

`collectManifestScope` keys on **session id**, and a subagent shares its
parent's session id. So the lock cannot distinguish the fixer from the main
agent or from a sibling subagent: while a fixer runs, a fan-out of unrelated
subagents is confined to the fixer's manifest. Parallel subagents are a common
pattern, so this bites early.

### What each surface actually provides

Researched, not assumed:

| surface         | identity in `preToolUse`? | detail                                                                                                                                                   |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | **Yes**                   | `agent_id` + `agent_type` on all hook events                                                                                                             |
| **Copilot**     | **No**                    | only `sessionId`, `timestamp`, `cwd`, `toolName`, `toolArgs`. Identity exists on `subagentStart` (`agentName`) / `subagentStop` (`agentId`, `agentType`) |
| **Codex**       | **No**                    | open upstream request, `openai/codex#16226`, citing Claude Code's fields as the reference                                                                |

Claude Code's own documentation is explicit that `agent_id` is the field to use:
"Present only when the hook fires from within a subagent … Absent for the main
thread. Use this field (not `agent_type`) to distinguish subagent calls from
main-thread calls." Neither field is agent-settable, so this is not spoofable by
the fixer.

### The tiering

The surfaces do not need the lock equally, which is what makes uneven
enforcement defensible rather than sloppy:

- **Claude Code and Copilot** restrict the fixer's tools **declaratively**, in
  the agent definition.
- **Codex** has no per-agent tool allowlist, so the repo-level hook _is_ the
  enforcement — as `scopeCheckCommand`'s own comment says.

So:

1. **Claude Code — precise.** Confine only when `agentType` names a guardrail
   fixer. The main agent and every sibling subagent are unaffected. This fully
   solves the reported problem on this surface.
2. **Copilot — narrower window.** `subagentStart`/`subagentStop` do carry
   identity, so they open and close a fixer-active window rather than leaving it
   open for the whole delegation. Better than today; still cannot tell _which_
   subagent is calling `preToolUse`, so parallel fan-out during a fix stays
   confined.
3. **Codex — unchanged, documented.** Session-scoped, with `openai/codex#16226`
   recorded as the upstream fix to watch.

**No surface gets weaker than it is today.** The honest cost is that "parallel
subagents are unaffected by a running fixer" is a Claude-Code-only property for
now, and that belongs in `docs/adoption.md` rather than being discovered.

## What this does not do

- **Change `guardrails-core`'s peer ranges.** Measurement says they are correct.
- **Add a supported-version table.** Rejected above in favour of asking npm.
- **Upgrade this repo's own eslint/unicorn.** Real, but separate.
- **Relax the Codex lock.** It is the one surface with no declarative fallback.
