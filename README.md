# Agent Guardrails

A guardrail system for coding agents (Claude Code and GitHub Copilot) targeting
TypeScript and Java repos. Mechanically-fixable violations are corrected
silently; judgment-requiring violations are diverted to disk and the main agent
is handed a **terse pointer** to delegate the fix to a restricted subagent —
keeping the main agent's context clean while a session-scoped memory tracks
recurring mistakes.

This repository is the **development home** for three artifacts:

| Artifact                                    | What it is                                     | Status                                           |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| [`guardrails-core/`](./guardrails-core)     | npm package — all machinery, CLI `guardrails`  | **Phase A: built**                               |
| [`guardrails-plugin/`](./guardrails-plugin) | thin Claude Code plugin (hooks + fixer agents) | **Phase A: built**                               |
| per-repo footprint                          | policy + state a target repo checks in         | **`guardrails init` ships it (Phase E piece 4)** |

See [`plan.md`](./plan.md) for the full design and phase breakdown.

## Install

`guardrails-core` is delivered as a GitHub Release asset, not from npm:

```bash
npm i -D https://github.com/ddteeter/agentic-guardrails-scaffolding/releases/download/v0.1.0/guardrails-core-0.1.0.tgz
```

No `v0.1.0` release exists yet — this resolves once the tag is pushed and
`.github/workflows/release.yml` runs.

**What a URL dependency costs you, stated plainly:** no semver range, no dedupe,
and Dependabot will not track it. Upgrading means editing the URL by hand. This
is deliberate while the package has no external consumers — publishing to npm
later changes this line and nothing else.

Installing the package does not wire anything up by itself — run
`guardrails init` to do that:

```bash
npx guardrails init --plan   # see what it would write; nothing touches disk
npx guardrails init --apply  # write it
```

`init` is re-runnable: on a fresh repo it creates the fixer agents,
`.githooks/pre-commit`, `.github/hooks/guardrails.json`, and a seeded
`guardrails.config.json`; on a repo it already scaffolded, an untouched file
is upgraded in place, and a file you edited is reported as drifted and left
alone (pass `--force` to overwrite it anyway). A file you own outright —
`package.json`, `.claude/settings.json`, `.gitignore` — is never replaced;
`init` merges only its own entries into whatever is already there. See
`plan.md`'s "Phase E status" for what that merge does and does not preserve.

## The control loop (Claude Code)

```
main agent finishes turn
   └─ Stop hook → guardrails gate --mode=stop
        1. verify (diff-scoped) → normalized Violation[] on disk
        2. clean?  → reset attempts, turn ends
        3. else    → tally rule-ids, bump attempt counter
        4. attempt > MAX → block with FULL dump (stop hiding), reset
        5. else          → block with TERSE pointer: "N violations at <path>.
                            Do NOT read it. Spawn the guardrail-fixer subagent."
        6. rule crossed recurrence threshold → attach a behavioral correction
   └─ main agent spawns guardrail-fixer (restricted: Read/Edit/Write, no fan-out)
        reads the manifest, fixes, returns one line
   └─ main agent tries to stop again → gate re-runs verify (never trusts the fixer)
        + diff-auditor rejects any suppression/cast/skip the fixer sneaked in
```

## What's in Phase A

Everything is authored in strict TypeScript, compiled to pure-Node ESM
(`dist/*.mjs`), and tested with Vitest.

- **`Violation` contract** (`src/violation.ts`) — the one normalized schema every
  check funnels into.
- **Recurrence memory** (`src/state.ts`, `src/state-store.ts`) — deterministic
  session tally + cross-session recurrence, keyed `package:ruleId` in monorepos.
- **Diff-auditor** (`src/audit.ts`) — rejects newly-added
  `eslint-disable`/`@ts-ignore`/`as any`/`.skip`/`@Disabled`/`@SuppressWarnings`.
- **verify orchestrator** (`src/verify/`) — diff-scoping + eslint/tsc adapters.
- **Gate** (`src/gate-decision.ts`, `src/gate.ts`) — the clean/delegate/escalate
  engine + snapshot-based fixer audit, shared by the CC stop-gate and (Phase B)
  the Copilot commit-gate.
- **CLI** (`src/cli.ts`, `src/cli-core.ts`) — `verify | autofix | audit | gate |
state | scope-check | session-start | session-end`.
- **Plugin** (`guardrails-plugin/`) — `hooks.json`, and the two fixer subagents
  with a fixer-scoped scope-lock hook.

## Development

```bash
npm install
npm test              # vitest
npm run lint          # eslint (strict-type-checked + unicorn + sonarjs)
npm run build         # tsup → guardrails-core/dist/*.mjs
npm run test:coverage && npm run check:graph   # the pre-push gate (fallow)
```

The `guardrails verify` CLI runs against this repo itself:

```bash
node guardrails-core/dist/cli.mjs verify
```

> **Prerequisite — clean baseline.** ESLint is diff-scoped to changed files, but
> `tsc` type-checks the whole project (type errors are inherently cross-file). So
> a repo must pass `guardrails verify` **before** activating the gate; on a branch
> with pre-existing `tsc` errors, every turn would escalate on them until fixed.

knip runs at the **commit and CI rungs only** (never the per-turn Stop gate) and
is whole-graph, so — like tsc — it assumes a **knip-clean baseline**. Run
`npx knip` clean before relying on the commit gate; pre-existing dead code will
otherwise block every commit until removed.

An analyzer set to `"off"` in `guardrails.config.json`'s `analyzers` block never
runs and never reports, so a repo can adopt eslint/tsc first and add the
whole-graph analyzers (knip, dependency-cruiser, stryker) once its baseline is
clean.

## Verifying the live Claude Code loop

The headless tests prove verify → gate → delegate → audit → re-verify →
recurrence at the logic and real-`git`/real-spawn integration level. The one
thing that needs a real Claude Code session (a subagent actually being spawned)
is documented as a manual acceptance test in
[`docs/live-loop-verification.md`](./docs/live-loop-verification.md).

## Dogfooding

This repo **self-hosts** the guardrail loop on its own development: the
`scaffold-typescript-project` bootstrap tooling gave way to `guardrails` itself.
`.claude/settings.json` wires `guardrails autofix` (PostToolUse) and
`guardrails gate --mode=stop` (Stop), with the two fixer agents in
`.claude/agents/`; the `vitest/expect-expect` house rule exercises the recurrence
path. Beneath that loop sits the tool-agnostic floor: this repo's
`.husky/pre-commit` runs `guardrails gate --mode=commit` on every commit;
consumer repos activate the identical check via
`git config core.hooksPath .githooks` (see `.githooks/pre-commit`). Husky
pre-push + CI remain the hard backstops. See
`docs/live-loop-verification.md` to run the loop, and
`docs/superpowers/specs/2026-07-12-dogfooding-pivot-design.md` for the design.

## License

MIT
