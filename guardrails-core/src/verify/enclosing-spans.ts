/**
 * The code a changed line belongs to (#196): the innermost function around
 * it, or the top-level statement when it is in no function.
 *
 * A one-line edit can change what the rest of its function does, and stryker
 * mutates only the nodes wholly inside a range, so a range of the hunk plus a
 * few lines of padding left the rest of the function, and the mutants spanning
 * it, untested at the gate. These spans are the minimum a hunk is widened to.
 *
 * Parsed with the consumer's own `typescript`, which is error-tolerant: a file
 * mid-edit still parses, into whatever nodes it can.
 */

import path from 'node:path';

import type * as Ts from 'typescript';

import type { Typescript } from '../typescript-loader.js';
import type { LineRange } from './mutate-ranges.js';

/**
 * The parser's kind for a file, by extension, or `undefined` when typescript
 * has no parser for it (`.vue`, `.svelte`, …).
 */
function scriptKindOf(
  ts: Typescript,
  fileName: string,
): Ts.ScriptKind | undefined {
  const kinds: Readonly<Record<string, Ts.ScriptKind>> = {
    '.ts': ts.ScriptKind.TS,
    '.mts': ts.ScriptKind.TS,
    '.cts': ts.ScriptKind.TS,
    '.tsx': ts.ScriptKind.TSX,
    '.js': ts.ScriptKind.JS,
    '.mjs': ts.ScriptKind.JS,
    '.cjs': ts.ScriptKind.JS,
    '.jsx': ts.ScriptKind.JSX,
  };
  return kinds[path.extname(fileName).toLowerCase()];
}

/**
 * `text` parsed as `fileName`, or `undefined` when typescript has no parser
 * for its extension.
 */
function parseSource(
  ts: Typescript,
  fileName: string,
  text: string,
): Ts.SourceFile | undefined {
  const kind = scriptKindOf(ts, fileName);
  return kind === undefined
    ? undefined
    : ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

function isFunction(ts: Typescript, node: Ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * The lines a node spans, from its decorators and JSDoc to its last token.
 */
function nodeLines(source: Ts.SourceFile, node: Ts.Node): LineRange {
  const line = (position: number): number =>
    source.getLineAndCharacterOfPosition(position).line + 1;
  return { start: line(node.getStart(source, true)), end: line(node.getEnd()) };
}

/**
 * The innermost function holding `position`, else the top-level statement
 * holding it, else `undefined` (a blank line or a comment between statements).
 */
function enclosingNode(
  ts: Typescript,
  source: Ts.SourceFile,
  position: number,
): Ts.Node | undefined {
  const isHolding = (node: Ts.Node): boolean =>
    node.getStart(source, true) <= position && position < node.getEnd();
  let innermost: Ts.Node | undefined = source.statements.find((statement) =>
    isHolding(statement),
  );
  let node = innermost;
  while (node !== undefined) {
    if (isFunction(ts, node)) {
      innermost = node;
    }
    node = ts.forEachChild(node, (child) =>
      isHolding(child) ? child : undefined,
    );
  }
  return innermost;
}

/**
 * Where line `line` (1-based) starts to hold code: its first character that
 * is not whitespace, or `undefined` for a blank line or one past the end.
 */
function firstCodeOf(source: Ts.SourceFile, line: number): number | undefined {
  const starts = source.getLineStarts();
  const start = starts[line - 1];
  if (start === undefined) {
    return undefined;
  }
  const end = starts[line] ?? source.text.length;
  const offset = source.text.slice(start, end).search(/\S/);
  return offset === -1 ? undefined : start + offset;
}

/**
 * The lines of every function (or top-level statement) a line of `hunks`
 * sits in, each once, in source order. `undefined` when typescript has no
 * parser for `fileName`, so the caller falls back to padding alone.
 */
export function enclosingSpans(
  ts: Typescript,
  fileName: string,
  text: string,
  hunks: readonly LineRange[],
): LineRange[] | undefined {
  const source = parseSource(ts, fileName, text);
  if (source === undefined) {
    return undefined;
  }
  const nodes = new Set<Ts.Node>();
  for (const hunk of hunks) {
    for (let line = hunk.start; line <= hunk.end; line += 1) {
      const position = firstCodeOf(source, line);
      const node =
        position === undefined
          ? undefined
          : enclosingNode(ts, source, position);
      if (node !== undefined) {
        nodes.add(node);
      }
    }
  }
  return [...nodes]
    .map((node) => nodeLines(source, node))
    .toSorted((first, second) => first.start - second.start);
}
