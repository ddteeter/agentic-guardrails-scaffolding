import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface HookCommand {
  readonly command: string;
  readonly timeout?: number;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

const config = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../.codex/hooks.json'),
    'utf8',
  ),
) as { hooks: Record<string, readonly HookGroup[]> };

function groups(event: string): readonly HookGroup[] {
  return config.hooks[event] ?? [];
}

function commands(event: string): HookCommand[] {
  return groups(event).flatMap((group) => [...group.hooks]);
}

describe('Codex hooks config', () => {
  it('wires the complete session/edit/stop lifecycle', () => {
    expect(
      Object.keys(config.hooks).sort((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
    expect(commands('PostToolUse')[0]?.command).toContain('autofix');
    expect(commands('Stop')[0]?.command).toContain(
      'gate --mode=stop --dialect=codex',
    );
  });

  it('resolves the installed CLI from the Git top-level', () => {
    for (const event of Object.keys(config.hooks)) {
      for (const hook of commands(event)) {
        expect(hook.command).toContain('$(git rev-parse --show-toplevel)');
        expect(hook.command).toContain(
          'node_modules/guardrails-core/dist/cli.mjs',
        );
      }
    }
  });

  it('covers apply_patch and locks shell/MCP capabilities during fixing', () => {
    expect(groups('PostToolUse')[0]?.matcher).toContain('apply_patch');
    const matchers = groups('PreToolUse')
      .map((group) => group.matcher)
      .join('|');
    expect(matchers).toContain('apply_patch');
    expect(matchers).toContain('Bash');
    expect(matchers).toContain('mcp__');
    expect(commands('PreToolUse').map((hook) => hook.command)).toContainEqual(
      expect.stringContaining('scope-check --dialect=codex'),
    );
  });

  it('keeps SessionEnd within Codex fixed timeout ceiling', () => {
    expect(commands('SessionEnd')[0]?.timeout).toBe(3);
  });
});
