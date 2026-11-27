/**
The Swift mutation generator: from a Swift source and line ranges to
mutants, each a span of the source and the text to put in its place.

It works from the lexer's tokens and never sees a type, so every operator is
a rule about token shapes, and every rule leans the same way: a mutant that
does not compile costs a build, so where the shape does not settle that a
mutation is well-formed, there is no mutant.

WHAT HOLDS FOR EVERY OPERATOR.

- A mutation point is a code token. Nothing is made of a comment, of the text
  of a string or a regex literal, or of a backtick identifier. The code of a
  string interpolation is code.
- Nothing is made on an `import` line, on a line that starts with `#` (a
  compiler directive, or a macro), or inside the arguments of an attribute,
  a directive or a macro (`@available(...)`, `#available(...)`).
- "Infix" means whitespace or a line boundary on both sides, and not the
  operator of a `func` or `operator` declaration. An unspaced operator is
  left alone.
- A mutant whose replacement is the text it replaces is not one.
- A source whose brackets do not balance gets no mutants at all.
- A span ends after a character of its last line, so the lines it touches
  are `location.start.line` to `location.end.line`.

The rules of each operator are on the function that implements it.
*/
export { applyMutant, generateMutants } from './generate.js';
export { OPERATOR_NAMES } from './operators.js';
export type { Mutant } from './types.js';
