# Formatter-agnostic drift detection for owned scaffold files — implementation plan

Fixes plan.md → "Roadmap: fixer-loop hardening" → "`init` treats a
consumer's formatter as a hand edit…" (dialed.run, 2026-10-24).

## The problem, precisely

`init` records `checksum(content written)` per owned file in
`.guardrails/scaffold.json`. On a later `init`, `decideOwned`
(`src/scaffold/plan.ts`) upgrades a file only when
`checksum(onDisk) === recorded`; otherwise it reports `drift` and leaves the
file alone. `staleArtifacts` (`src/scaffold/staleness.ts`) uses the same test
to warn at session start.

A consumer's formatter (Prettier at commit, via lint-staged) rewrites the
owned files after `init` writes them. The fixer prompts contain a fenced `ts`
block, which Prettier reformats as code, so dialed.run's only change was
`'number'` → `"number"`. From the first commit on, every owned file the
formatter touches reads as hand-edited and **never upgrades again**. That
happens silently, unless someone reads the drift warning. Prompt fixes like
#141 do not reach those consumers.

## Design

**Fingerprint.** `fingerprint(content)` = `words-sha256-` + sha256 of the
content lowercased, with every character that is not a Unicode letter or
digit removed (`/[^\p{L}\p{N}]/gu`). Formatters change whitespace, wrapping,
quote characters, optional punctuation and markdown markers. They do not
change words. That makes the fingerprint formatter-agnostic: Prettier, Biome,
dprint, and taplo for the `.toml` fixers.

**Rule.** An owned file is _unmodified_ when its exact checksum matches the
recorded one (today's rule), **or** when its fingerprint matches the recorded
fingerprint. Both `decideOwned` and `staleArtifacts` call one shared predicate,
so the two cannot disagree.

**Where the recorded fingerprint comes from:**

1. **Going forward:** the manifest gains a `fingerprints` map (path →
   fingerprint), written next to `files` whenever `apply.ts` records a
   checksum. It is a separate map rather than a changed `files` value, so an
   older guardrails reading a newer manifest still parses it. A downgrade
   drops the map, which is safe: it falls back to exact matching.
2. **Existing installs** (manifests with no `fingerprints`, e.g. dialed.run on
   0.11.x): a bundled, committed table `guidance/fingerprints.json` maps each
   exact checksum ever written by a release to that content's fingerprint.
   `recorded checksum → table → fingerprint`. That still proves the disk file
   is a reformat of what _this_ repo was given, not merely of some release. The
   table is generated once from the release tags and never grows: from this
   release on, every write records its own fingerprint.

**Which way it fails.**

- A formatter that changes a letter or digit (list renumbering, `.5` → `0.5`,
  hex case) makes the fingerprint mismatch, so the file reads as drift. That
  is today's behaviour: safe, and it says so.
- A consumer edit that changes only punctuation (`==` → `===` in a prompt)
  reads as unmodified and is overwritten on upgrade. This is accepted:
  owned files carry a do-not-edit contract, and `--force` already overwrites
  edits.
- An upgrade writes the unformatted template again, and the consumer's
  formatter reformats it at their next commit. The fingerprint absorbs that,
  so it does not come back as drift. Expected churn, not a bug.

**Out of scope.** SHARED files (merged, never drift) and SEED-ONCE files
(never upgraded) are unaffected. Formatting on write is not attempted.

## Steps

1. **`fingerprint()`**: in `src/scaffold/manifest.ts`, next to `checksum`.
   Tests in `test/scaffold/manifest.test.ts`:
   - invariant under whitespace, re-wrapping, `'`↔`"`, a trailing comma or
     semicolon, `*`↔`_`↔`-` markers;
   - changes when a word changes, when a digit changes, and when a word is
     added;
   - the output has the `words-sha256-` prefix.
   - Use real formatter output as a fixture: the 0.11.1 `guardrail-fixer.md`
     template next to the same file after `prettier --write`. This is
     dialed.run's exact case, and it must fingerprint equal.

   Done when those tests pass and mutation on the function is clean.

2. **Manifest `fingerprints` map**: extend `ScaffoldManifest` with
   `fingerprints: Readonly<Record<string, string>>`.
   - `parseManifest`: a missing or malformed map gives `{}`, and non-string
     entries are dropped. This is the same fail-toward-not-touching rule
     `files` already follows.
   - `serializeManifest`: emit the map with sorted keys, and omit it when it is
     empty, so existing committed manifests do not churn until a write
     happens.
   - Tests: a round trip; an old manifest without the map parses to `{}`.

   Done when the tests pass.

3. **Record on write**: `apply.ts` records `fingerprint(desiredContent)` next
   to `checksum(desiredContent)` for every create or update.
   - Test in `test/scaffold/apply.test.ts`: after apply, the manifest holds
     both values for each written path.

   Done when the test passes.

4. **One shared predicate**: add `isUnmodified(path, onDisk, manifest,
legacyTable)` in `manifest.ts`. It returns true on an exact checksum match,
   or when the fingerprint of `onDisk` equals
   `manifest.fingerprints[path] ?? legacyTable[manifest.files[path]]`. Then
   switch `decideOwned` and `staleArtifacts` to it.
   - Tests in `plan.test.ts` and `staleness.test.ts`:
     - a reformatted owned file gives `update` with the reason "reformatted
       since scaffolding; upgrading it";
     - a reworded file still gives `drift`;
     - an untracked file still gives `drift`;
     - `--force` is unchanged;
     - `staleArtifacts` reports a reformatted file as `updatable`, not
       `drifted`.

   Done when the tests pass and the existing plan and staleness suites are
   still green.

5. **Legacy table**: `scripts/legacy-fingerprints.mjs`, run by hand once and
   with its output committed. For every `v*` tag:
   - read the owned templates (`git show <tag>:guardrails-core/templates/…`);
   - read the guidance docs (`…/guidance/*.md`);
   - rebuild the `.claude/skills/*/SKILL.md` entries with the current
     `claudeSkillEntries` from that tag's guidance tree.

   It emits `{ checksum: fingerprint }` to
   `guardrails-core/scaffold-data/legacy-fingerprints.json`. (Not `guidance/`,
   as first planned: `sync-agents.mjs` deletes and regenerates `guidance/` on
   every build. `scaffold-data/` is added to the package's `files`.)
   The output is sorted and deterministic like `index.json`. A rebuilt skill that
   differs from what the tag really wrote only fails to match, which is safe.
   `init` and the session-start warning load the table through
   `legacyFingerprints()` in `templates.ts`.
   - Tests:
     - the table holds an entry for the 0.11.0 `guardrail-fixer.md` checksum;
     - a 0.11.0 manifest plus a Prettier-reformatted fixer gives `update`.

   Done when the tests pass and the tarball smoke test (`scripts/smoke-tarball.mjs`)
   shows the file packed.

6. **Docs and finding**:
   - Update `docs/adoption.md`'s drift wording to say that reformatting is no
     longer drift.
   - Mark the plan.md finding fixed.

   Done when the pre-push gate is green.

## Verification

- **Live check:** in a scratch consumer, scaffold with 0.11.1, run
  `prettier --write` over `.claude/agents`, commit, then `init --plan` with
  the new build. Expected: the fixer files show `update`, not `drift`.
- **Repeat on Biome:** the same check with `biome format --write` (markdown
  support permitting; otherwise on the `.json` hook templates).
- **The pre-push gate**, including mutation on the touched `src/scaffold`
  files.
