import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
      Object.keys(config.hooks).sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      ['agentStop', 'postToolUse', 'preToolUse'].sort((a, b) =>
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
});
