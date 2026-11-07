# Upgrade guidance for adopters' own instructions (#151) — design

## Problem

A release can make instructions the **adopter** wrote obsolete or under-used:
a rule the new version enforces mechanically, a workaround for a bug it fixed,
a new command nothing invokes. dialed.run's 0.11 → 0.12.0 bump kept "lanes stop
at ready-to-ship; only the coordinator pushes" after 0.12 had removed its reason
(`guardrails ship` + the PreToolUse foreground-wait denial), and a coordinator
spent most of a day hand-pushing lanes. Nothing in the upgrade path said so:
release notes are a PR list, and `guidance/` has `adopting-guardrails` but
nothing for upgrading.

#106 covered guardrails' own vendored files going stale. This is the other
half: the adopter's files.

## Scope

In this branch:

1. **Agent-facing upgrade notes**, one file per release, shipped in the tarball.
2. **An `upgrading-guardrails` guidance skill** that applies them.
3. **`ship` fixes** found on the way: `--help` passes the PreToolUse matcher
   (and actually prints help), a `--force-with-lease` flag plus a clear error
   on a non-fast-forward rejection, and `--attach` for PR media.

Out of scope: `init --plan` / `doctor` warning on superseded patterns — split to
**#152**, which reads the same notes files (hence the frontmatter below).

## 1. Upgrade notes

### Location

`guardrails-core/upgrades/<version>.md`, hand-written, added to the package's
`files`. Not `guidance/upgrades/`: `scripts/sync-agents.mjs` deletes and
regenerates `guidance/` from `guardrails-plugin/skills/` on every build, and
these files have no skill source. `smoke-tarball.mjs` asserts the directory
ships.

Unreleased changes accumulate in `upgrades/unreleased.md`; cutting a release
renames it to `<version>.md` (documented in the release step of `plan.md` /
README contributor notes). A test asserts `upgrades/<package version>.md`
exists, so a release cut without notes fails the build — the mechanized half,
same spirit as the drift-guard.

### Format

Markdown with YAML-subset frontmatter, written for an agent, not a changelog
reader:

```markdown
---
version: 0.12.0
supersedes:
  - search: 'does not push'
    because: 'lanes ship themselves with `guardrails ship`; the gate lock queues pushes'
  - search: 'gh pr checks --watch'
    because: 'denied by the PreToolUse foreground-wait rule; use `guardrails ship`'
wire:
  - kind: script
    name: ship
    value: 'guardrails ship'
    because: 'one backgrounded push + PR + CI wait'
---

# 0.12.0 — what changed for an agent

## Behaviour that changed

…

## Instructions this supersedes

…

## What to wire

…
```

- `supersedes[].search` — a literal, case-insensitive phrase to grep the
  adopter's instruction files for. Literal (not regex) so #152 can match it
  without a regex-safety story.
- `wire[].kind` — `script` (package.json), `hook`, or `config` (a
  `guardrails.config.json` key). `name` + `value` say what; `because` says why.
- The body carries the judgement the frontmatter can't: when an old rule is
  _partly_ still right, what to replace it with.

A schema test parses every `upgrades/*.md` frontmatter and fails on unknown
keys, a missing `version` matching the filename (except `unreleased`), or empty
`search`/`because`. The parser lives in `guardrails-core/src/upgrade-notes.ts`
(exported, unit-tested) because #152 will consume it; it handles only the subset
above, so no YAML dependency.

### Content for this branch

- `0.12.0.md` — backfilled from #146/#143/#122-era changes: `ship`, the
  foreground-wait denial, the mutation lock, reformatted-owned-file-not-drift.
  Supersedes phrases from the issue ("does not push", "only the coordinator
  pushes", "gh pr checks --watch", "gh run watch", `sleep` polling).
- `unreleased.md` — this branch's `ship` changes (`--force-with-lease`,
  `--attach`, `--help`): supersedes "--force-with-lease" manual pre-push steps
  and "gh pr comment --attach" follow-ups.
- No notes for ≤0.11.x; the skill says so and falls back to release PR titles.

## 2. `upgrading-guardrails` skill

Source `guardrails-plugin/skills/upgrading-guardrails/SKILL.md` (the single
source of truth; `npm run build` syncs it to `guidance/`, `docs/guardrails/`,
`.claude/skills/`).

**Tarball-only, like `adopting-guardrails`.** At upgrade time a vendored copy is
the _old_ version's skill; the copy in `node_modules/guardrails-core/guidance/`
is the new one, which is the one that knows the new notes. So `templates.ts`'s
`ADOPTION_TIME_SKILL` generalizes to a `TARBALL_ONLY_SKILLS` set, and `init`
neither vendors it nor indexes it in copilot-instructions. Discovery is from the
README's upgrade section, `docs/adoption.md`, and the release body template
("after bumping, read `node_modules/guardrails-core/guidance/upgrading-guardrails.md`").
(`init`/`doctor` pointing at it on a version change is #152.)

The skill's procedure:

1. Find the old pin (git diff of package.json / lockfile) and the new version.
2. Read every `node_modules/guardrails-core/upgrades/<v>.md` with old < v ≤ new,
   in order.
3. Run `guardrails init --plan` and act on vendored-file drift per
   `adopting-guardrails` (that half is #106's).
4. For each `supersedes[].search`, search the adopter's instruction surfaces —
   `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`, `.claude/skills/` (non-vendored),
   `.github/copilot-instructions.md` outside the guardrails block, `.cursor/`,
   `package.json` scripts — and for each hit **propose** an edit with the
   `because`, not apply it silently: these are the developer's words.
5. For each `wire` entry, check whether it is present; propose it if not.
6. Finish on a green `guardrails verify`, and tell the developer to start a
   fresh session if hooks/agents/settings changed.

Written per the `writing-for-agents` skill; pre-validated against this repo's
markdown lint.

## 3. `ship` fixes

### `--help`

- `foregroundWait`: a `guardrails ship` invocation whose arguments include
  `--help` or `-h` is not a wait. Test both directions, including the positive
  control (`ship --body-file=x` still denied) and a `--help` in a _later_
  command of the same line not exempting an earlier `ship`.
- `shipCommand`: `--help`/`-h` prints ship's usage (flags + the five states +
  status-file location) to stdout and exits 0 **without calling `ship()`**.
  Without this, the matcher change would let `ship --help` push in the
  foreground — the test asserts no `exec` call.

### Force

- `--force-with-lease` flag → `git push --force-with-lease -u origin HEAD`.
  The existing base-branch guard still refuses before any push.
- Without the flag, a push rejected as `non-fast-forward` / `stale info` keeps
  state `error`, and the tail gains a line naming the fix:
  `the branch was rewritten since its last push (rebased?); re-run with --force-with-lease`.

### `--attach`

- `--attach=<file>[#alt]`, repeatable (new `flags()` helper; `flag()` takes the
  first only).
- Opening a PR: passed through as `gh pr create --attach …`.
- PR already open: after finding it, `gh pr comment <n> --attach …` once.
- An attachment failure never changes `state` (CI's outcome is still the
  outcome); it is recorded in a new `warnings: string[]` on `ShipStatus` and
  printed by `shipSummary`. `warnings` is always present (empty when none) so
  readers needn't branch on absence.
- Re-running `ship` with `--attach` on an open PR posts again; documented in the
  help text.

## Testing

TDD throughout; each item is a failing test first. Matcher and ship tests use
the existing injected-`Exec` harness (no network). Frontmatter parser: unit
tests plus the schema test over the real `upgrades/` files. The skill is prose;
its check is the build sync + `sanctions`/lint, plus a read-through against
`writing-for-agents`.

## Risks

- **A notes file that over-matches** ("push" alone) makes the skill propose
  noise edits. Mitigation: phrases are multi-word and reviewed with the release.
- **Release cuts forgetting the rename**: caught by the version-exists test.
