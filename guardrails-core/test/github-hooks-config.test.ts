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
  hooks: Record<
    string,
    { hooks: { command?: string; timeoutSec?: number }[] }[]
  >;
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

  it('gives every gate a timeout well above the 30-second default', () => {
    // Copilot's default `timeoutSec` is 30, and a timeout is fail-OPEN for
    // every event, preToolUse included (docs.github.com/en/copilot/reference/
    // hooks-reference). A commit gate routinely runs longer than that, so
    // without an explicit timeout the gate was silently skipped on any commit
    // slower than half a minute. 300 matches the Claude and Codex wiring; the
    // CLI's own deadline (`hookDeadlineSeconds`) sits below it so the gate
    // decides before the host gives up on it.
    for (const event of ['preToolUse', 'agentStop']) {
      const groups = config.hooks[event] ?? [];
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.timeoutSec).toBe(300);
        }
      }
    }
    expect(config.hooks.postToolUse?.[0]?.hooks[0]?.timeoutSec).toBe(120);
  });

  it('spells each Copilot command exactly', () => {
    const stop = config.hooks.agentStop?.[0]?.hooks[0]?.command;
    expect(stop).toBe(cliCommand('gate --mode=stop --dialect=copilot'));
    const post = config.hooks.postToolUse?.[0]?.hooks[0]?.command;
    expect(post).toBe(cliCommand('autofix'));
  });
});
