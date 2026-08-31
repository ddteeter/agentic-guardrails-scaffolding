# Copilot instructions

<!-- guardrails:skills:start -->

## Guardrails reference docs

Read the linked doc **when its trigger applies** — not up front.

- [`adopting-guardrails`](../docs/guardrails/adopting-guardrails.md) — Use when installing guardrails-core into a repo — about to run `guardrails init`, or asked to set up, configure, or scaffold the guardrail loop for a project. Covers reading the CLI's plan before acting on it, proposing an analyzer set and enforcement level with reasoning, authoring the configs `init` deliberately does not own, and the real exit criterion — a green `guardrails verify`, not files written to disk.
- [`crushing-mutants`](../docs/guardrails/crushing-mutants.md) — Use when verify reports `stryker/survived` or `stryker/no-coverage` violations, or when working through mutants from a mutation-testing run. Covers triaging the list, writing tests that actually kill mutants, recognising vacuous assertions, proving a mutant equivalent, and the approval flow for the rare exemption.

<!-- guardrails:skills:end -->
