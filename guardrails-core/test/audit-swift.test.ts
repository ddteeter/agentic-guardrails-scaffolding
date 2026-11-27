/**
 * The Swift rows of the diff auditor (GR-04).
 *
 * Every row is held to the same matrix: the escape is a finding where it is
 * code (or, for a directive, where it is in a comment), a finding inside a
 * string interpolation, whose contents are code, and NOT a finding in a
 * line comment, a nested block comment, a doc comment, a string, a
 * multi-line string, a raw string or a backtick identifier.
 */

import { describe, expect, it } from 'vitest';

import { auditDiff, auditKinds, auditSource } from '../src/audit.js';

const SOURCE_FILE =
  'ios/Packages/DialedDomain/Sources/DialedDomain/Verdict.swift';
const TEST_FILE =
  'ios/Packages/DialedDomain/Tests/DialedDomainTests/VerdictTests.swift';
const PACKAGE_FILE = 'ios/Packages/DialedDomain/Package.swift';
const PROJECT_FILE = 'ios/project.yml';

/**
Every finding in `source`, as `line:kind`.
*/
function findings(source: string, file = SOURCE_FILE): string[] {
  return auditSource(file, source).map(
    (finding) => `${String(finding.line)}:${finding.kind}`,
  );
}

/**
A reader for a repository in which no file can be read.
*/
function unreadable(): undefined {
  return;
}

function escaped(sample: string): string {
  return sample.replaceAll('"', String.raw`\"`);
}

/**
 * A code-class row: the kind, a line of Swift that is the escape, and the
 * file it is audited in when the row is limited to some files.
 */
type CodeRow = readonly [kind: string, sample: string, file?: string];

const CODE_ROWS: readonly CodeRow[] = [
  ['unchecked-sendable', 'final class Box: @unchecked Sendable {}'],
  ['unchecked-sendable', 'extension Box: @unchecked   Sendable {}'],
  ['unsafe-isolation', 'nonisolated(unsafe) var cache = 0'],
  ['unsafe-isolation', 'nonisolated ( unsafe ) let shared = Box()'],
  ['preconcurrency', '@preconcurrency import Legacy'],
  ['preconcurrency', 'extension Box: @preconcurrency Delegate {}'],
  ['assume-isolated', 'MainActor.assumeIsolated { run() }'],
  ['assume-isolated', 'let value = actor.assumeIsolated(read)'],
  ['assume-isolated', 'assumeIsolated { run() }'],
  ['assume-isolated', 'assumeIsolated{ run() }'],
  ['unsafe-expression', 'let value = unsafe pointer.pointee'],
  ['unsafe-expression', 'return unsafe (pointer + 1).pointee'],
  ['unsafe-expression', 'let value = unsafe  pointer.pointee'],
  ['unsafe-expression', '@unsafe struct Raw {}'],
  ['unsafe-expression', '@safe struct Wrapped {}'],
  ['force-try', 'let data = try! load()'],
  ['force-cast', 'let count = value as! Int'],
  ['force-unwrap', 'let count = value!'],
  ['force-unwrap', 'let first = list[0]!'],
  ['force-unwrap', 'let made = make()!'],
  ['force-unwrap', 'let name = user?.name!'],
  ['force-unwrap', 'let length = value!.count'],
  ['force-unwrap', 'var label: UILabel!'],
  ['force-unwrap', 'var names: Set<String>!'],
  ['force-unwrap', 'let deep = value?!'],
  ['fatal-stub', 'fatalError("not yet")'],
  ['fatal-stub', 'preconditionFailure ("unreachable")'],
  ['fatal-stub', 'return unimplemented()'],
  ['skipped-test', 'throw XCTSkip("later")'],
  ['skipped-test', 'try XCTSkipIf(isSlow)'],
  ['skipped-test', 'try XCTSkipUnless(isFast)'],
  ['skipped-test', 'XCTExpectFailure("known")'],
  ['skipped-test', 'withKnownIssue { run() }'],
  ['skipped-test', 'withKnownIssue("flaky") { run() }'],
  ['skipped-test', '@Test(.disabled("flaky"))', TEST_FILE],
  ['skipped-test', '@Test(.enabled(if: isFast))', TEST_FILE],
  ['skipped-test', '@Suite(.enabled( if: isFast))', TEST_FILE],
  ['skipped-test', '@Test(.disabled ("flaky"))', TEST_FILE],
  ['skipped-test', '@Test(.enabled (if: isFast))', TEST_FILE],
  ['test-time-limit', '@Test(.timeLimit(.minutes(1)))'],
  ['test-time-limit', '@Test(.timeLimit (.minutes(1)))'],
  ['compile-escape', '#if DEBUG'],
  ['compile-escape', '#if  DEBUG'],
  ['compile-escape', '#if !DEBUG'],
  ['compile-escape', '#if ! DEBUG'],
  ['compile-escape', '#if  false'],
  ['compile-escape', '#if ! canImport(UIKit)'],
  ['compile-escape', '#if false'],
  ['compile-escape', '#if canImport(UIKit)'],
  ['compile-escape', '#if !canImport(UIKit)'],
  ['compile-escape', '#if TESTING'],
  ['compile-escape', '#if UNIT_TEST_BUILD'],
  ['underscored-attribute', '@_spi(Internal) import Core'],
  ['underscored-attribute', '@_exported import Core'],
  ['underscored-attribute', '@_optimize(none) func slow() {}'],
  ['unsafe-cast', 'let bits = unsafeBitCast(value, to: UInt.self)'],
  ['unsafe-cast', 'let view = unsafeDowncast(object, to: View.self)'],
  ['unsafe-cast', 'let ref = Unmanaged.passUnretained(object)'],
  ['unsafe-cast', 'withoutActuallyEscaping(body) { escape($0) }'],
  ['retroactive', 'extension Date: @retroactive Identifiable {}'],
  ['availability-hide', '@available(*, unavailable)'],
  ['availability-hide', '@available (*, unavailable)'],
  ['availability-hide', '@available(*,unavailable)'],
  ['availability-hide', '@available( * , deprecated, message: "old")'],
];

/**
Every row with its file spelled out, for the table below.
*/
const CODE_CASES: readonly (readonly [string, string, string])[] =
  CODE_ROWS.map(([kind, sample, file = SOURCE_FILE]) => [kind, sample, file]);

describe.each(CODE_CASES)('%s: `%s`', (kind, sample, file) => {
  it('is a finding where it is code', () => {
    expect(findings(sample, file)).toEqual([`1:${kind}`]);
  });

  it('is a finding inside a string interpolation, whose contents are code', () => {
    expect(
      findings(String.raw`let text = "a \(` + sample + ') b"', file),
    ).toEqual([`1:${kind}`]);
  });

  it('is not a finding in a line comment or a doc comment', () => {
    expect(findings(`// ${sample}\n/// ${sample}`, file)).toEqual([]);
  });

  it('is not a finding in a block comment, nested or spanning lines', () => {
    expect(
      findings(
        [
          `/* outer /* inner */ ${sample} */`,
          '/**',
          ` * ${sample}`,
          ` ${sample}`,
          ' */',
        ].join('\n'),
        file,
      ),
    ).toEqual([]);
  });

  it('is not a finding in a string, a multi-line string or a raw string', () => {
    expect(
      findings(
        [
          `let one = "${escaped(sample)}"`,
          'let many = """',
          sample,
          '"""',
          `let raw = #"${sample}"#`,
        ].join('\n'),
        file,
      ),
    ).toEqual([]);
  });

  it('is not a finding in a backtick identifier', () => {
    expect(findings('func `' + sample + '`() {}', file)).toEqual([]);
  });
});

describe('code rows: what is not an escape', () => {
  it.each([
    'final class Box: Sendable {}',
    'let unchecked = Sendable.self',
    'nonisolated var cache: Int { 0 }',
    'nonisolated(nonsending) func run() async {}',
    'let preconcurrency = 1',
    'let assumeIsolated = true',
    'let unsafe = 1',
    'value.unsafe = true',
    'let isUnsafe = pointer.unsafe',
    '@safety struct Odd {}',
    'let data = try? load()',
    'let data = try load()',
    'let retry = 1',
    'let count = value as? Int',
    'let alias = value as Int',
    'if left != right { run() }',
    'if left !== right { run() }',
    'let no = !flag',
    'run(!flag, [!flag])',
    'let no = flag ? !other : other',
    'let block = {!flag}',
    '/* why */!flag',
    'let sum = 5 + -!flag',
    'let either = left ?? right',
    'let maybe: Int? = nil',
    'let fatalErrorCount = 0',
    'let failure = preconditionFailureMessage',
    'XCTAssertEqual(left, right)',
    'let skip = XCTSkipped',
    'let known = withKnownIssueCount',
    '@Test(.tags(.fast))',
    '#if os(iOS)',
    '#if swift(>=6.0)',
    '#if targetEnvironment(simulator)',
    '#else',
    '#endif',
    'let debug = DEBUG',
    '@MainActor func run() {}',
    '@available(iOS 17, *)',
    '@available(*, noasync)',
    'let unmanaged = 1',
    'extension Date: Identifiable {}',
  ])('`%s` is clean', (line) => {
    expect(findings(line)).toEqual([]);
  });

  it('reads `a!=b` as a comparison, as the plan’s rule has it', () => {
    expect(findings('if left!=right { run() }')).toEqual([]);
  });

  it('names a line by its first matching row', () => {
    // force-try, not force-unwrap: the `!` belongs to `try`.
    expect(findings('let data = try! load()!')).toEqual(['1:force-try']);
  });
});

describe('rows limited to test files', () => {
  // `.disabled(` is also SwiftUI's view modifier, on nearly every form.
  it.each(['Button("Save") {}.disabled(!isValid)', 'field.enabled(if: isOn)'])(
    '`%s` is clean outside a test target',
    (line) => {
      expect(
        findings(line, 'ios/Packages/FeatureUI/Sources/FormUI/Form.swift'),
      ).toEqual([]);
    },
  );

  it.each([
    'ios/Packages/DialedDomain/Tests/DialedDomainTests/VerdictTests.swift',
    'ios/Tests/AppTests/LaunchTests.swift',
    'Tests/DomainTests/Support/Fixtures.swift',
  ])('a Swift Testing trait is a finding under %s', (file) => {
    expect(findings('@Test(.disabled("flaky"))', file)).toEqual([
      '1:skipped-test',
    ]);
  });

  it.each([
    'ios/Packages/Contests/Sources/Contests/Entry.swift',
    'ios/Packages/TestsSupport/Sources/Fixture.swift',
  ])('%s is not a test target path', (file) => {
    expect(findings('@Test(.disabled("flaky"))', file)).toEqual([]);
  });
});

describe('compile-escape and debugTargets', () => {
  const source = '#if DEBUG\nlet hooks = true\n#endif';
  const debugFile =
    'ios/Packages/DialedDebugHooks/Sources/DialedDebugHooks/Hooks.swift';

  function debugFindings(
    file: string,
    debugTargets: readonly string[],
  ): string[] {
    return auditSource(file, source, { debugTargets }).map(
      (finding) => finding.kind,
    );
  }

  it('exempts #if DEBUG in a file under a debug target', () => {
    expect(debugFindings(debugFile, ['DialedDebugHooks'])).toEqual([]);
  });

  it('does not exempt it anywhere else', () => {
    expect(debugFindings(SOURCE_FILE, ['DialedDebugHooks'])).toEqual([
      'compile-escape',
    ]);
    expect(debugFindings(debugFile, [])).toEqual(['compile-escape']);
    expect(debugFindings(debugFile, ['OtherHooks'])).toEqual([
      'compile-escape',
    ]);
  });

  it('holds a debug target to every other row', () => {
    expect(
      auditSource(debugFile, 'let data = try! load()', {
        debugTargets: ['DialedDebugHooks'],
      }).map((finding) => finding.kind),
    ).toEqual(['force-try']);
  });

  it('matches the target as a whole path segment', () => {
    expect(
      debugFindings('ios/Packages/DialedDebugHooksExtra/Sources/X.swift', [
        'DialedDebugHooks',
      ]),
    ).toEqual(['compile-escape']);
  });

  it('exempts only #if DEBUG, never the other compile escapes', () => {
    expect(
      auditSource(
        debugFile,
        '#if false\n#endif\n#if canImport(UIKit)\n#endif',
        {
          debugTargets: ['DialedDebugHooks'],
        },
      ).map((finding) => finding.kind),
    ).toEqual(['compile-escape', 'compile-escape']);
  });
});

/**
A directive-class row: the kind and the text of a comment that is the escape.
*/
type DirectiveRow = readonly [kind: string, directive: string];

const DIRECTIVE_ROWS: readonly DirectiveRow[] = [
  ['swiftlint-disable', 'swiftlint:disable force_cast'],
  ['swiftlint-disable', 'swiftlint:disable:next force_cast'],
  ['swiftlint-disable', 'swiftlint:disable:this force_cast'],
  ['swiftlint-disable', 'swiftlint:disable:previous force_cast'],
  ['swiftlint-disable', 'swiftlint:disable all'],
  ['swiftformat-disable', 'swiftformat:disable redundantSelf'],
  ['swiftformat-disable', 'swiftformat:disable:next redundantSelf'],
  ['swiftformat-disable', 'swiftformat:disable all'],
  ['swiftformat-disable', 'swiftformat:options --indent 2'],
  ['swift-format-ignore', 'swift-format-ignore'],
  ['swift-format-ignore', 'swift-format-ignore: NeverForceUnwrap'],
  ['swift-format-ignore', 'swift-format-ignore-file'],
  ['periphery-ignore', 'periphery:ignore'],
  ['periphery-ignore', 'periphery:ignore:all'],
  ['periphery-ignore', 'periphery:ignore:parameters unusedOne,unusedTwo'],
  [
    'mutation-suppress',
    'guardrails-mutate:disable-next-line EqualityOperator -- equivalent',
  ],
  ['mutation-suppress', 'guardrails-mutate:disable'],
  ['mutation-suppress', 'muter:disable'],
  ['mutation-suppress', 'muter:enable'],
  // Unverified against ast-grep itself: its documentation was unreachable
  // from the build environment. See QUESTIONS.md.
  ['ast-grep-ignore', 'ast-grep-ignore'],
  ['ast-grep-ignore', 'ast-grep-ignore: no-force-unwrap'],
];

describe.each(DIRECTIVE_ROWS)('%s: `%s`', (kind, directive) => {
  it('is a finding where it leads a comment, of any kind', () => {
    expect(
      findings(
        [
          `// ${directive}`,
          `let value = 1 // ${directive}`,
          `/* ${directive} */`,
          `/// ${directive}`,
        ].join('\n'),
      ),
    ).toEqual([`1:${kind}`, `2:${kind}`, `3:${kind}`, `4:${kind}`]);
  });

  it('is a finding on a line of a block comment that spans lines', () => {
    expect(findings(['/*', ` ${directive}`, ' */'].join('\n'))).toEqual([
      `2:${kind}`,
    ]);
  });

  it('is not a finding as code, in a string, a multi-line string, a raw string or an interpolation', () => {
    expect(
      findings(
        [
          `let one = "${directive}"`,
          'let many = """',
          directive,
          '"""',
          `let raw = #"${directive}"#`,
          String.raw`let text = "a \(` + '`' + directive + '`) b"',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('is not a finding in a backtick identifier', () => {
    expect(findings('func `' + directive + '`() {}')).toEqual([]);
  });
});

describe('directive rows: where the directive has to sit', () => {
  it.each([
    ['periphery-ignore', 'periphery:ignore'],
    ['swift-format-ignore', 'swift-format-ignore'],
    ['mutation-suppress', 'guardrails-mutate:disable'],
    ['mutation-suppress', 'muter:disable'],
    ['ast-grep-ignore', 'ast-grep-ignore'],
  ])(
    '%s must lead its comment: prose that names it is clean',
    (_kind, directive) => {
      expect(findings(`// we removed the ${directive} comment`)).toEqual([]);
    },
  );

  it.each([
    ['swiftlint-disable', 'swiftlint:disable:next force_cast'],
    ['swiftformat-disable', 'swiftformat:disable redundantSelf'],
  ])(
    '%s is honoured by its tool anywhere in a comment, so it is a finding there',
    (kind, directive) => {
      // Both tools search the comment for their marker; see the design.
      expect(findings(`// see ${directive}`)).toEqual([`1:${kind}`]);
    },
  );

  it.each([
    'swiftlint:enable force_cast',
    'swiftlint:disabled',
    'swiftformat:enable redundantSelf',
    'swiftformat:sort',
    'swiftformat:disabled',
    'swift-format-ignored',
    'periphery:ignored',
    'periphery:override kind="X"',
    'guardrails-mutate:disabled',
    'muter:disabled',
    'ast-grep-ignored',
    'Stryker disable all',
    'eslint-disable-next-line no-console',
    'fallow-ignore-next-line',
  ])('`// %s` is clean in a Swift file', (comment) => {
    expect(findings(`// ${comment}`)).toEqual([]);
  });
});

describe('build-setting-escape: Package.swift and project.yml only', () => {
  it.each([
    'swiftSettings: [.unsafeFlags(["-Onone"])],',
    '.unsafeFlags(flags)',
    'let flags = ["-suppress-warnings"]',
    'let flags = ["-no-warnings-as-errors"]',
    '.treatAllWarnings(as: .warning),',
    '.treatAllWarnings (as: .warning),',
    '.treatAllWarnings( as: .warning),',
    '.treatAllWarnings(as:.warning),',
    '.treatWarning("DeprecatedDeclaration", as: .warning),',
    '.treatWarning ("DeprecatedDeclaration", as: .warning),',
    '.swiftLanguageMode(.v5),',
    '.swiftLanguageMode (.v5),',
    '.swiftLanguageMode( .v4 )',
    'let flags = ["-strict-concurrency=minimal"]',
    'let flags = ["-strict-concurrency=targeted"]',
    'let flags = ["-Onone"]',
  ])('`%s` is a finding in Package.swift', (line) => {
    expect(findings(line, PACKAGE_FILE)).toEqual(['1:build-setting-escape']);
  });

  it.each([
    '      SWIFT_TREAT_WARNINGS_AS_ERRORS: NO',
    '      SWIFT_TREAT_WARNINGS_AS_ERRORS:NO',
    '      SWIFT_TREAT_WARNINGS_AS_ERRORS:  NO',
    '      SWIFT_STRICT_CONCURRENCY: minimal',
    '      OTHER_SWIFT_FLAGS: -suppress-warnings',
    '      OTHER_SWIFT_FLAGS: "-Onone"',
  ])('`%s` is a finding in project.yml', (line) => {
    expect(findings(line, PROJECT_FILE)).toEqual(['1:build-setting-escape']);
  });

  it.each([
    '.swiftLanguageMode(.v6),',
    '.treatAllWarnings(as: .error),',
    'let flags = ["-strict-concurrency=complete"]',
    '.enableUpcomingFeature("ExistentialAny"),',
    'let optimised = "-O"',
  ])('`%s` is clean in Package.swift', (line) => {
    expect(findings(line, PACKAGE_FILE)).toEqual([]);
  });

  it.each([
    '      SWIFT_TREAT_WARNINGS_AS_ERRORS: YES',
    '      SWIFT_VERSION: 6.0',
    '      # SWIFT_TREAT_WARNINGS_AS_ERRORS: NO',
    '      SWIFT_VERSION: 6.0 # was -suppress-warnings',
  ])('`%s` is clean in project.yml', (line) => {
    expect(findings(line, PROJECT_FILE)).toEqual([]);
  });

  it('reads a project.yml at the repository root too', () => {
    expect(
      findings('SWIFT_STRICT_CONCURRENCY: minimal', 'project.yml'),
    ).toEqual(['1:build-setting-escape']);
    expect(
      findings('SWIFT_STRICT_CONCURRENCY: minimal', 'notproject.yml'),
    ).toEqual([]);
  });

  it('is not a finding in a comment of Package.swift', () => {
    expect(
      findings('// .unsafeFlags(["-Onone"]) was removed', PACKAGE_FILE),
    ).toEqual([]);
  });

  it('applies to no other file', () => {
    expect(findings('let flags = ["-suppress-warnings"]')).toEqual([]);
    expect(findings('let mode = unsafeFlags', SOURCE_FILE)).toEqual([]);
    expect(
      findings('SWIFT_TREAT_WARNINGS_AS_ERRORS: NO', 'ios/other.yml'),
    ).toEqual([]);
    expect(
      findings('SWIFT_TREAT_WARNINGS_AS_ERRORS: NO', 'ios/Config/Package.yml'),
    ).toEqual([]);
  });

  it('still holds Package.swift to the ordinary Swift rows', () => {
    expect(findings('let data = try! load()', PACKAGE_FILE)).toEqual([
      '1:force-try',
    ]);
  });
});

describe('tool-config-escape, through the auditor', () => {
  it('flags an added rule under disabled_rules in .swiftlint.yml', () => {
    expect(
      findings('disabled_rules:\n  - force_cast', 'ios/.swiftlint.yml'),
    ).toEqual(['1:tool-config-escape', '2:tool-config-escape']);
  });

  it('flags --disable in .swiftformat and retain_* in .periphery.yml', () => {
    expect(findings('--disable redundantSelf', 'ios/.swiftformat')).toEqual([
      '1:tool-config-escape',
    ]);
    expect(findings('retain_public: true', 'ios/.periphery.yml')).toEqual([
      '1:tool-config-escape',
    ]);
  });

  it('reads the key above a hunk from the post-change file', () => {
    const diff = [
      '+++ b/ios/.swiftlint.yml',
      '@@ -3,0 +3,1 @@',
      '+  - force_cast',
    ].join('\n');
    const under = (key: string): string[] =>
      auditDiff(diff, {
        readSource: () => `${key}:\n  - todo\n  - force_cast\n`,
      }).map((finding) => `${String(finding.line)}:${finding.kind}`);
    expect(under('disabled_rules')).toEqual(['3:tool-config-escape']);
    expect(under('opt_in_rules')).toEqual([]);
  });

  it('reports the trimmed line as the finding’s text', () => {
    expect(
      auditSource('ios/.swiftformat', '  --exclude Generated  ')[0]?.text,
    ).toBe('--exclude Generated');
  });
});

describe('a hunk that begins inside a comment or a string', () => {
  const file = SOURCE_FILE;
  const source = [
    '/*',
    ' a long comment',
    ' let data = try! load()',
    ' */',
    'let x = 1',
  ].join('\n');
  const diff = [
    `+++ b/${file}`,
    '@@ -3,0 +3,1 @@',
    '+ let data = try! load()',
  ].join('\n');

  it('reads the state at the hunk’s first line from the post-change file', () => {
    expect(auditDiff(diff, { readSource: () => source })).toEqual([]);
  });

  it('treats the line as code when the file cannot be read: over-match rather than miss', () => {
    // Documented limit: the diff alone cannot say the hunk begins inside a
    // block comment.
    expect(
      auditDiff(diff, { readSource: unreadable }).map(
        (finding) => finding.kind,
      ),
    ).toEqual(['force-try']);
    expect(auditDiff(diff).map((finding) => finding.kind)).toEqual([
      'force-try',
    ]);
  });

  it('asks for the file the hunk belongs to', () => {
    const asked: string[] = [];
    auditDiff(diff, {
      readSource: (path) => {
        asked.push(path);
        return source;
      },
    });
    expect(asked).toEqual([file]);
  });

  it('carries the state across the context and added lines of one hunk', () => {
    const hunk = [
      `+++ b/${file}`,
      '@@ -1,2 +1,4 @@',
      ' /*',
      '+ let data = try! load()',
      ' */',
      '+let other = try! load()',
    ].join('\n');
    expect(
      auditDiff(hunk).map(
        (finding) => `${String(finding.line)}:${finding.kind}`,
      ),
    ).toEqual(['4:force-try']);
  });

  it('reads a context line without reporting it, whatever it holds', () => {
    const hunk = [
      `+++ b/${file}`,
      '@@ -1,2 +1,3 @@',
      ' let old = try! load()',
      '+let fine = 1',
      ' let older = value as! Int',
    ].join('\n');
    expect(auditDiff(hunk)).toEqual([]);
    const config = [
      '+++ b/ios/.swiftlint.yml',
      '@@ -1,2 +1,3 @@',
      ' disabled_rules:',
      '   - todo',
      '+strict: true',
    ].join('\n');
    expect(auditDiff(config)).toEqual([]);
  });

  it('does not let a removed line change the state', () => {
    const hunk = [
      `+++ b/${file}`,
      '@@ -1,3 +1,2 @@',
      '-/*',
      '+let data = try! load()',
      ' let x = 1',
    ].join('\n');
    expect(auditDiff(hunk).map((finding) => finding.kind)).toEqual([
      'force-try',
    ]);
  });

  it('starts each hunk and each file afresh', () => {
    const two = [
      `+++ b/${file}`,
      '@@ -1,0 +1,1 @@',
      '+/* an unterminated comment',
      '@@ -9,0 +10,1 @@',
      '+let data = try! load()',
      '+++ b/ios/Other.swift',
      '@@ -1,0 +1,1 @@',
      '+let more = try! load()',
    ].join('\n');
    expect(
      auditDiff(two).map(
        (finding) => `${finding.file}:${String(finding.line)}`,
      ),
    ).toEqual([`${file}:10`, 'ios/Other.swift:1']);
  });
});

describe('Swift is opt-in by file, and inert everywhere else', () => {
  const swiftOnlyLines = [
    'let data = try! load()',
    'let count = value as! Int',
    'let count = value!',
    'final class Box: @unchecked Sendable {}',
    '#if DEBUG',
    'fatalError("no")',
    '// swiftlint:disable force_cast',
    '// periphery:ignore',
    '@available(*, unavailable)',
    'let flags = ["-suppress-warnings"]',
  ];

  it.each(['src/a.ts', 'src/a.tsx', 'src/a.js', 'src/A.java'])(
    'no Swift row matches a line of %s',
    (file) => {
      expect(findings(swiftOnlyLines.join('\n'), file)).toEqual([]);
    },
  );

  it('no existing row matches a line of a .swift file', () => {
    expect(
      findings(
        [
          '// eslint-disable-next-line no-console',
          '// @ts-expect-error wrong',
          'let value = other as any',
          '@SuppressWarnings("unchecked")',
          '@Disabled',
          "it.skip('x', () => {})",
          '// Stryker disable all',
          '// fallow-ignore-next-line',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('reads a .swift extension whatever its case', () => {
    expect(findings('let data = try! load()', 'ios/App/Model.SWIFT')).toEqual([
      '1:force-try',
    ]);
  });

  it('knows every new kind, so a sanction can name it', () => {
    expect(
      [...auditKinds()].toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      'analyzer-ignore',
      'assume-isolated',
      'ast-grep-ignore',
      'availability-hide',
      'build-setting-escape',
      'cast-any',
      'compile-escape',
      'disabled-test',
      'eslint-disable',
      'fatal-stub',
      'force-cast',
      'force-try',
      'force-unwrap',
      'mutation-suppress',
      'periphery-ignore',
      'preconcurrency',
      'retroactive',
      'skipped-test',
      'suppress-warnings',
      'swift-format-ignore',
      'swiftformat-disable',
      'swiftlint-disable',
      'test-time-limit',
      'tool-config-escape',
      'ts-suppress',
      'unchecked-sendable',
      'underscored-attribute',
      'unsafe-cast',
      'unsafe-expression',
      'unsafe-isolation',
    ]);
  });
});
