import { describe, expect, it } from 'vitest';

import type { RepoFacts } from '../../src/scaffold/detect.js';
import {
  checksum,
  type ScaffoldManifest,
} from '../../src/scaffold/manifest.js';
import {
  planScaffold,
  type ActionKind,
  type FileClass,
  type PlannedAction,
  type PlanInput,
  type ScaffoldDecisions,
} from '../../src/scaffold/plan.js';

const DEFAULT_DECISIONS: ScaffoldDecisions = {
  analyzers: {},
  enforcement: 'warn',
  distribution: 'solo',
  force: false,
};

function facts(manifest?: ScaffoldManifest): RepoFacts {
  return {
    repoRoot: '/repo',
    baseBranch: 'main',
    declaredProviders: new Set(),
    hasTypeScriptConfig: false,
    hasEslintConfig: false,
    hasDependencyCruiserConfig: false,
    hasStrykerConfig: false,
    hasGuardrailsConfig: false,
    manifest,
    hooksPath: undefined,
    prepareScript: undefined,
  };
}

interface OneFileOptions {
  readonly desired?: string;
  readonly current?: string;
  readonly manifest?: ScaffoldManifest;
  readonly force?: boolean;
}

/**
 * Builds a `PlanInput` with exactly one file and returns the single resulting
 * action, so each decision-table row reads as one row instead of twenty lines
 * of setup.
 */
function planOneFile(path: string, options: OneFileOptions): PlannedAction {
  const input: PlanInput = {
    facts: facts(options.manifest),
    decisions: { ...DEFAULT_DECISIONS, force: options.force ?? false },
    desired: { [path]: options.desired ?? 'desired content' },
    current: options.current === undefined ? {} : { [path]: options.current },
  };
  const plan = planScaffold(input);
  const [action] = plan.actions;
  if (action === undefined) {
    throw new Error(`expected planScaffold to produce an action for ${path}`);
  }
  return action;
}

// Representative paths for each class, taken straight from spec §6.4 so the
// classification the implementation relies on is exercised by real examples.
const OWNED_PATH = '.githooks/pre-commit';
const SHARED_PATH = '.claude/settings.json';
const SEED_ONCE_PATH = 'guardrails.config.json';

// Every `ActionKind`/`FileClass` value, typed against the exported unions so
// a typo (or a renamed member) fails to compile rather than silently
// asserting the wrong thing.
const CREATE: ActionKind = 'create';
const UPDATE: ActionKind = 'update';
const DRIFT: ActionKind = 'drift';
const MERGE: ActionKind = 'merge';
const UNCHANGED: ActionKind = 'unchanged';
const OWNED: FileClass = 'owned';
const SHARED: FileClass = 'shared';
const SEED_ONCE: FileClass = 'seed-once';

describe('planScaffold — the decision table', () => {
  it('owned, absent -> create', () => {
    const action = planOneFile(OWNED_PATH, {});
    expect(action.kind).toBe(CREATE);
    expect(action.fileClass).toBe(OWNED);
  });

  it('owned, present, matches manifest checksum, no force -> update', () => {
    const current = 'content guardrails wrote last time';
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: { [OWNED_PATH]: checksum(current) },
    };
    const action = planOneFile(OWNED_PATH, {
      desired: 'a newer template',
      current,
      manifest,
    });
    expect(action.kind).toBe(UPDATE);
  });

  it('owned, present, edited (does not match manifest checksum), no force -> drift', () => {
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: { [OWNED_PATH]: checksum('what guardrails originally wrote') },
    };
    const action = planOneFile(OWNED_PATH, {
      desired: 'a newer template',
      current: 'the consumer edited this',
      manifest,
    });
    expect(action.kind).toBe(DRIFT);
  });

  it('owned, present, edited (does not match manifest checksum), force -> update', () => {
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: { [OWNED_PATH]: checksum('what guardrails originally wrote') },
    };
    const action = planOneFile(OWNED_PATH, {
      desired: 'a newer template',
      current: 'the consumer edited this',
      manifest,
      force: true,
    });
    expect(action.kind).toBe(UPDATE);
  });

  it('owned, present, not in manifest, no force -> drift', () => {
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: {},
    };
    const action = planOneFile(OWNED_PATH, {
      desired: 'a newer template',
      current: 'a file guardrails never recorded',
      manifest,
    });
    expect(action.kind).toBe(DRIFT);
  });

  it('owned, present, no manifest at all, no force -> drift', () => {
    // An unscaffolded repo (no `.guardrails/scaffold.json`) must read the same
    // as "not in manifest" -- both mean guardrails cannot prove it wrote this
    // file, so editing it must be reported, never silently overwritten.
    const action = planOneFile(OWNED_PATH, {
      desired: 'a newer template',
      current: 'a file guardrails never recorded',
    });
    expect(action.kind).toBe(DRIFT);
  });

  it('owned, present, identical to desired -> unchanged', () => {
    const identical = 'exactly what init would write';
    const action = planOneFile(OWNED_PATH, {
      desired: identical,
      current: identical,
    });
    expect(action.kind).toBe(UNCHANGED);
  });

  it('shared, absent -> create', () => {
    const action = planOneFile(SHARED_PATH, {});
    expect(action.kind).toBe(CREATE);
    expect(action.fileClass).toBe(SHARED);
  });

  it('shared, present -> merge', () => {
    const action = planOneFile(SHARED_PATH, {
      current: '{"permissions": {"allow": ["Bash(npm test)"]}}',
    });
    expect(action.kind).toBe(MERGE);
    // `decideShared`'s re-serialisation warning is a `package.json`-specific
    // special case (see `sharedMergeReason`) -- pinning that another SHARED
    // path gets the generic reason is what proves the special case is
    // actually keyed on the path, not merely always true.
    expect(action.reason).not.toContain('re-serial');
  });

  it("package.json's merge reason mentions re-serialisation, not just the merged entries", () => {
    // `mergePackageJsonScripts` always re-serialises the whole file
    // (JSON.stringify), unlike the text-splicing SHARED mergers -- a
    // consumer whose own formatter disagrees (4-space, tabs) needs to know
    // THAT is what a re-run touches, not just that guardrails' entries were
    // merged in.
    const action = planOneFile('package.json', {
      current: '{"name":"consumer"}',
    });
    expect(action.kind).toBe(MERGE);
    expect(action.reason).toContain('re-serial');
  });

  it('shared, present, edited beyond recognition, force -> still merge, never drift', () => {
    // The consumer is expected to own SHARED files; merging only ever touches
    // guardrails' own entries, so there is no "drift" state to report, and
    // --force changes nothing here.
    const action = planOneFile(SHARED_PATH, {
      current: 'a file that looks nothing like anything guardrails wrote',
      force: true,
    });
    expect(action.kind).toBe(MERGE);
  });

  it('seed-once, absent -> create', () => {
    const action = planOneFile(SEED_ONCE_PATH, {});
    expect(action.kind).toBe(CREATE);
    expect(action.fileClass).toBe(SEED_ONCE);
  });

  it('seed-once, present -> unchanged', () => {
    const action = planOneFile(SEED_ONCE_PATH, {
      desired: 'guardrails default policy',
      current: 'the consumer heavily customized this',
    });
    expect(action.kind).toBe(UNCHANGED);
  });

  it('seed-once, present, force -> STILL unchanged, never overwritten', () => {
    // Load-bearing: guardrails.config.json holds the consumer's policy and
    // sanctioned suppressions. Losing it to a --force run would be the worst
    // thing this command could do.
    const action = planOneFile(SEED_ONCE_PATH, {
      desired: 'guardrails default policy',
      current: 'the consumer heavily customized this',
      force: true,
    });
    expect(action.kind).toBe(UNCHANGED);
  });
});

describe('planScaffold — cross-cutting properties', () => {
  it('reports drift as a warning, not silently', () => {
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: { [OWNED_PATH]: checksum('original scaffolded content') },
    };
    const input: PlanInput = {
      facts: facts(manifest),
      decisions: DEFAULT_DECISIONS,
      desired: { [OWNED_PATH]: 'a newer template' },
      current: { [OWNED_PATH]: 'the consumer edited this' },
    };
    const plan = planScaffold(input);
    expect(plan.warnings.join(' ')).toContain(OWNED_PATH);
  });

  it('produces no warnings when nothing has drifted', () => {
    const input: PlanInput = {
      facts: facts(),
      decisions: DEFAULT_DECISIONS,
      desired: {
        [OWNED_PATH]: 'a newer template',
        [SHARED_PATH]: '{}',
        [SEED_ONCE_PATH]: '{}',
      },
      current: {},
    };
    const plan = planScaffold(input);
    expect(plan.warnings).toEqual([]);
  });

  it('every action carries a reason a human can act on', () => {
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: { [OWNED_PATH]: checksum('original scaffolded content') },
    };
    const input: PlanInput = {
      facts: facts(manifest),
      decisions: DEFAULT_DECISIONS,
      desired: {
        [OWNED_PATH]: 'a newer template',
        [SHARED_PATH]: '{}',
        [SEED_ONCE_PATH]: '{}',
        '.github/workflows/guardrails.yml': 'workflow yaml',
      },
      current: {
        [OWNED_PATH]: 'the consumer edited this',
        [SHARED_PATH]: '{"model": "custom"}',
        [SEED_ONCE_PATH]: 'consumer policy',
      },
    };
    const plan = planScaffold(input);
    expect(plan.actions.length).toBeGreaterThan(0);
    for (const action of plan.actions) {
      expect(action.reason.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same input yields the same plan', () => {
    const manifest: ScaffoldManifest = {
      guardrailsVersion: '0.1.0',
      files: { [OWNED_PATH]: checksum('original scaffolded content') },
    };
    const input: PlanInput = {
      facts: facts(manifest),
      decisions: DEFAULT_DECISIONS,
      desired: {
        [OWNED_PATH]: 'a newer template',
        [SHARED_PATH]: '{}',
        [SEED_ONCE_PATH]: '{}',
      },
      current: {
        [OWNED_PATH]: 'the consumer edited this',
        [SHARED_PATH]: '{"model": "custom"}',
      },
    };
    expect(planScaffold(input)).toEqual(planScaffold(input));
  });

  it('orders actions by path so --plan output is stable', () => {
    const input: PlanInput = {
      facts: facts(),
      decisions: DEFAULT_DECISIONS,
      desired: {
        '.github/workflows/guardrails.yml': 'workflow yaml',
        [SEED_ONCE_PATH]: '{}',
        [OWNED_PATH]: 'a newer template',
        [SHARED_PATH]: '{}',
        '.claude/agents/guardrail-fixer.md': 'agent doc',
      },
      current: {},
    };
    const plan = planScaffold(input);
    const paths = plan.actions.map((action) => action.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(paths).toHaveLength(5);
  });
});

/**
 * `core.hooksPath` is the one piece of guardrails' wiring that lives in git
 * config rather than in a file, and a consumer who already has one (husky
 * sets `.husky/_`) would lose every hook they own if `--apply` repointed it.
 * The plan is where that is announced, so `--plan` says it before `--apply`
 * does it -- and `printApply` re-emits `plan.warnings`, so one warning here
 * covers both runs.
 */
function planWithHooksPath(hooksPath: string | undefined): readonly string[] {
  return planScaffold({
    facts: { ...facts(), hooksPath },
    decisions: DEFAULT_DECISIONS,
    desired: { [OWNED_PATH]: 'hook script' },
    current: {},
  }).warnings;
}

describe('plan — an existing foreign core.hooksPath', () => {
  const FOREIGN = '.husky/_';

  it('warns, naming the value found and the hook left uninstalled', () => {
    const warnings = planWithHooksPath(FOREIGN).join('\n');
    expect(warnings).toContain(FOREIGN);
    expect(warnings).toContain('.githooks/pre-commit');
    expect(warnings).toContain('gate --mode=commit');
  });

  it('says nothing when git has no core.hooksPath at all', () => {
    expect(planWithHooksPath(undefined)).toEqual([]);
  });

  it('says nothing when core.hooksPath already points at .githooks', () => {
    expect(planWithHooksPath('.githooks')).toEqual([]);
  });
});
