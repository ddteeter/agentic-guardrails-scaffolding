import { describe, expect, it } from 'vitest';

import {
  isSharedPath,
  mergeAgentsInstructions,
  mergeClaudeSettings,
  mergeCopilotInstructions,
  mergeGitignore,
  mergePackageJsonScripts,
  mergePrepareScript,
  parseConsumerJson,
  SHARED_MERGERS,
} from '../../src/scaffold/merge.js';

const HOOKS_BLOCK = JSON.stringify({
  hooks: {
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          {
            type: 'command',
            command:
              'node -e "import(\'guardrails-core/cli\')" guardrails autofix',
            timeout: 120,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command:
              'node -e "import(\'guardrails-core/cli\')" guardrails gate --mode=stop',
            timeout: 300,
          },
        ],
      },
    ],
  },
});

describe('parseConsumerJson', () => {
  it('parses valid JSON', () => {
    expect(parseConsumerJson('{"a":1}')).toEqual({ parsed: { a: 1 } });
  });

  it('returns parsed: undefined for malformed JSON, distinct from a bare undefined', () => {
    const result = parseConsumerJson('{ not json');
    // The wrapper itself must exist even on failure -- this is what makes the
    // catch block's mutant observable: emptying it to `{}` would fail
    // `toHaveProperty`, where a bare `undefined` return could not be told
    // apart from `{ parsed: undefined }` by any caller that only reads
    // `.parsed`.
    expect(result).toHaveProperty('parsed');
    expect(result.parsed).toBeUndefined();
    expect(result).toEqual({ parsed: undefined });
  });
});

describe('mergeClaudeSettings', () => {
  it('creates a settings file when the consumer has none', () => {
    const result = mergeClaudeSettings(undefined, HOOKS_BLOCK);
    const parsed = JSON.parse(result) as {
      hooks: { PostToolUse: unknown[]; Stop: unknown[] };
    };
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('preserves a consumer hook that is not ours', () => {
    // The load-bearing case: a consumer with their own PostToolUse hook must
    // still have it afterwards.
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo their-own-hook' }],
          },
        ],
      },
    });
    const result = mergeClaudeSettings(current, HOOKS_BLOCK);
    const parsed = JSON.parse(result) as {
      hooks: { PostToolUse: { matcher?: string }[] };
    };
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(
      parsed.hooks.PostToolUse.some((entry) => entry.matcher === 'Bash'),
    ).toBe(true);
    expect(
      parsed.hooks.PostToolUse.some((entry) => entry.matcher === 'Edit|Write'),
    ).toBe(true);
  });

  it('replaces a stale guardrails hook rather than duplicating it', () => {
    // Guardrails entries are identified by their command containing any of the
    // known markers (current form, legacy forms across upgrades). Re-running init
    // must not append a second copy of every hook.
    const alreadyMerged = mergeClaudeSettings(undefined, HOOKS_BLOCK);
    const result = mergeClaudeSettings(alreadyMerged, HOOKS_BLOCK);
    const parsed = JSON.parse(result) as {
      hooks: { PostToolUse: unknown[]; Stop: unknown[] };
    };
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('preserves unrelated top-level settings keys', () => {
    // e.g. `permissions`, `model` -- their file, not ours.
    const current = JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      model: 'opus',
    });
    const result = mergeClaudeSettings(current, HOOKS_BLOCK);
    const parsed = JSON.parse(result) as {
      permissions: { allow: string[] };
      model: string;
      hooks: { PostToolUse: unknown[] };
    };
    expect(parsed.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
  });

  it('replaces an old-form guardrails entry rather than duplicating it on upgrade', () => {
    // An adopter who ran `init` under the old command form has entries with
    // `guardrails-core/dist/cli.mjs`. After upgrade, they re-run init. The new
    // command form and old both present means: either idempotency broke (we kept
    // the old as "foreign" and appended new), or we correctly recognised it as
    // ours and replaced it. This test covers the case the production code must
    // handle: old-form entry in current, new-form entry in template, one survivor.
    const currentWithOldForm = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node "${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs" gate --mode=stop',
              },
            ],
          },
        ],
      },
    });
    const result = mergeClaudeSettings(currentWithOldForm, HOOKS_BLOCK);
    const parsed = JSON.parse(result) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    // Must have exactly one Stop entry (the old was replaced, not kept beside new)
    expect(parsed.hooks.Stop).toHaveLength(1);
    // That entry must be the new form
    expect(parsed.hooks.Stop[0]?.hooks[0]?.command).toContain(
      'import(\'guardrails-core/cli\')',
    );
  });

  it('is idempotent: merging twice equals merging once', () => {
    const once = mergeClaudeSettings(undefined, HOOKS_BLOCK);
    const twice = mergeClaudeSettings(once, HOOKS_BLOCK);
    expect(twice).toBe(once);
  });

  it('preserves a consumer hook event the template does not define', () => {
    const current = JSON.stringify({
      hooks: {
        PreCompact: [
          { hooks: [{ type: 'command', command: 'echo their-own-event' }] },
        ],
      },
    });
    const result = mergeClaudeSettings(current, HOOKS_BLOCK);
    const parsed = JSON.parse(result) as {
      hooks: { PreCompact: unknown[]; PostToolUse: unknown[] };
    };
    expect(parsed.hooks.PreCompact).toEqual([
      { hooks: [{ type: 'command', command: 'echo their-own-event' }] },
    ]);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
  });

  it('leaves the consumer file untouched when it is not valid JSON', () => {
    // Failing closed: better to report than to destroy a file we cannot parse.
    const current = '{ this is not json';
    expect(mergeClaudeSettings(current, HOOKS_BLOCK)).toBe(current);
  });
});

describe('mergeAgentsInstructions', () => {
  const block = [
    '<!-- guardrails:instructions:start -->',
    'new guardrails index',
    '<!-- guardrails:instructions:end -->',
  ].join('\n');

  it('preserves consumer prose while replacing the guardrails block', () => {
    const current = [
      '# Project instructions',
      '',
      '<!-- guardrails:instructions:start -->',
      'old index',
      '<!-- guardrails:instructions:end -->',
      '',
      'Consumer tail.',
    ].join('\n');
    const merged = mergeAgentsInstructions(current, block);
    expect(merged).toContain('# Project instructions');
    expect(merged).toContain('new guardrails index');
    expect(merged).toContain('Consumer tail.');
    expect(merged).not.toContain('old index');
  });
});

describe('mergeGitignore', () => {
  // Spec §6.4 names three entries: `.guardrails/state/` (the gitignored
  // session state) plus `reports/mutation/` and `.stryker-tmp/` -- both
  // generated by guardrails' own `verify` running stryker inside the
  // consumer's repo, so without them a consumer's first mutation run leaves
  // untracked noise they never asked for.
  //
  // `.guardrails/state/*` (a wildcard on the directory's CONTENTS), not
  // `.guardrails/state/` (the directory itself): git never re-includes a
  // path whose PARENT directory is excluded, so a bare `.guardrails/state/`
  // would make the `!recurrence.json` negation below a no-op. Wildcarding the
  // contents instead keeps the directory itself un-excluded, so git still
  // walks into it and the negation applies -- see
  // `gitignore-recurrence.test.ts` for the real-`git` proof. This is the
  // Task-8 fix (plan.md "Solo -> team"): recurrence.json is the one file in
  // `.guardrails/state/` a team commits, and a blanket directory-ignore made
  // that impossible without `git add -f` on every change.
  const EXPECTED_BLOCK = [
    '# --- guardrails:start ---',
    '.guardrails/state/*',
    '!.guardrails/state/recurrence.json',
    'reports/mutation/',
    '.stryker-tmp/',
    '# --- guardrails:end ---',
  ].join('\n');

  it('adds a marker-delimited block when absent', () => {
    expect(mergeGitignore(undefined)).toBe(`${EXPECTED_BLOCK}\n`);
  });

  it('adds a clean block when the file exists but is blank', () => {
    // Distinguishes "no content" from "there is content": a whitespace-only
    // file must not grow stray leading blank lines the way real content would.
    expect(mergeGitignore('   \n  ')).toBe(`${EXPECTED_BLOCK}\n`);
  });

  it('appends the block to an existing gitignore that has no markers yet', () => {
    const current = 'node_modules/\n';
    expect(mergeGitignore(current)).toBe(
      `node_modules/\n\n${EXPECTED_BLOCK}\n`,
    );
  });

  it('falls back to appending when the closing marker is missing (a partially edited file)', () => {
    const current = '# --- guardrails:start ---\nstale-content\n';
    expect(mergeGitignore(current)).toBe(
      `${current.trimEnd()}\n\n${EXPECTED_BLOCK}\n`,
    );
  });

  it('falls back to appending when the opening marker is missing (a partially edited file)', () => {
    const current = 'stale-content\n# --- guardrails:end ---\n';
    expect(mergeGitignore(current)).toBe(
      `${current.trimEnd()}\n\n${EXPECTED_BLOCK}\n`,
    );
  });

  it('replaces only the marked block on a re-run', () => {
    const staleBlock = [
      '# --- guardrails:start ---',
      '.guardrails/old-stale-path/',
      '# --- guardrails:end ---',
    ].join('\n');
    const current = `node_modules/\n${staleBlock}\ndist/\n`;
    expect(mergeGitignore(current)).toBe(
      `node_modules/\n${EXPECTED_BLOCK}\ndist/\n`,
    );
  });

  it('preserves consumer entries outside the markers', () => {
    const current = `before-entry/\n\n${EXPECTED_BLOCK}\n\nafter-entry/\n`;
    expect(mergeGitignore(current)).toBe(current);
  });

  it('does NOT ignore .claude/agents or .claude/skills', () => {
    // This repo ignores those because it REGENERATES them every build. A
    // consumer has no build step and must commit them, or the Copilot cloud
    // agent and every teammate get no fixer agents.
    const result = mergeGitignore(undefined);
    expect(result).not.toContain('.claude/agents');
    expect(result).not.toContain('.claude/skills');
    expect(result).toContain('.guardrails/state/');
    expect(result).toContain('reports/mutation/');
    expect(result).toContain('.stryker-tmp/');
  });

  it('is idempotent', () => {
    const once = mergeGitignore(undefined);
    const twice = mergeGitignore(once);
    expect(twice).toBe(once);
  });
});

describe('mergePrepareScript', () => {
  it('creates the script when there is none', () => {
    expect(mergePrepareScript(undefined)).toBe('guardrails install-hooks');
  });
  it('appends to an existing script rather than replacing it', () => {
    // A consumer running husky must not lose it.
    expect(mergePrepareScript('husky')).toBe(
      'husky && guardrails install-hooks',
    );
  });
  it('is idempotent: an already-wired script is returned unchanged', () => {
    expect(mergePrepareScript('husky && guardrails install-hooks')).toBe(
      'husky && guardrails install-hooks',
    );
  });
});

describe('mergeCopilotInstructions', () => {
  const BLOCK = [
    '<!-- guardrails:skills:start -->',
    '',
    '## Guardrails reference docs',
    '',
    '- [`example`](../docs/guardrails/example.md) -- an example skill',
    '',
    '<!-- guardrails:skills:end -->',
  ].join('\n');

  it('creates the file with the marked block when absent', () => {
    const result = mergeCopilotInstructions(undefined, BLOCK);
    expect(result).toContain('<!-- guardrails:skills:start -->');
    expect(result).toContain('<!-- guardrails:skills:end -->');
    expect(result).toContain('example skill');
  });

  it('appends the block to an existing file that has no markers yet', () => {
    const current = '# Copilot instructions\n\nHand-written prose.\n';
    const result = mergeCopilotInstructions(current, BLOCK);
    expect(result).toContain('Hand-written prose.');
    expect(result).toContain('example skill');
  });

  it('replaces only the marked block, preserving hand-written prose', () => {
    const current = [
      '# Copilot instructions',
      '',
      'Prose before.',
      '',
      '<!-- guardrails:skills:start -->',
      '',
      '## Guardrails reference docs',
      '',
      '- [`stale`](../docs/guardrails/stale.md) -- a stale skill',
      '',
      '<!-- guardrails:skills:end -->',
      '',
      'Prose after.',
      '',
    ].join('\n');
    const result = mergeCopilotInstructions(current, BLOCK);
    expect(result).toContain('Prose before.');
    expect(result).toContain('Prose after.');
    expect(result).toContain('example skill');
    expect(result).not.toContain('stale skill');
  });

  it('is idempotent', () => {
    const once = mergeCopilotInstructions(undefined, BLOCK);
    const twice = mergeCopilotInstructions(once, BLOCK);
    expect(twice).toBe(once);
  });
});

describe('mergePackageJsonScripts', () => {
  it('creates a prepare script when package.json itself is missing entirely', () => {
    const result = mergePackageJsonScripts(undefined);
    const parsed = JSON.parse(result) as { scripts: { prepare: string } };
    expect(parsed.scripts.prepare).toBe('guardrails install-hooks');
  });

  it('handles a package.json that has no scripts object at all', () => {
    const result = mergePackageJsonScripts(JSON.stringify({ name: 'bare' }));
    const parsed = JSON.parse(result) as {
      name: string;
      scripts: { prepare: string };
    };
    expect(parsed.name).toBe('bare');
    expect(parsed.scripts.prepare).toBe('guardrails install-hooks');
  });

  it('appends to an existing prepare script rather than replacing it', () => {
    const result = mergePackageJsonScripts(
      JSON.stringify({ scripts: { prepare: 'husky' } }),
    );
    const parsed = JSON.parse(result) as { scripts: { prepare: string } };
    expect(parsed.scripts.prepare).toBe('husky && guardrails install-hooks');
  });

  it('falls back to guardrails install-hooks when an existing prepare field is not a string', () => {
    const result = mergePackageJsonScripts(
      JSON.stringify({ scripts: { prepare: 123 } }),
    );
    const parsed = JSON.parse(result) as { scripts: { prepare: string } };
    expect(parsed.scripts.prepare).toBe('guardrails install-hooks');
  });

  it('leaves an unparseable package.json unchanged', () => {
    const current = '{ not valid json';
    expect(mergePackageJsonScripts(current)).toBe(current);
  });

  it('is idempotent', () => {
    const once = mergePackageJsonScripts(undefined);
    const twice = mergePackageJsonScripts(once);
    expect(twice).toBe(once);
  });

  it('returns a foreign-formatted file byte-identical when it already has our entry', () => {
    // The bug this pins: `mergePackageJsonScripts` used to ALWAYS
    // re-serialise via `JSON.stringify(merged, undefined, 2)`, so a consumer
    // whose own formatter disagrees (4-space here) would be reformatted by
    // `init --apply`, reformatted back by their own formatter, and rewritten
    // again by the next `init --apply` -- forever, each run reporting
    // `wrote: package.json` even though nothing guardrails cares about
    // actually changed. The above "is idempotent" test cannot catch this: it
    // feeds THIS function's own 2-space output back into itself, so the
    // formats already match on the second call regardless of the bug.
    const current = `${JSON.stringify(
      { name: 'consumer', scripts: { prepare: 'guardrails install-hooks' } },
      undefined,
      4,
    )}\n`;
    expect(mergePackageJsonScripts(current)).toBe(current);
  });
});

describe('SHARED_MERGERS', () => {
  // This table (and `isSharedPath`, its companion) is the operational
  // definition of "shared": `plan.ts` classifies a path as shared by asking
  // `isSharedPath`, and `apply.ts` looks up its merger here by the same key.
  // These tests pin the `parseFailed` signal specifically, since that is
  // what lets `apply.ts` tell "already up to date" apart from "could not be
  // parsed" without re-parsing text that was never JSON in the first place.
  it('reports parseFailed for .claude/settings.json when current is not valid JSON', () => {
    const current = '{ not valid json';
    const result = SHARED_MERGERS['.claude/settings.json'](
      current,
      HOOKS_BLOCK,
    );
    expect(result.content).toBe(current);
    expect(result.parseFailed).toBe(true);
  });

  it('does not report parseFailed for .claude/settings.json when it is genuinely already up to date', () => {
    const once = SHARED_MERGERS['.claude/settings.json'](
      undefined,
      HOOKS_BLOCK,
    );
    const twice = SHARED_MERGERS['.claude/settings.json'](
      once.content,
      HOOKS_BLOCK,
    );
    expect(twice.content).toBe(once.content);
    expect(twice.parseFailed).toBe(false);
  });

  it('does not report parseFailed for .claude/settings.json on a fresh create (no current file at all)', () => {
    // Nothing failed to parse here -- there was nothing to parse. Absent and
    // malformed must not be conflated into the same warning.
    const result = SHARED_MERGERS['.claude/settings.json'](
      undefined,
      HOOKS_BLOCK,
    );
    expect(result.parseFailed).toBe(false);
  });

  it('reports parseFailed for package.json when current is not valid JSON', () => {
    const current = '{ not valid json';
    const result = SHARED_MERGERS['package.json'](current, '');
    expect(result.content).toBe(current);
    expect(result.parseFailed).toBe(true);
  });

  it('never reports parseFailed for .gitignore, which cannot be malformed the same way', () => {
    // There is no such thing as malformed `.gitignore`; re-parsing its
    // content as JSON to detect a failure would spuriously "fail" on every
    // genuinely up-to-date run.
    const once = SHARED_MERGERS['.gitignore'](undefined, '');
    const twice = SHARED_MERGERS['.gitignore'](once.content, '');
    expect(twice.content).toBe(once.content);
    expect(twice.parseFailed).toBe(false);
  });

  it('never reports parseFailed for copilot instructions, which cannot be malformed the same way', () => {
    const block = [
      '<!-- guardrails:skills:start -->',
      'index content',
      '<!-- guardrails:skills:end -->',
    ].join('\n');
    const once = SHARED_MERGERS['.github/copilot-instructions.md'](
      undefined,
      block,
    );
    const twice = SHARED_MERGERS['.github/copilot-instructions.md'](
      once.content,
      block,
    );
    expect(twice.content).toBe(once.content);
    expect(twice.parseFailed).toBe(false);
  });
});

describe('isSharedPath', () => {
  it('is true for every path SHARED_MERGERS registers', () => {
    for (const path of Object.keys(SHARED_MERGERS)) {
      expect(isSharedPath(path)).toBe(true);
    }
  });

  it('is false for a path with no registered merger', () => {
    expect(isSharedPath('some/owned-file.md')).toBe(false);
  });
});
