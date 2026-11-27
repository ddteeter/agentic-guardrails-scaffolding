/**
 * Which infix operator each swap operator turns into which: data, and
 * nothing else. Each entry is one direction, `[from, to]`, so a one-way swap
 * (`%` to `*`, never back) is written as plainly as a two-way one, and so
 * each direction is its own array literal: mutation testing empties them
 * one at a time, and a direction no test asserts survives.
 *
 * One function per table, each returning a fresh list: nothing here runs
 * when the module loads, and tables this small, each in its own function,
 * are not long enough to read as duplicated code to the `dupes` analyzer.
 */

/**
One direction of a swap: the operator as written, and what replaces it.
*/
export type Swap = readonly [from: string, to: string];

export function equalitySwaps(): readonly Swap[] {
  return [
    ['==', '!='],
    ['!=', '=='],
    ['===', '!=='],
    ['!==', '==='],
  ];
}

export function relationalBoundarySwaps(): readonly Swap[] {
  return [
    ['<', '<='],
    ['<=', '<'],
    ['>', '>='],
    ['>=', '>'],
  ];
}

export function relationalNegationSwaps(): readonly Swap[] {
  return [
    ['<', '>='],
    ['>=', '<'],
    ['>', '<='],
    ['<=', '>'],
  ];
}

export function logicalSwaps(): readonly Swap[] {
  return [
    ['&&', '||'],
    ['||', '&&'],
  ];
}

export function arithmeticSwaps(): readonly Swap[] {
  return [
    ['+', '-'],
    ['-', '+'],
    ['*', '/'],
    ['/', '*'],
    ['%', '*'],
  ];
}

export function assignmentSwaps(): readonly Swap[] {
  return [
    ['+=', '-='],
    ['-=', '+='],
    ['*=', '/='],
    ['/=', '*='],
  ];
}
