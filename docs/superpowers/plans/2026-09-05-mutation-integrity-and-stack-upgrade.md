# Mutation-gate integrity and stack upgrade — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mutation gate report honestly on any Stryker/Vitest combination, move this repo onto the current toolchain so dogfooding covers what consumers install, and close four scaffold findings from the fourth greenfield adoption.

**Architecture:** A report-level invariant in the stryker adapter (a `Survived` verdict with covering tests but zero test executions is a broken run, not a finding) replaces false survivors with one honest `analyzer-failed`. A live drift guard runs real Stryker through the vitest runner over known-killable code, so a future version bump that breaks the runner fails the build instead of silently inverting the gate. The toolchain then moves to current majors, with `vitest` pinned to `^4` behind that guard, and TypeScript reaching 6 by replacing tsup's dts step with `tsc --emitDeclarationOnly`.

**Tech Stack:** TypeScript (strict), Vitest, tsup, StrykerJS, ESLint flat config, knip, dependency-cruiser.

**Spec:** `docs/superpowers/specs/2026-09-05-mutation-integrity-and-stack-upgrade-design.md`

## Global Constraints

- **TDD, always.** No production code without a failing test first. This is
  non-negotiable in `CLAUDE.md`.
- **Never weaken a rule to pass a gate.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, no deleting code to quiet a checker, no raising thresholds.
- **Never add a `sanctionedSuppressions` entry on your own initiative.** Ask the
  developer, with what it covers / why it is unavoidable / what stops being
  checked.
- **`.claude/agents/` and `.github/agents/` are generated.** Edit
  `guardrails-plugin/agents/` and run `npm run build`. `.github/agents/` is
  committed; `.claude/agents/` is gitignored.
- **`vitest` and `@vitest/coverage-istanbul` stay on `^4`.** Vitest 5 breaks
  `@stryker-mutator/vitest-runner` — stryker-js#6210, tracked locally as issue
  **#35**.
- **TypeScript ceiling is `<6.1.0`**, set by `typescript-eslint@8`'s peer range.
  TypeScript 7 is out of scope.
- **`eslint-plugin-unicorn@74` requires `eslint >= 10.4`** — the two move together.
- Commit in small, logical steps. The pre-push gate is
  `npm run test:coverage && npm run check:graph`.

---

### Task 1: The zero-test-run invariant in the stryker adapter

A `Survived` verdict is only sound if a covering test actually executed. On
Vitest 5 the runner's per-test filter matches nothing, so every mutant run
executes zero tests and every covered mutant is reported `Survived`. This task
teaches the adapter to recognise that shape.

**Files:**

- Modify: `guardrails-core/src/verify/stryker-adapter.ts`
- Test: `guardrails-core/test/verify/stryker-adapter.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `export function unrunSurvivedMutants(reportJson: string, changedFiles: readonly string[]): number` — the count of mutants in the changed set reported `Survived` with a non-empty `coveredBy` and `testsCompleted === 0`. Task 2 calls it from `runStryker`.

- [ ] **Step 1: Write the failing tests**

Append to `guardrails-core/test/verify/stryker-adapter.test.ts`. Note the
import line at the top of that file needs `unrunSurvivedMutants` added to it.

```ts
describe('unrunSurvivedMutants', () => {
  function report(mutants: unknown[]): string {
    return JSON.stringify({ files: { 'src/a.ts': { mutants } } });
  }
  const at = (line: number) => ({ start: { line } });

  it('counts a Survived mutant whose covering tests never ran', () => {
    const json = report([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0', '1'],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(1);
  });

  it('does not count a genuine survivor, whose covering test did run', () => {
    const json = report([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0'],
        testsCompleted: 1,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('does not count NoCoverage, which legitimately runs no tests', () => {
    const json = report([
      {
        status: 'NoCoverage',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: [],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('does not count a Survived mutant with no covering tests at all', () => {
    const json = report([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: [],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('does not count a mutant from a file outside the changed set', () => {
    const json = JSON.stringify({
      files: {
        'src/other.ts': {
          mutants: [
            {
              status: 'Survived',
              mutatorName: 'EqualityOperator',
              location: at(1),
              coveredBy: ['0'],
              testsCompleted: 0,
            },
          ],
        },
      },
    });
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('treats a missing testsCompleted as unrun, failing closed', () => {
    const json = report([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0'],
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(1);
  });

  it('answers 0 for a payload that is not a report', () => {
    expect(unrunSurvivedMutants('not json', ['src/a.ts'])).toBe(0);
  });

  it('counts every affected mutant, so the message can say how many', () => {
    const json = report([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0'],
        testsCompleted: 0,
      },
      {
        status: 'Survived',
        mutatorName: 'ConditionalExpression',
        location: at(2),
        coveredBy: ['0'],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run guardrails-core/test/verify/stryker-adapter.test.ts`
Expected: FAIL — `unrunSurvivedMutants is not a function` / no matching export.

- [ ] **Step 3: Implement**

In `guardrails-core/src/verify/stryker-adapter.ts`, widen the mutant interface
with the two optional fields, then add the exported function. Both fields are
optional because `isMutant` must keep accepting reports that omit them — older
Stryker versions and the `NoCoverage` path do.

```ts
interface StrykerMutant {
  status: string;
  mutatorName: string;
  location: { start: { line: number } };
  /** Test ids Stryker determined cover this mutant. Absent in reports from
   *  runners that provide no per-test data. */
  coveredBy?: string[];
  /** How many tests actually EXECUTED during this mutant's run. The field that
   *  separates "the tests ran and none failed" from "no test ran at all". */
  testsCompleted?: number;
}
```

Add below `parseStrykerJson`:

```ts
/**
 * How many mutants in the changed set were reported `Survived` without a single
 * covering test having run?
 *
 * A `Survived` verdict means "every covering test executed and none failed". If
 * `coveredBy` is non-empty and `testsCompleted` is zero, the second half never
 * happened: the runner returned an unexamined default, and the verdict is not
 * evidence of anything. `@stryker-mutator/vitest-runner` does exactly this on
 * Vitest 5 (stryker-js#6210 — the per-test name filter stopped matching, so
 * every mutant run executes nothing), and has three more open bugs in the same
 * family. Upstream proposes the same invariant for itself in #6146.
 *
 * `NoCoverage` is deliberately excluded: running no tests is what that status
 * MEANS, and it is reported on its own merits by `parseStrykerJson`.
 *
 * A missing `testsCompleted` counts as unrun. Every runner that reports a
 * `Survived` mutant it actually exercised emits the field; treating its absence
 * as "probably fine" would fail open on precisely the malformed report this
 * guard exists to catch.
 */
export function unrunSurvivedMutants(
  reportJson: string,
  changedFiles: readonly string[],
): number {
  let parsed: unknown;
  // Equivalent mutants: emptying either block leaves `parsed` undefined, which
  // `isReport` rejects below — the function still returns 0.
  // Stryker disable BlockStatement
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return 0;
  }
  // Stryker restore BlockStatement
  if (!isReport(parsed)) {
    return 0;
  }
  const changed = new Set(changedFiles);
  let count = 0;
  for (const [file, fileResult] of Object.entries(parsed.files)) {
    if (!changed.has(file)) {
      continue;
    }
    for (const mutant of fileResult.mutants) {
      if (
        mutant.status === 'Survived' &&
        (mutant.coveredBy?.length ?? 0) > 0 &&
        (mutant.testsCompleted ?? 0) === 0
      ) {
        count += 1;
      }
    }
  }
  return count;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run guardrails-core/test/verify/stryker-adapter.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/verify/stryker-adapter.ts guardrails-core/test/verify/stryker-adapter.test.ts
git commit -m "feat(verify): recognise a mutant verdict no test ever produced"
```

---

### Task 2: Wire the invariant into `runStryker`

**Files:**

- Modify: `guardrails-core/src/verify/index.ts` (the `runStryker` outcome table, and a new violation helper next to `strykerReportMissingViolation`)
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: `unrunSurvivedMutants` from Task 1.
- Produces: nothing later tasks import; behaviour only.

- [ ] **Step 1: Write the failing tests**

Add to `guardrails-core/test/verify/orchestrator.test.ts`. Follow the file's
existing `runVerify` harness — an injected `exec`, `readFile`, `removeFile`, and
`declaredProviders` containing `@stryker-mutator/core`. Match the surrounding
tests' setup helper rather than inventing a new one.

```ts
it('reports one analyzer-failed, not survivors, when no test ran', async () => {
  const report = JSON.stringify({
    files: {
      'src/a.ts': {
        mutants: [
          {
            status: 'Survived',
            mutatorName: 'EqualityOperator',
            location: { start: { line: 1 } },
            coveredBy: ['0'],
            testsCompleted: 0,
          },
          {
            status: 'Survived',
            mutatorName: 'ConditionalExpression',
            location: { start: { line: 2 } },
            coveredBy: ['0'],
            testsCompleted: 0,
          },
        ],
      },
    },
  });
  const result = await runVerifyWithStrykerReport(report, ['src/a.ts']);
  const stryker = result.violations.filter((v) =>
    v.ruleId.startsWith('stryker/'),
  );
  const failed = result.violations.filter(
    (v) => v.ruleId === 'guardrails/analyzer-failed',
  );
  expect(stryker).toHaveLength(0);
  expect(failed).toHaveLength(1);
  expect(failed[0]?.message).toContain('2');
  expect(failed[0]?.severity).toBe('error');
});

it('still reports genuine survivors, which did run their tests', async () => {
  const report = JSON.stringify({
    files: {
      'src/a.ts': {
        mutants: [
          {
            status: 'Survived',
            mutatorName: 'EqualityOperator',
            location: { start: { line: 1 } },
            coveredBy: ['0'],
            testsCompleted: 1,
          },
        ],
      },
    },
  });
  const result = await runVerifyWithStrykerReport(report, ['src/a.ts']);
  expect(
    result.violations.filter((v) => v.ruleId === 'stryker/survived'),
  ).toHaveLength(1);
  expect(
    result.violations.filter((v) => v.ruleId === 'guardrails/analyzer-failed'),
  ).toHaveLength(0);
});
```

If no `runVerifyWithStrykerReport` helper exists in that file, write one that
wraps the existing setup used by the neighbouring stryker tests; do not
duplicate the whole harness inline in each test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run guardrails-core/test/verify/orchestrator.test.ts`
Expected: FAIL — the first test sees 2 `stryker/survived` violations and 0 `analyzer-failed`.

- [ ] **Step 3: Implement**

Add the import to the existing `stryker-adapter.js` import in
`guardrails-core/src/verify/index.ts`:

```ts
import {
  isStrykerReportJson,
  parseStrykerJson,
  unrunSurvivedMutants,
} from './stryker-adapter.js';
```

Add the helper next to `strykerReportMissingViolation`:

```ts
/**
 * Stryker completed and wrote a report, but the verdicts in it are not
 * evidence: every one of these mutants was covered by tests that never
 * executed. Reported once for the run rather than once per mutant — the finding
 * is about the runner, and N copies of "your runner is broken" is the context
 * flood the terse-pointer design exists to prevent.
 */
function strykerUnrunMutantsViolation(count: number): Violation {
  return {
    ruleId: 'guardrails/analyzer-failed',
    file: 'package.json',
    message:
      `stryker reported ${count} mutant(s) as "survived" whose covering tests ` +
      `never ran (testsCompleted: 0), so those verdicts are not evidence of ` +
      `anything — treating the mutation check as failed, not clean. This is ` +
      `the signature of a broken test-runner integration, not of weak tests: ` +
      `@stryker-mutator/vitest-runner does it on vitest 5 (stryker-js#6210). ` +
      `Check that your testRunner and its plugin support your test framework's ` +
      `installed major version.`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}
```

In `runStryker`, replace outcome 1:

```ts
// Outcome 1: a parseable report means the run reached its reporter, so its
// findings are the answer no matter what the exit code was -- unless the
// verdicts in it were never actually produced by a test run.
if (isStrykerReportJson(report)) {
  const unrun = unrunSurvivedMutants(report, production);
  if (unrun > 0) {
    return [strykerUnrunMutantsViolation(unrun)];
  }
  return parseStrykerJson(report, production);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run guardrails-core/test/verify/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — no existing stryker test regressed.

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/test/verify/orchestrator.test.ts
git commit -m "fix(verify): fail the mutation gate when no test actually ran"
```

---

### Task 3: A live drift guard that proves mutation testing still detects anything

`test/drift/stryker-banner.test.ts` guards the one piece of Stryker text we
parse. Nothing guards the question that matters more — _does the runner still
kill a killable mutant_. That is the gap #6210 walked through, and it is the
only test that would have failed on a `vitest@5` bump.

**Files:**

- Create: `guardrails-core/test/drift/stryker-runner-fixture/src/tier.ts`
- Create: `guardrails-core/test/drift/stryker-runner-fixture/tier.test.ts`
- Create: `guardrails-core/test/drift/stryker-runner-fixture/stryker.conf.json`
- Create: `guardrails-core/test/drift/stryker-runner-fixture/vitest.config.ts`
- Create: `guardrails-core/test/drift/stryker-runner.test.ts`
- Modify: `guardrails-core/tsconfig.json` (add the fixture to `exclude`)
- Modify: `eslint.config.js`, `knip.json`, `.fallowrc.jsonc` (same exclusion — `tsconfig.json`'s comment says keep the four in sync)

**Interfaces:**

- Consumes: `parseStrykerJson` and `unrunSurvivedMutants` from Task 1, to assert through the same code path production uses.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the fixture**

`guardrails-core/test/drift/stryker-runner-fixture/src/tier.ts`:

```ts
export function tier(spend: number): string {
  if (spend >= 1000) {
    return 'gold';
  }
  if (spend >= 100) {
    return 'silver';
  }
  return 'bronze';
}
```

`guardrails-core/test/drift/stryker-runner-fixture/tier.test.ts` — assertions
strong enough that every mutant Stryker generates is genuinely killable:

```ts
import { describe, expect, it } from 'vitest';

import { tier } from './src/tier.js';

describe('tier', () => {
  it('pins every boundary', () => {
    expect(tier(1000)).toBe('gold');
    expect(tier(999)).toBe('silver');
    expect(tier(100)).toBe('silver');
    expect(tier(99)).toBe('bronze');
    expect(tier(0)).toBe('bronze');
  });
});
```

`guardrails-core/test/drift/stryker-runner-fixture/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['*.test.ts'], root: import.meta.dirname },
});
```

`guardrails-core/test/drift/stryker-runner-fixture/stryker.conf.json` —
`incremental` is deliberately absent, so the guard can never read a cached
verdict from an earlier run:

```json
{
  "testRunner": "vitest",
  "plugins": ["@stryker-mutator/vitest-runner"],
  "reporters": ["json"],
  "vitest": { "configFile": "vitest.config.ts" },
  "mutate": ["src/tier.ts"],
  "coverageAnalysis": "perTest"
}
```

- [ ] **Step 2: Write the failing test**

`guardrails-core/test/drift/stryker-runner.test.ts`:

```ts
/**
 * Drift guard for the mutation RUNNER, not for its output text.
 *
 * `stryker-banner.test.ts` proves we still read stryker's instrumenter banner
 * correctly. This one proves something the banner cannot: that the configured
 * test runner still KILLS a mutant a test genuinely catches.
 *
 * The failure this exists for is silent and inverted. On vitest 5,
 * `@stryker-mutator/vitest-runner`'s per-test filter matches nothing
 * (stryker-js#6210), so every mutant run executes zero tests and every covered
 * mutant comes back `Survived` — the mutation gate manufactures violations
 * instead of suppressing them, and no unit test in this repo notices, because
 * every one of them feeds the adapter a hand-written report.
 *
 * So this runs REAL stryker through the vitest runner — the one
 * `adopting-guardrails` tells consumers to use — over code whose tests kill
 * every mutant, and asserts we read kills back. It is the only test here that
 * would have failed on a `vitest@5` bump. It is deliberately slow.
 */

import { rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import {
  parseStrykerJson,
  unrunSurvivedMutants,
} from '../../src/verify/stryker-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixture = path.join(here, 'stryker-runner-fixture');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');
const reportPath = path.join(fixture, 'reports', 'mutation', 'mutation.json');

describe('stryker vitest-runner drift guard', () => {
  it('still kills a mutant the fixture tests genuinely catch', async () => {
    await rm(path.join(fixture, 'reports'), { recursive: true, force: true });
    await rm(path.join(fixture, '.stryker-tmp'), {
      recursive: true,
      force: true,
    });

    const result = await spawnExec(strykerBin, ['run'], { cwd: fixture });
    const report = await readFile(reportPath, 'utf8');

    // The invariant Task 1 added, asserted against a real runner: if this is
    // non-zero the runner ran no tests, whatever the verdicts claim.
    expect(unrunSurvivedMutants(report, ['src/tier.ts'])).toBe(0);

    // And the positive half: a runner that reports nothing at all would pass
    // the check above vacuously.
    const violations = parseStrykerJson(report, ['src/tier.ts']);
    expect(violations).toEqual([]);
    expect(result.code).toBe(0);
  }, 180_000);
});
```

- [ ] **Step 3: Add the fixture to the four exclusion lists**

`guardrails-core/tsconfig.json` — the existing comment says to keep four files
in sync; extend `exclude`:

```json
  "exclude": [
    "test/drift/knip-fixture/**",
    "test/drift/stryker-runner-fixture/**"
  ]
```

Apply the matching exclusion in `eslint.config.js`, `knip.json`, and
`.fallowrc.jsonc` alongside the existing `knip-fixture` entry in each. Read each
file first — the shape of the exclusion differs per tool.

Also confirm the fixture's generated output cannot dirty the repo: add
`guardrails-core/test/drift/stryker-runner-fixture/reports/` and
`.stryker-tmp/` coverage to `.gitignore` if the existing root patterns
(`reports/mutation/`, `.stryker-tmp/`) do not already match at that depth. They
are root-anchored in some forms — verify with
`git check-ignore -v guardrails-core/test/drift/stryker-runner-fixture/reports/mutation/mutation.json`.

- [ ] **Step 4: Run it to verify it passes on the CURRENT stack**

Run: `npx vitest run guardrails-core/test/drift/stryker-runner.test.ts`
Expected: PASS on vitest 4 (a few seconds to a minute).

- [ ] **Step 5: Prove the guard actually guards**

Temporarily install vitest 5 without saving, and confirm the guard fails:

```bash
npm i -D vitest@^5 --no-save
npx vitest run guardrails-core/test/drift/stryker-runner.test.ts
```

Expected: FAIL — `unrunSurvivedMutants` returns a non-zero count.
This is the whole point of the task; do not skip it.

Then restore:

```bash
npm install
npx vitest run guardrails-core/test/drift/stryker-runner.test.ts
```

Expected: PASS again.

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/test/drift/stryker-runner.test.ts guardrails-core/test/drift/stryker-runner-fixture guardrails-core/tsconfig.json eslint.config.js knip.json .fallowrc.jsonc .gitignore
git commit -m "test(drift): guard that the mutation runner still kills mutants"
```

---

### Task 4: The safe dependency majors

**Files:**

- Modify: `package.json`, `guardrails-core/package.json`, `package-lock.json`
- Modify: `guardrails-core/src/loose-rules.ts` (only if the review finds something)
- Modify: `guardrails-core/src/audit.ts` (only if the review finds something)
- Test: the existing suite, plus `guardrails-core/test/drift/registry.test.ts` (already mechanises the id-existence half)

**Interfaces:**

- Consumes: the drift guard from Task 3, which is what makes the stryker bump safe.
- Produces: nothing later tasks import.

- [ ] **Step 1: Run the suite and record the green baseline**

Run: `npm test && npm run lint`
Expected: PASS. You need this to tell an upgrade regression from a pre-existing one.

- [ ] **Step 2: Bump, in one command so npm resolves the peer graph once**

```bash
npm i -D eslint@^10.10.0 @eslint/js@^10.0.1 eslint-plugin-unicorn@^74.0.0 \
  eslint-plugin-sonarjs@^4.2.0 typescript-eslint@^8.69.0 knip@^6.34.0 \
  dependency-cruiser@^18.2.0 @stryker-mutator/core@^10.0.0 \
  @stryker-mutator/vitest-runner@^10.0.0
```

Do **not** include `vitest`, `@vitest/coverage-istanbul`, or `typescript` — the
first two are pinned by Global Constraints, the third is Task 5.

- [ ] **Step 3: Pin vitest with its reason in the file**

In `package.json`, leave the `vitest` and `@vitest/coverage-istanbul` ranges on
`^4` and add a `comments`-style note where this repo already keeps such notes —
if there is no such convention, record it in `CLAUDE.md`'s upgrade section
instead. The pin must be discoverable from the file that carries it:

> `vitest` stays on `^4`: vitest 5 breaks `@stryker-mutator/vitest-runner`
> (every covered mutant reported Survived — stryker-js#6210). Tracked in #35.
> `test/drift/stryker-runner.test.ts` is what fails if this is raised early.

- [ ] **Step 4: Run everything**

Run: `npm run build && npm test && npm run lint`
Expected: PASS. Fix real breakage in the code; **do not** silence a new lint
rule to get green — that is the prohibition in Global Constraints.

Note that `eslint-plugin-unicorn@74` is a large major jump from 56 and will
likely surface new findings. Each one is a real fix.

- [ ] **Step 5: Do the judgment half of the tool-upgrade review**

`CLAUDE.md` requires this and the drift-guard only mechanises id _existence_:

- `guardrails-core/src/loose-rules.ts` — did eslint 10, unicorn 74, or sonarjs
  4.2 add rules that belong in the loose class (test-integrity, architecture,
  mutation, dead-code — where a green fix is easily not a good one)? Add them
  with a test.
- `guardrails-core/src/audit.ts` — did any tool change the syntax of a
  suppression the auditor watches for (`eslint-disable`, `@ts-*`, `.skip`,
  `// Stryker disable`, `@SuppressWarnings`)?

Record the outcome of the review in the commit message even when it is "no
change needed" — the next upgrader needs to know it was done.

- [ ] **Step 6: Run the drift guards specifically**

Run: `npx vitest run guardrails-core/test/drift/`
Expected: PASS — including the new runner guard against stryker 10.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json guardrails-core/package.json
git commit -m "chore(deps): move to eslint 10, unicorn 74, stryker 10"
```

---

### Task 5: TypeScript 6, by replacing tsup's dts build

`typescript@~6.0` fails `npm run build` with `Error: error occurred in dts
build` from tsup 8.5.1 — already the latest release. Plain `tsc` handles TS 6
on this source tree (verified, exit 0).

**Files:**

- Create: `guardrails-core/tsconfig.build.json`
- Modify: `guardrails-core/tsup.config.ts`
- Modify: `guardrails-core/package.json` (the `build` script)
- Modify: `package.json` (the `typescript` range)
- Test: `guardrails-core/test/package-exports.test.ts` (already pins the published entry points)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `dist/index.d.ts` and `dist/cli.d.ts` continue to exist, now as one `.d.ts` per module rather than a bundle.

- [ ] **Step 1: Confirm the current failure, so the fix is anchored**

```bash
npm i -D typescript@~6.0 --no-save
npm run build
```

Expected: FAIL — `Error: error occurred in dts build`.

- [ ] **Step 2: Run the package-exports test to record the contract**

Run: `npx vitest run guardrails-core/test/package-exports.test.ts`

Read what it asserts. If it does not already assert that `dist/index.d.ts`
exists and that the `exports` map's `types` target resolves, add that assertion
now — it is the test that has to keep passing across the build change.

- [ ] **Step 3: Write `guardrails-core/tsconfig.build.json`**

```jsonc
{
  // Declarations only. tsup bundles the JS; its dts pass (rollup-plugin-dts)
  // cannot parse TypeScript 6, and tsup 8.5.1 is the latest release, so the
  // type output is emitted by tsc directly instead. See the 2026-09-05
  // mutation-integrity-and-stack-upgrade spec, §5.3.
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "emitDeclarationOnly": true,
    "declaration": true,
    "declarationMap": true,
    "rootDir": "src",
    "outDir": "dist",
  },
  "include": ["src/**/*.ts"],
  "exclude": [],
}
```

- [ ] **Step 4: Turn off tsup's dts and chain the tsc pass**

In `guardrails-core/tsup.config.ts`, change `dts: true` to `dts: false` and add
a comment saying why, pointing at `tsconfig.build.json`.

In `guardrails-core/package.json`:

```json
  "scripts": { "build": "tsup && tsc -p tsconfig.build.json" }
```

Order matters: tsup's `clean: true` wipes `dist`, so declarations must come
after it.

- [ ] **Step 5: Build and verify the output shape**

```bash
npm run build
ls guardrails-core/dist/index.d.ts guardrails-core/dist/cli.d.ts
npx vitest run guardrails-core/test/package-exports.test.ts
```

Expected: build succeeds under TypeScript 6; both declaration files exist; the
exports test passes.

- [ ] **Step 6: Save the TypeScript bump**

```bash
npm i -D typescript@~6.0
```

Then run `npm run build && npm test && npm run lint`. Expected: PASS.

`typescript-eslint@8.69` accepts `>=4.8.4 <6.1.0`, so `~6.0` is inside the
ceiling. Confirm no peer warning appears in the install output.

- [ ] **Step 7: Verify the tarball a consumer actually installs**

The workspace symlink bypasses `files`, the bin shebang, and ESM resolution —
which is what `scripts/smoke-tarball.mjs` exists for, and a build-output change
is exactly what it catches.

Run: `node scripts/smoke-tarball.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add guardrails-core/tsconfig.build.json guardrails-core/tsup.config.ts guardrails-core/package.json package.json package-lock.json guardrails-core/test/package-exports.test.ts
git commit -m "build: emit declarations with tsc so TypeScript 6 builds"
```

---

### Task 6: Ignore stryker's incremental cache in the scaffolded `.gitignore`

Stryker's `incrementalFile` defaults to `reports/stryker-incremental.json`. The
seeded block covers `reports/mutation/` and `.stryker-tmp/` but not that, so a
greenfield repo's first `git add -A` commits a mutation-result cache that then
churns on every run. Measured on a real adoption.

**Files:**

- Modify: `guardrails-core/src/scaffold/merge.ts` (`GITIGNORE_BLOCK`)
- Test: `guardrails-core/test/scaffold/merge.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

In `guardrails-core/test/scaffold/merge.test.ts`, alongside the existing
`GITIGNORE_BLOCK` assertions:

```ts
it("ignores stryker's incremental cache, which is not under reports/mutation/", () => {
  const merged = mergeGitignore(undefined);
  expect(merged).toContain('reports/stryker-incremental.json');
});
```

Match the existing tests' call signature for `mergeGitignore` — read the
neighbouring cases first rather than assuming the argument shape.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run guardrails-core/test/scaffold/merge.test.ts`
Expected: FAIL — the string is absent.

- [ ] **Step 3: Implement**

In `guardrails-core/src/scaffold/merge.ts`, extend `GITIGNORE_BLOCK` next to
the existing stryker entries:

```ts
  'reports/mutation/',
  '.stryker-tmp/',
  // Stryker's `incrementalFile` default, which is NOT under reports/mutation/.
  // Without this a greenfield repo's first `git add -A` commits a
  // mutation-result cache that then churns on every run. `runStryker` deletes
  // this file before every run, so guardrails' own gate is unaffected either
  // way -- what this prevents is the committed artifact, and stale verdicts for
  // anyone running `npx stryker run` by hand.
  'reports/stryker-incremental.json',
```

- [ ] **Step 4: Run the scaffold tests**

Run: `npx vitest run guardrails-core/test/scaffold/`
Expected: PASS. Some tests assert the exact block content — update those
fixtures to include the new line; that is the intended change, not a regression.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/scaffold/merge.ts guardrails-core/test/scaffold/
git commit -m "fix(scaffold): ignore stryker's incremental cache too"
```

---

### Task 7: Point the agent at `init --apply` when a seed is missing

`seedOnceEntries` gates the three analyzer configs on the provider already
being declared, so a bare greenfield `init --apply` writes none of them. Install
the analyzers afterwards and the first `verify` reports `analyzer-failed` for
dependency-cruiser with upstream's own advice attached — `npx dependency-cruiser
--init`, which writes a different config than the seed.

The gating stays (its orphan-avoidance reason is sound). What is missing is the
pointer, and `silentSkipWarning` is already the message that fires in exactly
this state and already prints from `init`, `verify`, and the commit/push/ci
gates.

**Files:**

- Modify: `guardrails-core/src/verify/index.ts` (`silentSkipWarning`)
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Find the existing `silentSkipWarning` test (grep for it across
`guardrails-core/test/`) and add beside it:

```ts
it('says to re-run init --apply, which is what seeds the analyzer config', () => {
  const warning = silentSkipWarning([['knip', 'knip']]);
  expect(warning).toContain('guardrails init --apply');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run -t 'silentSkipWarning'`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `guardrails-core/src/verify/index.ts`, extend the returned string and the
docstring above it:

```ts
return (
  `these analyzers are enabled but their provider package is not in ` +
  `package.json, so each is skipped and verify reports clean without ` +
  `running it: ${named}. Install the ones you want, then re-run ` +
  `\`guardrails init --apply\` to seed the starter config each one needs ` +
  `(init only seeds a config for an analyzer the repo already declares, so ` +
  `a config missing after a bare first run is expected). Or set them ` +
  `"required" in guardrails.config.json so a missing one blocks instead.`
);
```

Extend the docstring to record why the re-run is necessary rather than a
workaround: `init` deliberately does not seed a config for an analyzer nobody
has asked for, because seed-once files it writes are files it can never clean up.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. Tests asserting the old exact string need updating — that is
the intended change.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/test/
git commit -m "fix(verify): name the command that seeds a missing analyzer config"
```

---

### Task 8: Teach the Bash gate git's global options

`GIT_WRITE` requires `git` to be immediately followed by `commit`/`push`, so
`git -c core.hooksPath=/dev/null commit` is a miss. Unlike the accepted
`git -C <path> commit` miss, this one **defeats the git-hook floor** — and it
is the exact bypass the scaffolded `AGENTS.md` tells the agent never to use.

**Files:**

- Modify: `guardrails-core/src/cli-core.ts:308` (`GIT_WRITE`)
- Test: `guardrails-core/test/cli-core.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Find the existing `GIT_WRITE` / `pretooluse` cases in
`guardrails-core/test/cli-core.test.ts` and add:

```ts
it.each([
  'git -c core.hooksPath=/dev/null commit -m x',
  'git -c core.hooksPath=/dev/null push',
  'git --no-pager commit -m x',
  'git -C /some/path commit -m x',
  'git -c a=b -c c=d commit -m x',
])('gates a git write behind global options: %s', async (command) => {
  expect(await gatesPreToolUse(command)).toBe(true);
});

it.each([
  'echo remember to git commit later',
  'ls -la',
  'git status',
  'git log --oneline',
])('does not gate: %s', async (command) => {
  expect(await gatesPreToolUse(command)).toBe(false);
});
```

Use whatever harness the neighbouring pretooluse tests already use for
`gatesPreToolUse`; do not invent a parallel one.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run guardrails-core/test/cli-core.test.ts`
Expected: FAIL on the four option-carrying commands.

- [ ] **Step 3: Implement**

Replace the pattern at `guardrails-core/src/cli-core.ts:308`:

```ts
/**
 * A git write in COMMAND POSITION, with git's global options in between.
 *
 * The classes are deliberately disjoint -- `\n` lives in the separator, `[ \t]`
 * in the padding -- so no input has two readings. An earlier version put `\n`
 * in both and this repo's own lint caught the super-linear backtracking before
 * it landed.
 *
 * The option group exists because `git -c core.hooksPath=/dev/null commit`
 * DEFEATS the git-hook floor, and is the exact bypass the scaffolded
 * instructions forbid by name. That makes it unlike `git -C <path> commit`,
 * which was an accepted miss precisely because the hooks still run -- it is
 * covered here now too, at no cost.
 *
 * Still a command-position test, not a shell parser: `FOO=1 git commit` and
 * `xargs git commit` remain misses, for the reason already recorded -- neither
 * skips the git hooks, so the git-native floor still catches them.
 */
const GIT_WRITE =
  /(?:^|[\n;&|()`{}])[ \t]*git(?:[ \t]+-[^ \t]*(?:[ \t]+[^ \t-][^ \t]*)?)*[ \t]+(?:commit|push)\b/;
```

Verify the option group cannot backtrack super-linearly before committing —
this repo's lint (`sonarjs`) will reject it if it can. If the nested quantifier
trips the rule, prefer an explicit two-alternative option token
(`-[^ \t]*=[^ \t]*` for `-c k=v`, `-[^ \t]*` for the rest) over relaxing the
rule.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run guardrails-core/test/cli-core.test.ts && npm run lint`
Expected: PASS, including the lint check on the new pattern.

- [ ] **Step 5: Check the timing did not regress**

The anchored pattern exists because an unanchored one ran the whole branch gate
on prose. Confirm a non-git Bash call still returns fast:

```bash
echo '{"session_id":"t","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo remember to git commit later"}}' \
  | time node guardrails-core/dist/cli.mjs gate --mode=pretooluse
```

Expected: returns in well under a second (build first if needed).

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/cli-core.ts guardrails-core/test/cli-core.test.ts
git commit -m "fix(gate): catch a git write hidden behind git's global options"
```

---

### Task 9: Correct the guidance that recommends the broken configuration

`adopting-guardrails` step 5 tells the adopter to swap `command` for a
framework runner, and its worked-example table was verified on 2026-09-04 —
before #6210 was known. A greenfield repo following it today resolves vitest 5
and gets a mutation gate that reports every covered mutant as survived.

**Files:**

- Modify: `guardrails-plugin/skills/adopting-guardrails/SKILL.md`
- Then: `npm run build` (regenerates `guardrails-core/guidance/`,
  `docs/guardrails/`, `.github/copilot-instructions.md`, `.claude/skills/`)
- Test: `guardrails-core/test/guidance.test.ts`, `guardrails-core/test/plugin-skills.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Edit the skill source**

Never edit `docs/guardrails/`, `.claude/skills/`, or
`guardrails-core/guidance/` — all generated by `scripts/sync-agents.mjs`.

In step 5's **Stryker's test-runner plugin** bullet, add after the existing
runner-swap advice:

> **Check the runner plugin against your test framework's installed major.**
> `@stryker-mutator/vitest-runner` declares `vitest: ">=2.0.0"`, so npm installs
> it happily against a vitest major it cannot drive — and the failure is silent
> and inverted: every covered mutant comes back `Survived`, so the gate
> manufactures violations rather than missing them. As of 2026-09-05 that is
> vitest 5 (stryker-js#6210); pin `vitest` to `^4` until a fixed runner ships.
> guardrails detects this shape and reports one `guardrails/analyzer-failed`
> instead of a storm of false survivors, so you will see it named rather than
> chase it — but the pin is what gets you a working mutation gate.

In the worked-example table, add the row and keep the section's existing
"the rule, not the numbers" framing:

| package  | range | why                                        |
| -------- | ----- | ------------------------------------------ |
| `vitest` | `^4`  | vitest 5 breaks the stryker runner — #6210 |

- [ ] **Step 2: Rebuild the generated copies**

Run: `npm run build`
Expected: the sync lines report skills synced to all four destinations.

- [ ] **Step 3: Run the guidance tests**

Run: `npx vitest run guardrails-core/test/guidance.test.ts guardrails-core/test/plugin-skills.test.ts`
Expected: PASS.

- [ ] **Step 4: Confirm no generated file drifted**

CI guards `.github/agents` with `git diff --exit-code` after the build. Check
the whole generated surface is committed:

```bash
git status --short
```

Expected: the regenerated `docs/guardrails/`, `guardrails-core/guidance/`, and
`.github/copilot-instructions.md` appear as modified — stage them.

- [ ] **Step 5: Commit**

```bash
git add guardrails-plugin/skills/adopting-guardrails/SKILL.md docs/guardrails guardrails-core/guidance .github/copilot-instructions.md
git commit -m "docs: pin vitest in the guidance that recommends the stryker runner"
```

---

### Task 10: Record the adoption findings and open the PR

`CLAUDE.md`'s dogfooding rule: a finding that is not written down is signal
thrown away. Three prior adoptions each have a `plan.md` section; this is the
fourth.

**Files:**

- Modify: `plan.md`
- Modify: `CLAUDE.md` (the tool-upgrade section gains the runner-integrity point)

- [ ] **Step 1: Add the findings section to `plan.md`**

After "How the third-adoption findings were resolved", add
`### Findings: a fourth greenfield adoption, on the current stack`, following
the established shape of those sections: what worked stated first, then each
finding with its measurement, then how it was resolved. Cover:

1. The vitest-5 false-survivor storm, with the three-row A/B table, the
   probe result (tests executed once, never again), and the six failed
   workarounds. Name stryker-js#6210 and local issue #35.
2. That this repo dogfooded a stack no adopter gets — the four-row version
   table — and that the trust argument depends on closing it.
3. The seed-ordering trap and its resolution (the pointer, not the gating).
4. `reports/stryker-incremental.json` committed by the first `git add -A`,
   **and the correction that it is not a gate fail-open** — `runStryker`
   deletes it before every run.
5. `git -c core.hooksPath=… commit` passing the Bash gate while `AGENTS.md`
   forbids it by name.
6. Under "what worked": every PR #30–#34 fix held out of the tarball — the
   created `.gitignore` carries `node_modules/`, the seed is
   `enforcement: "block"`, the commit gate blocked on the unborn branch, the
   Stop ladder ran fast → fast → thorough (with the recurrence correction) →
   full dump → release across five invocations, `--no-verify` was denied, and
   the skipped-analyzer warning fired at the `verify` rung.
7. Under a "left for the roadmap" heading: the knip/`command`-runner catch-22
   is unsatisfiable on stryker 10 (`@stryker-mutator/command-runner` 404s), and
   no release exists so the documented install URL still 404s.

- [ ] **Step 2: Extend `CLAUDE.md`'s tool-upgrade section**

The existing section tells the upgrader to review `loose-rules.ts` and
`audit.ts`. Add the lesson this milestone paid for:

> A third failure mode an upgrade can introduce: an analyzer that still runs,
> still exits 0, and still reports — **wrongly**. Rule ids and suppression
> syntax are the two id-shaped drifts; runner integrity is the behavioural one,
> and `test/drift/stryker-runner.test.ts` is what holds it. If you add an
> analyzer whose value depends on a framework integration, it needs a live
> guard of the same kind: a fixture whose expected finding is known, run through
> the real tool.

- [ ] **Step 3: Run the full gate**

```bash
npm run build && npm test && npm run lint
npm run test:coverage && npm run check:graph
node guardrails-core/dist/cli.mjs verify
node scripts/smoke-tarball.mjs
```

Expected: all PASS. This is the pre-push gate plus the tarball smoke test; do
not open the PR before it is green.

- [ ] **Step 4: Commit and push**

```bash
git add plan.md CLAUDE.md
git commit -m "docs: record a fourth adoption, on the stack consumers install"
git push -u origin upgrade-stack-and-mutation-guard
```

- [ ] **Step 5: Open the PR**

Title: `Make the mutation gate honest on any runner, and move to the current stack`

The body should state the measured A/B up front (12 Killed on vitest 4, 12
Survived on vitest 5, same code and tests), what the guard does about it, what
the upgrade covers, and that `vitest` is pinned behind issue #35. Link the spec
and the plan. Close #35? **No** — #35 tracks _unpinning_, which this PR does not
do; reference it instead.

---

## Self-review

**Spec coverage.** §3 → Tasks 1–2. §4 → Task 3. §5.1/§5.2 → Task 4. §5.3 →
Task 5. §6.1 → Task 6. §6.2 → Task 7. §6.3 → Task 8. §6.4 → Task 9. §7 is
explicitly out of scope and recorded in Task 10's roadmap heading. The dogfooding
record `CLAUDE.md` requires → Task 10.

**Ordering.** Task 3 (the drift guard) precedes Task 4 (the stryker 10 bump) on
purpose: the guard is what makes the bump safe, and Task 4 Step 6 runs it. Task
5 follows Task 4 because the TypeScript bump has to land on an already-current
typescript-eslint. Tasks 6–9 are independent of 1–5 and of each other, and can
be reordered freely.

**Type consistency.** `unrunSurvivedMutants(reportJson: string, changedFiles:
readonly string[]): number` is defined in Task 1 and consumed with that exact
signature in Task 2 (`runStryker`) and Task 3 (the drift guard). `StrykerMutant`
gains `coveredBy?: string[]` and `testsCompleted?: number`, both optional, and
both are read with `??` defaults at every use.
