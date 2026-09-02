# Adopting guardrails

This is the document a real adopter reads: what `guardrails init` writes, what
each analyzer costs, and what to do before turning on enforcement. Every claim
below is checked against `guardrails-core/src/scaffold/` and
`guardrails-core/src/verify/index.ts` as of this writing — if behavior drifts,
this doc is wrong until it is updated to match, not the other way around.

## Install

`guardrails-core` ships as a GitHub Release tarball, not from npm:

```bash
npm i -D https://github.com/ddteeter/agentic-guardrails-scaffolding/releases/download/v0.1.0/guardrails-core-0.1.0.tgz
```

**No `v0.1.0` release exists until the tag is pushed.** The URL above 404s
until `.github/workflows/release.yml` runs against a pushed `v0.1.0` tag.

**What a URL dependency costs you:** no semver range (you get exactly the
tarball at that URL, forever, until you edit the line), no dedupe (npm cannot
collapse it against another copy the way it would a registry package), and no
Dependabot tracking (Dependabot only watches registry ranges — an upgrade here
is a manual URL edit, checked in like any other dependency bump). This is
deliberate while the package has no npm-registry presence; publishing to npm
later changes this one line and nothing else.

Installing the tarball does not wire anything up. `guardrails init` does that.

## `init --plan`, then `init --apply`

```bash
npx guardrails init --plan   # print what would be written; touches nothing
npx guardrails init --apply  # write it
```

There is no interactive mode and no TTY probe: a non-TTY invocation of `init`
(no `--apply`) behaves identically to `--plan`. `--apply` is the only way past
the read-only default, and `--plan`/`--apply` are mutually exclusive on one
invocation.

`init` is re-runnable — on every run it recomputes the same plan from what is
already on disk and (for OWNED files) the checksums recorded in
`.guardrails/scaffold.json`, so running it twice against an unmodified repo is
a no-op except for the SHARED files, which always report `merge` (see below).

Flags: `--json` (machine-readable plan/result), `--force` (overwrite OWNED
files you have edited — never SEED-ONCE), `--analyzers=<tool>=<off|auto|required>[,...]`,
`--enforcement=warn|block`, `--distribution=solo|team`.

## Who owns each written file

`init` writes three kinds of files, and the difference matters the moment you
edit one of them by hand.

| Class         | Behavior                                                                                                                                                                                                                                                                                              | Examples                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OWNED**     | Absent → created. Unmodified since scaffolding (checksum in `.guardrails/scaffold.json` still matches) → silently rewritten on the next `init --apply`, so upgrades land automatically. Edited by you → left alone and reported as `drift` in the plan; `--force` overwrites it anyway.               | `.claude/agents/guardrail-fixer.md`, `.claude/agents/guardrail-fixer-thorough.md`, `.github/agents/guardrail-fixer*.agent.md`, `.github/hooks/guardrails.json`, `.githooks/pre-commit`, `.github/workflows/guardrails.yml`, `docs/guardrails/crushing-mutants.md`, `docs/guardrails/boundary-validation.md`, `.claude/skills/crushing-mutants/SKILL.md`, `.claude/skills/boundary-validation/SKILL.md` |
| **SHARED**    | Absent → the whole file is created. Present → always `merge`: guardrails splices in only its own entries (a hooks block, a gitignore stanza, the `prepare` script line, a marked doc section) and leaves everything else in your file untouched. Never reports `drift`, never sensitive to `--force`. | `.claude/settings.json`, `.gitignore`, `package.json`, `.github/copilot-instructions.md`                                                                                                                                                                                                                                                                                                               |
| **SEED-ONCE** | Absent → created once. Present → left alone, forever — `--force` included.                                                                                                                                                                                                                            | `guardrails.config.json`, `.dependency-cruiser.cjs` (only if dependency-cruiser is enabled and no config exists yet), `stryker.conf.json` (same, for stryker)                                                                                                                                                                                                                                          |

`guardrails.config.json` is the one file `--force` can never touch: it holds
your policy and your `sanctionedSuppressions`, and losing it is the worst
thing this command could do.

`.githooks/pre-commit` is written but inert on its own — git only runs hooks
from `.git/hooks` unless told otherwise. `init --apply`'s `package.json`
merger appends `guardrails install-hooks` to the `prepare` script, and that
command is what points `core.hooksPath` at `.githooks` (resolved against the
real repo root, not the current directory, so it still targets the right repo
from inside a monorepo package). `npm install` runs `prepare` automatically,
which is what gets a fresh clone or a teammate's checkout onto the commit gate
without anyone running a command by hand.

**Unless you already have a `core.hooksPath`.** git accepts exactly one hooks
directory, so pointing it at `.githooks` would silently disable every hook you
already have there — and husky sets it to `.husky/_`. Neither `init --apply`
nor `install-hooks` will do that. If `core.hooksPath` is set to anything other
than `.githooks`, both leave it exactly as they found it, write
`.githooks/pre-commit` anyway, and warn — in the `--plan` output as well as the
`--apply` output — naming the value they found. Your gate is then **not**
installed: add

```sh
node ./node_modules/guardrails-core/dist/cli.mjs gate --mode=commit
```

to the pre-commit hook you already have, and the check runs inside your
existing hooks instead of replacing them.

One SHARED file is a special case worth calling out: **`.claude/settings.json`
is re-serialized on every merge**, even when nothing guardrails-owned changed.
If your formatter disagrees with the merger's (2-space, alphabetical-ish key
order), you'll see it reformatted on every `init --apply` and reformatted back
by your own tooling afterward. Harmless, but don't be surprised by the diff.

## What each analyzer costs at which rung

Not every analyzer runs on every turn. `guardrails-core/src/verify/index.ts`'s
`ANALYZERS` table gates each one by a minimum cadence rung:

| Analyzer           | Runs at                            | Scope                                                                                  |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| eslint             | every turn (Stop gate), commit, CI | diff-scoped — only changed TypeScript files are linted                                 |
| tsc                | every turn (Stop gate), commit, CI | triggered by a changed file, but checks the whole project (type errors are cross-file) |
| knip               | commit and CI only                 | whole-project                                                                          |
| dependency-cruiser | commit and CI only                 | whole-project                                                                          |
| stryker            | commit and CI only                 | diff-scoped to changed production files                                                |

The practical read: eslint and tsc are cheap enough to run after every agent
turn. knip, dependency-cruiser, and stryker are whole-graph or mutation
analysis — too slow for a per-turn gate — so they only fire at `git commit`
(via `.githooks/pre-commit`) and in CI. An analyzer set to `"off"` in
`guardrails.config.json`'s `analyzers` block never runs at any rung, which is
how you adopt eslint/tsc first and turn on the heavier three once your
baseline is clean under them.

## The clean-baseline prerequisite

**Run `guardrails verify` clean before turning the gate on.** tsc, knip, and
dependency-cruiser are whole-project checks — they report every pre-existing
finding, not just ones you introduced, on every single turn. A repo scaffolded
onto a dirty baseline gets a gate that blocks every turn on findings the
adopter never wrote, which is worse than no gate at all: it trains the habit
of ignoring the gate.

```bash
npx guardrails verify
```

Fix (or explicitly turn off, via `analyzers`) whatever it reports before
wiring the Stop hook into a live session, and before enabling the whole-graph
analyzers in the commit/CI gate.

## Starting in `warn`, graduating to `block`

`guardrails.config.json`'s `enforcement` field (`"warn"` at the bare CLI
default, or `"block"`) governs exactly two commands: `gate --mode=commit` (run by
`.githooks/pre-commit`, and by the `guardrails gate --mode=commit` step in the
shipped `.github/workflows/guardrails.yml`) and `gate --mode=pretooluse` (the
Copilot commit/push self-gate). Under `warn`, both still run the full check —
verify, the diff-auditor, the sanction budget — and print every violation and
every added suppression in full; only the exit code changes, from a blocking
non-zero to an explicit 0 with a "not blocking" note on stderr. A green run
under `warn` is never silent about violations it chose not to block on.

**This means a "required" CI check is not automatically a hard gate.** Marking
the `guardrails` job required in GitHub branch protection stops a PR from
merging only when the job actually fails — and under `enforcement: "warn"`,
`gate --mode=commit` exits 0 regardless of what it found. Flip
`enforcement` to `"block"` before a required check does anything.

**The Claude Code Stop loop is never softened by this field.** The
per-turn Stop hook (`gate --mode=stop`) always blocks on a violation, bounded
by `maxAttempts`, from the moment it is wired in — `warn`/`block` has no
effect on it. That loop's safety comes from the attempt counter and the
`--no-verify`-equivalent bypass at the commit boundary, not from `enforcement`.

For a greenfield repo, or an existing repo that already verifies clean, start
with `enforcement: "block"`. `warn` is only a migration tool for an existing
backlog: let the commit/CI gate report while that backlog is cleared, then flip
to `"block"` immediately. Letting a violation commit to the configured base
branch removes it from later diff-scoped checks, so a clean repo gains nothing
from a calibration window and can create its own dirty baseline under `warn`.
Change this by editing `enforcement` in `guardrails.config.json` directly — `init`'s
`--enforcement=block` flag only affects the _first_ time the file is seeded;
because `guardrails.config.json` is SEED-ONCE, a later `init --apply
--enforcement=block` has no effect on an already-existing config, `--force`
included.

### Solution-style TypeScript configurations

Vite and other project-reference layouts commonly use a root `tsconfig.json`
with `files: []` and one or more `references`. Plain `tsc -p tsconfig.json`
checks no source files in that shape and exits successfully. Guardrails detects
the references from `tsc --showConfig` and follows an apparently-clean project
check with `tsc --build --noEmit`, so referenced projects are part of the gate.
If TypeScript cannot produce a readable resolved configuration, verification
fails closed rather than treating an unknown input set as clean.

**Do not trim `fetch-depth` on the shipped CI workflow.**
`.github/workflows/guardrails.yml` checks out with `fetch-depth: 0` on
purpose: `gate --mode=commit`'s diff-auditor and sanction budget diff against
`git merge-base <baseBranch> HEAD`, which needs history a shallow checkout
doesn't have. When that `merge-base` call fails, `branchDiff` (`gate.ts`)
falls back to `git diff --cached` — empty in a CI checkout, since nothing is
staged there. The blast radius is narrower than "CI audits nothing": eslint,
tsc, knip, dependency-cruiser, and stryker still run and can still block,
because they come from `verify`, not from the diff. What silently stops
working is only the diff-auditor and the sanction budget — a suppression
introduced on the branch sails through with no error, no warning, just a
clean-looking run. `.github/workflows/guardrails.yml` is OWNED, so a consumer
can edit it (including trimming `fetch-depth` to speed up checkout); nothing
catches that edit for you.

## Re-running `init` after an upgrade

Bump the tarball URL, run `npx guardrails init --plan` again. Each line is one
of:

```
create: <path> — <path> does not exist yet; creating it
update: <path> — <path> is unmodified since it was scaffolded; upgrading it
drift: <path> — <path> was edited after scaffolding; leaving it alone
merge: <path> — <path> is shared; merging in guardrails' entries
unchanged: <path> — ...
```

A `drift` line is a report, not a failure — the plan exits 0 and the file is
left exactly as you have it. It also prints a warning line:
`<path> has drifted from what guardrails scaffolded and was left alone (rerun
with --force to overwrite)`. Read the drift report before deciding whether to
take the upgrade's version (`--force`, which only touches OWNED files) or keep
your edit and manually reconcile.

`--json` gives the same information as `{ actions, warnings }` for scripting.

## The kill-switch

To turn off the Claude Code Stop loop specifically: edit `.claude/settings.json`
and remove (or empty) the `hooks.Stop` entry that runs
`guardrails gate --mode=stop`. `.githooks/pre-commit` and the CI workflow are
untouched by this — they are separate hook/workflow files, not gated by
`.claude/settings.json` at all.

**This is not durable across upgrades.** `.claude/settings.json` is a SHARED
file: `init --apply` always re-merges guardrails' `Stop` entry back in on the
next run, regardless of whether you removed it, because the merger only knows
"keep every entry that isn't ours, then append ours" — it has no memory of a
prior removal. If you kill the Stop loop, expect to remove it again after the
next `init --apply`.

## Org-level surface disablement (Copilot)

An organization admin can disable the Copilot CLI or the Copilot cloud coding
agent surface outright, at the GitHub org level. No enterprise policy
specifically gates `.github/hooks` or custom agents beyond that — there is no
finer-grained switch. If an org disables one of those surfaces, the half of
the Copilot channel built on it (the CLI's or the cloud agent's `agentStop`/
`preToolUse` gating) goes inert; the git-native `.githooks/pre-commit` and CI
`verify` step still run underneath, since neither depends on the disabled
surface.

## Known limits

Four things worth knowing before you hit them, rather than after:

- **`.claude/settings.json` is reformatted on every merge**, unconditionally
  (see the SHARED-file note above). If your formatter disagrees with the
  merger's output, expect a reformat/re-reformat cycle on every `init --apply`.
  Cosmetic, not destructive.
- **Orphan files are never reported or removed.** A file an earlier guardrails
  version wrote that a later version no longer wants to write (renamed,
  retired) is left in place silently, and its checksum entry in
  `.guardrails/scaffold.json` is never dropped by a later `--apply`. This is
  deliberate — deleting a file inside your repository needs a design of its
  own (what if you edited it first?) — but it means a stale file from an old
  install can outlive every upgrade until someone removes it by hand.
- **The scaffolder assumes a clean baseline** (see above) — it will happily
  scaffold onto a repo with pre-existing `verify` findings, and the gate it
  wires up will then escalate on those findings from turn one.
- **Declared analyzer providers are read from the ROOT `package.json` only.**
  A monorepo that declares eslint/typescript/knip/dependency-cruiser/stryker in
  its member packages rather than at the root has an empty declared set: every
  analyzer is `auto`+undeclared, so a broken install degrades to "skipped"
  silently instead of erroring, which is the opposite of what you want. The
  workaround is one line — mark those analyzers `"required"` in
  `guardrails.config.json`, which states the dependency explicitly and restores
  the hard `guardrails/analyzer-missing` error.
