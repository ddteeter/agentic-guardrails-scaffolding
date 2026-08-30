/**
 * Builds the `desired` map `planScaffold` decides over: every path
 * `guardrails init` wants to scaffold, mapped to the exact bytes it wants there.
 *
 * Two rules live HERE and nowhere else, because nothing downstream can express
 * them:
 *
 * 1. ANALYZER GATING (spec §6.4 SEED-ONCE). `.dependency-cruiser.cjs` and
 *    `stryker.conf.json` are written "only when those analyzers are enabled and
 *    no config already exists". `planScaffold` is pure and reads only the
 *    manifest, so the only way to express "do not write this at all" is to
 *    leave the path out of this map.
 * 2. CANONICAL KEYS. `plan.ts`'s `classifyFile` matches SEED_ONCE_PATHS /
 *    SHARED_PATHS by exact string, so a `./`-prefixed or backslash-separated
 *    key silently classifies as OWNED — where `--force` would overwrite a file
 *    that must never be overwritten. Every key goes through `canonicalKey`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../package-root.js';
import { analyzerMode, decideAnalyzer } from '../verify/analyzer-policy.js';
import type { RepoFacts } from './detect.js';
import type { ScaffoldDecisions } from './plan.js';
import {
  DEPENDENCY_CRUISER_SEED,
  guardrailsConfigSeed,
  STRYKER_SEED,
} from './seeds.js';

/** The consumer-facing template tree, shipped in the tarball (`files`). */
export function templatesRoot(): string {
  return path.join(packageRoot(), 'templates');
}

/** Run-time guidance docs, shipped in the tarball and copied INTO the consumer
 *  repo (spec §6.7): the Copilot cloud agent reads the default branch, where
 *  `node_modules` does not exist. */
export function guidanceRoot(): string {
  return path.join(packageRoot(), 'guidance');
}

/** One entry of the desired map: a canonical repo-relative path and its bytes. */
type DesiredEntry = readonly [string, string];

/**
 * Packaged template file -> where it lands in the consumer repo. An explicit
 * table rather than a directory walk: these destinations are what `plan.ts`
 * classifies by exact string, so they are contract, not discovery.
 */
const TEMPLATE_FILES: readonly DesiredEntry[] = [
  ['claude/agents/guardrail-fixer.md', '.claude/agents/guardrail-fixer.md'],
  [
    'claude/agents/guardrail-fixer-thorough.md',
    '.claude/agents/guardrail-fixer-thorough.md',
  ],
  // SHARED: the merger splices this hooks block into the consumer's own
  // settings file rather than replacing it.
  ['claude/settings.hooks.json', '.claude/settings.json'],
  [
    'copilot/agents/guardrail-fixer.agent.md',
    '.github/agents/guardrail-fixer.agent.md',
  ],
  [
    'copilot/agents/guardrail-fixer-thorough.agent.md',
    '.github/agents/guardrail-fixer-thorough.agent.md',
  ],
  ['copilot/hooks/guardrails.json', '.github/hooks/guardrails.json'],
  ['githooks/pre-commit', '.githooks/pre-commit'],
];

/*
 * Three paths spec §6.4 lists that this map deliberately does NOT yet carry,
 * each because its source is not in the tarball rather than because the
 * scaffolder cannot place it:
 *
 * - `.github/workflows/guardrails.yml` — the CI template is piece 6 (§8).
 * - `.claude/skills/<name>/SKILL.md` — the skills themselves are piece 5 (§7);
 *   the run-time GUIDANCE half of that bullet IS installed, into
 *   `docs/guardrails/` (§6.7), from the packaged `guidance/` tree.
 * - `.github/copilot-instructions.md` — a merger for it exists, but the block
 *   it would splice in is a progressive-disclosure index ("read this doc when
 *   this trigger applies"), and the per-doc trigger text lives in the plugin's
 *   SKILL.md frontmatter, which `guidance/` does not ship. Emitting bare links
 *   without triggers would be an index that tells an agent nothing about when
 *   to read anything. Shipping the descriptions means extending
 *   `scripts/sync-agents.mjs` and its drift-guard — pipeline work with its own
 *   slice.
 */

/**
 * SHARED paths whose merger derives the whole result from what is already on
 * disk: `mergeGitignore` takes no desired content at all, and `package.json`'s
 * merger touches only `scripts.prepare`. `planScaffold` still needs the path
 * present in `desired` for an action to be planned, and `applyScaffold` warns
 * on a planned path with no recorded content — so they carry this marker.
 *
 * It is never written anywhere: `applyScaffold` routes every SHARED path to its
 * merger and throws on one it does not recognise, so the only way this string
 * could reach a file is a SHARED path added to `plan.ts` without a merger,
 * which fails loudly there instead.
 */
const MERGER_DERIVED = '(derived from the file already in the repository)';

const SHARED_DERIVED_PATHS: readonly string[] = ['.gitignore', 'package.json'];

/**
 * The two analyzers whose config `init` seeds. `hasConfig` reads the DETECTED
 * fact, never a filename: `detect` probes `.dependency-cruiser.{cjs,js,json}`
 * while the seed-once key is `.cjs` only, so a consumer whose config is
 * `.dependency-cruiser.js` would otherwise be handed a second, silently ignored
 * dependency-cruiser config.
 *
 * `tool` and `provider` mirror verify's `ANALYZERS` table; a test holds them
 * against `ANALYZER_TOOLS` / `ANALYZER_PROVIDERS` so a rename there cannot
 * silently disable seeding here.
 */
export interface SeedOnceAnalyzer {
  readonly tool: string;
  readonly provider: string;
  readonly path: string;
  readonly seed: string;
  readonly hasConfig: (facts: RepoFacts) => boolean;
}

export const SEED_ONCE_ANALYZERS: readonly SeedOnceAnalyzer[] = [
  {
    tool: 'dependency-cruiser',
    provider: 'dependency-cruiser',
    path: '.dependency-cruiser.cjs',
    seed: DEPENDENCY_CRUISER_SEED,
    hasConfig: (facts) => facts.hasDependencyCruiserConfig,
  },
  {
    tool: 'stryker',
    provider: '@stryker-mutator/core',
    path: 'stryker.conf.json',
    seed: STRYKER_SEED,
    hasConfig: (facts) => facts.hasStrykerConfig,
  },
];

/**
 * Repo-relative, POSIX-separated, no `./` prefix — the precondition
 * `classifyFile` matches against. Exported so the normalisation itself has a
 * direct test: every key this module builds is already canonical, which would
 * otherwise make the normaliser unobservable.
 */
export function canonicalKey(key: string): string {
  return key.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
}

function readTemplate(relative: string): string {
  return readFileSync(path.join(templatesRoot(), relative), 'utf8');
}

function templateEntries(): DesiredEntry[] {
  return TEMPLATE_FILES.map(([source, destination]) => [
    destination,
    readTemplate(source),
  ]);
}

/**
 * Every guidance doc in `directory`, as desired entries under
 * `docs/guardrails/`. Takes the directory rather than calling `guidanceRoot()`
 * itself so the non-`.md` filter is provable against a fixture -- the packaged
 * tree happens to hold only Markdown, which would make the filter invisible.
 *
 * Deliberately unsorted: `planScaffold` sorts the whole desired map before it
 * plans, so ordering here would be a second, unobservable sort.
 */
export function guidanceEntries(directory: string): DesiredEntry[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => [
      `docs/guardrails/${name}`,
      readFileSync(path.join(directory, name), 'utf8'),
    ]);
}

/**
 * True when the repo actually asked for this analyzer — `required`, or an
 * unlisted/`auto` analyzer whose provider package the repo's own
 * `package.json` declares. That is exactly `decideAnalyzer`'s `reportMissing`
 * rule ("a declared-but-unresolvable tool is a broken install, not an
 * opt-out"), reused rather than restated so the two cannot drift. Seeding a
 * config for an analyzer nobody asked for would leave a file in the consumer's
 * repo that `init`, being seed-once, will never clean up.
 */
function analyzerAsked(
  analyzer: SeedOnceAnalyzer,
  facts: RepoFacts,
  decisions: ScaffoldDecisions,
): boolean {
  return decideAnalyzer(
    analyzerMode(decisions.analyzers, analyzer.tool),
    facts.declaredProviders.has(analyzer.provider),
  ).reportMissing;
}

function seedOnceEntries(
  facts: RepoFacts,
  decisions: ScaffoldDecisions,
): DesiredEntry[] {
  // `guardrails.config.json` needs no presence gate: it has exactly one valid
  // filename, so an existing one shows up in `current` and `decideSeedOnce`
  // reports it unchanged. The analyzer configs have several valid filenames,
  // which is why only they are gated on a detected fact.
  const entries: DesiredEntry[] = [
    [
      'guardrails.config.json',
      guardrailsConfigSeed(facts.baseBranch, decisions),
    ],
  ];
  for (const analyzer of SEED_ONCE_ANALYZERS) {
    if (
      analyzerAsked(analyzer, facts, decisions) &&
      !analyzer.hasConfig(facts)
    ) {
      entries.push([analyzer.path, analyzer.seed]);
    }
  }
  return entries;
}

export function buildDesiredFiles(
  facts: RepoFacts,
  decisions: ScaffoldDecisions,
): Record<string, string> {
  const desired: Record<string, string> = {};
  for (const [key, content] of [
    ...templateEntries(),
    ...guidanceEntries(guidanceRoot()),
    ...SHARED_DERIVED_PATHS.map((shared): DesiredEntry => [
      shared,
      MERGER_DERIVED,
    ]),
    ...seedOnceEntries(facts, decisions),
  ]) {
    desired[canonicalKey(key)] = content;
  }
  return desired;
}
