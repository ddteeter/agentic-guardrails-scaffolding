<!-- guardrails:instructions:start -->

## Guardrails

If `CLAUDE.md` exists, read and follow it as additional project instructions.

Read the linked reference **when its trigger applies** — not up front.

- [`adopting-guardrails`](docs/guardrails/adopting-guardrails.md) — Use when installing guardrails-core into a repo — about to run `guardrails init`, or asked to set up, configure, or scaffold the guardrail loop for a project. Covers reading the CLI's plan before acting on it, proposing an analyzer set and enforcement level with reasoning, authoring the configs `init` deliberately does not own, and the real exit criterion — a green `guardrails verify`, not files written to disk.
- [`boundary-validation`](docs/guardrails/boundary-validation.md) — Use when a fix touches an `as` cast on data crossing a trust boundary — parsed JSON from disk, a network response, an environment variable, or external tool output — especially when the only mechanical fix for a type error there would be adding one. Covers why no lint rule reliably gates this, the runtime-validator alternative, and what's deliberately left for the adopting repo to decide.
- [`crushing-mutants`](docs/guardrails/crushing-mutants.md) — Use when verify reports `stryker/survived` or `stryker/no-coverage` violations, or when working through mutants from a mutation-testing run. Covers triaging the list, writing tests that actually kill mutants, recognising vacuous assertions, proving a mutant equivalent, and the approval flow for the rare exemption.

When a guardrails Stop hook asks for a fixer, delegate only the violations-manifest path to the named fixer agent.

<!-- guardrails:instructions:end -->
