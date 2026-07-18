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
  | 'skipped-test'; // TS/JS: .skip / .only / xit / fit

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
 * `/* *\/`-style block comments that span multiple diff lines — a suppression
 * hidden inside the body of a multi-line block comment addition would not be
 * matched against `commentContent`. Directive signatures still require a
 * comment-leading token on the same line, so this only under-matches (never
 * over-matches) relative to a full lexer.
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
 */
interface LineLex {
  /** Trimmed content of a line-leading/only `//` or single-line `/* *\/` comment, if any. */
  commentContent: string | undefined;
  /** The line with all string-literal and comment spans blanked out. */
  code: string;
}

function isQuoteChar(ch: string): boolean {
  return ch === "'" || ch === '"' || ch === '`';
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

/** Lex one line into its comment content (if it starts a comment) and code-only text. */
function lexLine(text: string): LineLex {
  let code = '';
  let commentContent: string | undefined;
  let index = 0;
  const length = text.length;

  while (index < length) {
    const ch = text.charAt(index);
    if (isQuoteChar(ch)) {
      index = findStringEnd(text, index, ch);
      continue;
    }
    if (text.startsWith('//', index)) {
      commentContent = text.slice(index + 2).trim();
      break;
    }
    if (text.startsWith('/*', index)) {
      const block = scanBlockComment(text, index);
      // Only treat as the line's "leading comment" if nothing but whitespace
      // precedes it — matches the directive brief's `/* eslint-disable */`
      // example without misreading trailing block comments as leading ones.
      if (commentContent === undefined && code.trim() === '') {
        commentContent = block.content;
      }
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

  return { commentContent, code };
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
  const { commentContent, code } = lexLine(text);
  for (const signature of SIGNATURES) {
    if (signature.class === 'directive') {
      if (
        commentContent !== undefined &&
        signature.pattern.test(commentContent)
      ) {
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
