# Live-loop verification (manual acceptance test)

The automated suite proves the guardrail machinery end-to-end **except** the one
step that requires a running Claude Code session: the main agent actually
spawning the `guardrail-fixer` subagent in response to the Stop-gate pointer.
This document is the manual acceptance test for that last mile.

> Prerequisite: `guardrails-core` is built (`npm run build`) so
> `guardrails-core/dist/cli.mjs` exists, and the target repo has `guardrails-core`
> installed as a devDependency (in this dev repo it's a workspace, already
> present).

## 0. Install the plugin into a target repo

Point Claude Code at `guardrails-plugin/` (local plugin install) so its
`hooks/hooks.json` and the two fixer agents load. Confirm the plugin's hooks are
active with `/hooks` — you should see `Stop`, `PostToolUse`, `SessionStart`,
`SessionEnd` bound to `node ".../guardrails-core/dist/cli.mjs" …`.

Add a minimal `guardrails.config.json` at the repo root (or accept the defaults —
solo/warn, `main` base, thresholds 3/3):

```json
{ "baseBranch": "main", "maxAttempts": 3, "recurThreshold": 3 }
```

## 1. Silent autofix (PostToolUse) — _zero context_

In a Claude Code session, ask the agent to add a file with a trivially
`--fix`-able lint issue (e.g. wrong quotes / missing semicolon under the repo's
eslint). After the Edit, the `PostToolUse` hook runs `guardrails autofix` and the
file is corrected silently. **Expected:** the fix lands with no violation
surfaced to the agent.

## 2. Stop-gate delegation — _the terse pointer_

Ask the agent to write a function that trips a **judgment-class** rule that is not
auto-fixable — e.g. a test with no assertions, or code using `console.log` where
the repo bans it. Let the agent try to end its turn.

**Expected:** the turn does **not** end. The Stop hook blocks and the agent
receives a terse pointer like:

> `N guardrail violation(s) written to .claude/state/guardrails/<sid>.last.json.
Do NOT read it. Spawn the guardrail-fixer subagent and give it that path to
fix. Then try to stop again.`

Confirm the manifest exists on disk and the main agent's context did **not**
accumulate the full error text — only the pointer.

## 3. Fixer subagent resolves it

**Expected:** the main agent spawns `guardrail-fixer` (a restricted
Read/Edit/Write subagent). It reads the manifest, fixes the listed file(s), and
returns one line. The main agent tries to stop again; the gate re-runs `verify`;
it is now clean and the **turn ends**.

Check `guardrails state` — `attempts` should have reset to 0 after the clean
pass.

## 4. Scope-lock — _fixer can't wander_

While the fixer is active, its frontmatter `PreToolUse` hook runs
`guardrails scope-check` on every Edit/Write. If it tries to edit a file **not**
in the manifest, the edit is **denied** with a scope-lock reason. To exercise
this, temporarily craft a manifest referencing one file and confirm an edit to a
different file is blocked.

## 5. Diff-auditor — _fixer can't cheat_

Instruct a fixer (or hand-edit to simulate) to make `verify` pass by adding an
`eslint-disable` / `@ts-ignore` / `as any` / `.skip`. On the next Stop cycle the
gate's snapshot-based auditor surfaces a `guardrails/added-suppression` violation
and **re-blocks** — there is no green-by-cheating path.

## 6. Recurrence injection — _stop hiding a repeat offender_

Trip the **same** rule across three separate turns (`recurThreshold` default 3).
On the third, the Stop block additionally carries
`hookSpecificOutput.additionalContext` — a templated behavioral correction naming
the rule. Trip it across enough sessions and the correction also suggests
**graduating** the rule into `CLAUDE.md` or a hard gate.

Inspect `guardrails state` to watch `ruleCounts` climb and `recurrence.json`
accumulate across sessions.

## 7. Escalation — _the main agent gets the hard case_

Force a violation the fixer cannot resolve honestly for `maxAttempts` cycles.
**Expected:** on `attempt > MAX` the gate stops hiding, blocks with the **full
dump** (not a pointer), and hands it to the main agent (top model, full context).
The attempt counter resets.

---

### What "pass" looks like

Steps 1–3 are the core loop; 4–7 are the guards and memory. If all seven behave
as described in a real Claude Code session, Phase A's live loop is verified.
Record any deviation (especially agent-scoped hook behavior in step 4, which
depends on the running Claude Code version) back into the plan.
