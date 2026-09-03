# Phase C piece 6 — workspaces / affected-package attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive each violation's owning package from its file path and set `Violation.package`, activating the per-package recurrence memory the contract has specified since Phase A.

**Architecture:** One resolver built per run (`loadWorkspaceResolver`) reads the filesystem once and returns a pure `(file) => string | undefined`. Both resolution modes are the same walk — ancestors of the file, deepest first, stopping at `repoRoot` — differing only in whether a glob predicate gates each candidate. Attribution is a separate enrichment pass (`withPackages`) mirroring `withGuidance`, so no adapter needs to know about workspaces.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `node:fs`/`node:path`. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-08-29-phase-c-workspaces-design.md`

## Global Constraints

- **No new runtime or dev dependency.** `guardrails-core`'s `dependencies` stays `{}` — a test already enforces this (`test/peer-dependencies.test.ts`).
- **Supported glob syntax is exactly:** `*` (one segment), `**` (any number of segments), a leading `!` (negation), literal segments. Braces, character classes, `?` and extglobs are an **explicit non-goal** — treat such a pattern as non-matching rather than guessing.
- **The package id is the repo-relative directory path** (`packages/api`), never the `name` field.
- **Deepest match wins** when candidates nest.
- **Attribution degrades, never throws.** A malformed root `package.json` falls back to nearest-ancestor mode; a path escaping `repoRoot` yields `undefined`. A miss costs a missing key, never a failed gate.
- **TDD**, and the repo's own lint applies to plan code: no abbreviations (`directory` not `dir`), no explicit trailing `undefined` argument, cognitive complexity < 15, `.sort()` needs a comparator.
- **Zero surviving mutants** on every file touched (`npx stryker run --mutate '<path>' --reporters json`).

---

### Task 1: Workspace glob subset → matcher

**Files:**

- Create: `guardrails-core/src/workspace-glob.ts`
- Test: `guardrails-core/test/workspace-glob.test.ts`

**Interfaces:**

- Produces: `parseWorkspaceGlob(glob: string): ParsedGlob | undefined` where `interface ParsedGlob { negated: boolean; matches: (directory: string) => boolean }`. Returns `undefined` for unsupported syntax.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/workspace-glob.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseWorkspaceGlob } from '../src/workspace-glob.js';

/** Match helper: parse then test, failing loudly if the glob was unsupported. */
function matches(glob: string, directory: string): boolean {
  const parsed = parseWorkspaceGlob(glob);
  if (parsed === undefined) {
    throw new Error(`expected ${glob} to be supported`);
  }
  return parsed.matches(directory);
}

describe('parseWorkspaceGlob', () => {
  it('matches a single segment with *', () => {
    expect(matches('packages/*', 'packages/api')).toBe(true);
    // * is ONE segment: it must not reach into a nested directory.
    expect(matches('packages/*', 'packages/api/src')).toBe(false);
    expect(matches('packages/*', 'apps/api')).toBe(false);
  });

  it('matches any depth with **', () => {
    expect(matches('packages/**', 'packages/api')).toBe(true);
    expect(matches('packages/**', 'packages/group/api')).toBe(true);
    expect(matches('packages/**', 'apps/api')).toBe(false);
  });

  it('matches a literal path exactly', () => {
    expect(matches('guardrails-core', 'guardrails-core')).toBe(true);
    expect(matches('guardrails-core', 'guardrails-core/src')).toBe(false);
    expect(matches('guardrails-core', 'other')).toBe(false);
  });

  it('treats a leading ! as negation, without it being part of the pattern', () => {
    const parsed = parseWorkspaceGlob('!packages/private');
    expect(parsed?.negated).toBe(true);
    expect(parsed?.matches('packages/private')).toBe(true);
    expect(parseWorkspaceGlob('packages/*')?.negated).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    // A dot must match a dot, not any character.
    expect(matches('packages/a.b', 'packages/a.b')).toBe(true);
    expect(matches('packages/a.b', 'packages/axb')).toBe(false);
  });

  it('supports a partial-segment star', () => {
    expect(matches('packages/api-*', 'packages/api-core')).toBe(true);
    expect(matches('packages/api-*', 'packages/web-core')).toBe(false);
  });

  it('returns undefined for syntax outside the supported subset', () => {
    // Explicit non-goal: guessing is worse than declining, because the caller
    // still has a fallback that will attribute the file.
    expect(parseWorkspaceGlob('packages/{a,b}')).toBeUndefined();
    expect(parseWorkspaceGlob('packages/[ab]')).toBeUndefined();
    expect(parseWorkspaceGlob('packages/a?')).toBeUndefined();
    expect(parseWorkspaceGlob('packages/+(a|b)')).toBeUndefined();
  });

  it('returns undefined for an empty pattern', () => {
    expect(parseWorkspaceGlob('')).toBeUndefined();
    expect(parseWorkspaceGlob('!')).toBeUndefined();
  });

  it('ignores a trailing slash', () => {
    expect(matches('packages/*/', 'packages/api')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workspace-glob`
Expected: FAIL — `Cannot find module '.../workspace-glob.js'`.

- [ ] **Step 3: Write the implementation**

Create `guardrails-core/src/workspace-glob.ts`:

```ts
/**
 * The npm **workspace** glob subset — deliberately not a glob library.
 *
 * Workspace declarations use a small, well-known vocabulary (`packages/*`,
 * occasionally `packages/**`, rarely a `!` exclusion), so this implements
 * exactly that and declines everything else. Declining is safe: the caller
 * falls back to nearest-ancestor resolution, which still attributes the file.
 * Guessing is not — a wrong match silently corrupts recurrence memory.
 */

/** Syntax we do not implement: braces, character classes, `?`, extglobs. */
const UNSUPPORTED = /[{}[\]()?+]/;

export interface ParsedGlob {
  /** A leading `!` marks an exclusion, applied after the positive matches. */
  negated: boolean;
  /** `directory` is repo-relative and slash-separated, with no trailing slash. */
  matches: (directory: string) => boolean;
}

function escapeLiteral(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** `*` matches within one segment; `**` spans segments. */
function segmentToPattern(segment: string): string {
  if (segment === '**') {
    return '.*';
  }
  return segment.split('*').map(escapeLiteral).join('[^/]*');
}

export function parseWorkspaceGlob(glob: string): ParsedGlob | undefined {
  const negated = glob.startsWith('!');
  const body = (negated ? glob.slice(1) : glob).replace(/\/+$/, '');
  if (body.length === 0 || UNSUPPORTED.test(body)) {
    return undefined;
  }
  const source = body.split('/').map(segmentToPattern).join('/');
  const pattern = new RegExp(`^${source}$`);
  return { negated, matches: (directory) => pattern.test(directory) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- workspace-glob`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, and prove the tests are not hollow**

Run:

```bash
npm run typecheck && npx eslint guardrails-core/src/workspace-glob.ts guardrails-core/test/workspace-glob.test.ts
rm -rf reports .stryker-tmp && npx stryker run --mutate 'guardrails-core/src/workspace-glob.ts' --reporters json >/dev/null 2>&1
node -e "const d=require('./reports/mutation/mutation.json');const f=Object.values(d.files)[0];console.log(f.mutants.filter(m=>m.status==='Survived').map(m=>m.location.start.line+' '+m.mutatorName))"
rm -rf reports .stryker-tmp
```

Expected: no lint/type errors, and an empty survivor list. If any survive, use the **crushing-mutants** skill: read the mutant's `replacement`, and remember an assertion that passes for the wrong reason is the usual cause.

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/workspace-glob.ts guardrails-core/test/workspace-glob.test.ts
git commit -m "feat(workspaces): npm workspace glob subset matcher"
```

---

### Task 2: The resolver — declared and fallback modes

**Files:**

- Create: `guardrails-core/src/workspaces.ts`
- Test: `guardrails-core/test/workspaces.test.ts`

**Interfaces:**

- Consumes: `parseWorkspaceGlob` from Task 1.
- Produces: `type PackageResolver = (file: string) => string | undefined` and `loadWorkspaceResolver(repoRoot: string): PackageResolver`.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/workspaces.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadWorkspaceResolver } from '../src/workspaces.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-ws-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `<root>/<relative>/package.json`. */
function makePackage(relative: string): void {
  const directory = path.join(root, relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), '{}');
}

function makeRoot(contents: string): void {
  writeFileSync(path.join(root, 'package.json'), contents);
}

describe('loadWorkspaceResolver — declared mode', () => {
  it('attributes a file to its declared workspace member', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    makePackage('packages/api');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/src/a.ts')).toBe('packages/api');
  });

  it('ignores a nested package.json that is not a declared member', () => {
    // The case this repo actually has: a test fixture with its own manifest.
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    makePackage('packages/api');
    makePackage('packages/api/test/fixture');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/test/fixture/x.ts')).toBe('packages/api');
  });

  it('accepts yarn’s object form', () => {
    makeRoot(JSON.stringify({ workspaces: { packages: ['apps/*'] } }));
    makePackage('apps/web');
    expect(loadWorkspaceResolver(root)('apps/web/src/a.ts')).toBe('apps/web');
  });

  it('honours a ! exclusion', () => {
    makeRoot(
      JSON.stringify({ workspaces: ['packages/*', '!packages/private'] }),
    );
    makePackage('packages/api');
    makePackage('packages/private');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/a.ts')).toBe('packages/api');
    expect(resolve('packages/private/a.ts')).toBeUndefined();
  });

  it('requires a matching directory to actually contain a package.json', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(path.join(root, 'packages/not-a-package'), { recursive: true });
    expect(
      loadWorkspaceResolver(root)('packages/not-a-package/a.ts'),
    ).toBeUndefined();
  });

  it('picks the DEEPEST match when packages nest', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*', 'packages/*/sub'] }));
    makePackage('packages/api');
    makePackage('packages/api/sub');
    expect(loadWorkspaceResolver(root)('packages/api/sub/a.ts')).toBe(
      'packages/api/sub',
    );
  });

  it('falls back when a declared glob uses unsupported syntax', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/{a,b}'] }));
    makePackage('packages/a');
    // The glob is declined, but nearest-ancestor still attributes the file.
    expect(loadWorkspaceResolver(root)('packages/a/x.ts')).toBe('packages/a');
  });
});

describe('loadWorkspaceResolver — fallback mode', () => {
  it('uses the nearest ancestor package.json when nothing is declared', () => {
    makeRoot('{}');
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/src/a.ts')).toBe(
      'libs/thing',
    );
  });

  it('falls back when the root package.json is malformed', () => {
    makeRoot('{ not json');
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/a.ts')).toBe('libs/thing');
  });

  it('falls back when there is no root package.json at all', () => {
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/a.ts')).toBe('libs/thing');
  });
});

describe('loadWorkspaceResolver — no owning package', () => {
  it('returns undefined for a root-owned file', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    expect(loadWorkspaceResolver(root)('scripts/build.ts')).toBeUndefined();
  });

  it('returns undefined for a path escaping the repo root', () => {
    makeRoot('{}');
    expect(loadWorkspaceResolver(root)('../elsewhere/a.ts')).toBeUndefined();
  });

  it('never throws on a nonexistent repo root', () => {
    const resolve = loadWorkspaceResolver(path.join(root, 'missing'));
    expect(resolve('a/b.ts')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workspaces`
Expected: FAIL — `Cannot find module '.../workspaces.js'`.

- [ ] **Step 3: Write the implementation**

Create `guardrails-core/src/workspaces.ts`:

```ts
/**
 * Which package owns a file, in a monorepo.
 *
 * `Violation.package` and `recurrenceKey`'s `package:ruleId` form have existed
 * since Phase A with nothing to set them, so a rule recurring in one package was
 * diluted across the whole repo. Attribution is per-FILE, which is why it lives
 * here rather than as a single id threaded into each adapter.
 *
 * Both modes are one walk: ancestors of the file, deepest first, stopping at
 * `repoRoot`. Declared mode additionally gates each candidate on the root
 * `workspaces` globs; fallback mode takes the first ancestor with a
 * `package.json`. Everything degrades to `undefined` rather than throwing —
 * attribution is an enrichment and must never fail a gate that would pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseWorkspaceGlob, type ParsedGlob } from './workspace-glob.js';

export type PackageResolver = (file: string) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The declared patterns: npm/yarn's array form, or yarn's `{ packages: [] }`. */
function declaredPatterns(manifest: unknown): unknown[] {
  if (!isRecord(manifest)) {
    return [];
  }
  const declared = manifest.workspaces;
  if (Array.isArray(declared)) {
    return declared;
  }
  if (isRecord(declared) && Array.isArray(declared.packages)) {
    return declared.packages;
  }
  return [];
}

function readWorkspaceGlobs(repoRoot: string): ParsedGlob[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
  } catch {
    return [];
  }
  const parsed: ParsedGlob[] = [];
  for (const pattern of declaredPatterns(manifest)) {
    if (typeof pattern !== 'string') {
      continue;
    }
    const glob = parseWorkspaceGlob(pattern);
    if (glob !== undefined) {
      parsed.push(glob);
    }
  }
  return parsed;
}

/** Repo-relative ancestor directories of `file`, deepest first, excluding the
 *  root itself. Empty when the path escapes `repoRoot`. */
function ancestorDirectories(repoRoot: string, file: string): string[] {
  const relative = path.relative(repoRoot, path.resolve(repoRoot, file));
  if (relative.length === 0 || relative.startsWith('..')) {
    return [];
  }
  const directories: string[] = [];
  let current = path.dirname(relative);
  while (current !== '.' && current !== path.dirname(current)) {
    directories.push(current.split(path.sep).join('/'));
    current = path.dirname(current);
  }
  return directories;
}

function isDeclaredMember(globs: ParsedGlob[], directory: string): boolean {
  const included = globs.some(
    (glob) => !glob.negated && glob.matches(directory),
  );
  const excluded = globs.some(
    (glob) => glob.negated && glob.matches(directory),
  );
  return included && !excluded;
}

export function loadWorkspaceResolver(repoRoot: string): PackageResolver {
  const globs = readWorkspaceGlobs(repoRoot);
  return (file) => {
    for (const directory of ancestorDirectories(repoRoot, file)) {
      if (globs.length > 0 && !isDeclaredMember(globs, directory)) {
        continue;
      }
      if (existsSync(path.join(repoRoot, directory, 'package.json'))) {
        return directory;
      }
    }
    return undefined;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- workspaces`
Expected: PASS.

Note the `!packages/private` case relies on `isDeclaredMember` returning false, so the walk continues to `packages`, which is not itself a member — yielding `undefined`. The unsupported-syntax case relies on that glob being dropped in `readWorkspaceGlobs`, leaving `globs` empty and thus fallback behaviour.

- [ ] **Step 5: Typecheck, lint, and prove the tests are not hollow**

Run:

```bash
npm run typecheck && npx eslint guardrails-core/src/workspaces.ts guardrails-core/test/workspaces.test.ts
rm -rf reports .stryker-tmp && npx stryker run --mutate 'guardrails-core/src/workspaces.ts' --reporters json >/dev/null 2>&1
node -e "const d=require('./reports/mutation/mutation.json');const f=Object.values(d.files)[0];console.log(f.mutants.filter(m=>m.status==='Survived').map(m=>m.location.start.line+' '+m.mutatorName))"
rm -rf reports .stryker-tmp
```

Expected: clean, empty survivor list.

Two lint traps already avoided in the code above, both from recorded findings: the array/object-form narrowing is a named helper rather than a nested ternary (`unicorn/no-nested-ternary`), and `readWorkspaceGlobs` is split so neither function approaches the cognitive-complexity gate. If something still trips, **fix the code, never the threshold**.

- [ ] **Step 6: Commit**

```bash
git add guardrails-core/src/workspaces.ts guardrails-core/test/workspaces.test.ts
git commit -m "feat(workspaces): package resolver — declared members, nearest-ancestor fallback"
```

---

### Task 3: `withPackages` enrichment

**Files:**

- Modify: `guardrails-core/src/workspaces.ts`
- Test: `guardrails-core/test/workspaces.test.ts`

**Interfaces:**

- Consumes: `PackageResolver` from Task 2.
- Produces: `withPackages(violations: readonly Violation[], resolve: PackageResolver): Violation[]`.

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/workspaces.test.ts` (add `withPackages` to the existing import, and `import type { Violation } from '../src/violation.js';`):

```ts
function violation(file: string, extra: Partial<Violation> = {}): Violation {
  return {
    ruleId: 'no-console',
    file,
    message: 'msg',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
    ...extra,
  };
}

describe('withPackages', () => {
  const resolve = (file: string): string | undefined =>
    file.startsWith('packages/api/') ? 'packages/api' : undefined;

  it('sets package from the violation’s file', () => {
    const [tagged] = withPackages(
      [violation('packages/api/src/a.ts')],
      resolve,
    );
    expect(tagged?.package).toBe('packages/api');
  });

  it('adds no key when there is no owning package', () => {
    const [untagged] = withPackages([violation('scripts/build.ts')], resolve);
    expect(untagged && Object.hasOwn(untagged, 'package')).toBe(false);
  });

  it('does not overwrite a package a producer already set', () => {
    const [tagged] = withPackages(
      [violation('packages/api/src/a.ts', { package: 'explicit' })],
      resolve,
    );
    expect(tagged?.package).toBe('explicit');
  });

  it('is idempotent, so it is safe to apply more than once', () => {
    const once = withPackages([violation('packages/api/a.ts')], resolve);
    expect(withPackages(once, resolve)).toEqual(once);
  });

  it('preserves order and every other field', () => {
    const input = [violation('scripts/b.ts'), violation('packages/api/a.ts')];
    const result = withPackages(input, resolve);
    expect(result.map((entry) => entry.file)).toEqual([
      'scripts/b.ts',
      'packages/api/a.ts',
    ]);
    expect(result[0]).toEqual(input[0]);
  });

  it('is empty for no violations', () => {
    expect(withPackages([], resolve)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workspaces`
Expected: FAIL — `withPackages` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `guardrails-core/src/workspaces.ts` (and add `import type { Violation } from './violation.js';` at the top):

```ts
/**
 * Return `violations` with `package` set where an owning package is known.
 * Mirrors `withGuidance`: preserve-existing, add no key when there is nothing to
 * add, and therefore idempotent — safe to apply in both `runVerify` and the gate.
 */
export function withPackages(
  violations: readonly Violation[],
  resolve: PackageResolver,
): Violation[] {
  return violations.map((violation) => {
    if (violation.package !== undefined) {
      return violation;
    }
    const owner = resolve(violation.file);
    return owner === undefined ? violation : { ...violation, package: owner };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- workspaces`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/workspaces.ts guardrails-core/test/workspaces.test.ts
git commit -m "feat(workspaces): withPackages — attribute violations to their package"
```

---

### Task 4: Wire attribution into verify and the gate

**Files:**

- Modify: `guardrails-core/src/verify/index.ts`
- Modify: `guardrails-core/src/gate.ts`
- Test: `guardrails-core/test/verify/orchestrator.test.ts`

**Interfaces:**

- Consumes: `loadWorkspaceResolver`, `withPackages` from Tasks 2–3.

- [ ] **Step 1: Write the failing test**

Append to `guardrails-core/test/verify/orchestrator.test.ts`:

```ts
describe('package attribution', () => {
  it('adds no package key in a single-package repo', async () => {
    // repoRoot '/repo' does not exist, so resolution degrades to undefined —
    // proving attribution cannot throw or fail a gate that would otherwise pass.
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec().exec,
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => !Object.hasOwn(v, 'package'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrator`
Expected: PASS already — nothing sets `package` yet. This is a **regression guard** for the degrade-safely property; the wiring in Step 3 must keep it passing.

- [ ] **Step 3: Wire it in**

In `guardrails-core/src/verify/index.ts`, add the import:

```ts
import { loadWorkspaceResolver, withPackages } from '../workspaces.js';
```

and change the end of `runVerify` from `return { violations };` to:

```ts
// Attribution is per-file, so it happens here rather than inside any adapter.
// Built once per run: the resolver reads the filesystem at construction and is
// pure thereafter.
return {
  violations: withPackages(violations, loadWorkspaceResolver(options.repoRoot)),
};
```

In `guardrails-core/src/gate.ts`, add the import:

```ts
import { loadWorkspaceResolver, withPackages } from './workspaces.js';
```

and compose it with the existing `withGuidance` call in `runStopGate`, so audit-derived violations — which carry files too — are attributed:

```ts
const combined = withGuidance(
  withPackages(
    [...violations, ...auditFindings.map((finding) => toViolation(finding))],
    loadWorkspaceResolver(repoRoot),
  ),
);
```

`runVerify`'s violations are already attributed; `withPackages` is idempotent, so re-applying is a no-op.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, including the regression guard from Step 1.

- [ ] **Step 5: Commit**

```bash
git add guardrails-core/src/verify/index.ts guardrails-core/src/gate.ts guardrails-core/test/verify/orchestrator.test.ts
git commit -m "feat(verify): attribute violations to their workspace package"
```

---

### Task 5: Delete the dead `packageId` seam

**Files:**

- Modify: `guardrails-core/src/verify/eslint-adapter.ts`, `tsc-adapter.ts`, `knip-adapter.ts`, `depcruise-adapter.ts`, `stryker-adapter.ts`
- Modify: `guardrails-core/src/verify/index.ts` (the five runners and `VerifyOptions`)
- Test: the five matching files under `guardrails-core/test/verify/`

**Interfaces:**

- Produces: adapters with the trailing `packageId` parameter removed — `parseEslintJson(stdout, repoRoot)`, `parseTscOutput(stdout, repoRoot)`, `parseKnipJson(stdout, repoRoot)`, `parseDepcruiseJson(json, repoRoot)`, `parseStrykerJson(reportJson, changedFiles)`.

- [ ] **Step 1: Remove the parameter from each adapter**

In all five adapters, delete the `packageId?: string` parameter and every `...(packageId === undefined ? {} : { package: packageId })` spread. Attribution now happens in one place (Task 4), and a single id per run could never have been right for a monorepo — one `verify` run spans many packages.

Also delete `packageId?: string` from `VerifyOptions` in `verify/index.ts`, and drop it from each runner's destructuring (`const { exec, repoRoot } = options;`) and from the `parse*` call sites.

- [ ] **Step 2: Update the adapter tests**

Remove the `packageId` arguments and any assertion that a `package` key is set by an adapter. Keep every other assertion. In `stryker-adapter.test.ts`, the `bad()` helper and the "omits the package key" test both reference it — the latter becomes redundant and should be deleted, since Task 3 now owns that behaviour.

- [ ] **Step 3: Verify nothing still references it**

Run:

```bash
grep -rn "packageId" guardrails-core/src guardrails-core/test || echo "clean"
npm test && npm run typecheck && npm run lint && npx knip
```

Expected: `clean`, and everything green.

- [ ] **Step 4: Commit**

```bash
git add guardrails-core/src guardrails-core/test
git commit -m "refactor(verify): delete the dead packageId seam from the adapters"
```

---

### Task 6: Prove per-package recurrence

**Files:**

- Test: `guardrails-core/test/gate-decision.test.ts`

**Interfaces:**

- Consumes: `recurrenceKey` (existing, unchanged).

- [ ] **Step 1: Write the test**

Append to `guardrails-core/test/gate-decision.test.ts` (import `recurrenceKey` and `type Violation` from `'../src/violation.js'` if not already imported):

```ts
describe('per-package recurrence', () => {
  const base = {
    ruleId: 'no-console',
    file: 'a.ts',
    message: 'msg',
    severity: 'error' as const,
    fixable: false,
    tool: 'eslint',
  };

  it('keys the same rule separately in different packages', () => {
    // The whole point of attribution: a rule recurring in one package must not
    // be diluted across the repo, which is what recurrence-as-signal measures.
    const api: Violation = { ...base, package: 'packages/api' };
    const web: Violation = { ...base, package: 'packages/web' };
    expect(recurrenceKey(api)).not.toBe(recurrenceKey(web));
    expect(recurrenceKey(api)).toBe('packages/api:no-console');
  });

  it('keys on the bare ruleId when there is no package', () => {
    expect(recurrenceKey(base)).toBe('no-console');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- gate-decision`
Expected: PASS. `recurrenceKey` already implements this; the test pins the behaviour attribution has just made reachable, which was previously unexercised.

- [ ] **Step 3: Commit**

```bash
git add guardrails-core/test/gate-decision.test.ts
git commit -m "test(gate): per-package recurrence keys, now reachable"
```

---

### Task 7: Record status and findings

**Files:**

- Modify: `plan.md`

- [ ] **Step 1: Add the piece-6 status**

Under "Phase C status", add a **Piece 6 — workspaces / affected-package attribution (shipped)** entry covering: the hybrid resolver, the hand-rolled glob subset and why no dependency was taken (the polyglot argument — a declared dep's `npm audit` visibility buys nothing in a Maven repo, and Phase D targets those), the deletion of the dead `packageId` seam, and that per-package recurrence is now live.

Add a **Phase C piece 6 — execution findings** subsection with whatever the implementation actually surfaced. Record at minimum:

- `packageId` was threaded through five adapters and set by nobody — a forward-declared seam neither knip nor fallow could see, because it was a parameter rather than an export. Forward-declaring an interface before its producer exists creates dead code no analyzer flags.
- Anything the mutation runs caught in the glob matcher (Task 1, Step 5).

Then update the **Build phases** line for C: all six pieces are done, so drop the "Remaining:" clause.

- [ ] **Step 2: Commit**

```bash
git add plan.md
git commit -m "docs(plan): Phase C piece 6 shipped — workspace attribution + findings"
```
