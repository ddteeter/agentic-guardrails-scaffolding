/**
 * Defensive JSON file read, shared by every caller that treats an unreadable or
 * malformed file as "no data" rather than an error.
 *
 * Returns a WRAPPER rather than `unknown | undefined` on purpose. A bare
 * `undefined` return makes the catch block's mutant equivalent — emptying it
 * returns `undefined` too — which previously forced a mutation suppression at
 * every call site that needed this. Wrapping makes the failure path observable,
 * so the behaviour is provable by a test instead of exempted from the gate.
 */

import { readFileSync } from 'node:fs';

export interface JsonFileResult {
  /** Parsed contents, or `undefined` when the file was missing or malformed. */
  readonly parsed: unknown;
}

export function readJsonFile(filePath: string): JsonFileResult {
  try {
    return { parsed: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch {
    return { parsed: undefined };
  }
}
