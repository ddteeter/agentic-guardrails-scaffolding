import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyScaffold, type ApplyDeps } from '../../src/scaffold/apply.js';
import type { RepoFacts } from '../../src/scaffold/detect.js';
import {
  checksum,
  MANIFEST_PATH,
  parseManifest,
} from '../../src/scaffold/manifest.js';
import {
  planScaffold,
  type PlannedAction,
  type ScaffoldDecisions,
  type ScaffoldPlan,
} from '../../src/scaffold/plan.js';

const REPO_ROOT = '/repo';
/** The version `applyScaffold` is told to stamp into the manifest -- most
 *  tests here don't care about its value, only that it flows through.
 *  Deliberately distinct from the '1.2.3' some tests seed as a PRE-EXISTING
 *  manifest version, so a test that asserts the manifest ends up holding
 *  VERSION actually proves the new value overwrote the old one. */
const VERSION = '9.9.9';

function fullPath(repoRelativePath: string): string {
  return path.join(REPO_ROOT, repoRelativePath);
}

interface Harness {
  readonly deps: ApplyDeps;
  readonly files: Map<string, string>;
  readonly hooksPathCallCount: () => number;
}

function makeHarness(
  initialFiles: Readonly<Record<string, string>> = {},
): Harness {
  const files = new Map<string, string>(
    Object.entries(initialFiles).map(([relativePath, content]) => [
      fullPath(relativePath),
      content,
    ]),
  );
  let hooksPathCalls = 0;
  const deps: ApplyDeps = {
    readFile: (filePath) => files.get(filePath),
    writeFile: (filePath, content) => {
      files.set(filePath, content);
    },
    setHooksPath: () => {
      hooksPathCalls += 1;
    },
  };
  return { deps, files, hooksPathCallCount: () => hooksPathCalls };
}

function action(
  overrides: Partial<PlannedAction> &
    Pick<PlannedAction, 'path' | 'fileClass' | 'kind'>,
): PlannedAction {
  return { reason: 'test', ...overrides };
}

function planOf(...actions: PlannedAction[]): ScaffoldPlan {
  return { actions, warnings: [] };
}

/** Reads a harness's files map back into a repo-relative `current` record,
 * exactly what a real `detect()` would hand `planScaffold` -- used so a
 * "re-plan" step exercises the real `planScaffold`, not a hand-written
 * belief about what it would return. */
function currentFilesFrom(
  files: ReadonlyMap<string, string>,
): Record<string, string> {
  const current: Record<string, string> = {};
  for (const [absolutePath, content] of files) {
    current[path.relative(REPO_ROOT, absolutePath)] = content;
  }
  return current;
}

const TEST_DECISIONS: ScaffoldDecisions = {
  analyzers: {},
  enforcement: 'warn',
  distribution: 'solo',
  force: false,
};

function factsWithManifest(manifestRaw: string | undefined): RepoFacts {
  const manifest =
    manifestRaw === undefined
      ? undefined
      : parseManifest(JSON.parse(manifestRaw));
  return {
    repoRoot: REPO_ROOT,
    baseBranch: 'main',
    declaredProviders: new Set(),
    hasDependencyCruiserConfig: false,
    hasStrykerConfig: false,
    manifest,
    hooksPath: undefined,
  };
}

describe('applyScaffold', () => {
  it('writes a create action', () => {
    const { deps, files } = makeHarness();
    const plan = planOf(
      action({
        path: 'guardrails.config.json',
        fileClass: 'seed-once',
        kind: 'create',
      }),
    );
    const result = applyScaffold(
      plan,
      { 'guardrails.config.json': '{"enforcement":"warn"}' },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual(['guardrails.config.json']);
    expect(result.skipped).toEqual([]);
    expect(files.get(fullPath('guardrails.config.json'))).toBe(
      '{"enforcement":"warn"}',
    );
  });

  it('writes an update action', () => {
    const { deps, files } = makeHarness({
      '.githooks/pre-commit': 'old content',
    });
    const plan = planOf(
      action({
        path: '.githooks/pre-commit',
        fileClass: 'owned',
        kind: 'update',
      }),
    );
    const result = applyScaffold(
      plan,
      { '.githooks/pre-commit': 'new content' },
      REPO_ROOT,
      deps,
      VERSION,
    );
    // An owned write also refreshes the manifest checksum -- see "the
    // manifest" describe block below for that in isolation.
    expect(result.written).toEqual(['.githooks/pre-commit', MANIFEST_PATH]);
    expect(files.get(fullPath('.githooks/pre-commit'))).toBe('new content');
  });

  it('does not write a drift action', () => {
    const { deps, files } = makeHarness({
      '.githooks/pre-commit': 'consumer-edited content',
    });
    const plan = planOf(
      action({
        path: '.githooks/pre-commit',
        fileClass: 'owned',
        kind: 'drift',
      }),
    );
    const result = applyScaffold(
      plan,
      { '.githooks/pre-commit': 'template content' },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['.githooks/pre-commit']);
    expect(files.get(fullPath('.githooks/pre-commit'))).toBe(
      'consumer-edited content',
    );
  });

  it('does not write an unchanged action', () => {
    const { deps, files } = makeHarness({
      'guardrails.config.json': '{"enforcement":"warn"}',
    });
    const plan = planOf(
      action({
        path: 'guardrails.config.json',
        fileClass: 'seed-once',
        kind: 'unchanged',
      }),
    );
    const result = applyScaffold(
      plan,
      { 'guardrails.config.json': '{"enforcement":"warn"}' },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['guardrails.config.json']);
    expect(files.get(fullPath('guardrails.config.json'))).toBe(
      '{"enforcement":"warn"}',
    );
  });

  it('writes merged content for a merge action', () => {
    const current = JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
    });
    const { deps, files } = makeHarness({ '.claude/settings.json': current });
    const hooksBlock = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node -e "import(\'guardrails-core/cli\')" guardrails gate --mode=stop',
              },
            ],
          },
        ],
      },
    });
    const plan = planOf(
      action({
        path: '.claude/settings.json',
        fileClass: 'shared',
        kind: 'merge',
      }),
    );
    const result = applyScaffold(
      plan,
      { '.claude/settings.json': hooksBlock },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual(['.claude/settings.json']);
    const written = files.get(fullPath('.claude/settings.json'));
    expect(written).toBeDefined();
    const parsed = JSON.parse(written ?? '') as {
      permissions: { allow: string[] };
      hooks: { Stop: unknown[] };
    };
    expect(parsed.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('routes a shared create action (absent file) through the same merger as merge', () => {
    const { deps, files } = makeHarness();
    const hooksBlock = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    const plan = planOf(
      action({
        path: '.claude/settings.json',
        fileClass: 'shared',
        kind: 'create',
      }),
    );
    const result = applyScaffold(
      plan,
      { '.claude/settings.json': hooksBlock },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual(['.claude/settings.json']);
    const parsed = JSON.parse(
      files.get(fullPath('.claude/settings.json')) ?? '',
    ) as { hooks: { Stop: unknown[] } };
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('warns when a shared merge fails to parse, rather than silently reporting it as skipped', () => {
    // This is the sharpest edge the brief called out: `mergeClaudeSettings`
    // returns `current` unchanged on unparseable JSON specifically so a
    // caller can report it. A consumer whose `.claude/settings.json` is
    // malformed must not see it land silently in `skipped` next to every
    // genuinely up-to-date file -- that is exactly how the whole guardrail
    // hook loop fails to install without a trace.
    const current = '{ not valid json';
    const { deps, files } = makeHarness({ '.claude/settings.json': current });
    const plan = planOf(
      action({
        path: '.claude/settings.json',
        fileClass: 'shared',
        kind: 'merge',
      }),
    );
    const result = applyScaffold(
      plan,
      { '.claude/settings.json': JSON.stringify({ hooks: {} }) },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['.claude/settings.json']);
    expect(files.get(fullPath('.claude/settings.json'))).toBe(current);
    expect(result.warnings).toEqual([
      '.claude/settings.json could not be parsed as JSON and was left unchanged',
    ]);
  });

  it('throws rather than silently misrouting an unrecognised shared path', () => {
    // `merge.ts`'s SHARED_MERGERS (via `isSharedPath`) is the source of truth
    // for which paths are shared; this dispatcher is its mirror for how to
    // merge each one. If they ever drift apart, failing loudly beats silently
    // running the wrong merger against the file.
    const { deps } = makeHarness();
    const plan = planOf(
      action({
        path: 'some/future-shared-path.json',
        fileClass: 'shared',
        kind: 'create',
      }),
    );
    expect(() =>
      applyScaffold(
        plan,
        { 'some/future-shared-path.json': '{}' },
        REPO_ROOT,
        deps,
        VERSION,
      ),
    ).toThrow('no SHARED merger registered for some/future-shared-path.json');
  });

  describe('package.json merge routing', () => {
    // `mergePackageJsonScripts`'s own branches (no scripts object, a
    // non-string `prepare`, absent entirely, etc.) are unit-tested directly
    // in merge.test.ts. These confirm only that `applyScaffold` routes
    // `package.json` through it rather than one of the other three mergers.
    it('routes package.json merges through mergePackageJsonScripts', () => {
      const { deps, files } = makeHarness({
        'package.json': JSON.stringify({ scripts: { prepare: 'husky' } }),
      });
      const plan = planOf(
        action({ path: 'package.json', fileClass: 'shared', kind: 'merge' }),
      );
      applyScaffold(plan, { 'package.json': '' }, REPO_ROOT, deps, VERSION);
      const parsed = JSON.parse(files.get(fullPath('package.json')) ?? '') as {
        scripts: { prepare: string };
      };
      expect(parsed.scripts.prepare).toBe('husky && guardrails install-hooks');
    });

    it('warns when package.json fails to parse, not just settings.json', () => {
      const current = '{ not valid json';
      const { deps, files } = makeHarness({ 'package.json': current });
      const plan = planOf(
        action({ path: 'package.json', fileClass: 'shared', kind: 'merge' }),
      );
      const result = applyScaffold(
        plan,
        { 'package.json': '' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      expect(result.skipped).toEqual(['package.json']);
      expect(files.get(fullPath('package.json'))).toBe(current);
      expect(result.warnings).toEqual([
        'package.json could not be parsed as JSON and was left unchanged',
      ]);
    });
  });

  describe('.gitignore and copilot-instructions merge routing', () => {
    it('routes .gitignore merges through mergeGitignore, not the package.json fallback', () => {
      const { deps, files } = makeHarness();
      const plan = planOf(
        action({ path: '.gitignore', fileClass: 'shared', kind: 'create' }),
      );
      applyScaffold(plan, { '.gitignore': '' }, REPO_ROOT, deps, VERSION);
      const written = files.get(fullPath('.gitignore'));
      expect(written).toContain('.guardrails/state/');
    });

    it('routes copilot-instructions merges through mergeCopilotInstructions, not the package.json fallback', () => {
      const { deps, files } = makeHarness();
      const block = [
        '<!-- guardrails:skills:start -->',
        'index content',
        '<!-- guardrails:skills:end -->',
      ].join('\n');
      const plan = planOf(
        action({
          path: '.github/copilot-instructions.md',
          fileClass: 'shared',
          kind: 'create',
        }),
      );
      applyScaffold(
        plan,
        { '.github/copilot-instructions.md': block },
        REPO_ROOT,
        deps,
        VERSION,
      );
      const written = files.get(fullPath('.github/copilot-instructions.md'));
      expect(written).toContain('index content');
    });

    it('never warns for an already up-to-date .gitignore, unlike the JSON-based mergers', () => {
      // There is no such thing as malformed `.gitignore`: re-parsing its
      // content as JSON (to detect the settings.json/package.json failure
      // mode) would spuriously "fail" on every genuinely idempotent run.
      // This guards the design choice that text-splicing mergers never
      // report `parseFailed`.
      const { deps, files } = makeHarness();
      const createPlan = planOf(
        action({ path: '.gitignore', fileClass: 'shared', kind: 'create' }),
      );
      applyScaffold(createPlan, { '.gitignore': '' }, REPO_ROOT, deps, VERSION);

      const mergePlan = planOf(
        action({ path: '.gitignore', fileClass: 'shared', kind: 'merge' }),
      );
      const result = applyScaffold(
        mergePlan,
        { '.gitignore': '' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      expect(result.written).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(files.has(fullPath('.gitignore'))).toBe(true);
    });

    it('never warns for already up-to-date copilot instructions, unlike the JSON-based mergers', () => {
      const block = [
        '<!-- guardrails:skills:start -->',
        'index content',
        '<!-- guardrails:skills:end -->',
      ].join('\n');
      const { deps } = makeHarness();
      const createPlan = planOf(
        action({
          path: '.github/copilot-instructions.md',
          fileClass: 'shared',
          kind: 'create',
        }),
      );
      applyScaffold(
        createPlan,
        { '.github/copilot-instructions.md': block },
        REPO_ROOT,
        deps,
        VERSION,
      );

      const mergePlan = planOf(
        action({
          path: '.github/copilot-instructions.md',
          fileClass: 'shared',
          kind: 'merge',
        }),
      );
      const result = applyScaffold(
        mergePlan,
        { '.github/copilot-instructions.md': block },
        REPO_ROOT,
        deps,
        VERSION,
      );
      expect(result.written).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('the manifest', () => {
    it('records a fresh checksum for every OWNED file actually written', () => {
      const { deps, files } = makeHarness();
      const plan = planOf(
        action({
          path: '.githooks/pre-commit',
          fileClass: 'owned',
          kind: 'create',
        }),
        action({
          path: 'guardrails.config.json',
          fileClass: 'seed-once',
          kind: 'create',
        }),
      );
      const result = applyScaffold(
        plan,
        {
          '.githooks/pre-commit': 'hook script',
          'guardrails.config.json': '{}',
        },
        REPO_ROOT,
        deps,
        VERSION,
      );
      const manifestRaw = files.get(fullPath(MANIFEST_PATH));
      expect(manifestRaw).toBeDefined();
      const manifest = JSON.parse(manifestRaw ?? '') as {
        files: Record<string, string>;
      };
      expect(manifest.files).toEqual({
        '.githooks/pre-commit': checksum('hook script'),
      });
      // Seed-once files are never tracked in the manifest.
      expect(manifest.files['guardrails.config.json']).toBeUndefined();
      // A brand-new repo legitimately has no manifest yet -- that is not
      // itself a problem worth warning about.
      expect(result.warnings).toEqual([]);
    });

    it('preserves existing file entries but overwrites guardrailsVersion with the current one', () => {
      // A version-aware release must not keep stamping whatever was on disk
      // at the FIRST `init --apply` forever -- see apply.ts's `writeManifest`.
      // '1.2.3' here is deliberately not VERSION, so the assertion below
      // proves an overwrite happened rather than passing on a coincidence.
      const existingManifest = JSON.stringify({
        guardrailsVersion: '1.2.3',
        files: { 'existing-owned-file.md': checksum('old content') },
      });
      const { deps, files } = makeHarness({
        [MANIFEST_PATH]: existingManifest,
      });
      const plan = planOf(
        action({
          path: '.githooks/pre-commit',
          fileClass: 'owned',
          kind: 'create',
        }),
      );
      const result = applyScaffold(
        plan,
        { '.githooks/pre-commit': 'hook script' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      const manifest = JSON.parse(files.get(fullPath(MANIFEST_PATH)) ?? '') as {
        guardrailsVersion: string;
        files: Record<string, string>;
      };
      expect(manifest.guardrailsVersion).toBe(VERSION);
      expect(manifest.files['existing-owned-file.md']).toBe(
        checksum('old content'),
      );
      expect(manifest.files['.githooks/pre-commit']).toBe(
        checksum('hook script'),
      );
      // A manifest that reads back successfully is not a corrupted file --
      // no warning should be raised for it.
      expect(result.warnings).toEqual([]);
    });

    it('treats an unparseable existing manifest as absent rather than failing', () => {
      const { deps, files } = makeHarness({
        [MANIFEST_PATH]: '{ not valid json',
      });
      const plan = planOf(
        action({
          path: '.githooks/pre-commit',
          fileClass: 'owned',
          kind: 'create',
        }),
      );
      const result = applyScaffold(
        plan,
        { '.githooks/pre-commit': 'hook script' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      const manifest = JSON.parse(files.get(fullPath(MANIFEST_PATH)) ?? '') as {
        guardrailsVersion: string;
        files: Record<string, string>;
      };
      expect(manifest.guardrailsVersion).toBe(VERSION);
      expect(manifest.files).toEqual({
        '.githooks/pre-commit': checksum('hook script'),
      });
      // Unlike a brand-new repo with no manifest yet, a manifest that exists
      // and fails to parse is a corrupted file worth surfacing.
      expect(result.warnings).toEqual([
        `${MANIFEST_PATH} could not be read; treating it as absent`,
      ]);
    });

    it('is not written at all when no OWNED file was written', () => {
      const { deps, files } = makeHarness();
      const plan = planOf(
        action({ path: '.gitignore', fileClass: 'shared', kind: 'create' }),
      );
      applyScaffold(plan, { '.gitignore': '' }, REPO_ROOT, deps, VERSION);
      expect(files.has(fullPath(MANIFEST_PATH))).toBe(false);
    });
  });

  describe('setHooksPath', () => {
    it('is called when .githooks/pre-commit is written', () => {
      const { deps, hooksPathCallCount } = makeHarness();
      const plan = planOf(
        action({
          path: '.githooks/pre-commit',
          fileClass: 'owned',
          kind: 'create',
        }),
      );
      applyScaffold(
        plan,
        { '.githooks/pre-commit': 'hook' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      expect(hooksPathCallCount()).toBe(1);
    });

    it('is not called when .githooks/pre-commit is not part of the plan', () => {
      const { deps, hooksPathCallCount } = makeHarness();
      const plan = planOf(
        action({
          path: 'guardrails.config.json',
          fileClass: 'seed-once',
          kind: 'create',
        }),
      );
      applyScaffold(
        plan,
        { 'guardrails.config.json': '{}' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      expect(hooksPathCallCount()).toBe(0);
    });

    it('is not called when .githooks/pre-commit has drifted (not written)', () => {
      const { deps, hooksPathCallCount } = makeHarness({
        '.githooks/pre-commit': 'edited',
      });
      const plan = planOf(
        action({
          path: '.githooks/pre-commit',
          fileClass: 'owned',
          kind: 'drift',
        }),
      );
      applyScaffold(
        plan,
        { '.githooks/pre-commit': 'template' },
        REPO_ROOT,
        deps,
        VERSION,
      );
      expect(hooksPathCallCount()).toBe(0);
    });
  });

  it('skips with a warning when the plan references a path missing from desired', () => {
    const { deps, files } = makeHarness();
    const plan = planOf(
      action({ path: 'ghost.md', fileClass: 'owned', kind: 'create' }),
    );
    const result = applyScaffold(plan, {}, REPO_ROOT, deps, VERSION);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['ghost.md']);
    expect(result.warnings).toHaveLength(1);
    expect(files.has(fullPath('ghost.md'))).toBe(false);
  });

  it('writes nothing for a plan with no actionable entries', () => {
    const { deps, files } = makeHarness({
      'guardrails.config.json': '{}',
      '.githooks/pre-commit': 'edited by consumer',
    });
    const plan = planOf(
      action({
        path: 'guardrails.config.json',
        fileClass: 'seed-once',
        kind: 'unchanged',
      }),
      action({
        path: '.githooks/pre-commit',
        fileClass: 'owned',
        kind: 'drift',
      }),
    );
    const result = applyScaffold(
      plan,
      { 'guardrails.config.json': '{}', '.githooks/pre-commit': 'template' },
      REPO_ROOT,
      deps,
      VERSION,
    );
    expect(result.written).toEqual([]);
    expect(files.has(fullPath(MANIFEST_PATH))).toBe(false);
  });

  it('is idempotent: applying, re-planning and re-applying writes nothing', () => {
    // Re-running init on an untouched repo must be a no-op. This is the
    // property the phase name calls out -- both halves of it. The
    // "re-planning" half is exercised through the real `planScaffold`, not a
    // hand-written belief about what it would return: a hand-written second
    // plan would keep passing even if `plan.ts`'s decision table changed
    // underneath it, which is exactly the regression this test exists to
    // catch.
    const hooksBlock = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node -e "import(\'guardrails-core/cli\')" guardrails gate --mode=stop',
              },
            ],
          },
        ],
      },
    });
    const desired = {
      '.githooks/pre-commit': 'hook script',
      'guardrails.config.json': '{}',
      '.claude/settings.json': hooksBlock,
      '.gitignore': '',
      'package.json': '',
      '.github/copilot-instructions.md':
        '<!-- guardrails:skills:start -->\n<!-- guardrails:skills:end -->',
    };

    const { deps, files } = makeHarness({ 'package.json': '{}' });

    const firstPlan = planScaffold({
      facts: factsWithManifest(undefined),
      decisions: TEST_DECISIONS,
      desired,
      current: currentFilesFrom(files),
    });
    applyScaffold(firstPlan, desired, REPO_ROOT, deps, VERSION);

    // Re-plan for real, against what the first apply actually left behind --
    // including the manifest it just wrote.
    const secondPlan = planScaffold({
      facts: factsWithManifest(files.get(fullPath(MANIFEST_PATH))),
      decisions: TEST_DECISIONS,
      desired,
      current: currentFilesFrom(files),
    });
    // Every owned/seed-once action must have settled to `unchanged` and every
    // shared action to `merge` -- if planScaffold ever produced `drift` or
    // `create` here, this run would no longer be exercising the idempotent
    // path, and the assertions below would need to fail loudly, not pass
    // vacuously on an empty or wrong plan.
    const sortedKinds = secondPlan.actions
      .map((planned) => planned.kind)
      .sort((a, b) => a.localeCompare(b));
    expect(sortedKinds).toEqual(
      ['merge', 'merge', 'merge', 'merge', 'unchanged', 'unchanged'].sort(
        (a, b) => a.localeCompare(b),
      ),
    );

    const filesBefore = new Map(files);
    const result = applyScaffold(secondPlan, desired, REPO_ROOT, deps, VERSION);

    expect(result.written).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(files).toEqual(filesBefore);
  });
});
