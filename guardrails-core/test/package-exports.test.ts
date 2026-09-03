/**
 * `guardrails-core/cli` is what every generated hook command imports, so this
 * `exports` entry is public API — the only public API in this package that no
 * source file in this repo consumes. Narrowing the map, or renaming the built
 * file, would break every adopter's hooks simultaneously with no local signal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as {
  exports: Record<string, unknown>;
  bin: Record<string, string>;
};

describe('guardrails-core package exports', () => {
  it('publishes the CLI as ./cli for hook commands', () => {
    expect(manifest.exports['./cli']).toBe('./dist/cli.mjs');
  });

  it('points ./cli at the same file the guardrails bin runs', () => {
    // Two ways in, one entry point. If they ever diverge, `npx guardrails` and
    // the hook command would run different files.
    expect(manifest.exports['./cli']).toBe(manifest.bin.guardrails);
  });

  it('keeps the package root export intact', () => {
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
    });
  });
});
