/**
 * The CONSUMER's own `typescript`, an optional peer, loaded from the repo
 * being gated rather than from guardrails-core's install. The import graph
 * (#120) resolves with it and the mutation-scope planner (#196) parses with
 * it; each checks the export for the functions it calls, so a missing install
 * and a non-TypeScript export are the same answer: none.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import type * as Ts from 'typescript';

import { isRecord } from './verify/report-shape.js';

export type Typescript = typeof Ts;

/**
`typescript` as `repoRoot`'s own `package.json` would import it.
*/
export function loadFromRepo(repoRoot: string): unknown {
  return createRequire(path.join(repoRoot, 'package.json'))('typescript');
}

/**
 * What `load` gives, or nothing when it throws. A missing install and a
 * non-TypeScript export are then one answer, settled by the caller's guard.
 */
export function loaded(load: () => unknown): unknown {
  try {
    return load();
  } catch {
    // Not installed: falls through to undefined, which is not TypeScript.
  }
}

function canParse(value: unknown): value is Typescript {
  return isRecord(value) && typeof value.createSourceFile === 'function';
}

/**
 * `typescript` for parsing source text, or `undefined` when `repoRoot` has
 * none. `load` is injectable so a tmp repo can be given this repo's own.
 */
export function loadTypescriptParser(
  repoRoot: string,
  load: () => unknown = () => loadFromRepo(repoRoot),
): Typescript | undefined {
  const ts = loaded(load);
  return canParse(ts) ? ts : undefined;
}
