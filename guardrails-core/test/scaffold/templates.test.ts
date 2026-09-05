/**
 * The `desired` content map -- what `guardrails init` intends every scaffolded
 * path to contain. This is where SPEC §6.4's analyzer gating lives: `plan.ts`
 * reads only the manifest, so "written only when that analyzer is enabled and
 * no config already exists" can only be expressed by leaving the path out of
 * this map. The gating tests below are therefore the only place that property
 * is provable.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RepoFacts } from '../../src/scaffold/detect.js';
import {
  classifyFile,
  type ScaffoldDecisions,
} from '../../src/scaffold/plan.js';
import {
  buildDesiredFiles,
  canonicalKey,
  claudeSkillEntries,
  guidanceEntries,
  guidanceRoot,
  SEED_ONCE_ANALYZERS,
  templatesRoot,
} from '../../src/scaffold/templates.js';
import { ANALYZER_PROVIDERS, ANALYZER_TOOLS } from '../../src/verify/index.js';

function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    repoRoot: '/repo',
    baseBranch: 'main',
    declaredProviders: new Set<string>(),
    hasDependencyCruiserConfig: false,
    hasStrykerConfig: false,
    hasKnipConfig: false,
    existingAnalyzers: undefined,
    manifest: undefined,
    hooksPath: undefined,
    ...over,
  };
}

/** Reads one entry, failing the test (rather than throwing later) when the
 *  desired map does not carry it at all. */
function contentOf(
  desired: Readonly<Record<string, string>>,
  key: string,
): string {
  const value = desired[key];
  expect(value).toBeDefined();
  return value ?? '';
}

function decisions(over: Partial<ScaffoldDecisions> = {}): ScaffoldDecisions {
  return {
    analyzers: {},
    enforcement: 'warn',
    distribution: 'solo',
    force: false,
    ...over,
  };
}

const DEPCRUISE_PATH = '.dependency-cruiser.cjs';
const STRYKER_PATH = 'stryker.conf.json';
const KNIP_PATH = 'knip.json';

/** `toHaveProperty` reads a dot as a nested-path separator, and every key in
 *  this map contains dots -- so membership is asserted on the key list. */
function keysOf(desired: Readonly<Record<string, string>>): string[] {
  return Object.keys(desired);
}

describe('templatesRoot / guidanceRoot', () => {
  it('resolve against the installed package, not the consumer repo', () => {
    // A consumer has no `templates/` or `guidance/` of their own; both must
    // resolve inside guardrails-core wherever it is installed.
    expect(templatesRoot()).toBe(
      path.join(path.dirname(guidanceRoot()), 'templates'),
    );
    expect(path.basename(path.dirname(templatesRoot()))).toBe(
      'guardrails-core',
    );
  });

  it('point at the tree that actually ships', () => {
    expect(
      existsSync(path.join(templatesRoot(), 'githooks', 'pre-commit')),
    ).toBe(true);
    expect(existsSync(guidanceRoot())).toBe(true);
  });
});

describe('buildDesiredFiles — the shipped template tree', () => {
  it.each([
    '.claude/agents/guardrail-fixer.md',
    '.claude/agents/guardrail-fixer-thorough.md',
    '.claude/settings.json',
    '.codex/agents/guardrail-fixer.toml',
    '.codex/agents/guardrail-fixer-thorough.toml',
    '.codex/hooks.json',
    'AGENTS.md',
    '.github/agents/guardrail-fixer.agent.md',
    '.github/agents/guardrail-fixer-thorough.agent.md',
    '.github/hooks/guardrails.json',
    '.githooks/pre-commit',
    '.github/workflows/guardrails.yml',
    '.gitignore',
    'package.json',
    'guardrails.config.json',
  ])('includes %s', (key) => {
    expect(Object.keys(buildDesiredFiles(facts(), decisions()))).toContain(key);
  });

  it('carries the template bytes verbatim for an owned file', () => {
    const desired = buildDesiredFiles(facts(), decisions());
    expect(contentOf(desired, '.githooks/pre-commit')).toBe(
      readFileSync(
        path.join(templatesRoot(), 'githooks', 'pre-commit'),
        'utf8',
      ),
    );
  });

  it('scaffolds a pre-push hook running the branch-scoped gate', () => {
    // The third local rung. `--mode=commit` now means "staged files", so
    // without this nothing re-checks the whole branch until CI.
    const desired = buildDesiredFiles(facts(), decisions());
    expect(Object.keys(desired)).toContain('.githooks/pre-push');
    expect(contentOf(desired, '.githooks/pre-push')).toContain('--mode=push');
  });

  it('runs the shipped CI workflow at the ci rung, not the commit rung', () => {
    // Correctness, not tidiness: `--mode=commit` scopes to STAGED files, and
    // nothing is staged in a CI checkout -- so the old spelling would check an
    // empty file set and report clean.
    const workflow = readFileSync(
      path.join(templatesRoot(), 'workflows', 'guardrails.yml'),
      'utf8',
    );
    expect(workflow).toContain('gate --mode=ci');
    expect(workflow).not.toContain('gate --mode=commit');
  });

  it('carries the CI workflow template bytes verbatim (spec §8.1)', () => {
    const desired = buildDesiredFiles(facts(), decisions());
    expect(contentOf(desired, '.github/workflows/guardrails.yml')).toBe(
      readFileSync(
        path.join(templatesRoot(), 'workflows', 'guardrails.yml'),
        'utf8',
      ),
    );
  });

  it('maps the claude hooks block onto .claude/settings.json', () => {
    // SHARED: the merger splices this block into the consumer's own settings.
    const desired = buildDesiredFiles(facts(), decisions());
    expect(contentOf(desired, '.claude/settings.json')).toBe(
      readFileSync(
        path.join(templatesRoot(), 'claude', 'settings.hooks.json'),
        'utf8',
      ),
    );
  });

  it('gates git commit/push on the Claude channel, as the Copilot channel already does', () => {
    // `--no-verify` is the documented bypass, and the design is content with
    // that BECAUSE a human holds it. In a repo an agent develops on its own
    // there is no such holder: `.githooks/pre-commit` is the only local check
    // and one flag skips it. Copilot has closed this since Phase B — its
    // `preToolUse` `bash` matcher runs the same commit gate before the command
    // executes, `--no-verify` included. Claude Code, the surface this repo
    // dogfoods, had no Bash matcher at all.
    const desired = buildDesiredFiles(facts(), decisions());
    const settings = JSON.parse(
      contentOf(desired, '.claude/settings.json'),
    ) as {
      hooks?: {
        PreToolUse?: { matcher?: string; hooks?: { command: string }[] }[];
      };
    };
    const bashHook = settings.hooks?.PreToolUse?.find((entry) =>
      (entry.matcher ?? '').includes('Bash'),
    );
    expect(bashHook).toBeDefined();
    expect(
      bashHook?.hooks?.some((hook) =>
        hook.command.includes('gate --mode=pretooluse'),
      ),
    ).toBe(true);
  });

  it('installs every packaged RUN-TIME guidance doc under docs/guardrails', () => {
    // Spec §6.7: run-time guidance is COPIED IN, because the Copilot cloud
    // agent reads the default branch, where node_modules does not exist.
    // `adopting-guardrails` is excluded below: it is spec §7.1's ADOPTION-TIME
    // doc, and this test previously asserted "every" packaged doc lands here
    // -- which was wrong, and is the Critical finding this suite now encodes
    // correctly instead of working around.
    const desired = buildDesiredFiles(facts(), decisions());
    const documents = readdirSync(guidanceRoot()).filter(
      (name) => name.endsWith('.md') && name !== 'adopting-guardrails.md',
    );
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      expect(contentOf(desired, `docs/guardrails/${document}`)).toBe(
        readFileSync(path.join(guidanceRoot(), document), 'utf8'),
      );
    }
  });

  it('does NOT install the adoption-time skill under docs/guardrails', () => {
    // The Critical finding: a review packed the tarball, ran `init --apply`
    // into a scratch repo, and watched docs/guardrails/adopting-guardrails.md
    // appear. Spec §6.4/§7.1 say a skill that explains how to adopt
    // guardrails cannot itself be delivered BY adoption -- it ships in the
    // tarball only, readable at
    // node_modules/guardrails-core/guidance/adopting-guardrails.md before
    // `init` has scaffolded anything.
    const desired = buildDesiredFiles(facts(), decisions());
    expect(Object.keys(desired)).not.toContain(
      'docs/guardrails/adopting-guardrails.md',
    );
  });
});

describe('buildDesiredFiles — .claude/skills/<name>/SKILL.md (spec §6.4 OWNED, run-time only)', () => {
  it('installs the run-time skills as .claude/skills/<name>/SKILL.md', () => {
    const desired = buildDesiredFiles(facts(), decisions());
    expect(Object.keys(desired)).toContain(
      '.claude/skills/crushing-mutants/SKILL.md',
    );
    expect(Object.keys(desired)).toContain(
      '.claude/skills/boundary-validation/SKILL.md',
    );
  });

  it('rebuilds valid SKILL.md frontmatter from the packaged guidance/index.json', () => {
    // guidance/ ships only the body (parseSkill strips frontmatter before
    // writing it); the installed SKILL.md needs a real `name`/`description`
    // header to load as a Claude Code skill, reconstructed from index.json.
    const desired = buildDesiredFiles(facts(), decisions());
    const content = contentOf(
      desired,
      '.claude/skills/crushing-mutants/SKILL.md',
    );
    expect(content).toMatch(/^---\nname: crushing-mutants\n/);
    expect(content).toContain('stryker/survived');
  });

  it('does NOT install adopting-guardrails as a .claude skill', () => {
    // This is the point of the bootstrapping split (spec §7.1): the doc that
    // explains how to adopt guardrails cannot itself be installed BY
    // adoption. Asserted as its own test, not folded into the positive
    // assertions above, because a negative is easy to lose silently if the
    // packaged skill list ever grows.
    const desired = buildDesiredFiles(facts(), decisions());
    expect(Object.keys(desired)).not.toContain(
      '.claude/skills/adopting-guardrails/SKILL.md',
    );
  });
});

describe('buildDesiredFiles — .github/copilot-instructions.md (spec §7 Task 3)', () => {
  it('includes the marker block with a skill trigger, not merely a link', () => {
    // A bare-links index is the failure this task exists to avoid: an agent
    // with only a link and no trigger text has nothing telling it WHEN to
    // read the doc. Assert the description text is present, not just the URL.
    const desired = buildDesiredFiles(facts(), decisions());
    const content = contentOf(desired, '.github/copilot-instructions.md');
    expect(content).toContain('<!-- guardrails:skills:start -->');
    expect(content).toContain('<!-- guardrails:skills:end -->');
    expect(content).toContain('(../docs/guardrails/crushing-mutants.md)');
    // Trigger text from crushing-mutants' frontmatter description, not just
    // the link -- proves the index carries WHEN to read the doc.
    expect(content).toContain('stryker/survived');
  });

  it('does not index the adoption-time skill, which is never installed here', () => {
    // An index entry linking to docs/guardrails/adopting-guardrails.md would
    // be a dead link in a consumer repo, since that doc is never installed.
    const desired = buildDesiredFiles(facts(), decisions());
    const content = contentOf(desired, '.github/copilot-instructions.md');
    expect(content).not.toContain('adopting-guardrails');
  });

  it('states the never-weaken-the-gate contract unconditionally', () => {
    const content = contentOf(
      buildDesiredFiles(facts(), decisions()),
      '.github/copilot-instructions.md',
    );
    expect(content).toContain(NEVER_WEAKEN_HEADING);
  });
});

describe('buildDesiredFiles — Codex', () => {
  it('installs Codex hooks and both custom fixer agents', () => {
    const desired = buildDesiredFiles(facts(), decisions());
    expect(desired).toHaveProperty('.codex/hooks.json');
    expect(desired).toHaveProperty('.codex/agents/guardrail-fixer.toml');
    expect(desired).toHaveProperty(
      '.codex/agents/guardrail-fixer-thorough.toml',
    );
  });

  it('adds a marker-owned AGENTS.md index with runtime triggers', () => {
    const content = contentOf(
      buildDesiredFiles(facts(), decisions()),
      'AGENTS.md',
    );
    expect(content).toContain('<!-- guardrails:instructions:start -->');
    expect(content).toContain('(docs/guardrails/crushing-mutants.md)');
    expect(content).toContain('stryker/survived');
    expect(content).not.toContain('adopting-guardrails');
  });
});

/**
 * The doc index above is deliberately trigger-gated ("read this when that
 * applies"), which is right for method but wrong for a prohibition: an agent
 * about to write `eslint-disable` has no reason to open a mutation-testing
 * doc, so a contract that only lives behind a trigger is a contract the agent
 * never reads. These pin the parts that must be stated unconditionally, in
 * every host's always-loaded instruction file.
 */
const NEVER_WEAKEN_HEADING = 'Never satisfy a gate by weakening it';

describe.each([
  ['AGENTS.md', 'AGENTS.md'],
  ['Copilot instructions', '.github/copilot-instructions.md'],
])('buildDesiredFiles — %s gate contract', (_label, file) => {
  const content = (): string =>
    contentOf(buildDesiredFiles(facts(), decisions()), file);

  it('forbids the suppression syntaxes the diff-auditor watches for', () => {
    expect(content()).toContain('eslint-disable');
    expect(content()).toContain('@ts-expect-error');
    expect(content()).toContain('.skip');
  });

  it('forbids switching an analyzer off to make a check pass', () => {
    // The fixer cannot reach guardrails.config.json (scope.ts's
    // DENIED_FILE_NAMES); the main agent can, and nothing else stops it.
    expect(content()).toContain('analyzers');
  });

  it('forbids skipping the commit gate outright', () => {
    // The gate contract enumerated every way to weaken a check and omitted the
    // one that skips it wholesale. `--no-verify` is the design's deliberate
    // HUMAN escape hatch; nothing in a consumer repo said an agent must not
    // reach for it, and on a solo repo with no CI there is nothing downstream
    // that would notice.
    expect(content()).toContain('--no-verify');
  });

  it('tells the agent it may never grant itself a sanctioned suppression', () => {
    expect(content()).toContain('sanctionedSuppressions');
    expect(content()).toContain('file|kind|text');
  });

  it('does not promise a downstream check that will catch a self-grant', () => {
    // `sanctions-check` PRINTS a new grant and exits 0 by design -- there is
    // no automated backstop, which is precisely why the ask is mandatory.
    // Telling the agent otherwise hands it the rationalization.
    expect(content()).not.toContain('CI fails on every newly-added key');
  });
});

describe('claudeSkillEntries', () => {
  let guidance: string;

  beforeEach(() => {
    guidance = mkdtempSync(path.join(tmpdir(), 'guardrails-skills-'));
  });

  afterEach(() => {
    rmSync(guidance, { recursive: true, force: true });
  });

  it('rebuilds SKILL.md frontmatter and strips the leading provenance comment', () => {
    writeFileSync(
      path.join(guidance, 'index.json'),
      `${JSON.stringify({ 'my-skill': 'Use when testing.' })}\n`,
    );
    writeFileSync(
      path.join(guidance, 'my-skill.md'),
      '<!-- Generated by scripts/sync-agents.mjs from guardrails-plugin/skills/my-skill/SKILL.md -->\n\n# My skill\n\nBody text.\n',
    );

    expect(claudeSkillEntries(guidance)).toEqual([
      [
        '.claude/skills/my-skill/SKILL.md',
        '---\nname: my-skill\ndescription: Use when testing.\n---\n\n# My skill\n\nBody text.\n',
      ],
    ]);
  });

  it('leaves the body untouched when there is no blank line to split on', () => {
    // stripProvenanceComment's fallback: the real packaged tree always opens
    // with `<comment>\n\n<body>`, so only a fixture with NO blank line
    // anywhere proves the indexOf(...) === -1 branch.
    writeFileSync(
      path.join(guidance, 'index.json'),
      `${JSON.stringify({ 'my-skill': 'Use when testing.' })}\n`,
    );
    writeFileSync(path.join(guidance, 'my-skill.md'), 'No comment here.\n');

    expect(claudeSkillEntries(guidance)).toEqual([
      [
        '.claude/skills/my-skill/SKILL.md',
        '---\nname: my-skill\ndescription: Use when testing.\n---\n\nNo comment here.\n',
      ],
    ]);
  });

  it('excludes adopting-guardrails from the .claude/skills install', () => {
    writeFileSync(
      path.join(guidance, 'index.json'),
      `${JSON.stringify({
        'adopting-guardrails': 'Use when adopting.',
        'my-skill': 'Use when testing.',
      })}\n`,
    );
    writeFileSync(
      path.join(guidance, 'adopting-guardrails.md'),
      '# Adopting\n\nBody.\n',
    );
    writeFileSync(path.join(guidance, 'my-skill.md'), '# My skill\n\nBody.\n');

    expect(claudeSkillEntries(guidance).map(([key]) => key)).toEqual([
      '.claude/skills/my-skill/SKILL.md',
    ]);
  });
});

describe('guidanceEntries', () => {
  let guidance: string;

  beforeEach(() => {
    guidance = mkdtempSync(path.join(tmpdir(), 'guardrails-guidance-'));
  });

  afterEach(() => {
    rmSync(guidance, { recursive: true, force: true });
  });

  it('installs every Markdown doc under docs/guardrails, and nothing else', () => {
    // The packaged tree happens to hold only Markdown today; a fixture is the
    // only way to prove the filter is doing anything at all.
    writeFileSync(path.join(guidance, 'beta.md'), 'beta body\n');
    writeFileSync(path.join(guidance, 'alpha.md'), 'alpha body\n');
    writeFileSync(path.join(guidance, 'index.json'), '{}\n');

    expect(
      guidanceEntries(guidance).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ).toEqual([
      ['docs/guardrails/alpha.md', 'alpha body\n'],
      ['docs/guardrails/beta.md', 'beta body\n'],
    ]);
  });

  it('yields nothing for a directory with no guidance in it', () => {
    writeFileSync(path.join(guidance, 'notes.txt'), 'not guidance\n');
    expect(guidanceEntries(guidance)).toEqual([]);
  });

  it('excludes adopting-guardrails.md -- adoption-time guidance, never installed', () => {
    // Install path 1 of 2 for the Critical finding: guidanceEntries feeds
    // docs/guardrails/*.md. adopting-guardrails ships in the tarball
    // (guardrails-core/guidance/) so it is readable BEFORE `init` runs, and
    // must never land inside the repo it explains how to adopt.
    writeFileSync(path.join(guidance, 'crushing-mutants.md'), 'body\n');
    writeFileSync(
      path.join(guidance, 'adopting-guardrails.md'),
      'adoption body\n',
    );

    expect(guidanceEntries(guidance)).toEqual([
      ['docs/guardrails/crushing-mutants.md', 'body\n'],
    ]);
  });
});

describe('canonicalKey', () => {
  // Tested directly because every key this module builds is ALREADY canonical:
  // routed only through buildDesiredFiles, the normalisation would be
  // unobservable, and an unobservable guard is no guard at all.
  it('rewrites backslash separators to POSIX', () => {
    expect(canonicalKey(String.raw`.claude\agents\fixer.md`)).toBe(
      '.claude/agents/fixer.md',
    );
  });

  it('strips a leading "./", however many times it is repeated', () => {
    expect(canonicalKey('./guardrails.config.json')).toBe(
      'guardrails.config.json',
    );
    expect(canonicalKey('././guardrails.config.json')).toBe(
      'guardrails.config.json',
    );
  });

  it('leaves a dotfile at the repo root alone', () => {
    expect(canonicalKey('.gitignore')).toBe('.gitignore');
  });

  it('strips only a LEADING "./", never one in the middle of a path', () => {
    expect(canonicalKey('docs/./guardrails.md')).toBe('docs/./guardrails.md');
  });
});

describe('buildDesiredFiles — canonical keys', () => {
  it('emits repo-relative POSIX keys with no "./" prefix or backslash', () => {
    // PRECONDITION of plan.ts's classifyFile, which matches SEED_ONCE_PATHS
    // and (via merge.ts's isSharedPath) SHARED_MERGERS by exact string: a
    // './guardrails.config.json' or a backslash-separated key silently
    // classifies as OWNED, where --force would overwrite a file that must
    // never be overwritten.
    for (const key of Object.keys(
      buildDesiredFiles(
        facts({ declaredProviders: new Set(ANALYZER_PROVIDERS) }),
        decisions(),
      ),
    )) {
      expect(key.startsWith('./')).toBe(false);
      expect(key).not.toContain('\\');
      expect(path.posix.isAbsolute(key)).toBe(false);
    }
  });
});

describe('buildDesiredFiles — guardrails.config.json seed', () => {
  it('records the decisions and the detected base branch', () => {
    const desired = buildDesiredFiles(
      facts({ baseBranch: 'trunk' }),
      decisions({
        analyzers: { stryker: 'off' },
        enforcement: 'block',
        distribution: 'team',
      }),
    );
    expect(JSON.parse(contentOf(desired, 'guardrails.config.json'))).toEqual({
      baseBranch: 'trunk',
      enforcement: 'block',
      distribution: 'team',
      analyzers: { stryker: 'off' },
      sanctionedSuppressions: [],
    });
  });

  it('ends with a newline so the seeded file is diff-clean', () => {
    const desired = buildDesiredFiles(facts(), decisions());
    expect(contentOf(desired, 'guardrails.config.json').endsWith('}\n')).toBe(
      true,
    );
  });
});

describe('buildDesiredFiles — analyzer gating (spec §6.4 SEED-ONCE)', () => {
  it('seeds neither analyzer config when neither analyzer was asked for', () => {
    const desired = buildDesiredFiles(facts(), decisions());
    expect(keysOf(desired)).not.toContain(DEPCRUISE_PATH);
    expect(keysOf(desired)).not.toContain(STRYKER_PATH);
  });

  it('seeds .dependency-cruiser.cjs when required and no config exists', () => {
    const desired = buildDesiredFiles(
      facts(),
      decisions({ analyzers: { 'dependency-cruiser': 'required' } }),
    );
    expect(contentOf(desired, DEPCRUISE_PATH)).toContain('module.exports');
    expect(contentOf(desired, DEPCRUISE_PATH)).toContain('no-circular');
  });

  it('seeds stryker.conf.json when required and no config exists', () => {
    const desired = buildDesiredFiles(
      facts(),
      decisions({ analyzers: { stryker: 'required' } }),
    );
    // Pinned whole: `guardrails verify` reads stryker's JSON report from a
    // fixed path and treats a missing one as a FAILED mutation check, so the
    // reporter list is load-bearing, not decoration.
    expect(JSON.parse(contentOf(desired, STRYKER_PATH))).toEqual({
      $schema:
        './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
      testRunner: 'command',
      reporters: ['json'],
      incremental: true,
    });
  });

  /**
   * `guardrails.config.json` is SEED-ONCE, so on a re-run `--analyzers` cannot
   * change the policy -- but it was still driving what got seeded FROM that
   * policy. `--analyzers=stryker=required` on an already-configured repo left
   * every unnamed analyzer at `auto`, so dependency-cruiser looked asked-for
   * and got a config seeded, while the real config said `off`. Orphans are
   * never removed, so that file stays forever, for a tool that never runs.
   */
  it('follows an existing config over the flags when deciding what to seed', () => {
    const desired = buildDesiredFiles(
      facts({
        existingAnalyzers: { 'dependency-cruiser': 'off', stryker: 'required' },
      }),
      decisions({ analyzers: { 'dependency-cruiser': 'required' } }),
    );
    expect(keysOf(desired)).not.toContain(DEPCRUISE_PATH);
    expect(keysOf(desired)).toContain(STRYKER_PATH);
  });

  it('falls back to the flags when no config exists yet to override them', () => {
    // The first run is the one the flags are for: the file they would seed
    // does not exist, so there is nothing more authoritative to read.
    const desired = buildDesiredFiles(
      facts({ existingAnalyzers: undefined }),
      decisions({ analyzers: { 'dependency-cruiser': 'required' } }),
    );
    expect(keysOf(desired)).toContain(DEPCRUISE_PATH);
  });

  it('does NOT seed .dependency-cruiser.cjs for a consumer whose config is .dependency-cruiser.js', () => {
    // THE bug this gating exists to prevent. `detect` probes
    // `.dependency-cruiser.{cjs,js,json}`, but the seed-once key is `.cjs`
    // ONLY -- so gating on the filename instead of the FACT would hand that
    // consumer a second dependency-cruiser config, one of them silently
    // ignored, with no error anywhere.
    const desired = buildDesiredFiles(
      facts({ hasDependencyCruiserConfig: true }),
      decisions({ analyzers: { 'dependency-cruiser': 'required' } }),
    );
    expect(keysOf(desired)).not.toContain(DEPCRUISE_PATH);
  });

  it('does NOT seed stryker.conf.json when a stryker config already exists', () => {
    const desired = buildDesiredFiles(
      facts({ hasStrykerConfig: true }),
      decisions({ analyzers: { stryker: 'required' } }),
    );
    expect(keysOf(desired)).not.toContain(STRYKER_PATH);
  });

  it('seeds knip.json, so a greenfield repo is not told its only module is dead', () => {
    // knip was the one recommended analyzer with no starter config, and it is
    // the one that most needs an `entry`. Without it, knip walks the repo and
    // reports a greenfield project's first module as an unused file and its
    // as-yet-unused test runner as an unused devDependency — findings that are
    // artifacts of an empty module graph, on the very first `verify` the
    // adoption guidance says must come back green.
    const desired = buildDesiredFiles(
      facts(),
      decisions({ analyzers: { knip: 'required' } }),
    );
    expect(keysOf(desired)).toContain(KNIP_PATH);
    const seed = JSON.parse(contentOf(desired, KNIP_PATH)) as {
      entry?: string[];
      project?: string[];
    };
    // The exact globs, not just "some globs": an empty or shortened `entry` is
    // the failure this seed exists to prevent, and it fails the same silent way
    // as no seed at all — knip reports every module no entry point reaches.
    expect(seed.entry).toEqual([
      'src/index.ts',
      'src/main.ts',
      '**/*.{test,spec}.{ts,tsx}',
    ]);
    expect(seed.project).toEqual(['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}']);
  });

  it('seeds a knip config whose entry set covers tests, not only src', () => {
    // Stated as its own case because it is the non-obvious half. A module whose
    // only consumer is a test is live code; an `entry` of `src/index.ts` alone
    // reports it dead, and the honest-looking fix is to delete it.
    const desired = buildDesiredFiles(
      facts(),
      decisions({ analyzers: { knip: 'required' } }),
    );
    const seed = JSON.parse(contentOf(desired, KNIP_PATH)) as {
      entry?: string[];
    };
    expect(seed.entry?.some((glob) => glob.includes('test'))).toBe(true);
  });

  it('does NOT seed knip.json when the repo already configures knip', () => {
    // Same fact-not-filename rule as dependency-cruiser: knip reads its config
    // from several filenames AND from a `knip` key in package.json, so a second
    // config would be silently ignored.
    const desired = buildDesiredFiles(
      facts({ hasKnipConfig: true }),
      decisions({ analyzers: { knip: 'required' } }),
    );
    expect(keysOf(desired)).not.toContain(KNIP_PATH);
  });

  it('does NOT seed a config for an analyzer turned off', () => {
    const desired = buildDesiredFiles(
      facts({ declaredProviders: new Set(ANALYZER_PROVIDERS) }),
      decisions({
        analyzers: { 'dependency-cruiser': 'off', stryker: 'off' },
      }),
    );
    expect(keysOf(desired)).not.toContain(DEPCRUISE_PATH);
    expect(keysOf(desired)).not.toContain(STRYKER_PATH);
  });

  it('seeds an unlisted (auto) analyzer whose provider the repo declares', () => {
    // `auto` + declared package == the repo asked for it: the same rule
    // `decideAnalyzer` uses to decide a missing binary is an error.
    const desired = buildDesiredFiles(
      facts({ declaredProviders: new Set(['dependency-cruiser']) }),
      decisions(),
    );
    expect(keysOf(desired)).toContain(DEPCRUISE_PATH);
    expect(keysOf(desired)).not.toContain(STRYKER_PATH);
  });

  it('does not seed an unlisted analyzer the repo never declared', () => {
    const desired = buildDesiredFiles(
      facts({ declaredProviders: new Set(['eslint']) }),
      decisions(),
    );
    expect(keysOf(desired)).not.toContain(DEPCRUISE_PATH);
  });
});

describe('SEED_ONCE_ANALYZERS', () => {
  it('names tools and provider packages the analyzer registry knows', () => {
    // Drift guard: the tool/provider pair is duplicated from verify's ANALYZERS
    // table, and a rename there must not silently disable seeding here.
    for (const analyzer of SEED_ONCE_ANALYZERS) {
      expect(ANALYZER_TOOLS).toContain(analyzer.tool);
      expect(ANALYZER_PROVIDERS).toContain(analyzer.provider);
    }
    expect(SEED_ONCE_ANALYZERS.map((analyzer) => analyzer.path)).toEqual([
      DEPCRUISE_PATH,
      STRYKER_PATH,
      KNIP_PATH,
    ]);
  });

  it('is classified SEED-ONCE by the planner, every entry of it', () => {
    // `plan.ts`'s SEED_ONCE_PATHS is a second, hand-written copy of these
    // paths, and the two drifting apart is silent AND destructive: a seeded
    // config missing from that set classifies as OWNED, where `--force`
    // overwrites the consumer's edited config instead of leaving it alone.
    for (const analyzer of SEED_ONCE_ANALYZERS) {
      expect(
        classifyFile(analyzer.path),
        `${analyzer.path} must be SEED-ONCE in plan.ts`,
      ).toBe('seed-once');
    }
  });

  it('seeds a dependency-cruiser config that excludes nested worktrees', () => {
    // dependency-cruiser does NOT read .gitignore, so the gitignore entry does
    // nothing for it. Measured before this: 671 of 792 cruised modules came
    // from worktree copies. It reports nothing today only because the seed
    // ships a single `no-circular` rule -- the moment an adopter adds the
    // layer rules `adopting-guardrails` step 5 tells them to add, every rule
    // fires once per nested checkout.
    //
    // Written out and `require`d rather than string-matched: the seed is a
    // string here and a .cjs file in a consumer's repo, so a broken escape in
    // the pattern would otherwise ship silently. Loading it the way
    // dependency-cruiser itself does is the faithful check -- and, unlike a
    // `new Function` evaluation, is not code-eval.
    const seed = SEED_ONCE_ANALYZERS.find(
      (analyzer) => analyzer.tool === 'dependency-cruiser',
    );
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-seed-'));
    const seedPath = path.join(directory, '.dependency-cruiser.cjs');
    writeFileSync(seedPath, seed?.seed ?? '');
    const loaded = createRequire(import.meta.url)(seedPath) as {
      options?: { exclude?: { path?: string } };
    };
    rmSync(directory, { recursive: true, force: true });
    const pattern = loaded.options?.exclude?.path ?? '';
    expect(pattern.length).toBeGreaterThan(0);
    expect(new RegExp(pattern).test('.claude/worktrees/wt/src/a.ts')).toBe(
      true,
    );
    // The positive control: the exclude must not have become a catch-all that
    // silences the consumer's own sources too.
    expect(new RegExp(pattern).test('src/a.ts')).toBe(false);
  });
});
