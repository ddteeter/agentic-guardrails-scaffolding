/**
 * Diff-auditor (§2.3) — the deterministic backstop that closes the
 * suppression-escape hole. It scans the *added* lines of a unified diff (the
 * fixer's output, relative to a pre-fix snapshot) and rejects newly-introduced
 * suppressions, unsafe casts, and skipped/disabled tests.
 *
 * More reliable than trusting a weak-tier model not to add them: the fixer can
 * make `verify` green by weakening a test or silencing a checker, and only a
 * signature scan of the actual diff catches it.
 *
 * Pure over the diff text so the identical mechanism works at the Claude Code
 * stop-gate and the Copilot commit-gate.
 *
 * This is a single **cross-language** auditor, not a per-language one: because
 * it scans raw added diff lines for textual escape signatures, one signature
 * table covers both stacks — `eslint-disable`/`@ts-*`/`as any`/`.skip` (TS) and
 * `@SuppressWarnings`/`@Disabled`/casts (Java). New stacks add signatures here;
 * they never need a separate auditor.
 */

export type AuditKind =
  | 'eslint-disable' // TS: eslint-disable[-next-line]
  | 'ts-suppress' // TS: @ts-ignore / @ts-expect-error / @ts-nocheck
  | 'cast-any' // TS: as any / as unknown as / <any>
  | 'suppress-warnings' // Java: @SuppressWarnings
  | 'disabled-test' // Java: @Disabled
  | 'skipped-test' // TS/JS: .skip / .only / xit / fit
  | 'mutation-suppress'; // TS/JS: // Stryker disable | restore

export interface AuditFinding {
  file: string;
  /** 1-indexed line in the new (post-fix) file. */
  line: number;
  kind: AuditKind;
  /** The offending added line, trimmed. */
  text: string;
}

/**
 * `directive` signatures (eslint-disable, @ts-*) are only real when they lead
 * a comment: a human writing them as *prose* about the token, or a machine
 * emitting them inside a string/regex, does not activate the directive.
 *
 * `code` signatures (casts, Java annotations, test-skip calls) are only real
 * when they appear in the *code* portion of a line: the same token inside a
 * string literal (a test fixture asserting on diff text) or a comment
 * (a doc-comment describing the pattern) is a mention, not a suppression.
 */
type SignatureClass = 'directive' | 'code';

interface Signature {
  kind: AuditKind;
  class: SignatureClass;
  pattern: RegExp;
}

const SIGNATURES: readonly Signature[] = [
  {
    kind: 'eslint-disable',
    class: 'directive',
    pattern: /^eslint-disable(?:-next-line|-line)?\b/,
  },
  {
    kind: 'ts-suppress',
    class: 'directive',
    pattern: /^@ts-(?:ignore|expect-error|nocheck)\b/,
  },
  {
    kind: 'cast-any',
    class: 'code',
    pattern: /\bas\s+any\b|\bas\s+unknown\s+as\b|<any>/,
  },
  { kind: 'suppress-warnings', class: 'code', pattern: /@SuppressWarnings\b/ },
  { kind: 'disabled-test', class: 'code', pattern: /@Disabled\b/ },
  {
    kind: 'skipped-test',
    class: 'code',
    pattern:
      /\b(?:x(?:it|describe|test)|f(?:it|describe)|(?:it|test|describe|context|suite)\.(?:skip|only))\b/,
  },
  // stryker's mutation-suppression directives. `directive` class, so a mention
  // in prose ("we removed the Stryker disable comment") doesn't flag — only a
  // comment that LEADS with the directive does. `restore` is included because a
  // bare restore is meaningless without a matching disable: flagging both keeps
  // the pair reviewable as one sanctioned region.
  {
    kind: 'mutation-suppress',
    class: 'directive',
    pattern: /^Stryker\s+(?:disable|restore)\b/,
  },
];

/**
 * Source extensions that can meaningfully contain a real suppression.
 * Extensible: add a new extension here as new stacks are onboarded.
 */
const AUDITABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
]);

function isAuditableSourceFile(file: string): boolean {
  const dot = file.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  return AUDITABLE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

/**
 * Result of lexing a single source line into comment vs. code spans.
 *
 * Limitation (accepted): this is a single-line lexer only. It does not track
 * `/* *\/`-style block comments that span multiple diff lines — a continuation
 * line of a multi-line block/JSDoc comment carries no comment marker, so it is
 * lexed as bare code. This cuts BOTH ways relative to a full lexer:
 *   - Directive-class signatures (`eslint-disable`, `@ts-*`) require a
 *     comment-content-leading token within a single comment on the same line,
 *     so a directive hidden in a multi-line comment body is missed —
 *     an UNDER-match (false negative).
 *   - Code-class signatures (the Java suppression annotations, unchecked
 *     casts, and test-skip calls) are matched against the code span, so a
 *     continuation line that merely MENTIONS such a token in prose (e.g.
 *     idiomatic Javadoc, the Phase-D Java target) is misclassified as code —
 *     an OVER-match (false positive) that blocks a turn on legitimate
 *     documentation. This comment must therefore avoid literal code-class
 *     token examples itself (see `scanTemplateLiteral` below). A full parser
 *     that tracks open-comment state across lines is the real fix (roadmapped).
 *
 * Regex literals ARE lexed (skipped, like strings), despite the task brief's
 * simplification note that assumed no code signature appears only inside a
 * regex. Dogfooding this auditor against its own diff falsified that
 * assumption: `audit.ts`'s own `SIGNATURES` table spells `as any`,
 * `@SuppressWarnings`, and `@Disabled` as regex *source* (e.g.
 * `pattern: /@Disabled\b/`), which — left unlexed — self-matches as a `code`
 * finding on every edit to this file. `findRegexEnd` uses the standard
 * "regex vs. divide" heuristic (a `/` starts a regex when the last
 * significant character in the code accumulated so far is an operator/
 * punctuator or the line is blank so far); this repo has no arithmetic
 * division idiom that would trip it, and a misclassification only causes
 * under-matching (skipping a bit more code as a "regex"), never
 * over-matching.
 *
 * Template literals (backtick strings) are NOT wholly opaque: literal text
 * is a string span like any other quote, but a `${...}` interpolation is
 * lexed as code (see `scanTemplateLiteral`/`scanInterpolation`) — a cast or
 * suppression hidden inside an interpolation is caught, while mention tokens
 * in the surrounding template-string prose are not.
 */
interface LineLex {
  /** Trimmed content of every `//` (at most one, since it consumes the rest of
   * the line) and single-line `/* *\/` comment on the line, in source order —
   * leading or trailing, regardless of what precedes it. Each entry is tested
   * against directive signatures independently (never concatenated), so a
   * directive must start a *single* comment's content, not just appear
   * somewhere across the line's comments. */
  commentContents: readonly string[];
  /** The line with all string-literal and comment spans removed (the
   * remaining code characters are concatenated; position is not preserved). */
  code: string;
}

function isQuoteChar(ch: string): boolean {
  return ch === "'" || ch === '"';
}

interface BlockComment {
  /** Index just past the closing `*\/` (or end-of-line if unclosed). */
  end: number;
  /** Trimmed text between `/*` and `*\/`. */
  content: string;
}

/** Parse a single-line `/* *\/` block comment starting at `index`. */
function scanBlockComment(text: string, index: number): BlockComment {
  const close = text.indexOf('*/', index + 2);
  const contentEnd = close === -1 ? text.length : close;
  const end = close === -1 ? text.length : close + 2;
  return { end, content: text.slice(index + 2, contentEnd).trim() };
}

/** Lex one line into every comment's content (leading or trailing) and code-only text. */
function lexLine(text: string): LineLex {
  let code = '';
  const commentContents: string[] = [];
  let index = 0;
  const length = text.length;

  while (index < length) {
    const ch = text.charAt(index);
    if (isQuoteChar(ch) || ch === '`') {
      const span = consumeStringSpan(text, index, ch);
      code += span.code;
      index = span.end;
      continue;
    }
    if (text.startsWith('//', index)) {
      commentContents.push(text.slice(index + 2).trim());
      break;
    }
    if (text.startsWith('/*', index)) {
      const block = scanBlockComment(text, index);
      // Captured regardless of what precedes it on the line — a trailing
      // `foo(); /* eslint-disable */` is a real ESLint directive just as much
      // as a leading one.
      commentContents.push(block.content);
      index = block.end;
      continue;
    }
    if (ch === '/' && isRegexStart(code)) {
      index = findRegexEnd(text, index);
      continue;
    }
    code += ch;
    index += 1;
  }

  return { commentContents, code };
}

/**
 * Consume a string-like span — `'`, `"`, or a template literal — starting at
 * `index` (the quote/backtick char). A plain quote contributes no code (it's
 * opaque, like the rest of the lexer's string handling); a template literal
 * may contribute CODE text recovered from its `${...}` interpolations (see
 * `scanTemplateLiteral`). Kept as one dispatch point so `lexLine`'s loop has
 * a single branch for all string-like spans, not one per quote kind.
 */
function consumeStringSpan(
  text: string,
  index: number,
  ch: string,
): { end: number; code: string } {
  if (ch === '`') {
    return scanTemplateLiteral(text, index);
  }
  return { end: findStringEnd(text, index, ch), code: '' };
}

/** Find the index just past a string literal starting at `start` (the quote char). */
function findStringEnd(text: string, start: number, quote: string): number {
  let index = start + 1;
  const length = text.length;
  while (index < length) {
    if (text.charAt(index) === '\\') {
      index += 2;
      continue;
    }
    if (text.charAt(index) === quote) {
      return index + 1;
    }
    index += 1;
  }
  return length;
}

/**
 * Find the index just past a template literal starting at `start` (the
 * backtick), extracting the CODE text of any `${...}` interpolations along
 * the way. Literal text between interpolations is a string span (like other
 * quotes) and is excluded from the returned `code` — a mention hidden in the
 * literal text of a template string still resolves as a mention, while a
 * real cast or suppression hidden inside an interpolation is now visible to
 * `matchSignature`.
 *
 * (Deliberately not spelling out a live `${...}` + signature example inline
 * here: a continuation line of a multi-line `/** *\/` comment like this one is
 * NOT recognized as a comment by the single-line lexer above — see the
 * class doc's multi-line-block-comment limitation — so a literal example
 * would self-flag as a `code`-class finding on every future edit to this
 * doc comment. Dogfooding this fix against its own diff caught exactly that.)
 */
function scanTemplateLiteral(
  text: string,
  start: number,
): { end: number; code: string } {
  let index = start + 1;
  const length = text.length;
  let code = '';

  while (index < length) {
    const ch = text.charAt(index);
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '`') {
      return { end: index + 1, code };
    }
    if (ch === '$' && text.charAt(index + 1) === '{') {
      const interpolation = scanInterpolation(text, index + 1);
      code += interpolation.code;
      index = interpolation.end;
      continue;
    }
    index += 1;
  }
  return { end: length, code };
}

/**
 * Find the index just past a `${...}` interpolation's matching closing `}`,
 * given `braceIndex` (the index of the opening `{`). Returns the interpolation
 * span's code text, with its own nested string-literal spans excluded (a
 * signature token quoted as a string *inside* the interpolation is not code)
 * and brace depth tracked (an object-literal expression inside the
 * interpolation still resolves the interpolation's true end, rather than
 * closing early on the object literal's own `}`).
 *
 * (Deliberately not spelling out a live example inline — see
 * `scanTemplateLiteral`'s doc comment above for why: this line is a
 * continuation of a multi-line comment, not lexed as a comment itself.)
 *
 * Limitation (accepted): a template literal nested *inside* an interpolation
 * (`` `${`nested ${y}`}` ``) is skipped as an opaque string span (its own
 * `${...}` is not recursively lexed as code) rather than fully resolved —
 * matches the multi-line block-comment limitation above in spirit: this only
 * under-matches (never over-matches) relative to a full lexer.
 */
function scanInterpolation(
  text: string,
  braceIndex: number,
): { end: number; code: string } {
  let index = braceIndex + 1;
  const length = text.length;
  let depth = 1;
  let code = '';

  while (index < length) {
    const ch = text.charAt(index);
    if (isQuoteChar(ch) || ch === '`') {
      index = findStringEnd(text, index, ch);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      code += ch;
      index += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { end: index + 1, code };
      }
      code += ch;
      index += 1;
      continue;
    }
    code += ch;
    index += 1;
  }
  return { end: length, code };
}

/** Punctuators after which a `/` starts a regex literal, not a division. */
const REGEX_PRECEDING_PUNCTUATORS = new Set('([{,;:=!&|?+-*%^~<>');

/** True when a `/` at the end of `precedingCode` would start a regex literal. */
function isRegexStart(precedingCode: string): boolean {
  const trimmed = precedingCode.trimEnd();
  if (trimmed === '') {
    return true;
  }
  if (/\breturn$/.test(trimmed)) {
    return true;
  }
  return REGEX_PRECEDING_PUNCTUATORS.has(trimmed.at(-1) ?? '');
}

/** Find the index just past a regex literal (including flags) starting at `start` (the `/`). */
function findRegexEnd(text: string, start: number): number {
  let index = start + 1;
  const length = text.length;
  let inCharClass = false;
  while (index < length) {
    const ch = text.charAt(index);
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
    } else if (ch === ']') {
      inCharClass = false;
    } else if (ch === '/' && !inCharClass) {
      return skipRegexFlags(text, index + 1);
    }
    index += 1;
  }
  return length;
}

/** Advance past trailing regex flags (`g`, `i`, `m`, …) after the closing `/`. */
function skipRegexFlags(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[a-z]/i.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

function matchSignature(text: string): AuditKind | undefined {
  const { commentContents, code } = lexLine(text);
  for (const signature of SIGNATURES) {
    if (signature.class === 'directive') {
      if (commentContents.some((content) => signature.pattern.test(content))) {
        return signature.kind;
      }
    } else if (signature.pattern.test(code)) {
      return signature.kind;
    }
  }
  return undefined;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The `b/path` (or `a/path`) target of a `+++`/`---` header, prefix stripped. */
function headerPath(line: string): string {
  return line
    .slice(4)
    .replace(/^[ab]\//, '')
    .trim();
}

/** Scan the added lines of a unified diff for gate-cheating signatures. */
export function auditDiff(diffText: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  let file = '';
  let newLine = 0;

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = headerPath(raw);
    } else if (raw.startsWith('--- ') || raw.startsWith('diff --git')) {
      // Metadata, ignored.
    } else if (HUNK_HEADER.test(raw)) {
      newLine = Number(HUNK_HEADER.exec(raw)?.[1]);
    } else if (raw.startsWith('+')) {
      const text = raw.slice(1);
      const kind = isAuditableSourceFile(file)
        ? matchSignature(text)
        : undefined;
      if (kind) {
        findings.push({ file, line: newLine, kind, text: text.trim() });
      }
      newLine += 1;
    } else if (!raw.startsWith('-')) {
      // Context line (leading space) or blank separator advances the counter;
      // removed (`-`) lines do not and are never flagged.
      newLine += 1;
    }
  }

  return findings;
}
