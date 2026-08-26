import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
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
// dependency-cruiser's config validator is an internal file, not a public
// export (its `exports` map blocks subpath require/import of it), so it's
// loaded the same computed-path + `pathToFileURL` way as `eslint.config.js`
// above.
const depcruiseValidatorUrl = pathToFileURL(
  path.join(
    repoRoot,
    'node_modules',
    'dependency-cruiser',
    'src',
    'schema',
    'configuration.validate.mjs',
  ),
).href;

/**
 * knip probe: run real knip against the fixture, collect issue-type keys.
 *
 * This relies on a knip output invariant: every issue object carries the FULL
 * set of issue-type keys (all present, empty arrays for types with no finding) —
 * NOT only the types that fired. That's why the fixture only needs to trigger a
 * single issue type (one unused `export`) to expose all nine `knownIds` as keys;
 * verified against knip 6.27.0, which emits 13 keys on a single-`exports` issue.
 * If a future knip drops empty keys, this probe would report the untriggered
 * types as "missing" and the drift test would fail — which is the correct signal
 * to revisit (extend the fixture to organically trigger each asserted type).
 */
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

/**
 * dependency-cruiser probe: the rule-condition keywords and severity values our
 * `.dependency-cruiser.cjs` + depcruise-adapter depend on. Rule *names* are ours
 * (authored in the config), so they are NOT the drift target — what UPSTREAM owns
 * and can rename on upgrade is the condition vocabulary. DC 18 ships no consumable
 * JSON schema, but its config validator uses `additionalProperties: false`, so a
 * minimal config using a keyword validates ONLY while DC still accepts that keyword.
 * (Imports DC's internal validator by computed path — DC exposes no public API for
 * this; if a future DC moves the file, this import fails, which is itself a correct
 * "revisit on upgrade" drift signal.)
 */
async function depcruiseVocabulary(): Promise<Set<string>> {
  const { default: validate } = (await import(depcruiseValidatorUrl)) as {
    default: (config: unknown) => boolean;
  };

  const accepted = new Set<string>();

  // Each keyword gets a minimal config that is valid ONLY if DC still accepts it.
  const keywordConfigs: Record<string, unknown> = {
    circular: {
      forbidden: [
        { name: 'probe', severity: 'error', from: {}, to: { circular: true } },
      ],
    },
    path: {
      forbidden: [
        {
          name: 'probe',
          severity: 'error',
          from: { path: 'x' },
          to: { path: 'y' },
        },
      ],
    },
    pathNot: {
      forbidden: [
        {
          name: 'probe',
          severity: 'error',
          from: { path: 'x', pathNot: 'z' },
          to: { path: 'y' },
        },
      ],
    },
    dependencyTypes: {
      forbidden: [
        {
          name: 'probe',
          severity: 'error',
          from: {},
          to: { path: 'y', dependencyTypes: ['core'] },
        },
      ],
    },
  };
  for (const [keyword, config] of Object.entries(keywordConfigs)) {
    if (validate(config)) {
      accepted.add(keyword);
    }
  }

  // Severity enum values the adapter maps.
  for (const severity of ['error', 'warn', 'info']) {
    const config = {
      forbidden: [
        { name: 'probe', severity, from: {}, to: { circular: true } },
      ],
    };
    if (validate(config)) {
      accepted.add(severity);
    }
  }

  return accepted;
}

/**
 * stryker probe: the MutantStatus enum the stryker adapter classifies on
 * (stryker-adapter.ts keys on `status`, emitting only on 'Survived' and treating
 * 'Killed'/'Timeout'/'NoCoverage' as non-violations). The enum is upstream-owned
 * and read from the schema package's PUBLIC subpath export — no fixture, no
 * internal-file bypass. `mutatorName` is free-form (not an enum) so it's not a probe target.
 */
async function strykerStatuses(): Promise<Set<string>> {
  const schemaPath = createRequire(import.meta.url).resolve(
    'mutation-testing-report-schema/mutation-testing-report-schema.json',
  );
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as unknown;
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const en = (node as { enum?: unknown }).enum;
    if (Array.isArray(en) && en.includes('Survived')) {
      for (const value of en) {
        if (typeof value === 'string') {
          found.add(value);
        }
      }
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  walk(schema);
  return found;
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
  {
    tool: 'dependency-cruiser',
    // Condition keywords our .dependency-cruiser.cjs rules use + severities the
    // adapter maps. NOT rule names (those are ours). See depcruiseVocabulary above.
    knownIds: [
      'circular',
      'path',
      'pathNot',
      'dependencyTypes',
      'error',
      'warn',
      'info',
    ],
    probe: depcruiseVocabulary,
    hint: 'dependency-cruiser renamed/removed a rule-condition keyword or severity (its config validator now rejects the probe config) — reconcile .dependency-cruiser.cjs and guardrails-core/src/verify/depcruise-adapter.ts',
  },
  {
    tool: 'stryker',
    // Statuses the stryker adapter classifies on (guardrails-core/src/verify/stryker-adapter.ts).
    knownIds: ['Survived', 'Killed', 'Timeout', 'NoCoverage'],
    probe: strykerStatuses,
    hint: 'stryker/mutation-testing-report-schema renamed/removed a MutantStatus — reconcile guardrails-core/src/verify/stryker-adapter.ts',
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
