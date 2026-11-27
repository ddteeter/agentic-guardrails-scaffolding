/**
A Swift lexer: the Swift counterpart of the single-line JavaScript lexer in
`audit.ts`, but with state carried across lines, so a multi-line comment or
string is known for what it is on every line it touches.

THE TOKEN STREAM. Every non-whitespace character of a line belongs to exactly
one token, and a token never crosses a line break.

- Code is `identifier` (keywords, `$0`, `_` and backtick identifiers
  included), `number`, `operator` and `punctuation`. `@name` and `#name` are
  two tokens, the `@` or `#` and the identifier.
- A comment is one `comment` token per line it touches, delimiters included.
  On a continuation line of a block comment that is the whole line up to
  where the comment closes, leading whitespace and all.
- A string literal is one `string` token per run of its text, per line. A run
  takes the delimiters next to it: the opening and closing quotes with their
  hashes, and the backslash (with its hashes) that opens an interpolation. So
  `"a \(x) b"` is the string `"a \`, the punctuation `(`, the identifier `x`,
  the punctuation `)`, and the string ` b"`.
- The parentheses of an interpolation are therefore ordinary `punctuation`
  tokens, and the code between them ordinary code tokens. All of them carry
  an `interpolationDepth` of 1 or more, as does a string nested in there.
- A regex literal is one `regex` token.

Whitespace between tokens is code; whitespace inside a comment, string or
regex token is part of that token.

ACCEPTED LIMITS.

- Lexing that starts mid-file needs the state that line starts in
  (`swiftStateAtLine`). Given the initial state instead, a first line that is
  really inside a multi-line comment or string is lexed as code: an
  over-match rather than a miss.
- A single-line string never continues past its line, even when the line
  ends inside one of its interpolations: the next line starts in code.
- An extended regex literal `#/.../#` is single-line. The multi-line form is
  cut off at the end of its opening line, and its body is lexed as code.
- A bare `/.../` starts where the JavaScript lexer's heuristic says it may:
  at the start of the line, after `return`, or after an operator or opening
  punctuator. So a regex after any other keyword is lexed as code, and
  `x!/2/y`, a division after a postfix operator, as a regex. The same goes
  for the path of a `#!` line at the top of a script.
- An unspaced `a??b` is two postfix `?`, by the left-bound rule below, where
  Swift reads one `??`.
- Operator characters outside ASCII are identifier characters here.
- A hexadecimal float's exponent sign splits the literal (`0x1p-3`), and a
  nested tuple index (`t.0.1`) reads as one fractional number.

THE LEFT-BOUND RULE. A `!` or `?` directly after its operand -- no whitespace
and no opening `(`, `[`, `{`, `,`, `;`, `:` before it -- is a token on its own,
whatever follows: `a!.b`, `a?.b`, `x!)`, `try!`, `Int??`. The one exception is
a `!` that `=` follows, which stays in its `!=` or `!==`. And an operator ends
at a `>` that `!` or `?` follows, so `Set<Int>!` ends in a lone `!` too.
*/
export { lexSwiftLine, type SwiftLineLex } from './line.js';
export { lexSwift, swiftStateAtLine } from './source.js';
export { SWIFT_INITIAL_STATE, type SwiftLexState } from './state.js';
export type { SwiftToken, SwiftTokenKind } from './tokens.js';
