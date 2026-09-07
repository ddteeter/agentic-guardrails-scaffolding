/**
 * Defensive JSON parsing, shared by every caller that treats unreadable or
 * malformed input as "no data" rather than an error.
 *
 * Both functions return a WRAPPER rather than `unknown | undefined` on purpose.
 * A bare `undefined` return makes the catch block's mutant equivalent —
 * emptying it returns `undefined` too — which previously forced a mutation
 * suppression at every call site that needed this. Wrapping makes the failure
 * path observable, so the behaviour is provable by a test instead of exempted
 * from the gate.
 *
 * That property is why `parseJsonText` exists as its own export. Four analyzer
 * adapters (eslint, knip, dependency-cruiser, fallow) each carried their own
 * copy of the same `try { parsed = JSON.parse(stdout) } catch { return [] }`
 * preamble, and three of them carried a sanctioned mutation suppression for it.
 * Sharing this wrapper deletes all three grants rather than consolidating them
 * into one: the mutant is killable here, so none is needed.
 *
 * The duplication was not noticed by review — it was reported by the `dupes`
 * analyzer on its first run against this repository, which is what dogfooding
 * is for. See plan.md.
 */

import { readFileSync } from 'node:fs';

export interface JsonFileResult {
  /**
  Parsed contents, or `undefined` when the input was missing or malformed.
  */
  readonly parsed: unknown;
}

/**
 * Parse JSON already in hand — a tool's stdout, a string read elsewhere.
 *
 * Owns exactly one question: did it parse at all. Callers own their own shape
 * guard, because "is this an eslint report" and "is this a knip report" are not
 * this function's business, and a `parsed: undefined` that meant either
 * "malformed" or "wrong shape" would be strictly less informative.
 */
export function parseJsonText(text: string): JsonFileResult {
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { parsed: undefined };
  }
}

/**
 * Read and parse a JSON file. A missing file, an unreadable one and malformed
 * contents all land on `parsed: undefined` — this is for callers who treat all
 * three the same way.
 *
 * The read stays inside its own try/catch rather than delegating to
 * `parseJsonText` alone: `readFileSync` throws for a reason `parseJsonText`
 * never sees (ENOENT, EACCES), and the two failures must share one exit.
 */
export function readJsonFile(filePath: string): JsonFileResult {
  try {
    return parseJsonText(readFileSync(filePath, 'utf8'));
  } catch {
    return { parsed: undefined };
  }
}
