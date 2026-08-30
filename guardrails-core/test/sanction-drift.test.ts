import { describe, expect, it } from 'vitest';

import { auditSource, findingKey } from '../src/audit.js';
import { sanctionCountDrift } from '../src/sanctions.js';

const DISABLE = '// Stryker disable next-line ConditionalExpression';
// A strict PREFIX of the directive above. Counting by substring rather than by
// the auditor's own extraction would score this as an occurrence of the
// shorter key, over-provisioning its budget.
const WIDER =
  '// Stryker disable next-line ConditionalExpression,BlockStatement';

describe('auditSource', () => {
  it('finds a suppression in whole-file source, not just a diff', () => {
    const findings = auditSource(
      'src/a.ts',
      `const x = 1;\n${DISABLE}\nfoo();`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toBe(DISABLE);
    expect(findings[0]?.file).toBe('src/a.ts');
  });

  it('does not confuse a directive with a longer one sharing its prefix', () => {
    const findings = auditSource('src/a.ts', `${WIDER}\nfoo();`);
    expect(findings.map((f) => f.text)).toEqual([WIDER]);
    // The narrower key must score ZERO occurrences here.
    const narrow = `src/a.ts|mutation-suppress|${DISABLE}`;
    expect(findings.filter((f) => findingKey(f) === narrow)).toHaveLength(0);
    expect(findings.map((f) => findingKey(f))).toEqual([
      `src/a.ts|mutation-suppress|${WIDER}`,
    ]);
  });

  it('ignores a directive that is only mentioned inside a string literal', () => {
    // The auditor's lexer already knows the difference; reusing it is the
    // reason this check does not do its own matching.
    const findings = auditSource('src/a.ts', `const s = "${DISABLE}";`);
    expect(findings).toEqual([]);
  });

  it('ignores files whose extension is not auditable', () => {
    expect(auditSource('README.md', DISABLE)).toEqual([]);
  });
});

const read =
  (contents: Record<string, string>) =>
  (file: string): string | undefined =>
    contents[file];

describe('sanctionCountDrift', () => {
  it('reports nothing when every declared count matches reality', () => {
    const drift = sanctionCountDrift(
      [{ key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r', count: 2 }],
      read({ 'src/a.ts': `${DISABLE}\nfoo();\n${DISABLE}\nbar();` }),
    );
    expect(drift).toEqual([]);
  });

  it('reports an over-declared count — the stale-config case', () => {
    // A refactor deleted one of the two suppressed sites without touching the
    // policy file, so the budget silently over-provisions.
    const drift = sanctionCountDrift(
      [{ key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r', count: 2 }],
      read({ 'src/a.ts': `${DISABLE}\nfoo();` }),
    );
    expect(drift).toEqual([
      {
        key: `src/a.ts|mutation-suppress|${DISABLE}`,
        declared: 2,
        actual: 1,
      },
    ]);
  });

  it('reports an under-declared count too', () => {
    const drift = sanctionCountDrift(
      [{ key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r' }],
      read({ 'src/a.ts': `${DISABLE}\nfoo();\n${DISABLE}` }),
    );
    expect(drift[0]).toMatchObject({ declared: 1, actual: 2 });
  });

  it('sums several entries that grant the same key', () => {
    // The config legitimately splits one key across entries with separate
    // reasons; the budget is their sum, so the check must compare the sum.
    const key = `src/a.ts|mutation-suppress|${DISABLE}`;
    const drift = sanctionCountDrift(
      [
        { key, reason: 'first', count: 3 },
        { key, reason: 'second', count: 1 },
      ],
      read({ 'src/a.ts': Array.from({ length: 4 }, () => DISABLE).join('\n') }),
    );
    expect(drift).toEqual([]);
  });

  it('treats a vanished file as zero occurrences', () => {
    const drift = sanctionCountDrift(
      [{ key: `src/gone.ts|mutation-suppress|${DISABLE}`, reason: 'r' }],
      read({}),
    );
    expect(drift).toEqual([
      {
        key: `src/gone.ts|mutation-suppress|${DISABLE}`,
        declared: 1,
        actual: 0,
      },
    ]);
  });

  it('reads each file once even when several keys point at it', () => {
    const reads: string[] = [];
    const drift = sanctionCountDrift(
      [
        { key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r' },
        { key: `src/a.ts|mutation-suppress|${WIDER}`, reason: 'r' },
      ],
      (file) => {
        reads.push(file);
        return `${DISABLE}\nfoo();\n${WIDER}\nbar();`;
      },
    );
    expect(drift).toEqual([]);
    expect(reads).toEqual(['src/a.ts']);
  });
});

describe('sanctionCountDrift — several keys in one file', () => {
  it('reports drift for EVERY key in a file, not just one of them', () => {
    // Guards the per-file grouping: an implementation that kept only the first
    // or only the last key for a file would report one of these two, not both.
    const first = `src/a.ts|mutation-suppress|${DISABLE}`;
    const second = `src/a.ts|mutation-suppress|${WIDER}`;
    const drift = sanctionCountDrift(
      [
        { key: first, reason: 'r', count: 2 },
        { key: second, reason: 'r', count: 3 },
      ],
      () => `${DISABLE}\n${WIDER}`,
    );
    expect(drift).toEqual([
      { key: first, declared: 2, actual: 1 },
      { key: second, declared: 3, actual: 1 },
    ]);
  });
});
