# Copilot live-loop verification (manual acceptance test)

The automated suite proves the Copilot channel's machinery end-to-end
headlessly — dual payload parsing, `gate --mode=pretooluse` deny/allow, the
merge-base baseline, the `agentStop` output shape, `stateDirectory()` — **except**
the steps that require a running Copilot agent: the within-turn forcing loop
actually spawning the `guardrail-fixer` subagent on a real Copilot host, and
confirming that the fixer's scope-lock actually fires under that host. This
document is the manual acceptance test for that last mile, mirroring
[`docs/live-loop-verification.md`](./live-loop-verification.md) for the Claude
Code channel.

Two surfaces are exercised live: **VS Code** (primary — the day-to-day dev
surface, and the only one with a synchronous chat session to iterate in) and
the **Copilot CLI** (the headless-drivable proof of the native
`.github/hooks/guardrails.json` dialect). The **cloud coding agent** is
documented but its live proof is deferred (§5).

## 0. Preconditions

- `npm install` in the repo root (the `prepare` script builds
  `guardrails-core/dist/cli.mjs`, which every hook below shells out to). If any
  hook errors with a missing `cli.mjs`, run `npm run build`.
- Confirm the `.claude/` wiring is present and current — `.claude/settings.json`
  (`PostToolUse` → `autofix`, `Stop` → `gate --mode=stop`) and
  `.claude/agents/guardrail-fixer.md` / `guardrail-fixer-thorough.md`. These are
  **generated** by `npm run build` from `guardrails-plugin/agents/` — if you've
  hand-edited them, rebuild first. VS Code needs no _new_ config: it reads this
  wiring natively (§1).
- VS Code: a recent build with GitHub Copilot, **agent mode** available, and the
  **Hooks** capability (currently Preview) turned on. Confirm hooks are live by
  triggering any edit and observing the silent autofix in §1.1, or by checking
  the Copilot output/log channel for hook invocations.
- For the CLI section (§3): GitHub Copilot CLI installed and authenticated, run
  from this repo's working directory, with `.github/hooks/guardrails.json`
  present **on the branch you're testing** (the CLI reads it straight from the
  working tree — no default-branch requirement, unlike cloud).
- State now lives under `.guardrails/state/` for **both** runtimes (converged
  off the old `.claude/state/` this phase) — confirm `.gitignore` has
  `.guardrails/state/`, and read pointers/paths below with that in mind.

## 1. VS Code loop (primary) — a second-runtime proof of the same wiring

Copilot's hook mechanism natively ingests Claude-format (PascalCase) events,
and VS Code reads `.claude/settings.json` plus the agent definitions directly —
so pointing a Copilot agent-mode session at this repo exercises the **exact
same** `.claude/settings.json` and `.claude/agents/*.md` that
`docs/live-loop-verification.md` exercises for Claude Code. No new config is
authored for VS Code; this section is a second-runtime proof that the loop
mechanics (autofix, block-to-force, fixer delegation, scope-lock, diff-audit,
recurrence, escalation) aren't Claude-Code-specific.

### 1.1 Assertionless test → block → fixer → clean

- Open a Copilot Chat session in VS Code against this repo, switch to **agent
  mode**.
- Ask the agent to add a Vitest test with no assertions (trips the house rule
  `vitest/expect-expect`).
- Let the agent try to end its turn.

**Expected:** the turn does not end. VS Code's Copilot host runs
`guardrails gate --mode=stop` on `Stop` (no `--dialect` flag — `.claude/`
wiring is unchanged, so this is the plain Claude-dialect output) and blocks
with the terse pointer:

> `N guardrail violation(s) written to .guardrails/state/<sid>.last.json.
Do NOT read it. Spawn the guardrail-fixer subagent and give it that path to
fix. Then try to stop again.`

(Same wording as the Claude Code doc — only the state path changed, from
`.claude/state/` to `.guardrails/state/`.) Confirm the agent follows the
pointer and spawns `guardrail-fixer` (Copilot's native sub-agent
orchestration invoking the Claude-format frontmatter in
`.claude/agents/guardrail-fixer.md`), which reads the manifest, fixes the
file, and returns one line. The agent retries the stop; `verify` is now
clean; the turn ends. Check `guardrails state` — `attempts` should have reset
to 0.

### 1.2 Recurrence across 3 turns

- Trip `vitest/expect-expect` (or another rule) across 3 separate turns.

**Expected:** on the third trip, the block additionally carries the templated
behavioral correction via `hookSpecificOutput.additionalContext` — unchanged
from the Claude Code doc, since VS Code stays on the claude dialect end to
end. Inspect `guardrails state` to watch `ruleCounts` climb and
`recurrence.json` accumulate.

### 1.3 Force an unfixable case → escalation

- Force a violation the fixer cannot resolve honestly for `maxAttempts`
  cycles (or one that's loose-classed, routing straight to the thorough
  tier).

**Expected:** on the final attempt the gate stops delegating, blocks with the
full violation dump (not the terse pointer), and hands it to the main agent
(top model, full context). The attempt counter resets once resolved.

## 2. Scope-lock proof (closes carry-in #2)

Phase A's live run confirmed the **edit** scope-lock but never triggered a
**read**-scope denial, and never confirmed that a repo-local (non-plugin)
`.claude/agents/*.md` frontmatter `PreToolUse` hook fires under a live host at
all — the Phase-B design doc
(`docs/superpowers/specs/2026-07-16-phase-b-copilot-channel-design.md`) flags
this explicitly as **carry-in #2**, unconfirmed until this run.

Procedure, during a fixer run (reuse §1.1's or start a fresh one):

- Direct the fixer — via an instruction appended to its task, or by asking the
  main agent to tell it directly — to read a file **outside the repo**, e.g.
  `~/.claude/projects/.../memory/*.md` or any absolute path outside the
  checked-out worktree.

**Expected:** `.claude/settings.json`'s `PreToolUse` hook (matcher
`Read|Edit|Write`) runs `guardrails scope-check` and **denies** the read with a
scope-lock reason while the exact session's fix-loop marker is active:

> `Fixer read-scope: <path> is outside the repository. The fixer may only read
files within the repo.`

The **denied out-of-repo read is the confirming signal** that VS Code forwards
the session id and executes the self-filtering project hook.

Record PASS/FAIL — and any deviation from the expected denial — in `plan.md`.
That write-up is Task 11, not this document.

## 3. CLI loop (native dialect)

Repeats the same loop through the Copilot CLI, driven by the camelCase-native
`.github/hooks/guardrails.json` instead of `.claude/`.

- Start an agentic session with the Copilot CLI in this repo's working
  directory.
- Repeat the assertionless-test loop from §1.1. **Expected:** `postToolUse`
  (self-filtered on edit/create/`str_replace_editor`/`apply_patch`) silently
  autofixes mechanical issues, then `agentStop` runs
  `guardrails gate --mode=stop --dialect=copilot` and blocks turn-end with
  `{ "decision": "block", "reason": "..." }` — the Copilot dialect folds any
  recurrence correction directly into `reason` (there's no separate
  `additionalContext` channel the way Claude's `hookSpecificOutput` carries
  it).
- Confirm `guardrail-fixer` spawns via `.github/agents/guardrail-fixer.agent.md`
  (committed; generated by `scripts/sync-agents.mjs` from
  `guardrails-plugin/agents/` — the same source of truth as the `.claude/`
  variant, so the two cannot drift) and resolves the violation; re-verify is
  clean.
- **Commit/push gate:** with the tree left dirty (an unresolved violation, or
  a real suppression staged), ask the agent to run `git commit`. **Expected:**
  the repo-level `preToolUse` hook self-filters on a shell tool whose command
  matches `git commit`/`git push`, runs
  `guardrails gate --mode=pretooluse --dialect=copilot`, finds the tree dirty,
  and **denies** the tool call:
  `{ "permissionDecision": "deny", "permissionDecisionReason": "guardrails: N
violation(s), M added suppression(s). Resolve them before committing (run
'guardrails verify')." }`. The commit does not go through.
- Clean the tree and confirm a subsequent `git commit` is allowed (the hook
  emits nothing — silent allow).

## 4. Scope-lock note for CLI/cloud (not re-tested here)

Unlike VS Code, the CLI/cloud scope-lock is enforced **repo-level** via the
same `preToolUse` self-filtering `scope-check` call, not via `.agent.md`
frontmatter (per-agent `hooks` frontmatter is VS-Code-Preview-only and
unconfirmed on CLI/cloud). It shares the identical `scope-check` command
proven in §2, so a separate live confirmation isn't required this phase —
worth a spot-check in a future pass if the CLI fixer loop is exercised at
length.

## 5. Cloud (deferred)

The cloud coding agent reads the identical `.github/hooks/guardrails.json`,
but **only from the repository's default branch** — a hook file that exists
only on a feature branch or PR is invisible to it. Combined with cloud's
slower push-and-wait feedback loop (no interactive terminal to iterate in),
a live proof on cloud is out of scope for this phase (see `plan.md`'s
Phase-B non-goals). The `preToolUse` commit/push gate is documented as
cloud's one reliable floor regardless of whether `agentStop` fires there
(unconfirmed — see the Phase-B design doc's risk notes). Once
`.github/hooks/guardrails.json` is on `main`, a future phase can drive a live
cloud run the same way this doc drives the CLI in §3.

---

### What "pass" looks like

§1 is the core loop proof (autofix → block → delegate → clean, plus
recurrence and escalation); §2 closes carry-in #2; §3 proves the native
dialect end to end, including the commit/push gate that is Copilot's
tool-agnostic backstop. If all three behave as described in a real session,
Phase B's Copilot channel is live-verified on its primary and CLI surfaces.
Record any deviation — especially §2's scope-lock result, which is the one
still-unconfirmed mechanism from Phase A — back into `plan.md`.
