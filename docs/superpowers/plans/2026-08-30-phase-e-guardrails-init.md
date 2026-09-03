# Phase E piece 4 — `guardrails init` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command that turns a fresh Node/TypeScript repo into a guarded one —
deterministic, idempotent, and safe to re-run on a repo whose owner has edited
what it wrote.

**Architecture:** Detection, plan computation, and file writing are three separate
modules, and the middle one is **pure**. `detect()` reads the world and returns
facts; `planScaffold()` turns facts plus decisions into a list of actions with no
I/O at all; `applyScaffold()` executes those actions. That split is not
decoration — the spec's own risk section calls for it, because this repo gates
mutation testing at zero tolerance on changed production files and `init` is
string-and-path-heavy. Pure plan computation means mutants die to fast unit tests
instead of to filesystem integration tests.

**Tech Stack:** TypeScript 5 (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), Node ≥24 ESM, Vitest, Stryker at the commit rung.

**Spec:** `docs/superpowers/specs/2026-08-30-phase-e-adoption-design.md` §6

## Global Constraints

- **`guardrails-core` has zero runtime dependencies.** Hand-roll what you need.
- **TDD.** No production code without a failing test first.
- **Never weaken a gate to pass it.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, deleted assertions, or raised thresholds.
- **Never add a `sanctionedSuppressions` entry or a `// Stryker disable`
  directive without asking the developer first** (`CLAUDE.md`). The config has
  exactly 27 entries and must still have 27 at the end of this piece. If a mutant
  survives and you believe it equivalent, STOP and report — three times in this
  phase that situation arose and was resolved by restructuring or by adding a
  real test, never by an exemption.
- TypeScript strictness is `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`. Optional properties use conditional spread.
- **House lint rejects:** abbreviations (`dir` → `directory`), unused parameters,
  and a bare `.sort()` (`sonarjs/no-alphabetical-sort` — use
  `.sort((a, b) => a.localeCompare(b))`). All three have already cost deviations
  in this phase.
- Prefix every command with `mise exec --`. The shell default is Node 25;
  dependency-cruiser refuses it and the commit gate then fails confusingly.
- Watch `runVerify`-style complexity: the pre-push gate (`check:graph`, fallow)
  failed once in this phase on a function that grew three branches. Keep
  functions small.
- Commit in small logical steps.

---

## Module layout and the contract between tasks

Everything new lives under `guardrails-core/src/scaffold/`. Tasks build it
bottom-up; each task's **Produces** block is the next task's input.

```
scaffold/
  manifest.ts   Task 2  — the committed .guardrails/scaffold.json, checksums
  detect.ts     Task 3  — reads the world, returns RepoFacts
  plan.ts       Task 4  — PURE: RepoFacts + Decisions -> ScaffoldPlan
  merge.ts      Task 5  — PURE: the SHARED-class content mergers
  apply.ts      Task 6  — executes a ScaffoldPlan against the filesystem
```

`resolveRepoRoot` (Task 1) goes in `src/repo-root.ts` — it is not
scaffold-specific and fixes a standing bug elsewhere.

---

## Task 1: `resolveRepoRoot` — the git-toplevel seam

**Files:**

- Create: `guardrails-core/src/repo-root.ts`
- Test: `guardrails-core/test/repo-root.test.ts`

**Interfaces:**

- Consumes: the existing `Exec` seam from `src/exec.ts`.
- Produces: `resolveRepoRoot(exec: Exec, cwd: string): Promise<string>`

Spec §6.8. There is no git-root resolution anywhere in `src` today: every handler
computes `repoRoot = input.cwd ?? deps.cwd`, so running the CLI from a
subdirectory writes state to a different `.guardrails/` and `recurrence.json`
silently fragments. `init` cannot write anything correctly without this, and a
real adopter running `guardrails verify` from a package directory hits it
immediately. This repo's single-package-at-root layout hides it completely.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/repo-root.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { resolveRepoRoot } from '../src/repo-root.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

describe('resolveRepoRoot', () => {
  it('returns the git toplevel, not the working directory', async () => {
    const exec: Exec = () => Promise.resolve(ok('/repo\n'));
    await expect(resolveRepoRoot(exec, '/repo/packages/api')).resolves.toBe(
      '/repo',
    );
  });

  it('trims trailing whitespace from git output', async () => {
    const exec: Exec = () => Promise.resolve(ok('/repo\n\n'));
    await expect(resolveRepoRoot(exec, '/repo')).resolves.toBe('/repo');
  });

  it('asks git from the given working directory', async () => {
    const calls: {
      command: string;
      args: string[];
      cwd: string | undefined;
    }[] = [];
    const exec: Exec = (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return Promise.resolve(ok('/repo'));
    };
    await resolveRepoRoot(exec, '/repo/sub');
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo/sub',
      },
    ]);
  });

  it('falls back to the working directory when git exits non-zero', async () => {
    // Not a git repo, or git is unavailable. Falling back preserves today's
    // behaviour rather than making every command fail.
    const exec: Exec = () =>
      Promise.resolve({
        stdout: '',
        stderr: 'not a git repository',
        code: 128,
      });
    await expect(resolveRepoRoot(exec, '/somewhere')).resolves.toBe(
      '/somewhere',
    );
  });

  it('falls back to the working directory when git cannot be started', async () => {
    const exec: Exec = () =>
      Promise.resolve({
        stdout: '',
        stderr: 'ENOENT',
        code: 1,
        spawnFailed: true,
      });
    await expect(resolveRepoRoot(exec, '/somewhere')).resolves.toBe(
      '/somewhere',
    );
  });

  it('falls back when git exits zero but prints nothing', async () => {
    const exec: Exec = () => Promise.resolve(ok('   \n'));
    await expect(resolveRepoRoot(exec, '/somewhere')).resolves.toBe(
      '/somewhere',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/repo-root.test.ts`
Expected: FAIL — cannot resolve `../src/repo-root.js`.

- [ ] **Step 3: Write the implementation**

Create `guardrails-core/src/repo-root.ts`:

```ts
/**
 * Resolve the repository root from any working directory inside it.
 *
 * Every handler currently computes `repoRoot = input.cwd ?? deps.cwd`, so
 * running the CLI from a subdirectory anchors `.guardrails/state` somewhere
 * else and `recurrence.json` — the repeat-offender ledger that drives
 * loose-routing and graduation — silently fragments and undercounts. It also
 * lets nested `.guardrails/` directories escape the root-anchored `.gitignore`
 * pattern. Invisible in this repo, which is one package at the root; certain to
 * bite a monorepo adopter.
 *
 * Failure falls back to `cwd` rather than throwing: a non-git directory or a
 * missing git binary should degrade to today's behaviour, not break every
 * command. The gate reports a missing git separately (`analyzer-missing`).
 */
import type { Exec } from './exec.js';

export async function resolveRepoRoot(
  exec: Exec,
  cwd: string,
): Promise<string> {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.spawnFailed === true || result.code !== 0) {
    return cwd;
  }
  const toplevel = result.stdout.trim();
  return toplevel === '' ? cwd : toplevel;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/repo-root.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check while the file is tiny**

Run: `mise exec -- npx stryker run --mutate guardrails-core/src/repo-root.ts`
Expected: 0 survived, 0 no-coverage. Kill any survivor with a test; do not add a
directive. Note this repo's own finding: a single-file Stryker run can report
**false** survivors (the vitest runner loads only related test files) — so a
clean result here is trustworthy, but before treating a reported survivor as real,
delete `reports/stryker-incremental.json` and re-check.

- [ ] **Step 6: Commit**

```bash
mise exec -- git add guardrails-core/src/repo-root.ts guardrails-core/test/repo-root.test.ts
mise exec -- git commit -m "feat(core): resolve the git toplevel instead of trusting cwd"
```

**Scope note:** this task adds the seam only. Re-pointing every existing
`repoRoot` computation at it is a broader behavioural change with its own risk,
and is NOT in this task — `init` (Task 7) is its first consumer. Retro-fitting
the rest is recorded as a follow-up at the end of this plan.

---

## Task 2: The scaffold manifest

**Files:**

- Create: `guardrails-core/src/scaffold/manifest.ts`
- Test: `guardrails-core/test/scaffold/manifest.test.ts`

**Interfaces:**

- Consumes: `readJsonFile` from `src/json-file.ts` (returns `{ parsed: unknown }`).
- Produces:
  - `interface ScaffoldManifest { guardrailsVersion: string; files: Record<string, string> }`
  - `checksum(content: string): string` — `sha256-<hex>`
  - `parseManifest(parsed: unknown): ScaffoldManifest | undefined`
  - `serializeManifest(manifest: ScaffoldManifest): string`
  - `MANIFEST_PATH = '.guardrails/scaffold.json'`

Spec §6.5. This is what makes re-running `init` safe: it records a checksum per
OWNED file, so an unmodified file can be upgraded while a consumer-edited one is
reported as drift and left alone.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/scaffold/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  checksum,
  MANIFEST_PATH,
  parseManifest,
  serializeManifest,
} from '../../src/scaffold/manifest.js';

describe('checksum', () => {
  it('is stable for identical content', () => {
    expect(checksum('hello')).toBe(checksum('hello'));
  });

  it('differs for different content', () => {
    expect(checksum('hello')).not.toBe(checksum('hello '));
  });

  it('is prefixed so the algorithm is visible in the committed file', () => {
    expect(checksum('hello')).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

describe('parseManifest', () => {
  it('reads a well-formed manifest', () => {
    expect(
      parseManifest({
        guardrailsVersion: '0.1.0',
        files: { 'a.md': 'sha256-x' },
      }),
    ).toEqual({ guardrailsVersion: '0.1.0', files: { 'a.md': 'sha256-x' } });
  });

  it('rejects a non-object', () => {
    expect(parseManifest(undefined)).toBeUndefined();
    expect(parseManifest('nope')).toBeUndefined();
    expect(parseManifest(null)).toBeUndefined();
    expect(parseManifest([])).toBeUndefined();
  });

  it('rejects a missing or non-string version', () => {
    expect(parseManifest({ files: {} })).toBeUndefined();
    expect(parseManifest({ guardrailsVersion: 1, files: {} })).toBeUndefined();
  });

  it('rejects a missing or non-object files map', () => {
    expect(parseManifest({ guardrailsVersion: '0.1.0' })).toBeUndefined();
    expect(
      parseManifest({ guardrailsVersion: '0.1.0', files: [] }),
    ).toBeUndefined();
  });

  it('drops entries whose checksum is not a string', () => {
    // A malformed entry must not be trusted as "unmodified" — dropping it makes
    // the file read as untracked, which is the safe direction: init reports
    // drift rather than silently overwriting a consumer's edit.
    expect(
      parseManifest({
        guardrailsVersion: '0.1.0',
        files: { good: 'sha256-x', bad: 7 },
      }),
    ).toEqual({ guardrailsVersion: '0.1.0', files: { good: 'sha256-x' } });
  });
});

describe('serializeManifest', () => {
  it('round-trips through parseManifest', () => {
    const manifest = {
      guardrailsVersion: '0.1.0',
      files: { 'b.md': 'sha256-y' },
    };
    expect(parseManifest(JSON.parse(serializeManifest(manifest)))).toEqual(
      manifest,
    );
  });

  it('emits deterministic output with sorted keys and a trailing newline', () => {
    // Determinism keeps the committed manifest out of every diff and lets a CI
    // drift-check work on it.
    const one = serializeManifest({
      guardrailsVersion: '0.1.0',
      files: { 'b.md': 'sha256-y', 'a.md': 'sha256-x' },
    });
    const two = serializeManifest({
      guardrailsVersion: '0.1.0',
      files: { 'a.md': 'sha256-x', 'b.md': 'sha256-y' },
    });
    expect(one).toBe(two);
    expect(one.endsWith('\n')).toBe(true);
    expect(one.indexOf('a.md')).toBeLessThan(one.indexOf('b.md'));
  });

  it('carries no timestamp', () => {
    const text = serializeManifest({ guardrailsVersion: '0.1.0', files: {} });
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('MANIFEST_PATH', () => {
  it('sits beside the gitignored state directory, not inside it', () => {
    // .gitignore ignores `.guardrails/state/`; the manifest must be committed.
    expect(MANIFEST_PATH).toBe('.guardrails/scaffold.json');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/scaffold/manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `guardrails-core/src/scaffold/manifest.ts`:

```ts
/**
 * The committed scaffold manifest (`.guardrails/scaffold.json`).
 *
 * `guardrails init` writes a set of files into a consumer repo, and a re-run
 * has to tell three cases apart: a file it wrote that nobody touched (safe to
 * upgrade), a file the consumer edited (leave alone, report drift), and a file
 * it has never written (create). A checksum per file is what separates them.
 *
 * Serialization is deterministic — sorted keys, no timestamp — so the committed
 * file stays out of every diff and a CI drift-check can work on it.
 *
 * It lives BESIDE `.guardrails/state/`, not inside it: state is gitignored and
 * swept on a TTL, and this must be committed.
 */
import { createHash } from 'node:crypto';

import { isRecord } from './record.js';

export const MANIFEST_PATH = '.guardrails/scaffold.json';

export interface ScaffoldManifest {
  readonly guardrailsVersion: string;
  readonly files: Readonly<Record<string, string>>;
}

/** Content hash, algorithm-prefixed so the committed file says what it used. */
export function checksum(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Parse a manifest defensively. Anything malformed yields `undefined` (treat the
 * repo as unscaffolded); an individual entry with a non-string checksum is
 * dropped, which makes that file read as untracked — so `init` reports drift
 * rather than silently overwriting a consumer's edit. Both directions fail
 * toward not touching the consumer's files.
 */
export function parseManifest(parsed: unknown): ScaffoldManifest | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { guardrailsVersion, files } = parsed;
  if (typeof guardrailsVersion !== 'string' || !isRecord(files)) {
    return undefined;
  }
  const checked: Record<string, string> = {};
  for (const [file, value] of Object.entries(files)) {
    if (typeof value === 'string') {
      checked[file] = value;
    }
  }
  return { guardrailsVersion, files: checked };
}

export function serializeManifest(manifest: ScaffoldManifest): string {
  const files: Record<string, string> = {};
  for (const key of Object.keys(manifest.files).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const value = manifest.files[key];
    if (value !== undefined) {
      files[key] = value;
    }
  }
  return `${JSON.stringify(
    { guardrailsVersion: manifest.guardrailsVersion, files },
    undefined,
    2,
  )}\n`;
}
```

- [ ] **Step 4: Create the shared record guard**

`isRecord` now needs a fourth home. This phase deliberately did NOT consolidate
the three existing copies because they differ (`workspaces.ts`'s omits the
array check). Rather than add a fifth divergent copy, create one for the
scaffold modules to share:

Create `guardrails-core/src/scaffold/record.ts`:

```ts
/**
 * Object guard for the scaffold modules.
 *
 * Deliberately NOT shared with `config.ts` / `workspaces.ts` /
 * `verify/analyzer-policy.ts`: those three differ from each other —
 * `workspaces.ts`'s accepts arrays because npm's `workspaces` field can be one —
 * and merging them would silently change array handling at their call sites.
 * This is the scaffold's own, with the array-excluding semantics every scaffold
 * caller wants.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/scaffold/manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-check**

Run: `mise exec -- npx stryker run --mutate "guardrails-core/src/scaffold/manifest.ts,guardrails-core/src/scaffold/record.ts"`
Expected: 0 survived, 0 no-coverage.

- [ ] **Step 7: Commit**

```bash
mise exec -- git add guardrails-core/src/scaffold guardrails-core/test/scaffold
mise exec -- git commit -m "feat(scaffold): the committed scaffold manifest and its checksums"
```

---

## Task 3: Detection

**Files:**

- Create: `guardrails-core/src/scaffold/detect.ts`
- Test: `guardrails-core/test/scaffold/detect.test.ts`

**Interfaces:**

- Consumes: `Exec`, `resolveRepoRoot` (Task 1), `parseManifest` (Task 2),
  `readJsonFile`, `declaredProviders` from `verify/analyzer-policy.js`.
- Produces:

```ts
export interface RepoFacts {
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly declaredProviders: ReadonlySet<string>;
  readonly hasTypeScriptConfig: boolean;
  readonly hasEslintConfig: boolean;
  readonly hasDependencyCruiserConfig: boolean;
  readonly hasStrykerConfig: boolean;
  readonly hasGuardrailsConfig: boolean;
  readonly manifest: ScaffoldManifest | undefined;
  readonly hooksPath: string | undefined;
  readonly prepareScript: string | undefined;
}

export interface DetectOptions {
  readonly exec: Exec;
  readonly cwd: string;
  /** Existence probe, injected in tests. Defaults to node:fs existsSync. */
  readonly fileExists?: (filePath: string) => boolean;
  /** File reader seam, injected in tests. Defaults to readJsonFile. */
  readonly readJson?: (filePath: string) => unknown;
}

export function detect(options: DetectOptions): Promise<RepoFacts>;
```

Spec §6.3.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/scaffold/detect.test.ts`. Build a fake world rather
than touching the real filesystem:

```ts
import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { detect } from '../../src/scaffold/detect.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/** A fake git: toplevel, base branch, and core.hooksPath. */
function fakeExec(overrides: Record<string, ExecResult> = {}): Exec {
  return (command, args) => {
    const line = [command, ...args].join(' ');
    if (overrides[line]) {
      return Promise.resolve(overrides[line]);
    }
    if (line.includes('--show-toplevel')) return Promise.resolve(ok('/repo\n'));
    if (line.includes('core.hooksPath')) {
      return Promise.resolve({ stdout: '', stderr: '', code: 1 });
    }
    if (line.includes('symbolic-ref'))
      return Promise.resolve(ok('origin/main\n'));
    return Promise.resolve(ok(''));
  };
}

function facts(files: Record<string, unknown>, exec = fakeExec()) {
  return detect({
    exec,
    cwd: '/repo/packages/api',
    fileExists: (filePath) => Object.hasOwn(files, filePath),
    readJson: (filePath) => files[filePath],
  });
}

describe('detect', () => {
  it('anchors at the git toplevel, not the working directory', async () => {
    expect((await facts({})).repoRoot).toBe('/repo');
  });

  it('reports which analyzer configs exist', async () => {
    const result = await facts({
      '/repo/tsconfig.json': {},
      '/repo/stryker.conf.json': {},
    });
    expect(result.hasTypeScriptConfig).toBe(true);
    expect(result.hasStrykerConfig).toBe(true);
    expect(result.hasDependencyCruiserConfig).toBe(false);
    expect(result.hasEslintConfig).toBe(false);
  });

  it('collects declared providers from package.json', async () => {
    const result = await facts({
      '/repo/package.json': { devDependencies: { eslint: '^9', knip: '^6' } },
    });
    expect(
      [...result.declaredProviders].sort((a, b) => a.localeCompare(b)),
    ).toEqual(['eslint', 'knip']);
  });

  it('reads an existing prepare script', async () => {
    const result = await facts({
      '/repo/package.json': { scripts: { prepare: 'husky' } },
    });
    expect(result.prepareScript).toBe('husky');
  });

  it('leaves prepareScript undefined when there is none', async () => {
    expect(
      (await facts({ '/repo/package.json': {} })).prepareScript,
    ).toBeUndefined();
  });

  it('reports core.hooksPath when git has one configured', async () => {
    const exec = fakeExec({
      'git config --get core.hooksPath': ok('.githooks\n'),
    });
    expect((await facts({}, exec)).hooksPath).toBe('.githooks');
  });

  it('leaves hooksPath undefined when git has none', async () => {
    expect((await facts({})).hooksPath).toBeUndefined();
  });

  it('notices an existing guardrails.config.json', async () => {
    const result = await facts({ '/repo/guardrails.config.json': {} });
    expect(result.hasGuardrailsConfig).toBe(true);
  });

  it('parses an existing scaffold manifest', async () => {
    const result = await facts({
      '/repo/.guardrails/scaffold.json': {
        guardrailsVersion: '0.1.0',
        files: { 'x.md': 'sha256-a' },
      },
    });
    expect(result.manifest?.files).toEqual({ 'x.md': 'sha256-a' });
  });

  it('leaves the manifest undefined on an unscaffolded repo', async () => {
    expect((await facts({})).manifest).toBeUndefined();
  });

  it('derives the base branch from origin HEAD', async () => {
    expect((await facts({})).baseBranch).toBe('main');
  });

  it('falls back to main when origin HEAD is unknown', async () => {
    const exec = fakeExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD': {
        stdout: '',
        stderr: '',
        code: 1,
      },
    });
    expect((await facts({}, exec)).baseBranch).toBe('main');
  });
});
```

Confirm the exact git argv you use for the base branch and hooks path against the
assertions above; if you choose different arguments, update the fake's matching
and say so in your report.

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `mise exec -- npx vitest run guardrails-core/test/scaffold/detect.test.ts`
Expected: FAIL — module not found.

Implement `guardrails-core/src/scaffold/detect.ts` to satisfy exactly those
assertions. Requirements the tests encode:

- Resolve `repoRoot` via `resolveRepoRoot(exec, cwd)` — never trust `cwd`.
- `baseBranch`: read `git symbolic-ref --short refs/remotes/origin/HEAD`, strip
  the leading `origin/`, and fall back to `main` on any failure or empty output.
- `hooksPath`: `git config --get core.hooksPath`, `undefined` on non-zero exit.
  Use a conditional spread — `exactOptionalPropertyTypes` forbids assigning
  `undefined` to an optional property.
- Config presence: probe `tsconfig.json`; an eslint config under any of
  `eslint.config.js` / `.mjs` / `.cjs`; `.dependency-cruiser.cjs` / `.js` /
  `.json`; `stryker.conf.json`; `guardrails.config.json`.
- `declaredProviders`: reuse `declaredProviders()` from
  `verify/analyzer-policy.js` on the parsed root `package.json`. Do not
  reimplement it.
- `manifest`: `parseManifest(readJson(<repoRoot>/.guardrails/scaffold.json))`.

Keep it under fallow's complexity threshold — extract a small helper for the
"first existing path among these candidates" probe rather than writing one long
chain of `||`.

- [ ] **Step 3: Verify, mutation-check, commit**

```bash
mise exec -- npx vitest run guardrails-core/test/scaffold/detect.test.ts
mise exec -- npx stryker run --mutate guardrails-core/src/scaffold/detect.ts
mise exec -- git add guardrails-core/src/scaffold/detect.ts guardrails-core/test/scaffold/detect.test.ts
mise exec -- git commit -m "feat(scaffold): detect what a target repo already has"
```

Mutation must be 0 survived / 0 no-coverage before you commit.

---

## Task 4: Plan computation — the pure core

**Files:**

- Create: `guardrails-core/src/scaffold/plan.ts`
- Test: `guardrails-core/test/scaffold/plan.test.ts`

**Interfaces:**

- Consumes: `RepoFacts` (Task 3), `ScaffoldManifest` + `checksum` (Task 2).
- Produces:

```ts
export type FileClass = 'owned' | 'shared' | 'seed-once';

export type ActionKind =
  | 'create' // absent -> write it
  | 'update' // owned, matches its recorded checksum -> rewrite
  | 'drift' // owned, edited by the consumer -> leave alone, report
  | 'merge' // shared -> merge guardrails' entries into their file
  | 'unchanged'; // already correct, nothing to do

export interface PlannedAction {
  readonly path: string; // repo-relative, POSIX separators
  readonly fileClass: FileClass;
  readonly kind: ActionKind;
  readonly reason: string; // one line, shown by --plan
}

export interface ScaffoldDecisions {
  readonly analyzers: Readonly<Record<string, 'off' | 'auto' | 'required'>>;
  readonly enforcement: 'warn' | 'block';
  readonly distribution: 'solo' | 'team';
  readonly force: boolean;
}

export interface ScaffoldPlan {
  readonly actions: readonly PlannedAction[];
  readonly warnings: readonly string[];
}

export interface PlanInput {
  readonly facts: RepoFacts;
  readonly decisions: ScaffoldDecisions;
  /** Repo-relative path -> the content init would write. */
  readonly desired: Readonly<Record<string, string>>;
  /** Repo-relative path -> the content on disk, absent when the file is missing. */
  readonly current: Readonly<Record<string, string>>;
}

export function planScaffold(input: PlanInput): ScaffoldPlan;
```

**This function performs no I/O whatsoever.** Both the desired content and the
on-disk content are handed to it. That is what lets the whole decision table be
mutation-tested by fast unit tests, and it is the spec's stated mitigation for
this piece's biggest risk.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/scaffold/plan.test.ts`. Cover the full decision
table — one case per row, each asserting the `kind` that row demands:

| class     | on disk | matches manifest checksum | force | expected kind |
| --------- | ------- | ------------------------- | ----- | ------------- |
| owned     | absent  | —                         | —     | `create`      |
| owned     | present | yes                       | no    | `update`      |
| owned     | present | no (edited)               | no    | `drift`       |
| owned     | present | no (edited)               | yes   | `update`      |
| owned     | present | not in manifest           | no    | `drift`       |
| owned     | present | identical to desired      | no    | `unchanged`   |
| shared    | absent  | —                         | —     | `create`      |
| shared    | present | —                         | —     | `merge`       |
| seed-once | absent  | —                         | —     | `create`      |
| seed-once | present | —                         | —     | `unchanged`   |

Write one `it` per row with an explicit assertion on `kind`, plus:

```ts
it('reports drift as a warning, not silently', () => {
  // A consumer who edited a file must be TOLD, not quietly skipped -- otherwise
  // an upgrade appears to have applied when it did not.
  const plan = planScaffold(/* an owned, edited file */);
  expect(plan.warnings.join(' ')).toContain('.githooks/pre-commit');
});

it('every action carries a reason a human can act on', () => {
  const plan = planScaffold(/* a mixed input */);
  for (const action of plan.actions) {
    expect(action.reason.length).toBeGreaterThan(0);
  }
});

it('is deterministic: the same input yields the same plan', () => {
  const input = /* ... */;
  expect(planScaffold(input)).toEqual(planScaffold(input));
});

it('orders actions by path so --plan output is stable', () => {
  const plan = planScaffold(/* several files, inserted out of order */);
  const paths = plan.actions.map((action) => action.path);
  expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
});
```

Build the inputs with a small local helper so each case reads as one row of the
table rather than twenty lines of setup.

- [ ] **Step 2: Run to verify it fails, then implement**

Implement `planScaffold` to satisfy exactly that table. Requirements:

- **owned:** absent → `create`. Present and byte-identical to desired →
  `unchanged`. Present, and its checksum matches the manifest entry → `update`
  (we wrote it, nobody touched it, so upgrade it). Present and the checksum does
  not match, or there is no manifest entry → `drift`, plus a warning naming the
  path — unless `force`, which makes it `update`.
- **shared:** absent → `create`; present → `merge`. Never `drift`: the consumer
  is expected to own these files, and merging touches only guardrails' own
  entries.
- **seed-once:** absent → `create`; present → `unchanged`, always. Never
  overwritten, not even with `force` — `guardrails.config.json` holds the
  consumer's policy and their sanctioned suppressions.
- Actions sorted by `path`.
- No I/O, no `Date`, no randomness: the same input must produce an identical plan.

Keep each rule in its own small function; fallow's complexity gate is live.

- [ ] **Step 3: Verify, mutation-check, commit**

```bash
mise exec -- npx vitest run guardrails-core/test/scaffold/plan.test.ts
mise exec -- npx stryker run --mutate guardrails-core/src/scaffold/plan.ts
mise exec -- git add guardrails-core/src/scaffold/plan.ts guardrails-core/test/scaffold/plan.test.ts
mise exec -- git commit -m "feat(scaffold): pure plan computation over the three file classes"
```

Mutation must be 0 survived / 0 no-coverage. This is the file where that matters
most — it is the whole decision table.

---

## Task 5: The SHARED-class mergers

**Files:**

- Create: `guardrails-core/src/scaffold/merge.ts`
- Test: `guardrails-core/test/scaffold/merge.test.ts`

**Interfaces:**

- Consumes: `isRecord` from `scaffold/record.js`.
- Produces (all pure, `current` may be `undefined` when the file is absent):
  - `mergeClaudeSettings(current: string | undefined, hooksBlock: string): string`
  - `mergeGitignore(current: string | undefined): string`
  - `mergePrepareScript(current: string | undefined): string`
  - `mergeCopilotInstructions(current: string | undefined, block: string): string`

Spec §6.4 SHARED. **This is the sharpest edge in the piece.**
`.claude/settings.json` is the one file where a wrong merge either silently
disables the loop or clobbers a consumer's own hooks.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/scaffold/merge.test.ts`. The cases that matter:

```ts
describe('mergeClaudeSettings', () => {
  it('creates a settings file when the consumer has none', () => {
    /* ... */
  });

  it('preserves a consumer hook that is not ours', () => {
    // The load-bearing case: a consumer with their own PostToolUse hook must
    // still have it afterwards.
  });

  it('replaces a stale guardrails hook rather than duplicating it', () => {
    // Guardrails entries are identified by their command containing
    // `guardrails-core/dist/cli.mjs`. Re-running init must not append a second
    // copy of every hook.
  });

  it('preserves unrelated top-level settings keys', () => {
    // e.g. `permissions`, `model` -- their file, not ours.
  });

  it('is idempotent: merging twice equals merging once', () => {
    /* ... */
  });

  it('leaves the consumer file untouched when it is not valid JSON', () => {
    // Failing closed: better to report than to destroy a file we cannot parse.
  });
});

describe('mergeGitignore', () => {
  it('adds a marker-delimited block when absent', () => {
    /* ... */
  });
  it('replaces only the marked block on a re-run', () => {
    /* ... */
  });
  it('preserves consumer entries outside the markers', () => {
    /* ... */
  });
  it('does NOT ignore .claude/agents or .claude/skills', () => {
    // This repo ignores those because it REGENERATES them every build. A
    // consumer has no build step and must commit them, or the Copilot cloud
    // agent and every teammate get no fixer agents.
    const result = mergeGitignore(undefined);
    expect(result).not.toContain('.claude/agents');
    expect(result).not.toContain('.claude/skills');
    expect(result).toContain('.guardrails/state/');
  });
  it('is idempotent', () => {
    /* ... */
  });
});

describe('mergePrepareScript', () => {
  it('creates the script when there is none', () => {
    expect(mergePrepareScript(undefined)).toBe('guardrails install-hooks');
  });
  it('appends to an existing script rather than replacing it', () => {
    // A consumer running husky must not lose it.
    expect(mergePrepareScript('husky')).toBe(
      'husky && guardrails install-hooks',
    );
  });
  it('is idempotent: an already-wired script is returned unchanged', () => {
    expect(mergePrepareScript('husky && guardrails install-hooks')).toBe(
      'husky && guardrails install-hooks',
    );
  });
});

describe('mergeCopilotInstructions', () => {
  it('creates the file with the marked block when absent', () => {
    /* ... */
  });
  it('replaces only the marked block, preserving hand-written prose', () => {
    /* ... */
  });
  it('is idempotent', () => {
    /* ... */
  });
});
```

Fill each body with real assertions — every one of these is a case a consumer
will hit.

- [ ] **Step 2: Run to verify it fails, then implement**

`mergeCopilotInstructions` must reuse the marker logic already proven in
`scripts/sync-agents.mjs` (`<!-- guardrails:skills:start -->` /
`<!-- guardrails:skills:end -->`, replace between them, append if absent). Port
that logic; do not invent a second dialect of it.

`mergeClaudeSettings` merges by hook event: for each event in the template,
filter the consumer's array to drop entries whose command mentions
`guardrails-core/dist/cli.mjs`, then append the template's. Unrecognised
top-level keys pass through untouched. On unparseable JSON, return `current`
unchanged so the caller can report rather than destroy.

- [ ] **Step 3: Verify, mutation-check, commit**

```bash
mise exec -- npx vitest run guardrails-core/test/scaffold/merge.test.ts
mise exec -- npx stryker run --mutate guardrails-core/src/scaffold/merge.ts
mise exec -- git add guardrails-core/src/scaffold/merge.ts guardrails-core/test/scaffold/merge.test.ts
mise exec -- git commit -m "feat(scaffold): SHARED-class mergers that never clobber consumer content"
```

---

## Task 6: Apply

**Files:**

- Create: `guardrails-core/src/scaffold/apply.ts`
- Test: `guardrails-core/test/scaffold/apply.test.ts`

**Interfaces:**

- Consumes: `ScaffoldPlan` (Task 4), the mergers (Task 5), `serializeManifest`
  and `checksum` (Task 2).
- Produces:

```ts
export interface ApplyDeps {
  readonly readFile: (filePath: string) => string | undefined;
  readonly writeFile: (filePath: string, content: string) => void;
  readonly setHooksPath: () => void;
}

export interface ApplyResult {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
}

export function applyScaffold(
  plan: ScaffoldPlan,
  desired: Readonly<Record<string, string>>,
  repoRoot: string,
  deps: ApplyDeps,
): ApplyResult;
```

Every filesystem touch goes through `ApplyDeps`, so the whole of apply is
unit-testable with an in-memory map — no temp directories, no cleanup.

- [ ] **Step 1: Write the failing test**

Cases: `create` and `update` write; `drift` and `unchanged` do not; `merge`
writes merged content; the manifest is rewritten with a checksum for every OWNED
file actually written; applying the same plan twice is idempotent; nothing is
written for a plan with no actionable entries.

The idempotency test is the important one:

```ts
it('is idempotent: applying, re-planning and re-applying writes nothing', () => {
  // Re-running init on an untouched repo must be a no-op. This is the property
  // the phase name calls out.
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

- [ ] **Step 3: Verify, mutation-check, commit**

```bash
mise exec -- npx vitest run guardrails-core/test/scaffold/apply.test.ts
mise exec -- npx stryker run --mutate guardrails-core/src/scaffold/apply.ts
mise exec -- git add guardrails-core/src/scaffold/apply.ts guardrails-core/test/scaffold/apply.test.ts
mise exec -- git commit -m "feat(scaffold): apply a plan through an injected filesystem seam"
```

---

## Task 7: The `init` CLI command

**Files:**

- Modify: `guardrails-core/src/cli-core.ts`
- Create: `guardrails-core/src/scaffold/templates.ts`
- Test: `guardrails-core/test/scaffold/init-command.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: `guardrails init [--plan] [--json] [--apply] [--force]
[--analyzers=…] [--enforcement=…] [--distribution=…]`

`scaffold/templates.ts` resolves the packaged template tree:

```ts
/**
 * The template tree ships inside the package (`files: [..., "templates"]`) and
 * must resolve against the INSTALLED package, never the consumer's repo root —
 * a consumer has no `templates/` of their own. `dist/cli.mjs` sits directly in
 * `dist/`, so the tree is one level up.
 */
export function templatesRoot(): string {
  return path.join(import.meta.dirname, '..', 'templates');
}
```

- [ ] **Step 1: Write the failing test**

Cover, using the `CliDeps` idioms already in `guardrails-core/test/cli-core.test.ts`
(module-scope `root`, `out`, `errors`, `ok()`, `deps()`):

- `init` with no TTY writes nothing and prints a plan (assert the repo is
  unchanged afterwards).
- `init --plan --json` emits parseable JSON containing the actions.
- `init --apply` writes the expected files.
- `init --apply` twice is idempotent — the second run reports nothing to do.
- `init --apply` on a repo with a consumer-edited owned file reports drift and
  leaves the file alone; `--force` overwrites it.
- Unknown flag → usage and a non-zero exit.

- [ ] **Step 2: Run to verify it fails, then implement**

Wire the command into `runCommand`'s switch. **`init` must never write unless
`--apply` is passed** — that is the safety property; a test must pin it.

Update the usage banner to include `init` and `install-hooks`.

- [ ] **Step 3: Verify, mutation-check, commit**

```bash
mise exec -- npx vitest run
mise exec -- npx stryker run --mutate "guardrails-core/src/cli-core.ts,guardrails-core/src/scaffold/templates.ts"
mise exec -- git add -A guardrails-core
mise exec -- git commit -m "feat(cli): guardrails init — detect, plan, apply"
```

---

## Task 8: `guardrails install-hooks`

**Files:**

- Modify: `guardrails-core/src/cli-core.ts`
- Test: `guardrails-core/test/cli-core.test.ts`

**Interfaces:**

- Produces: `guardrails install-hooks` — runs `git config core.hooksPath .githooks`.

Spec §6.6. `.githooks/pre-commit` does nothing until `core.hooksPath` is set,
which is per-clone local config and cannot be committed. `init --apply` appends
`&& guardrails install-hooks` to `scripts.prepare` so teammates get it on
`npm install`; this is the command that line invokes.

- [ ] **Step 1: Write the failing test**

- `install-hooks` runs `git config core.hooksPath .githooks` from the repo root
  (assert the exact argv through the fake exec).
- It resolves the repo root rather than trusting cwd.
- A non-zero git exit is reported and returns 1.

- [ ] **Step 2: Implement, verify, commit**

```bash
mise exec -- npx vitest run guardrails-core/test/cli-core.test.ts
mise exec -- git add guardrails-core
mise exec -- git commit -m "feat(cli): install-hooks activates the git-native pre-commit gate"
```

---

## Task 9: Upgrade the tarball smoke test

**Files:**

- Modify: `scripts/smoke-tarball.mjs`

**Interfaces:**

- Consumes: `guardrails init --plan` from Task 7.

Piece 3 left an inline NOTE at stage 5 marking this exact change. The smoke test
currently exercises the usage banner; `init --plan` exercises far more of the
install path — template resolution from inside the installed package, detection,
and plan computation — which is precisely what a first adoption depends on.

- [ ] **Step 1: Replace stage 5**

Run `guardrails init --plan` in the fixture repo instead of the no-args
invocation. The fixture is not a git repo, so `resolveRepoRoot` falls back to
`cwd` — that is a legitimate path and the command must still produce a plan
rather than crash. Assert it exits 0 and prints at least one planned action.
Remove the NOTE comment.

If it does NOT work in a non-git fixture, that is a real finding about `init`,
not a reason to weaken the smoke test — report it.

- [ ] **Step 2: Prove it still has teeth**

Temporarily remove `templates` from `guardrails-core/package.json`'s `files`,
re-run, and confirm failure. Restore, re-run green. Record both outputs.

- [ ] **Step 3: Commit**

```bash
mise exec -- npm run smoke:tarball
mise exec -- git add scripts/smoke-tarball.mjs
mise exec -- git commit -m "test(release): smoke-test guardrails init from the packed tarball"
```

---

## Task 10: Documentation

**Files:**

- Modify: `plan.md`, `README.md`

- [ ] **Step 1: Update `plan.md`**

Mark piece 4 shipped in the Build-phases entry for E. Add a short section
recording what `init` writes, the three file classes, and the drift behaviour —
the same depth as the other Phase C/E status sections.

- [ ] **Step 2: Update `README.md`**

The Install section currently ends by saying `guardrails init` is piece 4 and
does not exist. Replace that with what it now does: `init --plan` to see what it
would write, `init --apply` to write it, re-runnable, and that a file you edit is
reported rather than overwritten.

- [ ] **Step 3: Commit**

```bash
mise exec -- npx prettier --write plan.md README.md
mise exec -- git add plan.md README.md
mise exec -- git commit -m "docs: record guardrails init as shipped"
```

---

## Done criteria

- `mise exec -- npm run lint && mise exec -- npm run typecheck && mise exec -- npx vitest run` all pass.
- `mise exec -- npm run test:coverage && mise exec -- npm run check:graph` passes at 0 above threshold.
- Mutation over every new/changed source file: **0 survived, 0 no-coverage**.
- `mise exec -- npm run smoke:tarball` green, and demonstrated failing with
  `templates` removed from `files`.
- `mise exec -- node guardrails-core/dist/cli.mjs verify` clean on this repo.
- `guardrails.config.json` still has exactly 27 `sanctionedSuppressions` entries.
- **The idempotency property holds end to end:** `init --apply` twice on a fresh
  fixture leaves the second run with nothing to do. Verify by hand in a temp repo
  before calling this done — no unit test substitutes for actually running it
  twice.

## Follow-ups recorded, not done here

- **Re-point the existing `repoRoot` computations at `resolveRepoRoot`.** Task 1
  adds the seam and `init` uses it; every other handler still trusts `cwd`, so
  `recurrence.json` still fragments for a subdirectory invocation. That is a
  behavioural change across the gate handlers with its own risk and deserves its
  own slice.
- The scaffold modules carry their own `isRecord`, making four in the codebase.
  The three existing ones genuinely differ; a future consolidation should
  introduce two clearly-named guards rather than merging them.
