/**
 * Deriving a sanction entry, WITHOUT installing it (#75).
 *
 * `sanctionedSuppressions` is the one thing a blocked agent routinely needs and
 * the one thing the fixer subagent cannot touch: `guardrails.config.json` is
 * outside the violations manifest, so the scope-lock forbids it. That leaves
 * the main agent — the only thing that can grant itself an exemption, which is
 * why CLAUDE.md tells it to ask a human first.
 *
 * Two things went wrong in the adoption this module answers:
 *
 * 1. **No derivation path.** The key is `file|kind|text`, where `text` must
 *    match the auditor's own lexer output exactly, so a hand-written key is a
 *    guess until `sanctions-check` says otherwise. One recorded session
 *    reverse-engineered `audit.d.ts` out of `dist/` to work the format out, and
 *    then wrote 57 direct edits of the policy file from the main thread with
 *    ad-hoc heredocs.
 * 2. **No structural ask.** Whether the human is consulted was left entirely to
 *    the agent's judgment, which holds for a novel grant and slips on the ninth
 *    identical one: two grants went in with no ask, both disclosed, both of the
 *    "this is just bookkeeping" shape.
 *
 * So this derives and PRINTS. It never writes the config — there is no
 * `--apply`, deliberately: an install path is exactly the self-grant the whole
 * hatch exists to prevent. What it removes is the guessing, and what it adds is
 * the sentence the agent is supposed to bring to the developer — the key, the
 * cost, the mechanism, and how many grants of this shape the repo already
 * holds.
 *
 * Keys come from `findingKey` over findings the auditor itself produced, so an
 * entry derived here is correct by construction rather than correct if the
 * agent guessed the lexer right.
 */

import {
  type AuditFinding,
  type AuditKind,
  auditSource,
  findingKey,
} from './audit.js';
import type { SanctionedFile, SanctionedSuppression } from './config.js';
import { ADDED_SUPPRESSION_RULE, type Violation } from './violation.js';

/**
 * The whole-file grant, OFFERED rather than chosen.
 *
 * "Is this file generated?" is inferred from its path and header, and that
 * inference is a guess. It earns its place by surfacing an option a reader
 * might not consider — the recorded miss put a `cast-any` in a genuinely
 * generated file under the counted mechanism with `"count": 50`, which
 * `sanctions-check` would then police forever against a number with no reason
 * to stay at 50.
 *
 * But it must never CHOOSE. `sanctionedFiles` is the broader grant, and a
 * heuristic that led with it would hand a reader the un-counted exemption
 * pre-justified in authoritative language on a wrong guess — the precise
 * failure this command exists to prevent. So the counted entry stays the
 * proposal, and this rides beside it as a question the reader answers.
 */
interface WholeFileAlternative {
  entry: SanctionedFile;
  /**
  What the reader has to establish before preferring this to the counted entry.
  */
  question: string;
}

export interface SanctionProposal {
  file: string;
  /**
  1-indexed line of the first occurrence.
  */
  line: number;
  kind: AuditKind;
  /**
  The exact `file|kind|text` key, from the auditor's own `findingKey`.
  */
  key: string;
  /**
  Occurrences of this exact key in the whole file — the `count` a grant needs.
  */
  count: number;
  /**
  Ready-to-paste counted entry, `reason` deliberately blank. Always the proposal.
  */
  entry: SanctionedSuppression;
  /**
  What stops being checked once this is granted.
  */
  cost: string;
  /**
  What the counted mechanism costs and checks.
  */
  mechanismNote: string;
  /**
  Present only when the file READS as generated — an offer, never a verdict.
  */
  wholeFile?: WholeFileAlternative;
  /**
  How many grants of this kind the repo already holds.
  */
  precedent: number;
}

export interface SanctionProposalContext {
  readSource: (file: string) => string | undefined;
  /**
  Keyed grants already in the config, for the precedent count.
  */
  sanctions: readonly SanctionedSuppression[];
  /**
  Whole-file grants already in the config, for the precedent count.
  */
  files: readonly SanctionedFile[];
}

/**
 * What an adopter actually loses per suppression kind. Typed as a total record
 * over `AuditKind` so a new signature cannot be added to the auditor without
 * someone stating what granting it costs.
 */
const COST: Readonly<Record<AuditKind, string>> = {
  'eslint-disable':
    'the ESLint rule(s) this line names stop being enforced here, for every future edit to the line',
  'ts-suppress':
    'the type system stops reporting the error below this line — including a DIFFERENT error that appears there later',
  'cast-any':
    'the type system stops checking this value, so nothing verifies what actually crosses this boundary at runtime',
  'suppress-warnings':
    'the static-analysis warning(s) this annotation names stop being reported for the whole annotated element',
  'disabled-test':
    'this test stops running, so it can never fail again — including on a regression it was written to catch',
  'skipped-test':
    'this test stops running, so it can never fail again — including on a regression it was written to catch',
  'mutation-suppress':
    'every mutant this directive covers stops being generated, so the mutation score reads clean without them',
  'analyzer-ignore':
    'the analyzer finding this line names stops being reported here, and nothing re-checks that it is still the same finding',
};

/**
 * Directories a generator owns, and the filename infixes one stamps on its
 * output (`routeTree.gen.ts`, `schema.generated.ts`).
 *
 * Deliberately narrow, and deliberately spelled as plain substring tests rather
 * than one path regex: `sanctionedFiles` is the broader grant and CLAUDE.md
 * restricts it to generated code, so over-matching here would hand out the
 * un-counted exemption for a file a person wrote. A regex also multiplies the
 * extension alternatives (`[cm]?[jt]sx?`) into a dozen mutants no realistic
 * fixture distinguishes; the infix test covers every one of those spellings
 * with a single case.
 */
const GENERATED_DIRECTORIES: readonly string[] = ['__generated__', 'generated'];
const GENERATED_INFIXES: readonly string[] = ['.gen.', '.generated.'];

function isGeneratedPath(file: string): boolean {
  const segments = new Set(file.split('/'));
  return (
    GENERATED_DIRECTORIES.some((directory) => segments.has(directory)) ||
    GENERATED_INFIXES.some((infix) => file.includes(infix))
  );
}

/**
 * Markers generators write at the top of their output, matched case-insensitively
 * as substrings. Checked over the first few lines ONLY — a mention of
 * "auto-generated" deep in a hand-written file is prose, not provenance.
 */
const GENERATED_MARKERS: readonly string[] = [
  '@generated',
  'do not edit',
  'code generated by',
  'autogenerated',
  'auto-generated',
];

const GENERATED_HEADER_LINES = 10;

function hasGeneratedHeader(source: string): boolean {
  return source
    .split('\n')
    .slice(0, GENERATED_HEADER_LINES)
    .some((line) => {
      const lowered = line.toLowerCase();
      return GENERATED_MARKERS.some((marker) => lowered.includes(marker));
    });
}

function isGeneratedSource(file: string, source: string): boolean {
  return isGeneratedPath(file) || hasGeneratedHeader(source);
}

/**
 * Above this, one suppression repeated in one hand-written file is a pattern
 * rather than an exception — the shape #75 describes as "the point where a
 * pattern being sanctioned nine times says something about the architecture".
 */
const PATTERN_COUNT = 5;

/**
Occurrences of one exact key in a file, counted with the auditor's own lexer.
*/
function occurrencesOf(key: string, file: string, source: string): number {
  return auditSource(file, source).filter(
    (finding) => findingKey(finding) === key,
  ).length;
}

/**
Grants of this kind the config already holds, keyed and whole-file alike.
*/
function precedentFor(
  kind: AuditKind,
  context: SanctionProposalContext,
): number {
  const keyed = context.sanctions.filter(
    (sanction) => sanction.key.split('|', 2)[1] === kind,
  ).length;
  const paths = context.files.filter((file) => file.kind === kind).length;
  return keyed + paths;
}

function countedEntry(key: string, count: number): SanctionedSuppression {
  return { key, reason: '', ...(count > 1 && { count }) };
}

function mechanismNoteFor(count: number): string {
  if (count > PATTERN_COUNT) {
    return (
      `counted and re-derived against the source every run. NOTE: this key ` +
      `needs a count of ${count}. One suppression repeated ${count} times in ` +
      `one hand-written file is a pattern, not an exception — fix the ` +
      `repetition, or establish that a generator wrote it (sanctionedFiles is ` +
      `for generated code only).`
    );
  }
  return 'counted and re-derived against the source every run.';
}

/**
 * The offer's wording, addressed to the reader rather than asserted about the
 * file. "reads as generated" is the honest register for a path-and-header
 * guess; the sentence that follows tells the reader what to do when the guess
 * is wrong, which is to use the entry above and ignore this.
 */
function wholeFileQuestion(file: string, kind: AuditKind): string {
  return (
    `${file} reads as generated (by its path or its header) — is it? ` +
    `If a person maintains this file, ignore this block and take the counted ` +
    `entry above. If a GENERATOR writes it, the counted entry is the wrong ` +
    `mechanism: its count changes on every regeneration, and its pinned ` +
    `suppression text breaks the first time the generator changes its output ` +
    `shape. This grant is the BROADER one — it covers every ${kind} in this ` +
    `file, forever, with no count and nothing verifying it afterwards.`
  );
}

function toProposal(
  finding: AuditFinding,
  key: string,
  context: SanctionProposalContext,
): SanctionProposal {
  const source = context.readSource(finding.file);
  const count =
    source === undefined ? 1 : occurrencesOf(key, finding.file, source);
  const isGenerated =
    source !== undefined && isGeneratedSource(finding.file, source);
  return {
    file: finding.file,
    line: finding.line,
    kind: finding.kind,
    key,
    count,
    entry: countedEntry(key, count),
    cost: COST[finding.kind],
    mechanismNote: mechanismNoteFor(count),
    ...(isGenerated && {
      wholeFile: {
        entry: { path: finding.file, kind: finding.kind, reason: '' },
        question: wholeFileQuestion(finding.file, finding.kind),
      },
    }),
    precedent: precedentFor(finding.kind, context),
  };
}

/**
 * One proposal per distinct suppression key, in the order the findings arrive.
 * Several occurrences of one key collapse into one entry carrying the real
 * count, which is what the policy file wants and what `sanctions-check`
 * re-derives.
 */
export function proposeSanctions(
  findings: readonly AuditFinding[],
  context: SanctionProposalContext,
): SanctionProposal[] {
  const proposals: SanctionProposal[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    proposals.push(toProposal(finding, key, context));
  }
  return proposals;
}

/**
 * Recover the auditor's own findings for the added-suppression violations in a
 * manifest.
 *
 * Resolved by re-auditing the named file and matching on LINE, rather than by
 * parsing the violation's human-readable message for the suppression text. The
 * message is prose written for an agent to read; deriving a key from it would
 * reintroduce exactly the guess this command exists to remove, and would break
 * silently the day that sentence is reworded.
 *
 * A violation with no line, or whose line no longer carries a suppression, is
 * dropped: there is nothing to derive, and a guess presented as a derivation is
 * worse than no answer.
 */
export function findingsFromManifest(
  violations: readonly Violation[],
  readSource: (file: string) => string | undefined,
): AuditFinding[] {
  const wanted = new Map<string, Set<number>>();
  for (const violation of violations) {
    if (
      violation.ruleId !== ADDED_SUPPRESSION_RULE ||
      violation.line === undefined
    ) {
      continue;
    }
    const lines = wanted.get(violation.file);
    if (lines === undefined) {
      wanted.set(violation.file, new Set([violation.line]));
    } else {
      lines.add(violation.line);
    }
  }
  const findings: AuditFinding[] = [];
  for (const [file, lines] of wanted) {
    const source = readSource(file);
    if (source === undefined) {
      continue;
    }
    for (const finding of auditSource(file, source)) {
      if (lines.has(finding.line)) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

const NOTHING_TO_GRANT =
  'guardrails: no suppression in scope needs a grant. Nothing to derive.';

/**
 * The closing instruction, and the reason this command stops short of writing.
 *
 * CLAUDE.md already says to ask; #75's finding is that the instruction holds
 * for a novel grant and slips on the ninth identical one. A terse pointer that
 * names the next action is the mechanism the rest of the loop runs on, so the
 * ask is stated HERE, at the moment the entry is in the agent's hands.
 */
const ASK_FIRST: readonly string[] = [
  'NOTHING HAS BEEN WRITTEN. guardrails.config.json is not yours to edit.',
  'Ask the developer — interactively, not in a note buried in a summary — and',
  'give them the key above, why it is unavoidable (for an equivalent mutant,',
  'why no test can kill it; for anything else, what you tried first), and what',
  'it costs. Add the entry only if they say yes, and put the argument they',
  'accepted into `reason`: that text is what a reviewer reads later.',
];

function entryLines(entry: SanctionedSuppression | SanctionedFile): string[] {
  return JSON.stringify(entry, null, 2)
    .split('\n')
    .map((line) => `      ${line}`);
}

/**
 * The offer, printed BELOW the counted entry and behind a question. A reader
 * skimming this hits the proposal first and reaches the broader grant only by
 * answering "does a generator write this file?" themselves.
 */
function alternativeLines(alternative: WholeFileAlternative): string[] {
  return [
    `    ALSO CONSIDER — sanctionedFiles, only if you can establish this:`,
    `      ${alternative.question}`,
    ...entryLines(alternative.entry),
  ];
}

function proposalLines(proposal: SanctionProposal): string[] {
  return [
    `  ${proposal.file}:${proposal.line}  [${proposal.kind}]`,
    `    mechanism: sanctionedSuppressions — ${proposal.mechanismNote}`,
    `    cost:      ${proposal.cost}`,
    `    precedent: this repo already holds ${proposal.precedent} ` +
      `${proposal.kind} grant(s); this would be number ${proposal.precedent + 1}.`,
    '    entry:',
    ...entryLines(proposal.entry),
    ...(proposal.wholeFile === undefined
      ? []
      : alternativeLines(proposal.wholeFile)),
    '',
  ];
}

/**
Render derived proposals for the agent that must take them to a human.
*/
export function formatProposals(
  proposals: readonly SanctionProposal[],
): string[] {
  if (proposals.length === 0) {
    return [NOTHING_TO_GRANT];
  }
  return [
    `guardrails: ${proposals.length} suppression(s) would need a grant.`,
    '',
    ...proposals.flatMap((proposal) => proposalLines(proposal)),
    ...ASK_FIRST,
  ];
}
