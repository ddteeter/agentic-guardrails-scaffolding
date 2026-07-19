# dependency-cruiser + Analyzer Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dependency-cruiser as the 2nd Phase-C commit-rung analyzer (three teeth-having graph rules), refactor `runVerify` to a min-rung analyzer registry, and add a drift-guard entry for dependency-cruiser's upstream-owned vocabulary.

**Architecture:** A `.dependency-cruiser.cjs` at the repo root declares three `error`-severity rules (`no-circular`, `not-to-test-from-src`, `exec-seam`). A pure `parseDepcruiseJson` adapter maps `depcruise --output-type json` into the existing `Violation` contract. `verify/index.ts` replaces its `if (profile !== 'stop')` knip branch with a `const ANALYZERS` min-rung table (knip + dependency-cruiser, both `minRung: 'commit'`), run serially; ESLint/tsc stay outside the table as the diff-scoped special case. A third `DriftEntry` in `test/drift/registry.test.ts` probes dependency-cruiser's config-condition-keyword + severity vocabulary.

**Tech Stack:** TypeScript (strict, ESM → `.mjs`), Vitest, dependency-cruiser (installed at the repo root, invoked via the injected `Exec` + `resolveBin`), the existing `verify` orchestrator.

**Design doc:** `docs/superpowers/specs/2026-07-19-phase-c-dependency-cruiser-design.md`

## Global Constraints

- **TDD** — no production code without a failing test first. Every code task writes the test, watches it fail, then implements.
- **Fix code, don't weaken rules** — never add `eslint-disable` / `@ts-ignore` / `as any` / `.skip`, delete code to quiet a checker, or raise thresholds. A real dependency-cruiser finding at first-enable is cleaned as ordinary work, never routed around.
- **`fixable` is always `false`** for dependency-cruiser — it has no safe autofix; graph fixes are judgment, never a silent PostToolUse autofix.
- **`Severity` is `'error' | 'warn'` only** (see `src/violation.ts`). Map dependency-cruiser `error → 'error'`, `warn`/`info → 'warn'`, `ignore → skipped`. There is no `'warning'`.
- **dependency-cruiser runs project-wide, clean-baseline** — the repo must be dependency-cruiser-clean before the commit gate relies on it (Task 1 enforces this). Matches tsc/knip's stance in `verify/index.ts`.
- **Config is `.dependency-cruiser.cjs`** (CommonJS) — the repo is `"type": "module"`, so a `.js` config would be mis-parsed as ESM.
- **Commit gate stays block-only** — this plan does NOT make dependency-cruiser delegate; its `dependency-cruiser/` loose-classification (already in `loose-rules.ts`) is intentionally dormant under this cut.
- **File layout** — source in `guardrails-core/src/`, tests mirror under `guardrails-core/test/`. Tests import source via the `.js` extension (`../../src/verify/depcruise-adapter.js`).
- **`Exec` seam** — every shell-out takes the injected `Exec`; unit tests use the `fakeExec` in `test/verify/orchestrator.test.ts`, never real processes, EXCEPT the drift-guard test (Task 4), which spawns real dependency-cruiser by design (mirroring the knip probe).
- **`resolveBin` is generic** — `binResolver(repoRoot)` in `cli-core.ts` resolves any tool to the repo-local `node_modules/.bin`, so `resolveBin('depcruise')` works with no CLI change once the devDep is installed.

---

## Task 1: Install dependency-cruiser, author the config, establish a clean baseline

**Files:**

- Modify: root `package.json` (add `dependency-cruiser` devDependency)
- Create: root `.dependency-cruiser.cjs`
- Reference: `guardrails-core/src/exec.ts` (the one legitimate `node:child_process` importer), `guardrails-core/tsconfig.json`

**Interfaces:**

- Consumes: nothing (first task).
- Produces: an installed `depcruise` bin at `node_modules/.bin/depcruise`; a repo-root `.dependency-cruiser.cjs` with rules named `no-circular`, `not-to-test-from-src`, `exec-seam`; a verified clean baseline. Later tasks rely on the rule names and the config path.

- [ ] **Step 1: Install dependency-cruiser at the repo root**

Run from the repo root (the directory containing the root `package.json`):

```bash
npm install --save-dev dependency-cruiser
```

Then record the resolved version:

```bash
node -e "console.log(require('dependency-cruiser/package.json').version)"
```

Expected: a version string prints (dependency-cruiser is 16.x-era at time of writing). Note it — if the installed major differs from what the fixture in Task 2 assumes, re-capture the fixture (Step 4 below) and adjust the adapter's field reads only.

- [ ] **Step 2: Author `.dependency-cruiser.cjs`**

Create `.dependency-cruiser.cjs` at the repo root:

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies within the module graph.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-test-from-src',
      severity: 'error',
      comment: 'Production src must not import test/spec/fixture modules.',
      from: {
        path: '^guardrails-core/src',
        pathNot: '\\.(test|spec)\\.ts$',
      },
      to: {
        path: '(\\.(test|spec)\\.ts$|/test/)',
      },
    },
    {
      name: 'exec-seam',
      severity: 'error',
      comment:
        'Only src/exec.ts may import node:child_process (the injected Exec seam every shell-out routes through).',
      from: {
        path: '^guardrails-core/src',
        pathNot: '^guardrails-core/src/exec\\.ts$',
      },
      to: {
        path: '^(node:)?child_process$',
        dependencyTypes: ['core'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'guardrails-core/tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
```

- [ ] **Step 3: Run dependency-cruiser and confirm a clean baseline**

Run from the repo root:

```bash
node_modules/.bin/depcruise --config .dependency-cruiser.cjs --output-type err guardrails-core/src
```

Expected: exit 0, no violations ("no dependency violations found"). If a real finding appears (most likely a `no-circular` cycle — `exec-seam` and `not-to-test-from-src` were verified clean during design), FIX THE CODE (break the cycle / reroute the import), never weaken the rule. Re-run until clean.

- [ ] **Step 4: Prove each rule has teeth (temporary violation, then revert)**

The risk with a misconfigured graph rule is that it silently never fires. Confirm `exec-seam` actually matches `node:child_process` (its `to.path` regex depends on how dependency-cruiser names the core module):

```bash
# Temporarily add a forbidden import to a non-exec source file:
node -e "require('fs').appendFileSync('guardrails-core/src/scope.ts', String.fromCharCode(10) + 'import { spawn as _probe } from ' + JSON.stringify('node:child_process') + ';' + String.fromCharCode(10))"
node_modules/.bin/depcruise --config .dependency-cruiser.cjs --output-type err guardrails-core/src
```

Expected: dependency-cruiser reports an `exec-seam` error on `guardrails-core/src/scope.ts`. Then revert:

```bash
git checkout guardrails-core/src/scope.ts
```

Expected: `git status` clean for `scope.ts`; a final `depcruise … --output-type err guardrails-core/src` run is clean again. (If `exec-seam` did NOT fire, dependency-cruiser names the core module differently — inspect `depcruise --output-type json guardrails-core/src` for the `to` module name and widen the `exec-seam` `to.path` regex accordingly, then re-verify.)

- [ ] **Step 5: Capture a real JSON fixture for the adapter (Task 2)**

With the temporary violation logic from Step 4 as a guide, capture dependency-cruiser's real `--output-type json` shape for a `no-circular` + a forbidden-edge case into a scratch file, to reconcile against the hand-authored fixture in Task 2:

```bash
node_modules/.bin/depcruise --config .dependency-cruiser.cjs --output-type json guardrails-core/src > /tmp/depcruise-clean.json
node -e "const j=require('/tmp/depcruise-clean.json'); console.log(Object.keys(j)); console.log(Object.keys(j.summary));"
```

Expected: top-level keys include `summary` and `modules`; `summary` includes `violations`. Confirm a `summary.violations[]` entry (produce one with the Step-4 temporary import if the clean repo has none) has the shape `{ from, to, rule: { name, severity }, ... }` and, for circular, a `cycle` array. This is the reference the Task 2 adapter maps.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .dependency-cruiser.cjs
git commit -m "build(depcruise): add dependency-cruiser devDep + config (3 graph rules), clean baseline"
```

---

## Task 2: The `parseDepcruiseJson` adapter

**Files:**

- Create: `guardrails-core/src/verify/depcruise-adapter.ts`
- Test: `guardrails-core/test/verify/depcruise-adapter.test.ts`

**Interfaces:**

- Consumes: `Violation` from `../violation.js`; the real JSON shape captured in Task 1 Step 5.
- Produces: `export function parseDepcruiseJson(stdout: string, repoRoot: string, packageId?: string): Violation[]`. Task 3's `runDepcruise` calls it.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/verify/depcruise-adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseDepcruiseJson } from '../../src/verify/depcruise-adapter.js';

const forbiddenEdge = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/scope.ts',
        to: 'node:child_process',
        rule: { name: 'exec-seam', severity: 'error' },
      },
    ],
    error: 1,
    warn: 0,
    info: 0,
  },
  modules: [],
});

const circular = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/a.ts',
        to: 'guardrails-core/src/b.ts',
        rule: { name: 'no-circular', severity: 'error' },
        cycle: [
          { name: 'guardrails-core/src/b.ts' },
          { name: 'guardrails-core/src/a.ts' },
        ],
      },
    ],
    error: 1,
    warn: 0,
    info: 0,
  },
  modules: [],
});

const infoSeverity = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/x.ts',
        to: 'guardrails-core/src/y.ts',
        rule: { name: 'some-advice', severity: 'info' },
      },
    ],
  },
  modules: [],
});

describe('parseDepcruiseJson', () => {
  it('maps a forbidden edge to a namespaced, non-fixable error violation', () => {
    const [v] = parseDepcruiseJson(forbiddenEdge, '/repo');
    expect(v).toMatchObject({
      ruleId: 'dependency-cruiser/exec-seam',
      file: 'guardrails-core/src/scope.ts',
      severity: 'error',
      fixable: false,
      tool: 'dependency-cruiser',
    });
    expect(v.message).toContain('exec-seam');
    expect(v.message).toContain('node:child_process');
    expect(v.line).toBeUndefined();
  });

  it('describes a circular violation with the cycle path', () => {
    const [v] = parseDepcruiseJson(circular, '/repo');
    expect(v.ruleId).toBe('dependency-cruiser/no-circular');
    expect(v.message).toContain('Circular dependency');
    expect(v.message).toContain('guardrails-core/src/a.ts');
    expect(v.message).toContain('guardrails-core/src/b.ts');
  });

  it('maps info/warn severities to warn', () => {
    const [v] = parseDepcruiseJson(infoSeverity, '/repo');
    expect(v.severity).toBe('warn');
  });

  it('passes packageId through when provided', () => {
    const [v] = parseDepcruiseJson(forbiddenEdge, '/repo', 'guardrails-core');
    expect(v.package).toBe('guardrails-core');
  });

  it('returns [] for empty, malformed, or shapeless input', () => {
    expect(parseDepcruiseJson('', '/repo')).toEqual([]);
    expect(parseDepcruiseJson('not json', '/repo')).toEqual([]);
    expect(
      parseDepcruiseJson(JSON.stringify({ modules: [] }), '/repo'),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=guardrails-core -- depcruise-adapter`
Expected: FAIL — `parseDepcruiseJson` is not defined / module not found.

- [ ] **Step 3: Write the adapter**

Create `guardrails-core/src/verify/depcruise-adapter.ts`:

```ts
/**
 * dependency-cruiser adapter: maps `depcruise --output-type json` output into
 * `Violation[]`.
 *
 * dependency-cruiser reports rule violations under `summary.violations`, each a
 * forbidden edge `{ from, to, rule: { name, severity }, cycle? }`. Every
 * violation is `fixable: false`: dependency-cruiser has no safe autofix, and a
 * graph fix (delete the import, invert the dependency, add an exception) is a
 * judgment, never a silent autofix. Paths are emitted repo-relative already.
 */

import type { Severity, Violation } from '../violation.js';

interface DepcruiseRule {
  name: string;
  severity: string;
}

interface DepcruiseViolation {
  from: string;
  to: string;
  rule: DepcruiseRule;
  cycle?: { name: string }[];
}

function isDepcruiseReport(
  value: unknown,
): value is { summary: { violations: DepcruiseViolation[] } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const summary = (value as { summary?: unknown }).summary;
  if (typeof summary !== 'object' || summary === null) {
    return false;
  }
  const violations = (summary as { violations?: unknown }).violations;
  return (
    Array.isArray(violations) &&
    violations.every(
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as DepcruiseViolation).from === 'string' &&
        typeof (v as { rule?: { name?: unknown } }).rule?.name === 'string',
    )
  );
}

/** dependency-cruiser `error → error`; `warn`/`info → warn`; anything else skipped. */
function toSeverity(severity: string): Severity | undefined {
  if (severity === 'error') {
    return 'error';
  }
  if (severity === 'warn' || severity === 'info') {
    return 'warn';
  }
  return undefined;
}

function toMessage(violation: DepcruiseViolation): string {
  if (Array.isArray(violation.cycle)) {
    const path = violation.cycle.map((module) => module.name).join(' → ');
    return `Circular dependency: ${path}`;
  }
  return `${violation.rule.name}: ${violation.from} → ${violation.to}`;
}

function toViolation(
  violation: DepcruiseViolation,
  packageId?: string,
): Violation | undefined {
  const severity = toSeverity(violation.rule.severity);
  if (severity === undefined) {
    return undefined;
  }
  return {
    ruleId: `dependency-cruiser/${violation.rule.name}`,
    file: violation.from,
    message: toMessage(violation),
    severity,
    fixable: false,
    tool: 'dependency-cruiser',
    ...(packageId === undefined ? {} : { package: packageId }),
  };
}

export function parseDepcruiseJson(
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
  if (!isDepcruiseReport(parsed)) {
    return [];
  }
  return parsed.summary.violations
    .map((violation) => toViolation(violation, packageId))
    .filter((violation): violation is Violation => violation !== undefined);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=guardrails-core -- depcruise-adapter`
Expected: PASS (all cases). If the real fixture from Task 1 Step 5 shows different field names (e.g. `cycle` entries aren't `{ name }`), reconcile the adapter's reads and the test fixtures against the captured real JSON before proceeding.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/verify/depcruise-adapter.ts guardrails-core/test/verify/depcruise-adapter.test.ts
git commit -m "feat(verify): parseDepcruiseJson adapter → Violation[]"
```

---

## Task 3: Analyzer registry refactor + wire dependency-cruiser into `runVerify`

**Files:**

- Modify: `guardrails-core/src/verify/index.ts`
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: `parseDepcruiseJson` from `./depcruise-adapter.js` (Task 2); the `.dependency-cruiser.cjs` config path + `depcruise` bin (Task 1).
- Produces: a min-rung `ANALYZERS` table in `verify/index.ts`; `runVerify` runs knip + dependency-cruiser at `commit`/`ci`, neither at `stop`, with ESLint/tsc still diff-scoped. No signature change to `runVerify` — callers in `gate.ts`/`cli-core.ts` are untouched.

- [ ] **Step 1: Write the failing tests**

Add these cases to `guardrails-core/test/verify/orchestrator.test.ts`. First extend `fakeExec` so it answers `depcruise` — add this branch immediately before the final `return Promise.resolve(ok(''));`:

```ts
if (command === 'depcruise' || args.includes('depcruise')) {
  return Promise.resolve(ok(depcruiseJson));
}
```

Add the `depcruiseJson` fixture near the top-of-file `knipJson` constant:

```ts
const depcruiseJson = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/scope.ts',
        to: 'node:child_process',
        rule: { name: 'exec-seam', severity: 'error' },
      },
    ],
    error: 1,
    warn: 0,
    info: 0,
  },
  modules: [],
});
```

Then add these tests inside the `describe('runVerify', ...)` block:

```ts
it('runs dependency-cruiser and includes its violations at the commit profile', async () => {
  const { exec, calls } = fakeExec();
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile: 'commit',
  });
  expect(violations.map((v) => v.ruleId)).toContain(
    'dependency-cruiser/exec-seam',
  );
  expect(
    calls.some(
      (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
    ),
  ).toBe(true);
});

it('does NOT run dependency-cruiser at the stop profile', async () => {
  const { exec, calls } = fakeExec();
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
  });
  expect(violations.map((v) => v.ruleId)).not.toContain(
    'dependency-cruiser/exec-seam',
  );
  expect(
    calls.some(
      (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
    ),
  ).toBe(false);
});

it('runs dependency-cruiser at the commit profile even when zero TS files changed', async () => {
  const noTs = fakeExec({
    'git diff --name-only --diff-filter=ACM main': {
      stdout: 'README.md',
      stderr: '',
      code: 0,
    },
    'git ls-files --others --exclude-standard': {
      stdout: '',
      stderr: '',
      code: 0,
    },
  });
  await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec: noTs.exec,
    profile: 'commit',
  });
  expect(
    noTs.calls.some(
      (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace=guardrails-core -- orchestrator`
Expected: the three new tests FAIL (dependency-cruiser is never invoked; `dependency-cruiser/exec-seam` absent). The existing knip/eslint/tsc tests still PASS.

- [ ] **Step 3: Refactor `runVerify` to the registry table**

In `guardrails-core/src/verify/index.ts`: add the `parseDepcruiseJson` import next to the knip import:

```ts
import { parseDepcruiseJson } from './depcruise-adapter.js';
```

Remove the `if (profile === 'stop') { return []; }` guard from `runKnip` (the table now owns rung-gating), leaving:

```ts
async function runKnip(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const knip = await exec(resolveBin('knip'), ['--reporter', 'json'], {
    cwd: repoRoot,
  });
  return parseKnipJson(knip.stdout, repoRoot, packageId);
}
```

Add `runDepcruise` beside it:

```ts
/** dependency-cruiser is whole-graph (not diff-scoped); like knip it runs at
 *  the commit/ci rungs only, independent of whether any `.ts` file changed. It
 *  assumes a dependency-cruiser-clean baseline, like tsc/knip. */
async function runDepcruise(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const result = await exec(
    resolveBin('depcruise'),
    [
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
      'guardrails-core/src',
    ],
    { cwd: repoRoot },
  );
  return parseDepcruiseJson(result.stdout, repoRoot, packageId);
}
```

Add the rung table above `runVerify`:

```ts
type Rung = NonNullable<VerifyOptions['profile']>;
const RUNG_ORDER: Record<Rung, number> = { stop: 0, commit: 1, ci: 2 };

interface Analyzer {
  tool: string;
  minRung: Rung;
  run: (
    options: VerifyOptions,
    resolveBin: (tool: string) => string,
  ) => Promise<Violation[]>;
}

/** Whole-graph analyzers, each gated by its minimum cadence rung. ESLint/tsc are
 *  NOT here — they are diff-scoped (gated on changed files, run at every rung),
 *  so they stay the special case in runVerify below. When semgrep (the first
 *  diff-scopable / possibly stop-rung analyzer) and stryker (CI-only) arrive,
 *  re-evaluate whether minRung alone suffices or this table must graduate to a
 *  fuller per-analyzer abstraction (bin + adapter + diff-scope policy), and
 *  reconsider parallel execution under a measured commit-gate budget. */
const ANALYZERS: Analyzer[] = [
  { tool: 'knip', minRung: 'commit', run: runKnip },
  { tool: 'dependency-cruiser', minRung: 'commit', run: runDepcruise },
];
```

Replace the body of `runVerify` with the table-driven form:

```ts
export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const files = await changedTypeScriptFiles(options);
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  const profile = options.profile ?? 'stop';

  const violations: Violation[] = [];
  for (const analyzer of ANALYZERS) {
    if (RUNG_ORDER[profile] >= RUNG_ORDER[analyzer.minRung]) {
      violations.push(...(await analyzer.run(options, resolveBin)));
    }
  }
  violations.push(...(await runEslintAndTsc(options, resolveBin, files)));
  return { violations };
}
```

- [ ] **Step 4: Run the full verify suite to verify green**

Run: `npm test --workspace=guardrails-core -- orchestrator`
Expected: PASS — all existing knip/eslint/tsc tests AND the three new dependency-cruiser tests. (The knip guard moved to the table, so the existing "does NOT run knip at the stop profile" test still passes.)

- [ ] **Step 5: Full type-check + lint**

Run: `npm run build --workspace=guardrails-core` (or the repo's `tsc --noEmit` equivalent) and `npx eslint guardrails-core/src/verify/index.ts`
Expected: no type errors, no lint errors. In particular confirm `type Rung = NonNullable<VerifyOptions['profile']>` compiles (it aliases `'stop' | 'commit' | 'ci'`).

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/test/verify/orchestrator.test.ts
git commit -m "refactor(verify): min-rung analyzer registry; wire dependency-cruiser at commit rung"
```

---

## Task 4: Drift-guard entry for dependency-cruiser

**Files:**

- Modify: `guardrails-core/test/drift/registry.test.ts`

**Interfaces:**

- Consumes: the existing `DriftEntry` interface + `checkDrift` from `../../src/drift-guard.js`; the installed dependency-cruiser package (Task 1).
- Produces: a third `DriftEntry` (`tool: 'dependency-cruiser'`) asserting the config-condition keywords + severity enum our config/adapter depend on still exist upstream.

- [ ] **Step 1: Discover dependency-cruiser's condition-keyword source**

The probe must return the set of rule-condition property names dependency-cruiser currently accepts (so a renamed `circular` → silent under-detection is caught). dependency-cruiser ships a JSON schema for its config. Locate it and inspect its structure:

```bash
find node_modules/dependency-cruiser -name "*.json" -path "*schema*"
node -e "const s=require('dependency-cruiser/schema/configuration-schema.json'); console.log(Object.keys(s.definitions || s.\$defs || {}))"
```

Expected: a `configuration-schema.json` path prints, and the definitions include restriction/condition types (names vary by version, e.g. `RestrictionType`, `FromRestrictionType`, `ToRestrictionType`). Identify the definition(s) whose `properties` include `path`, `pathNot`, `circular`, `dependencyTypes`. Record the exact require path + definition key(s) for Step 3. (If no schema file is shipped in the installed version, use the fixture fallback in Step 3b instead.)

- [ ] **Step 2: Write the failing test**

Add to `guardrails-core/test/drift/registry.test.ts`. First the probe (adjust the require path + definition keys to what Step 1 found):

```ts
/**
 * dependency-cruiser probe: the config-rule-condition keywords and severity
 * enum our `.dependency-cruiser.cjs` + depcruise-adapter depend on. Rule *names*
 * are ours (authored in the config), so they are NOT the drift target — what
 * upstream owns and can rename on upgrade is the condition vocabulary. A renamed
 * `circular` would silently stop detecting cycles; this asserts it still exists.
 */
async function depcruiseConditionKeywords(): Promise<Set<string>> {
  const { createRequire } = await import('node:module');
  const requireFromHere = createRequire(import.meta.url);
  const schema = requireFromHere(
    'dependency-cruiser/schema/configuration-schema.json',
  ) as {
    definitions?: Record<string, { properties?: Record<string, unknown> }>;
  };
  const definitions = schema.definitions ?? {};
  const keywords = new Set<string>();
  for (const definition of Object.values(definitions)) {
    for (const property of Object.keys(definition.properties ?? {})) {
      keywords.add(property);
    }
  }
  // Severity enum values are hardcoded by the adapter's toSeverity mapping.
  for (const severity of ['error', 'warn', 'info']) {
    keywords.add(severity);
  }
  return keywords;
}
```

Then add the registry entry to the `entries` array:

```ts
  {
    tool: 'dependency-cruiser',
    // Condition keywords our .dependency-cruiser.cjs rules use + severities the
    // adapter maps. NOT rule names (those are ours). See probe doc above.
    knownIds: [
      'circular',
      'path',
      'pathNot',
      'dependencyTypes',
      'error',
      'warn',
      'info',
    ],
    probe: depcruiseConditionKeywords,
    hint: 'dependency-cruiser renamed/removed a rule-condition keyword or severity — reconcile .dependency-cruiser.cjs and guardrails-core/src/verify/depcruise-adapter.ts',
  },
```

- [ ] **Step 2b: Fixture fallback (ONLY if Step 1 found no shipped schema)**

If the installed dependency-cruiser ships no `configuration-schema.json`, replace the `depcruiseConditionKeywords` probe with a behavioral one: run real depcruise against a fixture that organically triggers each rule and return the set of rule names that fired, with `knownIds: ['no-circular', 'not-to-test-from-src', 'exec-seam']`. Create the fixture under `guardrails-core/test/drift/depcruise-fixture/` (a file with a self-cycle, a src-imports-test edge, and a non-exec `node:child_process` import) plus a fixture-local `.dependency-cruiser.cjs`, and — per the piece-1 knip-fixture finding — exclude `test/drift/depcruise-fixture/**` from `knip.json` (`ignore`), `guardrails-core/tsconfig.json` (`exclude`), root `eslint.config.js` (`ignores`), and root `.fallowrc.jsonc` (`ignorePatterns`). Prefer Step 2's schema probe precisely to avoid this fixture; only use this branch if the schema is genuinely absent.

- [ ] **Step 3: Run the test to verify it passes (real dependency-cruiser)**

Run: `npm test --workspace=guardrails-core -- drift`
Expected: PASS — every `knownId` (`circular`, `path`, `pathNot`, `dependencyTypes`, `error`, `warn`, `info`) is found in the current dependency-cruiser vocabulary. To confirm the guard actually bites, temporarily add a bogus id (e.g. `'no-such-keyword'`) to `knownIds`, re-run, see it FAIL with the hint, then remove it.

- [ ] **Step 4: Commit**

```bash
git add guardrails-core/test/drift/registry.test.ts
git commit -m "test(drift): guard dependency-cruiser condition-keyword + severity vocabulary"
```

---

## Task 5: Documentation — Phase C status + semgrep revisit hint

**Files:**

- Modify: `plan.md` (the `## Phase C status (in progress)` section)

**Interfaces:**

- Consumes: nothing.
- Produces: a "Piece 2 — dependency-cruiser + analyzer registry (shipped)" subsection and the semgrep-revisit note, so the next phase picks up the registry-evolution decision.

- [ ] **Step 1: Add the piece-2 status entry**

Under `## Phase C status (in progress)`, after the piece-1 block, add:

```markdown
- **Piece 2 — dependency-cruiser + analyzer registry (shipped).**
  dependency-cruiser runs at the commit/ci rungs via a new min-rung analyzer
  registry in `verify/index.ts` (the `if (profile !== 'stop')` knip branch is
  now a `const ANALYZERS` table; knip + dependency-cruiser are `minRung: 'commit'`
  entries, run serially; ESLint/tsc stay the diff-scoped special case). A
  `.dependency-cruiser.cjs` declares three teeth-having rules — `no-circular`,
  `not-to-test-from-src`, and `exec-seam` (only `src/exec.ts` may import
  `node:child_process`, enforcing the injected-Exec invariant). A
  `parseDepcruiseJson` adapter maps `--output-type json` to `Violation[]`
  (`fixable: false` — dependency-cruiser has no safe autofix). The drift-guard
  gained a third probe over dependency-cruiser's config-condition keywords +
  severity enum (its rule names are ours, so not a drift target). Orphan/unresolved
  rules were deliberately left off — fallow + knip own dead-code. Design:
  `docs/superpowers/specs/2026-07-19-phase-c-dependency-cruiser-design.md`.
  - **Dormant loose-class (by design):** dependency-cruiser is loose-classed but
    runs only on the block-only commit rung, so thorough-tier routing stays inert
    until the throttled Stop tier (option B) lands — identical to knip.
  - **Registry revisit deferred to semgrep:** the min-rung table models only
    `minRung`, not a diff-scope policy. semgrep (first diff-scopable / possibly
    stop-rung analyzer) and stryker (CI-only) are the trigger to re-evaluate
    whether it must graduate to a fuller per-analyzer abstraction, and to
    reconsider parallel execution under a measured commit-gate budget.
```

- [ ] **Step 2: Verify the full gate is green before the final commit**

Run the authoritative pre-push gate:

```bash
npm run test:coverage && npm run check:graph
```

Expected: all tests pass, coverage holds, `check:graph` (fallow) clean. This is the same gate CI enforces; it must pass before the branch is done.

- [ ] **Step 3: Commit**

```bash
git add plan.md
git commit -m "docs(plan): Phase C piece 2 status — dependency-cruiser + analyzer registry"
```

---

## Self-Review

**Spec coverage:**

- Min-rung analyzer registry (spec §3) → Task 3.
- `parseDepcruiseJson` adapter + mapping table (spec §5) → Task 2.
- `.dependency-cruiser.cjs` with the three rules (spec §4) → Task 1.
- Drift-guard third probe over upstream-owned vocabulary (spec §6) → Task 4.
- Clean-baseline enablement (spec §8) → Task 1 Steps 3–4.
- Semgrep revisit hint (spec §3) → Task 3 Step 3 (code comment) + Task 5 Step 1 (plan.md).
- Loose-class dormancy, serial-not-parallel, ESLint/tsc-outside-table (spec §2, §3) → Task 3 comments + Task 5.
- Out-of-scope items (orphan/unresolved off, affected-scoping, stryker) → not implemented, recorded in Task 5 status.

**Placeholder scan:** No TBD/TODO. The one branch (Task 4 Step 2b fixture fallback) is a fully-specified alternative selected by a deterministic criterion in Step 1 (schema shipped or not), not a placeholder.

**Type consistency:** `parseDepcruiseJson(stdout, repoRoot, packageId?)` defined in Task 2, called identically in Task 3's `runDepcruise`. `Severity` mapping uses `'error' | 'warn'` (matches `violation.ts`). `Rung = NonNullable<VerifyOptions['profile']>` aliases the existing `'stop' | 'commit' | 'ci'`. Rule names `no-circular` / `not-to-test-from-src` / `exec-seam` are consistent across Tasks 1, 3, 4, 5. `depcruise` is the bin name (resolved via `resolveBin`) throughout.
