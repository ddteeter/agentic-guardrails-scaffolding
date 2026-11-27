import type { SwiftToken } from '../swift-lexer/index.js';
import { textAt, type SwiftDocument } from './document.js';
import {
  expressionStart,
  isInfix,
  replaceRun,
  siblingAfter,
  siblingsIn,
  type Mutator,
} from './syntax.js';
import { textIn } from './text.js';
import type { Edit } from './types.js';

type Rewrite = (run: readonly SwiftToken[]) => readonly Edit[];

/**
The edits `rewrite` makes of the condition that is the tokens from `first` up
to `end`, when a Boolean expression can stand in for it: at its top level
there is no comma, no binding, no pattern and no availability check
(replacing any of those does not compile), and no `try` or `await` (whose
call the replacement would drop).
*/
function rewriteCondition(
  document: SwiftDocument,
  first: number,
  end: number,
  rewrite: Rewrite,
): readonly Edit[] {
  const isReplaceable = siblingsIn(document, first, end).every(
    (token) =>
      ![',', 'let', 'var', 'case', '#', 'try', 'await'].includes(token.text),
  );
  return isReplaceable ? rewrite(document.tokens.slice(first, end)) : [];
}

/**
The edits `rewrite` makes of the condition after the keyword at `index`: the
tokens between it and the first sibling token whose text is `closer`. With
no closer the run is the one from the keyword up to 0, which is empty.
*/
function rewriteConditionAfter(
  document: SwiftDocument,
  index: number,
  closer: string,
  rewrite: Rewrite,
): readonly Edit[] {
  const end = Math.max(siblingAfter(document, index, [closer]), 0);
  return rewriteCondition(document, index + 1, end, rewrite);
}

/**
True for the `while` that ends a `repeat { ... }`: no brace follows its
condition, so where the condition ends is not known.
*/
function isRepeatWhile(document: SwiftDocument, index: number): boolean {
  const opener = document.partner.get(index - 1) ?? 0;
  return textAt(document, opener - 1) === 'repeat';
}

/**
`true` and `false` in place of the run.
*/
function bothWays(run: readonly SwiftToken[]): Edit[] {
  return ['true', 'false'].flatMap((value) => replaceRun(run, value));
}

/**
The condition of the ternary whose `?` is `mark`, at `index`, replaced both
ways. The condition is the tokens back to the nearest sibling an expression
can start after, or to the bracket around them. Nothing unless that boundary
is on the `?`'s own line, and nothing when a `?` is among the tokens: an
outer ternary's, or an optional chain's, and with either the boundary found
may not be this condition's.
*/
function ternary(
  document: SwiftDocument,
  index: number,
  mark: SwiftToken,
): readonly Edit[] {
  const first = expressionStart(document, index);
  const isOnLine = document.tokens[first - 1]?.line === mark.line;
  const hasMark = siblingsIn(document, first, index).some(
    (token) => token.text === '?',
  );
  return isOnLine && !hasMark
    ? rewriteCondition(document, first, index, bothWays)
    : [];
}

/**
The condition of an `if`, a `while` or a ternary, replaced by `true` and by
`false`.
*/
export const conditionalExpression: Mutator = (document, index, token) => {
  if (token.text === '?' && isInfix(document, index, token)) {
    return ternary(document, index, token);
  }
  return ['if', 'while'].includes(token.text) && !isRepeatWhile(document, index)
    ? rewriteConditionAfter(document, index, '{', bothWays)
    : [];
};

/**
The condition of a `guard`, negated.
*/
export const guardNegation: Mutator = (document, index, token) =>
  token.text === 'guard'
    ? rewriteConditionAfter(document, index, 'else', (run) =>
        replaceRun(run, '').map((edit) => ({
          ...edit,
          replacement: `!(${textIn(document.lines, edit.location)})`,
        })),
      )
    : [];
