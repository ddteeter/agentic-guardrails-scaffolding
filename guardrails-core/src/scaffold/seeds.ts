/**
 * The SEED-ONCE file bodies `guardrails init` generates rather than copies.
 *
 * Unlike everything under `templates/`, these three have no committed source in
 * this repository to copy from: `guardrails.config.json` is a function of the
 * adopter's own decisions, and the two analyzer configs are deliberately
 * MINIMAL starters rather than a copy of this repo's own (ours encode this
 * repo's layout and its house rules, which would be wrong — and in
 * dependency-cruiser's case actively broken — anywhere else).
 *
 * Every one is written at most once, and never rewritten afterwards (spec §6.4
 * SEED-ONCE), so they are starting points a consumer is expected to edit.
 */
import type { ScaffoldDecisions } from './plan.js';

/**
 * The adopter's policy file. Deterministic — two-space JSON with a trailing
 * newline — so the seeded file is prettier-clean and stays out of diffs.
 * `sanctionedSuppressions` starts empty on purpose: every entry is a reviewed
 * grant, and seeding one would be granting an exemption nobody asked for.
 */
export function guardrailsConfigSeed(
  baseBranch: string,
  decisions: ScaffoldDecisions,
): string {
  return `${JSON.stringify(
    {
      baseBranch,
      enforcement: decisions.enforcement,
      distribution: decisions.distribution,
      analyzers: decisions.analyzers,
      sanctionedSuppressions: [],
    },
    undefined,
    2,
  )}\n`;
}

/**
 * A starter dependency-cruiser configuration: the one rule that is right for
 * every repository (no cycles), and nothing else.
 *
 * It deliberately sets no `tsConfig`. Pointing dependency-cruiser at a
 * tsconfig is repo-shaped — a relative `fileName` mis-resolves an `extends`
 * chain in a workspace layout and makes depcruise exit non-zero with zero
 * modules cruised, which the gate reports as `analyzer-failed` on day one.
 * Adding it correctly requires knowing the consumer's layout, which is the
 * adoption skill's job (spec §7.2 step 5), not this seed's.
 */
export const DEPENDENCY_CRUISER_SEED = `/**
 * Starter dependency-cruiser configuration, seeded once by \`guardrails init\`.
 * guardrails never rewrites this file — tune it freely.
 *
 * \`guardrails verify\` runs \`depcruise --output-type json .\` from the repo
 * root with no --config, so this file's own \`exclude\`/\`doNotFollow\` and each
 * rule's from/to matchers are what scope the cruise.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies within the module graph.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // The trailing alternative excludes nested git worktrees. A worktree
    // checked out inside the repository is a whole second checkout of it, and
    // dependency-cruiser does not read .gitignore, so without this it cruises
    // every one of them. \`.claude/worktrees/\` is where Claude Code puts them
    // by default; add your own vendored or generated trees here too.
    exclude: {
      path: '(^|/)(dist|build|coverage|node_modules)/|^\\\\.claude/worktrees/',
    },
  },
};
`;

/**
 * A starter Stryker configuration.
 *
 * `testRunner: "command"` is the one runner that needs no extra plugin — it
 * shells out to `npm test` — so a freshly-seeded repo can run mutation testing
 * before choosing a framework-specific runner. `guardrails verify` passes
 * `--mutate` itself (the changed production files), so this file deliberately
 * declares no `mutate` list; it would be overridden every run.
 */
export const STRYKER_SEED = `${JSON.stringify(
  {
    $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    testRunner: 'command',
    reporters: ['json'],
    incremental: true,
  },
  undefined,
  2,
)}\n`;

/**
 * Starter knip configuration.
 *
 * knip was the one analyzer `adopting-guardrails` recommends that had no seed,
 * and it is the one whose defaults hurt a greenfield repo most. With no
 * `entry`, knip infers one from `package.json`'s `main`/`bin`/`exports` — which
 * an `npm init -y` repo points at a file that does not exist — and then reports
 * the project's first real module as `knip/files` "Unused file" and its
 * as-yet-unused test runner as an unused devDependency. Both are artifacts of a
 * module graph that has not been built yet, and both land on the first `verify`
 * the adoption guidance says has to come back green.
 *
 * `src/index.ts` and `src/**` are a guess, and deliberately a conventional one:
 * this is SEED-ONCE, so a repo laid out differently edits it once and guardrails
 * never touches it again. A wrong-but-visible starting point that the adopter
 * corrects beats a silent default that reports their whole codebase as dead.
 *
 * Test files are entry points too. knip resolves `vitest`/`jest` through its own
 * plugins, but only once a config for them exists; naming the conventional test
 * globs here means a repo whose tests are its only consumers of a module is not
 * told that module is unused.
 */
export const KNIP_SEED = `${JSON.stringify(
  {
    $schema: 'https://unpkg.com/knip@6/schema.json',
    entry: ['src/index.ts', 'src/main.ts', '**/*.{test,spec}.{ts,tsx}'],
    project: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
  },
  undefined,
  2,
)}\n`;
