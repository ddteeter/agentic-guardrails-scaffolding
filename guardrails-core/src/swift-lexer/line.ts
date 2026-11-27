import { canRegexFollow, lexAtom, matchAt } from './atoms.js';
import { commentContent, scanBlockComment } from './comments.js';
import {
  afterCodeToken,
  atEndOfLine,
  interpolationDepth,
  popFrame,
  type SwiftLexFrame,
  type SwiftLexState,
} from './state.js';
import {
  stringEventPattern,
  stringFrame,
  stringOpenerPattern,
  type StringFrame,
} from './strings.js';
import {
  isBoundary,
  isSignificant,
  type SwiftToken,
  type SwiftTokenKind,
} from './tokens.js';

/**
What one line lexes to.
*/
export interface SwiftLineLex {
  /**
  Every non-whitespace span of the line, in order.
  */
  readonly tokens: readonly SwiftToken[];
  /**
  The trimmed content of each comment token, in order, without delimiters or
  doc-comment markers: `x` for `// x`, `/// x`, `/* x *\/`, and for the
  ` * x` line of a block comment that started on an earlier line.
  */
  readonly comments: readonly string[];
  /**
  The line with its comment, string and regex tokens cut out and everything
  else, spacing included, as written. The code of a string interpolation
  stays, in its parentheses: `print("a \(x) b")` gives `print((x))`.
  */
  readonly code: string;
  /**
  The state the next line starts in.
  */
  readonly state: SwiftLexState;
}

interface Cursor {
  readonly text: string;
  readonly line: number;
  readonly before: SwiftToken | undefined;
  readonly tokens: SwiftToken[];
  index: number;
  frames: SwiftLexState;
}

type CommentFrame = Extract<SwiftLexFrame, { kind: 'comment' }>;

/**
Emit the span from the cursor up to `end` as one token and move past it.
*/
function emitTo(cursor: Cursor, kind: SwiftTokenKind, end: number): void {
  cursor.tokens.push({
    kind,
    text: cursor.text.slice(cursor.index, end),
    line: cursor.line,
    column: cursor.index + 1,
    endLine: cursor.line,
    endColumn: end + 1,
    interpolationDepth: interpolationDepth(cursor.frames),
    hasSpaceBefore: isBoundary(cursor.text.charAt(cursor.index - 1)),
    hasSpaceAfter: isBoundary(cursor.text.charAt(end)),
    previous:
      cursor.tokens.findLast((token) => isSignificant(token)) ?? cursor.before,
  });
  cursor.index = end;
}

/**
The cursor is in a block comment: everything up to where it closes, or the
rest of the line, is one comment token.
*/
function lexBlockComment(cursor: Cursor, frame: CommentFrame): void {
  const scan = scanBlockComment(cursor.text, cursor.index, frame.depth);
  const below = popFrame(cursor.frames);
  emitTo(cursor, 'comment', scan.closedAt ?? cursor.text.length);
  cursor.frames =
    scan.depth === 0
      ? below
      : [...below, { kind: 'comment', depth: scan.depth }];
}

/**
The cursor is in the string `frame`, whose text is scanned from `from` (past
the opening delimiter when the cursor is on one). The text up to whatever
ends it is one string token, and that token takes the delimiters with it:
the opening and closing quotes, and the backslash of an interpolation. The
interpolation's `(` is left for the code lexer, so it and its matching `)`
are ordinary punctuation tokens.
*/
function lexString(cursor: Cursor, frame: StringFrame, from: number): void {
  const run = matchAt(stringEventPattern(frame), cursor.text, from);
  if (run === undefined) {
    emitTo(cursor, 'string', cursor.text.length);
    return;
  }
  const end = from + run.length;
  if (run.endsWith('(')) {
    emitTo(cursor, 'string', end - 1);
    // 0 parentheses, cursor on the `(`: lexing it as code makes it 1.
    cursor.frames = [...cursor.frames, { kind: 'interpolation', parens: 0 }];
    return;
  }
  emitTo(cursor, 'string', end);
  cursor.frames = popFrame(cursor.frames);
}

/**
The cursor is in code: skip one whitespace character, enter a block comment
or a string, or lex one atom.
*/
function lexCode(cursor: Cursor): void {
  const { text, index } = cursor;
  if (isBoundary(text.charAt(index))) {
    cursor.index += 1;
    return;
  }
  if (text.startsWith('/*', index)) {
    // Depth 0, cursor still on the `/*`: the comment scan counts it as its
    // first opener, so opening and continuing a comment are one code path.
    cursor.frames = [...cursor.frames, { kind: 'comment', depth: 0 }];
    return;
  }
  const opener = matchAt(stringOpenerPattern(), text, index);
  if (opener !== undefined) {
    const frame = stringFrame(opener);
    cursor.frames = [...cursor.frames, frame];
    lexString(cursor, frame, index + opener.length);
    return;
  }
  const last = cursor.tokens.findLast((token) => isSignificant(token));
  const atom = lexAtom(text, index, canRegexFollow(last?.text));
  emitTo(cursor, atom.kind, index + atom.text.length);
  cursor.frames = afterCodeToken(cursor.frames, atom.text);
}

function step(cursor: Cursor): void {
  const frame = cursor.frames.at(-1);
  if (frame?.kind === 'comment') {
    lexBlockComment(cursor, frame);
    return;
  }
  if (frame?.kind === 'string') {
    lexString(cursor, frame, cursor.index);
    return;
  }
  lexCode(cursor);
}

function isOpaque(token: SwiftToken): boolean {
  return ['string', 'regex', 'comment'].includes(token.kind);
}

/**
The line with every opaque span cut out. Cutting from the right keeps the
columns of the spans still to cut valid.
*/
function codeOf(text: string, tokens: readonly SwiftToken[]): string {
  return tokens
    .filter((token) => isOpaque(token))
    .reduceRight(
      (code, token) =>
        code.slice(0, token.column - 1) + code.slice(token.endColumn - 1),
      text,
    );
}

/**
Lex one line of Swift (no line break in `text`), starting in `state`.

`line` is the 1-indexed number its tokens are given, and `previous` the last
significant token before the line, which the line's first token links to.
Both are for lexing a file line by line; a caller with one line in hand can
leave them out.
*/
export function lexSwiftLine(
  text: string,
  state: SwiftLexState,
  line = 1,
  previous?: SwiftToken,
): SwiftLineLex {
  const cursor: Cursor = {
    text,
    line,
    before: previous,
    tokens: [],
    index: 0,
    frames: state,
  };
  while (cursor.index !== text.length) {
    step(cursor);
  }
  return {
    tokens: cursor.tokens,
    comments: cursor.tokens
      .filter((token) => token.kind === 'comment')
      .map((token) => commentContent(token.text)),
    code: codeOf(text, cursor.tokens),
    state: atEndOfLine(cursor.frames),
  };
}
