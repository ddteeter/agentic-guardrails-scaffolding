# Upgrade guidance (#151) — implementation plan

Spec: `docs/superpowers/specs/2026-11-06-upgrade-guide-design.md`.
Branch `151-upgrade-guide`. TDD: every step starts with a failing test. One
commit per step.

## Step 1 — `ship --help` prints usage and never pushes

- Test (`test/cli-core.test.ts`): `ship --help` and `ship -h` exit 0, stdout
  names every flag and the five states, and the injected `exec` is never called.
- Impl: `shipCommand` checks for `--help`/`-h` before `directContext`; usage
  text in one constant shared with the top-level usage line.
- Done: test green; `verify` green.

## Step 2 — the PreToolUse matcher lets `ship --help` through

- Test (`test/foreground-wait.test.ts`): `npx guardrails ship --help`,
  `guardrails ship -h` → undefined. Positive controls still denied:
  `guardrails ship --body-file=b.md`, `guardrails ship; echo --help`,
  `guardrails ship && guardrails ship --help`.
- Impl: `SHIP` match followed by a check that the same command segment
  (up to `;`, `&`, `|`, newline) carries `--help`/`-h` as a whole word. Every
  `ship` occurrence must be a help call for the line to pass.
- Done: tests green.

## Step 3 — `--force-with-lease`, and a rejected push names it

- Tests (`test/ship.test.ts`): with `forceWithLease: true` the push args are
  `['push', '--force-with-lease', '-u', 'origin', 'HEAD']`; without it, a push
  whose stderr has `! [rejected] … (non-fast-forward)` (and separately
  `(stale info)`) gives `state: 'error'` with a tail ending in the
  `re-run with --force-with-lease` hint; a gate-blocked push gets no hint.
  CLI test: `--force-with-lease` reaches `ship()`.
- Impl: `ShipOptions.forceWithLease`; `rewrittenBranchHint(result)` appended in
  `pushFailure`.
- Done: tests green.

## Step 4 — `--attach`, and `warnings` on the status

- Tests: `flags(rest, 'attach')` returns every value in order. New PR → `gh pr
create … --attach a.png --attach b.mp4`. Existing PR → `gh pr comment <n>
--attach …` once, before watching checks. A failed comment → state is the
  checks' state, `warnings` holds gh's tail, `shipSummary` prints it. No
  `--attach` → no comment call, `warnings: []`. CLI resolves attach paths from
  `cwd` (keeping any `#alt` suffix).
- Impl: `ShipOptions.attach: string[]`, `ShipStatus.warnings`, `flags()` helper.
- Done: tests green; `ShipStatus` JSON documented in the help text.

## Step 5 — upgrade-notes parser

- Tests (`test/upgrade-notes.test.ts`): parses the frontmatter subset
  (`version`, `supersedes[{search,because}]`, `wire[{kind,name,value,because}]`)
  from a fixture string; rejects unknown keys, an unknown `kind`, an empty
  `search`/`because`, and a missing frontmatter block, each with a message
  naming the offending key.
- Impl: `src/upgrade-notes.ts` exporting `parseUpgradeNotes(text)` returning a
  result-or-error. Exported from the package index for #152 (check knip/fallow
  don't flag it as unused — it is used by the step-6 test and the index).
- Done: tests green.

## Step 6 — the notes files, shipped and enforced

- Tests (`test/upgrade-notes-files.test.ts`): every `upgrades/*.md` parses; a
  non-`unreleased` file's `version` equals its filename; `upgrades/<package.json
version>.md` exists.
- Write `upgrades/0.12.0.md` (backfilled from `git log v0.11.1..v0.12.0`) and
  `upgrades/unreleased.md` (steps 1–4).
- `package.json` `files` += `upgrades`; `smoke-tarball.mjs` checks the
  directory; `rebuild-if-changed.sh` unaffected (not a build input).
- Done: tests green; `npm run smoke` (or the tarball script) passes.

## Step 7 — `upgrading-guardrails` skill, tarball-only

- Tests (`test/templates.test.ts`): `guidanceEntries`, `claudeSkillEntries` and
  the Copilot index exclude `upgrading-guardrails` as well as
  `adopting-guardrails`.
- Impl: `ADOPTION_TIME_SKILL` → `TARBALL_ONLY_SKILLS` set, comment updated.
- Write `guardrails-plugin/skills/upgrading-guardrails/SKILL.md` per the spec's
  procedure; `npm run build` regenerates `guidance/`, `docs/guardrails/`,
  `.github/copilot-instructions.md`. Check `plugin-skills.test.ts` and
  `legacy-fingerprints` still pass.
- Done: build clean, generated files committed, tests green.

## Step 8 — discovery and the release step

- README upgrade section + `docs/adoption.md`: "after bumping, read
  `node_modules/guardrails-core/guidance/upgrading-guardrails.md`".
- `plan.md` / release notes: cutting a release renames `upgrades/unreleased.md`
  and links the skill in the release body. Roadmap note pointing at #152.
- Done: docs lint green.

## Ship

`npm run test:coverage && npm run check:graph` green, then
`guardrails ship --body-file=<f>` in the background.
