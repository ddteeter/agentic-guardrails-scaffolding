import { describe, expect, it } from 'vitest';

import { foregroundWait, withoutQuotedText } from '../src/foreground-wait.js';

const LIMIT = 120;

describe('foregroundWait: the waits it names', () => {
  it.each([
    ['gh pr checks 12 --watch', 'gh pr checks --watch'],
    ['gh pr checks --watch', 'gh pr checks --watch'],
    [
      'gh  pr  checks 12 --interval 30 --watch --fail-fast',
      'gh pr checks --watch',
    ],
    ['cd x && gh pr checks --watch', 'gh pr checks --watch'],
    ['gh run watch 123', 'gh run watch'],
    ['gh run watch', 'gh run watch'],
    [
      'until ! kill -0 4242; do sleep 20; done',
      'a wait loop on kill -0 or pgrep',
    ],
    [
      'while kill -0 $pid 2>/dev/null; do sleep 5; done',
      'a wait loop on kill -0 or pgrep',
    ],
    [
      'while kill  -0 $pid; do sleep 5; done',
      'a wait loop on kill -0 or pgrep',
    ],
    [
      'while pgrep -f vitest >/dev/null; do sleep 5; done',
      'a wait loop on kill -0 or pgrep',
    ],
    [
      'echo start\nuntil  ! pgrep x\ndo sleep 1; done',
      'a wait loop on kill -0 or pgrep',
    ],
    ['sleep 600', 'sleep 600'],
    ['sleep 121', 'sleep 121'],
    ['sleep 3m', 'sleep 3m'],
    ['sleep 1h', 'sleep 1h'],
    ['sleep 1d', 'sleep 1d'],
    ['sleep 120.5', 'sleep 120.5'],
    ['npm test; sleep 300', 'sleep 300'],
    ['while true; do sleep 300; done', 'sleep 300'],
    ['if x; then sleep 300; fi', 'sleep 300'],
    ['guardrails ship', 'guardrails ship'],
    ['npx guardrails-core ship --body-file=pr.md', 'guardrails ship'],
    [
      'node ./node_modules/guardrails-core/dist/cli.mjs ship',
      'guardrails ship',
    ],
    [
      'node -e "import(\'guardrails-core/cli\')" guardrails ship',
      'guardrails ship',
    ],
  ])('names %j', (command, expected) => {
    expect(foregroundWait(command, LIMIT)).toBe(expected);
  });
});

describe('foregroundWait: what it leaves alone', () => {
  it.each([
    'gh pr checks 12',
    'gh pr checks 12 --json name,bucket',
    'gh pr checks 12; echo --watch',
    'gh run list',
    'gh run view 123 --log',
    'sleep 120',
    'sleep 2m',
    'sleep 5',
    'sleep 0.5',
    'kill -0 4242',
    'pgrep -f vitest',
    'until make; do echo retry; done',
    'while read line; do echo "$line"; done',
    'while x; do kill -0 1; done',
    'echo sleep 600',
    'git commit -m "sleep 600"',
    'git commit -m "x; gh pr checks --watch"',
    "echo 'until ! kill -0 1; do sleep 20; done'",
    'git commit -m "then guardrails ship"',
    'echo guardrails ship it',
    'guardrails shipping',
    'notguardrails ship',
    "cat > notes.md <<'EOF'\nsleep 600\ngh run watch\nEOF",
    'mysleep 600',
    'sleep 600x',
  ])('allows %j', (command) => {
    expect(foregroundWait(command, LIMIT)).toBeUndefined();
  });

  it('follows the configured threshold', () => {
    expect(foregroundWait('sleep 60', 30)).toBe('sleep 60');
    expect(foregroundWait('sleep 600', 900)).toBeUndefined();
  });

  it('adds the minutes and hours up', () => {
    expect(foregroundWait('sleep 2m', 119)).toBe('sleep 2m');
    expect(foregroundWait('sleep 2m', 120)).toBeUndefined();
    expect(foregroundWait('sleep 1h', 3599)).toBe('sleep 1h');
    expect(foregroundWait('sleep 1h', 3600)).toBeUndefined();
    expect(foregroundWait('sleep 1d', 86_399)).toBe('sleep 1d');
    expect(foregroundWait('sleep 1d', 86_400)).toBeUndefined();
    expect(foregroundWait('sleep 100s', 99)).toBe('sleep 100s');
    expect(foregroundWait('sleep 100s', 100)).toBeUndefined();
  });
});

describe('withoutQuotedText', () => {
  it('keeps the quotes and drops what is between them', () => {
    expect(withoutQuotedText(`a "b c" d 'e f' g`)).toBe(`a "" d '' g`);
  });

  it('honours a backslash outside single quotes', () => {
    expect(withoutQuotedText(String.raw`a \" b "c \" d" e`)).toBe(
      String.raw`a \" b "" e`,
    );
  });

  it('reads a backslash literally inside single quotes', () => {
    expect(withoutQuotedText(String.raw`'a\' b`)).toBe(`'' b`);
  });

  it('reads an escaped quote or backslash outside quotes', () => {
    expect(withoutQuotedText(String.raw`\'b' c`)).toBe(String.raw`\'b'`);
    expect(withoutQuotedText(String.raw`\"b" c`)).toBe(String.raw`\"b"`);
    expect(withoutQuotedText(String.raw`\\"b" c`)).toBe(String.raw`\\"" c`);
  });

  it('skips any escaped character inside double quotes', () => {
    expect(withoutQuotedText(String.raw`"a\ b" c`)).toBe('"" c');
  });

  it('drops an unterminated single-quoted tail', () => {
    expect(withoutQuotedText("a 'b c")).toBe("a '");
  });

  it('drops an unterminated tail', () => {
    expect(withoutQuotedText('a "b c')).toBe('a "');
    expect(withoutQuotedText('a "')).toBe('a "');
    expect(withoutQuotedText("a '")).toBe("a '");
  });
});
