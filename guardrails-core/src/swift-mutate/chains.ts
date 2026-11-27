import type { SwiftToken } from '../swift-lexer/index.js';
import { kindAt, textAt, type SwiftDocument } from './document.js';
import {
  canStartOperand,
  isAttached,
  isExpressionBoundary,
  isInfix,
  replaceRun,
  replaceUpTo,
  siblingsIn,
  type Mutator,
} from './syntax.js';
import { textIn } from './text.js';

/**
Where the chain element that ends at `index` starts: a bracketed group at its
opening bracket; a name, a `.`, or a postfix `?` or `!` at itself. Undefined
for anything else, and for a keyword an expression starts after, which is
never part of a chain however closely something follows it.
*/
function elementStart(
  document: SwiftDocument,
  index: number,
): number | undefined {
  const text = textAt(document, index);
  if ([')', ']'].includes(text)) {
    return document.partner.get(index);
  }
  const isName =
    kindAt(document, index) === 'identifier' && !isExpressionBoundary(text);
  return isName || ['.', '?', '!'].includes(text) ? index : undefined;
}

/**
The index of the first token of the postfix chain that ends at `end`: back
over names, member dots, postfix marks and bracketed groups for as long as
each is attached to the one before. `end + 1` when the token at `end` is not
part of a chain at all.

A chain is all on one line: the `.` that starts a continuation line is not
attached to anything.
*/
function chainStart(document: SwiftDocument, end: number): number {
  const start = elementStart(document, end);
  if (start === undefined) {
    return end + 1;
  }
  return isAttached(document, start) ? chainStart(document, start - 1) : start;
}

/**
True when the postfix chain that ends at `end` is an operand in its own
right: it starts with a name or a bracketed group, not with a `.` (an
implicit member, or the continuation line of a longer chain) or a mark.
*/
export function isOperandChain(document: SwiftDocument, end: number): boolean {
  const start = chainStart(document, end);
  return (
    kindAt(document, start) === 'identifier' ||
    ['(', '['].includes(textAt(document, start))
  );
}

/**
The postfix chain that ends at `end`, as a run of tokens.
*/
function chainEndingAt(document: SwiftDocument, end: number): SwiftToken[] {
  return document.tokens.slice(chainStart(document, end), end + 1);
}

/**
True when the run has an optional-chaining `?` at its top level.
*/
function hasOptionalLink(
  document: SwiftDocument,
  start: number,
  end: number,
): boolean {
  return siblingsIn(document, start, end).some((token) => token.text === '?');
}

/**
`a ?? b` reduced to `b`: the left operand, the operator and the space after
it removed.

The left operand is taken to be the postfix chain before the operator, which
it is only when nothing binds tighter than `??` to its left. So the chain
must stand where an expression starts: after an opening bracket, or after a
token an expression can start after, and not hard up against it.
*/
export const nilCoalescing: Mutator = (document, index, token) => {
  if (token.text !== '??' || !isInfix(document, index, token)) {
    return [];
  }
  const start = chainStart(document, index - 1);
  const before = textAt(document, start - 1);
  const isWholeOperand =
    isOperandChain(document, index - 1) &&
    canStartOperand(document, start) &&
    (isExpressionBoundary(before) || ['(', '[', '{'].includes(before));
  return isWholeOperand
    ? document.tokens
        .slice(index + 1, index + 2)
        .filter((next) => next.line === token.line)
        .flatMap((next) =>
          document.tokens
            .slice(start, start + 1)
            .map((first) => replaceUpTo(first, next, '')),
        )
    : [];
};

/**
`x.isEmpty` negated: `!x.isEmpty`.

Not when the chain has an optional link (`!` does not apply to the optional
that gives), and only where an operand may start, which rules out a chain
that is already negated or sits behind any other prefix operator.
*/
export const emptinessNegation: Mutator = (document, index, token) => {
  if (token.text !== 'isEmpty' || textAt(document, index - 1) !== '.') {
    return [];
  }
  const start = chainStart(document, index);
  const isNegatable =
    isOperandChain(document, index) &&
    canStartOperand(document, start) &&
    !hasOptionalLink(document, start, index);
  return isNegatable
    ? replaceRun(chainEndingAt(document, index), '').map((edit) => ({
        ...edit,
        replacement: `!${textIn(document.lines, edit.location)}`,
      }))
    : [];
};

/**
True when the token at `index` ends its statement: nothing follows, or a
closing brace, or a name on a later line. Anything else on a later line may
continue the expression (`.member`, `?? x`, `as? T`).
*/
function isStatementEnd(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): boolean {
  const next = document.tokens[index + 1];
  return (
    next === undefined ||
    next.text === '}' ||
    (next.line > token.line &&
      next.kind === 'identifier' &&
      !['as', 'is'].includes(next.text))
  );
}

/**
True when the chain that starts at `start` is all of what is returned, or all
of what is assigned to something whose type is already given. `let x = ...`,
`var x = ...` and a tuple pattern infer the type from the chain, and `nil`
gives them none.
*/
function isOptionalExpected(document: SwiftDocument, start: number): boolean {
  const before = textAt(document, start - 1);
  return (
    before === 'return' ||
    (before === '=' &&
      textAt(document, start - 2) !== ')' &&
      !['let', 'var'].includes(textAt(document, start - 3)))
  );
}

/**
An optional-chaining expression replaced by `nil`, where it is the whole of a
statement's value and an optional is certainly expected there.
*/
export const optionalChain: Mutator = (document, index, token) => {
  const start = chainStart(document, index);
  const isWholeValue =
    isStatementEnd(document, index, token) &&
    isOperandChain(document, index) &&
    isOptionalExpected(document, start) &&
    hasOptionalLink(document, start, index);
  return isWholeValue ? replaceRun(chainEndingAt(document, index), 'nil') : [];
};
