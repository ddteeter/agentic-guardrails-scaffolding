# Phase E piece 3 — packaging and release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `guardrails-core` installable. Today it is `version: 0.0.0`, has
never been published, ships only `dist` and `guidance`, and the hooks and fixer
agents a consumer needs live in `guardrails-plugin/`, which they have no way to
obtain.

**Architecture:** The npm tarball becomes the only delivery vehicle.
`scripts/sync-agents.mjs` gains a third destination, `guardrails-core/templates/`,
carrying the consumer-facing wiring; `files` grows to include it. A tag-triggered
workflow packs the tarball and attaches it to a GitHub Release, and a CI smoke
test installs that tarball into a throwaway fixture repo to prove it actually
works — the one check that catches a missing `files` entry, a broken bin shebang,
or an ESM resolution failure, all of which the workspace symlink hides today.

**Tech Stack:** Node ≥24 ESM, npm, GitHub Actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-phase-e-adoption-design.md` §5

## Global Constraints

- **`guardrails-core` has zero runtime dependencies.** Do not add one, and do not
  add a devDependency to `guardrails-core/package.json` without saying why.
- **TDD** where there is logic to test. Some of this piece is configuration and
  workflow YAML, which is verified by running it rather than by unit tests — each
  task says which it is.
- **Never weaken a gate to pass it.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, deleted assertions, or raised thresholds.
- **Never add a `sanctionedSuppressions` entry or a `// Stryker disable`
  directive without asking the developer first** (see `CLAUDE.md`). The config
  has exactly 27 entries and must still have 27 at the end of this piece.
- TypeScript strictness is `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`.
- No abbreviations in identifiers; no unused parameters.
- Run every command under the repo's pinned Node (`.nvmrc` = 24) by prefixing
  `mise exec --`. The shell default here is Node 25, which dependency-cruiser
  refuses; the commit gate then fails with a confusing `analyzer-failed`.
- Commit in small logical steps.

---

## Decisions this plan makes, and why

Two places where the spec cannot be followed literally. Both are recorded here
rather than discovered mid-task.

**1. The smoke test cannot run `guardrails init --plan`.** Spec §5.3 specifies
that command, but `init` is piece 4 and does not exist yet. This piece's smoke
test therefore exercises what does exist — the bin resolving, ESM loading, and
the usage banner — plus an assertion on the tarball's actual contents, which is
where most of the value is anyway. **Piece 4 upgrades the smoke test to run
`init --plan` once that command lands.** A task in piece 4's plan must do this;
it is noted in Task 6 below.

**2. The CI workflow template is NOT shipped by this piece.** Spec §5.1 lists it
among the tarball's contents, but spec §9.1 (piece 6) is where that workflow's
content is designed, and authoring consumer CI content inside a packaging task
would be inventing it in the wrong place. This piece ships templates for the four
wiring artifacts that already exist; **piece 6 adds `guardrails.yml` to the same
`templates/` directory**, which requires no change to the machinery built here.
Since pieces 3-6 land in one pull request, the tarball is complete before any
release is cut.

**3. Templates are this repo's own live wiring, not a second copy.** The sync
script copies `.claude/settings.json`'s hook block, `.github/hooks/guardrails.json`,
and `.githooks/pre-commit` into `templates/`, and emits the fixer agents there
from `guardrails-plugin/agents/` exactly as it already does for `.claude/agents/`
and `.github/agents/`. All three wiring files are already consumer-generic — they
contain no path specific to this repo. Making them the template source means
drift between what this repo dogfoods and what it ships to a consumer is
structurally impossible, and CI's existing `git diff --exit-code` drift-guard
extends to cover it.

---

## File Structure

**Create:**

- `guardrails-core/templates/` — generated, **committed** (like `.github/agents/`,
  and for the same reason: it must be present in a fresh clone and in the tarball
  without depending on a build having run). Contents:
  - `claude/agents/guardrail-fixer.md`, `claude/agents/guardrail-fixer-thorough.md`
  - `claude/settings.hooks.json` — the `hooks` block `init` merges into a
    consumer's `.claude/settings.json`
  - `copilot/agents/guardrail-fixer.agent.md`, `copilot/agents/guardrail-fixer-thorough.agent.md`
  - `copilot/hooks/guardrails.json`
  - `githooks/pre-commit`
- `scripts/smoke-tarball.mjs` — packs, installs into a temp fixture repo, and
  asserts the result works.
- `.github/workflows/release.yml` — tag-triggered pack + GitHub Release.

**Modify:**

- `scripts/sync-agents.mjs` — emit `guardrails-core/templates/`.
- `guardrails-core/package.json` — `version` 0.0.0 → 0.1.0; `files` gains
  `templates`.
- `.github/workflows/ci.yml` — extend the drift-guard to `templates/`; add the
  smoke-test step.
- `package.json` (root) — a `smoke:tarball` script.
- `README.md` — install instructions and the URL-dependency caveat.

---

## Task 1: Emit the templates directory

**Files:**

- Modify: `scripts/sync-agents.mjs`
- Create (generated): `guardrails-core/templates/**`

**Interfaces:**

- Consumes: `guardrails-plugin/agents/*.md`, `.claude/settings.json`,
  `.github/hooks/guardrails.json`, `.githooks/pre-commit`.
- Produces: `guardrails-core/templates/` with the six files listed in File
  Structure. Piece 4's `init` reads this directory out of the installed package.

This task is build tooling, not application logic; it is verified by running the
build and inspecting the output, and then pinned by Task 2's test.

- [ ] **Step 1: Read the existing script**

Read `scripts/sync-agents.mjs` end to end before changing it. It already emits
three destinations from two sources and has a clear-then-write discipline (it
`rmSync`s each destination first, so a renamed or deleted source cannot leave a
stale generated file behind). Follow that discipline exactly.

- [ ] **Step 2: Add the templates emitter**

Append to `scripts/sync-agents.mjs`, after the existing Copilot-agent block:

```js
// Consumer-facing templates, shipped in the npm tarball (`files`) and written
// into a target repo by `guardrails init` (piece 4). The SOURCES are this
// repo's own live wiring: what we dogfood is exactly what we ship, so the two
// cannot drift. All three wiring files are already consumer-generic — they
// reference `${CLAUDE_PROJECT_DIR}` / `./node_modules`, never a path specific
// to this repo. Committed and CI drift-guarded, like .github/agents.
const templates = path.join(root, 'guardrails-core', 'templates');
rmSync(templates, { recursive: true, force: true });

const claudeAgents = path.join(templates, 'claude', 'agents');
mkdirSync(claudeAgents, { recursive: true });
for (const file of agents) {
  copyFileSync(path.join(from, file), path.join(claudeAgents, file));
}

const copilotAgents = path.join(templates, 'copilot', 'agents');
mkdirSync(copilotAgents, { recursive: true });
for (const file of agents) {
  const target = file.replace(/\.md$/, '.agent.md');
  // toCopilotAgent takes the file CONTENTS, not a path -- match the existing
  // .github/agents emitter above, which reads the file first.
  writeFileSync(
    path.join(copilotAgents, target),
    toCopilotAgent(readFileSync(path.join(from, file), 'utf8')),
  );
}

// Only the `hooks` block: a consumer's .claude/settings.json is THEIR file, and
// `init` merges this in rather than replacing it.
const claudeSettings = JSON.parse(
  readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'),
);
mkdirSync(path.join(templates, 'claude'), { recursive: true });
writeFileSync(
  path.join(templates, 'claude', 'settings.hooks.json'),
  `${JSON.stringify({ hooks: claudeSettings.hooks }, undefined, 2)}\n`,
);

const copilotHooks = path.join(templates, 'copilot', 'hooks');
mkdirSync(copilotHooks, { recursive: true });
copyFileSync(
  path.join(root, '.github', 'hooks', 'guardrails.json'),
  path.join(copilotHooks, 'guardrails.json'),
);

const gitHooks = path.join(templates, 'githooks');
mkdirSync(gitHooks, { recursive: true });
copyFileSync(
  path.join(root, '.githooks', 'pre-commit'),
  path.join(gitHooks, 'pre-commit'),
);

console.log(`synced consumer templates → guardrails-core/templates`);
```

Check the names against the real file before you paste. In the existing script:
`from` is the agent source directory, `agents` is the list of `.md` filenames,
`toCopilotAgent(source)` takes the file's **contents** (the `.github/agents`
emitter above reads the file first — do the same), and `readFileSync`,
`writeFileSync`, `copyFileSync`, `mkdirSync` and `rmSync` are all already
imported. If any of those differ, adapt rather than renaming the existing
bindings.

- [ ] **Step 3: Build and inspect**

Run: `mise exec -- npm run build`
Then: `find guardrails-core/templates -type f | sort`

Expected exactly:

```
guardrails-core/templates/claude/agents/guardrail-fixer-thorough.md
guardrails-core/templates/claude/agents/guardrail-fixer.md
guardrails-core/templates/claude/settings.hooks.json
guardrails-core/templates/copilot/agents/guardrail-fixer-thorough.agent.md
guardrails-core/templates/copilot/agents/guardrail-fixer.agent.md
guardrails-core/templates/copilot/hooks/guardrails.json
guardrails-core/templates/githooks/pre-commit
```

Also confirm `templates/claude/settings.hooks.json` contains the four hook
entries (`SessionStart`, `PostToolUse`, `Stop`, `SessionEnd`) and nothing else
from `.claude/settings.json`.

- [ ] **Step 4: Confirm the output is committed, not ignored**

Run: `git check-ignore -v guardrails-core/templates/githooks/pre-commit || echo "not ignored (correct)"`
Expected: `not ignored (correct)`. `.gitignore` ignores `.claude/agents/` and
`.claude/skills/` because those are regenerated per-clone; `templates/` must be
committed so a fresh clone and the tarball both have it. If it IS ignored, stop
and report — do not edit `.gitignore` to work around it without saying so.

- [ ] **Step 5: Commit**

```bash
mise exec -- git add scripts/sync-agents.mjs guardrails-core/templates
mise exec -- git commit -m "feat(build): emit consumer templates into guardrails-core/templates"
```

---

## Task 2: Pin the template contract with a test

**Files:**

- Create: `guardrails-core/test/templates.test.ts`

**Interfaces:**

- Consumes: the `guardrails-core/templates/` tree from Task 1.
- Produces: nothing. This is the regression net that stops a future edit to the
  sync script from silently dropping a file piece 4 depends on.

- [ ] **Step 1: Write the failing test**

Create `guardrails-core/test/templates.test.ts`:

```ts
/**
 * The consumer template tree is generated by scripts/sync-agents.mjs and
 * committed, and `guardrails init` (piece 4) writes it into a target repo. A
 * file silently dropped from it would produce a consumer whose fixer agents or
 * hooks never got written — which looks like a working install right up until
 * the loop does not fire. These assertions are the contract.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const templates = path.join(import.meta.dirname, '..', 'templates');

const EXPECTED_FILES = [
  'claude/agents/guardrail-fixer.md',
  'claude/agents/guardrail-fixer-thorough.md',
  'claude/settings.hooks.json',
  'copilot/agents/guardrail-fixer.agent.md',
  'copilot/agents/guardrail-fixer-thorough.agent.md',
  'copilot/hooks/guardrails.json',
  'githooks/pre-commit',
] as const;

describe('consumer templates', () => {
  it.each(EXPECTED_FILES)('ships %s', (relative) => {
    expect(existsSync(path.join(templates, relative))).toBe(true);
  });

  it('carries all four Claude hook events', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        path.join(templates, 'claude', 'settings.hooks.json'),
        'utf8',
      ),
    );
    expect(raw).toHaveProperty('hooks');
    const { hooks } = raw as { hooks: Record<string, unknown> };
    expect(Object.keys(hooks).sort()).toEqual([
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
  });

  it('references guardrails-core through node_modules, never a repo-local path', () => {
    // A template that pointed at this repo's own layout would break in every
    // consumer. The hook commands must resolve through the installed package.
    const hooks = readFileSync(
      path.join(templates, 'claude', 'settings.hooks.json'),
      'utf8',
    );
    expect(hooks).toContain('node_modules/guardrails-core/dist/cli.mjs');
    expect(hooks).not.toContain('guardrails-core/src');
  });

  it('ships a pre-commit hook that runs the commit gate', () => {
    const hook = readFileSync(
      path.join(templates, 'githooks', 'pre-commit'),
      'utf8',
    );
    expect(hook).toContain('gate --mode=commit');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

First prove it fails for the right reason. Temporarily rename one template:

```bash
mv guardrails-core/templates/githooks/pre-commit /tmp/pre-commit.bak
mise exec -- npx vitest run guardrails-core/test/templates.test.ts
```

Expected: the `githooks/pre-commit` case FAILS. Then restore it:

```bash
mv /tmp/pre-commit.bak guardrails-core/templates/githooks/pre-commit
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `mise exec -- npx vitest run guardrails-core/test/templates.test.ts`
Expected: PASS, 10 cases.

- [ ] **Step 4: Commit**

```bash
mise exec -- git add guardrails-core/test/templates.test.ts
mise exec -- git commit -m "test(templates): pin the consumer template contract"
```

---

## Task 3: Version and package contents

**Files:**

- Modify: `guardrails-core/package.json`

**Interfaces:**

- Consumes: Task 1's `templates/` directory.
- Produces: a package whose `files` includes `templates`, at version `0.1.0`.

- [ ] **Step 1: Make the change**

In `guardrails-core/package.json`:

- `"version": "0.0.0"` → `"version": "0.1.0"`
- `"files": ["dist", "guidance"]` → `"files": ["dist", "guidance", "templates"]`

Change nothing else. In particular do not touch `peerDependencies` or
`peerDependenciesMeta` — the optional-peer arrangement is what lets a consumer
install a subset, which piece 1 made real.

- [ ] **Step 2: Verify the tarball contents**

Run:

```bash
cd guardrails-core && mise exec -- npm pack --dry-run 2>&1 | grep -E 'templates|guidance|dist/cli|package.json' | head -20; cd ..
```

Expected: entries under `templates/`, `guidance/`, and `dist/`, including
`dist/cli.mjs`. If `templates/` is absent, the `files` edit did not take.

- [ ] **Step 3: Commit**

```bash
mise exec -- git add guardrails-core/package.json
mise exec -- git commit -m "chore(release): guardrails-core 0.1.0, ship templates in the tarball"
```

---

## Task 4: The tarball smoke test

**Files:**

- Create: `scripts/smoke-tarball.mjs`
- Modify: `package.json` (root) — add a `smoke:tarball` script

**Interfaces:**

- Consumes: the packed tarball.
- Produces: a script that exits non-zero when the published artifact is broken.
  Piece 4 extends it (see Task 6).

This is the load-bearing task of the piece. Everything else here is
configuration; this is the only check that exercises the artifact a consumer
actually installs. A workspace symlink makes `guardrails-core` resolve in this
repo whether or not `files` is correct — so nothing else in the suite can catch a
missing `files` entry, a broken bin shebang, or an ESM resolution failure.

- [ ] **Step 1: Write the script**

Create `scripts/smoke-tarball.mjs`:

```js
#!/usr/bin/env node
/**
 * Prove the published artifact works, not just the source tree.
 *
 * Everything else in the suite runs against this repo, where the npm workspace
 * symlinks `guardrails-core` into `node_modules` — so `files`, the bin shebang,
 * and ESM resolution are all bypassed. A consumer gets none of that. This packs
 * the real tarball, installs it into a throwaway repo the way a consumer would,
 * and runs the CLI out of it.
 *
 * Failure here means a first adoption fails at the first command.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageDirectory = path.join(root, 'guardrails-core');

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function fail(message) {
  console.error(`smoke-tarball: ${message}`);
  process.exit(1);
}

// 1. Pack the real tarball.
const packOutput = run(
  'npm',
  ['pack', '--pack-destination', tmpdir()],
  packageDirectory,
);
const tarballName = packOutput.trim().split('\n').at(-1);
const tarball = path.join(tmpdir(), tarballName);
if (!existsSync(tarball)) {
  fail(`npm pack reported "${tarballName}" but no file exists at ${tarball}`);
}
console.log(`smoke-tarball: packed ${tarballName}`);

// 2. Install it into a throwaway repo, exactly as a consumer would.
const fixture = mkdtempSync(path.join(tmpdir(), 'guardrails-smoke-'));
writeFileSync(
  path.join(fixture, 'package.json'),
  `${JSON.stringify({ name: 'smoke-fixture', version: '1.0.0', private: true }, undefined, 2)}\n`,
);
run('npm', ['install', '--no-audit', '--no-fund', tarball], fixture);
console.log(`smoke-tarball: installed into ${fixture}`);

// 3. The package must carry every directory `files` promises.
const installed = path.join(fixture, 'node_modules', 'guardrails-core');
for (const directory of ['dist', 'guidance', 'templates']) {
  const target = path.join(installed, directory);
  if (!existsSync(target) || readdirSync(target).length === 0) {
    fail(
      `the tarball is missing "${directory}/" — check "files" in guardrails-core/package.json`,
    );
  }
}

// 4. The templates a consumer's install depends on must have survived packing.
for (const relative of [
  'claude/agents/guardrail-fixer.md',
  'claude/settings.hooks.json',
  'copilot/hooks/guardrails.json',
  'githooks/pre-commit',
]) {
  if (!existsSync(path.join(installed, 'templates', relative))) {
    fail(`the tarball is missing templates/${relative}`);
  }
}

// 5. The bin must resolve and the ESM entry must load. `guardrails` with no
//    subcommand prints usage and exits 1 — a real exercise of argv parsing and
//    every top-level import, without needing a git repo or any analyzer.
//    NOTE (piece 4): replace this with `init --plan` once that command exists;
//    it exercises far more of the install path.
let usage = '';
try {
  run(path.join(fixture, 'node_modules', '.bin', 'guardrails'), [], fixture);
  fail(
    '`guardrails` with no arguments exited 0; expected the usage banner and exit 1',
  );
} catch (error) {
  usage = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  if (error.status !== 1) {
    fail(
      `\`guardrails\` exited ${error.status}, expected 1. Output:\n${usage}`,
    );
  }
}
if (!usage.includes('usage: guardrails')) {
  fail(`the CLI ran but printed no usage banner. Output:\n${usage}`);
}

console.log('smoke-tarball: OK — tarball installs and the CLI runs from it');
```

- [ ] **Step 2: Add the npm script**

In the root `package.json` `scripts` block, after `"depcruise"`:

```json
    "smoke:tarball": "node scripts/smoke-tarball.mjs",
```

- [ ] **Step 3: Run it**

Run: `mise exec -- npm run smoke:tarball`
Expected: ends with `smoke-tarball: OK`. It takes tens of seconds — it really
does pack and install.

- [ ] **Step 4: Prove it can fail**

A check that cannot fail is not a check. Temporarily remove `"templates"` from
`guardrails-core/package.json`'s `files`, re-run, and confirm it exits non-zero
with the missing-`templates/` message. Then restore it and re-run to green.
Record both outputs in your report.

- [ ] **Step 5: Commit**

```bash
mise exec -- git add scripts/smoke-tarball.mjs package.json
mise exec -- git commit -m "test(release): smoke-test the packed tarball end to end"
```

---

## Task 5: Wire CI — drift-guard and smoke test

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: Task 1's generated `templates/`, Task 4's `smoke:tarball` script.
- Produces: CI that fails when generated templates are stale or the tarball is
  broken.

- [ ] **Step 1: Extend the drift-guard**

`ci.yml` has a step named `Skill docs in sync (generated docs committed)` running
`git diff --exit-code -- docs/guardrails guardrails-core/guidance .github/copilot-instructions.md`.
Add `guardrails-core/templates` to that same path list, and extend the step's
comment to say that templates are generated from this repo's own live wiring, so
a drift here means the shipped template no longer matches what this repo runs.

- [ ] **Step 2: Add the smoke-test step**

After the `Fallow graph gate` step, append:

```yaml
# The only check that exercises the artifact a consumer installs. Every
# other step runs against the workspace, where guardrails-core is
# symlinked into node_modules — so `files`, the bin shebang and ESM
# resolution are all bypassed here and only here.
- name: Tarball smoke test
  run: npm run smoke:tarball
```

- [ ] **Step 3: Validate the YAML**

Run: `mise exec -- npx prettier --check .github/workflows/ci.yml`
If it reports formatting, run `--write` and re-check. A malformed workflow fails
at GitHub rather than locally, so this parse is the cheapest signal available.

- [ ] **Step 4: Commit**

```bash
mise exec -- git add .github/workflows/ci.yml
mise exec -- git commit -m "ci: guard template drift and smoke-test the tarball"
```

---

## Task 6: The release workflow

**Files:**

- Create: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: the build and `npm pack`.
- Produces: a GitHub Release carrying the tarball, addressable by URL.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

# Tag-triggered. `npm publish` is deliberately NOT used yet: the package is
# delivered as a GitHub Release asset installed by URL while it has no external
# consumers. Migrating later replaces the pack/upload step with
# `npm publish --provenance` and changes nothing else in this file.
on:
  push:
    tags: ['v*']
  workflow_dispatch:

# Least privilege by default; the one job that needs to create a Release
# escalates for itself.
permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        # actions/checkout@v6.0.2
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
        with:
          persist-credentials: false

      - name: Setup Node
        # actions/setup-node@v6.4.0
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
        with:
          node-version: '24'
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      # The tag is the release's claim about what it contains; a tag that does
      # not match the packed version would publish a mislabelled artifact.
      - name: Tag matches package version
        run: |
          tag="${GITHUB_REF_NAME#v}"
          packaged="$(node -p "require('./guardrails-core/package.json').version")"
          if [ "$tag" != "$packaged" ]; then
            echo "tag $GITHUB_REF_NAME does not match guardrails-core version $packaged" >&2
            exit 1
          fi

      # Never ship an artifact the smoke test has not cleared.
      - name: Tarball smoke test
        run: npm run smoke:tarball

      - name: Pack
        run: npm pack --pack-destination .. --workspace guardrails-core

      - name: Create the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" ../guardrails-core-*.tgz --generate-notes
```

Note the two guards that matter: the tag-versus-package-version check stops a
mislabelled artifact, and running the smoke test before packing means a broken
tarball never reaches a Release.

- [ ] **Step 2: Validate**

Run: `mise exec -- npx prettier --check .github/workflows/release.yml`
Then re-read the file once against `.github/workflows/ci.yml`: the checkout and
setup-node actions must be pinned to the same commit SHAs that file uses, so
Dependabot updates both together.

- [ ] **Step 3: Verify `npm pack --workspace` puts the tarball where the workflow expects**

Run: `mise exec -- npm pack --pack-destination /tmp --workspace guardrails-core && ls /tmp/guardrails-core-*.tgz`
Expected: one tarball named `guardrails-core-0.1.0.tgz`. If `--workspace` behaves
differently than assumed, fix the workflow's pack and glob rather than the
assertion.

- [ ] **Step 4: Commit**

```bash
mise exec -- git add .github/workflows/release.yml
mise exec -- git commit -m "ci(release): tag-triggered GitHub Release with the packed tarball"
```

---

## Task 7: Install documentation

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: everything above.
- Produces: the first honest answer to "how do I install this?"

Full adoption documentation is piece 6 (spec §9.2). This task adds only what is
true as of this piece, so the README stops implying the package is unobtainable.

- [ ] **Step 1: Add an Install section**

Add a section after the artifacts table in `README.md`, before "The control loop":

````markdown
## Install

`guardrails-core` is delivered as a GitHub Release asset, not from npm:

```bash
npm i -D https://github.com/ddteeter/agentic-guardrails-scaffolding/releases/download/v0.1.0/guardrails-core-0.1.0.tgz
```
````

**What a URL dependency costs you, stated plainly:** no semver range, no dedupe,
and Dependabot will not track it. Upgrading means editing the URL by hand. This
is deliberate while the package has no external consumers — publishing to npm
later changes this line and nothing else.

Installing the package does not yet wire anything up; `guardrails init`
(piece 4) writes the hooks, fixer agents, and pre-commit hook into your repo.

````

Match the README's existing voice: it states costs alongside capabilities and
does not sell.

- [ ] **Step 2: Format and commit**

```bash
mise exec -- npx prettier --write README.md
mise exec -- git add README.md
mise exec -- git commit -m "docs: how to install guardrails-core, and what a URL dependency costs"
````

---

## Done criteria

- `mise exec -- npm run build` regenerates `guardrails-core/templates/` with
  exactly the seven expected files, and `git status` is clean afterwards (the
  committed output matches the build).
- `mise exec -- npm run lint && mise exec -- npm run typecheck && mise exec -- npx vitest run` all pass.
- `mise exec -- npm run test:coverage && mise exec -- npm run check:graph` passes.
- `mise exec -- npm run smoke:tarball` ends with `smoke-tarball: OK`, **and** has
  been demonstrated to fail when `templates` is removed from `files` (Task 4
  Step 4).
- `mise exec -- node guardrails-core/dist/cli.mjs verify` is clean on this repo.
- `guardrails.config.json` still has exactly 27 `sanctionedSuppressions` entries.
- `guardrails-core/package.json` is at `0.1.0` with
  `files: ["dist", "guidance", "templates"]`.

## Carried into piece 4

- **Upgrade the smoke test** from the usage banner to `guardrails init --plan`
  (`scripts/smoke-tarball.mjs`, step 5). That is the check that proves a consumer
  can actually get started, and it cannot be written until `init` exists.
- `init` reads templates from `<package>/templates/`, resolved relative to the
  installed package rather than the consumer's repo root.

## Carried into piece 6

- Add the consumer CI workflow template as `templates/workflows/guardrails.yml`,
  emitted by the same block in `scripts/sync-agents.mjs` and asserted by
  `templates.test.ts`. The machinery is in place; only the content is missing.
