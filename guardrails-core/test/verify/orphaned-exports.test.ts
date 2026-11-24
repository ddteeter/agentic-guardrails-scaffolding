/**
 * `orphanedExportSpans` (#196): the declarations of the exports a change may
 * have stopped calling, so their now-uncovered mutants are in range.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { orphanedExportSpans } from '../../src/verify/enclosing-spans.js';

function source(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const callee = source(
  "import { other } from './other.js';",
  '',
  '/**',
  ' * Doubles a value.',
  ' */',
  'export function callee(value: number): number {',
  '  return other(value) * 2;',
  '}',
  '',
  'export function kept(): number {',
  '  return 1;',
  '}',
);

describe('orphanedExportSpans', () => {
  it('takes the whole declaration of an export whose name was removed', () => {
    expect(
      orphanedExportSpans(ts, 'src/callee.ts', callee, new Set(['callee'])),
    ).toEqual([{ start: 3, end: 8 }]);
  });

  it('takes nothing for an export whose name was not removed', () => {
    expect(
      orphanedExportSpans(ts, 'src/callee.ts', callee, new Set(['unrelated'])),
    ).toEqual([]);
  });

  it('takes an exported class and an exported variable statement', () => {
    const text = source(
      'export class Store {',
      '  size = 0;',
      '}',
      'export const first = 1,',
      '  second = 2;',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['Store', 'second'])),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  it('resolves `export { a }` to the local declaration', () => {
    const text = source(
      'function helper(): number {',
      '  return 1;',
      '}',
      'const unrelated = 2;',
      'export { helper, unrelated as renamed };',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['helper'])),
    ).toEqual([{ start: 1, end: 3 }]);
  });

  it('resolves a renamed export by its exported name', () => {
    const text = source(
      'const local = (): number => 2;',
      'export { local as renamed };',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['renamed'])),
    ).toEqual([{ start: 1, end: 1 }]);
  });

  it('takes nothing for a local that is not exported', () => {
    const text = source(
      'function helper(): number {',
      '  return 1;',
      '}',
      'export const used = helper();',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['helper'])),
    ).toEqual([]);
  });

  it('leaves a default export and a re-export out', () => {
    const text = source(
      'export default function helper(): number {',
      '  return 1;',
      '}',
      "export { other } from './other.js';",
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['helper', 'other'])),
    ).toEqual([]);
  });

  it('resolves a renamed export by its local name', () => {
    const text = source(
      'const local = (): number => 2;',
      'export { local as renamed };',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['local'])),
    ).toEqual([{ start: 1, end: 1 }]);
  });

  it('takes an export with other modifiers too', () => {
    const text = source('export async function load(): Promise<void> {', '}');
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['load'])),
    ).toEqual([{ start: 1, end: 2 }]);
  });

  it('takes nothing for a local with modifiers that are not export', () => {
    const text = source(
      'async function load(): Promise<void> {',
      '}',
      'export const used = load();',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['load'])),
    ).toEqual([]);
  });

  it('does not take a re-export for a local of the same name', () => {
    const text = source(
      'function other(): number {',
      '  return 1;',
      '}',
      "export { other } from './other.js';",
      'export const used = other();',
    );
    expect(
      orphanedExportSpans(ts, 'src/a.ts', text, new Set(['other'])),
    ).toEqual([]);
  });

  it('leaves out an anonymous default export, a type and a destructured export', () => {
    const text = source(
      'export default function (): number {',
      '  return 1;',
      '}',
      'export interface Shape {',
      '  size: number;',
      '}',
      'export type Alias = Shape;',
      'export const { picked } = { picked: 1 };',
    );
    expect(
      orphanedExportSpans(
        ts,
        'src/a.ts',
        text,
        new Set(['Shape', 'Alias', 'picked', 'default']),
      ),
    ).toEqual([]);
  });

  it('takes nothing from a file typescript cannot parse', () => {
    expect(
      orphanedExportSpans(
        ts,
        'src/a.vue',
        'export function a() {}\n',
        new Set(['a']),
      ),
    ).toEqual([]);
  });
});
