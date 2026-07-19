import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import eslintJs from '@eslint/js';

import { checkDrift, type DriftEntry } from '../../src/drift-guard.js';
import { spawnExec } from '../../src/exec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const knipFixture = path.join(here, 'knip-fixture');
const repoRoot = path.resolve(here, '../../..');
const knipBin = path.join(repoRoot, 'node_modules', '.bin', 'knip');
// `eslint.config.js` lives outside guardrails-core's rootDir/tsconfig include
// set and is plain JS, so it's loaded via a computed (non-literal) dynamic
// import — TS doesn't statically resolve those, avoiding both an out-of-root
// compile error and an untyped-JS declaration error. The `unknown[]` result is
// narrowed with the same runtime cast the flat-config block iteration already
// uses below.
const eslintConfigUrl = pathToFileURL(
  path.join(repoRoot, 'eslint.config.js'),
).href;

/** knip probe: run real knip against the fixture, collect issue-type keys. */
async function knipIssueTypes(): Promise<Set<string>> {
  const { stdout } = await spawnExec(knipBin, ['--reporter', 'json'], {
    cwd: knipFixture,
  });
  const parsed = JSON.parse(stdout) as { issues: Record<string, unknown>[] };
  const keys = new Set<string>();
  for (const issue of parsed.issues) {
    for (const key of Object.keys(issue)) {
      if (key !== 'file') {
        keys.add(key);
      }
    }
  }
  return keys;
}

/** eslint-family probe: every rule id available from the flat config + core. */
async function eslintRuleIds(): Promise<Set<string>> {
  const { default: eslintConfig } = (await import(eslintConfigUrl)) as {
    default: unknown[];
  };
  // `@eslint/js`'s `all` config enumerates the full core rule catalog (not just
  // the curated `recommended` subset) — e.g. `no-restricted-imports` is core
  // but off by default, so it's absent from `recommended.rules`. This is the
  // public, non-deprecated equivalent of `eslint/use-at-your-own-risk`'s
  // `builtinRules` map for this repo's purposes.
  const ids = new Set<string>(Object.keys(eslintJs.configs.all.rules));
  for (const block of eslintConfig as { plugins?: Record<string, unknown> }[]) {
    const plugins = block.plugins ?? {};
    for (const [ns, plugin] of Object.entries(plugins)) {
      const rules = (plugin as { rules?: Record<string, unknown> }).rules ?? {};
      for (const rule of Object.keys(rules)) {
        ids.add(`${ns}/${rule}`);
      }
    }
  }
  return ids;
}

const entries: DriftEntry[] = [
  {
    tool: 'knip',
    // The issue types the knip adapter (MAPPED_ISSUE_TYPES) depends on.
    knownIds: [
      'files',
      'exports',
      'types',
      'dependencies',
      'devDependencies',
      'optionalPeerDependencies',
      'unlisted',
      'unresolved',
      'binaries',
    ],
    probe: knipIssueTypes,
    hint: 'knip renamed/removed an issue type — update MAPPED_ISSUE_TYPES in guardrails-core/src/verify/knip-adapter.ts',
  },
  {
    tool: 'eslint-family',
    // Only loose ids whose plugin is CURRENTLY installed are asserted.
    // Forward-declared, not-yet-installed ids are excluded on purpose:
    //   - 'no-assertionless-test'  (LOOSE_RULE_NAMES): no installed plugin
    //   - 'boundaries/' prefix     (LOOSE_PREFIXES): eslint-plugin-boundaries not installed
    //   - 'stryker/', 'knip/', 'dependency-cruiser/' prefixes: no eslint plugin (knip covered by its own probe)
    // Move an id here from that list when its plugin lands.
    knownIds: [
      'vitest/expect-expect',
      'sonarjs/no-trivial-assertions',
      'sonarjs/assertions-in-tests',
      'no-restricted-imports',
    ],
    probe: eslintRuleIds,
    hint: 'a loose rule id in guardrails-core/src/loose-rules.ts no longer exists in its plugin — reconcile after the tool upgrade',
  },
];

describe('drift-guard registry', () => {
  for (const entry of entries) {
    it(`${entry.tool}: every known id still exists upstream`, async () => {
      const { missing, hint } = await checkDrift(entry);
      expect(missing, `${entry.tool} drift — ${hint}`).toEqual([]);
    }, 20_000);
  }
});
