# Dogfooding Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-host the guardrail Stop-loop + recurrence memory on this repo, using existing eslint/tsc plus one judgment-class house rule (`vitest/expect-expect`), so real development here exercises the delegation loop.

**Architecture:** Replace the scaffold's hard per-edit lint hook with the guardrails model — silent `autofix` on `PostToolUse`, and `gate --mode=stop` at the turn boundary that verifies, diverts violations to a manifest, and delegates to a restricted fixer subagent. Hooks + fixer agents are wired **inline** into this repo's `.claude/` (Approach A); Husky pre-push + CI stay as hard backstops.

**Tech Stack:** Node 24, TypeScript→ESM (tsup), ESLint 9 flat config, `eslint-plugin-vitest`, Vitest, Claude Code hooks/agents, the repo-local `guardrails` CLI (workspace symlink `node_modules/guardrails-core`).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-12-dogfooding-pivot-design.md`.
- Hook command form (cross-platform, pure Node): `node "${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs" <subcommand>`.
- **Do not touch** Husky (`.husky/pre-commit`, `.husky/pre-push`) or `.github/workflows/ci.yml` — they are the hard backstops and must remain.
- No new `guardrails-core` runtime logic in this milestone; if wiring reveals a core gap, fix it TDD-first in `guardrails-core` (separate from these tasks).
- Config values: `baseBranch: "main"`, `maxAttempts: 3`, `recurThreshold: 3`, `graduationThreshold: 3`, `distribution: "solo"`, `enforcement: "warn"`.
- Every task runs from the worktree root: `/Users/drewteeter/dev/projects/agentic-guardrails-scaffolding/.claude/worktrees/dogfooding-pivot`.
- `guardrails-core` must be built (`npm run build`) before any CLI/hook invocation — the hook path points at `dist/cli.mjs`.

---

### Task 1: Add the `vitest/expect-expect` house rule

**Files:**

- Modify: `package.json` (add `eslint-plugin-vitest` devDependency)
- Modify: `eslint.config.js` (test-files block: add the plugin + rule)

**Interfaces:**

- Produces: an active, **non-autofixable** lint rule (`vitest/expect-expect`) that `guardrails verify` picks up for free (verify shells out to the repo's own eslint).

- [ ] **Step 1: Install the plugin**

Run:

```bash
npm install --save-dev eslint-plugin-vitest
```

Expected: adds `eslint-plugin-vitest` to `devDependencies`, no errors.

- [ ] **Step 2: Import the plugin in `eslint.config.js`**

Add to the import block at the top of `eslint.config.js` (after the existing plugin imports):

```js
import vitest from 'eslint-plugin-vitest';
```

- [ ] **Step 3: Enable the rule on the existing test-files override block**

Find the test-files config object (the one matching `['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts']`) and replace it with:

```js
  // Test files: relax some rules where fixtures need loose types, and enforce
  // that every test actually asserts something (a judgment-class house rule).
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    plugins: { vitest },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'vitest/expect-expect': 'error',
    },
  },
```

- [ ] **Step 4: Verify the existing test suite stays lint-clean**

Run:

```bash
npm run lint
```

Expected: exit 0 (all existing tests already assert via `expect`, so the rule is dormant until someone writes an assertionless test). If any existing test is flagged, it genuinely lacks an assertion — fix that test to assert, then re-run until green.

- [ ] **Step 5: Prove the rule fires on an assertionless test (scratch)**

Run:

```bash
cat > guardrails-core/test/scratch-assertionless.test.ts <<'EOF'
import { it } from 'vitest';
it('asserts nothing', () => {
  const unused = 1 + 1;
});
EOF
npx eslint guardrails-core/test/scratch-assertionless.test.ts ; echo "exit=$?"
```

Expected: an error `vitest/expect-expect ... Test has no assertions` and `exit=1`.

- [ ] **Step 6: Remove the scratch file**

Run:

```bash
rm guardrails-core/test/scratch-assertionless.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json eslint.config.js
git commit -m "feat: enable vitest/expect-expect house rule for dogfooding"
```

---

### Task 2: Make the repo-local CLI work against this repo

**Files:**

- Create: `guardrails.config.json`
- Build artifact: `guardrails-core/dist/cli.mjs` (via `npm run build`)

**Interfaces:**

- Consumes: nothing from prior tasks.
- Produces: a working `node node_modules/guardrails-core/dist/cli.mjs <cmd>` invocation resolving through the workspace symlink; `guardrails.config.json` that `loadConfig` reads.

- [ ] **Step 1: Create `guardrails.config.json`**

```bash
cat > guardrails.config.json <<'EOF'
{
  "baseBranch": "main",
  "maxAttempts": 3,
  "recurThreshold": 3,
  "graduationThreshold": 3,
  "distribution": "solo",
  "enforcement": "warn"
}
EOF
```

- [ ] **Step 2: Build guardrails-core**

Run:

```bash
npm run build
```

Expected: `guardrails-core/dist/cli.mjs` exists (`ls guardrails-core/dist/cli.mjs`).

- [ ] **Step 3: Confirm the CLI resolves via the workspace symlink and verify runs clean**

Run:

```bash
node node_modules/guardrails-core/dist/cli.mjs verify ; echo "exit=$?"
```

Expected: prints `guardrails: clean (0 violations).` (or a small count if the tree is mid-edit) and `exit=0` on a clean tree.

- [ ] **Step 4: Confirm `autofix` runs (silent mechanical fix) on a scratch file**

Run:

```bash
printf "export const x = 1\n" > guardrails-core/src/scratch-fmt.ts
echo '{"cwd":"'"$PWD"'","tool_input":{"file_path":"'"$PWD"'/guardrails-core/src/scratch-fmt.ts"}}' \
  | node node_modules/guardrails-core/dist/cli.mjs autofix
cat guardrails-core/src/scratch-fmt.ts   # eslint --fix should have normalized it
rm guardrails-core/src/scratch-fmt.ts
```

Expected: the command exits 0 and does not error (autofix runs eslint --fix on the file; it stays or becomes lint-clean). Scratch removed.

- [ ] **Step 5: Commit**

```bash
git add guardrails.config.json
git commit -m "chore: add guardrails.config.json (solo/warn) for self-hosting"
```

---

### Task 3: Wire the loop into `.claude/` (hooks + fixer agents + state ignore)

**Files:**

- Create: `.claude/agents/guardrail-fixer.md`, `.claude/agents/guardrail-fixer-thorough.md` (copies of the plugin agents)
- Modify: `.claude/settings.json` (replace the `post-edit-lint.sh` PostToolUse entry with the four guardrails hooks)
- Modify: `.gitignore` (add `.claude/state/`)
- Keep (unreferenced): `.claude/hooks/post-edit-lint.sh` — the kill-switch/revert target

**Interfaces:**

- Consumes: the built CLI from Task 2.
- Produces: `.claude/settings.json` whose Stop/PostToolUse/SessionStart/SessionEnd hooks call the repo-local CLI; two fixer agents available to a future session.

- [ ] **Step 1: Copy the two fixer agents into `.claude/agents/`**

Run:

```bash
mkdir -p .claude/agents
cp guardrails-plugin/agents/guardrail-fixer.md .claude/agents/guardrail-fixer.md
cp guardrails-plugin/agents/guardrail-fixer-thorough.md .claude/agents/guardrail-fixer-thorough.md
```

- [ ] **Step 2: Replace `.claude/settings.json` with the guardrails hooks**

Overwrite `.claude/settings.json` with:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs\" autofix",
            "timeout": 120
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs\" gate --mode=stop",
            "timeout": 300
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs\" session-start"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs\" session-end"
          }
        ]
      }
    ]
  }
}
```

(The old `post-edit-lint.sh` PostToolUse entry is gone; the script stays on disk as the documented revert target.)

- [ ] **Step 3: Ignore the session-state directory**

Add `.claude/state/` to `.gitignore`:

```bash
printf ".claude/state/\n" >> .gitignore
```

- [ ] **Step 4: Validate the wiring parses**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('settings.json OK')"
head -6 .claude/agents/guardrail-fixer.md
git check-ignore .claude/state/ && echo "state ignored"
```

Expected: `settings.json OK`; the agent file's YAML frontmatter prints (`--- name: guardrail-fixer ...`); `.claude/state/ ... state ignored`.

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json .claude/agents/guardrail-fixer.md .claude/agents/guardrail-fixer-thorough.md .gitignore
git commit -m "feat: wire guardrails loop into .claude (hooks + fixer agents)"
```

---

### Task 4: Headless acceptance — synthetic violation delegates through the gate

**Files:**

- (No committed files — a scratch test is created and removed within the steps.)

**Interfaces:**

- Consumes: Task 1 (house rule), Task 2 (built CLI + config), Task 3 (wiring).
- Produces: evidence the wired Stop-gate's headless-testable path works end-to-end (verify → manifest → terse-pointer block), the acceptance gate for the wiring.

- [ ] **Step 1: Create a scratch assertionless test (uncommitted change the gate will see)**

Run:

```bash
cat > guardrails-core/test/scratch-loop.test.ts <<'EOF'
import { it } from 'vitest';
it('has no assertion', () => {
  const value = 2;
});
EOF
```

- [ ] **Step 2: Run the stop-gate with a synthetic hook payload**

Run:

```bash
echo '{"session_id":"scratch-sid","cwd":"'"$PWD"'","hook_event_name":"Stop"}' \
  | node node_modules/guardrails-core/dist/cli.mjs gate --mode=stop
echo "---exit=$?---"
```

Expected: stdout is JSON containing `"decision":"block"` and a `reason` that names `.claude/state/guardrails/scratch-sid.last.json`, says `Do NOT read it`, and names the `guardrail-fixer` subagent. `exit=0` (Stop hooks emit the block via stdout, not exit code).

- [ ] **Step 3: Confirm the manifest was written with the expect-expect violation**

Run:

```bash
node -e "const v=require('./.claude/state/guardrails/scratch-sid.last.json'); console.log(v.map(x=>x.ruleId+':'+x.fixable).join(','))"
```

Expected: includes `vitest/expect-expect:false` (a judgment-class, non-fixable violation).

- [ ] **Step 4: Clean up scratch test + scratch state**

Run:

```bash
rm guardrails-core/test/scratch-loop.test.ts
rm -rf .claude/state/guardrails/scratch-sid.json .claude/state/guardrails/scratch-sid.last.json .claude/state/guardrails/scratch-sid.pre-fix.json
git status --short   # confirm no stray files remain
```

Expected: `git status --short` shows no scratch files (only whatever this task legitimately changes — which is nothing to commit).

- [ ] **Step 5: No commit**

This task commits nothing (it is a verification harness). Record the result in the task tracker and proceed.

---

### Task 5: Update the live-loop doc for Approach A, and record the pivot

**Files:**

- Modify: `docs/live-loop-verification.md` (Step 0: inline `.claude/` wiring instead of plugin install)
- Modify: `README.md` (note the repo self-hosts the guardrail loop)

**Interfaces:**

- Consumes: the wired state from Tasks 1–3.
- Produces: the accurate instructions the next fresh session follows to run the live proof.

- [ ] **Step 1: Update `docs/live-loop-verification.md` Step 0**

Replace the "## 0. Install the plugin into a target repo" section body with inline-wiring instructions:

```markdown
## 0. Prerequisite — the loop is wired inline (Approach A)

This repo self-hosts the guardrail loop directly in `.claude/` (no plugin
install): `.claude/settings.json` carries the Stop / PostToolUse / SessionStart /
SessionEnd hooks, and `.claude/agents/` holds the two fixer subagents. They load
automatically at the start of a fresh Claude Code session — no marketplace step.
Confirm with `/hooks` that `Stop` is bound to
`node ".../guardrails-core/dist/cli.mjs" gate --mode=stop`.

`guardrails.config.json` is already present (solo/warn, base `main`,
thresholds 3/3). `guardrails-core` must be built (`npm run build`) so
`dist/cli.mjs` exists — CI/pre-push already build it.

Kill-switch: to revert to plain development, comment out the `Stop` (and/or
`PostToolUse`) entry in `.claude/settings.json`; `.claude/hooks/post-edit-lint.sh`
remains on disk if you want the old hard-block hook back.
```

Leave sections 1–7 (the actual test steps) unchanged.

- [ ] **Step 2: Add a self-hosting note to `README.md`**

Under the existing `## Dogfooding` section, append:

```markdown
As of the dogfooding pivot, this repo **self-hosts** the guardrail loop on its
own development: `.claude/settings.json` wires `guardrails autofix` (PostToolUse)
and `guardrails gate --mode=stop` (Stop), with the two fixer agents in
`.claude/agents/`. The `vitest/expect-expect` house rule exercises the
recurrence path. Husky pre-push + CI remain the hard backstops. See
`docs/live-loop-verification.md` to run the loop, and
`docs/superpowers/specs/2026-07-12-dogfooding-pivot-design.md` for the design.
```

- [ ] **Step 3: Verify docs still format-clean**

Run:

```bash
npx prettier --check docs/live-loop-verification.md README.md
```

Expected: both listed as unchanged/clean (or run `npx prettier --write` on them, then re-check).

- [ ] **Step 4: Commit**

```bash
git add docs/live-loop-verification.md README.md
git commit -m "docs: self-host the guardrail loop (inline wiring) + live-loop steps"
```

---

## Self-Review

**Spec coverage:**

- Scope (loop + memory + expect-expect; defer Phase-C checks) → Tasks 1, 4. ✓
- Approach A inline hooks + agents → Task 3. ✓
- Replace hard per-edit hook; Husky/CI backstops untouched → Task 3 + Global Constraints. ✓
- guardrails.config.json (solo/warn, thresholds) → Task 2. ✓
- House rule via eslint-plugin-vitest expect-expect → Task 1. ✓
- Workspace-symlink CLI resolution + build → Task 2. ✓
- `.gitignore .claude/state/` → Task 3. ✓
- Headless acceptance (verify → manifest → pointer) → Task 4. ✓
- Live-proof doc update for Approach A → Task 5. ✓
- Kill-switch (keep post-edit-lint.sh) → Task 3 + Task 5. ✓

**Placeholder scan:** No TBD/TODO; each code/command step shows exact content and expected output. ✓

**Type/name consistency:** CLI subcommands (`verify`/`autofix`/`gate --mode=stop`/`session-start`/`session-end`), config keys, and the rule id `vitest/expect-expect` are used identically across tasks. ✓

**Interactive boundary:** The live subagent-spawn proof is explicitly out of these tasks (it needs a fresh session) and is covered by `docs/live-loop-verification.md` (updated in Task 5). ✓
