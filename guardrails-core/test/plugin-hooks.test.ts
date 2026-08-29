import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Wiring guard for the Claude Code plugin. `guardrails-plugin/hooks/hooks.json`
 * is what a CONSUMER repo installs, so a missing event there is a guard that
 * silently does not run in the product.
 *
 * It also pins WHERE the scope-lock lives, which is easy to get wrong: the
 * PreToolUse scope-check is declared in each fixer AGENT's frontmatter, not in
 * the session-level hooks. That is deliberate — it must confine the fixer
 * subagents, and wiring it session-wide would confine the MAIN agent too (no
 * ~/.claude memory, no scratchpad, no sibling repos). Copilot cannot express
 * per-agent hooks, which is why `.github/hooks/guardrails.json` wires the same
 * check session-wide there instead: richest-per-surface, not an inconsistency.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(here, '../../guardrails-plugin');

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

const wiring = JSON.parse(
  readFileSync(path.join(pluginDirectory, 'hooks', 'hooks.json'), 'utf8'),
) as { hooks: Record<string, HookEntry[]> };

/** Every command string configured for one hook event. */
function commandsFor(event: string): string[] {
  return (wiring.hooks[event] ?? []).flatMap((entry) =>
    entry.hooks.map((hook) => hook.command),
  );
}

describe('guardrails-plugin hook wiring', () => {
  it('wires every session-level event the control loop depends on', () => {
    expect(
      Object.keys(wiring.hooks).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop']);
  });

  it('does NOT wire the scope-check session-wide', () => {
    // A session-level PreToolUse would apply to the MAIN agent, not just the
    // fixers. The scope-lock is fixer-only by design.
    expect(wiring.hooks.PreToolUse).toBeUndefined();
  });

  it('declares the scope-check in each fixer agent instead', () => {
    const agentsDirectory = path.join(pluginDirectory, 'agents');
    const agents = readdirSync(agentsDirectory).filter((file) =>
      file.endsWith('.md'),
    );
    expect(agents.length).toBeGreaterThan(0);
    for (const file of agents) {
      const frontmatter =
        readFileSync(path.join(agentsDirectory, file), 'utf8').split(
          '---',
        )[1] ?? '';
      expect(frontmatter, file).toContain('PreToolUse');
      expect(frontmatter, file).toContain('scope-check');
      expect(frontmatter, file).toContain("matcher: 'Read|Edit|Write'");
    }
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
