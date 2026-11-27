/**
One open construct the lexer is inside of.

- `comment`: a block comment, `depth` nested comments deep.
- `string`: the text of a string literal whose delimiter has `hashes` hashes.
  Only a `multiline` one survives the end of a line.
- `interpolation`: the code of a `\(...)` in the string frame below it, with
  `parens` parentheses open, counting the interpolation's own.
*/
export type SwiftLexFrame =
  | { readonly kind: 'comment'; readonly depth: number }
  | {
      readonly kind: 'string';
      readonly hashes: number;
      readonly multiline: boolean;
    }
  | { readonly kind: 'interpolation'; readonly parens: number };

/**
The lexer's position between two lines: a stack of open constructs, innermost
last. Empty means "in code".
*/
export type SwiftLexState = readonly SwiftLexFrame[];

/**
The state at the top of a file: in code. Frozen, because it is the one state
every caller shares.
*/
export const SWIFT_INITIAL_STATE: SwiftLexState = Object.freeze([]);

/**
The stack without its innermost frame.
*/
export function popFrame(frames: SwiftLexState): SwiftLexState {
  return frames.slice(0, -1);
}

/**
How many string interpolations deep a token lexed in `frames` is.
*/
export function interpolationDepth(frames: SwiftLexState): number {
  return frames.filter((frame) => frame.kind === 'interpolation').length;
}

function parenDelta(text: string): number {
  if (text === '(') {
    return 1;
  }
  if (text === ')') {
    return -1;
  }
  return 0;
}

/**
The stack after lexing the code token `text`. Only an interpolation counts
parentheses: the `)` that brings its count back to 0 closes it.
*/
export function afterCodeToken(
  frames: SwiftLexState,
  text: string,
): SwiftLexState {
  const frame = frames.at(-1);
  if (frame?.kind !== 'interpolation') {
    return frames;
  }
  const parens = frame.parens + parenDelta(text);
  const below = popFrame(frames);
  return parens === 0 ? below : [...below, { kind: 'interpolation', parens }];
}

function isSingleLineString(frame: SwiftLexFrame): boolean {
  return frame.kind === 'string' && !frame.multiline;
}

/**
The stack as the next line inherits it. A single-line string never continues
past its line, so an unterminated one is dropped along with everything opened
inside it.
*/
export function atEndOfLine(frames: SwiftLexState): SwiftLexState {
  const unterminated = frames.findIndex((frame) => isSingleLineString(frame));
  return unterminated === -1 ? frames : frames.slice(0, unterminated);
}
