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
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RepoFacts } from '../../src/scaffold/detect.js';
import type { ScaffoldDecisions } from '../../src/scaffold/plan.js';
import {
  buildDesiredFiles,
  canonicalKey,
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
    hasTypeScriptConfig: false,
    hasEslintConfig: false,
    hasDependencyCruiserConfig: false,
    hasStrykerConfig: false,
    hasGuardrailsConfig: false,
    manifest: undefined,
    hooksPath: undefined,
    prepareScript: undefined,
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
    '.github/agents/guardrail-fixer.agent.md',
    '.github/agents/guardrail-fixer-thorough.agent.md',
    '.github/hooks/guardrails.json',
    '.githooks/pre-commit',
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

  it('installs every packaged guidance doc under docs/guardrails', () => {
    // Spec §6.7: run-time guidance is COPIED IN, because the Copilot cloud
    // agent reads the default branch, where node_modules does not exist.
    const desired = buildDesiredFiles(facts(), decisions());
    const documents = readdirSync(guidanceRoot()).filter((name) =>
      name.endsWith('.md'),
    );
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      expect(contentOf(desired, `docs/guardrails/${document}`)).toBe(
        readFileSync(path.join(guidanceRoot(), document), 'utf8'),
      );
    }
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
    ]);
  });
});
