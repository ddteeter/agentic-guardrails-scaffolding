/**
A place in a source text. Both numbers are 1-indexed; the column counts
UTF-16 code units, as the lexer does.
*/
export interface Position {
  readonly line: number;
  readonly column: number;
}

/**
A span of source text. `end` is exclusive: the position just past the last
character of the span.
*/
export interface Location {
  readonly start: Position;
  readonly end: Position;
}

/**
One change to a source text: replace the span with the replacement.
*/
export interface Edit {
  readonly location: Location;
  readonly replacement: string;
}

/**
One mutant of a Swift source.
*/
export interface Mutant extends Edit {
  /**
  Stable within one `generateMutants` call: `'0'`, `'1'`, ... in output order.
  */
  readonly id: string;
  /**
  One of `OPERATOR_NAMES`.
  */
  readonly mutatorName: string;
  /**
  Set, with `statusReason`, by a disable directive on the line above.
  */
  readonly status?: 'Ignored';
  readonly statusReason?: string;
}

/**
What to generate mutants of.
*/
export interface GenerateOptions {
  readonly source: string;
  /**
  Inclusive 1-indexed line ranges to keep mutants in. Absent: the whole file.
  */
  readonly ranges?: readonly (readonly [number, number])[];
  /**
  The operators to run, by name. Absent or `'default'`: all of them. A name
  that is not an operator's selects nothing.
  */
  readonly operators?: 'default' | readonly string[];
}
