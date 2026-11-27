import type { SwiftToken } from '../swift-lexer/index.js';
import { leaderOf, textAt, type SwiftDocument } from './document.js';
import type { Edit, Position } from './types.js';

/**
What an operator is: given a token of the document, the edits it makes
there. Most tokens are none of an operator's business and get no edits.
*/
export type Mutator = (
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
) => readonly Edit[];

function startOf(token: SwiftToken): Position {
  return { line: token.line, column: token.column };
}

function endOf(token: SwiftToken): Position {
  return { line: token.endLine, column: token.endColumn };
}

/**
The edit that replaces everything from the start of `first` to the end of
`last`.
*/
export function replaceTokens(
  first: SwiftToken,
  last: SwiftToken,
  replacement: string,
): Edit {
  return { location: { start: startOf(first), end: endOf(last) }, replacement };
}

/**
The edit that replaces everything from the start of `first` up to the start
of `next`, the whitespace between them included.
*/
export function replaceUpTo(
  first: SwiftToken,
  next: SwiftToken,
  replacement: string,
): Edit {
  return {
    location: { start: startOf(first), end: startOf(next) },
    replacement,
  };
}

/**
The edit that replaces one token.
*/
export function replaceToken(token: SwiftToken, replacement: string): Edit {
  return replaceTokens(token, token, replacement);
}

/**
True for an operator token used as a binary operator, as far as a lexer can
tell: whitespace (or a line boundary) on both sides, which is how Swift
itself tells infix from prefix and postfix. An operator being declared
(`static func == (...)`, `infix operator ==`) is spaced the same way and is
not one.
*/
export function isInfix(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): boolean {
  return (
    token.hasSpaceBefore &&
    token.hasSpaceAfter &&
    !['func', 'operator'].includes(textAt(document, index - 1))
  );
}

/**
True when there is a token at `index` and nothing, not even whitespace,
between it and what is before it.
*/
export function isAttached(document: SwiftDocument, index: number): boolean {
  return document.tokens[index]?.hasSpaceBefore === false;
}

/**
True when an operand may start at `index`: after whitespace, or after what
Swift counts as whitespace before an operator, an opening bracket, a comma
or a colon.
*/
export function canStartOperand(
  document: SwiftDocument,
  index: number,
): boolean {
  return (
    !isAttached(document, index) ||
    ['(', '[', '{', ',', ':'].includes(textAt(document, index - 1))
  );
}

/**
True for an operator token used as a prefix operator: it stands where an
operand may start, with its operand directly after it. The postfix `!` of
`x!.y` does not.
*/
export function isPrefix(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): boolean {
  return !token.hasSpaceAfter && canStartOperand(document, index);
}

/**
The tokens an expression can start directly after, besides an opening
bracket: an assignment, a separator, and the keywords that take one.
*/
export function isExpressionBoundary(text: string): boolean {
  return [
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    ',',
    ':',
    'return',
    'throw',
    'in',
    'if',
    'while',
    'guard',
    'switch',
    'where',
    'else',
  ].includes(text);
}

/**
The index of the first token of the expression the token at `index` is in:
the one after the nearest earlier sibling an expression can start after, or
after the bracket around it; 0 when there is neither.
*/
export function expressionStart(
  document: SwiftDocument,
  index: number,
): number {
  const boundary = document.tokens
    .slice(0, index)
    .findLastIndex(
      (token, at) =>
        at === document.enclosing[index] ||
        (document.enclosing[at] === document.enclosing[index] &&
          isExpressionBoundary(token.text)),
    );
  return boundary + 1;
}

/**
The edits (none or one) that replace a run of tokens, from the start of its
first to the end of its last. An empty run gets none.
*/
export function replaceRun(
  run: readonly SwiftToken[],
  replacement: string,
): Edit[] {
  return run
    .slice(0, 1)
    .flatMap((first) =>
      run.slice(-1).map((last) => replaceTokens(first, last, replacement)),
    );
}

/**
The index of the first token after `index` that is its sibling -- inside the
same brackets, and inside no others -- and has one of the texts; -1 if none.
*/
export function siblingAfter(
  document: SwiftDocument,
  index: number,
  texts: readonly string[],
): number {
  return document.tokens.findIndex(
    (token, at) =>
      at > index &&
      document.enclosing[at] === document.enclosing[index] &&
      texts.includes(token.text),
  );
}

/**
The tokens from `first` up to, not including, `end` that are siblings of the
first: the top level of that run, without what is inside its brackets.
*/
export function siblingsIn(
  document: SwiftDocument,
  first: number,
  end: number,
): SwiftToken[] {
  const parents = document.enclosing.slice(first, end);
  return document.tokens
    .slice(first, end)
    .filter((_, offset) => parents[offset] === parents[0]);
}

/**
True when the token at `index` is directly after the `=` of a `case` line:
the position of an enum's raw value, where two values mutated to the same
thing do not compile. Any `=` on a line that starts with `case` counts, so a
`case .a: x = 1` in a switch is passed over too.
*/
export function isCaseValue(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): boolean {
  return (
    textAt(document, index - 1) === '=' && leaderOf(document, token) === 'case'
  );
}

/**
True when the bracket at `index` opens the arguments of an attribute or of a
`#` directive or macro: a `(` two tokens after the `@` or `#`.
*/
function isArgumentList(document: SwiftDocument, index: number): boolean {
  return (
    textAt(document, index) === '(' &&
    ['@', '#'].includes(textAt(document, index - 2))
  );
}

/**
True when some bracket around the token at `index` opens such arguments.
*/
function isInArguments(document: SwiftDocument, index: number): boolean {
  const opener = document.enclosing[index];
  if (opener === undefined) {
    return false;
  }
  return isArgumentList(document, opener) || isInArguments(document, opener);
}

/**
False where no operator mutates anything: on an `import` line, on a line that
starts with `#` (a compiler directive, or a macro), and inside the arguments
of an attribute, directive or macro. A change there either does not compile
or tests nothing.
*/
export function isMutationPoint(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): boolean {
  return (
    !['#', 'import'].includes(leaderOf(document, token)) &&
    !isInArguments(document, index)
  );
}
