# Hook CLI Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four hand-built paths to `cli.mjs` with one command form that names the package and lets Node resolve it, bounded to the repository.

**Architecture:** Every generated hook command becomes
`node -e "import('guardrails-core/cli')" guardrails <subcommand>`. Node's upward
`node_modules` walk replaces `${CLAUDE_PROJECT_DIR}` and
`$(git rev-parse --show-toplevel)`, so npm hoisting, pnpm and subpackage
adoption all work without guessing a root. The walk is then bounded to the repo
in both places that perform one — `resolveLocalBin` for analyzer binaries, and a
startup self-check in the CLI itself — using a shared `.git` findUp that also
replaces `resolveRepoRoot`'s git subprocess.

**Tech Stack:** TypeScript (strict) → tsup → `dist/*.mjs`; vitest; eslint +
typescript-eslint + unicorn + sonarjs; knip and fallow for graph analysis;
Stryker for mutation.

**Spec:** `docs/superpowers/specs/2026-09-02-cli-resolution-design.md`

## Global Constraints

- **TDD is non-negotiable.** No production code without a failing test first.
- **Never weaken a rule to pass it.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, deleted assertions, or raised thresholds.
- **Node `>=24.0.0`**; `"type": "module"`; pure ESM, `.mjs` output.
- **`guardrails-core/src` reads no environment variables.** `process.versions`
  and `process.platform` are not environment reads; `process.env` is.
- **Naming:** `eslint-plugin-unicorn`'s `prevent-abbreviations` is on. Write
  `directory`, `error`, `arguments`, `configuration` — not `dir`, `e`, `args`,
  `cfg`. This applies to test files too.
- **Generated, do not hand-edit:** `guardrails-core/templates/**` (from
  `scripts/sync-agents.mjs` via `npm run build`), `.claude/agents/**`,
  `.github/agents/**`. Edit the source, run `npm run build`, commit the output.
- **The four hook configs are sources, not generated:** `.claude/settings.json`,
  `.codex/hooks.json`, `.github/hooks/guardrails.json`,
  `guardrails-plugin/hooks/hooks.json`. `sync-agents.mjs` copies the first three
  into `templates/`.
- **Commit in small logical steps.** Every task ends with a commit.
- **Hooks and agents load at session start.** Nothing in this plan takes effect
  in the session that writes it.

---

## File Structure

**Created:**

- `guardrails-core/src/path-walk.ts` — one upward-directory generator, shared by
  the two resolvers that walk. Nothing else in it.
- `guardrails-core/test/path-walk.test.ts`
- `guardrails-core/test/hook-command.ts` — the canonical command string and its
  builder. Not a `.test.ts` file, so vitest's include pattern
  (`guardrails-core/test/**/*.test.ts`) does not collect it; knip counts it as
  used because four test files import it.
- `guardrails-core/test/package-exports.test.ts`
- `guardrails-core/test/cli-resolution.test.ts` — the layout matrix, executable.

**Modified:**

- `guardrails-core/package.json` — `exports` gains `"./cli"`.
- `guardrails-core/src/repo-root.ts` — findUp-first; exports `findGitRoot`.
- `guardrails-core/src/hook-io.ts:279-283` — `resolveLocalBin` bounded walk.
- `guardrails-core/src/cli-core.ts:54-60` (`CliDeps`) and `:525` (`runCommand`).
- `guardrails-core/src/cli.ts` — supplies `selfPath`.
- `.claude/settings.json`, `.codex/hooks.json`,
  `.github/hooks/guardrails.json`, `guardrails-plugin/hooks/hooks.json`.
- `guardrails-core/test/repo-root.test.ts`, `test/hook-io.test.ts`,
  `test/cli-core.test.ts`, `test/codex-hooks-config.test.ts`,
  `test/github-hooks-config.test.ts`, `test/plugin-hooks.test.ts`,
  `test/scaffold/init-command.test.ts`.
- `scripts/smoke-tarball.mjs`.
- `docs/adoption.md`, `README.md`, `CLAUDE.md`,
  `docs/live-loop-verification.md`, `docs/copilot-live-loop-verification.md`.

**Deliberately untouched:** `.githooks/pre-commit`, `.husky/pre-commit`,
`guardrails-plugin/templates/workflows/guardrails.yml`,
`guardrails-core/src/scaffold/hooks-path.ts`. See spec §9.

---

### Task 1: Publish `guardrails-core/cli` as a package export

Every generated hook command will import the bare specifier
`guardrails-core/cli`. The current `exports` map publishes `.` only, so that
subpath is refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing inside this
repo imports it by name, so without a test the entry can be narrowed later and
every adopter's hooks break at once, silently.

**Files:**

- Modify: `guardrails-core/package.json:12-17`
- Create: `guardrails-core/test/package-exports.test.ts`
- Modify: `scripts/smoke-tarball.mjs` (after the existing templates loop)

**Interfaces:**

- Consumes: nothing.
- Produces: the bare specifier `guardrails-core/cli`, resolving to
  `./dist/cli.mjs`. Tasks 2 and 5 depend on it.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/package-exports.test.ts`:

```ts
/**
 * `guardrails-core/cli` is what every generated hook command imports, so this
 * `exports` entry is public API — the only public API in this package that no
 * source file in this repo consumes. Narrowing the map, or renaming the built
 * file, would break every adopter's hooks simultaneously with no local signal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as {
  exports: Record<string, unknown>;
  bin: Record<string, string>;
};

describe('guardrails-core package exports', () => {
  it('publishes the CLI as ./cli for hook commands', () => {
    expect(manifest.exports['./cli']).toBe('./dist/cli.mjs');
  });

  it('points ./cli at the same file the guardrails bin runs', () => {
    // Two ways in, one entry point. If they ever diverge, `npx guardrails` and
    // the hook command would run different files.
    expect(manifest.exports['./cli']).toBe(manifest.bin.guardrails);
  });

  it('keeps the package root export intact', () => {
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run guardrails-core/test/package-exports.test.ts`
Expected: FAIL — `expected undefined to be './dist/cli.mjs'`.

- [ ] **Step 3: Add the export**

In `guardrails-core/package.json`, replace the `exports` block:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs"
    },
    "./cli": "./dist/cli.mjs"
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run guardrails-core/test/package-exports.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prove it in the packed tarball too**

In `scripts/smoke-tarball.mjs`, immediately after the `for (const relative of [...])`
templates loop that ends with its closing `}`, add:

```js
// 4b. The subpath every generated hook command imports. `files` and the
//     templates checks above prove the BYTES shipped; this proves the
//     `exports` map actually publishes them under the name hooks use.
//     Resolved, never imported: importing cli.mjs would run the CLI, which
//     reads stdin and would hang here.
const resolveProbe = spawnSync(
  process.execPath,
  [
    '-e',
    "const { createRequire } = require('node:module');" +
      "console.log(createRequire(process.cwd() + '/probe.cjs')" +
      ".resolve('guardrails-core/cli'));",
  ],
  { cwd: fixture, encoding: 'utf8' },
);
if (resolveProbe.status !== 0 || !resolveProbe.stdout.includes('cli.mjs')) {
  fail(
    'the packed package does not publish `guardrails-core/cli` — every ' +
      'generated hook command imports that subpath:\n' +
      `${resolveProbe.stdout}${resolveProbe.stderr}`,
  );
}
```

- [ ] **Step 6: Run the tarball smoke test**

Run: `npm run build && npm run smoke:tarball`
Expected: exits 0. If it reports the missing subpath, step 3 did not land.

- [ ] **Step 7: Commit**

```bash
git add guardrails-core/package.json guardrails-core/test/package-exports.test.ts scripts/smoke-tarball.mjs
git commit -m "feat(package): publish guardrails-core/cli as an exports subpath

The hook command form every dialect is about to generate imports the bare
specifier \`guardrails-core/cli\`. The exports map published \`.\` only, so
that subpath was refused with ERR_PACKAGE_PATH_NOT_EXPORTED.

Tested because no source file in this repo imports it by name: narrowing the
map later would break every adopter's hooks at once with nothing local to
catch it. The tarball smoke test resolves the subpath rather than importing
it — importing cli.mjs runs the CLI, which reads stdin and would hang."
```

---

### Task 2: One canonical hook command across all four emitters

The bug being fixed and the reason it survived. `.github/hooks/guardrails.json`
carries `${CLAUDE_PROJECT_DIR:-.}` — Claude Code's variable, in a host that
never sets it, so the `:-.` fallback always fires and it silently resolves to
the process cwd. `github-hooks-config.test.ts` asserts the dialect flags and the
envelope shape and says **nothing about the path at all**, which is why it
shipped. Every emitter gets a path assertion against one shared constant.

**Files:**

- Create: `guardrails-core/test/hook-command.ts`
- Modify: `guardrails-core/test/codex-hooks-config.test.ts:52-62`
- Modify: `guardrails-core/test/github-hooks-config.test.ts`
- Modify: `guardrails-core/test/plugin-hooks.test.ts:38-43`
- Modify: `.claude/settings.json`, `.codex/hooks.json`,
  `.github/hooks/guardrails.json`, `guardrails-plugin/hooks/hooks.json`
- Regenerate: `guardrails-core/templates/{claude/settings.hooks.json,codex/hooks.json,copilot/hooks/guardrails.json}`

**Interfaces:**

- Consumes: the `guardrails-core/cli` subpath from Task 1.
- Produces: `CLI_PREFIX: string` and `cliCommand(subcommand: string): string`
  from `guardrails-core/test/hook-command.ts`. Task 5 imports `CLI_PREFIX`.

- [ ] **Step 1: Create the shared constant**

Create `guardrails-core/test/hook-command.ts`:

```ts
/**
 * The one command string every generated hook uses, and the single place any
 * test may spell it.
 *
 * Four separate config files emit it — Claude's settings, the Codex hooks, the
 * Copilot hooks and the plugin's own wiring — and they drifted once already:
 * the Copilot config shipped Claude's `${CLAUDE_PROJECT_DIR}` with a `:-.`
 * fallback into a host that never sets that variable, and no test noticed,
 * because not one of them asserted the path. Asserting against a shared
 * constant is what makes a repeat impossible rather than unlikely.
 *
 * Deliberately not a `.test.ts` file: vitest's include pattern is
 * `guardrails-core/test/**\/*.test.ts`, so this is a helper, not a suite.
 */

/**
 * Locate nothing, name the package. Node resolves `guardrails-core` by walking
 * up from the hook process's cwd, which is correct under npm hoisting, pnpm and
 * subpackage adoption alike — the layouts a constructed absolute path splits on.
 *
 * The literal `guardrails` fills the `argv[1]` slot a script path normally
 * occupies, so `process.argv.slice(2)` in `cli.ts` keeps working unchanged.
 */
export const CLI_PREFIX = `node -e "import('guardrails-core/cli')" guardrails`;

/** The full command string for one subcommand, e.g. `gate --mode=stop`. */
export function cliCommand(subcommand: string): string {
  return `${CLI_PREFIX} ${subcommand}`;
}
```

- [ ] **Step 2: Write the failing assertions — Codex**

In `guardrails-core/test/codex-hooks-config.test.ts`, add to the imports:

```ts
import { CLI_PREFIX, cliCommand } from './hook-command.js';
```

Replace the whole `it('resolves the installed CLI from the Git top-level', ...)`
block (its name is now wrong too) with:

```ts
it('resolves the CLI by package name, never by a constructed path', () => {
  for (const event of Object.keys(config.hooks)) {
    for (const hook of commands(event)) {
      expect(hook.command).toContain(CLI_PREFIX);
      expect(hook.command).not.toContain('node_modules');
      expect(hook.command).not.toContain('git rev-parse');
      expect(hook.command).not.toContain('CLAUDE_PROJECT_DIR');
    }
  }
});

it('spells each lifecycle command exactly', () => {
  expect(commands('SessionStart')[0]?.command).toBe(
    cliCommand('session-start'),
  );
  expect(commands('SessionEnd')[0]?.command).toBe(cliCommand('session-end'));
  expect(commands('PostToolUse')[0]?.command).toBe(cliCommand('autofix'));
  expect(commands('Stop')[0]?.command).toBe(
    cliCommand('gate --mode=stop --dialect=codex'),
  );
});
```

- [ ] **Step 3: Write the failing assertions — Copilot**

In `guardrails-core/test/github-hooks-config.test.ts`, add to the imports:

```ts
import { CLI_PREFIX, cliCommand } from './hook-command.js';
```

Add these two tests inside the existing
`describe('.github/hooks/guardrails.json', ...)`:

```ts
it('resolves the CLI by package name, never by a constructed path', () => {
  // The regression this file exists to prevent: CLAUDE_PROJECT_DIR is Claude
  // Code's variable. Copilot never sets it, so `${CLAUDE_PROJECT_DIR:-.}`
  // always took the `.` branch and resolved to the process cwd under a name
  // that claimed otherwise.
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        expect(hook.command).toContain(CLI_PREFIX);
        expect(hook.command).not.toContain('CLAUDE_PROJECT_DIR');
        expect(hook.command).not.toContain('node_modules');
      }
    }
  }
});

it('spells each Copilot command exactly', () => {
  const stop = config.hooks.agentStop?.[0]?.hooks[0]?.command;
  expect(stop).toBe(cliCommand('gate --mode=stop --dialect=copilot'));
  const post = config.hooks.postToolUse?.[0]?.hooks[0]?.command;
  expect(post).toBe(cliCommand('autofix'));
});
```

- [ ] **Step 4: Write the failing assertion — plugin**

In `guardrails-core/test/plugin-hooks.test.ts`, add to the imports:

```ts
import { cliCommand } from './hook-command.js';
```

Replace the body of `it('wires the self-filtering scope-check session-wide', ...)`:

```ts
expect(commandsFor('PreToolUse')).toContain(cliCommand('scope-check'));
```

- [ ] **Step 5: Run all four suites to verify they fail**

Run:

```bash
npx vitest run guardrails-core/test/codex-hooks-config.test.ts guardrails-core/test/github-hooks-config.test.ts guardrails-core/test/plugin-hooks.test.ts
```

Expected: FAIL. Codex fails on `git rev-parse`, Copilot on
`CLAUDE_PROJECT_DIR`, plugin on the exact-string mismatch.

- [ ] **Step 6: Rewrite the four hook configs**

In each file below, replace every `command` value's prefix — everything up to
and including the closing quote of the `cli.mjs` path — with
`node -e \"import('guardrails-core/cli')\" guardrails`, leaving the subcommand
and flags untouched. Timeouts, matchers and event names do not change.

`.claude/settings.json` and `guardrails-plugin/hooks/hooks.json` (identical five
commands in both):

```json
"command": "node -e \"import('guardrails-core/cli')\" guardrails scope-check"
"command": "node -e \"import('guardrails-core/cli')\" guardrails autofix"
"command": "node -e \"import('guardrails-core/cli')\" guardrails gate --mode=stop"
"command": "node -e \"import('guardrails-core/cli')\" guardrails session-start"
"command": "node -e \"import('guardrails-core/cli')\" guardrails session-end"
```

`.codex/hooks.json` (six commands):

```json
"command": "node -e \"import('guardrails-core/cli')\" guardrails session-start"
"command": "node -e \"import('guardrails-core/cli')\" guardrails session-end"
"command": "node -e \"import('guardrails-core/cli')\" guardrails scope-check --dialect=codex"
"command": "node -e \"import('guardrails-core/cli')\" guardrails gate --mode=pretooluse --dialect=codex"
"command": "node -e \"import('guardrails-core/cli')\" guardrails autofix"
"command": "node -e \"import('guardrails-core/cli')\" guardrails gate --mode=stop --dialect=codex"
```

(`scope-check --dialect=codex` appears twice — once under the
`Bash|Shell|PowerShell|mcp__.*` matcher, once under `apply_patch|Edit|Write`.)

`.github/hooks/guardrails.json` (four commands):

```json
"command": "node -e \"import('guardrails-core/cli')\" guardrails autofix"
"command": "node -e \"import('guardrails-core/cli')\" guardrails gate --mode=pretooluse --dialect=copilot"
"command": "node -e \"import('guardrails-core/cli')\" guardrails scope-check --dialect=copilot"
"command": "node -e \"import('guardrails-core/cli')\" guardrails gate --mode=stop --dialect=copilot"
```

- [ ] **Step 7: Run the three suites to verify they pass**

Run:

```bash
npx vitest run guardrails-core/test/codex-hooks-config.test.ts guardrails-core/test/github-hooks-config.test.ts guardrails-core/test/plugin-hooks.test.ts
```

Expected: PASS.

- [ ] **Step 8: Regenerate the shipped templates**

Run: `npm run build`
Then confirm the three generated templates moved:

```bash
git diff --stat -- guardrails-core/templates
```

Expected: `claude/settings.hooks.json`, `codex/hooks.json` and
`copilot/hooks/guardrails.json` all changed. If they did not, `sync-agents.mjs`
did not run — re-run `npm run build`.

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run`
Expected: PASS. `templates.test.ts` and `scaffold/templates.test.ts` assert file
presence and event names, not command strings, so they stay green.

- [ ] **Step 10: Commit**

```bash
git add guardrails-core/test/hook-command.ts guardrails-core/test/codex-hooks-config.test.ts guardrails-core/test/github-hooks-config.test.ts guardrails-core/test/plugin-hooks.test.ts .claude/settings.json .codex/hooks.json .github/hooks/guardrails.json guardrails-plugin/hooks/hooks.json guardrails-core/templates
git commit -m "fix(hooks): resolve the CLI by package name on every surface

The Copilot config carried \${CLAUDE_PROJECT_DIR:-.} — Claude Code's variable,
copy-pasted into a host that never sets it, so the fallback always fired and
the command silently resolved against the process cwd under a name claiming
otherwise. It shipped because github-hooks-config.test.ts asserted the dialect
flags and the envelope and nothing whatsoever about the path.

All four emitters now share one string that names the package instead of
locating it, asserted against a single constant so a repeat is impossible
rather than unlikely. Node's upward walk then covers npm hoisting, pnpm and
subpackage adoption alike, and the string carries no \$() and no \${VAR}, so
whether a host's hook runner performs expansion stops mattering."
```

---

### Task 3: `resolveRepoRoot` finds `.git` before it spawns git

`src/repo-root.ts` shells out to `git rev-parse --show-toplevel` on every call.
A `.git` findUp returns the identical answer — verified against a linked
worktree, whose `.git` is a plain file — with no subprocess, and it gives Task 6
something `resolveRepoRoot` cannot: a way to distinguish "found a real repo
root" from "fell back to cwd". That distinction is what keeps the self-check
advisory.

**Files:**

- Create: `guardrails-core/src/path-walk.ts`
- Create: `guardrails-core/test/path-walk.test.ts`
- Modify: `guardrails-core/src/repo-root.ts`
- Modify: `guardrails-core/test/repo-root.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `upwardFrom(start: string): Generator<string>` from `src/path-walk.ts` —
    yields `start` then each ancestor, ending at the filesystem root. Task 4
    consumes it.
  - `findGitRoot(from: string, exists?: (candidate: string) => boolean): string | undefined`
    from `src/repo-root.ts`. Task 6 consumes it.
  - `resolveRepoRoot(exec: Exec, cwd: string, exists?: (candidate: string) => boolean): Promise<string>`
    — signature gains a third optional parameter; existing call sites are
    unaffected.

- [ ] **Step 1: Write the failing test for the walker**

Create `guardrails-core/test/path-walk.test.ts`:

```ts
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { upwardFrom } from '../src/path-walk.js';

describe('upwardFrom', () => {
  it('yields the starting directory first', () => {
    expect([...upwardFrom('/repo/packages/web')][0]).toBe(
      path.resolve('/repo/packages/web'),
    );
  });

  it('yields each ancestor in order and stops at the filesystem root', () => {
    const walked = [...upwardFrom('/repo/packages/web')];
    expect(walked).toEqual([
      path.resolve('/repo/packages/web'),
      path.resolve('/repo/packages'),
      path.resolve('/repo'),
      path.parse(path.resolve('/repo')).root,
    ]);
  });

  it('yields exactly once when started at the filesystem root', () => {
    // The termination case: dirname('/') === '/', so a naive loop never ends.
    const root = path.parse(path.resolve('/')).root;
    expect([...upwardFrom(root)]).toEqual([root]);
  });

  it('resolves a relative start against the working directory', () => {
    expect([...upwardFrom('.')][0]).toBe(process.cwd());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run guardrails-core/test/path-walk.test.ts`
Expected: FAIL — cannot resolve `../src/path-walk.js`.

- [ ] **Step 3: Write the walker**

Create `guardrails-core/src/path-walk.ts`:

```ts
/**
 * Walking up a directory tree, in one place.
 *
 * Two resolvers need it and they must agree: `findGitRoot` looks upward for
 * `.git`, and `resolveLocalBin` looks upward for `node_modules/.bin`. Two
 * hand-rolled loops would be two chances to get the termination condition
 * wrong, and `path.dirname('/') === '/'` makes that loop non-terminating by
 * default rather than by accident.
 */
import path from 'node:path';

/**
 * `start` (resolved against the working directory) followed by each ancestor,
 * ending with the filesystem root. Always yields at least once.
 */
export function* upwardFrom(start: string): Generator<string> {
  let directory = path.resolve(start);
  for (;;) {
    yield directory;
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run guardrails-core/test/path-walk.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests for `findGitRoot`**

In `guardrails-core/test/repo-root.test.ts`, add to the imports:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

and extend the existing `resolveRepoRoot` import:

```ts
import { findGitRoot, resolveRepoRoot } from '../src/repo-root.js';
```

Then add this new suite at the end of the file:

```ts
describe('findGitRoot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'guardrails-root-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks up to a .git directory', () => {
    mkdirSync(path.join(root, '.git'));
    const deep = path.join(root, 'packages', 'web', 'src');
    mkdirSync(deep, { recursive: true });
    expect(findGitRoot(deep)).toBe(root);
  });

  it('treats a .git FILE as the root, which is how linked worktrees look', () => {
    // `git worktree add` writes a FILE containing `gitdir: <path>`, not a
    // directory. An existsSync check covers both; a statSync().isDirectory()
    // check would silently skip every worktree.
    writeFileSync(
      path.join(root, '.git'),
      'gitdir: /elsewhere/.git/worktrees/x',
    );
    expect(findGitRoot(root)).toBe(root);
  });

  it('returns undefined when no .git is found anywhere above', () => {
    expect(findGitRoot(root, () => false)).toBeUndefined();
  });

  it('stops at the nearest .git, not the outermost', () => {
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'vendor', 'library');
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(findGitRoot(nested)).toBe(nested);
  });
});
```

Add `beforeEach` and `afterEach` to the existing vitest import at the top of the
file:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
```

- [ ] **Step 6: Write the failing test for the no-subprocess path**

Still in `guardrails-core/test/repo-root.test.ts`, add inside the existing
`describe('resolveRepoRoot', ...)`:

```ts
it('does not spawn git when a .git is found by walking up', async () => {
  const { exec, calls } = recordingExec(ok('/should-not-be-asked'));
  await expect(
    resolveRepoRoot(
      exec,
      '/repo/packages/api',
      (candidate) => candidate === path.join(path.resolve('/repo'), '.git'),
    ),
  ).resolves.toBe(path.resolve('/repo'));
  expect(calls).toEqual([]);
});
```

- [ ] **Step 7: Make the eight existing `resolveRepoRoot` assertions hermetic**

Those tests exercise the git fallback with paths that do not exist on disk
(`/repo`, `/somewhere`). With a real-filesystem findUp they would pass only
because no `.git` happens to sit above them — a dependency on the machine, not
on the code. Pass an explicit "nothing found" probe to each so they test the
fallback deliberately.

In every existing `resolveRepoRoot(exec, ...)` call inside
`describe('resolveRepoRoot', ...)` — there are eight, excluding the one added in
step 6 — add `() => false` as the third argument. For example:

```ts
await expect(
  resolveRepoRoot(exec, '/repo/packages/api', () => false),
).resolves.toBe('/repo');
```

and, for the recording-exec case:

```ts
await resolveRepoRoot(exec, '/repo/sub', () => false);
```

- [ ] **Step 8: Run the suite to verify the new tests fail**

Run: `npx vitest run guardrails-core/test/repo-root.test.ts`
Expected: FAIL — `findGitRoot` is not exported, and `resolveRepoRoot` takes two
arguments.

- [ ] **Step 9: Rewrite `repo-root.ts`**

Replace the body of `guardrails-core/src/repo-root.ts` below its existing module
docstring (keep that docstring, and add the paragraph shown) with:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Exec } from './exec.js';
import { upwardFrom } from './path-walk.js';

/**
 * The repository root, found by walking up for `.git`, or `undefined` when
 * there is none above `from`.
 *
 * Returning `undefined` rather than falling back is the point: it is the only
 * way a caller can tell "the repo root is X" from "there is no repo here", and
 * the CLI's out-of-repo self-check must skip in the second case rather than
 * reject a directory it cannot bound.
 *
 * `.git` is matched as a plain existence check because a linked worktree's
 * `.git` is a FILE containing `gitdir: <path>`, not a directory. Testing for a
 * directory would silently skip every worktree.
 */
export function findGitRoot(
  from: string,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined {
  for (const directory of upwardFrom(from)) {
    if (exists(path.join(directory, '.git'))) {
      return directory;
    }
  }
  return undefined;
}

export async function resolveRepoRoot(
  exec: Exec,
  cwd: string,
  exists: (candidate: string) => boolean = existsSync,
): Promise<string> {
  // Filesystem first: it returns exactly what `git rev-parse --show-toplevel`
  // returns, including inside a linked worktree, without a subprocess on the
  // hot path — and without requiring git to be installed at all.
  const walked = findGitRoot(cwd, exists);
  if (walked !== undefined) {
    return walked;
  }
  // Kept for the cases a `.git` walk cannot see: GIT_DIR pointing elsewhere,
  // and anything else git knows that the filesystem does not say.
  const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.spawnFailed === true || result.code !== 0) {
    return cwd;
  }
  const toplevel = result.stdout.trim();
  return toplevel === '' ? cwd : toplevel;
}
```

Append this paragraph to the existing module docstring:

```
 * Resolution is filesystem-first as of the CLI-resolution work: walking up for
 * `.git` gives the same answer as `git rev-parse --show-toplevel` with no
 * subprocess, and `findGitRoot` exposes the undecided case the git form cannot
 * express, which the CLI's out-of-repo check needs.
```

- [ ] **Step 10: Run the suite to verify it passes**

Run: `npx vitest run guardrails-core/test/repo-root.test.ts`
Expected: PASS — the eight original assertions plus five new ones.

- [ ] **Step 11: Run the full suite and the graph checks**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: all pass. `scaffold/detect.ts` calls `resolveRepoRoot(exec, cwd)` with
two arguments and still compiles, because the third parameter has a default.

- [ ] **Step 12: Commit**

```bash
git add guardrails-core/src/path-walk.ts guardrails-core/src/repo-root.ts guardrails-core/test/path-walk.test.ts guardrails-core/test/repo-root.test.ts
git commit -m "refactor(repo-root): find .git by walking up before shelling out

git rev-parse --show-toplevel and a .git findUp return the same answer,
worktrees included — a linked worktree's .git is a plain file, so an
existence check covers it where an isDirectory check would not. The walk
costs no subprocess and needs no git binary.

It also exposes something the git form cannot express. resolveRepoRoot falls
back to cwd when there is no repo, which makes 'the root is here' and 'there
is no repo here' the same value; the CLI's out-of-repo check has to skip in
the second case rather than reject a directory it cannot bound, so
findGitRoot returns undefined instead.

The eight existing fallback assertions now pass an explicit nothing-found
probe. They used paths that do not exist on disk, so they would have passed
only as long as no .git sat above them — a property of the machine rather
than of the code."
```

---

### Task 4: `resolveLocalBin` walks up, bounded at the repo

`resolveLocalBin` looks only in `repoRoot/node_modules/.bin`. Under npm hoisting
a subpackage has no `node_modules` at all, so eslint and tsc silently fall
through to whatever is on PATH — a different version than the repo pinned,
producing different findings. It gets the same upward walk as the CLI, stopping
at the repo root so it cannot pick up an ancestor's toolchain.

**Files:**

- Modify: `guardrails-core/src/hook-io.ts:279-283`
- Modify: `guardrails-core/test/hook-io.test.ts` (the `resolveLocalBin` suite)

**Interfaces:**

- Consumes: `upwardFrom` from `src/path-walk.ts` (Task 3).
- Produces: no signature change — `resolveLocalBin(repoRoot: string, tool: string): string`.

- [ ] **Step 1: Write the failing tests**

In `guardrails-core/test/hook-io.test.ts`, add these four tests inside the
existing `describe('resolveLocalBin', ...)`:

```ts
it('finds the bin in an ancestor when the package has no node_modules', () => {
  // npm hoisting: deps live at the monorepo root and packages/web has no
  // node_modules of its own. Before the walk, this fell through to PATH and
  // ran whatever eslint the machine had.
  const binDirectory = path.join(root, 'node_modules', '.bin');
  mkdirSync(binDirectory, { recursive: true });
  const eslint = path.join(binDirectory, 'eslint');
  writeFileSync(eslint, '#!/usr/bin/env node\n');
  chmodSync(eslint, 0o755);
  mkdirSync(path.join(root, '.git'));
  const package_ = path.join(root, 'packages', 'web');
  mkdirSync(package_, { recursive: true });

  expect(resolveLocalBin(package_, 'eslint')).toBe(eslint);
});

it('prefers the nearest bin over an ancestor copy', () => {
  const outer = path.join(root, 'node_modules', '.bin');
  mkdirSync(outer, { recursive: true });
  writeFileSync(path.join(outer, 'eslint'), '');
  mkdirSync(path.join(root, '.git'));
  const package_ = path.join(root, 'packages', 'web');
  const inner = path.join(package_, 'node_modules', '.bin');
  mkdirSync(inner, { recursive: true });
  const nearest = path.join(inner, 'eslint');
  writeFileSync(nearest, '');

  expect(resolveLocalBin(package_, 'eslint')).toBe(nearest);
});

it('stops at the repo root instead of taking an ancestor toolchain', () => {
  // The bound. A bin above the repo is not this repo's pinned version, and
  // silently running it would change what counts as a violation.
  const outside = path.join(root, 'node_modules', '.bin');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'eslint'), '');
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });

  expect(resolveLocalBin(repo, 'eslint')).toBe('eslint');
});

it('still finds a bin at the repo root itself', () => {
  // The boundary is inclusive: the repo root's own node_modules is in scope.
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const binDirectory = path.join(repo, 'node_modules', '.bin');
  mkdirSync(binDirectory, { recursive: true });
  const eslint = path.join(binDirectory, 'eslint');
  writeFileSync(eslint, '');

  expect(resolveLocalBin(repo, 'eslint')).toBe(eslint);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run guardrails-core/test/hook-io.test.ts -t resolveLocalBin`
Expected: FAIL on the first two (returns `'eslint'`); the last two pass already.

- [ ] **Step 3: Implement the bounded walk**

In `guardrails-core/src/hook-io.ts`, add to the imports:

```ts
import { upwardFrom } from './path-walk.js';
```

Replace `resolveLocalBin`:

```ts
export function resolveLocalBin(repoRoot: string, tool: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const name = `${tool}${suffix}`;
  for (const directory of upwardFrom(repoRoot)) {
    const candidate = path.join(directory, 'node_modules', '.bin', name);
    if (existsSync(candidate)) {
      return candidate;
    }
    // Inclusive bound: this directory's node_modules was just checked, and a
    // bin ABOVE the repository is not the version this repo pinned. Running it
    // would silently change what counts as a violation.
    if (existsSync(path.join(directory, '.git'))) {
      break;
    }
  }
  return tool;
}
```

Extend the existing docstring above it with:

```
 * The lookup walks UP from `repoRoot`, because npm hoisting leaves a
 * subpackage with no `node_modules` of its own — before that, eslint and tsc
 * fell through to PATH there and ran an unpinned version. It stops at the
 * repository root: no `.git` anywhere above means no bound to apply, which
 * degrades to a full walk rather than to a failure.
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run guardrails-core/test/hook-io.test.ts -t resolveLocalBin`
Expected: PASS (7 tests — 3 original, 4 new).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Check the sanctions ledger**

Run: `node ./node_modules/guardrails-core/dist/cli.mjs sanctions-check`

`hook-io.ts` carries a recorded mutation-suppression entry keyed by file and
directive text. If this edit moved that directive's line, the declared count no
longer matches and this fails — the same failure mode as commit `9f5d753`.
Expected: exits 0. If it reports a count mismatch for `hook-io.ts`, run
`npm run build` first (the CLI runs from `dist/`), and if it still mismatches,
reconcile the entry in `guardrails.config.json` against the source rather than
deleting the directive.

- [ ] **Step 7: Commit**

```bash
git add guardrails-core/src/hook-io.ts guardrails-core/test/hook-io.test.ts
git commit -m "fix(hook-io): resolve analyzer bins by walking up, bounded at the repo

resolveLocalBin looked only in repoRoot/node_modules/.bin. Under npm hoisting
a subpackage has no node_modules at all, so eslint and tsc fell through to
PATH and ran whatever version the machine had — different findings from the
same code, with no signal.

Same upward walk as the CLI now, and the same inclusive bound: a bin above
the repository is not the version this repo pinned. No .git anywhere above
means no bound to apply, so the walk degrades to unbounded rather than to a
failure."
```

---

### Task 5: The layout matrix, executable

Spec §3 is the evidence the whole design rests on, and it was produced by hand
against throwaway fixtures. This turns it into a test. It is the only test in
the plan that would have caught the original Copilot bug class, because it
exercises resolution itself rather than the string that triggers it.

**Files:**

- Create: `guardrails-core/test/cli-resolution.test.ts`

**Interfaces:**

- Consumes: `CLI_PREFIX` from `test/hook-command.ts` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `guardrails-core/test/cli-resolution.test.ts`:

```ts
/**
 * The resolution contract the generated hook command depends on, as a test.
 *
 * Every hook now runs `node -e "import('guardrails-core/cli')"`, so Node's
 * upward `node_modules` walk — not any code in this repo — decides whether the
 * guardrail runs at all. These are the layouts an adopter can be in; the design
 * they justify is in docs/superpowers/specs/2026-09-02-cli-resolution-design.md
 * §3, and this file is what keeps that section honest.
 *
 * The fixtures install a SYNTHETIC package rather than the real build: the
 * subject here is Node's resolution algorithm and our `exports` shape, and a
 * synthetic package needs no `dist/` to exist. `package-exports.test.ts` pins
 * the real map; `smoke:tarball` proves the real tarball.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_PREFIX } from './hook-command.js';

let root: string;

beforeEach(() => {
  // realpathSync is load-bearing, not tidiness. On macOS `tmpdir()` is
  // /var/folders/..., a symlink to /private/var/folders/..., and Node returns
  // the REALPATH of a resolved module — the same property that puts this repo's
  // workspace symlink inside its own repo (spec §3, layout E). Without this,
  // every `self` assertion below compares /private/var against /var and fails.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'guardrails-resolve-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Install a synthetic guardrails-core into `<where>/node_modules`. */
function install(where: string): string {
  const installed = path.join(where, 'node_modules', 'guardrails-core', 'dist');
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    path.join(where, 'node_modules', 'guardrails-core', 'package.json'),
    JSON.stringify({
      name: 'guardrails-core',
      version: '0.0.0-fixture',
      type: 'module',
      exports: { './cli': './dist/cli.mjs' },
    }),
  );
  const cli = path.join(installed, 'cli.mjs');
  writeFileSync(
    cli,
    [
      "import { fileURLToPath } from 'node:url';",
      'console.log(JSON.stringify({',
      '  self: fileURLToPath(import.meta.url),',
      '  argv: process.argv.slice(2),',
      '}));',
    ].join('\n'),
  );
  return cli;
}

interface Probe {
  status: number | null;
  self: string | undefined;
  argv: string[] | undefined;
  stderr: string;
}

/** Run the exact invocation the hook configs generate, from `cwd`. */
function probe(cwd: string): Probe {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "import('guardrails-core/cli')",
      'guardrails',
      'gate',
      '--mode=stop',
    ],
    { cwd, encoding: 'utf8' },
  );
  const parsed =
    result.status === 0
      ? (JSON.parse(result.stdout) as { self: string; argv: string[] })
      : undefined;
  return {
    status: result.status,
    self: parsed?.self,
    argv: parsed?.argv,
    stderr: result.stderr,
  };
}

describe('hook command resolution', () => {
  it('uses the same specifier the generated hook commands carry', () => {
    // Ties the probe above to the string every config emits, so this file
    // cannot drift into testing an invocation nothing ships.
    expect(CLI_PREFIX).toContain("import('guardrails-core/cli')");
    expect(CLI_PREFIX).toContain('node -e');
  });

  it('passes the subcommand through as argv[2] onward (layout A)', () => {
    // `node -e` puts the first argument at argv[1], where a script path
    // normally sits, so the literal `guardrails` restores the offset
    // `process.argv.slice(2)` in cli.ts expects.
    install(root);
    expect(probe(root).argv).toEqual(['gate', '--mode=stop']);
  });

  it('resolves from a flat install at the repo root (layout A)', () => {
    const cli = install(root);
    expect(probe(root).self).toBe(cli);
  });

  it('resolves an ancestor install from a subpackage (layout B, npm hoisting)', () => {
    const cli = install(root);
    const web = path.join(root, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    expect(probe(web).self).toBe(cli);
  });

  it('resolves through a store symlink (layout C, pnpm-shaped)', () => {
    const web = path.join(root, 'packages', 'web');
    const store = path.join(web, 'node_modules', '.pnpm', 'guardrails-core');
    mkdirSync(store, { recursive: true });
    const real = install(store);
    symlinkSync(
      path.join(store, 'node_modules', 'guardrails-core'),
      path.join(web, 'node_modules', 'guardrails-core'),
    );
    // Resolution returns the REALPATH, which is why this repo's own workspace
    // symlink lands inside the repo and passes the CLI's out-of-repo check.
    expect(probe(web).self).toBe(real);
  });

  it('fails loudly, naming the package and the base (layout D)', () => {
    // Deps only in the subpackage, invoked from the repo root. Genuinely
    // unresolvable — no strategy fixes it — but the error says where it looked,
    // unlike the empty `$(git rev-parse ...)` expansion this replaces, which
    // produced "/node_modules/..." and an opaque MODULE_NOT_FOUND.
    const web = path.join(root, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    install(web);
    const result = probe(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('guardrails-core');
    expect(result.stderr).toContain('[eval]');
  });

  it('reaches an install ABOVE the repo, which is why the CLI bounds itself (layout F)', () => {
    // Node's walk does not stop at a repository. This is the escape the
    // out-of-repo self-check exists to catch; asserting it here keeps the
    // justification for that check from becoming folklore.
    const cli = install(root);
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(probe(repo).self).toBe(cli);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run guardrails-core/test/cli-resolution.test.ts`
Expected: PASS (7 tests). No production code changes — this task documents
behaviour Tasks 1 and 2 already rely on. If layout D or F fails, stop: a Node
version change has invalidated spec §3 and the design needs revisiting.

- [ ] **Step 3: Commit**

```bash
git add guardrails-core/test/cli-resolution.test.ts
git commit -m "test(resolution): pin the layout matrix the hook command relies on

Every hook now runs node -e \"import('guardrails-core/cli')\", so Node's
upward walk — not any code here — decides whether the guardrail runs. Spec
section 3 was measured by hand against throwaway fixtures; this makes those
measurements executable.

Layouts D and F earn their place: D proves the unresolvable case fails while
naming the package and the base, where the empty git-rev-parse expansion it
replaces produced /node_modules/... and an opaque MODULE_NOT_FOUND. F proves
the walk really does reach past a repository, which is the entire
justification for the CLI's out-of-repo check."
```

---

### Task 6: The CLI refuses to run from outside the repo

Landed last, deliberately: this check is fatal, so a misfire fails every hook
closed at once. Node's walk reaches past the repository (Task 5, layout F), so a
stray `~/node_modules/guardrails-core` can guard a repo that never installed it,
at whatever version that ancestor holds, silently.

**Files:**

- Modify: `guardrails-core/src/cli-core.ts:54-60` and `:525`
- Modify: `guardrails-core/src/cli.ts`
- Modify: `guardrails-core/test/cli-core.test.ts:41-50`
- Modify: `guardrails-core/test/scaffold/init-command.test.ts:74-83`

**Interfaces:**

- Consumes: `findGitRoot` from `src/repo-root.ts` (Task 3); `isWithinRepo` from
  `src/scope.ts` (existing: `isWithinRepo(repoRoot: string, candidate: string): boolean`).
- Produces: `CliDeps` gains a required `selfPath: string`.

- [ ] **Step 1: Write the failing tests**

In `guardrails-core/test/cli-core.test.ts`, add this suite at the end:

```ts
describe('out-of-repo self-check', () => {
  it('refuses to run when resolved from outside the repository', async () => {
    // Node's node_modules walk does not stop at the repo, so an install in an
    // ancestor directory satisfies it. Guarding a repo with a version nobody
    // in it chose, silently, is worse than not running.
    mkdirSync(path.join(root, '.git'));
    const outside = path.join(
      path.dirname(root),
      'node_modules',
      'guardrails-core',
      'dist',
      'cli.mjs',
    );

    const code = await runCommand('verify', [], deps({ selfPath: outside }));

    expect(code).not.toBe(0);
    expect(errors.join('')).toContain(outside);
    expect(errors.join('')).toContain(root);
  });

  it('runs normally when resolved from inside the repository', async () => {
    mkdirSync(path.join(root, '.git'));
    const inside = path.join(
      root,
      'node_modules',
      'guardrails-core',
      'dist',
      'cli.mjs',
    );

    const code = await runCommand('verify', [], deps({ selfPath: inside }));

    expect(code).toBe(0);
    expect(errors.join('')).not.toContain('outside');
  });

  it('skips the check when there is no repository to bound', async () => {
    // Advisory, not authoritative: a non-git directory has no boundary, so the
    // check must degrade to today's behaviour rather than reject a directory
    // it cannot bound. `root` has no .git here.
    const outside = path.join(path.dirname(root), 'elsewhere', 'cli.mjs');

    const code = await runCommand('verify', [], deps({ selfPath: outside }));

    expect(code).toBe(0);
    expect(errors.join('')).not.toContain('outside');
  });
});
```

- [ ] **Step 2: Add `selfPath` to both test helpers**

In `guardrails-core/test/cli-core.test.ts`, in `function deps(...)`, add to the
returned object before the `...over` spread:

```ts
    selfPath: path.join(root, 'node_modules', 'guardrails-core', 'dist', 'cli.mjs'),
```

Do the same in `guardrails-core/test/scaffold/init-command.test.ts`'s `deps(...)`.

`blockingCommitDeps` returns `deps({ exec })` and `blockingPreToolUseDeps`
spreads it, so neither needs a change.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `npx vitest run guardrails-core/test/cli-core.test.ts -t "out-of-repo"`
Expected: FAIL — `selfPath` is not a property of `CliDeps`, so the file does not
typecheck; the first test also fails on exit code 0.

- [ ] **Step 4: Implement the check**

In `guardrails-core/src/cli-core.ts`, add `findGitRoot` to the existing
`repo-root.js` import (create the import if the file has none):

```ts
import { findGitRoot } from './repo-root.js';
```

Add the field to `CliDeps`:

```ts
export interface CliDeps {
  exec: Exec;
  readStdin: () => Promise<string>;
  cwd: string;
  /**
   * Where this CLI was resolved from, as a filesystem path. Injected rather
   * than read from `import.meta.url` here so the check has a test seam.
   */
  selfPath: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
```

Add this function immediately above `runCommand`:

```ts
/**
 * The message for a CLI that resolved from outside the repository it is about
 * to guard, or `undefined` when it did not — or when there is no repository to
 * bound it against.
 *
 * Node resolves `guardrails-core` by walking up from the hook's cwd, and that
 * walk does not stop at the repository (spec §3, layout F). So a stray install
 * in an ancestor — `~/node_modules`, typically — satisfies every hook in a repo
 * that never installed guardrails, at whatever version that ancestor holds,
 * with no signal at all.
 *
 * `findGitRoot` rather than `resolveRepoRoot`: the latter falls back to `cwd`,
 * which would make "no repository here" indistinguishable from "the root is
 * cwd" and reject the hoisted-subpackage layout the walk exists to support.
 */
function outsideRepoMessage(deps: CliDeps): string | undefined {
  const repoRoot = findGitRoot(deps.cwd);
  if (repoRoot === undefined || isWithinRepo(repoRoot, deps.selfPath)) {
    return undefined;
  }
  return (
    `guardrails: resolved from ${deps.selfPath}, which is outside ` +
    `${repoRoot}. Install guardrails-core in this repository ` +
    `(npm install) rather than relying on a parent directory's ` +
    `node_modules.\n`
  );
}
```

Add this as the first statement inside `runCommand`, before the `switch`:

```ts
const outside = outsideRepoMessage(deps);
if (outside !== undefined) {
  deps.stderr(outside);
  return 1;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run guardrails-core/test/cli-core.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the real path in `cli.ts`**

In `guardrails-core/src/cli.ts`, add to the imports:

```ts
import { fileURLToPath } from 'node:url';
```

and add the field to the `deps` object literal:

```ts
  selfPath: fileURLToPath(import.meta.url),
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: PASS.

- [ ] **Step 8: Prove it against the real build, in this repo**

Run:

```bash
npm run build
node -e "import('guardrails-core/cli')" guardrails verify; echo "exit=$?"
```

Expected: the normal `verify` output, NOT the out-of-repo message. This is the
dogfooding case: `node_modules/guardrails-core` is a workspace symlink to
`./guardrails-core`, and because Node returns the realpath, `selfPath` lands
inside the repo. If this prints the out-of-repo message, stop and fix it before
committing — every hook in this repo is about to run this code path.

- [ ] **Step 9: Commit**

```bash
git add guardrails-core/src/cli-core.ts guardrails-core/src/cli.ts guardrails-core/test/cli-core.test.ts guardrails-core/test/scaffold/init-command.test.ts
git commit -m "feat(cli): refuse to run when resolved from outside the repository

Node's node_modules walk does not stop at a repository, so a stray install in
an ancestor directory — ~/node_modules, typically — satisfies every hook in a
repo that never installed guardrails, at whatever version that ancestor
holds, with nothing to indicate it happened.

Bounded with findGitRoot rather than resolveRepoRoot: the latter falls back
to cwd, which makes 'no repository here' indistinguishable from 'the root is
cwd' and would reject the hoisted-subpackage layout the walk exists to
support. No repository found means no bound to apply, so the check skips.

selfPath is injected through CliDeps rather than read from import.meta.url in
cli-core, keeping cli.ts a thin wire and the check inside the tested seam."
```

---

### Task 7: Stop telling adopters to run `npx guardrails`

`guardrails` is a real package on the public npm registry, version 2.4.1, owned
by someone else. `npx guardrails verify` on a repo whose install is broken or
absent fetches and executes it. This repo already decided against npx twice —
`hook-io.ts` ("avoids npx's overhead/registry check") and the consumer CI
template — but the adopter-facing docs still say it.

**Files:**

- Modify: `docs/adoption.md:33-34` and `:128`
- Modify: `README.md:43-44`
- Modify: `CLAUDE.md:42`
- Modify: `docs/live-loop-verification.md:20`
- Modify: `docs/copilot-live-loop-verification.md:22-23`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Replace the npx invocations**

In `docs/adoption.md`, replace the `init` block:

````markdown
```bash
node ./node_modules/guardrails-core/dist/cli.mjs init --plan   # print what would be written; touches nothing
node ./node_modules/guardrails-core/dist/cli.mjs init --apply  # write it
```

Invoked by path rather than `npx guardrails`: npx resolves a bin NAME, and
`guardrails` is a package on the public registry that this project does not own.
On a broken or missing install, npx fetches and runs that one. The path form can
only ever run what you installed.
````

and the `verify` block:

````markdown
```bash
node ./node_modules/guardrails-core/dist/cli.mjs verify
```
````

In `README.md`, replace its `init` block with the same two-line path form (no
need to repeat the explanation there — link it):

````markdown
```bash
node ./node_modules/guardrails-core/dist/cli.mjs init --plan   # see what it would write; nothing touches disk
node ./node_modules/guardrails-core/dist/cli.mjs init --apply  # write it
```

(Invoked by path, not `npx` — see `docs/adoption.md` for why.)
````

- [ ] **Step 2: Correct the hook command shown in the docs**

Four documents describe the old hook command and are now wrong.

In `CLAUDE.md`, in the Setup section, replace the sentence beginning
"The Stop hook runs" with:

```markdown
The Stop hook runs
`node -e "import('guardrails-core/cli')" guardrails gate --mode=stop`, which
resolves `guardrails-core` through Node's own upward `node_modules` walk. `dist/`
is gitignored, so a fresh worktree needs a build — `npm install` does it (the
`prepare` script builds after install). If a hook errors with
`ERR_MODULE_NOT_FOUND` for `guardrails-core`, run `npm run build`.
```

In `docs/live-loop-verification.md`, replace the
`node ".../guardrails-core/dist/cli.mjs" gate --mode=stop` reference with
`node -e "import('guardrails-core/cli')" guardrails gate --mode=stop`.

In `docs/copilot-live-loop-verification.md`, replace the "If any hook errors
with a missing `cli.mjs`" phrasing with "If any hook errors with
`ERR_MODULE_NOT_FOUND` for `guardrails-core`".

- [ ] **Step 3: Verify no stale invocation survives**

Run:

```bash
grep -rn "npx guardrails" --include=*.md . | grep -v node_modules | grep -v docs/superpowers/plans
grep -rn 'CLAUDE_PROJECT_DIR.*cli\.mjs' --include=*.json --include=*.md . | grep -v node_modules | grep -v docs/superpowers
```

Expected: no output from either. Historical plan documents under
`docs/superpowers/plans/` are records of past decisions and are left alone.

- [ ] **Step 4: Run the checks**

Run: `npm run format:check && npx vitest run`
Expected: PASS. If `format:check` fails, run `npm run format`.

- [ ] **Step 5: Commit**

```bash
git add docs/adoption.md README.md CLAUDE.md docs/live-loop-verification.md docs/copilot-live-loop-verification.md
git commit -m "docs: stop telling adopters to run npx guardrails

\`guardrails\` is a real package on the public npm registry, version 2.4.1,
owned by someone else. \`npx guardrails verify\` on a repo whose install is
broken or absent fetches and executes it. This repo had already decided
against npx twice — resolveLocalBin's docstring and the consumer CI template
both say so — but the adopter-facing docs still said otherwise.

Also corrects the four documents that describe the hook command, which no
longer builds a path to cli.mjs."
```

---

## Final Verification

- [ ] **Full gate**

```bash
npm run build
npm run test:coverage && npm run check:graph
node ./node_modules/guardrails-core/dist/cli.mjs gate --mode=commit; echo "exit=$?"
node ./node_modules/guardrails-core/dist/cli.mjs sanctions-check; echo "exit=$?"
npm run smoke:tarball
```

All must pass. `gate --mode=commit` runs verify plus the diff-auditor plus the
sanction budget — the diff-auditor is what would catch a suppression added to
get any of the above green.

- [ ] **Generated output is committed**

```bash
git status --short -- guardrails-core/templates .github/agents
```

Expected: empty. CI runs `git diff --exit-code` over both.

- [ ] **Mutation check on the new logic**

```bash
npx stryker run --mutate 'guardrails-core/src/path-walk.ts,guardrails-core/src/repo-root.ts'
```

The two walk terminations and the `findGitRoot` undefined return are the
survivors to look for; a surviving mutant here means the advisory-skip
behaviour is not actually pinned.

## Rollout

Hooks and agents load at session start, so **none of this takes effect in the
session that writes it.** After the final verification:

- [ ] Tell the developer to start a fresh Claude Code session.
- [ ] Re-run `docs/live-loop-verification.md` end to end.
- [ ] Re-run `docs/copilot-live-loop-verification.md`. Treat its expectations
      with suspicion: the Copilot hook path never worked, so any step that
      passed before may have been passing for the wrong reason.
- [ ] If the loop bricks, comment out the `Stop` entry in
      `.claude/settings.json` (CLAUDE.md's kill-switch). Husky pre-push and CI
      remain the hard backstops.

## Notes for the executor

- **The stacking.** This branch is `worktree-cli-resolution`, based on
  `origin/codex-pr16-adoption-ready` (PR 19), which is itself based on
  `worktree-phase-c-stryker` (PR 16). Do not retarget it.
- **`npm install` first** in a fresh worktree — `dist/` is gitignored and the
  `prepare` script builds after install.
- **Task 6 is fatal-on-failure by design.** Its step 8 is not optional: it is
  the only check that proves this repo's own loop still runs.
- **If the guardrail loop misbehaves while you work** — oscillates, weakens a
  test, over-reads — that is a finding, not a nuisance. Record it in `plan.md`
  under "Roadmap: fixer-loop hardening" per CLAUDE.md, rather than routing
  around it.
