import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Wiring guard for the Claude Code plugin. `guardrails-plugin/hooks/hooks.json`
 * is what a CONSUMER repo installs, so a missing event there is a guard that
 * silently does not run in the product.
 *
 * It also pins WHERE the scope-lock lives. Live Claude Code 2.1.258 did not
 * execute repo-local agent-frontmatter hooks, so scope-check is session-level
 * and self-activates only while the exact session's fix loop marker exists.
 * That makes it enforceable without confining later main-agent turns.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(here, '../../guardrails-plugin');
const repoDirectory = path.resolve(here, '../..');

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
    ).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
  });

  it('wires the self-filtering scope-check session-wide', () => {
    expect(commandsFor('PreToolUse')).toContain(
      'node "${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs" scope-check',
    );
  });

  it('does not rely on unsupported fixer-agent frontmatter hooks', () => {
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
      expect(frontmatter, file).not.toContain('PreToolUse');
      expect(frontmatter, file).not.toContain('scope-check');
    }
  });

  it('dogfoods the same session-level scope-check wiring', () => {
    const settings = JSON.parse(
      readFileSync(
        path.join(repoDirectory, '.claude', 'settings.json'),
        'utf8',
      ),
    ) as { hooks: Record<string, HookEntry[]> };
    const commands = (settings.hooks.PreToolUse ?? []).flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(commands).toContain(
      'node "${CLAUDE_PROJECT_DIR}/node_modules/guardrails-core/dist/cli.mjs" scope-check',
    );
  });

  it('dispatches each event to its own guardrails command', () => {
    expect(commandsFor('PostToolUse').join(' ')).toContain('autofix');
    expect(commandsFor('PreToolUse').join(' ')).toContain('scope-check');
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
