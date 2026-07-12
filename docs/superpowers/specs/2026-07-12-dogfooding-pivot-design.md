# Dogfooding Pivot — Design

**Date:** 2026-07-12
**Status:** approved (brainstorming) → ready for implementation plan
**Milestone:** make guardrails-core guard its own development (post–Phase A, pre–Phase B)

## Goal

Prove the guardrail **delegation loop + recurrence memory** work on this repo's
own development, and — incrementally — add one real judgment-class house rule so
the recurrence/graduation path runs against a genuine rule, not just eslint/tsc.

This is a **validation milestone**, not a breadth milestone. The novel value
being proven is the _mechanics_ (silent autofix → Stop-gate → delegate to fixer →
re-verify → recurrence injection), because the base checks (eslint/tsc) are
already enforced here by the scaffold tooling. New check _classes_ (knip,
semgrep, dependency-drift, ArchUnit-equivalents) remain **Phase C** — explicitly
out of scope.

### Non-goals (deferred)

- knip / dependency-cruiser / semgrep / dependency-drift checks (Phase C).
- The bundled custom `no-assertionless-test` ESLint rule (Phase C) — we reuse
  `eslint-plugin-vitest`'s `expect-expect` instead.
- Installing `guardrails-plugin/` as a distributed plugin via a marketplace
  (validated later against a genuinely external consumer repo / at team-flip).
- Copilot surfaces, Java, monorepo (Phases B/C/D).

## Approach: A — inline into the repo's `.claude/`

The CC hooks and fixer agents are wired **directly into this repo** rather than
loaded as a packaged plugin:

- Hooks go in `.claude/settings.json` (Stop / PostToolUse / SessionStart /
  SessionEnd), each invoking the repo-local CLI.
- The two fixer agents go in `.claude/agents/`.

**Why A over installing the plugin (B):** the loop mechanics are identical either
way (both call the same CLI and spawn the same agents). A keeps everything
version-controlled and visible in one place, gives a trivial kill-switch
(comment out a hook), and avoids marketplace/install ceremony. Dogfooding's goal
is the loop mechanics, which A exercises fully. The plugin _distribution_ path is
a separate concern, better validated against a real external consumer than
against the repo that _is_ guardrails-core.

The agents' scope-lock `PreToolUse` hook is authored in agent frontmatter exactly
as in `guardrails-plugin/agents/` (confirmed supported for CC agents). If repo
`.claude/agents/*.md` frontmatter hooks turn out not to fire, that is recorded as
a live-verification risk (see Risks).

## The pivot: bootstrap → self-hosted

The scaffold's `post-edit-lint.sh` PostToolUse hook (`eslint --fix` + `tsc`, and
**hard-blocks the edit** on error) is **replaced** by the guardrails model:

| Concern       | Before (scaffold)                                                  | After (guardrails)                                                                               |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Per-edit      | `eslint --fix` + `tsc`, **blocks** on error                        | `guardrails autofix` (silent `eslint --fix`, non-blocking)                                       |
| Turn boundary | —                                                                  | `guardrails gate --mode=stop` → verify (eslint + tsc + house rule) → clean / delegate / escalate |
| Session       | —                                                                  | `guardrails session-start` (TTL sweep) / `session-end` (cleanup)                                 |
| Commit / push | Husky pre-commit (lint-staged) + pre-push (test:coverage + fallow) | **unchanged** — hard backstops                                                                   |
| CI            | `.github/workflows/ci.yml`                                         | **unchanged** — authoritative backstop                                                           |

Replacing the hard per-edit block is **necessary** for the loop to fire: if edits
are blocked at edit time, errors never reach the Stop-gate, and the block would
also stop the fixer subagent's own edits. tsc/lint enforcement moves to the turn
boundary by design; Husky pre-push + CI remain as hard nets so nothing escapes.

## Components / wiring (all done this session)

1. **`.claude/settings.json`** — replace the `post-edit-lint.sh` PostToolUse
   entry with four guardrails hooks, each calling
   `node "${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs" <cmd>`
   (resolves via the workspace symlink `node_modules/guardrails-core → ../guardrails-core`).
   - `PostToolUse` (matcher `Edit|Write`) → `autofix`
   - `Stop` → `gate --mode=stop`
   - `SessionStart` → `session-start`
   - `SessionEnd` → `session-end`
   - Leave `.claude/hooks/post-edit-lint.sh` on disk but unreferenced — it is the
     documented kill-switch / revert target (re-point `settings.json` at it to
     restore the old hard-block behavior).
2. **`.claude/agents/guardrail-fixer.md` + `guardrail-fixer-thorough.md`** —
   copied from `guardrails-plugin/agents/`, unchanged (restricted tools, model
   tiers, scope-lock `PreToolUse`).
3. **`guardrails.config.json`** (repo root) — `{ baseBranch: "main",
maxAttempts: 3, recurThreshold: 3, graduationThreshold: 3, distribution:
"solo", enforcement: "warn" }`. (`enforcement` is Phase-B/CI-reserved; the
   local loop always runs — documented in config.ts.)
4. **House rule** — add `eslint-plugin-vitest` (devDep) and enable
   `vitest/expect-expect` on test files in `eslint.config.js`. It flows through
   `guardrails verify` for free, because verify shells out to the repo's own
   eslint + config. `expect-expect` is non-autofixable → `fixable:false` →
   reaches the Stop-gate → delegates → exercises recurrence.
5. **`.gitignore`** — add `.claude/state/` (session tally + manifests;
   `recurrence.json` stays gitignored in solo mode).
6. **Build** — `npm run build` so `guardrails-core/dist/cli.mjs` exists for the
   hook path (CI/pre-push already build).

## Data flow (the loop, once live)

```
agent edits a file
  └─ PostToolUse → guardrails autofix   (silent eslint --fix; non-blocking)
agent finishes turn
  └─ Stop → guardrails gate --mode=stop
       verify (diff-scoped eslint incl. expect-expect + project-wide tsc)
       clean?  → end turn
       else    → tally rule-ids, write manifest, block with terse pointer
                 (+ recurrence correction if a rule crossed threshold)
  └─ main agent spawns guardrail-fixer (scope-locked, no fan-out)
       reads manifest, fixes, returns one line
  └─ agent tries to stop again → gate re-verifies (+ diff-audits the fixer)
       clean → end turn ; exhausted → full dump to main agent
```

## Validation

**Headlessly verifiable now (acceptance for the wiring):**

- `guardrails.config.json` loads (config round-trips).
- `guardrails-core` builds; `node node_modules/guardrails-core/dist/cli.mjs verify`
  runs against this repo and exits 0 on a clean tree.
- `guardrails autofix` fixes a deliberately mis-formatted file via the repo eslint.
- A synthetic assertionless test yields a `vitest/expect-expect`,
  `fixable:false` violation, and `guardrails gate --mode=stop` (fed a synthetic
  hook payload) writes the manifest and emits the terse-pointer block JSON.
- `.claude/settings.json` and both agents parse (schema/frontmatter valid).

**Live proof (next fresh session — the acceptance gate before real reliance):**
Run `docs/live-loop-verification.md` end-to-end: assertionless test → Stop blocks
with pointer → fixer spawns and fixes → re-verify clean → trip the rule across 3
turns → observe the behavioral-correction injection; force an unfixable case →
observe escalation.

## Safety (circular-brick mitigation)

- **Husky pre-push (test:coverage + fallow) and CI remain hard backstops** — the
  authoritative gates are untouched, so a bug in the local loop cannot land
  broken code.
- **Kill-switch:** the loop is inline hooks in `.claude/settings.json`; comment
  out the `Stop` (and/or `PostToolUse`) entry to instantly revert to plain
  development. `post-edit-lint.sh` is kept on disk as the revert target if we
  want the old hard-block back.
- **Bounded loop:** the attempt counter + CC's block-override backstop the loop;
  `git commit --no-verify` bypasses if ever needed.
- **enforcement stays `warn`:** does not soften the local loop (that's
  Phase-B/CI semantics), but signals intent for when CI becomes a required check.

## Testing

No new guardrails-core logic is introduced by this milestone (it's wiring +
config + a repo eslint rule), so there are no new unit tests in `guardrails-core`.
The verification is the headless acceptance checklist above (run as commands) plus
the live-loop script. If any wiring reveals a guardrails-core gap (e.g. an adapter
mis-maps the house rule), that fix follows TDD in guardrails-core as usual.

## Risks / open items

- **Agent-frontmatter hooks in repo `.claude/agents/`** — confirmed for plugin
  agents; assumed equivalent for repo-local agents. Verify in the live run; if
  the scope-lock `PreToolUse` doesn't fire, fall back to the diff-auditor (still
  active) + a global-but-guarded scope-check, or install as a plugin (Approach B).
- **Losing per-edit `tsc`** — intended (moves to Stop), but means a type error is
  surfaced at turn end rather than per-edit. Acceptable; pre-push/CI still hard-gate.
- **Fixer model availability** — the fixer agents name Haiku/Sonnet tiers; if the
  session's `availableModels` restricts them, `fallbackModel` / the ladder still
  terminate at the main agent. Not blocking.
