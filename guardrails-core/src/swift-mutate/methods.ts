import { isOperandChain } from './chains.js';
import { textAt, type SwiftDocument } from './document.js';
import {
  isAttached,
  replaceToken,
  replaceTokens,
  replaceUpTo,
  type Mutator,
} from './syntax.js';

/**
True when the name at `index` is called: its `(` directly after it.
*/
function isCalled(document: SwiftDocument, index: number): boolean {
  return isAttached(document, index + 1) && textAt(document, index + 1) === '(';
}

/**
True when the name at `index` is a member: a `.` before it.
*/
function isMember(document: SwiftDocument, index: number): boolean {
  return textAt(document, index - 1) === '.';
}

/**
`min` and `max` swapped, as a method or as the free function, wherever the
name is called and not being declared.
*/
function swapCall(replacement: string): Mutator {
  return (document, index, token) =>
    isCalled(document, index) &&
    !['func', 'case'].includes(textAt(document, index - 1))
      ? [replaceToken(token, replacement)]
      : [];
}

/**
`first` and `last` swapped, as properties of something: the name must end a
postfix chain that has a base, since a bare `.first` may be an enum case
with no `.last` beside it. Followed by `(` or `{` it is `first(where:)`,
another method.
*/
function swapProperty(replacement: string): Mutator {
  return (document, index, token) =>
    isMember(document, index) &&
    isOperandChain(document, index) &&
    !['(', '{'].includes(textAt(document, index + 1))
      ? [replaceToken(token, replacement)]
      : [];
}

/**
`prefix(n)` and `suffix(n)` swapped. A labelled argument (`prefix(while:)`,
`suffix(from:)`) has no counterpart on the other side.
*/
function swapSlice(replacement: string): Mutator {
  return (document, index, token) =>
    isMember(document, index) &&
    isCalled(document, index) &&
    textAt(document, index + 3) !== ':'
      ? [replaceToken(token, replacement)]
      : [];
}

/**
`.allSatisfy { ... }` to `.contains { ... }`, and `.allSatisfy(p)` to
`.contains(where: p)`.
*/
const allSatisfy: Mutator = (document, index, token) => {
  if (!isMember(document, index)) {
    return [];
  }
  if (textAt(document, index + 1) === '{') {
    return [replaceToken(token, 'contains')];
  }
  return document.tokens
    .slice(index + 1, index + 2)
    .filter(() => isCalled(document, index))
    .map((paren) => replaceTokens(token, paren, 'contains(where: '));
};

/**
`.contains { ... }` to `.allSatisfy { ... }`, and `.contains(where: p)` to
`.allSatisfy(p)`. Never `.contains(x)`, which asks about an element.
*/
const contains: Mutator = (document, index, token) => {
  if (!isMember(document, index)) {
    return [];
  }
  if (textAt(document, index + 1) === '{') {
    return [replaceToken(token, 'allSatisfy')];
  }
  const isPredicateCall =
    isCalled(document, index) &&
    textAt(document, index + 2) === 'where' &&
    textAt(document, index + 3) === ':';
  return document.tokens
    .slice(index + 4, index + 5)
    .filter((argument) => isPredicateCall && argument.line === token.line)
    .map((argument) => replaceUpTo(token, argument, 'allSatisfy('));
};

function swaps(): Map<string, Mutator> {
  return new Map([
    ['min', swapCall('max')],
    ['max', swapCall('min')],
    ['first', swapProperty('last')],
    ['last', swapProperty('first')],
    ['prefix', swapSlice('suffix')],
    ['suffix', swapSlice('prefix')],
    ['allSatisfy', allSatisfy],
    ['contains', contains],
  ]);
}

/**
A method swapped for its opposite.
*/
export const methodSwap: Mutator = (document, index, token) =>
  swaps().get(token.text)?.(document, index, token) ?? [];
