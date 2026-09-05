/**
 * `guardrails-core/cli` is what every generated hook command imports, so this
 * `exports` entry is public API — the only public API in this package that no
 * source file in this repo consumes. Narrowing the map, or renaming the built
 * file, would break every adopter's hooks simultaneously with no local signal.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as {
  exports: Record<string, unknown>;
  bin: Record<string, string>;
};

describe('guardrails-core package exports', () => {
  it('actually ships the declaration files the exports map promises', () => {
    // The build emits declarations with `tsc --emitDeclarationOnly` rather than
    // tsup's dts pass (tsup 8.5.1's cannot parse TypeScript 6), so the type
    // output is one .d.ts per module instead of one bundle. `types` still has
    // to resolve, and only a build can prove it -- run `npm run build` first.
    const builtOutput = path.join(import.meta.dirname, '..', 'dist');
    const root = manifest.exports['.'] as { types: string };
    expect(existsSync(path.join(builtOutput, path.basename(root.types)))).toBe(
      true,
    );
    expect(existsSync(path.join(builtOutput, 'cli.mjs'))).toBe(true);
  });

  it('publishes the CLI as ./cli for hook commands', () => {
    expect(manifest.exports['./cli']).toBe('./dist/cli.mjs');
  });

  it('names the bin after the package, so an npx miss cannot fetch a stranger', () => {
    // `npx <name>` resolves a bin NAME, and falls through to the registry when
    // nothing local provides it. While the bin was `guardrails`, that fallthrough
    // fetched `guardrails@2.4.1` -- a real, unrelated, and since-2022 dormant
    // package owned by someone else -- and executed it. Naming the bin after the
    // package is what makes the miss land on US: `npx guardrails-core` can only
    // ever resolve this package.
    expect(Object.keys(manifest.bin)).toEqual(['guardrails-core']);
  });

  it('points ./cli at the same file the bin runs', () => {
    // Two ways in, one entry point. If they ever diverge, the bin and the hook
    // command would run different files.
    expect(manifest.exports['./cli']).toBe(manifest.bin['guardrails-core']);
  });

  it('keeps the package root export intact', () => {
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
    });
  });
});
