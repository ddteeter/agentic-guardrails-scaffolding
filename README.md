# Agent Guardrails

An initial TypeScript guardrail pack for Claude Code, ChatGPT Codex CLI, and a
headless GitHub Copilot channel, with Java support on the roadmap. Mechanically-fixable violations
are corrected silently; judgment-requiring violations are diverted to disk and
the main agent is handed a **terse pointer** to delegate the fix to a restricted
subagent — keeping the main agent's context clean while a session-scoped memory
tracks recurring mistakes.

This repository is the **development home** for three artifacts:

| Artifact                                    | What it is                                     | Status                         |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| [`guardrails-core/`](./guardrails-core)     | npm package — all machinery, CLI `guardrails`  | **v0.1 release candidate**     |
| [`guardrails-plugin/`](./guardrails-plugin) | thin Claude Code plugin (hooks + fixer agents) | **v0.1 release candidate**     |
| per-repo footprint                          | policy + state a target repo checks in         | **`guardrails init` ships it** |

See [`plan.md`](./plan.md) for the full design and phase breakdown, and
[`docs/adoption.md`](./docs/adoption.md) for how to adopt guardrails in
another repo — install, `init`, who owns which written file, what each
analyzer costs, and the clean-baseline prerequisite.

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
node ./node_modules/guardrails-core/dist/cli.mjs init --plan   # see what it would write; nothing touches disk
node ./node_modules/guardrails-core/dist/cli.mjs init --apply  # write it
```

(Invoked by path, not `npx` — see `docs/adoption.md` for why.)

`init` is re-runnable: on a fresh repo it creates the Claude, Codex, and Copilot
fixer agents, `.githooks/pre-commit`, host hook configuration, and a seeded
`guardrails.config.json`; on a repo it already scaffolded, an untouched file
is upgraded in place, and a file you edited is reported as drifted and left
alone (pass `--force` to overwrite it anyway) — except `guardrails.config.json`
itself, which holds your policy and your sanctioned suppressions and is never
overwritten again once it exists, `--force` included. A file you own outright —
`package.json`, `.claude/settings.json`, `.gitignore` — is never replaced;
`init` merges only its own entries into whatever is already there. See
`plan.md`'s "Phase E status" for what that merge does and does not preserve.

## The control loop (Claude Code and Codex CLI)

```
main agent finishes turn
   └─ Stop hook → guardrails gate --mode=stop
        1. verify (diff-scoped) → normalized Violation[] on disk
        2. clean?  → reset attempts, turn ends
        3. else    → tally rule-ids, bump attempt counter
        4. attempt > MAX → block once with FULL dump (stop hiding)
        5. still unfixable → release retry; commit/CI remain the backstop
        6. else          → block with TERSE pointer: "N violations at <path>.
                            Do NOT read it. Spawn the guardrail-fixer subagent."
        7. rule crossed recurrence threshold → attach a behavioral correction
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
  the Codex and Copilot commit gates.
- **CLI** (`src/cli.ts`, `src/cli-core.ts`) — `verify | autofix | audit | gate |
state | scope-check | session-start | session-end`.
- **Plugin** (`guardrails-plugin/`) — `hooks.json`, two fixer subagents, and a
  session hook whose exact-session fix-loop marker makes the scope-lock active
  only during delegation.

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

## Verifying the live agent loop

The headless tests prove verify → gate → delegate → audit → re-verify →
recurrence at the logic and real-`git`/real-spawn integration level. The one
thing that needs a real host session (a subagent actually being spawned)
is documented as a manual acceptance test in
[`docs/live-loop-verification.md`](./docs/live-loop-verification.md).

## Dogfooding

This repo **self-hosts** the guardrail loop on its own development: the
`scaffold-typescript-project` bootstrap tooling gave way to `guardrails` itself.
`.claude/settings.json` and `.codex/hooks.json` wire `guardrails autofix`
(PostToolUse) and `guardrails gate --mode=stop` (Stop), with generated fixer
agents in `.claude/agents/` and `.codex/agents/`; the `vitest/expect-expect`
house rule exercises the recurrence path. Codex asks for one-time repository
hook trust; inspect and approve `.codex/hooks.json` with `/hooks` in a fresh
session. Beneath that loop sits the tool-agnostic floor: this repo's
`.husky/pre-commit` runs `guardrails gate --mode=commit` on every commit;
consumer repos activate the identical check via
`git config core.hooksPath .githooks` (see `.githooks/pre-commit`). Husky
pre-push + CI remain the hard backstops. See
`docs/live-loop-verification.md` to run the loop, and
`docs/superpowers/specs/2026-07-12-dogfooding-pivot-design.md` for the design.

## License

MIT
