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
 * 2. CANONICAL KEYS. `plan.ts`'s `classifyFile` matches SEED_ONCE_PATHS
 *    (and, via `merge.ts`'s `isSharedPath`, `SHARED_MERGERS`) by exact
 *    string, so a `./`-prefixed or backslash-separated key silently
 *    classifies as OWNED — where `--force` would overwrite a file that must
 *    never be overwritten. Every key goes through `canonicalKey`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../package-root.js';
import { analyzerMode, decideAnalyzer } from '../verify/analyzer-policy.js';
import type { RepoFacts } from './detect.js';
import {
  AGENTS_GUARDRAILS_END,
  AGENTS_GUARDRAILS_START,
  COPILOT_SKILLS_END,
  COPILOT_SKILLS_START,
} from './merge.js';
import type { SharedPath } from './merge.js';
import type { ScaffoldDecisions } from './plan.js';
import {
  DEPENDENCY_CRUISER_SEED,
  guardrailsConfigSeed,
  STRYKER_SEED,
} from './seeds.js';

/**
 * Spec §7.1's bootstrapping split, by name: `adopting-guardrails` explains
 * HOW to adopt guardrails, so it cannot itself be delivered BY adoption. It
 * ships in the tarball -- readable at
 * `node_modules/guardrails-core/guidance/adopting-guardrails.md` before
 * `init` has scaffolded anything -- and is deliberately excluded from every
 * path `init` writes into a consumer repo: `docs/guardrails/` doc bodies
 * (`guidanceEntries`), `.claude/skills/<name>/SKILL.md` (`claudeSkillEntries`),
 * and the `.github/copilot-instructions.md` index (`copilotInstructionsBlock`,
 * via `runtimeSkillIndex` -- an index entry pointing at a doc that is never
 * installed would be a dead link).
 * Do NOT remove this filter to "fix" a skill that looks missing from a
 * scaffolded repo -- installing this doc would put "how to adopt" inside the
 * very thing it explains how to adopt. A run-time skill that should be
 * installed needs a NEW name, not this one un-excluded.
 */
const ADOPTION_TIME_SKILL = 'adopting-guardrails';

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
  ['codex/agents/guardrail-fixer.toml', '.codex/agents/guardrail-fixer.toml'],
  [
    'codex/agents/guardrail-fixer-thorough.toml',
    '.codex/agents/guardrail-fixer-thorough.toml',
  ],
  // SHARED: consumers can define their own Codex hooks alongside ours.
  ['codex/hooks.json', '.codex/hooks.json'],
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
  // The branch-wide local rung. pre-commit scopes to staged files so commits
  // stay fast; this re-checks the whole branch once before it leaves the
  // machine, catching what a per-commit scope structurally cannot.
  ['githooks/pre-push', '.githooks/pre-push'],
  // OWNED, not SEED_ONCE or SHARED (spec §8.1): a consumer who edits this
  // workflow gets drift-reported and left alone on the next `init`, same as
  // any other owned file -- classifyFile's default, since this path is in
  // neither SEED_ONCE_PATHS nor SHARED_MERGERS.
  ['workflows/guardrails.yml', '.github/workflows/guardrails.yml'],
];

/**
 * SHARED paths whose merger derives the whole result from what is already on
 * disk: `mergeGitignore` takes no desired content at all, and `package.json`'s
 * merger touches only `scripts.prepare`. `planScaffold` still needs the path
 * present in `desired` for an action to be planned, and `applyScaffold` warns
 * on a planned path with no recorded content — so they carry this marker.
 *
 * It is never written anywhere given a path that STAYS classified `shared`:
 * `applyScaffold` routes every SHARED path to its merger and throws on one it
 * does not recognise. That throw does NOT cover every way this string could
 * leak, though — it fires only for a path `plan.ts` already calls `shared`.
 * REMOVING an entry from `merge.ts`'s `SHARED_MERGERS` instead demotes that
 * path to OWNED (see `plan.ts`'s `classifyFile`), where this marker would be
 * written to the consumer's file verbatim, silently. Typing this array as
 * `readonly SharedPath[]` (not `string[]`) closes that gap at compile time:
 * a path removed from `SHARED_MERGERS` also leaves the `SharedPath` union,
 * so listing it here stops compiling instead of failing silently at runtime.
 */
const MERGER_DERIVED = '(derived from the file already in the repository)';

const SHARED_DERIVED_PATHS: readonly SharedPath[] = [
  '.gitignore',
  'package.json',
];

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
 * Every RUN-TIME guidance doc in `directory`, as desired entries under
 * `docs/guardrails/`. Takes the directory rather than calling `guidanceRoot()`
 * itself so the non-`.md` filter is provable against a fixture -- the packaged
 * tree happens to hold only Markdown (plus `index.json`, itself proof the
 * filter does something), which would otherwise make the filter invisible.
 *
 * Excludes `ADOPTION_TIME_SKILL` -- see that constant's comment; this is
 * install path 1 of 2 for spec §7.1's bootstrapping split.
 *
 * Deliberately unsorted: `planScaffold` sorts the whole desired map before it
 * plans, so ordering here would be a second, unobservable sort.
 */
export function guidanceEntries(directory: string): DesiredEntry[] {
  return readdirSync(directory)
    .filter(
      (name) => name.endsWith('.md') && name !== `${ADOPTION_TIME_SKILL}.md`,
    )
    .map((name) => [
      `docs/guardrails/${name}`,
      readFileSync(path.join(directory, name), 'utf8'),
    ]);
}

/**
 * `guidance/index.json`, parsed. Trusted as-authored rather than
 * runtime-validated: it is self-authored packaged data written by this
 * repo's own `scripts/sync-agents.mjs`, never consumer- or network-supplied
 * -- the same convention `merge.ts`'s `HooksTemplate` documents for its own
 * `JSON.parse(...) as` cast.
 */
function skillIndex(directory: string): Record<string, string> {
  return JSON.parse(
    readFileSync(path.join(directory, 'index.json'), 'utf8'),
  ) as Record<string, string>;
}

/**
 * `skillIndex`, minus `ADOPTION_TIME_SKILL` -- the one lookup both
 * `claudeSkillEntries` and the Copilot index block need, so the exclusion is
 * applied once rather than separately at each of the two call sites.
 */
function runtimeSkillIndex(directory: string): Record<string, string> {
  const runtime: Record<string, string> = {};
  for (const [name, description] of Object.entries(skillIndex(directory))) {
    if (name !== ADOPTION_TIME_SKILL) {
      runtime[name] = description;
    }
  }
  return runtime;
}

/**
 * A guidance doc opens with a `<!-- Generated by scripts/sync-agents.mjs
 * from guardrails-plugin/skills/<name>/SKILL.md -->` provenance comment (see
 * that script). True of `docs/guardrails/*.md` and
 * `guardrails-core/guidance/*.md` alike -- both say the doc came from THIS
 * repo's own build. Reused inside a CONSUMER's installed
 * `.claude/skills/<name>/SKILL.md`, that claim is false: the consumer never
 * ran `scripts/sync-agents.mjs` and has no `guardrails-plugin/` directory.
 * So the comment (the doc's first line, followed by the blank line the
 * writer always inserts after it) is stripped before the body is reused as a
 * skill's content.
 */
function stripProvenanceComment(guidanceDocument: string): string {
  const bodyAt = guidanceDocument.indexOf('\n\n');
  return bodyAt === -1 ? guidanceDocument : guidanceDocument.slice(bodyAt + 2);
}

/** One skill's installed `.claude/skills/<name>/SKILL.md`: frontmatter
 *  rebuilt from `index.json`'s description, plus the guidance doc's body. */
function skillMarkdown(
  name: string,
  description: string,
  guidanceDocument: string,
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    stripProvenanceComment(guidanceDocument),
  ].join('\n');
}

/**
 * Spec §6.4 OWNED / §7.1 run-time half: `crushing-mutants` and
 * `boundary-validation` installed as `.claude/skills/<name>/SKILL.md`,
 * install path 2 of 2 for the bootstrapping split (`ADOPTION_TIME_SKILL` is
 * excluded via `runtimeSkillIndex`). The packaged `guidance/` tree is the
 * source: it ships each skill's body plus (since Task 3) an `index.json` of
 * descriptions, which is exactly enough to reconstruct a loadable SKILL.md
 * without shipping the whole plugin source tree a second time.
 *
 * Exported (like `guidanceEntries`) so `stripProvenanceComment`'s
 * no-leading-comment fallback -- never exercised by the real packaged tree,
 * which always carries the comment -- is provable against a fixture.
 */
export function claudeSkillEntries(directory: string): DesiredEntry[] {
  return Object.entries(runtimeSkillIndex(directory)).map(
    ([name, description]): DesiredEntry => [
      `.claude/skills/${name}/SKILL.md`,
      skillMarkdown(
        name,
        description,
        readFileSync(path.join(directory, `${name}.md`), 'utf8'),
      ),
    ],
  );
}

/**
 * The `.github/copilot-instructions.md` marker block, in the exact dialect
 * `merge.ts`'s `mergeCopilotInstructions` expects (its `block` argument
 * already carries its own markers) -- reusing `COPILOT_SKILLS_START/END`
 * rather than restating the literal strings, so this and that module cannot
 * grow two dialects of the same idea. Excludes `ADOPTION_TIME_SKILL` (via
 * `runtimeSkillIndex`): an index entry linking to
 * `docs/guardrails/adopting-guardrails.md` would be a dead link, since that
 * doc is never installed (see `guidanceEntries`).
 *
 * Not re-sorted here: `skillIndex` reads `index.json` back via `JSON.parse`,
 * which preserves the file's own key order, and `scripts/sync-agents.mjs`
 * already writes that file with sorted keys (the same "trusted as-authored"
 * reasoning `skillIndex`'s own comment gives for skipping validation applies
 * to its order too -- re-deriving an invariant the writer already guarantees
 * would be a second, unobservable sort, the same reason `guidanceEntries`
 * stays unsorted).
 */
function copilotInstructionsBlock(directory: string): string {
  return [
    COPILOT_SKILLS_START,
    '',
    '## Guardrails reference docs',
    '',
    'Read the linked doc **when its trigger applies** — not up front.',
    '',
    ...Object.entries(runtimeSkillIndex(directory)).map(
      ([name, description]) =>
        `- [\`${name}\`](../docs/guardrails/${name}.md) — ${description}`,
    ),
    '',
    ...GATE_CONTRACT,
    '',
    COPILOT_SKILLS_END,
  ].join('\n');
}

/**
 * The prohibitions every host must state UNCONDITIONALLY, in the instruction
 * file it always loads.
 *
 * The doc index these blocks are mostly made of is trigger-gated on purpose
 * ("read this when that applies"), which is right for method and wrong for a
 * prohibition: an agent about to write `eslint-disable` has no reason to open
 * a mutation-testing doc, so a rule that only lives behind a trigger is a rule
 * it never reads. `crushing-mutants` carried the sanction protocol, and only
 * for Stryker directives.
 *
 * The sanction paragraph is the load-bearing one. `scope.ts`'s
 * `DENIED_FILE_NAMES` stops the FIXER from reaching `guardrails.config.json`;
 * nothing stops the main agent, and `sanctions-check` reports a new grant and
 * exits 0 by design (the pull request is the review). In a `solo` repo there
 * may be no pull request at all. So the ask is the whole control, and the text
 * must not imply a backstop that does not exist.
 */
const GATE_CONTRACT: readonly string[] = [
  '### Never satisfy a gate by weakening it',
  '',
  'Fix the code. Never add a suppression (`eslint-disable`, `@ts-ignore`,',
  '`@ts-expect-error`, `@ts-nocheck`, `as any`, `.skip`, `.only`,',
  '`@SuppressWarnings`, `// Stryker disable`), never loosen or delete an',
  'assertion, and never delete code to quiet a checker. A deterministic',
  'diff-auditor inspects the branch diff and re-blocks on any of them.',
  '',
  'Equally off-limits: making a check pass by switching off the check.',
  "Never set an entry in `guardrails.config.json`'s `analyzers` block to",
  '`off`, never remove an analyzer from `package.json` to turn its',
  '`analyzer-missing` error into silence, and never raise a threshold.',
  '',
  '### Never grant yourself an exemption',
  '',
  "`guardrails.config.json`'s `sanctionedSuppressions` is the only escape",
  'hatch from the diff-auditor. **You do not add an entry to it.** Nothing',
  'downstream will catch it for you — the CI sanctions check reports a new',
  'grant and exits 0, because a human reviewing the change is the control.',
  '',
  'Ask the developer directly, and give them what they need to decide:',
  '',
  '- **What** the exemption covers — the exact `file|kind|text` key.',
  '- **Why** it is unavoidable — for an equivalent mutant, the argument that',
  '  no test can kill it; for anything else, what you tried first.',
  '- **What it costs** — what stops being checked once it is granted.',
  '',
  'If they approve, put the argument they accepted into `reason`: that text is',
  'what a reviewer reads later. If they do not, fix the code instead.',
];

/** Portable instruction index used by Codex and any other AGENTS.md host. */
function agentsInstructionsBlock(directory: string): string {
  return [
    AGENTS_GUARDRAILS_START,
    '',
    '## Guardrails',
    '',
    'If `CLAUDE.md` exists, read and follow it as additional project instructions.',
    '',
    'Read the linked reference **when its trigger applies** — not up front.',
    '',
    ...Object.entries(runtimeSkillIndex(directory)).map(
      ([name, description]) =>
        `- [\`${name}\`](docs/guardrails/${name}.md) — ${description}`,
    ),
    '',
    'When a guardrails Stop hook asks for a fixer, delegate only the violations-manifest path to the named fixer agent.',
    '',
    ...GATE_CONTRACT,
    '',
    AGENTS_GUARDRAILS_END,
  ].join('\n');
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
    ...claudeSkillEntries(guidanceRoot()),
    [
      '.github/copilot-instructions.md',
      copilotInstructionsBlock(guidanceRoot()),
    ] satisfies DesiredEntry,
    [
      'AGENTS.md',
      agentsInstructionsBlock(guidanceRoot()),
    ] satisfies DesiredEntry,
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
