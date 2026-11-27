/**
What a span of Swift source is.

`identifier`, `number`, `operator` and `punctuation` are CODE. `string`,
`regex` and `comment` are opaque: their text is never scanned for code.
*/
export type SwiftTokenKind =
  | 'identifier'
  | 'number'
  | 'operator'
  | 'punctuation'
  | 'string'
  | 'regex'
  | 'comment';

/**
One lexed span. A token never crosses a line break: a multi-line comment or
string yields one token per line it touches.
*/
export interface SwiftToken {
  readonly kind: SwiftTokenKind;
  /**
  The exact source text of the span.
  */
  readonly text: string;
  /**
  1-indexed line of the first character.
  */
  readonly line: number;
  /**
  1-indexed column (UTF-16 code unit) of the first character.
  */
  readonly column: number;
  /**
  Always equal to `line`: tokens are single-line.
  */
  readonly endLine: number;
  /**
  1-indexed column just past the last character (exclusive).
  */
  readonly endColumn: number;
  /**
  0 in ordinary code, n inside n nested string interpolations. The `(` and
  `)` of an interpolation count as inside it; the string tokens around them
  have the depth of the literal they belong to.
  */
  readonly interpolationDepth: number;
  /**
  Whitespace, or the start of the line, is directly before the token. This
  is the raw character test: an abutting comment or bracket is not
  whitespace here, though Swift treats both as such when it binds operators.
  */
  readonly hasSpaceBefore: boolean;
  /**
  Whitespace, or the end of the line, is directly after the token.
  */
  readonly hasSpaceAfter: boolean;
  /**
  The nearest earlier token that is not a comment, if any. It may be on an
  earlier line. Note what this makes of a token: a link in a chain back to
  the first one, so print or serialise its fields, not the token whole.
  */
  readonly previous: SwiftToken | undefined;
}

/**
Everything but a comment is significant: it can be the operand or operator
that decides how the next token reads.
*/
export function isSignificant(token: SwiftToken): boolean {
  return token.kind !== 'comment';
}

/**
True for whitespace and for the empty string `charAt` returns off either end
of a line.
*/
export function isBoundary(neighbour: string): boolean {
  return neighbour.trim() === '';
}
