import { describe, expect, it } from 'vitest';

import {
  isFixerAgentMissing,
  unbuiltFixerAgents,
} from '../src/fixer-agents.js';

/**
A checkout holding exactly these repo-relative files.
*/
function checkout(files: Record<string, string>) {
  return (file: string): string | undefined => files[file];
}

const SOURCE = 'guardrails-plugin/agents/guardrail-fixer.md';
const GENERATED = '.claude/agents/guardrail-fixer.md';

describe('unbuiltFixerAgents', () => {
  it('names an agent whose generated copy is missing', () => {
    expect(
      unbuiltFixerAgents(['guardrail-fixer'], checkout({ [SOURCE]: 'v2' })),
    ).toEqual(['guardrail-fixer']);
  });

  it('names an agent whose generated copy is behind its source', () => {
    expect(
      unbuiltFixerAgents(
        ['guardrail-fixer'],
        checkout({ [SOURCE]: 'v2', [GENERATED]: 'v1' }),
      ),
    ).toEqual(['guardrail-fixer']);
  });

  it('is empty when the generated copy is its source', () => {
    expect(
      unbuiltFixerAgents(
        ['guardrail-fixer'],
        checkout({ [SOURCE]: 'v2', [GENERATED]: 'v2' }),
      ),
    ).toEqual([]);
  });

  it('is empty in a repository that generates no agents', () => {
    // A consumer's agents are committed files, or come from the plugin: with
    // no source to build from there is nothing to be behind.
    expect(unbuiltFixerAgents(['guardrail-fixer'], checkout({}))).toEqual([]);
    expect(
      unbuiltFixerAgents(['guardrail-fixer'], checkout({ [GENERATED]: 'v1' })),
    ).toEqual([]);
  });

  it('answers per agent, and once for a name given twice', () => {
    const read = checkout({
      [SOURCE]: 'v2',
      [GENERATED]: 'v2',
      'guardrails-plugin/agents/guardrail-fixer-thorough.md': 'v2',
    });
    expect(
      unbuiltFixerAgents(['guardrail-fixer', 'guardrail-fixer-thorough'], read),
    ).toEqual(['guardrail-fixer-thorough']);
    expect(
      unbuiltFixerAgents(
        ['guardrail-fixer-thorough', 'guardrail-fixer-thorough'],
        read,
      ),
    ).toEqual(['guardrail-fixer-thorough']);
  });
});

describe('isFixerAgentMissing', () => {
  it('is true when there is a source and no generated copy', () => {
    expect(
      isFixerAgentMissing('guardrail-fixer', checkout({ [SOURCE]: 'v2' })),
    ).toBe(true);
  });

  it('is false for a copy that is only behind: that agent can be spawned', () => {
    expect(
      isFixerAgentMissing(
        'guardrail-fixer',
        checkout({ [SOURCE]: 'v2', [GENERATED]: 'v1' }),
      ),
    ).toBe(false);
  });

  it('is false in a repository that generates no agents', () => {
    expect(isFixerAgentMissing('guardrail-fixer', checkout({}))).toBe(false);
  });
});
