import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANALYZER_PROVIDERS,
  NON_PACKAGE_PROVIDERS,
} from '../src/verify/index.js';

/**
 * The pack shells out to tools the CONSUMER repo provides — guardrails-core
 * never imports them. `peerDependencies` is how that requirement is declared at
 * install time; the runtime `guardrails/analyzer-missing` check is what enforces
 * it. An analyzer added without its declaration would surface only as a runtime
 * failure in someone else's repo, so the two are pinned together here.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.resolve(here, '../package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

// The exemption itself lives in `verify/index.ts`, because `init`'s
// silent-skip warning needs it too -- it must never tell a consumer to
// `npm install npm`. The assertions below are what keep it from growing
// silently, wherever it is declared.

/**
Providers that must appear in `peerDependencies`.
*/
const packageProviders = ANALYZER_PROVIDERS.filter(
  (provider) => !NON_PACKAGE_PROVIDERS.has(provider),
);

describe('analyzer peer dependencies', () => {
  it('declares a peer dependency for every analyzer provider', () => {
    const declared = Object.keys(manifest.peerDependencies ?? {});
    for (const provider of packageProviders) {
      expect(declared, provider).toContain(provider);
    }
  });

  it('exempts only providers that are genuinely not packages', () => {
    // The positive control: keeps the exemption list from quietly absorbing a
    // real analyzer whose peer declaration was simply forgotten.
    expect([...NON_PACKAGE_PROVIDERS]).toEqual(['npm']);
    expect(packageProviders).toHaveLength(ANALYZER_PROVIDERS.length - 1);
  });

  it('declares no peer dependency that no analyzer provides', () => {
    // Keeps the declaration honest in the other direction: a tool removed from
    // the table must not leave a phantom requirement on consumers.
    const declaredPeers = Object.keys(manifest.peerDependencies ?? {});
    for (const declared of declaredPeers) {
      expect(packageProviders, declared).toContain(declared);
    }
  });

  it('marks every peer as optional', () => {
    // Which tools a repo needs depends on which rungs and analyzers it runs, so
    // npm must warn rather than hard-fail. The runtime check is the enforcement.
    const meta = manifest.peerDependenciesMeta ?? {};
    for (const provider of packageProviders) {
      expect(meta[provider]?.optional, provider).toBe(true);
    }
  });

  it('keeps the runtime dependency tree empty', () => {
    // guardrails-core installs into a consumer repo with no transitive supply
    // chain. See the piece-6 spec: this is why the workspace glob matcher is
    // hand-rolled rather than taking picomatch.
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
