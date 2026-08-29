import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Wiring guard for the Claude Code plugin. `guardrails-plugin/hooks/hooks.json`
 * is what a CONSUMER repo installs, so a missing event there is a guard that
 * silently does not run in the product — exactly how the PreToolUse scope-check
 * went unwired: nothing asserted the set, so nothing noticed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const hooksPath = path.resolve(
  here,
  '../../guardrails-plugin/hooks/hooks.json',
);

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

const wiring = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
  hooks: Record<string, HookEntry[]>;
};

/** Every command string configured for one hook event. */
function commandsFor(event: string): string[] {
  return (wiring.hooks[event] ?? []).flatMap((entry) =>
    entry.hooks.map((hook) => hook.command),
  );
}

describe('guardrails-plugin hook wiring', () => {
  it('wires every event the control loop depends on', () => {
    expect(
      Object.keys(wiring.hooks).sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
  });

  it('wires the PreToolUse scope-check over the read/edit tools', () => {
    // The fixer scope-lock: reads confined to the repo, edits confined to the
    // violations manifest. Tool-level frontmatter restricts WHICH tools the
    // fixer has; this hook restricts WHICH PATHS they may touch.
    const preToolUse = wiring.hooks.PreToolUse ?? [];
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0]?.matcher).toBe('Read|Edit|Write');
    expect(commandsFor('PreToolUse').join(' ')).toContain('scope-check');
  });

  it('dispatches each event to its own guardrails command', () => {
    expect(commandsFor('PostToolUse').join(' ')).toContain('autofix');
    expect(commandsFor('Stop').join(' ')).toContain('gate --mode=stop');
    expect(commandsFor('SessionStart').join(' ')).toContain('session-start');
    expect(commandsFor('SessionEnd').join(' ')).toContain('session-end');
  });

  it('resolves the CLI consumer-generically, with a timeout on every hook', () => {
    // Ships into other repos: the command must resolve through the consumer's
    // own CLAUDE_PROJECT_DIR and node_modules, never this repo's layout.
    const every = Object.keys(wiring.hooks).flatMap((event) =>
      commandsFor(event),
    );
    expect(every.length).toBeGreaterThan(0);
    expect(
      every.every((command) =>
        command.includes(
          '${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs',
        ),
      ),
    ).toBe(true);
    expect(every.some((command) => command.includes('guardrails-plugin'))).toBe(
      false,
    );
    const timeouts = Object.values(wiring.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((hook) => hook.timeout));
    expect(timeouts.every((timeout) => typeof timeout === 'number')).toBe(true);
  });
});
