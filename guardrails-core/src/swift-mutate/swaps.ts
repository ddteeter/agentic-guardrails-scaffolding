import type { SwiftToken } from '../swift-lexer/index.js';
import { textAt, type SwiftDocument } from './document.js';
import type { Swap } from './swap-tables.js';
import {
  expressionStart,
  isCaseValue,
  isExpressionBoundary,
  isInfix,
  isPrefix,
  replaceToken,
  siblingsIn,
  type Mutator,
} from './syntax.js';

type Guard = (document: SwiftDocument, index: number) => boolean;

/**
An operator that swaps one infix operator for another, by the table given
(see `swap-tables.ts`), unless the guard says the place is not safe.
*/
export function swapInfix(swaps: readonly Swap[], isUnsafe?: Guard): Mutator {
  return (document, index, token) => {
    const replacement = swaps.find(([from]) => from === token.text)?.[1];
    return replacement === undefined ||
      !isInfix(document, index, token) ||
      isUnsafe?.(document, index)
      ? []
      : [replaceToken(token, replacement)];
  };
}

function isCapitalised(text: string): boolean {
  return /^\p{Lu}/u.test(text);
}

/**
True for an `==` between two capitalised names: as likely a same-type
constraint (`where Element == Int`) as a comparison, and `!=` is not a
constraint.
*/
export function isTypeConstraint(
  document: SwiftDocument,
  index: number,
): boolean {
  return (
    isCapitalised(textAt(document, index - 1)) &&
    isCapitalised(textAt(document, index + 1))
  );
}

/**
True when a string literal is among the tokens up to the first one an
expression can start after: the tokens are the top level of what follows in
an expression, and that token is where the next one begins.
*/
function hasStringOperand(run: readonly SwiftToken[]): boolean {
  // The `=` at the end is there to be found when nothing else is.
  const end = [...run.map((token) => token.text), '='].findIndex((text) =>
    isExpressionBoundary(text),
  );
  return run.slice(0, end).some((token) => token.kind === 'string');
}

/**
True for an arithmetic operator in an expression that has a string literal
as an operand, or with an array literal after it: `+` concatenates those,
and no other operator in its place compiles. Only literals show this; two
strings held in variables look like two numbers.
*/
export function isConcatenation(
  document: SwiftDocument,
  index: number,
): boolean {
  const expression = siblingsIn(
    document,
    expressionStart(document, index),
    document.tokens.length,
  );
  return textAt(document, index + 1) === '[' || hasStringOperand(expression);
}

/**
The same for a compound assignment, whose expression is what follows it.
*/
export function isAppending(document: SwiftDocument, index: number): boolean {
  const assigned = siblingsIn(document, index + 1, document.tokens.length);
  return textAt(document, index + 1) === '[' || hasStringOperand(assigned);
}

/**
`true` and `false` swapped, and a prefix `!` removed.
*/
export const booleanLiteral: Mutator = (document, index, token) => {
  const flipped = new Map([
    ['true', 'false'],
    ['false', 'true'],
    ['!', ''],
  ]).get(token.text);
  return flipped === undefined ||
    (token.text === '!' && !isPrefix(document, index, token))
    ? []
    : [replaceToken(token, flipped)];
};

/**
A prefix `-` removed, except from an enum's raw value.
*/
export const unaryOperator: Mutator = (document, index, token) =>
  token.text === '-' &&
  isPrefix(document, index, token) &&
  !isCaseValue(document, index, token)
    ? [replaceToken(token, '')]
    : [];

/**
The value one above a decimal integer's, except that 1 goes down to 0.
*/
function stepped(digits: string): string {
  const value = BigInt(digits.replaceAll('_', ''));
  return value === 1n ? '0' : String(value + 1n);
}

/**
A decimal integer literal stepped by one. Not a tuple index (`t.0`), whose
neighbour may not exist, and not an enum's raw value, negative or not.
*/
export const integerLiteral: Mutator = (document, index, token) => {
  const isOperand =
    /^\d[\d_]*$/.test(token.text) &&
    textAt(document, index - 1) !== '.' &&
    !isCaseValue(document, index, token) &&
    !(
      textAt(document, index - 1) === '-' &&
      isCaseValue(document, index - 1, token)
    );
  return isOperand ? [replaceToken(token, stepped(token.text))] : [];
};
