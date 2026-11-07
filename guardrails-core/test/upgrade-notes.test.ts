import { describe, expect, it } from 'vitest';

import { parseUpgradeNotes } from '../src/upgrade-notes.js';

const FULL = `---
version: 0.12.0
supersedes:
  - search: 'does not push'
    because: 'lanes ship themselves with \`guardrails ship\`'
  - search: gh pr checks --watch
    because: 'it''s denied by the PreToolUse hook'
wire:
  - kind: script
    name: ship
    value: 'guardrails ship'
    because: 'one backgrounded push + PR + CI wait'
---

# 0.12.0

Body text.
`;

function errorOf(text: string): string | undefined {
  const result = parseUpgradeNotes(text);
  return 'error' in result ? result.error : undefined;
}

describe('parseUpgradeNotes: what it reads', () => {
  it('reads the version, both lists and the body', () => {
    expect(parseUpgradeNotes(FULL)).toEqual({
      notes: {
        version: '0.12.0',
        supersedes: [
          {
            search: 'does not push',
            because: 'lanes ship themselves with `guardrails ship`',
          },
          {
            search: 'gh pr checks --watch',
            because: "it's denied by the PreToolUse hook",
          },
        ],
        wire: [
          {
            kind: 'script',
            name: 'ship',
            value: 'guardrails ship',
            because: 'one backgrounded push + PR + CI wait',
          },
        ],
        body: '# 0.12.0\n\nBody text.\n',
      },
    });
  });

  it('drops every blank line between the frontmatter and the body', () => {
    expect(parseUpgradeNotes('---\nversion: 1\n---\n\n\nx\n')).toMatchObject({
      notes: { body: 'x\n' },
    });
  });

  it('reads a double-quoted value, as prettier writes one holding a quote', () => {
    expect(
      parseUpgradeNotes(
        '---\nversion: "1.0.0"\nsupersedes:\n  - search: "it\'s here"\n    because: ""\n---\n',
      ),
    ).toEqual({ error: 'supersedes item 1: "because" is empty' });
    expect(
      parseUpgradeNotes(
        '---\nversion: "1.0.0"\nsupersedes:\n  - search: "it\'s here"\n    because: b\n---\n',
      ),
    ).toMatchObject({
      notes: {
        version: '1.0.0',
        supersedes: [{ search: "it's here", because: 'b' }],
      },
    });
  });

  it('reads absent lists as empty', () => {
    expect(parseUpgradeNotes('---\nversion: 1.0.0\n---\nx\n')).toEqual({
      notes: { version: '1.0.0', supersedes: [], wire: [], body: 'x\n' },
    });
  });

  it('skips blank lines inside the frontmatter', () => {
    const result = parseUpgradeNotes(
      '---\nversion: 1.0.0\n\nsupersedes:\n\n  - search: a b\n    because: c\n---\n',
    );
    expect(result).toMatchObject({
      notes: { supersedes: [{ search: 'a b', because: 'c' }] },
    });
  });

  it('skips whitespace-only lines inside the frontmatter', () => {
    expect(parseUpgradeNotes('---\nversion: 1.0.0\n  \n---\n')).toMatchObject({
      notes: { version: '1.0.0' },
    });
  });

  it('keeps --- inside a value and closes only on a line of its own', () => {
    expect(parseUpgradeNotes('---\nversion: a---\n---\n')).toMatchObject({
      notes: { version: 'a---' },
    });
  });

  it('reads CRLF line endings', () => {
    expect(
      parseUpgradeNotes('---\r\nversion: 1.0.0\r\n---\r\nx\r\n'),
    ).toMatchObject({ notes: { version: '1.0.0' } });
  });
});

describe('parseUpgradeNotes: what it refuses', () => {
  it.each([
    ['no frontmatter', '# just a body\n', 'no frontmatter'],
    ['an unclosed frontmatter', '---\nversion: 1.0.0\n', 'no frontmatter'],
    ['a missing version', '---\nwire:\n---\n', 'version'],
    ['an empty version', "---\nversion: ''\n---\n", 'version'],
    ['an unknown top-level key', '---\nversion: 1\nnotes: x\n---\n', 'notes'],
    [
      'an unknown item key',
      '---\nversion: 1\nsupersedes:\n  - search: a\n    because: b\n    regex: c\n---\n',
      'regex',
    ],
    [
      'an empty search',
      "---\nversion: 1\nsupersedes:\n  - search: ''\n    because: b\n---\n",
      'search',
    ],
    [
      'a missing because',
      '---\nversion: 1\nsupersedes:\n  - search: a\n---\n',
      'because',
    ],
    [
      'an unknown wire kind',
      '---\nversion: 1\nwire:\n  - kind: plugin\n    name: a\n    value: b\n    because: c\n---\n',
      'plugin',
    ],
    [
      'a wire entry without a value',
      '---\nversion: 1\nwire:\n  - kind: script\n    name: a\n    because: c\n---\n',
      'value',
    ],
    [
      'an item outside a list',
      '---\nversion: 1\n  - search: a\n---\n',
      'line 2',
    ],
    [
      'a list key given a scalar',
      '---\nversion: 1\nsupersedes: everything\n---\n',
      'supersedes',
    ],
    ['a line it does not understand', '---\nversion: 1\n\tx\n---\n', 'line 2'],
    ['an unterminated quote', "---\nversion: '1.0.0\n---\n", 'line 1'],
    [
      'an unterminated double quote',
      '---\nversion: "1.0.0\n---\n',
      'line 1: unterminated quote',
    ],
    [
      'a double quote inside a double-quoted value',
      '---\nversion: "1"0"\n---\n',
      'line 1: unterminated quote',
    ],
    [
      'an escape in a double-quoted value',
      '---\nversion: "1\\n0"\n---\n',
      'line 1: escapes are not supported',
    ],
    ['a key given twice', '---\nversion: 1\nversion: 2\n---\n', 'version'],
  ])('refuses %s, naming %j', (_case, text, named) => {
    expect(errorOf(text)).toContain(named);
  });

  it.each([
    ['a lone quote', "---\nversion: '\n---\n", 'line 1: unterminated quote'],
    [
      'a field given twice in one item',
      '---\nversion: 1\nwire:\n  - kind: script\n    kind: hook\n---\n',
      'line 4: "kind" given twice',
    ],
    [
      'a field before any list item',
      '---\nversion: 1\nwire:\n    kind: script\n---\n',
      'line 3: a field before any list item',
    ],
    [
      'a --- line with text after it',
      '---\nversion: 1\n--- x\n---\n',
      'line 2: not understood',
    ],
    [
      'an item indented three spaces',
      '---\nversion: 1\nsupersedes:\n   - search: a\n    because: b\n---\n',
      'line 3: not understood',
    ],
    [
      'a field indented five spaces',
      '---\nversion: 1\nsupersedes:\n  - search: a\n     because: b\n---\n',
      'line 4: not understood',
    ],
    [
      'a top-level line ended by a line separator',
      '---\nversion: 1 x\n---\n',
      'line 1: not understood',
    ],
    [
      'an item start ended by a line separator',
      '---\nversion: 1\nsupersedes:\n  - search: a x\n    because: b\n---\n',
      'line 3: not understood',
    ],
    [
      'a field ended by a line separator',
      '---\nversion: 1\nsupersedes:\n  - search: a\n    because: b x\n---\n',
      'line 4: not understood',
    ],
    [
      'an unknown wire kind, naming the item from 1',
      '---\nversion: 1\nwire:\n  - kind: plugin\n    name: a\n    value: b\n    because: c\n---\n',
      'wire item 1: kind "plugin" is not one of script, hook, config',
    ],
  ])('refuses %s with the exact message', (_case, text, message) => {
    expect(errorOf(text)).toBe(message);
  });

  it('says which item is wrong, counting from 1', () => {
    const text =
      '---\nversion: 1\nsupersedes:\n  - search: a\n    because: b\n  - search: c\n---\n';
    expect(errorOf(text)).toBe('supersedes item 2: missing "because"');
  });
});
