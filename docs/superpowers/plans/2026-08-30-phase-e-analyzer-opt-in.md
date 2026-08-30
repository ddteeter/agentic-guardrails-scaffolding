# Phase E pieces 1–2 — analyzer opt-in + `enforcement` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer repo run a subset of the TypeScript analyzer pack
instead of all five, and make `RepoConfig.enforcement` actually govern the
commit and preToolUse gates.

**Architecture:** A new pure module `verify/analyzer-policy.ts` holds the whole
opt-in decision as two small functions, so the logic is unit-testable and
mutation-killable without spawning anything. `runVerify` consults it per
analyzer: `off` skips the spawn entirely, and a spawn failure only becomes
`guardrails/analyzer-missing` when the tool was actually asked for — in
`analyzers` or in the repo's own `package.json`. `enforcement` is honored
entirely in the CLI's exit code, so no hook definition or workflow template
encodes the policy.

**Tech Stack:** TypeScript 5 (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), Node ≥24 ESM, Vitest, ESLint
(strict-type-checked + unicorn + sonarjs), Stryker mutation testing at the
commit rung.

**Spec:** `docs/superpowers/specs/2026-08-30-phase-e-adoption-design.md`
(§3 piece 1, §4 piece 2)

## Global Constraints

- **`guardrails-core` has zero runtime dependencies.** Do not add one. Hand-roll
  what you need.
- **TDD is non-negotiable.** No production code without a failing test first.
- **Never weaken a gate to pass it.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, deleted assertions, or raised thresholds.
- **Never add a `sanctionedSuppressions` entry without asking the developer
  first** (see `CLAUDE.md`). This includes Stryker equivalent-mutant
  directives.
- TypeScript strictness is `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`. Optional properties are set with conditional
  spread (`...(x === undefined ? {} : { x })`), never assigned `undefined`.
- No abbreviations in identifiers — the house ESLint config rejects them
  (`analyzer`, not `a`; `violation`, not `v`).
- Run commands under the repo's pinned Node (`.nvmrc` = 24). If your shell's
  default `node` is a different major, prefix commands with `mise exec --`;
  dependency-cruiser refuses Node 25 and the commit gate will (correctly) block
  you.
- Commit in small logical steps. The pre-commit gate runs
  `guardrails gate --mode=commit`; the pre-push gate runs
  `npm run test:coverage && npm run check:graph`.

---

## File Structure

**Create:**

- `guardrails-core/src/verify/analyzer-policy.ts` — the opt-in decision. Pure
  functions only, no I/O. One responsibility: turn (configured mode, is the
  provider declared) into (should we run, should a missing binary be an error).
- `guardrails-core/test/verify/analyzer-policy.test.ts` — the truth table.

**Modify:**

- `guardrails-core/src/config.ts` — add `analyzers` to `RepoConfig`, its default,
  and its defensive parser.
- `guardrails-core/src/verify/index.ts` — read the repo manifest, export
  `ANALYZER_TOOLS`, consult the policy in `runVerify`'s loop, emit
  `guardrails/analyzer-unknown`.
- `guardrails-core/src/gate.ts` — thread `analyzers` / `declaredProviders`
  through `StopGateOptions` and `CommitGateOptions` into their `runVerify`
  calls.
- `guardrails-core/src/cli-core.ts` — pass `config.analyzers` into every verify
  path; honor `config.enforcement` in `gateCommitCommand` and
  `gatePreToolUseCommand`.
- `guardrails.config.json` — this repo's own `analyzers` block (all five
  `required`, since this repo genuinely depends on all of them).

**Tests modified:** `guardrails-core/test/config.test.ts`,
`guardrails-core/test/verify/orchestrator.test.ts`,
`guardrails-core/test/cli-core.test.ts`,
`guardrails-core/test/commit-gate.test.ts`.

---

## Task 1: The analyzer-policy decision module

**Files:**

- Create: `guardrails-core/src/verify/analyzer-policy.ts`
- Test: `guardrails-core/test/verify/analyzer-policy.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type AnalyzerMode = 'off' | 'auto' | 'required'`
  - `interface AnalyzerDecision { run: boolean; reportMissing: boolean }`
  - `decideAnalyzer(mode: AnalyzerMode, providerDeclared: boolean): AnalyzerDecision`
  - `analyzerMode(analyzers: Readonly<Record<string, AnalyzerMode>>, tool: string): AnalyzerMode`
  - `declaredProviders(manifest: unknown): ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/verify/analyzer-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  analyzerMode,
  decideAnalyzer,
  declaredProviders,
} from '../../src/verify/analyzer-policy.js';

describe('decideAnalyzer', () => {
  it('never runs an analyzer turned off, and never reports it missing', () => {
    expect(decideAnalyzer('off', true)).toEqual({
      run: false,
      reportMissing: false,
    });
    expect(decideAnalyzer('off', false)).toEqual({
      run: false,
      reportMissing: false,
    });
  });

  it('runs a required analyzer and reports it missing regardless of declaration', () => {
    expect(decideAnalyzer('required', false)).toEqual({
      run: true,
      reportMissing: true,
    });
    expect(decideAnalyzer('required', true)).toEqual({
      run: true,
      reportMissing: true,
    });
  });

  it('runs an auto analyzer but reports it missing only when the provider is declared', () => {
    expect(decideAnalyzer('auto', true)).toEqual({
      run: true,
      reportMissing: true,
    });
    expect(decideAnalyzer('auto', false)).toEqual({
      run: true,
      reportMissing: false,
    });
  });
});

describe('analyzerMode', () => {
  it('defaults an unlisted analyzer to auto', () => {
    expect(analyzerMode({}, 'knip')).toBe('auto');
  });

  it('returns the configured mode for a listed analyzer', () => {
    expect(analyzerMode({ knip: 'off' }, 'knip')).toBe('off');
  });
});

describe('declaredProviders', () => {
  it('collects names from every dependency field', () => {
    const names = declaredProviders({
      dependencies: { eslint: '^9' },
      devDependencies: { knip: '^6' },
      optionalDependencies: { 'dependency-cruiser': '^18' },
      peerDependencies: { '@stryker-mutator/core': '^9' },
    });
    expect([...names].sort()).toEqual([
      '@stryker-mutator/core',
      'dependency-cruiser',
      'eslint',
      'knip',
    ]);
  });

  it('returns an empty set for a manifest that is not an object', () => {
    expect(declaredProviders(undefined).size).toBe(0);
    expect(declaredProviders('nope').size).toBe(0);
    expect(declaredProviders(null).size).toBe(0);
  });

  it('ignores a dependency field that is not an object', () => {
    expect(declaredProviders({ devDependencies: 'nope' }).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/verify/analyzer-policy.test.ts`
Expected: FAIL — cannot resolve `../../src/verify/analyzer-policy.js`.

- [ ] **Step 3: Write the implementation**

Create `guardrails-core/src/verify/analyzer-policy.ts`:

```ts
/**
 * Per-analyzer opt-in policy (Phase E piece 1). `ANALYZERS` is a fixed table,
 * so without this every consumer runs the whole TypeScript pack — and since
 * Phase C piece 5 an analyzer that cannot be started is an error-severity
 * violation, a repo that does not install knip, dependency-cruiser AND Stryker
 * is permanently blocked. That severity is right (a guard that silently did not
 * run is worse than no guard); what was missing is a way to say "I did not ask
 * for that one".
 *
 * The rule in one sentence: OFF if the config says off; otherwise it runs if it
 * is there, and a missing binary is an error only if it was asked for — in
 * `analyzers` or in the repo's own `package.json`.
 *
 * Pure functions in their own module, deliberately: the decision is the part
 * worth proving, and proving it should not require spawning anything.
 */

/** How a repo has opted into one analyzer. Absent from config means `auto`. */
export type AnalyzerMode = 'off' | 'auto' | 'required';

export interface AnalyzerDecision {
  /** Spawn the analyzer at all. */
  run: boolean;
  /**
   * When the spawn fails, report `guardrails/analyzer-missing` rather than
   * treating the absence as a deliberate opt-out.
   */
  reportMissing: boolean;
}

/**
 * The truth table from the design doc §3.3. `providerDeclared` is whether the
 * analyzer's npm package is named in the consumer's own `package.json`: a
 * declared-but-unresolvable tool is a broken install, not an opt-out, and must
 * never read as a clean gate. That distinction is what makes
 * installed-means-enabled safe as a default.
 */
export function decideAnalyzer(
  mode: AnalyzerMode,
  providerDeclared: boolean,
): AnalyzerDecision {
  if (mode === 'off') {
    return { run: false, reportMissing: false };
  }
  if (mode === 'required') {
    return { run: true, reportMissing: true };
  }
  return { run: true, reportMissing: providerDeclared };
}

/** The configured mode for `tool`, defaulting to `auto` when unlisted. */
export function analyzerMode(
  analyzers: Readonly<Record<string, AnalyzerMode>>,
  tool: string,
): AnalyzerMode {
  return analyzers[tool] ?? 'auto';
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every package name a `package.json` declares, across all four dependency
 * fields. Takes the already-parsed manifest rather than a path so it stays
 * pure; the caller owns the read. A malformed manifest yields an empty set,
 * which degrades to "nothing was asked for" — the conservative direction, since
 * the alternative would invent a demand the repo never made.
 */
export function declaredProviders(manifest: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  if (!isRecord(manifest)) {
    return names;
  }
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];
    if (!isRecord(section)) {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }
  return names;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/verify/analyzer-policy.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Check the mutation gate on the new file early**

Run: `mise exec -- npx stryker run --mutate guardrails-core/src/verify/analyzer-policy.ts`
Expected: 0 survived, 0 no-coverage. If a mutant survives, add the test that
kills it — do NOT add a Stryker directive. This file is small and pure
specifically so that this step is cheap; catching it now is far cheaper than at
the commit gate after five more files have changed.

- [ ] **Step 6: Commit**

```bash
mise exec -- git add guardrails-core/src/verify/analyzer-policy.ts guardrails-core/test/verify/analyzer-policy.test.ts
mise exec -- git commit -m "feat(verify): analyzer opt-in policy decision module"
```

---

## Task 2: `analyzers` in `RepoConfig`

**Files:**

- Modify: `guardrails-core/src/config.ts`
- Test: `guardrails-core/test/config.test.ts`

**Interfaces:**

- Consumes: `AnalyzerMode` from Task 1.
- Produces: `RepoConfig.analyzers: Record<string, AnalyzerMode>` — empty object
  by default, meaning every analyzer is `auto`.

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/config.test.ts` (inside the existing
`describe('loadConfig')`, or a new `describe` at the end of the file — follow
whichever shape the file already uses):

```ts
describe('analyzers', () => {
  it('defaults to an empty map, so every analyzer is auto', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    expect(loadConfig(dir).analyzers).toEqual({});
  });

  it('reads the three string modes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(dir, 'guardrails.config.json'),
      JSON.stringify({
        analyzers: { eslint: 'required', knip: 'auto', stryker: 'off' },
      }),
    );
    expect(loadConfig(dir).analyzers).toEqual({
      eslint: 'required',
      knip: 'auto',
      stryker: 'off',
    });
  });

  it('accepts true/false as shorthand for required/off', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(dir, 'guardrails.config.json'),
      JSON.stringify({ analyzers: { eslint: true, knip: false } }),
    );
    expect(loadConfig(dir).analyzers).toEqual({
      eslint: 'required',
      knip: 'off',
    });
  });

  it('drops an entry whose value is neither a known mode nor a boolean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(dir, 'guardrails.config.json'),
      JSON.stringify({ analyzers: { knip: 'sometimes', eslint: 3 } }),
    );
    // Dropped, not defaulted to off: a malformed entry must never be the thing
    // that silently disables a guard.
    expect(loadConfig(dir).analyzers).toEqual({});
  });

  it('ignores an analyzers value that is not an object', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(dir, 'guardrails.config.json'),
      JSON.stringify({ analyzers: ['knip'] }),
    );
    expect(loadConfig(dir).analyzers).toEqual({});
  });
});
```

If `mkdtempSync` / `writeFileSync` / `tmpdir` / `path` are not already imported
in that test file, add them:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/config.test.ts`
Expected: FAIL — `analyzers` is `undefined` on the returned config.

- [ ] **Step 3: Write the implementation**

In `guardrails-core/src/config.ts`, add the type import at the top of the
existing import block:

```ts
import type { AnalyzerMode } from './verify/analyzer-policy.js';
```

Add the field to `RepoConfig`, after `looseRules`:

```ts
/**
 * Per-analyzer opt-in (Phase E piece 1). Keyed by the analyzer's `tool` name
 * (`eslint`, `tsc`, `knip`, `dependency-cruiser`, `stryker`). An unlisted
 * analyzer is `auto`: it runs if its binary resolves, and a failure to
 * resolve is an error only when the repo's own `package.json` declares the
 * provider. `required` restores the unconditional hard error; `off` skips it
 * entirely. Empty by default. See `verify/analyzer-policy.ts`.
 */
analyzers: Record<string, AnalyzerMode>;
```

Add the default in `defaultConfig()`, after `looseRules: []`:

```ts
    analyzers: {},
```

Add the parser next to the other `pick*` helpers:

```ts
function isAnalyzerMode(value: unknown): value is AnalyzerMode {
  return value === 'off' || value === 'auto' || value === 'required';
}

/**
 * Parse the `analyzers` block. `true`/`false` are accepted as the natural
 * shorthand for `required`/`off`. Anything else is DROPPED rather than
 * defaulted, so a typo'd value falls back to `auto` (the analyzer keeps
 * running) instead of silently disabling a guard — failing toward more
 * checking, like every other defensive path in this file.
 */
function pickAnalyzers(value: unknown): Record<string, AnalyzerMode> {
  if (!isRecord(value)) {
    return {};
  }
  const modes: Record<string, AnalyzerMode> = {};
  for (const [tool, raw] of Object.entries(value)) {
    if (raw === true) {
      modes[tool] = 'required';
    } else if (raw === false) {
      modes[tool] = 'off';
    } else if (isAnalyzerMode(raw)) {
      modes[tool] = raw;
    }
  }
  return modes;
}
```

Wire it into `loadConfig`'s returned object, after `looseRules`:

```ts
    analyzers: pickAnalyzers(raw.analyzers),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the new import does not create a forbidden edge**

Run: `mise exec -- npm run depcruise`
Expected: exit 0. The repo's rules are `no-circular`, `not-to-test-from-src` and
`exec-seam`; `config.ts` → `verify/analyzer-policy.ts` is a new edge and
`analyzer-policy.ts` imports nothing, so no cycle is possible. If it does report
something, do not suppress it — report back before continuing.

- [ ] **Step 6: Commit**

```bash
mise exec -- git add guardrails-core/src/config.ts guardrails-core/test/config.test.ts
mise exec -- git commit -m "feat(config): analyzers opt-in block in RepoConfig"
```

---

## Task 3: `runVerify` honors the policy

**Files:**

- Modify: `guardrails-core/src/verify/index.ts`
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: `decideAnalyzer`, `analyzerMode`, `declaredProviders`,
  `AnalyzerMode` from Task 1.
- Produces:
  - `VerifyOptions.analyzers?: Readonly<Record<string, AnalyzerMode>>`
  - `VerifyOptions.declaredProviders?: ReadonlySet<string>`
  - `export const ANALYZER_TOOLS: readonly string[]`

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/verify/orchestrator.test.ts`, inside the
existing `describe('runVerify')`:

```ts
it('does not spawn an analyzer turned off in config', async () => {
  const { exec, calls } = fakeExec();
  await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'commit',
    analyzers: { knip: 'off' },
    declaredProviders: new Set(['knip']),
  });
  expect(calls.some((call) => call.command === 'knip')).toBe(false);
});

it('reports a required analyzer that cannot start', async () => {
  const { exec } = fakeExec({
    knip: { stdout: '', stderr: '', code: 1, spawnFailed: true },
  });
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'commit',
    analyzers: { knip: 'required' },
    declaredProviders: new Set(),
  });
  expect(
    violations.filter(
      (violation) => violation.ruleId === 'guardrails/analyzer-missing',
    ),
  ).toHaveLength(1);
});

it('stays silent about an auto analyzer that is neither installed nor declared', async () => {
  const { exec } = fakeExec({
    knip: { stdout: '', stderr: '', code: 1, spawnFailed: true },
  });
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'commit',
    declaredProviders: new Set(),
  });
  expect(
    violations.some(
      (violation) => violation.ruleId === 'guardrails/analyzer-missing',
    ),
  ).toBe(false);
});

it('reports an auto analyzer that package.json declares but that cannot start', async () => {
  const { exec } = fakeExec({
    knip: { stdout: '', stderr: '', code: 1, spawnFailed: true },
  });
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'commit',
    declaredProviders: new Set(['knip']),
  });
  const missing = violations.filter(
    (violation) => violation.ruleId === 'guardrails/analyzer-missing',
  );
  expect(missing).toHaveLength(1);
  expect(missing[0]?.message).toContain('knip');
});

it('warns about an unknown key in the analyzers block', async () => {
  const { exec } = fakeExec();
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    analyzers: { knipp: 'off' },
    declaredProviders: new Set(),
  });
  const unknown = violations.filter(
    (violation) => violation.ruleId === 'guardrails/analyzer-unknown',
  );
  expect(unknown).toHaveLength(1);
  expect(unknown[0]?.severity).toBe('warn');
  expect(unknown[0]?.message).toContain('knipp');
});
```

`fakeExec` dispatches overrides on `[command, ...args].join(' ')`, so the four
tests above must key on the exact command string `runKnip` issues. Replace every
`knip: { ... }` override key with the literal below — a bare `knip` key silently
matches nothing, and the test would pass for the wrong reason:

```ts
const knipMissing = {
  'knip --reporter json': {
    stdout: '',
    stderr: '',
    code: 1,
    spawnFailed: true as const,
  },
};
```

then call `fakeExec(knipMissing)` in the three tests that need a missing knip.
For reference, the other analyzers' exact command strings are
`depcruise --output-type json .`,
`eslint --format json --no-warn-ignored src/foo.ts src/new.ts`, and
`tsc --noEmit --pretty false -p tsconfig.json`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/verify/orchestrator.test.ts`
Expected: FAIL — `analyzers` / `declaredProviders` are not valid options, and no
`analyzer-unknown` violation is produced.

- [ ] **Step 3: Write the implementation**

In `guardrails-core/src/verify/index.ts`, add to the imports:

```ts
import { readFileSync } from 'node:fs';

import {
  type AnalyzerMode,
  analyzerMode,
  decideAnalyzer,
  declaredProviders,
} from './analyzer-policy.js';
```

Add to `VerifyOptions`:

```ts
  /**
   * Per-analyzer opt-in (`RepoConfig.analyzers`). Absent → every analyzer is
   * `auto`. See `analyzer-policy.ts` for the truth table.
   */
  analyzers?: Readonly<Record<string, AnalyzerMode>>;
  /**
   * Package names the repo's own `package.json` declares. A provider named
   * there whose binary does not resolve is a broken install, not an opt-out.
   * Injected in tests; defaults to reading `<repoRoot>/package.json`.
   */
  declaredProviders?: ReadonlySet<string>;
```

Add the tool-name export next to `ANALYZER_PROVIDERS`:

```ts
/** The valid keys of `guardrails.config.json`'s `analyzers` block. Exported so
 *  `runVerify` can flag an unrecognised key rather than let a typo silently
 *  leave an analyzer running that the author believes disabled. */
export const ANALYZER_TOOLS: readonly string[] = ANALYZERS.map(
  (analyzer) => analyzer.tool,
);
```

Add the manifest read and the unknown-key reporter above `runVerify`:

```ts
/** Read and parse `<repoRoot>/package.json`. A missing or malformed manifest
 *  yields `undefined`, which `declaredProviders` turns into an empty set — the
 *  conservative direction, since inventing a declaration would invent a demand
 *  the repo never made. */
function readManifest(repoRoot: string): unknown {
  try {
    return JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
  } catch {
    return undefined;
  }
}

function unknownAnalyzerViolations(
  analyzers: Readonly<Record<string, AnalyzerMode>>,
): Violation[] {
  return Object.keys(analyzers)
    .filter((key) => !ANALYZER_TOOLS.includes(key))
    .map((key) => ({
      ruleId: 'guardrails/analyzer-unknown',
      file: 'guardrails.config.json',
      message:
        `"${key}" in the "analyzers" block is not a known analyzer, so the ` +
        `entry has no effect. Known analyzers: ${ANALYZER_TOOLS.join(', ')}. ` +
        `Check for a typo — an analyzer you believe disabled is still running.`,
      severity: 'warn' as const,
      fixable: false,
      tool: 'guardrails',
    }));
}
```

Replace the body of `runVerify`'s analyzer loop. The existing loop is:

```ts
for (const analyzer of ANALYZERS) {
  if (RUNG_ORDER[profile] < RUNG_ORDER[analyzer.minRung]) {
    continue;
  }
  if (analyzer.scope === 'changed-files' && files.length === 0) {
    continue;
  }
  const before = failures.length;
  violations.push(...(await analyzer.run(tracked, resolveBin, files)));
  if (failures.length > before) {
    violations.push(missingToolViolation(analyzer.tool, analyzer.provider));
  }
}
```

Replace it with, and add the two lines above it:

```ts
const analyzers = options.analyzers ?? {};
const declared =
  options.declaredProviders ??
  declaredProviders(readManifest(options.repoRoot));
violations.push(...unknownAnalyzerViolations(analyzers));

for (const analyzer of ANALYZERS) {
  const decision = decideAnalyzer(
    analyzerMode(analyzers, analyzer.tool),
    declared.has(analyzer.provider),
  );
  if (!decision.run) {
    continue;
  }
  if (RUNG_ORDER[profile] < RUNG_ORDER[analyzer.minRung]) {
    continue;
  }
  if (analyzer.scope === 'changed-files' && files.length === 0) {
    continue;
  }
  const before = failures.length;
  violations.push(...(await analyzer.run(tracked, resolveBin, files)));
  if (failures.length > before && decision.reportMissing) {
    violations.push(missingToolViolation(analyzer.tool, analyzer.provider));
  }
}
```

Finally, update this file's header comment: the sentence pointing at
`plan.md "Roadmap: analyzer opt-in"` in `trackSpawnFailures`'s doc comment now
describes shipped behaviour. Replace

```
 * commands hit it. See plan.md "Roadmap: analyzer opt-in" for making a pack tool
 * optional rather than required.
```

with

```
 * commands hit it. Whether a failure becomes a violation is the opt-in policy's
 * call — see `analyzer-policy.ts`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/verify/`
Expected: PASS, including the pre-existing orchestrator tests. Those pass
neither `analyzers` nor `declaredProviders`, so they take the `auto` +
read-`package.json` path against `repoRoot: '/repo'`, which does not exist —
`readManifest` returns `undefined` and the set is empty. Any pre-existing test
that asserted an `analyzer-missing` violation without declaring the provider
will now fail; fix it by passing an explicit
`declaredProviders: new Set([...])`, not by loosening the assertion.

- [ ] **Step 5: Commit**

```bash
mise exec -- git add guardrails-core/src/verify/index.ts guardrails-core/test/verify/orchestrator.test.ts
mise exec -- git commit -m "feat(verify): honor per-analyzer opt-in in runVerify"
```

---

## Task 4: Thread the policy through the gates

**Files:**

- Modify: `guardrails-core/src/gate.ts`
- Modify: `guardrails-core/src/cli-core.ts`
- Test: `guardrails-core/test/commit-gate.test.ts`

**Interfaces:**

- Consumes: `VerifyOptions.analyzers` / `.declaredProviders` from Task 3;
  `RepoConfig.analyzers` from Task 2.
- Produces: `StopGateOptions.analyzers?`, `CommitGateOptions.analyzers?` (both
  `Readonly<Record<string, AnalyzerMode>>`).

Note: only `analyzers` is threaded, not `declaredProviders` — the gates already
know `repoRoot`, and letting `runVerify` read the manifest itself keeps the
seam in exactly one place.

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/commit-gate.test.ts`:

```ts
it('passes the configured analyzer policy through to verify', async () => {
  const commands: string[] = [];
  const exec: Exec = (command, args) => {
    commands.push(command);
    return Promise.resolve({ stdout: '', stderr: '', code: 0 });
  };
  await runCommitGate({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    analyzers: { knip: 'off' },
  });
  expect(commands).not.toContain('knip');
});
```

Match the import style already used at the top of that file; add
`import type { Exec } from '../src/exec.js';` if it is not already there. If the
existing tests in this file use a shared fake-exec helper, use that instead and
assert on its recorded calls.

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/commit-gate.test.ts`
Expected: FAIL — `analyzers` is not a valid `CommitGateOptions` property.

- [ ] **Step 3: Write the implementation**

In `guardrails-core/src/gate.ts`, add the type import:

```ts
import type { AnalyzerMode } from './verify/analyzer-policy.js';
```

Add to **both** `StopGateOptions` and `CommitGateOptions`:

```ts
  /** Per-analyzer opt-in (`RepoConfig.analyzers`), forwarded to `runVerify`. */
  analyzers?: Readonly<Record<string, AnalyzerMode>>;
```

In `runStopGate`, the `verifyOptions` object is built with a conditional spread
for `resolveBin`; add the same shape for `analyzers` (required by
`exactOptionalPropertyTypes`):

```ts
    ...(options.analyzers ? { analyzers: options.analyzers } : {}),
```

In `runCommitGate`, add the same conditional spread to the inline `runVerify`
call, next to the existing `resolveBin` spread:

```ts
    ...(options.analyzers ? { analyzers: options.analyzers } : {}),
```

In `guardrails-core/src/cli-core.ts`, add `analyzers: config.analyzers` to every
call site that already passes `baseBranch: config.baseBranch`. There are three:
`verifyCommand`'s `runVerify`, `gateCommitCommand`'s `runCommitGate`, and
`gatePreToolUseCommand`'s `runCommitGate`. Also add it to `gateStopCommand`'s
`runStopGate` call. `config.analyzers` is always a plain object (never
`undefined`), so it is assigned directly rather than spread.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `mise exec -- npx vitest run`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
mise exec -- git add guardrails-core/src/gate.ts guardrails-core/src/cli-core.ts guardrails-core/test/commit-gate.test.ts
mise exec -- git commit -m "feat(gate): forward analyzer opt-in policy from config to verify"
```

---

## Task 5: Honor `enforcement` on the commit gate

**Files:**

- Modify: `guardrails-core/src/cli-core.ts:135-152` (`gateCommitCommand`)
- Test: `guardrails-core/test/cli-core.test.ts`

**Interfaces:**

- Consumes: `RepoConfig.enforcement` (already parsed; no schema change).
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/cli-core.test.ts`. Follow the file's existing
pattern for building `CliDeps` and a temp repo; the assertions that matter are
the exit code and that output is still emitted:

This file already provides `root`, `out`, `errors`, `ok()` and `deps()` at module
scope. Add the fixture helper next to the existing `violation()` helper:

```ts
/** A repo whose commit gate blocks: one eslint error on a changed TS file.
 *  `enforcement` is written into the config the command will load. */
function blockingCommitDeps(enforcement: 'warn' | 'block'): CliDeps {
  writeFileSync(
    path.join(root, 'guardrails.config.json'),
    JSON.stringify({ baseBranch: 'main', enforcement }),
  );
  const eslintJson = JSON.stringify([
    {
      filePath: path.join(root, 'src/foo.ts'),
      messages: [
        {
          ruleId: 'no-console',
          severity: 2,
          message: 'Unexpected console.',
          line: 1,
        },
      ],
    },
  ]);
  const exec: Exec = (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.includes('--name-only')) return Promise.resolve(ok('src/foo.ts'));
    if (line.includes('eslint')) return Promise.resolve(ok(eslintJson));
    // merge-base resolves to nothing, so branchDiff falls back to the staged
    // diff, which is empty — the block comes from the violation, not a finding.
    return Promise.resolve(ok(''));
  };
  return deps({ exec });
}
```

The two tests then read:

```ts
describe('gate --mode=commit enforcement', () => {
  it('exits 1 on a blocking violation when enforcement is block', async () => {
    const code = await runCommand(
      'gate',
      ['--mode=commit'],
      blockingCommitDeps('block'),
    );
    expect(code).toBe(1);
    expect(errors.join('')).not.toContain('enforcement: warn');
  });

  it('exits 0 when enforcement is warn, but still prints the violations', async () => {
    const code = await runCommand(
      'gate',
      ['--mode=commit'],
      blockingCommitDeps('warn'),
    );
    expect(code).toBe(0);
    const output = errors.join('');
    expect(output).toContain('not blocking (enforcement: warn)');
    // A passing exit code must never be mistakable for a clean gate.
    expect(output).toContain('no-console');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/cli-core.test.ts`
Expected: FAIL — the `warn` case exits 1, and the `not blocking` line is absent.

- [ ] **Step 3: Write the implementation**

Replace the tail of `gateCommitCommand` in `guardrails-core/src/cli-core.ts`.
The current final line is `return blocked ? 1 : 0;`. Replace it with:

```ts
if (!blocked) {
  return 0;
}
// `enforcement` governs the commit and preToolUse gates only; the Claude Code
// Stop loop is deliberately never softened (see RepoConfig.enforcement). Under
// `warn` the findings are still printed in full above — a zero exit must never
// be mistakable for a clean gate, so it is stated outright.
if (config.enforcement === 'warn') {
  deps.stderr(
    'guardrails: not blocking (enforcement: warn). Set "enforcement": ' +
      '"block" in guardrails.config.json to make this gate enforce.\n',
  );
  return 0;
}
return 1;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/cli-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise exec -- git add guardrails-core/src/cli-core.ts guardrails-core/test/cli-core.test.ts
mise exec -- git commit -m "feat(gate): honor enforcement on the commit gate"
```

---

## Task 6: Honor `enforcement` on the preToolUse gate

**Files:**

- Modify: `guardrails-core/src/cli-core.ts:164-199` (`gatePreToolUseCommand`)
- Test: `guardrails-core/test/cli-core.test.ts`

**Interfaces:**

- Consumes: `RepoConfig.enforcement`.
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Add a second fixture beside `blockingCommitDeps`. It differs in one way: the
command self-filters on the hook payload, so `readStdin` must return a shell
tool running `git commit`, or the command returns before it ever loads the
config.

```ts
/** As blockingCommitDeps, plus the preToolUse hook payload that gets past the
 *  command's shell-tool + git-commit self-filter. */
function blockingPreToolUseDeps(enforcement: 'warn' | 'block'): CliDeps {
  const base = blockingCommitDeps(enforcement);
  return {
    ...base,
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          cwd: root,
          tool_name: 'bash',
          tool_input: { command: 'git commit -m x' },
        }),
      ),
  };
}
```

Check the payload key names against `parseHookInput` in
`guardrails-core/src/hook-io.ts` before running — it accepts both the Claude and
Copilot dialects, and the fixture must use whichever shape that function reads
for `toolName` and `command`. The existing preToolUse tests in this file already
build such a payload; copy their exact shape.

```ts
describe('gate --mode=pretooluse enforcement', () => {
  it('emits a deny payload when enforcement is block', async () => {
    await runCommand(
      'gate',
      ['--mode=pretooluse'],
      blockingPreToolUseDeps('block'),
    );
    expect(out.join('')).toContain('deny');
  });

  it('writes feedback to stderr and emits no deny payload when enforcement is warn', async () => {
    await runCommand(
      'gate',
      ['--mode=pretooluse'],
      blockingPreToolUseDeps('warn'),
    );
    expect(out.join('')).toBe('');
    expect(errors.join('')).toContain('not blocking (enforcement: warn)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mise exec -- npx vitest run guardrails-core/test/cli-core.test.ts`
Expected: FAIL — the `warn` case still writes a deny payload to stdout.

- [ ] **Step 3: Write the implementation**

In `gatePreToolUseCommand`, replace the final line
(`deps.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));`) with:

```ts
// Under `warn` the gate reports and allows. stderr rather than a deny payload,
// because both hook dialects treat a deny payload as the block itself — there
// is no "allow, but say this" channel — and stderr still surfaces in the
// transcript.
if (config.enforcement === 'warn') {
  deps.stderr(`guardrails: ${reason} Not blocking (enforcement: warn).\n`);
  return;
}
deps.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/cli-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise exec -- git add guardrails-core/src/cli-core.ts guardrails-core/test/cli-core.test.ts
mise exec -- git commit -m "feat(gate): honor enforcement on the preToolUse gate"
```

---

## Task 7: Declare this repo's own analyzer policy

**Files:**

- Modify: `guardrails.config.json`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing. Dogfooding only.

This repo genuinely depends on all five analyzers, and its own gate should say
so explicitly rather than rely on the `auto` default — the config is also the
worked example a reader copies.

- [ ] **Step 1: Add the block**

Add to `guardrails.config.json`, after `"graduationThreshold"`:

```json
  "analyzers": {
    "eslint": "required",
    "tsc": "required",
    "knip": "required",
    "dependency-cruiser": "required",
    "stryker": "required"
  },
```

- [ ] **Step 2: Verify nothing changed for this repo**

Run: `mise exec -- node guardrails-core/dist/cli.mjs verify`
Expected: clean, exactly as before — all five were already effectively required.
Build first if `dist/` is stale: `mise exec -- npm run build`.

- [ ] **Step 3: Run the full gate**

Run: `mise exec -- npm run lint && mise exec -- npm run typecheck && mise exec -- npm test`
Expected: all pass.

- [ ] **Step 4: Run the pre-push gate**

Run: `mise exec -- npm run test:coverage && mise exec -- npm run check:graph`
Expected: pass. `check:graph` is fallow's dead-code + duplication + CRAP gate.
If it reports duplication on `analyzer-policy.ts`'s local `isRecord` (config.ts
and workspaces.ts each have their own copy), do NOT suppress it — extract a
shared `guardrails-core/src/json.ts` and have all three import it. That refactor
changes how many mutants `config.ts`'s existing
`// Stryker disable next-line ConditionalExpression` covers, whose sanction entry
declares `"count": 2`; adjusting that count is a config change, so **ask the
developer before touching `sanctionedSuppressions`.**

- [ ] **Step 5: Run the mutation gate on every file this plan touched**

Run:

```bash
mise exec -- npx stryker run --mutate "guardrails-core/src/verify/analyzer-policy.ts,guardrails-core/src/config.ts,guardrails-core/src/verify/index.ts,guardrails-core/src/gate.ts,guardrails-core/src/cli-core.ts"
```

Expected: 0 survived, 0 no-coverage on the new code. Kill survivors with tests.
Adding a Stryker directive requires the developer's approval first (`CLAUDE.md`),
and per the Phase C finding, a directive silences every mutant of that mutator on
that line — so measure `Killed`/`Ignored` before and after if one is ever
approved.

- [ ] **Step 6: Commit**

```bash
mise exec -- git add guardrails.config.json
mise exec -- git commit -m "chore(config): declare this repo's analyzers explicitly as required"
```

---

## Task 8: Update the project docs to match

**Files:**

- Modify: `plan.md` — the "Roadmap: analyzer opt-in" section
- Modify: `README.md` — the prerequisite note

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Retire the roadmap section**

In `plan.md`, replace the body of `## Roadmap: analyzer opt-in (pack
composition, not all-or-nothing)` with a short shipped-note: the chosen policy
is the hybrid, the truth table lives in
`guardrails-core/src/verify/analyzer-policy.ts`, the design is
`docs/superpowers/specs/2026-08-30-phase-e-adoption-design.md` §3, and the
declared-provider check is what closes the silent-degradation hole the section
worried about. Keep the closing cross-reference to the mutation survivor
baseline, and state that it remains out of scope.

Also update the `## Build phases` entry for **E** to name the seven pieces from
the spec, replacing "Scaffolder + team-flip".

- [ ] **Step 2: Update the README prerequisite**

`README.md`'s "Prerequisite — clean baseline" block and the knip paragraph below
it both assume every analyzer runs. Add one sentence after them: an analyzer set
to `"off"` in `guardrails.config.json`'s `analyzers` block never runs and never
reports, so a repo can adopt eslint/tsc first and add the whole-graph analyzers
once its baseline is clean.

- [ ] **Step 3: Commit**

```bash
mise exec -- git add plan.md README.md
mise exec -- git commit -m "docs: record analyzer opt-in as shipped"
```

---

## Done criteria

- `mise exec -- npm run lint && mise exec -- npm run typecheck && mise exec -- npm test` all pass.
- `mise exec -- npm run test:coverage && mise exec -- npm run check:graph` passes.
- The mutation run in Task 7 Step 5 reports 0 survived / 0 no-coverage.
- `mise exec -- node guardrails-core/dist/cli.mjs verify` is clean on this repo.
- A repo with `{"analyzers": {"knip": "off", "stryker": "off", "dependency-cruiser": "off"}}`
  and none of those three installed passes `gate --mode=commit` with no
  `analyzer-missing` violation. Verify by hand in a temp repo before calling this
  done — it is the actual adoption blocker this plan exists to remove.
- No new entry in `sanctionedSuppressions`.

## Next plans in this phase

Following Phase C's one-plan-per-piece convention:

- `2026-XX-XX-phase-e-packaging-release.md` — piece 3
- `2026-XX-XX-phase-e-guardrails-init.md` — piece 4
- `2026-XX-XX-phase-e-scaffolding-skill.md` — pieces 5–6
- Piece 7 (cut the release, adopt, record findings) is an operational checklist
  rather than a code plan; it lives in the spec (§9).
