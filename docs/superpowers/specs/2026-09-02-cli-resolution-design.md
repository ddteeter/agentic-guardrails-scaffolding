# Hook CLI resolution — one rule across every agent surface — Design

How a guardrails hook command finds `cli.mjs`. Today each dialect answers this
differently, one answer is outright broken, and none of them is testable in the
place where it fails. This design replaces four hand-built paths with one rule:
**name the package, let Node resolve it, and never construct a path.**

Judged against adopters, not against this repo. This repo is a single package at
the git root with an npm workspace symlink — the one layout where every current
strategy happens to work, which is exactly why the Copilot bug shipped
unnoticed.

## 0. TL;DR

- **One command string on all four hook emitters**:
  `node -e "import('guardrails-core/cli')" guardrails <subcommand>`. No
  `${VAR}`, no `$(...)`, no host-specific expansion, no subprocess.
- **Node's own upward `node_modules` walk does the layout guessing.** Correct
  under npm hoisting, pnpm, and subpackage adoption alike — the three layouts
  the current strategies split on.
- **The Copilot config is fixed as a side effect**, not as a special case. Its
  `${CLAUDE_PROJECT_DIR:-.}` was a copy-paste of Claude's variable into a host
  that never sets it, so the `:-.` fallback always fired.
- **Resolution is bounded to the repo.** `cli.mjs` self-checks its own resolved
  location and `resolveLocalBin` stops walking at the repo root, so a stray
  ancestor install can never silently guard a repo that never installed us.
- **`resolveRepoRoot` becomes findUp-first**, with `git rev-parse` as fallback.
  One repo-root implementation, no subprocess in the common case, worktrees
  handled natively.
- **`guardrails-core/cli` becomes public API** (an `exports` subpath) and gets a
  test, because every adopter's hooks now depend on it.
- **Two consumer-facing footguns fixed**: `foreignHooksPathWarning()` hands
  adopters a path that cannot resolve under hoisting, and `docs/adoption.md`
  tells them to run `npx guardrails`, which can execute a stranger's package.
- **Out of scope:** the git-hook, husky and CI invocations keep their relative
  path. Those contexts genuinely guarantee cwd, and there a hard failure is the
  correct behaviour.

## 1. What is broken

Three strategies, in generated hook config:

| Surface                                   | Form                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Claude (`.claude/settings.json`)          | `node "${CLAUDE_PROJECT_DIR}/node_modules/.../cli.mjs"`            |
| Codex (`.codex/hooks.json`)               | `node "$(git rev-parse --show-toplevel)/node_modules/.../cli.mjs"` |
| Copilot (`.github/hooks/guardrails.json`) | `node "${CLAUDE_PROJECT_DIR:-.}/node_modules/.../cli.mjs"`         |

There is a fourth emitter that the original framing missed:
`guardrails-plugin/hooks/hooks.json`, the Claude Code plugin's own wiring, using
the same `${CLAUDE_PROJECT_DIR}` form and pinned by an exact-string assertion in
`plugin-hooks.test.ts`.

**Copilot is a bug.** `CLAUDE_PROJECT_DIR` is Claude Code's variable. Copilot
never sets it, so `:-.` always fires and the command silently resolves against
the process cwd under a name that claims otherwise. It came in by copy-paste
from `docs/superpowers/plans/2026-07-16-phase-b-copilot-channel.md:859`.

**It shipped silently because nothing tested it.**
`github-hooks-config.test.ts` asserts the dialect flags and the envelope shape
and says nothing at all about the path. That gap, not the copy-paste, is the
defect worth fixing.

## 2. The correction that reframes the problem

The original framing held that the two absolute strategies "fail on opposite
layouts". They do not. Both build `<root>/node_modules/...` and differ only in
which root. Open a session at a monorepo root under pnpm with guardrails
installed in `packages/web`, and `CLAUDE_PROJECT_DIR` and git-toplevel resolve
to the _same_ wrong directory.

They diverge only when the agent's cwd is not the git root — and in exactly that
case, `input.cwd`, the value that decides what gets _guarded_, sides with the
session. So git-toplevel is the one strategy that can locate a binary under a
root different from the root being guarded.

The real fork is not "which root". It is **whether to guess a root at all.**

## 3. What Node actually does

Measured against real fixtures on Node 24.15.0, not derived from the docs.

For `node -e`, the ESM resolution base is `<cwd>/[eval]` — Node's own error text
names it. A bare specifier walks `<cwd>/node_modules`, then each ancestor's, to
the filesystem root; first hit wins. The package's `exports` map then gates the
subpath, and symlinks are resolved last, so `import.meta.url` is the **realpath**.

| #   | Layout                                             | cwd            | Resolves                 | Lands                                                     |
| --- | -------------------------------------------------- | -------------- | ------------------------ | --------------------------------------------------------- |
| A   | flat `node_modules`                                | repo root      | yes                      | in repo                                                   |
| B   | hoisted monorepo, subpackage has no `node_modules` | `packages/web` | yes                      | repo root's `node_modules`                                |
| C   | pnpm-shaped (`.pnpm` store + symlink)              | `packages/web` | yes                      | in repo                                                   |
| D   | deps only in subpackage                            | repo root      | **no**                   | `ERR_MODULE_NOT_FOUND`, naming package and base           |
| E   | npm workspaces symlink (**this repo**)             | repo root      | yes                      | `<repo>/guardrails-core/dist/cli.mjs` — realpath, in repo |
| F   | no install in repo, **ancestor directory has one** | repo root      | yes                      | **outside the repo**                                      |
| G   | package only in `$HOME/.node_modules`              | repo root      | **no** (ESM) / yes (CJS) | —                                                         |
| H   | Yarn PnP shape, plain `node`                       | repo root      | **no**                   | —                                                         |

Four consequences:

- **B and C are the whole argument.** They are the layouts `docs/adoption.md:71`
  says we support and that `workspaces.ts` exists to serve, and they are where
  the current strategies split. The upward walk gets both.
- **F is real and justifies bounding.** For a repo at `~/dev/projects/x`, a
  stray `~/node_modules` would silently satisfy it. G shows the _other_ leak —
  the legacy global folders — does not exist for ESM, so F is the only one.
- **H makes the PnP question moot.** Plain `node` resolves nothing under PnP,
  and the current absolute-path forms fail there too since no `node_modules`
  directory exists. PnP is already unsupported; this is not a regression.
- **E is why dogfooding survives.** Because resolution returns the realpath,
  this repo's workspace symlink lands inside the repo and passes the bound.

## 4. The rule

> **Node resolves guardrails-core; we never construct a path to it.** The hook
> command names the package. Resolution starts at the hook process's cwd and
> walks up.

```
node -e "import('guardrails-core/cli')" guardrails <subcommand> [flags]
```

The literal `guardrails` fills the `argv[1]` slot a script path normally
occupies, so `process.argv.slice(2)` in `cli.ts` keeps working untouched.
Verified equivalent to the current form on argv, stdin and exit code.

The only shell syntax is quoting, so the string is identical under `sh`,
`cmd.exe` and PowerShell. This retires two open questions at once: whether
Copilot's hook runner performs command substitution, and what `$(...)` does on
Windows. Neither can matter any more.

Cost, measured over five runs each, warm:

| form                          | ms/run |
| ----------------------------- | ------ |
| `node <abs-path>` (today)     | 26     |
| `node -e "import('pkg/cli')"` | **27** |
| `git rev-parse` subprocess    | 14     |
| `npx --no-install <bin>`      | 172    |

## 5. Bounded resolution

Unbounded resolution is wrong for a tool whose `scope-check` exists to stop
out-of-repo reads. Both halves of "where is `node_modules`" get the same bound,
from one shared source of truth.

- **`resolveRepoRoot(exec, cwd, exists)`** — refactored findUp-first: walk up
  for `.git` (file _or_ directory), falling back to the existing
  `git rev-parse` path, then to `cwd` as it does today. A linked worktree's
  `.git` is a plain file, so the walk is worktree-correct by construction and
  returns exactly what `git rev-parse --show-toplevel` returns — verified. Net
  effect: no subprocess in the common case, and the check no longer depends on
  a git binary being installed.
- **`resolveLocalBin(repoRoot, tool)`** — gains the upward walk for
  `node_modules/.bin`, stopping at the repo root. PATH fallback unchanged.
- **CLI self-check** — `cli.mjs` compares its own resolved location against the
  repo root. Outside it, exit non-zero with a message naming both paths and
  telling the adopter to install guardrails-core in this repo.

The bound is **advisory**: an indeterminate root means skip, never fail.

## 6. Where the logic lives

`cli.ts` stays a thin wire outside the tested seam, so the self-check goes in
`runCommand` in `cli-core.ts`, with the module's own path injected through
`CliDeps` as `selfPath` (set from `fileURLToPath(import.meta.url)` in `cli.ts`)
alongside the existing `cwd` / `exec` / `readStdin`. That makes it testable with
the fake-deps style `cli-core.test.ts` already uses, and adds no untested
branch.

`guardrails-core/package.json` gains an `exports` subpath:

```json
"./cli": "./dist/cli.mjs"
```

The current map exposes `.` only; anything deeper is refused with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, confirmed against the live repo. This entry is
now load-bearing for every adopter's hooks, so it is public API and is tested as
such.

## 7. Relationship to the unfinished `resolveRepoRoot` migration

`src/repo-root.ts` exists and is tested, but is wired into `scaffold/detect.ts`
only; all six `repoRoot` sites in `cli-core.ts` still use raw
`input.cwd ?? deps.cwd`. Its docstring documents that as a live defect — state
and `recurrence.json` fragment in a monorepo.

That migration and this one answer **different questions**, and conflating them
is what produced the original three-strategy split:

- **Where is the repo?** State, the recurrence ledger, `.gitignore` anchoring,
  the diff base. Needs one stable answer per repo: the git root.
  `resolveRepoRoot`'s job.
- **Where is the code we execute?** `cli.mjs`, eslint, tsc. Follows the
  _installation_, which is a `node_modules` question, not a git question.

In a monorepo these genuinely differ. The upward walk is correct under **either**
answer — starting at cwd and walking up finds the install whether it sits in the
subpackage or at the git root — so nothing here needs revisiting when that
migration lands. This design deliberately does not finish it.

## 8. Alternatives rejected

- **`npx --no-install guardrails`.** 172ms/run against a 26ms baseline, on
  PostToolUse after every edit. It refuses to fetch, but its error
  (`npx canceled due to missing packages: ["guardrails@2.4.1"]`) shows it
  resolved the name against the registry first — and **`guardrails` is a real
  published package owned by someone else**. Rejecting it also matches two
  existing deliberate decisions: `hook-io.ts` says `resolveLocalBin` "avoids
  npx's overhead/registry check", and `templates/workflows/guardrails.yml` says
  the same at length.
- **Plain relative `./node_modules/...` everywhere.** The boring answer, already
  shipping in five places, no shell syntax at all. Fails on exactly case B — the
  hoisted-subpackage layout `docs/adoption.md:71` promises to support.
- **Resolve at scaffold time in `init`.** Exact and free at runtime, but
  `sync-agents.mjs` copies the three live hook configs byte-for-byte into
  `templates/`; a placeholder token would have to live in files that must
  actually run here, destroying the "what we dogfood is what we ship"
  invariant. Also goes stale if the adopter changes layout.
- **Keep them deliberately different.** Preserves host-idiomatic configs at the
  cost of four rules, four failure modes, and four test surfaces — one of which
  demonstrably had no test at all.

## 9. Scope

**Changes:**

- `.claude/settings.json`, `.codex/hooks.json`, `.github/hooks/guardrails.json`,
  `guardrails-plugin/hooks/hooks.json` — the one command form
- `guardrails-core/package.json` — the `"./cli"` export
- `src/hook-io.ts` — `resolveLocalBin` bounded upward walk
- `src/repo-root.ts` — findUp-first
- `src/cli-core.ts`, `src/cli.ts` — the self-check and `selfPath`
- `src/scaffold/hooks-path.ts` — `foreignHooksPathWarning()`, which today hands
  a hoisted-subpackage adopter a path that cannot resolve
- `docs/adoption.md`, `README.md` — replace `npx guardrails init|verify` with
  the relative-path form. All three sites run after the tarball install with cwd
  at the repo root, the same context as the git-hook and CI invocations, so the
  relative path is both correct and the loud-failure behaviour we want there

**Deliberately unchanged:** `.githooks/pre-commit`, `.husky/pre-commit`,
`templates/workflows/guardrails.yml`, `docs/adoption.md:85`. Git sets cwd to the
working-tree root and CI checks out at the workspace root, so cwd is genuinely
guaranteed. There, `npm ci` either installed it or it did not, and an upward
walk could only mask a broken install — a hard failure is correct.

## 10. Test plan

Red first, one commit per step.

1. **`package-exports.test.ts`** — `guardrails-core/cli` resolves and points at
   `dist/cli.mjs`; add it to `scripts/smoke-tarball.mjs` so the packed tarball
   is checked too.
2. **One canonical command string** — a single exported constant plus a shared
   assertion helper, so all four emitters are checked against the same value.
   This is the step that prevents the class of bug being fixed; every emitter
   gets a path assertion, including `github-hooks-config.test.ts`, which has
   none today.
3. **Rewrite the existing wiring assertions** —
   `codex-hooks-config.test.ts` ("resolves the installed CLI from the Git
   top-level", name included) and `plugin-hooks.test.ts`, which pins the full
   `${CLAUDE_PROJECT_DIR}` string exactly.
4. **`resolveRepoRoot` findUp-first** in `repo-root.test.ts` — `.git` as file
   and as directory; git fallback when no `.git` is found; cwd fallback
   unchanged. Existing assertions inject a fake `exec`; an `exists` seam joins
   it.
5. **`resolveLocalBin` bounded walk** in `hook-io.test.ts` — finds `.bin` in an
   ancestor, stops at the boundary, PATH fallback unchanged.
6. **CLI self-check** in `cli-core.test.ts` — outside the bound is non-zero with
   the message; inside proceeds; indeterminate root skips.
7. **Layout integration test** over real temp fixtures for cases A, B, C, D and
   F. These are the only tests that would have caught the original bug, and the
   fixtures already exist from this design's verification.
8. **Regenerate** — `npm run build`, then update `templates.test.ts` and
   `scaffold/templates.test.ts`.

**Drift guards.** The four hook configs are sources, not generated, so no guard
covers them directly; `ci.yml`'s
`git diff --exit-code -- ... guardrails-core/templates ...` will fail until the
regenerated templates are committed alongside. `.github/agents` is untouched.

**Budgeted, not a surprise:** step 5 touches `hook-io.ts`, which carries a
recorded mutation-suppression entry. If the refactor moves that line,
`sanctions-check` fails on a count mismatch — the same failure mode as commit
`9f5d753`.

## 11. Rollout

Branch stacks on PR 19's head (`codex-pr16-adoption-ready`, itself based on
`worktree-phase-c-stryker` for PR 16), in a worktree with its own `npm install`.

The change is self-modifying: `npm run build` must run before the new hooks are
correct, but the running session still holds the old ones. So — build, full
`npm run test:coverage && npm run check:graph`, commit, **then a fresh Claude
Code session** before any live verification, per `CLAUDE.md`. Then re-run
`docs/live-loop-verification.md` and `docs/copilot-live-loop-verification.md` —
the Copilot one especially, since its hook path has never actually worked and
that doc's expectations may have been written against the broken behaviour.

**The one real risk:** the self-check is fatal, so a misfire fails every hook
closed at once. Case E is verified and the `.claude/settings.json` kill-switch
remains the escape, but step 6 lands last.

## 12. Open items

- Whether `resolveLocalBin`'s bound should also apply to the PATH fallback — a
  global eslint on PATH is outside the repo by definition, but rejecting it
  would break every adopter who relies on it today. Left as-is; flagged.
- Whether to add the one-line `process.versions.pnp` skip to the self-check, for
  a PnP session activated through `NODE_OPTIONS`. Not required by any layout in
  §3; cheap insurance if PnP support is ever wanted.
- The `npx guardrails` removal fixes the docs, but nothing prevents the
  instruction returning. A grep-based guard is possible and probably
  disproportionate.
