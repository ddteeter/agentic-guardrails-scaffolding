import { isDisabled } from './directive.js';
import { readDocument, type SwiftDocument } from './document.js';
import { operators, type Operator } from './operators.js';
import { isMutationPoint } from './syntax.js';
import { applyEdit, textIn } from './text.js';
import type { Edit, GenerateOptions, Mutant } from './types.js';

/**
A mutant before it has its place in the output.
*/
interface Candidate extends Edit {
  readonly mutatorName: string;
  /**
  Sorts as the output is ordered: by start, then end, then the operator's
  place in the table, then the replacement.
  */
  readonly key: string;
}

function sortKey(edit: Edit, order: number): string {
  const { start, end } = edit.location;
  const numbers = [start.line, start.column, end.line, end.column, order];
  const padded = numbers.map((number) => String(number).padStart(8, '0'));
  return `${padded.join(' ')} ${edit.replacement}`;
}

/**
Everything one operator makes of the document: its edits at every token
where anything may be mutated, less those that would change nothing.
*/
function candidatesOf(
  document: SwiftDocument,
  operator: Operator,
  order: number,
): Candidate[] {
  return document.tokens
    .flatMap((token, index) =>
      isMutationPoint(document, index, token)
        ? operator.mutate(document, index, token)
        : [],
    )
    .filter(
      (edit) => textIn(document.lines, edit.location) !== edit.replacement,
    )
    .map((edit) => ({
      ...edit,
      mutatorName: operator.name,
      key: sortKey(edit, order),
    }));
}

/**
The candidates in output order.
*/
function inOrder(candidates: readonly Candidate[]): Candidate[] {
  return candidates.toSorted((one, other) => one.key.localeCompare(other.key));
}

/**
True when the span touches a range. Every span an operator makes ends after a
character of its last line, so its lines are `start.line` to `end.line`.
*/
function isInRanges(
  edit: Edit,
  ranges: NonNullable<GenerateOptions['ranges']>,
): boolean {
  const { start, end } = edit.location;
  return ranges.some(([from, to]) => from <= end.line && start.line <= to);
}

/**
The status a disable directive on the line above gives the candidate, if
there is one and it names the candidate's operator.
*/
function statusOf(
  document: SwiftDocument,
  candidate: Candidate,
): Pick<Mutant, 'status' | 'statusReason'> {
  const directive = document.directives.get(candidate.location.start.line - 1);
  return directive !== undefined && isDisabled(directive, candidate.mutatorName)
    ? { status: 'Ignored', statusReason: directive.reason }
    : {};
}

/**
The mutants of a Swift source: for each enabled operator, every place in the
requested lines where it applies, in a deterministic order.

A source whose brackets do not balance gets none: either it does not compile
or it was lexed wrongly, and in both cases a mutant could land anywhere.
*/
export function generateMutants(options: GenerateOptions): Mutant[] {
  const document = readDocument(options.source);
  if (!document.isBalanced) {
    return [];
  }
  const { operators: enabled = 'default' } = options;
  const ranges = options.ranges ?? [[1, Infinity]];
  const candidates = operators().flatMap((operator, order) =>
    enabled === 'default' || enabled.includes(operator.name)
      ? candidatesOf(document, operator, order)
      : [],
  );
  return inOrder(candidates)
    .filter((candidate) => isInRanges(candidate, ranges))
    .map((candidate, index) => ({
      id: String(index),
      mutatorName: candidate.mutatorName,
      replacement: candidate.replacement,
      location: candidate.location,
      ...statusOf(document, candidate),
    }));
}

/**
The source with the mutant applied.
*/
export function applyMutant(
  source: string,
  mutant: Pick<Mutant, 'location' | 'replacement'>,
): string {
  return applyEdit(source, mutant);
}
