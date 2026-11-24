/**
 * The code a changed line belongs to (#196): the innermost function around
 * it, or the top-level statement when it is in no function. And the exports a
 * change may have orphaned, by the names its removed lines held.
 *
 * A one-line edit can change what the rest of its function does, and stryker
 * mutates only the nodes wholly inside a range, so a range of the hunk plus a
 * few lines of padding left the rest of the function, and the mutants spanning
 * it, untested at the gate. These spans are the minimum a hunk is widened to.
 *
 * Parsed with the consumer's own `typescript`, which is error-tolerant: a file
 * mid-edit still parses, into whatever nodes it can. The parser's script kind
 * (TS, TSX, JS, JSX) comes from the file's extension, as the compiler's does.
 */

import path from 'node:path';

import type * as Ts from 'typescript';

import type { Typescript } from '../typescript-loader.js';
import type { LineRange } from './line-range.js';

/**
The extensions typescript parses. Any other (`.vue`, `.svelte`, …) is not.
*/
const PARSEABLE = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
]);

/**
 * `text` parsed as `fileName`, with parent links (an export list is read
 * through its parent), or `undefined` when typescript has no parser for it.
 */
function parseSource(
  ts: Typescript,
  fileName: string,
  text: string,
): Ts.SourceFile | undefined {
  return PARSEABLE.has(path.extname(fileName))
    ? ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
    : undefined;
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
 * holding it, else `undefined` (a comment between statements).
 */
function enclosingNode(
  ts: Typescript,
  source: Ts.SourceFile,
  position: number,
): Ts.Node | undefined {
  // A node's last character is at `getEnd() - 1`.
  const isHolding = (node: Ts.Node): boolean =>
    node.getStart(source, true) <= position && position <= node.getEnd() - 1;
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
 * The node line `line` (1-based, inside the file) belongs to, read at its
 * first character that is not whitespace. A blank line belongs to none.
 */
function enclosingNodeOfLine(
  ts: Typescript,
  source: Ts.SourceFile,
  line: number,
): Ts.Node | undefined {
  const start = source.getPositionOfLineAndCharacter(line - 1, 0);
  const offset = source.text
    .slice(start, source.getLineEndOfPosition(start))
    .search(/\S/);
  return offset === -1 ? undefined : enclosingNode(ts, source, start + offset);
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
  const lineCount = source.getLineStarts().length;
  const nodes = new Set<Ts.Node>();
  for (const hunk of hunks) {
    const last = Math.min(hunk.end, lineCount);
    for (let line = hunk.start; line <= last; line += 1) {
      const node = enclosingNodeOfLine(ts, source, line);
      if (node !== undefined) {
        nodes.add(node);
      }
    }
  }
  return [...nodes]
    .map((node) => nodeLines(source, node))
    .toSorted((first, second) => first.start - second.start);
}

/**
The top-level statements that declare code with mutants an export can name.
*/
type Declaration =
  Ts.FunctionDeclaration | Ts.ClassDeclaration | Ts.VariableStatement;

function isDeclaration(
  ts: Typescript,
  statement: Ts.Statement,
): statement is Declaration {
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isVariableStatement(statement)
  );
}

/**
`export function a`, not `export default function a`.
*/
function isNamedExport(ts: Typescript, declaration: Declaration): boolean {
  const modifiers = ts.getModifiers(declaration);
  return (
    modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) === true &&
    modifiers.every(
      (modifier) => modifier.kind !== ts.SyntaxKind.DefaultKeyword,
    )
  );
}

/**
 * Does `declaration` declare a name `isWanted` accepts? A destructured
 * variable is read as its pattern's text, so it never matches a name.
 */
function isDeclaring(
  ts: Typescript,
  source: Ts.SourceFile,
  declaration: Declaration,
  isWanted: (name: string) => boolean,
): boolean {
  if (ts.isVariableStatement(declaration)) {
    return declaration.declarationList.declarations.some((variable) =>
      isWanted(variable.name.getText(source)),
    );
  }
  return declaration.name !== undefined && isWanted(declaration.name.text);
}

/**
 * Adds to `locals` the local names an `export { a, b as c }` in `statement`
 * exports, when `names` holds either name. A re-export
 * (`export { a } from …`) exports nothing declared here.
 */
function addLocallyExported(
  ts: Typescript,
  statement: Ts.Statement,
  names: ReadonlySet<string>,
  locals: Set<string>,
): void {
  ts.forEachChild(statement, (child) => {
    if (
      ts.isNamedExports(child) &&
      child.parent.moduleSpecifier === undefined
    ) {
      for (const element of child.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (names.has(element.name.text) || names.has(local)) {
          locals.add(local);
        }
      }
    }
  });
}

/**
 * The lines of every export of `fileName` named in `names` (the identifiers a
 * change removed, `removedIdentifiers`): an exported function, class or
 * variable statement, or the local declaration an `export { a }` names. A
 * change that removed an export's last caller left its mutants uncovered, and
 * outside every hunk the gate would never have seen them.
 *
 * A deliberate superset: a name that was removed in one place and is still
 * called in another brings its export in all the same. `export default`,
 * `export *`, re-exports and destructured exports are not followed.
 */
export function orphanedExportSpans(
  ts: Typescript,
  fileName: string,
  text: string,
  names: ReadonlySet<string>,
): LineRange[] {
  const source = parseSource(ts, fileName, text);
  if (source === undefined) {
    return [];
  }
  const locals = new Set<string>();
  for (const statement of source.statements) {
    addLocallyExported(ts, statement, names, locals);
  }
  return source.statements
    .filter(
      (statement) =>
        isDeclaration(ts, statement) &&
        isDeclaring(
          ts,
          source,
          statement,
          (name) =>
            locals.has(name) ||
            (names.has(name) && isNamedExport(ts, statement)),
        ),
    )
    .map((statement) => nodeLines(source, statement));
}
