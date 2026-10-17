# `complexity` defaults on where fallow is installed — Implementation Plan

> One PR, one commit per task. Branch `feat/complexity-default-when-fallow`.

**Goal:** an adopter whose repo declares `fallow` gets the `complexity` analyzer
without configuring it. One that doesn't gets nothing, and no
silently-skipped nag. This is option 2 of #133's follow-up, approved 2026-10-17.

## Why this shape

- `complexity` shipped (#133, 0.10.0) with default `off`, the same as `dupes`,
  because under `auto` every adopter without fallow would get a
  `silentlySkippedAnalyzers` warning.
- That warning only fires for `auto` **and provider not declared**. An
  unconfigured default of `auto` when fallow is declared and `off` otherwise
  can therefore never nag. It also reaches existing adopters on upgrade, which
  an `init`-only change cannot, because `guardrails.config.json` is seed-once.
- `dupes` stays `off` regardless. Its reason is noise that only an
  adopter-written ignore list can fix, not the nag.

## Behaviour change (release notes must say this)

A repo that declares `fallow` and has no `complexity` key now runs the analyzer
at commit, push and ci. A function in a touched file that is over the repo's own
fallow thresholds blocks. `"complexity": "off"` restores the old behaviour.

## Task 1 — Mode resolution takes the declared providers

**Builds:**

- In `analyzer-policy.ts`, replace the `complexity: 'off'` entry with a
  provider-conditional default: `auto` when the analyzer's provider is
  declared, `off` when it isn't.
- Keep it data-driven: for example, `DEFAULT_MODES` values become `AnalyzerMode
| 'auto-if-declared'`, resolved by `analyzerMode(analyzers, tool,
isProviderDeclared)`. Every caller already has, or can cheaply derive, the
  declared set. The callers are `silentlySkippedAnalyzers` and
  `selectAnalyzers` in `verify/index.ts`, and `isAnalyzerAsked` in
  `scaffold/templates.ts`.
- An explicit config value always wins.
  **Tests (`analyzer-policy.test.ts` and caller tests):**
- `complexity`, unconfigured, with fallow declared, gives `auto`;
- unconfigured with fallow not declared gives `off`;
- explicit `off` and `required` win over both;
- `dupes` stays `off` either way;
- `silentlySkippedAnalyzers` never lists `complexity`;
- `runVerify` with fallow declared and no key spawns `fallow health`, and
  without fallow it does not.

## Task 2 — Docs

`docs/adoption.md`: complexity's row and the enabling text now say "on by
default where fallow is declared", with the opt-out. Update the `plan.md`
follow-up entry to done.

## Constraints

TDD; no suppressions, casts, `.skip` or weakened assertions; never
`--no-verify`; functions under fallow's thresholds; `node
guardrails-core/dist/cli.mjs verify` must be clean after `npm run build`
before each commit.
