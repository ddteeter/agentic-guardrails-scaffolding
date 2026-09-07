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
 * A starter fallow configuration, for the `dupes` analyzer.
 *
 * `.jsonc` rather than `.json` because fallow accepts comments there and this
 * seed is mostly commentary: the values a clone detector needs are exactly the
 * ones no default can get right, so the file's job is to say what to tune and
 * why. Same reasoning as the commented `.dependency-cruiser.cjs` above.
 *
 * `mode: "semantic"` rather than fallow's own `mild` default. Semantic is the
 * near-duplicate mode -- it matches blocks that differ only in identifier
 * names, which is the class the analyzer exists for: an agent that copies a
 * helper into a second module renames its parameters on the way.
 *
 * No `threshold`. fallow's own `--threshold` gate reads
 * `stats.duplication_percentage`, and under guardrails' diff-scoped reporting
 * that number is computed over the scoped file set rather than the project
 * (measured at 71.4% on a two-file fixture). guardrails raises one violation
 * per clone instance instead, so a project-wide percentage would be a number
 * that means nothing here.
 *
 * `ignore` starts EMPTY and is the field an adopter is expected to fill: a
 * clone detector's false positives are generated files, ORM schema DSLs and
 * framework boilerplate, and which of those a repo has is not knowable from
 * here. This is SEED-ONCE, so guardrails never touches it again.
 */
export const FALLOW_SEED = `{
  // Starter fallow configuration, seeded once by \`guardrails init\`.
  // guardrails never rewrites this file -- tune it freely.
  //
  // \`guardrails verify\` runs \`fallow dupes --format json --quiet\` from the
  // repository root with no --config and no tuning flags, so everything below
  // is what actually governs clone detection.
  "duplicates": {
    // "semantic" matches blocks that differ only in identifier names -- the
    // copy-then-rename an agent produces. "strict" is exact-token only;
    // "mild"/"weak" sit between.
    "mode": "semantic",
    // The floor for what counts as a clone. Lower finds more and rhymes more;
    // 50 is fallow's default and a reasonable place to start tuning.
    "minTokens": 50,
    "minLines": 5,
    // Raise to 3+ to report only widespread copy-paste and skip pair-only
    // clones.
    "minOccurrences": 2,
    // THE FIELD TO EDIT. A clone detector's false positives are repo-specific:
    // generated code, ORM/schema DSLs that legitimately repeat, and framework
    // boilerplate. Add globs here as you meet them -- for example:
    //   "**/*.gen.ts", "src/db/schema*.ts"
    "ignore": []
  }
}
`;

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
