# Phase B — GitHub Copilot Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the guardrail loop to a GitHub Copilot channel (VS Code / CLI / cloud) co-equal with the Claude Code channel, plus the git-native and CI floors.

**Architecture:** `guardrails-core` gains dual-dialect hook I/O (parse Copilot camelCase payloads; emit Copilot or Claude decision shapes via an explicit `--dialect` flag) and a self-filtering `preToolUse` commit/push gate. New checked-in config drives Copilot: `.github/hooks/guardrails.json` (camelCase-native, for CLI + cloud) and generated `.github/agents/*.agent.md` fixers. VS Code rides the existing `.claude/` wiring it reads natively. Two tool-agnostic floors — `.githooks/pre-commit` (templated for consumers; integrated into this repo's Husky) and a CI `guardrails verify` job — sit beneath every surface. State converges on runtime-neutral `.guardrails/state/`.

**Tech Stack:** TypeScript (strict, ESM → `.mjs` via tsup), Vitest, Node ≥24, ESLint/Prettier, Husky, GitHub Actions. Type-only devDeps `@anthropic-ai/claude-agent-sdk` (existing) and `@github/copilot-sdk` (new).

## Global Constraints

- **TDD-first** — no production code without a failing test first (repo rule, `CLAUDE.md`). Each core task follows write-test → run-fail → implement → run-pass → commit.
- **Node ≥ 24** (`engines.node >=24.0.0`); **TypeScript `^5`** (do not bump to 6 — breaks tsup dts, see `plan.md` / memory).
- **ESM import specifiers carry `.js`** (e.g. `import { x } from './scope.js'`) even though sources are `.ts` — matches the whole codebase.
- **Never weaken a check to pass it** — no `eslint-disable` / `@ts-ignore` / `as any` / `.skip` / assertion removal. The repo's own Stop-gate + diff-auditor guard this work (dogfooding).
- **Boundary type-safety** — at the hook-payload boundary, read field _names_ from published SDK types where available so schema drift breaks the build; runtime-check values (do not `as`-assert shapes). Follows the existing `parseHookInput` pattern and `plan.md`'s boundary roadmap.
- **State lives under `.guardrails/state/`** (runtime-neutral) after Task 1 — the single chokepoint is `stateDirectory()`.
- **Output-dialect default is `claude`** — commands emit Claude-format decisions unless invoked with `--dialect=copilot`, so the existing `.claude/` wiring is byte-for-byte unchanged.
- **`.github/` config is committed, not gitignored** — the cloud agent reads it from the default branch. Generated `.github/agents/` is committed with a CI drift-guard.
- Work happens in the `worktree-phase-b` worktree; paths below are repo-relative to its root.

---

### Task 1: Converge state on `.guardrails/state/`

Moves the single state-dir chokepoint off `.claude/state/guardrails/` to runtime-neutral `.guardrails/state/`, so the Copilot channel isn't borrowing Claude's directory and a Copilot-only repo works. State is ephemeral (7-day TTL), so no data migration.

**Files:**

- Modify: `guardrails-core/src/state-store.ts:27-29` (the `stateDirectory` function)
- Test: `guardrails-core/test/state-store.test.ts` (add one case)
- Modify: `.gitignore:7` (`.claude/state/` → `.guardrails/state/`)
- Modify: `CLAUDE.md` (one reference under "Kill-switch"/state)

**Interfaces:**

- Consumes: nothing new.
- Produces: `stateDirectory(repoRoot: string): string` now returns `<repoRoot>/.guardrails/state`. Signature unchanged; all callers (`cli-core.ts`, `gate.ts`, `scope.ts`) keep working.

- [ ] **Step 1: Write the failing test**

Add to `guardrails-core/test/state-store.test.ts`:

```ts
import { stateDirectory } from '../src/state-store.js';

describe('stateDirectory', () => {
  it('is the runtime-neutral .guardrails/state path', () => {
    expect(stateDirectory('/repo')).toBe(
      path.join('/repo', '.guardrails', 'state'),
    );
  });
});
```

(If `path` / `describe` / `it` / `expect` are not already imported in this file, add them: `import path from 'node:path';` and the vitest imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- state-store`
Expected: FAIL — current value is `.claude/state/guardrails`.

- [ ] **Step 3: Implement the change**

In `guardrails-core/src/state-store.ts`, replace the function body:

```ts
export function stateDirectory(repoRoot: string): string {
  return path.join(repoRoot, '.guardrails', 'state');
}
```

Also update the file's top doc comment: `.claude/state/guardrails/` → `.guardrails/state/`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- state-store`
Expected: PASS (all existing state-store tests still green — they use `stateDirectory` output relatively, not the literal path).

- [ ] **Step 5: Update `.gitignore` and `CLAUDE.md`**

In `.gitignore`, change the line `.claude/state/` to `.guardrails/state/`. Leave `.claude/agents/` as-is.

In `CLAUDE.md`, update any literal `.claude/state/` mention to `.guardrails/state/` (the state description under Setup/Kill-switch).

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npm run test`
Expected: PASS.

```bash
git add guardrails-core/src/state-store.ts guardrails-core/test/state-store.test.ts .gitignore CLAUDE.md
git commit -m "refactor: converge guardrail state on runtime-neutral .guardrails/state/"
```

---

### Task 2: Parse Copilot camelCase payloads (dual-dialect input)

`parseHookInput` today reads only Claude-format snake_case. Copilot pipes camelCase (`sessionId`, `toolName`, `toolArgs`). Extend it to read _either_ shape at the field level, and add a `command` field (needed by the commit/push gate). Bind Copilot field _names_ to `@github/copilot-sdk` types if it exports the file-hook wire shapes; otherwise a documented local interface.

**Files:**

- Modify: `package.json` (add `@github/copilot-sdk` devDependency)
- Modify: `guardrails-core/src/hook-io.ts:16-73` (imports, `HookInput`, `RawHookPayload`, `parseHookInput`)
- Test: `guardrails-core/test/hook-io.test.ts` (add Copilot cases)

**Interfaces:**

- Consumes: nothing new.
- Produces: `HookInput` gains `command?: string`. `parseHookInput(stdin: string): HookInput` now populates `sessionId`/`cwd`/`toolName`/`filePath`/`command` from Claude _or_ Copilot payloads.

- [ ] **Step 1: Add the type-only devDependency and inspect its exports**

Run:

```bash
npm install --save-dev --save-exact @github/copilot-sdk
node -e "const s=require('@github/copilot-sdk'); console.log(Object.keys(s))" 2>/dev/null || true
ls node_modules/@github/copilot-sdk/dist/*.d.ts 2>/dev/null || true
```

Read the package's `.d.ts` (or `nodejs/README.md`) to see whether it exports a hook-input type carrying the camelCase wire fields (`toolName`, `toolArgs`, `sessionId`). Record the finding in the commit message.

- **If it exports a matching type** (e.g. a `PreToolUseInput`/`HookInput` with those fields): import it type-only in Step 3 and `Pick` the fields from it.
- **If not:** use the local `CopilotHookPayload` interface written in Step 3 (fields hand-declared), and add a one-line note to `plan.md`'s Phase-B risk list that the Copilot payload binding is local pending SDK coverage. Either way the runtime value-checks are identical.

Keep the dependency regardless — it is type-only (erased at build) and documents intent.

- [ ] **Step 2: Write the failing tests**

Add to `guardrails-core/test/hook-io.test.ts` inside `describe('parseHookInput', …)`:

```ts
it('extracts fields from a Copilot camelCase preToolUse payload', () => {
  const parsed = parseHookInput(
    JSON.stringify({
      sessionId: 'xyz',
      cwd: '/repo',
      toolName: 'bash',
      toolArgs: { command: 'git commit -m wip' },
    }),
  );
  expect(parsed).toEqual({
    sessionId: 'xyz',
    cwd: '/repo',
    toolName: 'bash',
    command: 'git commit -m wip',
  });
});

it('extracts the edited path from a Copilot postToolUse payload', () => {
  const parsed = parseHookInput(
    JSON.stringify({
      sessionId: 'xyz',
      cwd: '/repo',
      toolName: 'edit',
      toolArgs: { path: '/repo/src/a.ts' },
    }),
  );
  expect(parsed.filePath).toBe('/repo/src/a.ts');
});

it('reads the git command from a Claude Bash payload too', () => {
  const parsed = parseHookInput(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' } }),
  );
  expect(parsed.command).toBe('git push');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -- hook-io`
Expected: FAIL — `command` undefined; camelCase fields ignored.

- [ ] **Step 4: Implement dual-dialect parsing**

In `guardrails-core/src/hook-io.ts`, add `command` to `HookInput`:

```ts
export interface HookInput {
  sessionId?: string;
  cwd?: string;
  filePath?: string;
  toolName?: string;
  command?: string;
}
```

Add the Copilot payload view. **If Step 1 found a matching SDK export**, replace this local interface with a `Pick` from the import; otherwise keep it local:

```ts
/** Copilot camelCase hook payload — the fields we read. Local declaration;
 * replace with a @github/copilot-sdk Pick if that package exports the wire type. */
interface CopilotHookPayload {
  sessionId?: unknown;
  cwd?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
}
```

Rewrite `parseHookInput` to read either shape, field by field (Claude snake_case first, Copilot camelCase fallback):

```ts
export function parseHookInput(stdin: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const claude = parsed as RawHookPayload;
  const copilot = parsed as CopilotHookPayload;
  const input: HookInput = {};

  const sessionId = claude.session_id ?? copilot.sessionId;
  if (typeof sessionId === 'string') {
    input.sessionId = sessionId;
  }
  if (typeof claude.cwd === 'string') {
    input.cwd = claude.cwd;
  }
  const toolName = claude.tool_name ?? copilot.toolName;
  if (typeof toolName === 'string') {
    input.toolName = toolName;
  }

  // Argument bag: Claude's `tool_input` or Copilot's `toolArgs`.
  const args = isRecord(claude.tool_input)
    ? claude.tool_input
    : isRecord(copilot.toolArgs)
      ? copilot.toolArgs
      : undefined;
  if (args) {
    const filePath = args.file_path ?? args.path;
    if (typeof filePath === 'string') {
      input.filePath = filePath;
    }
    if (typeof args.command === 'string') {
      input.command = args.command;
    }
  }
  return input;
}
```

(`RawHookPayload` stays as-is; `cwd` is shared between dialects so no camelCase fallback is needed for it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- hook-io`
Expected: PASS (existing Claude cases still green — snake_case is read first).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add package.json package-lock.json guardrails-core/src/hook-io.ts guardrails-core/test/hook-io.test.ts
git commit -m "feat: parse Copilot camelCase hook payloads + git command field"
```

---

### Task 3: Dialect-aware decision output

Add output formatters so the same commands can emit a Copilot decision shape or the Claude shape. `preToolUse` deny: Copilot wants top-level `{ permissionDecision, permissionDecisionReason }`; Claude wants it wrapped in `hookSpecificOutput`. `agentStop` block: Copilot wants `{ decision, reason }` with the correction folded into `reason` (no `additionalContext` channel).

**Files:**

- Modify: `guardrails-core/src/hook-io.ts` (add `Dialect`, `formatPreToolUseDeny`, `formatCopilotStopOutput`; import `stopHookReason`… see note)
- Test: `guardrails-core/test/hook-io.test.ts` (add cases)

**Interfaces:**

- Consumes: `GateDecision` (from `gate-decision.js`); `stopHookReason` lives in `gate.ts` — to avoid a `hook-io → gate` dependency cycle, **inline the same one-liner** here rather than importing it.
- Produces:
  - `type Dialect = 'claude' | 'copilot'`
  - `formatPreToolUseDeny(reason: string, dialect: Dialect): HookOutput`
  - `formatCopilotStopOutput(decision: GateDecision): HookOutput | null`

- [ ] **Step 1: Write the failing tests**

Add to `guardrails-core/test/hook-io.test.ts`:

```ts
import {
  formatCopilotStopOutput,
  formatPreToolUseDeny,
} from '../src/hook-io.js';

describe('formatPreToolUseDeny', () => {
  it('emits the Claude hookSpecificOutput shape by default', () => {
    expect(formatPreToolUseDeny('nope', 'claude')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
      },
    });
  });

  it('emits the Copilot top-level shape', () => {
    expect(formatPreToolUseDeny('nope', 'copilot')).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: 'nope',
    });
  });
});

describe('formatCopilotStopOutput', () => {
  const base: GateDecision = {
    outcome: 'delegate',
    block: true,
    message: 'spawn the fixer',
    nextSession: { attempts: 1, ruleCounts: {}, corrected: [] },
    nextRecurrence: {},
  };

  it('returns null when not blocking', () => {
    expect(
      formatCopilotStopOutput({ ...base, outcome: 'clean', block: false }),
    ).toBeNull();
  });

  it('folds the correction into reason (no hookSpecificOutput)', () => {
    expect(
      formatCopilotStopOutput({ ...base, additionalContext: 'stop that' }),
    ).toEqual({ decision: 'block', reason: 'spawn the fixer\n\nstop that' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- hook-io`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the formatters**

In `guardrails-core/src/hook-io.ts` add:

```ts
export type Dialect = 'claude' | 'copilot';

/** PreToolUse deny in the requested dialect. Claude nests under
 * hookSpecificOutput; Copilot uses a top-level permissionDecision. */
export function formatPreToolUseDeny(
  reason: string,
  dialect: Dialect,
): HookOutput {
  if (dialect === 'copilot') {
    return { permissionDecision: 'deny', permissionDecisionReason: reason };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Copilot agentStop block: correction folded into `reason` (Copilot has no
 * additionalContext channel). `null` lets the turn end. */
export function formatCopilotStopOutput(
  decision: GateDecision,
): HookOutput | null {
  if (!decision.block) {
    return null;
  }
  const reason =
    decision.additionalContext === undefined
      ? decision.message
      : `${decision.message}\n\n${decision.additionalContext}`;
  return { decision: 'block', reason };
}
```

Note: `HookOutput` is `SyncHookJSONOutput`, whose fields (`decision`, `reason`, `hookSpecificOutput`, `permissionDecision`, …) come from the SDK. If the SDK's `SyncHookJSONOutput` does not permit a top-level `permissionDecision`, widen the return type to `HookOutput | { permissionDecision: 'deny'; permissionDecisionReason: string }` and adjust — but check first; the PreToolUse deny shape is part of the Claude hook schema.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- hook-io`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add guardrails-core/src/hook-io.ts guardrails-core/test/hook-io.test.ts
git commit -m "feat: dialect-aware preToolUse-deny and Copilot agentStop output"
```

---

### Task 4: Merge-base baseline for the commit gate

`gate --mode=commit` audits `git diff --cached` with no baseline, so a suppression already on the branch flags on every commit (the Phase-A stub deferred the fix). Extract a shared `runCommitGate` that audits the branch's cumulative diff **against the merge-base with the base branch** — so suppressions inherited from `main` are excluded but any introduced on the branch are caught.

**Files:**

- Modify: `guardrails-core/src/gate.ts` (add `CommitGateOptions`, `CommitGateResult`, `runCommitGate`)
- Modify: `guardrails-core/src/cli-core.ts:107-130` (rewrite `gateCommitCommand` to use it)
- Test: `guardrails-core/test/commit-gate.test.ts` (new)

**Interfaces:**

- Consumes: `runVerify`, `auditDiff`, `hasErrors`, `Exec`.
- Produces:
  - `interface CommitGateOptions { repoRoot: string; baseBranch: string; exec: Exec; resolveBin?: (tool: string) => string }`
  - `interface CommitGateResult { violations: Violation[]; findings: AuditFinding[]; blocked: boolean }`
  - `async function runCommitGate(options: CommitGateOptions): Promise<CommitGateResult>`

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/commit-gate.test.ts`. Use a canned `Exec` so no real git runs:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { runCommitGate } from '../src/gate.js';

function execResult(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

// An Exec that returns a merge-base sha, then a diff for `git diff <sha>`.
function fakeExec(diffForBase: string): Exec {
  return vi.fn(async (command, args) => {
    if (args[0] === 'merge-base') return execResult('BASESHA\n');
    if (args[0] === 'diff' && args[1] === 'BASESHA')
      return execResult(diffForBase);
    return execResult('');
  }) as unknown as Exec;
}

const ADDED_DISABLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,1 @@',
  '+// eslint-disable-next-line',
].join('\n');

describe('runCommitGate', () => {
  it('flags a suppression introduced on the branch (merge-base diff)', async () => {
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(ADDED_DISABLE),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('is clean when the branch diff has no suppressions', async () => {
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec('+const x = 1;\n'),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });
});
```

(This test exercises the audit path. `runVerify` with a fake `Exec` that returns empty eslint/tsc output yields zero violations, so `blocked` tracks the findings; the fake returns `''` for all other git calls.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- commit-gate`
Expected: FAIL — `runCommitGate` not exported.

- [ ] **Step 3: Implement `runCommitGate`**

In `guardrails-core/src/gate.ts` add (after the existing imports, alongside `runStopGate`):

```ts
import { hasErrors } from './violation.js';

export interface CommitGateOptions {
  repoRoot: string;
  baseBranch: string;
  exec: Exec;
  resolveBin?: (tool: string) => string;
}

export interface CommitGateResult {
  violations: Violation[];
  findings: AuditFinding[];
  blocked: boolean;
}

/** Diff of the branch vs its merge-base with the base branch, so suppressions
 * inherited from the base branch are excluded. Falls back to the staged diff
 * when the merge-base can't be resolved (shallow clone / missing base). */
async function branchDiff(options: CommitGateOptions): Promise<string> {
  const mergeBase = await options.exec(
    'git',
    ['merge-base', options.baseBranch, 'HEAD'],
    { cwd: options.repoRoot },
  );
  const sha = mergeBase.stdout.trim();
  if (mergeBase.code === 0 && sha) {
    const diff = await options.exec('git', ['diff', sha], {
      cwd: options.repoRoot,
    });
    return diff.stdout;
  }
  const staged = await options.exec('git', ['diff', '--cached'], {
    cwd: options.repoRoot,
  });
  return staged.stdout;
}

export async function runCommitGate(
  options: CommitGateOptions,
): Promise<CommitGateResult> {
  const { violations } = await runVerify({
    repoRoot: options.repoRoot,
    baseBranch: options.baseBranch,
    exec: options.exec,
    ...(options.resolveBin ? { resolveBin: options.resolveBin } : {}),
  });
  const findings = auditDiff(await branchDiff(options));
  return {
    violations,
    findings,
    blocked: hasErrors(violations) || findings.length > 0,
  };
}
```

- [ ] **Step 4: Rewrite `gateCommitCommand` to use it**

In `guardrails-core/src/cli-core.ts`, replace the body of `gateCommitCommand` (lines ~107-130) and add `runCommitGate` to the `./gate.js` import:

```ts
async function gateCommitCommand(deps: CliDeps): Promise<number> {
  const repoRoot = deps.cwd;
  const config = loadConfig(repoRoot);
  const { violations, findings } = await runCommitGate({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    resolveBin: binResolver(repoRoot),
  });
  printViolations(deps, violations);
  for (const finding of findings) {
    deps.stderr(
      `${finding.file}:${finding.line} added ${finding.kind}: ${finding.text}\n`,
    );
  }
  return hasErrors(violations) || findings.length > 0 ? 1 : 0;
}
```

Update the import line `import { runStopGate } from './gate.js';` → `import { runCommitGate, runStopGate } from './gate.js';`. Remove the now-unused `auditDiff` import from `cli-core.ts` **only if** no other function there uses it — `auditCommand` still calls `auditDiff`, so keep the import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- commit-gate cli-core`
Expected: PASS.

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS.

```bash
git add guardrails-core/src/gate.ts guardrails-core/src/cli-core.ts guardrails-core/test/commit-gate.test.ts
git commit -m "feat: merge-base baseline for the commit gate (only new suppressions flag)"
```

---

### Task 5: `gate --mode=pretooluse` — the Copilot commit/push gate

A hook-style gate that reads a `preToolUse` payload on stdin, self-filters (fires only on a shell tool whose command is `git commit`/`git push`), runs `runCommitGate`, and emits a dialect-appropriate `deny` when the tree is dirty — else stays silent (allow).

**Files:**

- Modify: `guardrails-core/src/cli-core.ts` (add `gatePreToolUseCommand`; route it from `runCommand`; import formatters)
- Test: `guardrails-core/test/cli-core.test.ts` (add cases — follow the existing `CliDeps`-injection pattern there)

**Interfaces:**

- Consumes: `parseHookInput`, `formatPreToolUseDeny`, `Dialect` (Task 2/3); `runCommitGate` (Task 4); `loadConfig`.
- Produces: CLI behavior — `guardrails gate --mode=pretooluse [--dialect=copilot]` reads stdin and prints a deny decision (or nothing).

- [ ] **Step 1: Write the failing tests**

Open `guardrails-core/test/cli-core.test.ts` and mirror its existing dependency-injection style (a fake `CliDeps` with `exec`, `readStdin`, `cwd`, captured `stdout`/`stderr`). Add:

```ts
it('denies a git commit when the tree is dirty (copilot dialect)', async () => {
  // exec: merge-base → sha, diff <sha> → an added eslint-disable, verify → clean
  const deps = makeDeps({
    stdin: JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'git commit -m wip' },
      cwd: '/repo',
    }),
    exec: gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': '+// eslint-disable-next-line\n',
    }),
  });
  const code = await runCommand(
    'gate',
    ['--mode=pretooluse', '--dialect=copilot'],
    deps,
  );
  expect(code).toBe(0); // hook always exits 0; the decision is in stdout
  const out = JSON.parse(deps.stdoutText());
  expect(out.permissionDecision).toBe('deny');
});

it('stays silent for a non-git shell command', async () => {
  const deps = makeDeps({
    stdin: JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'ls -la' },
    }),
  });
  const code = await runCommand(
    'gate',
    ['--mode=pretooluse', '--dialect=copilot'],
    deps,
  );
  expect(code).toBe(0);
  expect(deps.stdoutText()).toBe('');
});

it('stays silent on a clean commit', async () => {
  const deps = makeDeps({
    stdin: JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'git commit -m ok' },
      cwd: '/repo',
    }),
    exec: gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': '+const x = 1;\n',
    }),
  });
  const code = await runCommand(
    'gate',
    ['--mode=pretooluse', '--dialect=copilot'],
    deps,
  );
  expect(deps.stdoutText()).toBe('');
});
```

Reuse or add small helpers next to the existing tests: `makeDeps({stdin, exec})` building a `CliDeps` (default `exec` returns empty `ExecResult`, `cwd: '/repo'`, `stdout`/`stderr` capturing to strings with a `stdoutText()` accessor); `gitExec(map)` returning canned stdout keyed by `args.join(' ')` (`'merge-base'` matches when `args[0]==='merge-base'`; `'diff BASESHA'` when `args.slice(0,2).join(' ')==='diff BASESHA'`), empty otherwise. Match whatever helper style `cli-core.test.ts` already uses.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- cli-core`
Expected: FAIL — `--mode=pretooluse` falls through to the stop gate today.

- [ ] **Step 3: Implement the command**

In `guardrails-core/src/cli-core.ts`:

Extend the formatters import:

```ts
import {
  type Dialect,
  formatPreToolUseDeny,
  formatStopHookOutput,
  type HookOutput,
  parseHookInput,
  resolveLocalBin,
} from './hook-io.js';
```

Add the shell/git detectors and the command:

```ts
const SHELL_TOOLS = /^(?:bash|shell|powershell)$/i;
const GIT_WRITE = /\bgit\s+(?:commit|push)\b/;

async function gatePreToolUseCommand(
  deps: CliDeps,
  dialect: Dialect,
): Promise<void> {
  const input = parseHookInput(await deps.readStdin());
  // Self-filter: only shell tools running git commit/push. VS Code ignores
  // matchers, so the command must gate itself regardless of hook config.
  if (
    input.toolName === undefined ||
    !SHELL_TOOLS.test(input.toolName) ||
    input.command === undefined ||
    !GIT_WRITE.test(input.command)
  ) {
    return; // allow (silent)
  }
  const repoRoot = input.cwd ?? deps.cwd;
  const config = loadConfig(repoRoot);
  const { violations, findings, blocked } = await runCommitGate({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    resolveBin: binResolver(repoRoot),
  });
  if (!blocked) {
    return; // allow (silent)
  }
  const reason =
    `guardrails: ${violations.length} violation(s), ` +
    `${findings.length} added suppression(s). ` +
    `Resolve them before committing (run 'guardrails verify').`;
  deps.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));
}
```

Route it in `runCommand`'s `gate` case:

```ts
case 'gate': {
  const mode = flag(rest, 'mode');
  const dialect: Dialect = flag(rest, 'dialect') === 'copilot' ? 'copilot' : 'claude';
  if (mode === 'commit') {
    return gateCommitCommand(deps);
  }
  if (mode === 'pretooluse') {
    await gatePreToolUseCommand(deps, dialect);
    return 0;
  }
  return gateStopCommand(deps, dialect);
}
```

Thread `dialect` into `gateStopCommand` (Task 3 output selection): change its signature to `gateStopCommand(deps: CliDeps, dialect: Dialect)` and pick the formatter:

```ts
const output =
  dialect === 'copilot'
    ? formatCopilotStopOutput(decision)
    : formatStopHookOutput(decision);
```

Add `formatCopilotStopOutput` to the `./hook-io.js` import.

Update the usage string in the `default` case to mention the modes:
`'usage: guardrails <verify|autofix|audit|gate [--mode=stop|commit|pretooluse] [--dialect=copilot]|state|scope-check|session-start|session-end>\n'`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- cli-core`
Expected: PASS (existing stop-gate test still green — default dialect is `claude`, and no `--dialect` flag reproduces prior output).

- [ ] **Step 5: Full check + commit**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS.

```bash
git add guardrails-core/src/cli-core.ts guardrails-core/test/cli-core.test.ts
git commit -m "feat: gate --mode=pretooluse self-filtering Copilot commit/push gate"
```

---

### Task 6: Author `.github/hooks/guardrails.json` (native dialect)

The camelCase-native Copilot hook config for CLI + cloud. Committed (cloud reads it from the default branch). Self-filtering everywhere (VS Code ignores matchers). A parse test guards its validity and the CLI paths it invokes.

**Files:**

- Create: `.github/hooks/guardrails.json`
- Test: `guardrails-core/test/github-hooks-config.test.ts` (new)

**Interfaces:**

- Consumes: the CLI commands `autofix`, `gate --mode=stop`, `gate --mode=pretooluse`, `scope-check` (all existing after Tasks 1-5).
- Produces: the committed config file.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/github-hooks-config.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const config = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      '..',
      '..',
      '.github',
      'hooks',
      'guardrails.json',
    ),
    'utf8',
  ),
) as {
  version: number;
  hooks: Record<string, { hooks: { command?: string }[] }[]>;
};

describe('.github/hooks/guardrails.json', () => {
  it('declares the camelCase native envelope', () => {
    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks).sort()).toEqual(
      ['agentStop', 'postToolUse', 'preToolUse'].sort(),
    );
  });

  it('invokes the copilot dialect on the deny-capable gates', () => {
    const commands = JSON.stringify(config.hooks);
    expect(commands).toContain('gate --mode=stop --dialect=copilot');
    expect(commands).toContain('gate --mode=pretooluse --dialect=copilot');
    expect(commands).toContain('scope-check --dialect=copilot');
    expect(commands).toContain('autofix');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- github-hooks-config`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create the config**

Create `.github/hooks/guardrails.json`. Command paths resolve the built CLI the same way the plugin's `hooks.json` does. Add `--dialect=copilot` to the deny-capable events; the two `preToolUse` entries self-filter internally (scope-check by manifest, the gate by tool+command).

```json
{
  "version": 1,
  "disableAllHooks": false,
  "hooks": {
    "postToolUse": [
      {
        "matcher": "edit|create|str_replace_editor|apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/node_modules/guardrails-core/dist/cli.mjs\" autofix"
          }
        ]
      }
    ],
    "preToolUse": [
      {
        "matcher": "bash|shell|powershell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/node_modules/guardrails-core/dist/cli.mjs\" gate --mode=pretooluse --dialect=copilot"
          }
        ]
      },
      {
        "matcher": "edit|create|str_replace_editor|apply_patch|view",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/node_modules/guardrails-core/dist/cli.mjs\" scope-check --dialect=copilot"
          }
        ]
      }
    ],
    "agentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/node_modules/guardrails-core/dist/cli.mjs\" gate --mode=stop --dialect=copilot"
          }
        ]
      }
    ]
  }
}
```

Note: `scope-check` must accept `--dialect=copilot` — it already routes through `flag(rest,'dialect')` if you thread the dialect into `scopeCheckCommand`'s `denyPreToolUse` the same way as the gate. **In Task 5 Step 3, also update `scopeCheckCommand` + `denyPreToolUse` to take `dialect` and call `formatPreToolUseDeny(reason, dialect)`** instead of hand-building the Claude shape, and read the dialect in the `scope-check` case of `runCommand`. (This unifies deny output; do it now if not already.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- github-hooks-config`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `npm run typecheck && npm run test`
Expected: PASS.

```bash
git add .github/hooks/guardrails.json guardrails-core/test/github-hooks-config.test.ts guardrails-core/src/cli-core.ts
git commit -m "feat: .github/hooks/guardrails.json native Copilot channel (CLI + cloud)"
```

---

### Task 7: Generate committed `.github/agents/*.agent.md` fixers (+ drift guard)

Extend `scripts/sync-agents.mjs` to also emit Copilot-format fixer agents from the single source of truth (`guardrails-plugin/agents/`). Unlike `.claude/agents/` (gitignored), these are **committed** (cloud reads the default branch), so CI verifies they are in sync.

**Files:**

- Modify: `scripts/sync-agents.mjs`
- Create (generated, committed): `.github/agents/guardrail-fixer.agent.md`, `.github/agents/guardrail-fixer-thorough.agent.md`
- Modify: `.github/workflows/ci.yml` (add a drift-guard step)
- Modify: `guardrails.config.json` + `guardrails-core/src/config.ts` (optional Copilot model knobs)
- Modify: `CLAUDE.md` (note the new generated-and-committed target)
- Test: `guardrails-core/test/config.test.ts` (cover the new optional fields)

**Interfaces:**

- Consumes: `guardrails-plugin/agents/*.md` frontmatter (`name`, `description`, `model`) + body.
- Produces: committed `.agent.md` files; `RepoConfig` gains `copilotFastModel?: string` and `copilotThoroughModel?: string`.

- [ ] **Step 1: Add optional Copilot model config (test first)**

Add to `guardrails-core/test/config.test.ts`:

```ts
it('defaults the Copilot model knobs to undefined', () => {
  const config = defaultConfig();
  expect(config.copilotFastModel).toBeUndefined();
  expect(config.copilotThoroughModel).toBeUndefined();
});
```

Run: `npm run test -- config` → FAIL.

In `guardrails-core/src/config.ts`, add to `RepoConfig`:

```ts
  /** Copilot model id for the fast/thorough fixer .agent.md (the tier ladder on
   * Copilot). Unset → omit `model` so the agent loads on Copilot's default. */
  copilotFastModel?: string;
  copilotThoroughModel?: string;
```

In `loadConfig`, after the existing fields, add (only set when a string is present, to keep them truly optional):

```ts
    ...(typeof raw.copilotFastModel === 'string'
      ? { copilotFastModel: raw.copilotFastModel }
      : {}),
    ...(typeof raw.copilotThoroughModel === 'string'
      ? { copilotThoroughModel: raw.copilotThoroughModel }
      : {}),
```

(`defaultConfig` leaves them unset.) Run: `npm run test -- config` → PASS.

- [ ] **Step 2: Extend `scripts/sync-agents.mjs`**

Append Copilot emission after the existing `.claude/agents` copy loop. Add near the top:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const githubAgents = path.join(root, '.github', 'agents');

// Copilot fixer tool allowlist (Copilot tool names, NOT Claude's). Read+edit
// family only; `bash` and `agent`/`task` are withheld so the fixer can't shell
// out or fan out (the latter reinforced by `agents: []`).
const COPILOT_TOOLS = [
  'view',
  'edit',
  'create',
  'apply_patch',
  'str_replace_editor',
];

// Map the CC model tier keyword → a Copilot model id from guardrails.config.json.
const cfg = (() => {
  try {
    return JSON.parse(
      readFileSync(path.join(root, 'guardrails.config.json'), 'utf8'),
    );
  } catch {
    return {};
  }
})();
const MODEL_FOR = {
  haiku: cfg.copilotFastModel,
  sonnet: cfg.copilotThoroughModel,
};

function frontmatterField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

function toCopilotAgent(source) {
  const parts = source.split(/^---$/m);
  // parts[0] = '' , parts[1] = frontmatter , parts.slice(2) = body
  const fm = parts[1];
  const body = parts.slice(2).join('---').replace(/^\n/, '');
  const name = frontmatterField(fm, 'name');
  const description = frontmatterField(fm, 'description');
  const model = MODEL_FOR[frontmatterField(fm, 'model')];
  const lines = ['---', `name: ${name}`, `description: ${description}`];
  lines.push(`tools: [${COPILOT_TOOLS.join(', ')}]`);
  lines.push('agents: []');
  if (model) lines.push(`model: ${model}`);
  lines.push('---', '', body.trimEnd(), '');
  return lines.join('\n');
}

rmSync(githubAgents, { recursive: true, force: true });
mkdirSync(githubAgents, { recursive: true });
for (const file of agents) {
  const source = readFileSync(path.join(from, file), 'utf8');
  const target = file.replace(/\.md$/, '.agent.md');
  writeFileSync(path.join(githubAgents, target), toCopilotAgent(source));
}
console.log(
  `synced ${agents.length} agent(s): guardrails-plugin/agents → .github/agents (.agent.md)`,
);
```

Run: `npm run build` and inspect the two generated files:
`cat .github/agents/guardrail-fixer.agent.md` — confirm valid frontmatter (`name`, `description`, `tools: [...]`, `agents: []`; `model` absent because config knobs are unset), body identical to the source prompt.

- [ ] **Step 3: Verify Copilot model ids, then (optionally) set the config knobs**

Check the Copilot custom-agents docs for the model identifiers exposed to `.agent.md` (`model:`). **If confirmed**, set `copilotFastModel` / `copilotThoroughModel` in `guardrails.config.json` and re-run `npm run build`. **If not confirmable now**, leave them unset (agents load on Copilot's default model) and add a one-line note to `plan.md`'s Phase-B risk list: "Copilot fixer tier-ladder pending model-id confirmation — config-only flip, no code change." Do **not** invent an id.

- [ ] **Step 4: Do NOT gitignore; add the CI drift guard**

Confirm `.github/agents/` is **not** in `.gitignore` (it isn't — only `.claude/agents/` is). Add a step to `.github/workflows/ci.yml` after `Build`:

```yaml
- name: Agents in sync (generated .github/agents committed)
  run: git diff --exit-code -- .github/agents
```

(Build regenerates them; a diff means someone edited a source without committing the regenerated output.)

- [ ] **Step 5: Update `CLAUDE.md`**

In the "Editing the loop" section, note: `.github/agents/*.agent.md` is **generated by `npm run build` and committed** (cloud reads the default branch), guarded by the CI `git diff --exit-code` step — edit `guardrails-plugin/agents/`, rebuild, and commit the regenerated `.github/agents/` output; never hand-edit it.

- [ ] **Step 6: Full check + commit**

Run: `npm run build && npm run typecheck && npm run lint && npm run test`
Expected: PASS.

```bash
git add scripts/sync-agents.mjs .github/agents guardrails-core/src/config.ts guardrails-core/test/config.test.ts guardrails.config.json CLAUDE.md .github/workflows/ci.yml
git commit -m "feat: generate committed .github/agents Copilot fixers + CI drift guard"
```

---

### Task 8: Make the diff-auditor mention-aware (discovered during execution)

**Why (finding):** wiring `gate --mode=commit` as a hard blocker (Task 9) surfaced a real dogfooding finding — `auditDiff` is a pure text scan that flags any added line containing a suppression token, with no awareness of context. Against this repo it false-positived on: prose (`CLAUDE.md`/`README`/`plan.md`/agent `.md` prompts), string literals in test fixtures (`'+// eslint-disable-next-line'`), and the auditor's **own** pattern definitions in `audit.ts`. The auditor genuinely adds value at the commit boundary (it catches human-added suppressions that eslint/tsc can't, since the scaffold disables `no-unsafe-*`), so the right fix is to make it precise — not to mask it with `enforcement: warn`. This task must land BEFORE Task 9 wires the gate as a blocker.

**The discriminator:**

- **Non-source files** never contain real suppressions → audit only recognized source extensions (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .java`; extensible). Findings for any other file (`.md`, `.json`, `.yaml`, …) are dropped.
- **Directive patterns** (`eslint-disable`, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`) are real only when a comment's content STARTS with the token (`// eslint-disable-next-line`, `/* eslint-disable */`, `// @ts-ignore`). Rejects `// TS: eslint-disable[-next-line]`, `'eslint-disable'` strings, and `/eslint-disable/` regexes.
- **Code patterns** (`as any`/`as unknown as`/`<any>`, `@SuppressWarnings`, `@Disabled`, `.skip`/`.only`/`xit`/…) are real only in the CODE portion of a line — strip string-literal and comment spans first, then match. Rejects `as any` inside `'...'` fixtures and inside `// ...` describing comments.

**Files:**

- Modify: `guardrails-core/src/audit.ts` (add a source-extension gate; split signatures into directive vs code classes; add a light single-line lexer to locate string/comment spans; apply the two matching rules)
- Test: `guardrails-core/test/audit.test.ts` (add a mention-awareness describe block; keep every existing case green)

**Interfaces:**

- Consumes: nothing new.
- Produces: `auditDiff(diffText: string): AuditFinding[]` — same signature, more precise. `AuditKind`/`AuditFinding` unchanged.

- [ ] **Step 1: Write the failing corpus (must-NOT-flag)**

Add a describe block with these cases (each expects `auditDiff(...)` to return `[]`). Use the existing `diff(file, addedLine)` helper in `audit.test.ts` (it builds a one-line unified diff for `file`); note the FILE arg drives the extension gate.

- `diff('README.md', '+never add `eslint-disable`or`as any`or`.skip`')` → non-source.
- `diff('audit.ts', "+  { kind: 'eslint-disable', pattern: /eslint-disable/ },")` → string + regex, no directive/code.
- `diff('audit.ts', "+  | 'cast-any' // TS: as any / as unknown as / <any>")` → string + describing comment.
- `diff('audit.ts', '+  | \'skipped-test\'; // TS/JS: .skip / .only / xit / fit')` → describing comment.
- `diff('a.test.ts', "+  auditDiff(diff('a.ts', '+  const x = foo as any;'))")` → `as any` inside a string.
- `diff('a.ts', '+  // see the eslint-disable rule referenced below')` → token mid-comment, not directive-leading.

- [ ] **Step 2: Add the must-FLAG cases and run RED**

Add (each expects the given `kind`), then run `npm run test -- audit` and confirm the must-NOT-flag cases FAIL (current auditor over-matches) while these still pass:

- `diff('a.ts', '+  // eslint-disable-next-line no-console')` → `eslint-disable`.
- `diff('a.ts', '+  /* eslint-disable */')` → `eslint-disable`.
- `diff('a.ts', '+  // @ts-ignore')` → `ts-suppress`.
- `diff('a.ts', '+  const x = foo as any;')` → `cast-any`.
- `diff('a.ts', '+  return bar as unknown as Baz;')` → `cast-any`.
- `diff('a.test.ts', "+  it.skip('x', () => {});")` → `skipped-test` (the `it.skip` is code; only the `'x'` is a string).
- `diff('A.java', '+  @SuppressWarnings("unchecked")')` → `suppress-warnings`.
- `diff('A.java', '+  @Disabled')` → `disabled-test`.

- [ ] **Step 3: Implement the precise auditor**

In `audit.ts`: (a) add `isAuditableSourceFile(file)` (extension allowlist) and skip signature matching when the current `+++` file is not auditable; (b) classify each signature as `directive` or `code`; (c) add a single-line scanner that returns the line's comment content (after `//` / inside `/* */`, not inside a string) and its code-only text (string + comment spans removed), handling `'`, `"`, `` ` `` with backslash escapes; (d) match `directive` signatures only against a comment whose trimmed content STARTS with the token, and `code` signatures only against the code-only text. Keep `AuditFinding.line`/`text` semantics (report the original added line trimmed). No nested ternaries (sonarjs).

- [ ] **Step 4: Run GREEN + the existing suite**

Run: `npm run test -- audit`
Expected: all new must-NOT-flag and must-FLAG cases PASS, and every pre-existing `audit.test.ts` case still PASSES (e.g. the oscillation/removed-suppression tests in `gate.test.ts` that depend on `auditDiff` behavior — run `npm run test` to confirm the whole suite).

- [ ] **Step 5: Dogfood check — the auditor no longer flags its own repo**

Run: `npm run build && node ./node_modules/guardrails-core/dist/cli.mjs gate --mode=commit; echo "exit=$?"`
Expected: the long false-positive list is gone. Any remaining findings are REAL suppressions — there should be none in this strict repo, so `exit=0`. If a genuine suppression is found, that is a true positive (report it); do not weaken the auditor to hide it.

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS.

```bash
git add guardrails-core/src/audit.ts guardrails-core/test/audit.test.ts
git commit -m "fix: diff-auditor flags real suppressions, not mentions (source-only, directive-at-comment-start, code-portion casts)"
```

---

### Task 9: Tool-agnostic floors — git pre-commit + CI verify

The two backstops no surface can skip: a `.githooks/pre-commit` template (for consumer repos) plus the same check wired into this repo's Husky, and a CI `guardrails verify` job. **Depends on Task 8** — the commit gate is now a real hard blocker, which is only safe because the auditor is mention-aware.

**Files:**

- Create: `.githooks/pre-commit`
- Modify: `.husky/pre-commit`
- Modify: `.github/workflows/ci.yml` (add a `guardrails verify` step)
- Modify: `README.md` (one line documenting the consumer `.githooks` template)

**Interfaces:**

- Consumes: `guardrails gate --mode=commit` (Task 4), `guardrails verify` (existing).
- Produces: the committed floor artifacts.

- [ ] **Step 1: Create the consumer `.githooks/pre-commit` template**

Create `.githooks/pre-commit` (executable):

```sh
#!/bin/sh
# Universal, tool-agnostic guardrail floor for consumer repos. Fires for ANY
# committer (human or agent) that shells out to git. Activate with:
#   git config core.hooksPath .githooks
# This repo uses Husky instead (see .husky/pre-commit), which runs the same
# check; the template ships for repos scaffolded by guardrails (Phase E).
node "./node_modules/guardrails-core/dist/cli.mjs" gate --mode=commit || {
  echo "guardrails: commit blocked — resolve violations or run 'guardrails verify'." >&2
  exit 1
}
```

Make it executable: `chmod +x .githooks/pre-commit`.

- [ ] **Step 2: Wire the same check into this repo's Husky**

`.husky/pre-commit` currently is just `npx lint-staged`. Append the guardrails commit gate so this repo exercises its own floor (dogfooding). New content:

```sh
npx lint-staged
node "./node_modules/guardrails-core/dist/cli.mjs" gate --mode=commit
```

(If the gate exits non-zero, the commit aborts — the intended floor. `--no-verify` remains the documented bypass.)

- [ ] **Step 3: Verify the floor locally**

Run (does not commit): `node ./node_modules/guardrails-core/dist/cli.mjs gate --mode=commit; echo "exit=$?"`
Expected: `exit=0` on a clean tree (build must be current: `npm run build` first).

- [ ] **Step 4: Add the CI verify job step**

In `.github/workflows/ci.yml`, add after the `Build` step (and after the Task 7 drift-guard step):

```yaml
- name: Guardrails verify
  run: node ./node_modules/guardrails-core/dist/cli.mjs verify
```

(`verify` exits non-zero on error-severity violations — the authoritative, only-guaranteed gate from `plan.md` §7. It runs post-Build so `dist/cli.mjs` exists.)

- [ ] **Step 5: Document the consumer template**

In `README.md`, add one line under the setup/enforcement section: consumer repos activate the universal floor with `git config core.hooksPath .githooks`; this repo uses Husky, which runs the identical `guardrails gate --mode=commit`.

- [ ] **Step 6: Commit**

Run: `npm run build && npm run test`
Expected: PASS.

```bash
git add .githooks/pre-commit .husky/pre-commit .github/workflows/ci.yml README.md
git commit -m "feat: git pre-commit + CI verify floors beneath every surface"
```

---

### Task 10: Copilot live-loop verification doc

The manual acceptance script for the interactive-only first surface (VS Code via `.claude/` reuse), plus the CLI native-dialect run. Mirrors `docs/live-loop-verification.md`. Also the vehicle that closes carry-in #2 (scope-lock frontmatter firing).

**Files:**

- Create: `docs/copilot-live-loop-verification.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the doc**

Create `docs/copilot-live-loop-verification.md` covering:

1. **Preconditions** — `npm install` (builds `dist/`); confirm `.claude/` wiring present; VS Code with Copilot agent mode (hooks Preview enabled); for the CLI section, Copilot CLI installed with `.github/hooks/guardrails.json` on the branch.
2. **VS Code loop (primary):** in a Copilot agent-mode session, introduce an assertionless test (`vitest/expect-expect`), let the agent finish a turn → confirm the `Stop`/`agentStop` gate **blocks** with the terse pointer → the agent spawns `guardrail-fixer` → the fix re-verifies clean. Then trip the rule across 3 turns → observe the recurrence correction. Force an unfixable case → observe escalation to the main agent.
3. **Scope-lock proof (closes carry-in #2):** during a fixer run, direct it to read a file **outside the repo** (e.g. `~/.claude/…`) → confirm the `scope-check` `PreToolUse` hook **denies** it. The denied out-of-repo read is the confirming signal. Record PASS/FAIL in `plan.md` (Task 11).
4. **CLI loop (native dialect):** repeat the assertionless-test loop through Copilot CLI, driven by `.github/hooks/guardrails.json`; confirm `gate --mode=pretooluse` denies a `git commit` while dirty.
5. **Cloud (deferred):** note the default-branch requirement and that live cloud proof is out of scope this phase.

- [ ] **Step 2: Commit**

```bash
git add docs/copilot-live-loop-verification.md
git commit -m "docs: Copilot live-loop verification script (VS Code + CLI)"
```

---

### Task 11: Update `plan.md` (corrections + status)

Fold the phase's factual corrections and status into the self-describing plan.

**Files:**

- Modify: `plan.md` (§7 correction; Phase-B open-questions resolution; carry-in #2 result; phase status)

**Interfaces:** none.

- [ ] **Step 1: Correct §7 (cross-runtime map)**

Replace the claim that Copilot `Stop` is observational with: Copilot `agentStop` (= Claude `Stop`) **can** block turn-end and force another turn; the Copilot analog is **richest-per-surface** — `agentStop`-block where supported, the `preToolUse` commit/push gate as the universal deny (and the only reliable gate on cloud), with git pre-commit + CI beneath. Reference the design spec `docs/superpowers/specs/2026-07-16-phase-b-copilot-channel-design.md`.

- [ ] **Step 2: Resolve the "Open questions surfaced in review" for Phase B**

Under the Phase-B open-questions section, record the settled facts: hooks are Preview in VS Code / effectively shipped on CLI+cloud; no enterprise policy specifically gates `.github/hooks` or custom agents (only whole-surface disable); the native dialect is camelCase in `.github/hooks/*.json` (matchers ignored in VS Code → self-filter); state converged on `.guardrails/state/`; fixer scope-lock is enforced repo-level on CLI/cloud (per-agent frontmatter hooks are VS-Code-Preview only).

- [ ] **Step 3: Record the carry-in #2 result**

Add the outcome of the Task 9 scope-lock proof (PASS = the out-of-repo read was denied; FAIL = fall back per the spec's Risks). If Phase B ships before the live run, mark it "pending live-loop" rather than asserting a result.

- [ ] **Step 4: Update phase status**

Mark Phase B's build-phase line and add a short "Phase B status" note listing what shipped (dual-dialect hook I/O, `gate --mode=pretooluse`, merge-base commit baseline, mention-aware diff-auditor, `.github/hooks` + `.github/agents`, git + CI floors, `.guardrails/state/`).

- [ ] **Step 5b: Record the diff-auditor finding + resolution**

Add to the "Roadmap: fixer-loop hardening" (or a new roadmap subsection) the diff-auditor finding surfaced this phase and how it was resolved: the auditor was a context-free text scan that flagged suppression-token _mentions_ (prose, string literals, its own pattern source); Phase B made it mention-aware (source-file gate; directive-at-comment-start; code-patterns matched against the code portion only). Note the remaining known limitation (multi-line block comments are not lexed across lines) and the separate **repo-hygiene item**: this worktree's `main` ref sits at the initial commit, so the commit gate's merge-base diff spans the whole repo — advancing `main` to the true integration base would both narrow the gate's scope and speed up `verify`.

- [ ] **Step 5: Commit**

```bash
git add plan.md
git commit -m "docs: record Phase B corrections, resolved unknowns, and status in plan.md"
```

---

## Self-Review

**Spec coverage** (each spec section → task):

- Dual payload parsing → Task 2. ✓
- `gate --mode=pretooluse` → Task 5. ✓
- Commit-gate merge-base baseline → Task 4. ✓
- Copilot `agentStop` output → Task 3 + wired in Task 5. ✓
- `stateDirectory()` → `.guardrails/state/` → Task 1. ✓
- `.github/hooks/guardrails.json` → Task 6. ✓
- `.agent.md` fixers via sync + single-source + fan-out lock → Task 7. ✓
- `.githooks/pre-commit` + Husky integration → Task 8. ✓
- CI `guardrails verify` → Task 8; agents drift-guard → Task 7. ✓
- Validation (headless throughout; VS Code + CLI live-loop) → Tasks 1-8 tests + Task 9. ✓
- `plan.md` §7 correction + status → Task 10. ✓
- Type-only `@github/copilot-sdk` dep → Task 2. ✓

**Cloud-agent commit requirement:** `.github/hooks/guardrails.json` (Task 6) and `.github/agents/` (Task 7) are committed, not gitignored — satisfied, with the drift-guard covering the generated agents.

**Type consistency:** `runCommitGate`/`CommitGateResult` (Task 4) consumed unchanged in Task 5; `Dialect`, `formatPreToolUseDeny`, `formatCopilotStopOutput` (Task 3) consumed in Tasks 5-6; `HookInput.command` (Task 2) consumed in Task 5; `stateDirectory()` (Task 1) signature unchanged, all callers intact; `copilotFastModel`/`copilotThoroughModel` (Task 7) read in `sync-agents.mjs`.

**Placeholder scan:** the two genuinely external unknowns — the `@github/copilot-sdk` file-hook type export (Task 2 Step 1) and the Copilot model ids (Task 7 Step 3) — are handled as verify-then-choose steps with concrete written fallbacks (local interface; omit `model`), not deferred blanks. No "TBD"/"handle appropriately" steps remain.

**Ordering:** state (1) → input parse (2) → output format (3) → commit-gate core (4) → gate command (5) → config (6) → agents (7) → floors (8) → docs (9, 10). Each task ends green and independently reviewable.
