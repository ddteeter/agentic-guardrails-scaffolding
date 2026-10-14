# PreToolUse gate targets the repo the command writes to (#123) — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.
> One PR, one commit per task.

**Goal:** the Bash/shell PreToolUse commit/push gate checks the repository the
git write actually lands in, with **that** repository's installed
guardrails-core, rather than the repository the hook payload's `cwd` names.

**Branch:** `fix/pretooluse-target-repo`, stacked on `feat/agent-wait-cost`
(PR #122). Retarget the PR to `main` once #122 merges; #122's branch itself is
never modified from here.

## Problem (verified)

`gatePreToolUseCommand` resolves `repoRoot` from `commandRepoRoot(deps,
input.cwd)` (`cli-core.ts`). Payload `cwd` is the shell's directory _before_ the
command runs, so for `cd X && git commit`, `git -C X commit`, and
`git --git-dir/--work-tree … commit` the gate checks the session's repo while
git writes to X. Seen live: a dialed.run-rooted session committing here was
gated by dialed.run's pinned 0.7.0 against dialed.run's tree, and hit #118's
EISDIR crash. The same applies to `push`, because `isShellGitWrite` covers both,
and to #122's `isPushGatedByHook(repoRoot)` short-circuit, which consults the
wrong repo's pre-push hook.

## Decisions (approved 2026-10-12)

1. **Delegate cross-repo writes to the target's own install.** When the
   resolved target root does not contain the running CLI (`selfPath`), spawn
   the target's copy and relay its decision. When it does (every same-repo
   command, including `cd subdir && git commit`), gate in-process exactly as
   today, with no spawn.
2. **Missing install, split by adoption.** If the target has
   `guardrails.config.json` but no guardrails-core resolvable _inside_ it, deny
   with the #115 install remedy naming the target. If the target never adopted
   guardrails (no config), allow silently: nothing to enforce, and its own git
   hooks still run.
3. **Undeterminable target → fail closed** (#115's shape): deny the git write
   with a remedy ("use a literal path: `cd <dir> && git …` or `git -C <dir> …`").

## Design

### Target resolution: `guardrails-core/src/command-target.ts` (new, pure)

`commandTarget(command, cwd, home): { kind: 'directory', directory } |
{ kind: 'unknown', reason }`, which returns the directory every git write in the
command runs in. It builds on #122's `shell-command.ts` (`COMMAND_START`,
`withoutQuotedHeredocBodies`) and adds a small quote-aware splitter. It is not a
shell parser. It recognises a narrow set of literal shapes and returns
`unknown` for everything else:

- **Top-level segments** are split on `&&`, `;` and newline, outside quotes.
  A `cd` is honoured only in a segment joined to the git write by `&&`, `;` or
  newline. The same cd-carrying chain inside `||`, `|`, `( … )`, `{ … }`,
  backticks or `$( … )` → `unknown`.
- **`cd <arg>`**: literal unquoted, or single/double-quoted with no `$` or
  backtick. A leading `~` / `~/` expands to `home`. A relative path resolves
  against the running directory. Several `cd`s compose. A bare `cd` goes to
  `home`. `cd -`, `cd $X`, `cd "$(…)"`, `pushd`/`popd` → `unknown`.
- **`git` global options**: each `-C <dir>` composes onto the directory (as git
  does). `--git-dir=…`, `--work-tree=…`, their separate-value forms, and a
  `GIT_DIR=`/`GIT_WORK_TREE=` prefix → `unknown`. Resolving them would
  mean modelling git's discovery, and `-C` is the remedy.
- **Several git writes** that resolve to different directories → `unknown`
  ("one repository per command").
- `$` and backticks **elsewhere** (a `-m "$(cat <<'EOF' …)"` message) do not
  affect the answer. Only `cd` arguments and git's directory options are
  inspected. This keeps the common `git add -A && git commit -m "$(…)"` shape
  unchanged.

`unknown` is reached only after `isShellGitWrite` already said yes, so non-git
commands never pay for it.

### Delegation

- `gatePreToolUseCommand` (and its #122 push short-circuit) takes `repoRoot` from
  the resolved target (`resolveRepoRoot(exec, directory)`) instead of
  `input.cwd`.
- **Marker:** a delegated run receives env `GUARDRAILS_PRETOOLUSE_TARGET=<root>`
  and uses it as `repoRoot` without re-parsing (re-parsing `cd ../x` from the
  rewritten cwd would resolve somewhere else). A marked run never delegates
  again.
- **Old-version compatibility:** the delegate also gets the payload with `cwd`
  rewritten to the target root, so a target pinned to ≤0.8 (no marker support)
  still gates the right tree through its own `input.cwd` path.
- **Spawn:** resolve `guardrails-core/cli` with `createRequire` anchored at
  `<target>/package.json`. If it is outside the target (`isWithinRepo`), apply
  decision 2. Otherwise run `node -e "import('guardrails-core/cli')" guardrails
gate --mode=pretooluse [--dialect=…]` with `cwd = target`. This is the same
  invocation the hook template uses, so the delegate's own `outsideRepoMessage`
  and deadline apply. The payload goes on stdin, so `Exec` gains an optional
  `input`. Its stdout (the decision JSON) and stderr are relayed verbatim.
- **Delegate failure** (spawn failed, signal, non-zero exit) throws, so
  `decidingHook`'s existing failure path denies the write. The outer
  `hookDeadlineSeconds` still bounds the whole thing.
- `decidingHook`'s deadline lookup and `didDenyForegroundWait` (#122) keep
  using payload `cwd`. Both are session-side concerns, not the write target.

### Out of scope (noted in plan.md)

- The Stop gate (`sessionCwd`) and git-native hooks are unaffected: git hooks
  already run in the repo being written.
- `xargs git commit`, `sh -c '…'`, aliases: already documented misses of
  `GIT_WRITE` and unchanged.

## Global constraints

TDD (failing test first); no suppressions, casts, `.skip` or weakened
assertions; zero runtime deps; `unicorn/prevent-abbreviations` naming;
complexity under the house ceiling (pre-validate against the
`plan-code-vs-own-lint` rules); every task ends green on `npm run verify` in
`guardrails-core` and is committed through the normal gate (no
`--no-verify`, no scratch-script commits).

---

## Task 1 — `command-target.ts`: literal `cd` chains

**Builds:** `commandTarget` with the segment splitter and `cd` handling
(literal, quoted, `~`, relative, composed, bare `cd`).
**Tests (`test/command-target.test.ts`):** a plain `git commit` gives `cwd`;
`cd /abs && git commit`; `cd rel; git commit`; `cd a && cd b && git commit`;
`cd ~/x && git commit`; quoted paths with spaces; a `cd` _after_ the commit is
ignored; `cd` inside a quoted `-m` message is ignored; the
`git commit -m "$(cat <<'EOF' … EOF)"` shape gives `cwd`.
**Done:** all pass; mutation score on the new file is 100% or every survivor
is argued equivalent.

## Task 2 — `command-target.ts`: git directory options and `unknown`

**Builds:** `-C` (composed, relative to the running directory); `unknown` for
`--git-dir`/`--work-tree` (both forms), `GIT_DIR=`/`GIT_WORK_TREE=` prefixes,
`cd -`, `cd $X`, `cd "$(…)"`, `pushd`, a cd under `||`/`|`/subshell/group, and
two writes in different directories. Each `unknown` carries a reason string.
**Tests:** one per shape above, plus `git -C a -C b commit` → `a/b` and
`cd a && git -C b commit` → `a/b`. A timing test on a long, pathological command
pins linear time (the `GIT_GLOBAL_OPTIONS` precedent).
**Done:** as Task 1.

## Task 3 — Gate the resolved target in-process (same-install case)

**Builds:** `gatePreToolUseCommand` resolves the target first. An `unknown`
target denies with the remedy. A resolved target whose root contains `selfPath`
gates that root in-process. That covers the `cd subdir` and nested-repo
same-install cases, and the #122 push short-circuit reads the target's hook.
**Tests (`cli-core.test.ts`, fake exec):** a plain `git commit` is unchanged
(same exec calls as before); `cd <subdir> && git commit` gates the same root;
an undeterminable `cd "$X" && git commit` is denied with the remedy text and
runs no analyzer; a non-git command is still silent.
**Done:** green verify; the existing pretooluse suite is untouched.

## Task 4 — Delegate to the target's install

**Builds:** `Exec` `input` option (`spawnExec` writes it to stdin and closes it);
target-install resolution; the marker env plus the rewritten payload `cwd`; the
spawn and relay; delegate failure → throw. Decision 2 for a missing install.
**Tests:** unit tests with a fake exec: the spawn args, `cwd`, env marker, the
rewritten payload, and stdout relayed; a marked run gates the marker root
without parsing or delegating; a failed delegate → deny via `decidingHook`; an
adopted target without an install → deny naming the target; an unadopted
target → silent allow. **One integration test** with two temporary git repos
(stripped `GIT_*` env, per the git-hook-env memory): repo B has a stub
`node_modules/guardrails-core` whose cli prints a recognisable deny. Running
`cd B && git commit` from repo A relays B's deny, and `git -C B commit` does
the same.
**Done:** green verify, mutation included.

## Task 5 — Docs and findings

**Builds:** a `docs/adoption.md` note on cross-repo commands (what is resolved,
what fails closed, and the remedy); a `plan.md` entry closing #122's recorded
finding and listing the deliberate misses; a CHANGELOG/Unreleased line if
the repo keeps one. No version bump (0.8.0 is held by the owner).
**Done:** verify green; the PR body links #123 and #122 and says it is
stacked.

## Verification after merge

Start a fresh Claude Code session rooted in another adopting repo (dialed.run
or a scratch adopter). Run `cd <this repo> && git commit` on a deliberate
violation and confirm this repo's gate is what blocks. Repeat with
`git -C <this repo> commit`.
