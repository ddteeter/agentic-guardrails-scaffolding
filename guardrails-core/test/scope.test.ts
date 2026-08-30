import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectManifestScope,
  isPathAllowed,
  isWithinRepo,
} from '../src/scope.js';
import { stateDirectory, writeViolations } from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let directory: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-scope-'));
  directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function v(file: string, ruleId = 'x'): Violation {
  return {
    ruleId,
    file,
    message: 'm',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
  };
}

describe('collectManifestScope', () => {
  it('unions the files across every session manifest', () => {
    writeViolations(directory, 's1', [v('src/a.ts'), v('src/b.ts')]);
    writeViolations(directory, 's2', [v('src/c.ts')]);
    expect(
      [...collectManifestScope(directory).files].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('is empty and INACTIVE when there are no manifests', () => {
    const scope = collectManifestScope(directory);
    expect(scope.files.size).toBe(0);
    // `active` is what the scope-lock keys on: no manifest means no fixer is
    // running, so the lock stands aside.
    expect(scope.active).toBe(false);
  });

  it('is empty and inactive when the state directory does not exist', () => {
    const scope = collectManifestScope(path.join(root, 'absent'));
    expect(scope.files.size).toBe(0);
    expect(scope.active).toBe(false);
  });

  it('is ACTIVE with no editable files when every violation names a denied file', () => {
    // The two empty cases must stay distinguishable: this one denies every
    // write, where "no manifest" allows them all.
    writeViolations(directory, 's1', [
      v('package.json', 'guardrails/analyzer-missing'),
      v('guardrails.config.json', 'guardrails/analyzer-unknown'),
    ]);
    const scope = collectManifestScope(directory);
    expect(scope.files.size).toBe(0);
    expect(scope.active).toBe(true);
  });

  it('is active for a manifest that names editable files', () => {
    writeViolations(directory, 's1', [v('src/a.ts')]);
    expect(collectManifestScope(directory).active).toBe(true);
  });

  it('is not active for a state directory holding no manifest', () => {
    // A stray non-manifest file must not switch the lock on.
    writeFileSync(path.join(directory, 'notes.json'), '[]');
    expect(collectManifestScope(directory).active).toBe(false);
  });

  it('denies a denied filename whatever its casing', () => {
    writeViolations(directory, 's1', [
      v('Package.json'),
      v('GUARDRAILS.CONFIG.JSON'),
      v('packages/a/PACKAGE.JSON'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('never makes package.json editable, whatever names it', () => {
    // guardrails/analyzer-missing points at package.json. Letting the fixer
    // edit it would let it delete the provider dependency, which flips the
    // analyzer to auto+undeclared and makes the violation vanish.
    writeViolations(directory, 's1', [
      v('package.json', 'guardrails/analyzer-missing'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('never makes guardrails.config.json editable, whatever names it', () => {
    // guardrails/analyzer-unknown points at the config, which holds
    // sanctionedSuppressions, maxAttempts, analyzers and enforcement.
    writeViolations(directory, 's1', [
      v('guardrails.config.json', 'guardrails/analyzer-unknown'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('denies a workspace member package.json at any depth', () => {
    writeViolations(directory, 's1', [
      v('packages/a/package.json', 'guardrails/analyzer-missing'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('reads only `.last.json` manifests, not other state files', () => {
    // The state directory also holds session tallies and recurrence counts, and
    // a consumer may leave anything else there. Without the suffix filter this
    // array-shaped stray would widen the fixer's allowlist.
    writeViolations(directory, 's1', [v('src/a.ts')]);
    writeFileSync(
      path.join(directory, 'notes.json'),
      JSON.stringify([v('src/stray.ts')]),
    );
    expect([...collectManifestScope(directory).files]).toEqual(['src/a.ts']);
  });

  it('yields nothing for a manifest that is not a JSON array', () => {
    writeFileSync(path.join(directory, 's1.last.json'), '{"not":"an array"}');
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('ignores manifest entries that are not violations', () => {
    writeFileSync(
      path.join(directory, 's1.last.json'),
      JSON.stringify([{ nonsense: true }, v('src/a.ts')]),
    );
    expect([...collectManifestScope(directory).files]).toEqual(['src/a.ts']);
  });

  it('keeps every non-denied file editable alongside a denied one', () => {
    writeViolations(directory, 's1', [
      v('src/foo.ts'),
      v('package.json', 'guardrails/analyzer-missing'),
    ]);
    expect([...collectManifestScope(directory).files]).toEqual(['src/foo.ts']);
  });
});

describe('isPathAllowed', () => {
  const files = new Set(['src/a.ts']);

  it('allows a listed file given as an absolute path', () => {
    expect(isPathAllowed(files, '/repo', '/repo/src/a.ts')).toBe(true);
  });

  it('allows a listed file given as a repo-relative path', () => {
    expect(isPathAllowed(files, '/repo', 'src/a.ts')).toBe(true);
  });

  it('denies a file not in the manifest', () => {
    expect(isPathAllowed(files, '/repo', '/repo/src/b.ts')).toBe(false);
  });

  it('normalizes the candidate so a `..` segment does not cause a false denial', () => {
    expect(isPathAllowed(files, '/repo', 'src/nested/../a.ts')).toBe(true);
  });
});

describe('isWithinRepo', () => {
  it('accepts paths inside the repo, including node_modules', () => {
    expect(isWithinRepo('/repo', '/repo/src/a.ts')).toBe(true);
    expect(isWithinRepo('/repo', '/repo/node_modules/x/rule.js')).toBe(true);
    expect(isWithinRepo('/repo', '/repo/.claude/state/g/sid.last.json')).toBe(
      true,
    );
  });

  it('accepts the repo root itself', () => {
    expect(isWithinRepo('/repo', '/repo')).toBe(true);
  });

  it('rejects paths outside the repo (e.g. ~/.claude project memory)', () => {
    expect(
      isWithinRepo('/repo', '/home/u/.claude/projects/x/memory/y.md'),
    ).toBe(false);
    expect(isWithinRepo('/repo', '/repo-sibling/file.ts')).toBe(false);
  });
});

describe('collectManifestScope normalization', () => {
  it('stores normalized manifest paths', () => {
    writeViolations(directory, 's1', [v('src/nested/../a.ts')]);
    expect(collectManifestScope(directory).files.has('src/a.ts')).toBe(true);
  });
});
