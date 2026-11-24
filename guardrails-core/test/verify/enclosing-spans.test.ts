/**
 * `enclosingSpans` (#196): the lines of the function, or failing that the
 * top-level statement, each changed line sits in, parsed by the real
 * `typescript`.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { enclosingSpans } from '../../src/verify/enclosing-spans.js';

/**
Numbered lines of source, so each case can name its lines.
*/
function source(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const thirtyLineFunction = source(
  "import { x } from './x.js';",
  '',
  'export function long(value: number): number {',
  ...Array.from({ length: 26 }, (_, index) => `  value += ${index};`),
  '  return value;',
  '}',
  '',
  'export const after = 1;',
);

describe('enclosingSpans', () => {
  it('widens a one-line hunk to the whole function around it', () => {
    expect(
      enclosingSpans(ts, 'src/a.ts', thirtyLineFunction, [
        { start: 15, end: 15 },
      ]),
    ).toEqual([{ start: 3, end: 31 }]);
  });

  it('takes only the innermost function: a nested arrow, not its parent', () => {
    const text = source(
      'export function outer(items: number[]): number[] {',
      '  const doubled = items.map((item) => {',
      '    const twice = item * 2;',
      '    return twice;',
      '  });',
      '  return doubled;',
      '}',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 3, end: 3 }]),
    ).toEqual([{ start: 2, end: 5 }]);
  });

  it('takes the top-level statement when the hunk is in no function', () => {
    const text = source(
      'const before = 0;',
      'export const table = {',
      '  one: 1,',
      '  two: 2,',
      '  three: 3,',
      '};',
      'const after = 0;',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 4, end: 4 }]),
    ).toEqual([{ start: 2, end: 6 }]);
  });

  it('takes each function a hunk spans', () => {
    const text = source(
      'function first(): number {',
      '  return 1;',
      '}',
      'function second(): number {',
      '  return 2;',
      '}',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 2, end: 5 }]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it('widens a pure deletion, read as the lines either side of the cut', () => {
    // `parseDiffHunks` turns `+4,0` into lines 4 and 5.
    const text = source(
      'export function guard(value: number): number {',
      '  if (value < 0) {',
      '    return 0;',
      '  }',
      '  return value;',
      '}',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 4, end: 5 }]),
    ).toEqual([{ start: 1, end: 6 }]);
  });

  it('includes a method’s decorator and its JSDoc', () => {
    const text = source(
      'class Service {',
      '  /**',
      '   * Says hello.',
      '   */',
      '  @logged',
      '  greet(): string {',
      "    return 'hello';",
      '  }',
      '}',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 7, end: 7 }]),
    ).toEqual([{ start: 2, end: 8 }]);
  });

  it.each([
    ['a constructor', 'constructor() {'],
    ['a getter', 'get name(): string {'],
    ['a setter', 'set name(value: string) {'],
  ])('takes %s as a function', (_label, head) => {
    const text = source(
      'class Thing {',
      '  other = 1;',
      `  ${head}`,
      '    void 0;',
      '  }',
      '}',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 4, end: 4 }]),
    ).toEqual([{ start: 3, end: 5 }]);
  });

  it('takes a function expression as a function', () => {
    const text = source(
      'export const handlers = {',
      '  run: function run(): void {',
      '    void 0;',
      '  },',
      '  other: 1,',
      '};',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 3, end: 3 }]),
    ).toEqual([{ start: 2, end: 4 }]);
  });

  it('parses TSX', () => {
    const text = source(
      'export function View(): JSX.Element {',
      '  const label = "x";',
      '  return <div>{label}</div>;',
      '}',
    );
    expect(
      enclosingSpans(ts, 'src/view.tsx', text, [{ start: 3, end: 3 }]),
    ).toEqual([{ start: 1, end: 4 }]);
  });

  it.each([
    'src/a.js',
    'src/a.mjs',
    'src/a.cjs',
    'src/a.jsx',
    'src/a.mts',
    'src/a.cts',
  ])('parses %s', (fileName) => {
    const text = source('function a() {', '  return 1;', '}');
    expect(enclosingSpans(ts, fileName, text, [{ start: 2, end: 2 }])).toEqual([
      { start: 1, end: 3 },
    ]);
  });

  it('is undefined for a file typescript has no parser for', () => {
    expect(
      enclosingSpans(ts, 'src/a.vue', '<template></template>\n', [
        { start: 1, end: 1 },
      ]),
    ).toBeUndefined();
  });

  it('finds nothing for blank lines and comments between statements', () => {
    const text = source('const a = 1;', '', '// a note', 'const b = 2;');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 2, end: 3 }]),
    ).toEqual([]);
  });

  it('ignores hunk lines past the end of the file', () => {
    const text = source('const a = 1;');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 5, end: 9 }]),
    ).toEqual([]);
  });

  it('reads a hunk that runs past the end up to the last line', () => {
    const text = source('const a = 1;');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 1, end: 9 }]),
    ).toEqual([{ start: 1, end: 1 }]);
  });

  it('takes the function whose first line is the hunk', () => {
    const text = source('const a = 1;', 'function b() {', '  return 2;', '}');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 2, end: 2 }]),
    ).toEqual([{ start: 2, end: 4 }]);
  });

  it('takes the function whose JSDoc the hunk is in', () => {
    const text = source('const a = 1;', '/** Two. */', 'function b() {', '}');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 2, end: 2 }]),
    ).toEqual([{ start: 2, end: 4 }]);
  });

  it('takes a method whose first line is the hunk, not the object around it', () => {
    const text = source(
      'export const handlers = {',
      '  run() {',
      '    void 0;',
      '  },',
      '};',
    );
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 2, end: 2 }]),
    ).toEqual([{ start: 2, end: 4 }]);
  });

  it('takes the arrow a closing brace ends, and not the line after it', () => {
    const text = source('run(() => {', '  void 0;', '}', ');');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 3, end: 3 }]),
    ).toEqual([{ start: 1, end: 3 }]);
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 4, end: 4 }]),
    ).toEqual([{ start: 1, end: 4 }]);
  });

  it('finds nothing for a blank line inside a function', () => {
    const text = source('function a() {', '  void 0;', '', '  void 1;', '}');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [{ start: 3, end: 3 }]),
    ).toEqual([]);
  });

  it('answers in source order whatever order the hunks come in', () => {
    const text = source('function a() {', '}', 'function b() {', '}');
    expect(
      enclosingSpans(ts, 'src/a.ts', text, [
        { start: 3, end: 3 },
        { start: 1, end: 1 },
      ]),
    ).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it('names each enclosing node once however many lines it holds', () => {
    expect(
      enclosingSpans(ts, 'src/a.ts', thirtyLineFunction, [
        { start: 10, end: 12 },
        { start: 20, end: 20 },
      ]),
    ).toEqual([{ start: 3, end: 31 }]);
  });
});
