# Phase C piece 4 — stryker mutation gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stryker as a diff-scoped, incremental, commit-rung mutation-testing analyzer that flags surviving mutants in the code a turn changed.

**Architecture:** A `parseStrykerJson` adapter maps the `mutation-testing-elements` report to `Violation[]` (Survived-in-changed-code only). A `runStryker` orchestrator function execs stryker (consumer-generic, reads the report _file_), scoped to changed production files. The `ANALYZERS` table graduates to model a `scope` (run-trigger) policy, folding ESLint/tsc in. A fourth drift probe guards the `MutantStatus` enum. The gate blocks on any survivor in changed code; noise is controlled by diff-scoping + consumer-owned `excludedMutations` + in-source region exclusion.

**Tech Stack:** TypeScript (strict, ESM), vitest, `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` 9.x, `mutation-testing-report-schema` 3.x.

**Spec:** `docs/superpowers/specs/2026-07-23-phase-c-stryker-design.md` — read it first.

## Global Constraints

- **TDD** — no production code without a failing test first. One assertion of behavior per step.
- **Never weaken a rule** — no `eslint-disable` / `@ts-ignore` / `as any` / `.skip` / raised thresholds. (`// Stryker disable` in `audit.ts` per Task 7 is a _curated mutation-scope_ decision, not a correctness suppression, and is the one deliberate exception — justified in-file.)
- **TypeScript stays on `^5`** (TS 6 breaks tsup dts) — do not bump.
- **Consumer-generic invocation** — the stryker CLI call carries **no** `--configFile` and **no** repo-specific path; only `run --incremental --reporters json --mutate <changed files>`. A "no repo-specific argv" test enforces this.
- **Verify against the real gate** — `npm run lint`, `npm test`, `npm run typecheck`, `npm run check:graph` (never a hand-scoped probe; whole-graph issues surface only at commit/push).
- **`noUncheckedIndexedAccess` is on** — use whole-array matchers (`toContainEqual`), never `const [v] = fn(); v.prop`. vitest (esbuild) won't catch the resulting `TS18048`; only `npm run typecheck` will.
- **Pin `fixable: false`** via object-equality assertions (`toContainEqual({...})`), never `expect(v.fixable).toBe(false)` — the `no-unnecessary-boolean-literal-compare` autofix rewrites `=== false`.
- **House lint rules bite adapters** — keep functions under `sonarjs/cognitive-complexity` (15) and avoid `unicorn/prevent-abbreviations` triggers; decompose into named helpers (mirror `knip-adapter.ts`).
- **Report default path** — stryker's json reporter writes `reports/mutation/mutation.json` (verified default); `runStryker` reads exactly that.

---

### Task 1: Install the stryker toolchain + gitignore

**Files:**

- Modify: `package.json` (root `devDependencies`)
- Modify: `guardrails-core/package.json` (`devDependencies`)
- Modify: `.gitignore`

**Interfaces:**

- Produces: the `stryker` binary resolvable at `node_modules/.bin/stryker`; the schema importable at `mutation-testing-report-schema/mutation-testing-report-schema.json`.

- [ ] **Step 1: Add the CLI tools to the root devDependencies**

Root tools (invoked via `resolveBin`, like `eslint`/`knip`/`dependency-cruiser`) go in the **root** `package.json`:

```bash
npm install --save-dev --save-exact=false \
  @stryker-mutator/core@^9.6.1 \
  @stryker-mutator/vitest-runner@^9.6.1
```

- [ ] **Step 2: Add the schema package to guardrails-core devDependencies**

`mutation-testing-report-schema` is imported by the drift probe under `guardrails-core/test/`, so it must be declared in that workspace (the piece-1 `@eslint/js` "declare where it's used" lesson):

```bash
npm install --save-dev --save-exact=false \
  --workspace guardrails-core \
  mutation-testing-report-schema@^3.7.3
```

- [ ] **Step 3: Gitignore stryker's generated artifacts**

Append to `.gitignore` (below the existing `coverage/` line):

```gitignore
reports/
.stryker-tmp/
```

- [ ] **Step 4: Verify the toolchain resolves**

Run:

```bash
node -e "require('node:fs').accessSync('node_modules/.bin/stryker'); console.log('bin ok')"
node --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire('$PWD/guardrails-core/test/x.js'); console.log('schema:', r.resolve('mutation-testing-report-schema/mutation-testing-report-schema.json').includes('node_modules') ? 'ok' : 'MISSING')"
```

Expected: `bin ok` then `schema: ok`.

- [ ] **Step 5: Commit**

```bash
git add package.json guardrails-core/package.json package-lock.json .gitignore
git commit -m "build: add stryker + vitest-runner + report-schema devDeps, gitignore artifacts"
```

**Correction (found when the branch was first pushed):** Task 1 taught **knip** about the
two new unused devDependencies but not **fallow**, whose whole-graph dead-dependency check
runs only in the `pre-push` gate — so the miss stayed invisible across both Task-1 commits
and blocked the first `git push`. `@stryker-mutator/vitest-runner` and
`mutation-testing-report-schema` were added to `.fallowrc.jsonc`'s `ignoreDependencies`
(permanent and stopgap respectively; `@stryker-mutator/core` needs no entry — fallow
resolves it via its `stryker` bin). This is a second instance of piece 1's
"the gate runs at push, not per-commit, so it slipped earlier tasks unnoticed" finding:
**a new devDependency must be reconciled against knip AND fallow in the same task that adds it.**

---

### Task 2: `parseStrykerJson` adapter

**Files:**

- Create: `guardrails-core/src/verify/stryker-adapter.ts`
- Test: `guardrails-core/test/verify/stryker-adapter.test.ts`

**Interfaces:**

- Produces: `parseStrykerJson(reportJson: string, changedFiles: readonly string[], packageId?: string): Violation[]` — emits one `Violation` per `Survived` mutant whose file is in `changedFiles`. `ruleId: 'stryker/survived'`, `tool: 'stryker'`, `fixable: false`, `severity: 'error'`, `line` from `location.start.line`.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/verify/stryker-adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseStrykerJson } from '../../src/verify/stryker-adapter.js';

const report = JSON.stringify({
  schemaVersion: '1.0',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/changed.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '1',
          mutatorName: 'ConditionalExpression',
          status: 'Survived',
          location: {
            start: { line: 12, column: 3 },
            end: { line: 12, column: 9 },
          },
        },
        {
          id: '2',
          mutatorName: 'BlockStatement',
          status: 'Killed',
          location: {
            start: { line: 20, column: 1 },
            end: { line: 22, column: 2 },
          },
        },
        {
          id: '3',
          mutatorName: 'ArithmeticOperator',
          status: 'NoCoverage',
          location: {
            start: { line: 30, column: 1 },
            end: { line: 30, column: 5 },
          },
        },
      ],
    },
    'src/untouched.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '4',
          mutatorName: 'EqualityOperator',
          status: 'Survived',
          location: {
            start: { line: 5, column: 1 },
            end: { line: 5, column: 8 },
          },
        },
      ],
    },
  },
});

describe('parseStrykerJson', () => {
  it('emits one violation per Survived mutant in a changed file', () => {
    // No packageId argument: the exact-object match below asserts the
    // emitted violation carries no `package` key.
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toContainEqual({
      ruleId: 'stryker/survived',
      file: 'src/changed.ts',
      line: 12,
      message:
        'ConditionalExpression mutant survived — a test executes this line but does not assert its behavior',
      severity: 'error',
      fixable: false,
      tool: 'stryker',
    });
  });

  it('ignores Killed, NoCoverage, and survivors in unchanged files', () => {
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toHaveLength(1);
    expect(result.map((v) => v.line)).toEqual([12]);
  });

  it('adds the package id when given', () => {
    const result = parseStrykerJson(
      report,
      ['src/changed.ts'],
      'guardrails-core',
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        package: 'guardrails-core',
        ruleId: 'stryker/survived',
      }),
    );
  });

  it('returns [] on malformed or wrong-shaped JSON', () => {
    expect(parseStrykerJson('not json', ['src/changed.ts'])).toEqual([]);
    expect(parseStrykerJson('{"files":"nope"}', ['src/changed.ts'])).toEqual(
      [],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stryker-adapter`
Expected: FAIL — `Cannot find module '.../stryker-adapter.js'`.

- [ ] **Step 3: Write the adapter**

Create `guardrails-core/src/verify/stryker-adapter.ts`:

```ts
/**
 * stryker adapter: maps a `mutation-testing-elements` report into `Violation[]`.
 *
 * Emits one violation per **Survived** mutant whose file is in the changed-file
 * set — a surviving mutant in changed code means a test executes the line but
 * doesn't assert its behavior. `Killed`/`Timeout` are good; `NoCoverage` is left
 * to the coverage gate; `Ignored`/`Pending`/`CompileError`/`RuntimeError` are
 * non-signal. Every violation is `fixable: false`: the fix is a judgment
 * (strengthen a test, or exclude an equivalent mutant), never a silent autofix.
 * Stryker emits repo-relative paths already, matching the git-diff file list.
 */

import type { Violation } from '../violation.js';

interface StrykerMutant {
  status: string;
  mutatorName: string;
  location: { start: { line: number } };
}

interface StrykerFile {
  mutants: StrykerMutant[];
}

function isMutant(value: unknown): value is StrykerMutant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const mutant = value as Record<string, unknown>;
  const start = (mutant.location as { start?: { line?: unknown } } | undefined)
    ?.start;
  return (
    typeof mutant.status === 'string' &&
    typeof mutant.mutatorName === 'string' &&
    typeof start?.line === 'number'
  );
}

function isReport(
  value: unknown,
): value is { files: Record<string, StrykerFile> } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const files = (value as { files?: unknown }).files;
  if (typeof files !== 'object' || files === null) {
    return false;
  }
  return Object.values(files).every(
    (file) =>
      typeof file === 'object' &&
      file !== null &&
      Array.isArray((file as StrykerFile).mutants) &&
      (file as StrykerFile).mutants.every((mutant) => isMutant(mutant)),
  );
}

function survivorViolation(
  file: string,
  mutant: StrykerMutant,
  packageId?: string,
): Violation {
  return {
    ruleId: 'stryker/survived',
    file,
    line: mutant.location.start.line,
    message: `${mutant.mutatorName} mutant survived — a test executes this line but does not assert its behavior`,
    severity: 'error',
    fixable: false,
    tool: 'stryker',
    ...(packageId === undefined ? {} : { package: packageId }),
  };
}

export function parseStrykerJson(
  reportJson: string,
  changedFiles: readonly string[],
  packageId?: string,
): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return [];
  }
  if (!isReport(parsed)) {
    return [];
  }
  const changed = new Set(changedFiles);
  const violations: Violation[] = [];
  for (const [file, fileResult] of Object.entries(parsed.files)) {
    if (!changed.has(file)) {
      continue;
    }
    for (const mutant of fileResult.mutants) {
      if (mutant.status === 'Survived') {
        violations.push(survivorViolation(file, mutant, packageId));
      }
    }
  }
  return violations;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- stryker-adapter`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + lint the new file**

Run: `npm run typecheck && npx eslint guardrails-core/src/verify/stryker-adapter.ts guardrails-core/test/verify/stryker-adapter.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/verify/stryker-adapter.ts guardrails-core/test/verify/stryker-adapter.test.ts
git commit -m "feat(verify): parseStrykerJson — survived mutants in changed files -> Violation[]"
```

**Correction (found while executing):** the first test originally passed an explicit
`undefined` third argument, which trips `sonarjs/no-undefined-argument` ("Remove this
redundant 'undefined'"). The repo's `unicorn/no-useless-undefined` is configured with
`checkArguments: false`, but **sonarjs enforces the same thing independently** — a config
relaxation on one plugin does not imply the other. Fixed by omitting the argument (the
exact-object `toContainEqual` already asserts no `package` key is emitted). Third instance
of the recorded "validate plan code against the repo's own linter before committing to it"
lesson; the code block above has been corrected in place.

---

### Task 3: `isTestFile` helper (filter tests out of the mutate set)

**Files:**

- Modify: `guardrails-core/src/verify/git.ts`
- Test: `guardrails-core/test/verify/git.test.ts`

**Interfaces:**

- Produces: `isTestFile(file: string): boolean` — `true` for `*.test.ts(x)` / `*.spec.ts(x)`.

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/verify/git.test.ts` (add `isTestFile` to the existing import from `'../../src/verify/git.js'`):

```ts
describe('isTestFile', () => {
  it('flags test and spec files, not production sources', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.tsx')).toBe(true);
    expect(isTestFile('test/bar.test.ts')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
    expect(isTestFile('src/testing.ts')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- git.test`
Expected: FAIL — `isTestFile is not a function` / import error.

- [ ] **Step 3: Add the helper**

Append to `guardrails-core/src/verify/git.ts`:

```ts
export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- git.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/verify/git.ts guardrails-core/test/verify/git.test.ts
git commit -m "feat(verify): isTestFile helper — excludes tests from the mutate set"
```

---

### Task 4: Graduate the `ANALYZERS` table to a `scope` policy

**Files:**

- Modify: `guardrails-core/src/verify/index.ts`
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: `runKnip`, `runDepcruise` (existing); `parseEslintJson`, `parseTscOutput` (existing).
- Produces: `Analyzer` interface with `scope: 'whole-project' | 'changed-files'` and `run(options, resolveBin, files)`; `runEslint`/`runTsc` split out of `runEslintAndTsc`; `runVerify` as one uniform loop. **Behavior-preserving** — the existing orchestrator tests are the regression net.

- [ ] **Step 1: Write the failing regression/scope test**

Append to `guardrails-core/test/verify/orchestrator.test.ts`:

```ts
describe('runVerify scope policy', () => {
  it('skips changed-files analyzers (eslint/tsc) when no .ts changed, runs whole-project (knip) at commit', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'README.md\n',
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
      exec,
      profile: 'commit',
    });
    const ran = (tool: string) =>
      calls.some((c) => c.command === tool || c.args.includes(tool));
    expect(ran('eslint')).toBe(false);
    expect(ran('tsc')).toBe(false);
    expect(ran('knip')).toBe(true); // whole-project runs even with no .ts changed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrator`
Expected: this specific assertion may already pass under the current code (knip runs at commit; eslint/tsc skip when no `.ts` changed). That's fine — it's a regression guard. The refactor in Step 3 is required regardless, because Task 5 registers stryker as a `scope`-carrying `ANALYZERS` entry that the current combined `runEslintAndTsc` special-case cannot express.

- [ ] **Step 3: Refactor `runVerify` — split runners and add `scope`**

In `guardrails-core/src/verify/index.ts`: replace `runEslintAndTsc` with two functions and update the `Analyzer` interface + `ANALYZERS` + `runVerify`.

Replace the `runEslintAndTsc` function with:

```ts
async function runEslint(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const eslint = await exec(
    resolveBin('eslint'),
    ['--format', 'json', '--no-warn-ignored', ...files],
    { cwd: repoRoot },
  );
  return parseEslintJson(eslint.stdout, repoRoot, packageId);
}

async function runTsc(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot, packageId } = options;
  const tsconfig = options.tsconfig ?? 'tsconfig.json';
  const tsc = await exec(
    resolveBin('tsc'),
    ['--noEmit', '--pretty', 'false', '-p', tsconfig],
    { cwd: repoRoot },
  );
  return parseTscOutput(tsc.stdout, repoRoot, packageId);
}
```

Replace the `Analyzer` interface and `ANALYZERS` with:

```ts
type Scope = 'whole-project' | 'changed-files';

interface Analyzer {
  tool: string;
  minRung: Rung;
  /** Run-trigger: 'changed-files' runs only when the turn changed >=1 TS file
   *  (and receives the list); 'whole-project' runs whenever the rung is active. */
  scope: Scope;
  run: (
    options: VerifyOptions,
    resolveBin: (tool: string) => string,
    files: string[],
  ) => Promise<Violation[]>;
}

const ANALYZERS: Analyzer[] = [
  { tool: 'eslint', minRung: 'stop', scope: 'changed-files', run: runEslint },
  { tool: 'tsc', minRung: 'stop', scope: 'changed-files', run: runTsc },
  { tool: 'knip', minRung: 'commit', scope: 'whole-project', run: runKnip },
  {
    tool: 'dependency-cruiser',
    minRung: 'commit',
    scope: 'whole-project',
    run: runDepcruise,
  },
];
```

Replace `runVerify` with:

```ts
export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const files = await changedTypeScriptFiles(options);
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  const profile = options.profile ?? 'stop';

  const violations: Violation[] = [];
  for (const analyzer of ANALYZERS) {
    if (RUNG_ORDER[profile] < RUNG_ORDER[analyzer.minRung]) {
      continue;
    }
    if (analyzer.scope === 'changed-files' && files.length === 0) {
      continue;
    }
    violations.push(...(await analyzer.run(options, resolveBin, files)));
  }
  return { violations };
}
```

Update the module header comment: ESLint **and** stryker are diff-scoped; tsc is changed-files-_triggered_ but checks the whole project; knip/DC are whole-project. (Remove the "ESLint/tsc stay the special case" wording.)

- [ ] **Step 4: Run the full verify suite**

Run: `npm test -- verify`
Expected: PASS — all existing orchestrator/adapter tests plus the new scope test. If an existing test asserted `runEslintAndTsc`-specific ordering, adjust it to the loop order (eslint, tsc, knip, dependency-cruiser).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/test/verify/orchestrator.test.ts
git commit -m "refactor(verify): graduate ANALYZERS to a scope policy; fold eslint/tsc into the table"
```

**Correction (found while executing):** the plan wrapped the narrower runners as
`run: (o, r) => runTsc(o, r)` to fit the three-parameter `Analyzer.run` signature. That is
both unnecessary and unlintable here — TypeScript already accepts a function with _fewer_
parameters where more are expected, and the single-letter parameters `o`/`r` trip
`unicorn/prevent-abbreviations` (its allowlist is `args, env, fn, img, params, props, ref,
src, str`). Registered the functions directly instead (`run: runTsc`); `npm run typecheck`
and `npm run lint` both pass, confirming the wrappers bought nothing. The code block above
is corrected in place.

---

### Task 5: `runStryker` + readFile seam + register the analyzer

**Files:**

- Modify: `guardrails-core/src/verify/index.ts`
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: `parseStrykerJson` (Task 2), `isTestFile` + `isTypeScriptFile` (Task 3 / existing), `Analyzer`/`ANALYZERS` (Task 4).
- Produces: `runStryker(options, resolveBin, files)`; a new optional `VerifyOptions.readFile?: (path: string) => Promise<string>` seam (defaults to `node:fs/promises` readFile); a `{ tool: 'stryker', minRung: 'commit', scope: 'changed-files', run: runStryker }` entry.

- [ ] **Step 1: Write the failing test (argv + integration)**

Append to `guardrails-core/test/verify/orchestrator.test.ts`:

```ts
describe('runStryker', () => {
  const strykerReport = JSON.stringify({
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: {
      'guardrails-core/src/foo.ts': {
        language: 'typescript',
        source: '',
        mutants: [
          {
            id: '1',
            mutatorName: 'ConditionalExpression',
            status: 'Survived',
            location: {
              start: { line: 7, column: 1 },
              end: { line: 7, column: 4 },
            },
          },
        ],
      },
    },
  });

  it('mutates changed production files, is consumer-generic, and maps survivors', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout:
          'guardrails-core/src/foo.ts\nguardrails-core/test/foo.test.ts\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      resolveBin: (tool) => tool,
      readFile: () => Promise.resolve(strykerReport),
    });

    const strykerCall = calls.find((c) => c.command === 'stryker');
    expect(strykerCall).toBeDefined();
    const args = strykerCall?.args ?? [];
    // diff-scoped to the production file, test file excluded
    expect(args).toContain('--mutate');
    expect(args).toContain('guardrails-core/src/foo.ts');
    expect(args.join(' ')).not.toContain('foo.test.ts');
    // incremental + machine-readable json
    expect(args).toContain('--incremental');
    expect(args).toContain('--reporters');
    // consumer-generic: no config flag, no absolute/repo-specific path
    expect(args).not.toContain('--configFile');
    expect(args.every((argument) => !argument.startsWith('/'))).toBe(true);
    // survivor mapped
    expect(violations).toContainEqual(
      expect.objectContaining({
        ruleId: 'stryker/survived',
        file: 'guardrails-core/src/foo.ts',
        line: 7,
      }),
    );
  });

  it('returns no stryker violations when only test files changed', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'guardrails-core/test/foo.test.ts\n',
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
      exec,
      profile: 'commit',
      readFile: () => Promise.resolve('{}'),
    });
    expect(calls.some((c) => c.command === 'stryker')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrator`
Expected: FAIL — no `stryker` call recorded / `readFile` not on options.

- [ ] **Step 3: Add the readFile seam, `runStryker`, and the ANALYZERS entry**

In `guardrails-core/src/verify/index.ts`:

Add imports at the top:

```ts
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { isTestFile, isTypeScriptFile, mergeChangedFiles } from './git.js';
import { parseStrykerJson } from './stryker-adapter.js';
```

(Merge the `./git.js` import with the existing one — do not duplicate.)

Add the `readFile` seam to `VerifyOptions`:

```ts
  /** File reader seam (stryker writes its JSON report to disk, not stdout).
   *  Defaults to node:fs/promises readFile; injected in tests. */
  readFile?: (filePath: string) => Promise<string>;
```

Add the runner (mirrors `runKnip`'s consumer-generic shape — no `--configFile`, stryker auto-detects the consumer's `stryker.conf.json`):

```ts
/** stryker is diff-scoped (changed production files) and CI/commit-only (mutation
 *  testing reruns the suite per mutant). Consumer-generic: no `--configFile` (stryker
 *  auto-detects the consumer's stryker.conf.json), the `--mutate` list is the
 *  consumer's own changed files. Forces `--reporters json` and reads stryker's default
 *  report path (reports/mutation/mutation.json). A missing/failed report yields [] —
 *  a stryker crash must not falsely block the gate. */
async function runStryker(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const production = files.filter(
    (file) => isTypeScriptFile(file) && !isTestFile(file),
  );
  if (production.length === 0) {
    return [];
  }
  const { exec, repoRoot, packageId } = options;
  const readFile =
    options.readFile ?? ((filePath) => fsReadFile(filePath, 'utf8'));

  await exec(
    resolveBin('stryker'),
    [
      'run',
      '--incremental',
      '--reporters',
      'json',
      '--mutate',
      production.join(','),
    ],
    { cwd: repoRoot },
  );

  let report: string;
  try {
    report = await readFile(
      path.join(repoRoot, 'reports', 'mutation', 'mutation.json'),
    );
  } catch {
    return [];
  }
  return parseStrykerJson(report, production, packageId);
}
```

Add the entry to `ANALYZERS` (after dependency-cruiser):

```ts
  { tool: 'stryker', minRung: 'commit', scope: 'changed-files', run: runStryker },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orchestrator`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `npm test && npm run typecheck && npx eslint guardrails-core/src/verify/index.ts`
Expected: all pass; no lint errors (watch `runStryker` cognitive-complexity — if it trips, extract the exec-args array into a `const`).

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/test/verify/orchestrator.test.ts
git commit -m "feat(verify): runStryker — diff-scoped, incremental, consumer-generic mutation analyzer"
```

**Correction (found while executing):** the callback parameter must be spelled
`argument` — `unicorn/prevent-abbreviations` allowlists `args` (plural) but **not** `arg`,
so the obvious shortening fails lint. Code block corrected in place.

---

### Task 6: Drift probe #4 — the `MutantStatus` enum

**Files:**

- Modify: `guardrails-core/test/drift/registry.test.ts`

**Interfaces:**

- Consumes: `checkDrift`, `DriftEntry` (existing). Produces: a fourth `DriftEntry` whose probe reads the `MutantStatus` enum from the schema package's public subpath.

- [ ] **Step 1: Write the probe + entry (failing until knownIds match)**

In `guardrails-core/test/drift/registry.test.ts`, add near the other probes:

```ts
/**
 * stryker probe: the MutantStatus enum the stryker adapter classifies on
 * (stryker-adapter.ts keys on `status`, emitting only on 'Survived' and treating
 * 'Killed'/'Timeout'/'NoCoverage' as non-violations). The enum is upstream-owned
 * and read from the schema package's PUBLIC subpath export — no fixture, no
 * internal-file bypass. `mutatorName` is free-form (not an enum) so it's not a probe target.
 */
async function strykerStatuses(): Promise<Set<string>> {
  const schemaPath = createRequire(import.meta.url).resolve(
    'mutation-testing-report-schema/mutation-testing-report-schema.json',
  );
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as unknown;
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const en = (node as { enum?: unknown }).enum;
    if (Array.isArray(en) && en.includes('Survived')) {
      for (const value of en) {
        if (typeof value === 'string') {
          found.add(value);
        }
      }
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  walk(schema);
  return found;
}
```

Add the imports at the top (merge with existing):

```ts
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
```

Add the fourth entry to the `entries` array:

```ts
  {
    tool: 'stryker',
    // Statuses the stryker adapter classifies on (guardrails-core/src/verify/stryker-adapter.ts).
    knownIds: ['Survived', 'Killed', 'Timeout', 'NoCoverage'],
    probe: strykerStatuses,
    hint: 'stryker/mutation-testing-report-schema renamed/removed a MutantStatus — reconcile guardrails-core/src/verify/stryker-adapter.ts',
  },
```

- [ ] **Step 2: Run the drift suite**

Run: `npm test -- drift`
Expected: PASS — the four asserted statuses exist in the installed schema (verified this session: enum is `Killed | Survived | NoCoverage | CompileError | RuntimeError | Timeout | Ignored | Pending`).

- [ ] **Step 3: Remove the Task-1 knip + fallow stopgaps and confirm both see the real import**

Task 1 added a temporary `ignoreDependencies: ["mutation-testing-report-schema"]` to the `guardrails-core` workspace in `knip.json` (the package was unused until this task's probe imports it via `require.resolve`, and the pre-commit gate runs whole-project knip). Now that the probe imports it, **remove that workspace-level `ignoreDependencies` entry** (and its stopgap comment) from `knip.json`, then run `npx knip` and confirm it stays clean (0 issues) — proving knip detects the `require.resolve('mutation-testing-report-schema/...')` usage. If (and only if) knip still flags the package as unused, restore the entry with a comment explaining knip cannot see the `require.resolve` import, per the spec's "prefer confirming the import over ignoring" guidance. Do **not** touch the root-level `ignoreDependencies` for the `@stryker-mutator/*` binaries — those are a permanent, correct ignore (CLI-invoked via resolveBin).

`.fallowrc.jsonc` carries the **same stopgap** for `mutation-testing-report-schema` (added after Task 1's push was blocked — see the Task-1 correction below). Remove it there too, then run `npm run test:coverage && npm run check:graph` and confirm fallow stays clean. Do **not** remove fallow's `@stryker-mutator/vitest-runner` entry — that plugin is loaded by name from stryker's config and is never imported, so it is a permanent ignore.

- [ ] **Step 4: Typecheck + lint the test file**

Run: `npm run typecheck && npx eslint guardrails-core/test/drift/registry.test.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/test/drift/registry.test.ts knip.json .fallowrc.jsonc
git commit -m "test(drift): fourth probe — guard the stryker MutantStatus enum via the public schema subpath"
```

---

### Task 7: Dogfood config — `stryker.conf.json`, audit.ts exclusion, knip reconcile, real gate

**Files:**

- Create: `stryker.conf.json` (repo root)
- Modify: `guardrails-core/src/audit.ts` (in-source `// Stryker disable`)
- Modify: `knip.json` (if knip flags the CLI-only stryker deps)

**Interfaces:** none (config + dogfood wiring).

- [ ] **Step 1: Author this repo's stryker config**

Create `stryker.conf.json`:

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "testRunner": "vitest",
  "reporters": ["json"],
  "incremental": true,
  "mutate": [
    "guardrails-core/src/**/*.ts",
    "!guardrails-core/src/**/*.test.ts"
  ],
  "mutator": {
    "excludedMutations": ["StringLiteral"]
  }
}
```

Rationale (record in the file is unnecessary; the spec §7 carries it): `excludedMutations: ['StringLiteral']` removes the brittle "assert exact message text" pressure (the biggest noise source, −44% on gate.ts); it lives in the consumer's own config so it's trivially overridable. `mutate` here scopes _manual_ whole-repo runs; the gate's per-turn run overrides `mutate` via CLI (Task 5).

- [ ] **Step 2: Exclude the audit.ts lexer region in-source**

In `guardrails-core/src/audit.ts`, wrap the hand-written tokenizer helpers (the block spanning `isQuoteChar` through `skipRegexFlags` — verify the exact bounds in the file) with stryker disable/restore directives. Place immediately before the first lexer helper:

```ts
/* Stryker disable all — hand-written tokenizer: mutation-dense in boundary/equivalent
   mutants with poor defect-catching ROI; its behavioral suppression-detection tests are
   the real coverage. See docs/superpowers/specs/2026-07-23-phase-c-stryker-design.md §7. */
```

and immediately after the last lexer helper:

```ts
/* Stryker restore all */
```

Keep the higher-level diff-parsing logic (`parseDiff`, hunk handling) **outside** the disabled block so it stays mutated.

- [ ] **Step 3: Verify the exclusion + diff-scoping work end-to-end**

Run a real, scoped stryker run against a non-lexer audit.ts function to confirm the config loads and the lexer is excluded:

```bash
npx stryker run --mutate 'guardrails-core/src/audit.ts' --reporters json,clear-text 2>&1 | tail -20
```

Expected: completes; the clear-text table shows audit.ts mutated with the lexer lines reported as `Ignored` (not Survived/Killed). Clean up: `rm -rf reports .stryker-tmp`.

- [ ] **Step 4: Run the real whole-graph gate and reconcile**

Run: `npm run typecheck && npm test && npm run lint`
Then the whole-graph checks (these surface knip/fallow issues that per-file checks miss — the piece-1 lesson):

```bash
npm run test:coverage && npm run check:graph
npx knip
```

Expected: green. **If knip flags `@stryker-mutator/core` / `@stryker-mutator/vitest-runner` as unused dependencies** (they're invoked via `resolveBin`, not imported), add to `knip.json` at the top level:

```json
"ignoreDependencies": ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"]
```

with a comment that they're runtime-invoked binaries. Re-run `npx knip` until clean. (Do **not** ignore `mutation-testing-report-schema` — it's imported by the drift probe; if knip can't see the `require.resolve` usage, prefer confirming the import over ignoring.)

- [ ] **Step 5: Commit**

```bash
git add stryker.conf.json guardrails-core/src/audit.ts knip.json
git commit -m "chore(dogfood): stryker.conf.json + audit.ts lexer mutation-exclusion; knip reconcile"
```

---

### Task 8: Record findings + status in plan.md

**Files:**

- Modify: `plan.md` (Phase C status section)

- [ ] **Step 1: Add the piece-4 status + findings**

In `plan.md`, under "Phase C status", add a "Piece 4 — stryker (shipped)" entry and a "Phase C piece 4 — execution findings" subsection capturing, each as a bullet:

- **Registry graduation resolved** — the twice-deferred `ANALYZERS` abstraction now models `scope` (run-trigger); ESLint/tsc folded into the table.
- **`// Stryker disable` is in-source checker-weakening**, and `audit.ts` _is_ the suppression-detector → the diff-auditor should likely watch `// Stryker disable` as a suppression signature (Roadmap: fixer-loop hardening / audit suppression list).
- **Mutation testing is low-ROI on hand-written parsers** (audit.ts: mutator-exclusion only cut it 31%; the residue is control-flow mutators you can't drop) — pack curation guidance: exclude mutation-hostile regions deliberately, in-source.
- **Whole-repo absolute mutation thresholds are arbitrary**; diff-scoped zero-tolerance is the principled, in-work-cycle model.
- **CLI `--mutate` replaces config `mutate`** (and config range-negation is fragile) — region exclusion must be in-source disable directives, which compose with `--mutate` and are edit-robust. Verified stryker 9.6.1.
- Any knip/fallow reconciliation actually needed in Task 7 (record what, so the next analyzer expects it).

- [ ] **Step 2: Commit**

```bash
git add plan.md
git commit -m "docs(plan): Phase C piece 4 shipped — stryker diff-scoped mutation gate + findings"
```

---

## Self-Review notes (for the executor)

- **Live-loop verification:** editing the gate/analyzers doesn't take effect in a running session (hooks load at start) and stryker now runs at the **commit** rung — after this lands, start a fresh session and exercise `docs/live-loop-verification.md` at the commit rung to confirm a real survivor in changed code blocks and routes to the thorough fixer.
- **Branch/worktree:** this worktree is named `phase-c-semgrep` (piece 3). Confirm with the maintainer whether piece 4 lands here or on a fresh `phase-c-stryker` branch/worktree before executing.
- **Do not** commit `reports/` or `.stryker-tmp/` (gitignored in Task 1); if a manual run leaves them, they should stay untracked.
