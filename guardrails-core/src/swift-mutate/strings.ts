import type { SwiftToken } from '../swift-lexer/index.js';
import type { SwiftDocument } from './document.js';
import { isCaseValue, replaceTokens, type Mutator } from './syntax.js';

/**
How many interpolations deep the token at `index` is; 0 off either end.
*/
function depthAt(document: SwiftDocument, index: number): number {
  return document.tokens[index]?.interpolationDepth ?? 0;
}

/**
True for the string token that opens a single-line, non-raw literal.

The lexer gives a literal one string token per run of text, so three kinds of
string token are not an opening: one that starts with `"""` or a `#` (a
multi-line or raw literal, left alone), one that resumes a literal after an
interpolation (the token before it is deeper), and one that continues a
multi-line string from the line above (it starts a line that starts in
string text, and such a token always starts at column 1).
*/
function isLiteralStart(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): boolean {
  return (
    token.text.startsWith('"') &&
    !token.text.startsWith('"""') &&
    depthAt(document, index - 1) <= token.interpolationDepth &&
    !(document.stringLines.has(token.line) && token.column === 1)
  );
}

/**
The string token that closes the literal of which `token`, at `index`, is a
run of text: itself, unless an interpolation opens after it (the next token
is deeper), in which case the search goes on from the token that comes back
out of the interpolation. A single-line literal that does not come back out
on its own line is unterminated, and has no end.
*/
function literalEnd(
  document: SwiftDocument,
  index: number,
  token: SwiftToken,
): SwiftToken | undefined {
  if (depthAt(document, index + 1) <= token.interpolationDepth) {
    return token;
  }
  const resume = document.tokens.findIndex(
    (later, at) =>
      at > index && later.interpolationDepth <= token.interpolationDepth,
  );
  const next = document.tokens[resume];
  return next?.line === token.line
    ? literalEnd(document, resume, next)
    : undefined;
}

/**
A single-line string literal, interpolations and all, emptied; an empty one
filled. Not an enum's raw value: two emptied raw values do not compile.
*/
export const stringLiteral: Mutator = (document, index, token) => {
  if (
    !isLiteralStart(document, index, token) ||
    isCaseValue(document, index, token)
  ) {
    return [];
  }
  const last = literalEnd(document, index, token);
  const replacement = token.text === '""' ? '"Stryker was here!"' : '""';
  return last === undefined ? [] : [replaceTokens(token, last, replacement)];
};
