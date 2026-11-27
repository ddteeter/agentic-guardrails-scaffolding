/**
 * `tool-config-escape` (GR-04): an added line in a Swift tool's own config
 * that switches a check off. These files are not source, so no line
 * signature applies; what matters is which key an added line sits under.
 */

import { describe, expect, it } from 'vitest';

import { toolConfigAuditor } from '../src/audit-tool-config.js';

/**
The post-change file could not be read, so what is above the hunk is unknown.
*/
const UNREADABLE = 'unreadable';

function noLines(): string[] {
  return [];
}

/**
 * Feed `lines` (each `+added` or ` context`) through the auditor for `file`,
 * given the post-change lines above the hunk, and answer the added lines it
 * called a weakening, as `audit.ts` does.
 */
function flagged(
  file: string,
  lines: readonly string[],
  before: readonly string[] | typeof UNREADABLE = [],
): string[] {
  const auditor = toolConfigAuditor(file, () =>
    before === UNREADABLE ? undefined : before,
  );
  if (auditor === undefined) {
    throw new Error(`${file} has no tool-config auditor`);
  }
  // Every line is read, in order; only an added one can be a finding.
  return lines.filter(
    (line) => auditor.line(line.slice(1)) && line.startsWith('+'),
  );
}

describe('which files have a tool-config rule', () => {
  it.each([
    '.swiftlint.yml',
    'ios/.swiftlint.yml',
    'ios/Packages/DialedDomain/.swiftlint.yml',
    '.swiftformat',
    'ios/.swiftformat',
    '.periphery.yml',
    'ios/.periphery.yml',
  ])('%s does', (file) => {
    expect(toolConfigAuditor(file, noLines)).toBeDefined();
  });

  it.each([
    'ios/App/Model.swift',
    'swiftlint.yml',
    'ios/.swiftlint.yml.bak',
    'ios/not.swiftformat',
    'project.yml',
    'guardrails.config.json',
  ])('%s does not', (file) => {
    expect(toolConfigAuditor(file, noLines)).toBeUndefined();
  });
});

/**
A reader of the lines above a hunk that counts how often it is asked.
*/
function counting(): { above: () => string[]; calls: () => number } {
  let calls = 0;
  return {
    above: () => {
      calls += 1;
      return [];
    },
    calls: () => calls,
  };
}

describe('the lines above the hunk', () => {
  it.each([
    ['not asked for when the file is no tool config', 'src/a.ts', 0],
    [
      'not asked for by .swiftformat, whose lines stand alone',
      '.swiftformat',
      0,
    ],
    ['asked for once by a YAML config', '.swiftlint.yml', 1],
  ])('are %s', (_label, file, asked) => {
    const probe = counting();
    toolConfigAuditor(file, probe.above);
    expect(probe.calls()).toBe(asked);
  });
});

describe('.swiftlint.yml', () => {
  const file = 'ios/.swiftlint.yml';

  it('flags an added rule under disabled_rules', () => {
    expect(
      flagged(file, [
        ' disabled_rules:',
        '   - line_length',
        '+  - force_cast',
      ]),
    ).toEqual(['+  - force_cast']);
  });

  it('flags an added path under excluded', () => {
    expect(flagged(file, [' excluded:', '+  - Generated'])).toEqual([
      '+  - Generated',
    ]);
  });

  it('flags the key line itself when it is added', () => {
    expect(
      flagged(file, [
        '+disabled_rules: [force_cast]',
        '+excluded:',
        '+  - Pods',
      ]),
    ).toEqual(['+disabled_rules: [force_cast]', '+excluded:', '+  - Pods']);
  });

  it('flags an excluded list nested in a rule’s own configuration', () => {
    expect(
      flagged(file, [' identifier_name:', '+  excluded:', '+    - id']),
    ).toEqual(['+  excluded:', '+    - id']);
  });

  it('leaves an added line under any other key alone', () => {
    expect(
      flagged(file, [
        ' opt_in_rules:',
        '+  - force_unwrapping',
        '+line_length: 120',
        '+strict: true',
      ]),
    ).toEqual([]);
  });

  it('stops flagging once another key begins', () => {
    expect(
      flagged(file, [
        ' disabled_rules:',
        '+  - todo',
        ' opt_in_rules:',
        '+  - force_try',
      ]),
    ).toEqual(['+  - todo']);
  });

  it('reads a context line as well as an added one to know the key', () => {
    expect(
      flagged(file, [' opt_in_rules:', ' excluded:', '+  - Pods']),
    ).toEqual(['+  - Pods']);
    expect(
      flagged(file, [' excluded:', ' opt_in_rules:', '+  - force_try']),
    ).toEqual([]);
  });

  it('reads a list item that holds a colon as an item, not as a key', () => {
    expect(
      flagged(file, [' disabled_rules:', '+  - name: todo', '+  - force_cast']),
    ).toEqual(['+  - name: todo', '+  - force_cast']);
  });

  it('reads a key written with a space before its colon', () => {
    expect(flagged(file, ['+excluded : [Pods]', '+strict : true'])).toEqual([
      '+excluded : [Pods]',
    ]);
  });

  it('leaves a blank or comment-only line alone, and keeps its place', () => {
    expect(
      flagged(file, [
        ' disabled_rules:',
        '+',
        '+   ',
        '+  # excluded: not a key, a comment',
        '+# opt_in_rules: nor is this',
        '+  - todo',
      ]),
    ).toEqual(['+  - todo']);
  });

  it('ignores a comment after a value', () => {
    expect(flagged(file, ['+line_length: 120 # excluded: nothing'])).toEqual(
      [],
    );
  });

  it('matches the key by its whole name', () => {
    expect(
      flagged(file, [
        '+not_excluded:',
        '+  - a',
        '+excluded_paths:',
        '+  - b',
        '+disabled_rules_extra: [c]',
      ]),
    ).toEqual([]);
  });

  it('takes the key above the hunk from the file when it can be read', () => {
    expect(flagged(file, ['+  - todo'], ['disabled_rules:', '  - a'])).toEqual([
      '+  - todo',
    ]);
    expect(flagged(file, ['+  - todo'], ['opt_in_rules:', '  - a'])).toEqual(
      [],
    );
    expect(
      flagged(
        file,
        ['+  - todo'],
        ['disabled_rules:', '  - a', 'opt_in_rules:'],
      ),
    ).toEqual([]);
  });

  it('starts a file with no lines above the hunk under no key', () => {
    expect(flagged(file, ['+  - todo'], [])).toEqual([]);
  });

  it('flags a list item whose key it cannot know: over-match rather than miss', () => {
    // Documented limit: without the post-change file, a hunk that begins
    // inside a list could be under any key.
    expect(flagged(file, ['+  - todo'], UNREADABLE)).toEqual(['+  - todo']);
    // A key line settles it either way.
    expect(
      flagged(file, ['+opt_in_rules:', '+  - force_try'], UNREADABLE),
    ).toEqual([]);
  });
});

describe('.periphery.yml', () => {
  const file = 'ios/.periphery.yml';

  it('flags an added retain_* key', () => {
    expect(
      flagged(file, [
        '+retain_public: true',
        '+retain_objc_accessible: true',
        '+  retain_assign_only_property_types:',
        '+    - CGFloat',
      ]),
    ).toEqual([
      '+retain_public: true',
      '+retain_objc_accessible: true',
      '+  retain_assign_only_property_types:',
      '+    - CGFloat',
    ]);
  });

  it('leaves every other key alone', () => {
    expect(
      flagged(file, [
        '+schemes:',
        '+  - DialedApp',
        '+not_retain_public: true',
      ]),
    ).toEqual([]);
  });

  it('does not borrow SwiftLint’s keys', () => {
    expect(flagged(file, ['+excluded:', '+  - Pods'])).toEqual([]);
    expect(flagged('.swiftlint.yml', ['+retain_public: true'])).toEqual([]);
  });
});

describe('.swiftformat', () => {
  const file = 'ios/.swiftformat';

  it('flags an added --disable or --exclude', () => {
    expect(
      flagged(file, [
        '+--disable redundantSelf,trailingCommas',
        '+  --exclude Generated',
        '+--exclude',
      ]),
    ).toEqual([
      '+--disable redundantSelf,trailingCommas',
      '+  --exclude Generated',
      '+--exclude',
    ]);
  });

  it('leaves every other option alone', () => {
    expect(
      flagged(file, [
        '+--indent 2',
        '+--enable isEmpty',
        '+--swiftversion 6.2',
        '+--disabled-thing x',
        '+--excluded x',
        '+--unexclude Generated',
        '+# --disable redundantSelf',
        '+--rules indent # --disable nothing',
      ]),
    ).toEqual([]);
  });

  it('finds the option wherever it stands on the line', () => {
    expect(flagged(file, ['+--indent 2 --disable redundantSelf'])).toEqual([
      '+--indent 2 --disable redundantSelf',
    ]);
  });

  it('needs no lines above the hunk: every line stands alone', () => {
    expect(flagged(file, ['+--disable x'], UNREADABLE)).toEqual([
      '+--disable x',
    ]);
  });
});
