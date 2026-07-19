# knip Integration + Drift-Guard Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add knip as the first Phase-C analyzer (on the commit rung, via a new verify-profile seam) and build a per-tool drift-guard test that fails the build when a hardcoded third-party id disappears upstream.

**Architecture:** knip runs whole-graph at the commit/CI rungs only, kept off the per-turn Stop gate by a new `profile` field on `VerifyOptions`. A pure `parseKnipJson` adapter maps knip's `--reporter json` output into the existing `Violation` contract, dispatched from `runVerify` exactly as ESLint/tsc are. A separate hermetic drift-guard test holds a registry of `{ tool, knownIds, probe }` entries and asserts `knownIds ⊆ probe()` for knip (issue-type keys from a real knip run) and the eslint-family (rule ids from the flat config + core rules).

**Tech Stack:** TypeScript (strict, ESM → `.mjs`), Vitest, knip 6.x, ESLint 9 flat config, the injected `Exec` seam.

## Global Constraints

- **TDD** — no production code without a failing test first. Every task writes the test, watches it fail, then implements.
- **Fix code, don't weaken rules** — never add `eslint-disable` / `@ts-ignore` / `as any` / `.skip`, delete code to quiet a checker, or raise thresholds.
- **knip is 6.27.0+** — the JSON shape below is confirmed against 6.27.0. If `npm install` resolves a different 6.x, re-capture the fixture in Task 2 Step 1 and adjust field access only if keys changed.
- **knip `fixable` is always `false`** — knip `--fix` deletes code; dead-code removal is never a silent PostToolUse autofix.
- **knip runs project-wide, clean-baseline** — the repo must be knip-clean before the commit gate relies on it (Task 1 enforces this). Matches tsc's existing stance in `verify/index.ts`.
- **Commit gate stays block-only** — this plan does NOT make knip delegate; its `knip/` loose-classification is intentionally dormant under this cut (see the design doc §3.1).
- **File layout** — source in `guardrails-core/src/`, tests mirror under `guardrails-core/test/` (e.g. `src/verify/knip-adapter.ts` ↔ `test/verify/knip-adapter.test.ts`). Tests import source via the `.js` extension (`../../src/verify/knip-adapter.js`).
- **`Exec` seam** — every shell-out takes the injected `Exec`; unit tests use a `fakeExec`, never real processes, EXCEPT the drift-guard test (Task 4), which spawns real knip against a fixture by design.

**Reference: confirmed knip 6.27.0 `--reporter json` shape.** Top level is `{ "issues": Issue[] }`. Each `Issue` has a `file` string plus 13 always-present issue-type keys (present even when empty):

```json
{
  "issues": [
    {
      "file": "src/orphan.ts",
      "files": [{ "name": "src/orphan.ts" }],
      "exports": [],
      "types": [],
      "dependencies": [],
      "devDependencies": [],
      "optionalPeerDependencies": [],
      "unlisted": [],
      "unresolved": [],
      "binaries": [],
      "duplicates": [],
      "enumMembers": [],
      "namespaceMembers": [],
      "catalog": []
    },
    {
      "file": "src/index.ts",
      "files": [],
      "exports": [{ "name": "unusedExport", "line": 2, "col": 17, "pos": 53 }],
      "types": [{ "name": "UnusedType", "line": 3, "col": 13, "pos": 94 }],
      "dependencies": [],
      "devDependencies": [],
      "optionalPeerDependencies": [],
      "unlisted": [],
      "unresolved": [],
      "binaries": [],
      "duplicates": [],
      "enumMembers": [],
      "namespaceMembers": [],
      "catalog": []
    }
  ]
}
```

- Unused **file** → an entry in `files: [{ name }]` (no line/col); `issue.file` equals that path.
- Unused **export/type/dependency/…** → `{ name, line?, col?, pos? }` entries under the issue-type key.
- knip exits **non-zero when findings exist**, writing JSON to stdout regardless (like ESLint) — we parse stdout, ignore the exit code.

**Reference: issue types the adapter maps (first cut).** The nine uniform `{ name, line?, col? }`-shaped types:

```
files, exports, types, dependencies, devDependencies,
optionalPeerDependencies, unlisted, unresolved, binaries
```

The four nested/non-uniform types (`duplicates`, `enumMembers`, `namespaceMembers`, `catalog`) are **out of scope for this cut** — documented in the adapter, a follow-up.

---

## Task 1: Enable knip and baseline-clean the repo

Installs knip, configures it for this workspace, and removes any genuine dead code so the commit gate starts from a clean baseline. No adapter wiring yet — knip does not run in any gate until Task 3, so this task can iterate freely.

**Files:**

- Modify: `package.json` (root — add `knip` devDependency)
- Create: `knip.json` (root)
- Modify: whatever source files knip flags as genuinely dead (unknown until run)

- [ ] **Step 1: Install knip at the workspace root**

Run: `npm install -D knip --workspace-root` (or plain `npm install -D knip` from the repo root)
Expected: `knip` appears in root `package.json` devDependencies; `node_modules/.bin/knip` exists.

- [ ] **Step 2: Create a starting `knip.json`**

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "workspaces": {
    "guardrails-core": {
      "entry": ["src/cli.ts", "src/index.ts"],
      "project": ["src/**/*.ts", "test/**/*.ts"]
    }
  },
  "ignoreDependencies": [
    "husky",
    "lint-staged",
    "tsup",
    "fallow",
    "@vitest/coverage-istanbul"
  ]
}
```

Rationale: knip flags build/config-only devDeps (husky, lint-staged, tsup, the coverage provider, the graph tool) as "unused" because nothing imports them — they are invoked by scripts/hooks. Seed the ignore list with those; add others only after confirming they are genuinely config-only.

- [ ] **Step 3: Run knip and triage**

Run: `npx knip`
Expected: a list of findings. For each finding decide:

- **Genuine dead code** (an unused export/type/file with no real consumer) → delete it in Step 4.
- **Config-only dependency** knip can't see (e.g. a plugin loaded by string) → add to `ignoreDependencies`.
- **Entry point knip missed** (a file that IS a root, e.g. a script) → add to `entry`.

Triage `@anthropic-ai/claude-agent-sdk` explicitly: if nothing imports it, it is dead — remove the dependency rather than ignore it.

- [ ] **Step 4: Remove genuine dead code; re-run until clean**

Delete each genuinely-unused export/file knip flagged. Re-run `npx knip` after each change.
Run: `npx knip`
Expected: `✂️  Excellent, Knip found no issues.` and exit code 0.

- [ ] **Step 5: Confirm the existing suite still passes**

Run: `npm test`
Expected: all tests pass (no regression from any dead-code removal).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json knip.json
git add -A   # include any dead-code deletions
git commit -m "chore(knip): install knip, configure workspace, baseline-clean dead code"
```

---

## Task 2: knip adapter (`parseKnipJson`)

A pure function mapping knip JSON → `Violation[]`, mirroring `parseEslintJson`. No orchestrator wiring — this task is the mapper and its unit tests only.

**Files:**

- Create: `guardrails-core/src/verify/knip-adapter.ts`
- Test: `guardrails-core/test/verify/knip-adapter.test.ts`

**Interfaces:**

- Consumes: `Violation` from `../violation.js`.
- Produces: `export function parseKnipJson(stdout: string, repoRoot: string, packageId?: string): Violation[]`. Emits `ruleId: 'knip/<issueType>'`, `tool: 'knip'`, `severity: 'error'`, `fixable: false`, `line` only when knip supplies a numeric line, `package` only when `packageId` is given. `file` is the repo-relative path already present in knip output (knip emits repo-relative paths, so no `path.relative` needed — unlike ESLint's absolute `filePath`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { parseKnipJson } from '../../src/verify/knip-adapter.js';

const root = '/repo';

const stdout = JSON.stringify({
  issues: [
    {
      file: 'src/orphan.ts',
      files: [{ name: 'src/orphan.ts' }],
      exports: [],
      types: [],
      dependencies: [],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
    {
      file: 'src/index.ts',
      files: [],
      exports: [{ name: 'unusedExport', line: 2, col: 17, pos: 53 }],
      types: [{ name: 'UnusedType', line: 3, col: 13, pos: 94 }],
      dependencies: [{ name: 'left-pad' }],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
  ],
});

describe('parseKnipJson', () => {
  it('maps a fully-unused file to knip/files with no line', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations).toContainEqual({
      ruleId: 'knip/files',
      file: 'src/orphan.ts',
      message: 'Unused file',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
  });

  it('maps unused exports and types with their line numbers', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations).toContainEqual({
      ruleId: 'knip/exports',
      file: 'src/index.ts',
      line: 2,
      message: 'Unused export: unusedExport',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
    expect(violations).toContainEqual({
      ruleId: 'knip/types',
      file: 'src/index.ts',
      line: 3,
      message: 'Unused type: UnusedType',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
  });

  it('maps an unused dependency with no line', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations).toContainEqual({
      ruleId: 'knip/dependencies',
      file: 'src/index.ts',
      message: 'Unused dependency: left-pad',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
  });

  it('never marks a knip violation fixable', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations.every((v) => v.fixable === false)).toBe(true);
  });

  it('threads packageId onto every violation when given', () => {
    const violations = parseKnipJson(stdout, root, 'guardrails-core');
    expect(violations.every((v) => v.package === 'guardrails-core')).toBe(true);
  });

  it('returns [] on empty or malformed stdout', () => {
    expect(parseKnipJson('', root)).toEqual([]);
    expect(parseKnipJson('not json', root)).toEqual([]);
    expect(parseKnipJson('{}', root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run guardrails-core/test/verify/knip-adapter.test.ts`
Expected: FAIL — `parseKnipJson` is not a module export.

- [ ] **Step 3: Write the minimal implementation**

```ts
/**
 * knip adapter: maps `knip --reporter json` output into `Violation[]`.
 *
 * knip reports whole-graph dead code grouped by file. Each issue object carries
 * a fixed set of issue-type keys; this adapter maps the nine uniform
 * `{ name, line?, col? }`-shaped types. The four nested/non-uniform types
 * (`duplicates`, `enumMembers`, `namespaceMembers`, `catalog`) are intentionally
 * not mapped in this first cut — a documented follow-up.
 *
 * Every knip violation is `fixable: false`: knip's own `--fix` DELETES code, and
 * dead-code removal is a maybe-live judgment, never a silent autofix. knip emits
 * repo-relative paths already, so no `path.relative` is applied.
 */

import type { Violation } from '../violation.js';

/** The uniform issue types mapped in this cut, and their human labels. */
const MAPPED_ISSUE_TYPES: Record<string, string> = {
  files: 'file',
  exports: 'export',
  types: 'type',
  dependencies: 'dependency',
  devDependencies: 'devDependency',
  optionalPeerDependencies: 'optional peer dependency',
  unlisted: 'unlisted dependency',
  unresolved: 'unresolved import',
  binaries: 'unlisted binary',
};

interface KnipEntry {
  name: string;
  line?: number;
}

interface KnipIssue {
  file: string;
  [issueType: string]: unknown;
}

function isKnipReport(value: unknown): value is { issues: KnipIssue[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    (value as { issues: unknown[] }).issues.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as KnipIssue).file === 'string',
    )
  );
}

function isEntryArray(value: unknown): value is KnipEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as KnipEntry).name === 'string',
    )
  );
}

export function parseKnipJson(
  stdout: string,
  _repoRoot: string,
  packageId?: string,
): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isKnipReport(parsed)) {
    return [];
  }

  const violations: Violation[] = [];
  for (const issue of parsed.issues) {
    for (const [issueType, label] of Object.entries(MAPPED_ISSUE_TYPES)) {
      const entries = issue[issueType];
      if (!isEntryArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        const message =
          issueType === 'files'
            ? 'Unused file'
            : `Unused ${label}: ${entry.name}`;
        const violation: Violation = {
          ruleId: `knip/${issueType}`,
          file: issue.file,
          message,
          severity: 'error',
          fixable: false,
          tool: 'knip',
          ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
          ...(packageId === undefined ? {} : { package: packageId }),
        };
        violations.push(violation);
      }
    }
  }
  return violations;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run guardrails-core/test/verify/knip-adapter.test.ts`
Expected: PASS (all six `it` blocks).

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/verify/knip-adapter.ts guardrails-core/test/verify/knip-adapter.test.ts
git commit -m "feat(verify): knip adapter mapping knip JSON to Violation[]"
```

---

## Task 3: verify profile seam + wire knip into the gates

Adds `profile` to `VerifyOptions`, dispatches knip only when `profile !== 'stop'`, and threads the right profile from each caller (`stop` gate → `stop`; commit gate → `commit`; CLI verify/CI → `ci`).

**Files:**

- Modify: `guardrails-core/src/verify/index.ts` (add `profile`, dispatch knip)
- Modify: `guardrails-core/src/gate.ts:129-134` (runStopGate verifyOptions → `profile: 'stop'`) and `:201-206` (runCommitGate → `profile: 'commit'`)
- Modify: `guardrails-core/src/cli-core.ts:60-65` (verifyCommand → `profile: 'ci'`)
- Test: `guardrails-core/test/verify/orchestrator.test.ts` (extend)

**Interfaces:**

- Consumes: `parseKnipJson` from `./knip-adapter.js` (Task 2).
- Produces: `VerifyOptions.profile?: 'stop' | 'commit' | 'ci'` (default `'stop'`). When `profile !== 'stop'`, `runVerify` additionally runs `resolveBin('knip')` with `['--reporter', 'json']` from `repoRoot` and appends `parseKnipJson(stdout, repoRoot, packageId)`.

- [ ] **Step 1: Write the failing tests (extend `orchestrator.test.ts`)**

Add a knip JSON constant near the top of the file:

```ts
const knipJson = JSON.stringify({
  issues: [
    {
      file: 'src/dead.ts',
      files: [{ name: 'src/dead.ts' }],
      exports: [],
      types: [],
      dependencies: [],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
  ],
});
```

Extend `fakeExec` to answer knip: add this branch **before** the final `return` in the `exec` closure:

```ts
if (command === 'knip' || args.includes('knip')) {
  return Promise.resolve(ok(knipJson));
}
```

Add these tests inside the `describe('runVerify', ...)` block:

```ts
it('runs knip and includes its violations at the commit profile', async () => {
  const { exec, calls } = fakeExec();
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'commit',
  });
  expect(violations.map((v) => v.ruleId)).toContain('knip/files');
  expect(
    calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
  ).toBe(true);
});

it('does NOT run knip at the stop profile (default)', async () => {
  const { exec, calls } = fakeExec();
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec, // no profile → defaults to 'stop'
  });
  expect(violations.map((v) => v.ruleId)).not.toContain('knip/files');
  expect(
    calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
  ).toBe(false);
});

it('runs knip at the ci profile', async () => {
  const { exec, calls } = fakeExec();
  await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'ci',
  });
  expect(
    calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
  ).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run guardrails-core/test/verify/orchestrator.test.ts`
Expected: FAIL — `VerifyOptions` has no `profile`; knip never runs (the commit/ci assertions fail).

- [ ] **Step 3: Add `profile` to `VerifyOptions` and dispatch knip**

In `guardrails-core/src/verify/index.ts`, add the import:

```ts
import { parseKnipJson } from './knip-adapter.js';
```

Add the field to `VerifyOptions` (after `resolveBin?`):

```ts
  /** Cadence rung. Heavy whole-graph analyzers (knip) run only at commit/ci;
   *  the per-turn stop gate stays fast. Defaults to 'stop'. */
  profile?: 'stop' | 'commit' | 'ci';
```

In `runVerify`, after the tsc block and before `return { violations }`, add:

```ts
// knip is whole-graph (not diff-scoped) and seconds-scale, so it runs only at
// the commit/ci rungs — never on the per-turn stop gate. It assumes a
// knip-clean baseline, like tsc (see this file's header).
const profile = options.profile ?? 'stop';
if (profile !== 'stop') {
  const knip = await exec(resolveBin('knip'), ['--reporter', 'json'], {
    cwd: repoRoot,
  });
  violations.push(...parseKnipJson(knip.stdout, repoRoot, packageId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run guardrails-core/test/verify/orchestrator.test.ts`
Expected: PASS (existing tests + the three new ones).

- [ ] **Step 5: Thread the profile from the three callers**

In `guardrails-core/src/gate.ts`, `runStopGate` (the `verifyOptions` object around line 129):

```ts
const verifyOptions = {
  repoRoot,
  baseBranch,
  exec,
  profile: 'stop' as const,
  ...(options.resolveBin ? { resolveBin: options.resolveBin } : {}),
};
```

In `runCommitGate` (the `runVerify({ ... })` call around line 201):

```ts
const { violations } = await runVerify({
  repoRoot: options.repoRoot,
  baseBranch: options.baseBranch,
  exec: options.exec,
  profile: 'commit',
  ...(options.resolveBin ? { resolveBin: options.resolveBin } : {}),
});
```

In `guardrails-core/src/cli-core.ts`, `verifyCommand` (the `runVerify({ ... })` call around line 60):

```ts
const { violations } = await runVerify({
  repoRoot,
  baseBranch: config.baseBranch,
  exec: deps.exec,
  profile: 'ci',
  resolveBin: binResolver(repoRoot),
});
```

- [ ] **Step 6: Run the full suite (guards the callers didn't regress)**

Run: `npm test`
Expected: all tests pass. In particular `test/gate.test.ts`, `test/commit-gate.test.ts`, and `test/cli-core.test.ts` still pass — their `fakeExec`s fall through to `ok('')` for the new knip call, which `parseKnipJson` maps to `[]`, so no behavior changes at those layers.

- [ ] **Step 7: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/src/gate.ts guardrails-core/src/cli-core.ts guardrails-core/test/verify/orchestrator.test.ts
git commit -m "feat(verify): profile seam — run knip at commit/ci rungs only"
```

---

## Task 4: drift-guard harness

A hermetic test that fails the build when a hardcoded third-party id disappears upstream. A registry of per-tool probes; each asserts `knownIds ⊆ probe()`. Two structurally different probes prove the harness generalizes: knip (issue-type keys from a real knip run) and eslint-family (rule ids from the flat config + core rules).

**Files:**

- Create: `guardrails-core/src/drift-guard.ts` (the registry-checking logic — pure, unit-testable)
- Create: `guardrails-core/test/drift-guard.test.ts` (logic unit tests, fake probes)
- Create: `guardrails-core/test/drift/knip-fixture/` (a self-contained knip project: `package.json`, `knip.json`, `src/index.ts` with one unused export)
- Create: `guardrails-core/test/drift/registry.test.ts` (the real knip + eslint-family probes wired to `checkDrift`)

**Interfaces:**

- Produces: `export interface DriftEntry { tool: string; knownIds: string[]; probe: () => Promise<Set<string>>; hint: string }` and `export async function checkDrift(entry: DriftEntry): Promise<{ tool: string; missing: string[]; hint: string }>`. `missing` is the `knownIds` absent from `probe()`; empty means no drift.

### 4a — the harness logic (pure, fake probes)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { checkDrift, type DriftEntry } from '../src/drift-guard.js';

const entry = (over: Partial<DriftEntry>): DriftEntry => ({
  tool: 'fake',
  knownIds: ['a', 'b'],
  probe: () => Promise.resolve(new Set(['a', 'b', 'c'])),
  hint: 'edit fake-rules.ts',
  ...over,
});

describe('checkDrift', () => {
  it('reports no missing ids when all known ids are present', async () => {
    const result = await checkDrift(entry({}));
    expect(result.missing).toEqual([]);
  });

  it('reports the known ids absent from the probe set', async () => {
    const result = await checkDrift(
      entry({ probe: () => Promise.resolve(new Set(['a'])) }),
    );
    expect(result.missing).toEqual(['b']);
    expect(result.hint).toBe('edit fake-rules.ts');
    expect(result.tool).toBe('fake');
  });

  it('reports all ids missing when the probe set is empty', async () => {
    const result = await checkDrift(
      entry({ probe: () => Promise.resolve(new Set()) }),
    );
    expect(result.missing).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run guardrails-core/test/drift-guard.test.ts`
Expected: FAIL — `checkDrift` is not a module export.

- [ ] **Step 3: Write the minimal implementation**

```ts
/**
 * Tool-upgrade drift-guard (roadmap: "Tool/language-upgrade drift guard").
 *
 * guardrails-core hardcodes third-party ids (loose-rule names in
 * `loose-rules.ts`, issue-type keys the knip adapter reads). When a tool is
 * upgraded and renames/removes an id, the hardcoded reference silently
 * mis-routes or under-matches. This harness turns that into a build failure:
 * each `DriftEntry` pairs the ids we depend on (`knownIds`) with a `probe` that
 * returns the tool's CURRENT id set, and `checkDrift` reports any known id the
 * probe no longer contains.
 *
 * Probes differ per tool because tools expose their ids differently — knip's
 * are keys in its JSON output, ESLint's are enumerable from loaded plugins — so
 * the registry holds arbitrary probe functions rather than one uniform query.
 */

export interface DriftEntry {
  tool: string;
  knownIds: string[];
  probe: () => Promise<Set<string>>;
  hint: string;
}

export async function checkDrift(
  entry: DriftEntry,
): Promise<{ tool: string; missing: string[]; hint: string }> {
  const current = await entry.probe();
  const missing = entry.knownIds.filter((id) => !current.has(id));
  return { tool: entry.tool, missing, hint: entry.hint };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run guardrails-core/test/drift-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/drift-guard.ts guardrails-core/test/drift-guard.test.ts
git commit -m "feat(drift-guard): checkDrift harness over per-tool id probes"
```

### 4b — the knip probe fixture

- [ ] **Step 6: Create the self-contained knip fixture**

`guardrails-core/test/drift/knip-fixture/package.json`:

```json
{ "name": "knip-drift-fixture", "private": true, "version": "0.0.0" }
```

`guardrails-core/test/drift/knip-fixture/knip.json`:

```json
{ "entry": ["src/entry.ts"], "project": ["src/**/*.ts"] }
```

`guardrails-core/test/drift/knip-fixture/src/entry.ts`:

```ts
import { used } from './lib.js';
console.log(used());
```

`guardrails-core/test/drift/knip-fixture/src/lib.ts`:

```ts
export function used() {
  return 1;
}
export function unusedExport() {
  return 2;
}
```

This fixture always produces ≥1 issue (the unused export), so a real knip run emits an issue object carrying all issue-type keys — the probe reads the key set off it.

- [ ] **Step 7: Verify the fixture emits the expected keys**

Run: `cd guardrails-core/test/drift/knip-fixture && npx knip --reporter json; cd -`
Expected: JSON on stdout whose issue object has keys including `files`, `exports`, `types`, `dependencies`, `devDependencies`, `optionalPeerDependencies`, `unlisted`, `unresolved`, `binaries`. (Non-zero exit is fine — findings exist.)

### 4c — the real registry (knip + eslint-family probes)

- [ ] **Step 8: Write the failing registry test**

`guardrails-core/test/drift/registry.test.ts`:

```ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { builtinRules } from 'eslint/use-at-your-own-risk';

import { checkDrift, type DriftEntry } from '../../src/drift-guard.js';
import { spawnExec } from '../../src/exec.js';
import eslintConfig from '../../../eslint.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const knipFixture = path.join(here, 'knip-fixture');

/** knip probe: run real knip against the fixture, collect issue-type keys. */
async function knipIssueTypes(): Promise<Set<string>> {
  const { stdout } = await spawnExec('knip', ['--reporter', 'json'], {
    cwd: knipFixture,
  });
  const parsed = JSON.parse(stdout) as { issues: Record<string, unknown>[] };
  const keys = new Set<string>();
  for (const issue of parsed.issues) {
    for (const key of Object.keys(issue)) {
      if (key !== 'file') {
        keys.add(key);
      }
    }
  }
  return keys;
}

/** eslint-family probe: every rule id available from the flat config + core. */
async function eslintRuleIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of builtinRules.keys()) {
    ids.add(name); // core rules are unprefixed, e.g. 'no-restricted-imports'
  }
  for (const block of eslintConfig as { plugins?: Record<string, unknown> }[]) {
    const plugins = block.plugins ?? {};
    for (const [ns, plugin] of Object.entries(plugins)) {
      const rules = (plugin as { rules?: Record<string, unknown> }).rules ?? {};
      for (const rule of Object.keys(rules)) {
        ids.add(`${ns}/${rule}`);
      }
    }
  }
  return ids;
}

const entries: DriftEntry[] = [
  {
    tool: 'knip',
    // The issue types the knip adapter (MAPPED_ISSUE_TYPES) depends on.
    knownIds: [
      'files',
      'exports',
      'types',
      'dependencies',
      'devDependencies',
      'optionalPeerDependencies',
      'unlisted',
      'unresolved',
      'binaries',
    ],
    probe: knipIssueTypes,
    hint: 'knip renamed/removed an issue type — update MAPPED_ISSUE_TYPES in guardrails-core/src/verify/knip-adapter.ts',
  },
  {
    tool: 'eslint-family',
    // Only loose ids whose plugin is CURRENTLY installed are asserted.
    // Forward-declared, not-yet-installed ids are excluded on purpose:
    //   - 'no-assertionless-test'  (LOOSE_RULE_NAMES): no installed plugin
    //   - 'boundaries/' prefix     (LOOSE_PREFIXES): eslint-plugin-boundaries not installed
    //   - 'stryker/', 'knip/', 'dependency-cruiser/' prefixes: no eslint plugin (knip covered by its own probe)
    // Move an id here from that list when its plugin lands.
    knownIds: [
      'vitest/expect-expect',
      'sonarjs/no-trivial-assertions',
      'sonarjs/assertions-in-tests',
      'no-restricted-imports',
    ],
    probe: eslintRuleIds,
    hint: 'a loose rule id in guardrails-core/src/loose-rules.ts no longer exists in its plugin — reconcile after the tool upgrade',
  },
];

describe('drift-guard registry', () => {
  for (const entry of entries) {
    it(`${entry.tool}: every known id still exists upstream`, async () => {
      const { missing, hint } = await checkDrift(entry);
      expect(missing, `${entry.tool} drift — ${hint}`).toEqual([]);
    }, 20_000);
  }
});
```

- [ ] **Step 9: Run the registry test**

Run: `npx vitest run guardrails-core/test/drift/registry.test.ts`
Expected: PASS both entries. (The knip entry spawns real knip — allow the 20s timeout. If knip resolution fails from the fixture cwd, confirm `node_modules/.bin/knip` is reachable and that `spawnExec('knip', …)` finds it via PATH; if not, switch the probe's command to the absolute `node_modules/.bin/knip` path via `binResolver(repoRoot)`.)

- [ ] **Step 10: Prove the guard actually catches drift (temporary sanity check)**

Temporarily add a bogus id to the eslint-family `knownIds` (e.g. `'vitest/this-rule-does-not-exist'`), run the test, confirm it FAILS with the hint, then remove it.

Run: `npx vitest run guardrails-core/test/drift/registry.test.ts`
Expected: FAIL naming the bogus id and the hint. Revert the edit; re-run → PASS.

- [ ] **Step 11: Commit**

```bash
git add guardrails-core/test/drift/
git commit -m "test(drift-guard): knip + eslint-family probes over the real registry"
```

---

## Task 5: docs, roadmap, and dogfooding capture

Records the design's load-bearing facts where future readers will look, and captures the drift-guard's first finding.

**Files:**

- Modify: `README.md` (knip caveat next to the tsc clean-baseline note)
- Modify: `plan.md` (Phase C status; mark the drift-guard roadmap bullet in-progress; record the dormant loose-class and the `no-assertionless-test` finding)
- Modify: `CLAUDE.md` ("Upgrading leveraged tools" — note the drift-guard now mechanizes the id-existence half)

- [ ] **Step 1: README — knip clean-baseline caveat**

Find the README section describing `verify` / the clean-baseline assumption for tsc and add:

```markdown
knip runs at the **commit and CI rungs only** (never the per-turn Stop gate) and
is whole-graph, so — like tsc — it assumes a **knip-clean baseline**. Run
`npx knip` clean before relying on the commit gate; pre-existing dead code will
otherwise block every commit until removed.
```

- [ ] **Step 2: plan.md — Phase C status + roadmap + findings**

Under the Phase C material, add a status note:

```markdown
## Phase C status (in progress)

- **Piece 1 — knip + drift-guard (shipped).** knip runs at the commit/ci rungs
  via a new `VerifyOptions.profile` seam; a `parseKnipJson` adapter maps its
  output to `Violation[]` (`fixable: false` — knip `--fix` deletes code). The
  drift-guard (`src/drift-guard.ts` + `test/drift/`) asserts the knip issue
  types and the resolvable eslint-family loose ids still exist upstream.
  Design: `docs/superpowers/specs/2026-07-18-phase-c-knip-drift-guard-design.md`.
  - **Dormant loose-class (by design):** knip is loose-classed but runs only on
    the block-only commit rung, so that thorough-tier routing is inert until the
    throttled Stop tier (option B) lands. Do NOT read the `knip/` loose entry as
    live behavior yet.
```

In the "Roadmap: fixer-loop hardening" list, update the tool-upgrade drift-guard bullet to note the first cut shipped (knip + eslint-family probes; `audit.ts` suppression-signature drift is the documented next registry entry).

Add a dogfooding finding under the roadmap:

```markdown
- **Drift-guard finding: `no-assertionless-test` resolves to no installed
  plugin.** `loose-rules.ts` `LOOSE_RULE_NAMES` lists `no-assertionless-test`,
  but no installed ESLint plugin provides it (checked while building the
  drift-guard). Likewise `boundaries/` has no installed plugin. Both are
  excluded from the drift-guard's asserted set and documented as
  forward-declared in `test/drift/registry.test.ts`; move them into `knownIds`
  when their plugins land. Harmless today (a loose name matching nothing never
  classifies anything), but recorded so the entries aren't mistaken for live.
```

- [ ] **Step 3: CLAUDE.md — mechanized drift note**

In the "Upgrading leveraged tools" section, append:

```markdown
The **id-existence half of this review is now mechanized**: the drift-guard
(`guardrails-core/test/drift/registry.test.ts`) fails the build if a hardcoded
loose id or knip issue type no longer exists upstream. You must still review the
**judgment half** — whether an upgrade added rules that _should_ be classed loose
(`loose-rules.ts`) or changed a suppression syntax the auditor watches
(`audit.ts`); the guard checks existence, not completeness.
```

- [ ] **Step 4: Run the full gated suite**

Run: `npm run test:coverage && npm run check:graph`
Expected: pass (this is the pre-push gate; docs changes don't affect it, but confirm nothing regressed across Tasks 1–5).

- [ ] **Step 5: Commit**

```bash
git add README.md plan.md CLAUDE.md
git commit -m "docs: knip clean-baseline caveat, Phase C status, drift-guard mechanization + no-assertionless-test finding"
```

---

## Self-Review

**Spec coverage** (against `2026-07-18-phase-c-knip-drift-guard-design.md`):

- §2 verify profile seam → Task 3. ✓
- §2 knip adapter → Task 2. ✓
- §2 drift-guard harness over loose-rules.ts via per-tool probes → Task 4 (knip + eslint-family). ✓
- §3.1 commit gate stays block-only; dormant loose-class recorded → Task 3 (no delegation change) + Task 5 Step 2. ✓
- §5 mapping table (ruleId/fixable/severity/line/package), project-wide clean-baseline, enablement → Task 2 + Task 1 + README (Task 5). ✓
- §5 nested issue types out of scope → documented in the adapter (Task 2 Step 3). ✓
- §6 registry shape, knip golden-fixture probe, eslint-family probe, hermetic → Task 4. ✓
- §6 audit.ts signatures = next entry → noted in Task 5 roadmap update. ✓
- §8 first-enable noise, dormant loose-class → Task 1 + Task 5. ✓
- Out-of-scope items (affected-scoping, option B, option iii, AST auditor) → not implemented, correctly. ✓

**Placeholder scan:** no "TBD/handle appropriately/similar to". knip JSON, adapter code, probe code, and the exact resolvable loose ids are all concrete and confirmed against installed versions. The only intentionally-iterative step is Task 1's knip config triage — inherent to knip adoption, with a concrete starting config, command, and acceptance criterion (`npx knip` exit 0).

**Type consistency:** `parseKnipJson(stdout, repoRoot, packageId?)` — defined Task 2, consumed Task 3 with matching args. `VerifyOptions.profile?: 'stop'|'commit'|'ci'` — defined Task 3, set by all three callers with those exact literals. `DriftEntry { tool, knownIds, probe, hint }` / `checkDrift` — defined Task 4a, consumed Task 4c with matching shape. `MAPPED_ISSUE_TYPES` keys (Task 2) match the knip drift `knownIds` (Task 4c). ✓
