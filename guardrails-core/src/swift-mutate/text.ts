import type { Edit, Location, Position } from './types.js';

/**
The offset of a position in the text whose lines, split on `\n`, are `lines`:
the lengths of the lines above it, a newline each, and its column.
*/
function offsetOf(lines: readonly string[], position: Position): number {
  return lines
    .slice(0, position.line - 1)
    .reduce((offset, text) => offset + text.length + 1, position.column - 1);
}

/**
The text a location spans.
*/
export function textIn(lines: readonly string[], location: Location): string {
  return lines
    .join('\n')
    .slice(offsetOf(lines, location.start), offsetOf(lines, location.end));
}

/**
The source with the edit's span replaced by its replacement.
*/
export function applyEdit(source: string, edit: Edit): string {
  const lines = source.split('\n');
  return (
    source.slice(0, offsetOf(lines, edit.location.start)) +
    edit.replacement +
    source.slice(offsetOf(lines, edit.location.end))
  );
}
