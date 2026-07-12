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

interface Signature {
  kind: AuditKind;
  pattern: RegExp;
}

const SIGNATURES: readonly Signature[] = [
  { kind: 'eslint-disable', pattern: /eslint-disable(?:-next-line|-line)?\b/ },
  { kind: 'ts-suppress', pattern: /@ts-(?:ignore|expect-error|nocheck)\b/ },
  {
    kind: 'cast-any',
    pattern: /\bas\s+any\b|\bas\s+unknown\s+as\b|<any>/,
  },
  { kind: 'suppress-warnings', pattern: /@SuppressWarnings\b/ },
  { kind: 'disabled-test', pattern: /@Disabled\b/ },
  {
    kind: 'skipped-test',
    pattern:
      /\b(?:x(?:it|describe|test)|f(?:it|describe)|(?:it|test|describe|context|suite)\.(?:skip|only))\b/,
  },
];

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function matchSignature(text: string): AuditKind | undefined {
  for (const { kind, pattern } of SIGNATURES) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return undefined;
}

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
      const kind = matchSignature(text);
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
