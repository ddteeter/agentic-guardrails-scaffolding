/**
 * The Swift rows of the diff auditor (GR-04).
 *
 * `audit.ts` scans added lines for escapes; this module is what it knows
 * about Swift. It is built on the Swift lexer (`swift-lexer/`), which carries
 * its state across lines, so a row is tested against what a line really is:
 * a `directive` row against the content of each comment, a `code` row
 * against the code (the code of a string interpolation included), and never
 * against the text of a string, a regex literal or a backtick identifier.
 *
 * Every pattern below is as small as it can be while still matching what it
 * must. A fragment a test cannot tell apart from its absence (an optional
 * group after a `\b`, a quantifier nothing depends on) is not written, for
 * the reason the rest of this package gives: it would be a mutant no test
 * can kill.
 */

import { withoutComment } from './audit-tool-config.js';
import {
  SWIFT_INITIAL_STATE,
  type SwiftLineLex,
  type SwiftToken,
  lexSwiftLine,
  swiftStateAtLine,
} from './swift-lexer/index.js';

/**
The kinds a Swift row can report. Two are shared with the existing table.
*/
export type SwiftAuditKind =
  | 'swiftlint-disable' // // swiftlint:disable[:next|:this|:previous]
  | 'swiftformat-disable' // // swiftformat:disable | swiftformat:options
  | 'swift-format-ignore' // // swift-format-ignore[-file]
  | 'periphery-ignore' // // periphery:ignore[:all|:parameters]
  | 'mutation-suppress' // // guardrails-mutate:disable… | muter:disable
  | 'ast-grep-ignore' // // ast-grep-ignore
  | 'unchecked-sendable' // @unchecked Sendable
  | 'unsafe-isolation' // nonisolated(unsafe)
  | 'preconcurrency' // @preconcurrency
  | 'assume-isolated' // .assumeIsolated
  | 'unsafe-expression' // unsafe <expr>, @unsafe, @safe
  | 'force-try' // try!
  | 'force-cast' // as!
  | 'force-unwrap' // value!, T!
  | 'fatal-stub' // fatalError(…) and kin
  | 'skipped-test' // XCTSkip, .disabled(…), withKnownIssue
  | 'test-time-limit' // .timeLimit(…)
  | 'compile-escape' // #if DEBUG | false | canImport | …TEST…
  | 'underscored-attribute' // @_spi, @_exported, …
  | 'unsafe-cast' // unsafeBitCast, Unmanaged, …
  | 'retroactive' // @retroactive
  | 'availability-hide' // @available(*, unavailable | deprecated)
  | 'build-setting-escape'; // unsafeFlags, -suppress-warnings, …

/**
 * How a row is matched.
 *
 * - `directive`: against the content of each comment on the line.
 * - `code`: against the line's code.
 * - `setting`: against the code AND the text of each string literal, because
 *   a compiler flag in `Package.swift` is a string (`["-Onone"]`). Only ever
 *   applied to a package manifest or an XcodeGen project file.
 * - `token`: a rule over the token stream, for what no pattern can say.
 */
interface PatternRow {
  kind: SwiftAuditKind;
  class: 'directive' | 'code' | 'setting';
  /**
  Any one of these matching is the escape.
  */
  patterns: readonly RegExp[];
}

type Row = PatternRow | { kind: 'force-unwrap'; class: 'token' };

/**
 * Which files a row is held against. Absent means every Swift file.
 *
 * - `tests`: only a file under a test target.
 * - `outside-debug-targets`: every file but one under a debug target.
 * - `manifest`: only `Package.swift`.
 */
type Scope = 'tests' | 'outside-debug-targets' | 'manifest';

type ScopedRow = Row & { scope?: Scope };

function directive(kind: SwiftAuditKind, ...patterns: RegExp[]): PatternRow {
  return { kind, class: 'directive', patterns };
}

function code(kind: SwiftAuditKind, ...patterns: RegExp[]): PatternRow {
  return { kind, class: 'code', patterns };
}

function within(scope: Scope, row: Row): ScopedRow {
  return { ...row, scope };
}

/**
 * Build settings that turn the compiler's strictness down: the textual half
 * of what the `swift-settings` analyzer will check semantically. Applied to
 * `Package.swift` and to an XcodeGen `project.yml`, and to nothing else.
 */
function settingPatterns(): RegExp[] {
  return [
    /\bunsafeFlags\b/,
    /-suppress-warnings\b/,
    /-no-warnings-as-errors\b/,
    /\btreatWarning\s*\(/,
    /\btreatAllWarnings\s*\(\s*as:\s*\.warning\b/,
    /\bswiftLanguageMode\s*\(\s*\.v[45]\b/,
    /strict-concurrency=(?:minimal|targeted)\b/,
    /-Onone\b/,
    /\bSWIFT_TREAT_WARNINGS_AS_ERRORS:\s*NO\b/,
    /\bSWIFT_STRICT_CONCURRENCY\b/,
  ];
}

/**
 * Every Swift row, in the order a line is tested against them: the first
 * that matches names the line. A row is one kind and every pattern that
 * means it.
 *
 * COMMENT DIRECTIVES. SwiftLint and SwiftFormat each search a comment for
 * their marker and read the command from there (their own sources:
 * `comment.range(of: "swiftlint:")`, `comment.range(of: "swiftformat:")`), so
 * `// see swiftlint:disable:next force_cast` is a live suppression and those
 * two rows are not anchored. Periphery only honours a command that starts
 * its comment, and the rest follow it. `swiftlint:enable` and
 * `swiftformat:enable` turn checking back on and are not escapes;
 * `muter:enable` is listed with `muter:disable` as the two halves of one
 * region, the way the Stryker row treats `restore`.
 *
 * CONCURRENCY AND MEMORY SAFETY. Acknowledgements the compiler accepts
 * without complaint, which is why the auditor has to see them. `unsafe` the
 * expression marker is not `unsafe` the name: something has to follow it,
 * and nothing may qualify it (`x.unsafe`, `isUnsafe`).
 *
 * CRASHES WRITTEN AS OPERATORS. `force-unwrap` comes after `try!` and `as!`
 * so that their `!` is named for what it is.
 *
 * TESTS. Skipped, expected to fail, or given a deadline. Swift Testing's
 * `.disabled(…)` and `.enabled(if:)` traits are held only under a test
 * target: `.disabled(` is also SwiftUI's view modifier, on nearly every form,
 * and a row that flagged it in a view would block ordinary code with no way
 * past but a sanction per call.
 *
 * CONDITIONAL COMPILATION. `#if DEBUG` is exempt in a file under one of the
 * stack's `debugTargets`; the other conditions never are.
 */
function allRows(): ScopedRow[] {
  return [
    directive('swiftlint-disable', /swiftlint:disable\b/),
    directive('swiftformat-disable', /swiftformat:(?:disable|options)\b/),
    directive('swift-format-ignore', /^swift-format-ignore\b/),
    directive('periphery-ignore', /^periphery:ignore\b/),
    directive(
      'mutation-suppress',
      /^guardrails-mutate:disable\b/,
      /^muter:(?:disable|enable)\b/,
    ),
    directive('ast-grep-ignore', /^ast-grep-ignore\b/),
    code('unchecked-sendable', /@unchecked\s+Sendable\b/),
    code('unsafe-isolation', /\bnonisolated\s*\(\s*unsafe\s*\)/),
    code('preconcurrency', /@preconcurrency\b/),
    code('assume-isolated', /\.assumeIsolated\b/, /\bassumeIsolated\s*\{/),
    code('unsafe-expression', /(?<![\w.])unsafe\s+[\w(]/, /@(?:un)?safe\b/),
    code('force-try', /\btry!/),
    code('force-cast', /\bas!/),
    { kind: 'force-unwrap', class: 'token' },
    code(
      'fatal-stub',
      /\b(?:fatalError|preconditionFailure|unimplemented)\s*\(/,
    ),
    code(
      'skipped-test',
      /\bXCTSkip(?:If|Unless)?\b/,
      /\bXCTExpectFailure\b/,
      /\bwithKnownIssue\s*[({]/,
    ),
    code('test-time-limit', /\.timeLimit\s*\(/),
    within(
      'tests',
      code('skipped-test', /\.disabled\s*\(/, /\.enabled\s*\(\s*if:/),
    ),
    within(
      'outside-debug-targets',
      code('compile-escape', /#if\s+(?:!\s*)?DEBUG\b/),
    ),
    code('compile-escape', /#if\s+(?:false\b|(?:!\s*)?canImport\b|\w*TEST)/),
    code('underscored-attribute', /@_\w/),
    code(
      'unsafe-cast',
      /\bunsafe(?:BitCast|Downcast)\b/,
      /\b(?:Unmanaged|withoutActuallyEscaping)\b/,
    ),
    code('retroactive', /@retroactive\b/),
    code(
      'availability-hide',
      /@available\s*\(\s*\*\s*,\s*(?:unavailable|deprecated)\b/,
    ),
    within('manifest', {
      kind: 'build-setting-escape',
      class: 'setting',
      patterns: settingPatterns(),
    }),
  ];
}

/**
What decides which rows a Swift file is held to.
*/
interface FileTraits {
  /**
  `Package.swift`: the settings rows apply.
  */
  isPackageManifest: boolean;
  /**
  Under a test target: the Swift Testing trait rows apply.
  */
  isTestFile: boolean;
  /**
  Under a debug target: `#if DEBUG` is what the target is for.
  */
  isDebugTarget: boolean;
}

function isHeldTo(row: ScopedRow, traits: FileTraits): boolean {
  if (row.scope === 'tests') {
    return traits.isTestFile;
  }
  if (row.scope === 'manifest') {
    return traits.isPackageManifest;
  }
  // Unscoped, or everywhere but a debug target.
  return row.scope === undefined || !traits.isDebugTarget;
}

/**
 * Every kind a Swift row can report. `audit.ts` adds these to
 * `auditKinds()`, which is what lets a sanction name one.
 */
export function swiftAuditKinds(): SwiftAuditKind[] {
  return allRows().map((row) => row.kind);
}

const UNWRAPPED_CLOSERS: ReadonlySet<string> = new Set([')', ']', '?', '>']);

/**
 * A postfix `!`: the lexer hands back a lone `!` only where one is bound to
 * what precedes it, so this asks what that is. An identifier (`value!`,
 * `UILabel!`), a closing bracket (`make()!`, `list[0]!`, `Set<Int>!`) or a
 * postfix `?` is an operand being unwrapped; an opening bracket, a comma or
 * another operator means the `!` is a prefix `not` (`f(!flag)`).
 */
function isForceUnwrap(token: SwiftToken): boolean {
  const { previous } = token;
  return (
    token.text === '!' &&
    !token.hasSpaceBefore &&
    previous !== undefined &&
    (previous.kind === 'identifier' || UNWRAPPED_CLOSERS.has(previous.text))
  );
}

/**
 * The line's code as a `code` row reads it: the lexer's, less the backtick
 * identifiers. `` `try! load()` `` is a NAME (Swift 6.2 lets a test be
 * called that), so what it spells is a mention, not an escape. The backtick
 * is in no other code token, so each identifier's text is found exactly
 * where it stands (a string or comment that holds one is not in the code to
 * begin with, so removing its text removes nothing).
 */
function auditedCode(lexed: SwiftLineLex): string {
  let code = lexed.code;
  for (const token of lexed.tokens) {
    if (token.text.includes('`')) {
      code = code.replace(token.text, '');
    }
  }
  return code;
}

function isAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isMatch(row: Row, lexed: SwiftLineLex): boolean {
  switch (row.class) {
    case 'directive': {
      return lexed.comments.some((comment) => isAny(row.patterns, comment));
    }
    case 'code': {
      return isAny(row.patterns, auditedCode(lexed));
    }
    case 'setting': {
      return (
        isAny(row.patterns, lexed.code) ||
        lexed.tokens.some(
          (token) => token.kind === 'string' && isAny(row.patterns, token.text),
        )
      );
    }
    case 'token': {
      return lexed.tokens.some((token) => isForceUnwrap(token));
    }
  }
}

/**
 * One file's rule, fed the post-change lines of a hunk in order, context
 * lines included: each line moves the state the next is read in. Whether an
 * escape is a FINDING is the caller's to say (only on an added line).
 */
export interface SwiftLineAuditor {
  /**
  Read the next line; the kind of escape it holds, if it holds one.
  */
  line(text: string): SwiftAuditKind | undefined;
}

/**
What the auditor has to be told about the hunk it is about to read.
*/
export interface SwiftHunk {
  /**
   * The post-change lines above the hunk, or `undefined` when the file could
   * not be read. Without them the hunk is read as if it began in code: a
   * first line that is really inside a multi-line comment or string is then
   * over-matched rather than missed.
   */
  above: readonly string[] | undefined;
  /**
  The `debugTargets` of the repository's Swift stacks, when it has any.
  */
  debugTargets: readonly string[] | undefined;
}

/**
 * The auditor for one hunk of the Swift file `file` (a repo-relative POSIX
 * path).
 *
 * A file is under a test target when one of its path segments ends in
 * `Tests` (`Tests/`, `DialedDomainTests/`), and under a debug target when
 * one of them IS a debug target's name. Path segments, because the auditor
 * has no build graph to ask: SwiftPM puts a target's sources in a directory
 * named for it.
 */
export function swiftAuditor(file: string, hunk: SwiftHunk): SwiftLineAuditor {
  const segments = file.split('/');
  const traits: FileTraits = {
    isPackageManifest: segments.at(-1) === 'Package.swift',
    isTestFile: segments.some((segment) => segment.endsWith('Tests')),
    isDebugTarget: segments.some(
      (segment) => hunk.debugTargets?.includes(segment) === true,
    ),
  };
  const rows = allRows().filter((row) => isHeldTo(row, traits));
  let state =
    hunk.above === undefined
      ? SWIFT_INITIAL_STATE
      : swiftStateAtLine(hunk.above.join('\n'), hunk.above.length + 1);
  return {
    line: (text) => {
      const lexed = lexSwiftLine(text, state);
      state = lexed.state;
      return rows.find((row) => isMatch(row, lexed))?.kind;
    },
  };
}

/**
 * The auditor for an XcodeGen `project.yml`: the settings rows, against each
 * line without its `#` comment. Every line stands alone.
 */
export function xcodegenAuditor(): SwiftLineAuditor {
  const patterns = settingPatterns();
  return {
    line: (text) =>
      isAny(patterns, withoutComment(text))
        ? 'build-setting-escape'
        : undefined,
  };
}
