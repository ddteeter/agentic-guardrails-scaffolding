import { describe, expect, it } from 'vitest';

import { checksum } from '../../src/scaffold/manifest.js';
import { staleArtifacts } from '../../src/scaffold/staleness.js';

const SHIPPED = 'the current guidance\n';
const SCAFFOLDED = 'the guidance as it was written\n';

const reader =
  (files: Record<string, string>) =>
  (file: string): string | undefined =>
    files[file];

const manifestFor = (
  files: Record<string, string>,
): { guardrailsVersion: string; files: Record<string, string> } => ({
  guardrailsVersion: '0.1.0',
  files,
});

describe('staleArtifacts', () => {
  it('reports an unmodified file the package has since changed', () => {
    // The whole failure this exists for: a repo adopts at 0.1.0, upgrades the
    // package through ordinary dependency maintenance, and the vendored copy
    // stays at 0.1.0 forever with nothing saying so.
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        manifestFor({
          'docs/guardrails/crushing-mutants.md': checksum(SCAFFOLDED),
        }),
        reader({ 'docs/guardrails/crushing-mutants.md': SCAFFOLDED }),
      ),
    ).toEqual({
      updatable: ['docs/guardrails/crushing-mutants.md'],
      drifted: [],
    });
  });

  it('says nothing when the vendored copy is already current', () => {
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        manifestFor({
          'docs/guardrails/crushing-mutants.md': checksum(SHIPPED),
        }),
        reader({ 'docs/guardrails/crushing-mutants.md': SHIPPED }),
      ),
    ).toEqual({ updatable: [], drifted: [] });
  });

  it('reports a file the consumer edited as drifted, not updatable', () => {
    // The sharper half: one well-meant edit opts the file out of upgrades
    // permanently, silently, with no warning at edit time.
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        manifestFor({
          'docs/guardrails/crushing-mutants.md': checksum(SCAFFOLDED),
        }),
        reader({ 'docs/guardrails/crushing-mutants.md': 'edited by hand\n' }),
      ),
    ).toEqual({
      updatable: [],
      drifted: ['docs/guardrails/crushing-mutants.md'],
    });
  });

  it('reports drift even when the package has not changed the file', () => {
    // Drift is about the consumer's edit, not about an available upgrade: the
    // file is opted out of every FUTURE upgrade too, which is the thing worth
    // saying early.
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        manifestFor({
          'docs/guardrails/crushing-mutants.md': checksum(SHIPPED),
        }),
        reader({ 'docs/guardrails/crushing-mutants.md': 'edited by hand\n' }),
      ),
    ).toEqual({
      updatable: [],
      drifted: ['docs/guardrails/crushing-mutants.md'],
    });
  });

  it('reports a scaffolded file that has been deleted as updatable', () => {
    // It was installed and is gone; `init --apply` restores it.
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        manifestFor({
          'docs/guardrails/crushing-mutants.md': checksum(SCAFFOLDED),
        }),
        reader({}),
      ),
    ).toEqual({
      updatable: ['docs/guardrails/crushing-mutants.md'],
      drifted: [],
    });
  });

  it('ignores a file this repo never scaffolded', () => {
    // A repo that never adopted the guidance must not be nagged to adopt it;
    // this warns about rot, not about opting in.
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        manifestFor({}),
        reader({}),
      ),
    ).toEqual({ updatable: [], drifted: [] });
  });

  it('says nothing at all when there is no manifest', () => {
    // An unscaffolded repo, or one whose manifest is unreadable.
    expect(
      staleArtifacts(
        [['docs/guardrails/crushing-mutants.md', SHIPPED]],
        undefined,
        reader({ 'docs/guardrails/crushing-mutants.md': SCAFFOLDED }),
      ),
    ).toEqual({ updatable: [], drifted: [] });
  });

  it('sorts each list, so the warning is stable between runs', () => {
    const result = staleArtifacts(
      [
        ['docs/guardrails/z.md', SHIPPED],
        ['docs/guardrails/a.md', SHIPPED],
      ],
      manifestFor({
        'docs/guardrails/z.md': checksum(SCAFFOLDED),
        'docs/guardrails/a.md': checksum(SCAFFOLDED),
      }),
      reader({
        'docs/guardrails/z.md': SCAFFOLDED,
        'docs/guardrails/a.md': SCAFFOLDED,
      }),
    );
    expect(result.updatable).toEqual([
      'docs/guardrails/a.md',
      'docs/guardrails/z.md',
    ]);
  });

  it('sorts the drifted list too', () => {
    const result = staleArtifacts(
      [
        ['docs/guardrails/z.md', SHIPPED],
        ['docs/guardrails/a.md', SHIPPED],
      ],
      manifestFor({
        'docs/guardrails/z.md': checksum(SCAFFOLDED),
        'docs/guardrails/a.md': checksum(SCAFFOLDED),
      }),
      reader({
        'docs/guardrails/z.md': 'edited\n',
        'docs/guardrails/a.md': 'edited\n',
      }),
    );
    expect(result.drifted).toEqual([
      'docs/guardrails/a.md',
      'docs/guardrails/z.md',
    ]);
  });
});
