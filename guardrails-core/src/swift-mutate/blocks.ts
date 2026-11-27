import { lexSwift } from '../swift-lexer/index.js';
import type { SwiftDocument } from './document.js';
import {
  replaceRun,
  siblingAfter,
  siblingsIn,
  type Mutator,
} from './syntax.js';

/**
The value a function can return for a return type written as `type` (its
tokens joined, so without spaces), if this knows one: the literal of the
four basic types, `[]` for an array and `nil` for an optional, each only in
its plainest spelling. A dictionary is `[...]` too, and `[]` is not one.
*/
function valueOf(type: string): string | undefined {
  if (
    type.endsWith('?') ||
    (type.startsWith('Optional<') && type.endsWith('>'))
  ) {
    return 'nil';
  }
  const isArray =
    (type.startsWith('[') && type.endsWith(']') && !type.includes(':')) ||
    (type.startsWith('Array<') && type.endsWith('>'));
  return isArray
    ? '[]'
    : new Map([
        ['Bool', 'false'],
        ['Int', '0'],
        ['Double', '0'],
        ['String', '""'],
      ]).get(type);
}

/**
The body that replaces a function's, given where its signature's `->` and its
body's `{` are: empty when nothing is returned, else returning the value of
the return type. Undefined when that type has no known value, or is a
function type (a second `->` before the body).
*/
function emptyBody(
  document: SwiftDocument,
  arrow: number,
  open: number,
): string | undefined {
  if (arrow === open) {
    return '{}';
  }
  const end = siblingAfter(document, arrow, ['where', '{']);
  const type = document.tokens
    .slice(arrow + 1, end)
    .map((token) => token.text)
    .join('');
  if (['Void', '()'].includes(type)) {
    return '{}';
  }
  const value =
    siblingAfter(document, arrow, ['->', '{']) === open
      ? valueOf(type)
      : undefined;
  return value === undefined ? undefined : `{ return ${value} }`;
}

/**
True when the two token runs read the same, whatever their spacing.
*/
function isSameCode(one: readonly string[], other: readonly string[]): boolean {
  return one.join(' ') === other.join(' ');
}

/**
True when a declaration starts among the sibling tokens from `first` up to
`end`.
*/
function isDeclaredBefore(
  document: SwiftDocument,
  first: number,
  end: number,
): boolean {
  return siblingsIn(document, first, end).some((sibling) =>
    ['func', 'var', 'let', 'init', 'subscript'].includes(sibling.text),
  );
}

/**
The body of a `func` replaced by an empty one, or by one that returns the
plainest value of its return type.

The body is the first `{` after `func` that is its sibling, with its partner.
A requirement in a protocol has none, and the first sibling `{` after it is
some later member's: that is told by a declaration keyword in between. A
body that is already the replacement, comments and spacing aside, is left.
*/
export const blockStatement: Mutator = (document, index, token) => {
  if (token.text !== 'func') {
    return [];
  }
  const open = siblingAfter(document, index, ['{']);
  // No body: no `{`, so no partner, and the run from -1 up to 0 is empty.
  const close = document.partner.get(open) ?? -1;
  if (isDeclaredBefore(document, index + 1, open)) {
    return [];
  }
  const arrow = siblingAfter(document, index, ['->', '{']);
  const replacement = emptyBody(document, arrow, open);
  const body = document.tokens.slice(open, close + 1);
  return replacement === undefined ||
    isSameCode(
      body.map((part) => part.text),
      lexSwift(replacement).map((part) => part.text),
    )
    ? []
    : replaceRun(body, replacement);
};
