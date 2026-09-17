import { describe, expect, it } from 'vitest';

import { isBuiltinLoose, makeIsLoose } from '../src/loose-rules.js';

describe('isBuiltinLoose', () => {
  it('classifies test-integrity rules as loose (a green assertion is easily not good)', () => {
    expect(isBuiltinLoose('vitest/expect-expect')).toBe(true);
    expect(isBuiltinLoose('sonarjs/no-trivial-assertions')).toBe(true);
    expect(isBuiltinLoose('sonarjs/assertions-in-tests')).toBe(true);
    expect(isBuiltinLoose('ts/no-assertionless-test')).toBe(true);
  });

  it('classifies architecture / mutation / dead-code families as loose', () => {
    expect(isBuiltinLoose('boundaries/element-types')).toBe(true);
    expect(isBuiltinLoose('java/archunit/layer-access')).toBe(true);
    expect(isBuiltinLoose('stryker/survived-mutant')).toBe(true);
    expect(isBuiltinLoose('knip/unused-export')).toBe(true);
  });

  it('classifies duplication as loose (a green dedupe is easily not a good one)', () => {
    // "Delete one copy" and "extract into the wrong shape" are both green and
    // both wrong; the right answer depends on whether the two sites should
    // evolve together, which is exactly the judgment the fast tier skips.
    expect(isBuiltinLoose('fallow/code-duplication')).toBe(true);
  });

  it('classifies behaviour-changing mechanical fixes as loose', () => {
    // Not analyzer categories -- plain lint rules whose *obvious* mechanical
    // fix is a behaviour change. `unicorn/no-null` is the measured one: the
    // cheap tier rewrote a `== null` guard (null AND undefined) to
    // `=== undefined` (one of them), leaving the guard unreachable for exactly
    // the value it existed to catch.
    expect(isBuiltinLoose('unicorn/no-null')).toBe(true);
    expect(isBuiltinLoose('@typescript-eslint/no-unnecessary-condition')).toBe(
      true,
    );
    expect(
      isBuiltinLoose(
        '@typescript-eslint/no-unnecessary-boolean-literal-compare',
      ),
    ).toBe(true);
  });

  it('classifies behaviour-changing rules under any plugin namespace', () => {
    // Repos alias plugin namespaces (`ts` for `@typescript-eslint`), so the
    // class matches on the rule *name*, as the test-integrity names do.
    expect(isBuiltinLoose('ts/no-unnecessary-condition')).toBe(true);
  });

  it('leaves tight, well-pinned rules to the fast tier', () => {
    expect(isBuiltinLoose('no-console')).toBe(false);
    expect(isBuiltinLoose('@typescript-eslint/no-unused-vars')).toBe(false);
    expect(isBuiltinLoose('prettier/prettier')).toBe(false);
    expect(isBuiltinLoose('TS2322')).toBe(false);
    // Deliberately tight: `unicorn/no-await-expression-member`'s obvious fix
    // (bind the awaited value to a local, then read the member) preserves
    // behaviour everywhere except a conditionally-evaluated subexpression,
    // and its shipped autofix is a destructuring rewrite that cannot change
    // behaviour at all. Common rule, rare failure -- not worth the tier.
    expect(isBuiltinLoose('unicorn/no-await-expression-member')).toBe(false);
  });
});

describe('makeIsLoose', () => {
  it('routes built-in loose rules regardless of repo config', () => {
    const isLoose = makeIsLoose([]);
    expect(isLoose({ ruleId: 'vitest/expect-expect' })).toBe(true);
    expect(isLoose({ ruleId: 'no-console' })).toBe(false);
  });

  it('extends the built-in set with exact repo rule-ids', () => {
    const isLoose = makeIsLoose(['house/no-raw-sql']);
    expect(isLoose({ ruleId: 'house/no-raw-sql' })).toBe(true);
    expect(isLoose({ ruleId: 'house/other' })).toBe(false);
  });
});
