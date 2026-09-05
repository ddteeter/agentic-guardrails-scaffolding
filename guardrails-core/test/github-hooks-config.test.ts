import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_PREFIX, cliCommand } from './hook-command.js';

const config = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      '..',
      '..',
      '.github',
      'hooks',
      'guardrails.json',
    ),
    'utf8',
  ),
) as {
  version: number;
  hooks: Record<string, { hooks: { command?: string }[] }[]>;
};

describe('.github/hooks/guardrails.json', () => {
  it('declares the camelCase native envelope', () => {
    expect(config.version).toBe(1);
    expect(
      Object.keys(config.hooks).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      ['agentStop', 'postToolUse', 'preToolUse'].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  it('invokes the copilot dialect on the deny-capable gates', () => {
    const commands = JSON.stringify(config.hooks);
    expect(commands).toContain('gate --mode=stop --dialect=copilot');
    expect(commands).toContain('gate --mode=pretooluse --dialect=copilot');
    expect(commands).toContain('scope-check --dialect=copilot');
    expect(commands).toContain('autofix');
  });

  it('resolves the CLI by package name, never by a constructed path', () => {
    // The regression this file exists to prevent: CLAUDE_PROJECT_DIR is Claude
    // Code's variable. Copilot never sets it, so `${CLAUDE_PROJECT_DIR:-.}`
    // always took the `.` branch and resolved to the process cwd under a name
    // that claimed otherwise.
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toContain(CLI_PREFIX);
          expect(hook.command).not.toContain('CLAUDE_PROJECT_DIR');
          expect(hook.command).not.toContain('node_modules');
        }
      }
    }
  });

  it('spells each Copilot command exactly', () => {
    const stop = config.hooks.agentStop?.[0]?.hooks[0]?.command;
    expect(stop).toBe(cliCommand('gate --mode=stop --dialect=copilot'));
    const post = config.hooks.postToolUse?.[0]?.hooks[0]?.command;
    expect(post).toBe(cliCommand('autofix'));
  });
});
