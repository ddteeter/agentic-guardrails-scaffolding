import { lexSwiftLine } from './line.js';
import { SWIFT_INITIAL_STATE, type SwiftLexState } from './state.js';
import { isSignificant, type SwiftToken } from './tokens.js';

interface SourceLex {
  readonly tokens: SwiftToken[];
  readonly state: SwiftLexState;
}

/**
Lex consecutive lines from the top of a file, threading the state and the
last significant token from each line into the next.

Lines are split on `\n` alone: the `\r` of a CRLF ending stays on its line,
where the lexer reads it as the whitespace it is.
*/
function lexLines(lines: readonly string[]): SourceLex {
  const tokens: SwiftToken[] = [];
  let state = SWIFT_INITIAL_STATE;
  let previous: SwiftToken | undefined;
  for (const [index, text] of lines.entries()) {
    const lexed = lexSwiftLine(text, state, index + 1, previous);
    tokens.push(...lexed.tokens);
    state = lexed.state;
    previous =
      lexed.tokens.findLast((token) => isSignificant(token)) ?? previous;
  }
  return { tokens, state };
}

/**
Lex a whole Swift source into its tokens, in order, with absolute positions.
*/
export function lexSwift(source: string): SwiftToken[] {
  return lexLines(source.split('\n')).tokens;
}

/**
The state the 1-indexed `line` of `source` starts in: what to hand
`lexSwiftLine` when lexing begins there instead of at the top, as it does for
a diff hunk that opens inside a multi-line comment or string. A line past
the end gets the state the source ends in.
*/
export function swiftStateAtLine(source: string, line: number): SwiftLexState {
  return lexLines(source.split('\n').slice(0, line - 1)).state;
}
