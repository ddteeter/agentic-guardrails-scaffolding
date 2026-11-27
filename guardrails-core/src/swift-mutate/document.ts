import {
  lexSwiftLine,
  SWIFT_INITIAL_STATE,
  type SwiftLineLex,
  type SwiftToken,
  type SwiftTokenKind,
} from '../swift-lexer/index.js';
import { parseDirective, type Directive } from './directive.js';

/**
A Swift source, lexed and indexed for the operators to look around in.
*/
export interface SwiftDocument {
  readonly lines: readonly string[];
  /**
  Every token but the comments, in order. An operator's `index` is into this.
  */
  readonly tokens: readonly SwiftToken[];
  /**
  For each token, the index of the innermost bracket open around it, or
  undefined at the top level. A bracket's own entry is the one around it, so
  two tokens with the same entry are siblings.
  */
  readonly enclosing: readonly (number | undefined)[];
  /**
  For each bracket, the index of the bracket it pairs with.
  */
  readonly partner: ReadonlyMap<number, number>;
  /**
  False when a bracket is left open or closes nothing.
  */
  readonly isBalanced: boolean;
  /**
  The text of the first token of each line that has one.
  */
  readonly leaders: ReadonlyMap<number, string>;
  /**
  The lines that begin inside the text of a multi-line string.
  */
  readonly stringLines: ReadonlySet<number>;
  /**
  The disable directive on each line that has one.
  */
  readonly directives: ReadonlyMap<number, Directive>;
}

interface LexedLine {
  readonly line: number;
  readonly isInString: boolean;
  readonly lexed: SwiftLineLex;
}

/**
Lex the lines in order, keeping for each whether it starts in string text:
the token stream alone does not tell a line of a multi-line string from a
string literal that happens to start its line.
*/
function lexLines(lines: readonly string[]): LexedLine[] {
  let state = SWIFT_INITIAL_STATE;
  return lines.map((text, index) => {
    const isInString = state.at(-1)?.kind === 'string';
    const lexed = lexSwiftLine(text, state, index + 1);
    state = lexed.state;
    return { line: index + 1, isInString, lexed };
  });
}

type Brackets = Pick<SwiftDocument, 'enclosing' | 'partner' | 'isBalanced'>;

/**
Pair up the brackets. A closer pairs with whatever is open, whatever its
shape; one that closes nothing pairs with -1, which is how it is found.
*/
function matchBrackets(tokens: readonly SwiftToken[]): Brackets {
  const enclosing: (number | undefined)[] = [];
  const partner = new Map<number, number>();
  const open: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if ([')', ']', '}'].includes(token.text)) {
      const opener = open.pop() ?? -1;
      partner.set(index, opener).set(opener, index);
    }
    enclosing.push(open.at(-1));
    if (['(', '[', '{'].includes(token.text)) {
      open.push(index);
    }
  }
  return {
    enclosing,
    partner,
    isBalanced: !partner.has(-1) && open.length === 0,
  };
}

/**
Lex and index a Swift source.
*/
export function readDocument(source: string): SwiftDocument {
  const lines = source.split('\n');
  const rows = lexLines(lines);
  const tokens = rows.flatMap((row) =>
    row.lexed.tokens.filter((token) => token.kind !== 'comment'),
  );
  return {
    lines,
    tokens,
    ...matchBrackets(tokens),
    // Reversed, so that of a line's tokens the first is the one that stays.
    leaders: new Map(
      tokens.toReversed().map((token) => [token.line, token.text]),
    ),
    stringLines: new Set(
      rows.filter((row) => row.isInString).map((row) => row.line),
    ),
    directives: new Map(
      rows.flatMap((row) =>
        row.lexed.comments
          .flatMap((content) => parseDirective(content))
          .map((directive) => [row.line, directive] as const),
      ),
    ),
  };
}

/**
The text of the token at `index`, or the empty string off either end.
*/
export function textAt(document: SwiftDocument, index: number): string {
  return document.tokens[index]?.text ?? '';
}

/**
The kind of the token at `index`, if there is one.
*/
export function kindAt(
  document: SwiftDocument,
  index: number,
): SwiftTokenKind | undefined {
  return document.tokens[index]?.kind;
}

/**
The text of the first token on the token's line.
*/
export function leaderOf(document: SwiftDocument, token: SwiftToken): string {
  return document.leaders.get(token.line) ?? '';
}
