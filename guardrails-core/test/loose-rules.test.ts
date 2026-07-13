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

  it('leaves tight, well-pinned rules to the fast tier', () => {
    expect(isBuiltinLoose('no-console')).toBe(false);
    expect(isBuiltinLoose('@typescript-eslint/no-unused-vars')).toBe(false);
    expect(isBuiltinLoose('prettier/prettier')).toBe(false);
    expect(isBuiltinLoose('TS2322')).toBe(false);
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
