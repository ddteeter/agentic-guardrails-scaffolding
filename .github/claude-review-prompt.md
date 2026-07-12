# Agent Guardrails — Review Guidelines

These are **supplemental** to the standard code-review. The normal correctness /
quality / bug review still applies in full.

## About this project

`guardrails-core` is a runtime-agnostic npm package (CLI: `guardrails`) that
gates coding agents: it runs `verify`, normalizes every check into one
`Violation` schema, silently autofixes mechanical issues, and diverts
judgment-class violations to a restricted fixer subagent. A thin Claude Code
plugin wires the hooks. It is **open-source and this repo is public**.

## Security & the open-source boundary — HIGHEST PRIORITY

- **Public repo, no secrets, ever.** Flag any hardcoded token, API key, internal
  hostname, private registry URL, or org-specific value. There are no
  application secrets in this codebase by design; there should be none in a PR.
- **The open-source / proprietary boundary (plan §10.1).** `guardrails-core`
  must stay generic. Flag any company-specific rule, house policy, internal URL,
  or org threshold leaking into `src/` — those belong in per-repo policy
  (`guardrails.config.json`) or a private preset, never in core.
- **It shells out.** `src/exec.ts` spawns processes and the CLI runs git,
  eslint, tsc. Flag: `shell: true`, unsanitized interpolation of file paths /
  ruleIds / diff text into a command, or any path where attacker-influenced
  content (a crafted filename, a violation `message`) reaches a shell.
- **It parses untrusted tool output and diffs.** Adapters map eslint/tsc output
  and `audit.ts` scans raw diff text. Flag unvalidated `JSON.parse` results used
  without the `isViolation` guard, or regex/parse logic that could be driven to
  crash or mis-attribute by hostile input.
- **Workflow security (this dir).** For any `.github/workflows` change: flag a
  switch to `pull_request_target` that then runs PR code, an unpinned action
  (must be a full commit SHA), a broadened `permissions:` block, a removed
  owner-only `if:` gate, or untrusted `${{ github.event.* }}` interpolated
  directly into a `run:`/`prompt:` instead of via `env:`.

## Integrity of the guardrail itself

- **The gate/auditor must not be weakened.** This tool's whole value is that a
  fixer can't cheat. Flag any change that loosens `audit.ts` signatures, lets
  the fixer delete code, weakens the scope-lock, or removes a re-verify.
- **The `Violation` contract is load-bearing.** Flag changes to its shape or to
  `recurrenceKey` semantics that would break deterministic tallying.
- **Pure-Node ESM runtime invariant.** Shipped code (`src/**` → `dist/*.mjs`)
  must stay cross-platform pure Node — no bash, no platform-specific shelling
  where a Node API exists. (Dev tooling is exempt.)

## Quality-gate expectations (don't let the gate be gamed)

This repo enforces its own strict fallow gate (dead-code, duplication,
coverage-backed CRAP) plus strict ESLint + Prettier and a per-edit lint hook.

- **Fix code, don't weaken rules.** Flag any PR that disables lint rules, raises
  fallow thresholds, adds baselines, or excludes files from the gate to make a
  red check pass.
- **New complex code must be tested** (TDD). CRAP drops as coverage rises, so new
  complex functions ship with real behavioral tests — not coverage-gaming
  assertions, not a threshold bump.
- Prefer the smallest change that fixes the issue.

Keep feedback concrete, actionable, and prioritized (security first).
