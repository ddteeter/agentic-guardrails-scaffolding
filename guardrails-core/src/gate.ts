/**
 * Gate composition (§2.1 + §2.3). Wires verify + the diff-auditor + the
 * decision engine + persistence into the Stop-boundary control loop, and is
 * the shared core both the Claude Code stop-gate and the Copilot commit-gate
 * call. Every shell-out goes through the injected `Exec`.
 *
 * The auditor is snapshot-based, not SubagentStop-based, so the identical
 * mechanism works at the Copilot commit gate: at the first delegation of a fix
 * loop we snapshot the suppressions already present in the working diff; every
 * subsequent cycle flags only suppressions absent from that baseline — i.e. the
 * ones the fixer added — and surfaces them as violations so they flow through
 * the normal escalation ladder.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { auditDiff, type AuditFinding } from './audit.js';
import type { Exec } from './exec.js';
import {
  decideGate,
  type GateConfig,
  type GateDecision,
} from './gate-decision.js';
import {
  loadRecurrence,
  loadSession,
  manifestFile,
  saveRecurrence,
  saveSession,
  stateDirectory,
  writeViolations,
} from './state-store.js';
import type { Violation } from './violation.js';
import { runVerify } from './verify/index.js';

export interface StopGateOptions {
  repoRoot: string;
  sessionId: string;
  baseBranch: string;
  exec: Exec;
  config: GateConfig;
  resolveBin?: (tool: string) => string;
}

export interface StopGateResult {
  decision: GateDecision;
  auditFindings: AuditFinding[];
}

function findingKey(finding: AuditFinding): string {
  return `${finding.file}|${finding.kind}|${finding.text}`;
}

function snapshotFile(directory: string, sessionId: string): string {
  return path.join(directory, `${sessionId}.pre-fix.json`);
}

function readSnapshot(file: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // Filter to strings rather than casting — consistent with the strict
    // validation in state-store, and keeps the baseline a true Set<string>.
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

async function workingDiff(options: StopGateOptions): Promise<string> {
  // Deliberately `git diff HEAD` (uncommitted working-tree changes), NOT the
  // baseBranch range that `verify` uses. The fixer's edits are uncommitted, so
  // this is exactly the surface the auditor must inspect. A suppression that was
  // committed in an earlier turn is already past this point — it would have been
  // audited while it was uncommitted, and the Copilot commit-gate re-checks the
  // staged diff at commit time.
  const result = await options.exec('git', ['diff', 'HEAD'], {
    cwd: options.repoRoot,
  });
  return result.stdout;
}

function toViolation(finding: AuditFinding): Violation {
  return {
    ruleId: 'guardrails/added-suppression',
    file: finding.file,
    line: finding.line,
    message: `Fixer added a forbidden ${finding.kind}: ${finding.text}`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

export async function runStopGate(
  options: StopGateOptions,
): Promise<StopGateResult> {
  const { repoRoot, sessionId, baseBranch, exec, config } = options;
  const directory = stateDirectory(repoRoot);
  const session = loadSession(directory, sessionId);
  const recurrence = loadRecurrence(directory);

  const snapshotPath = snapshotFile(directory, sessionId);
  const hadSnapshot = existsSync(snapshotPath);
  const baseline = readSnapshot(snapshotPath);

  const diff = await workingDiff(options);
  const auditFindings = auditDiff(diff).filter(
    (finding) => !baseline.has(findingKey(finding)),
  );

  const verifyOptions = {
    repoRoot,
    baseBranch,
    exec,
    ...(options.resolveBin ? { resolveBin: options.resolveBin } : {}),
  };
  const { violations } = await runVerify(verifyOptions);
  const combined = [
    ...violations,
    ...auditFindings.map((finding) => toViolation(finding)),
  ];

  writeViolations(directory, sessionId, combined);
  const manifestPath = path.relative(
    repoRoot,
    manifestFile(directory, sessionId),
  );

  const decision = decideGate({
    violations: combined,
    session,
    recurrence,
    manifestPath,
    config,
  });

  saveSession(directory, sessionId, decision.nextSession);
  saveRecurrence(directory, decision.nextRecurrence);

  if (decision.outcome === 'delegate') {
    // Snapshot the pre-fix suppression baseline once per fix loop.
    if (!hadSnapshot) {
      const keys = auditDiff(diff).map((finding) => findingKey(finding));
      writeFileSync(snapshotPath, JSON.stringify(keys));
    }
  } else {
    // Loop ended (clean or escalate) — drop the baseline.
    rmSync(snapshotPath, { force: true });
  }

  return { decision, auditFindings };
}

/** Combine the block message and any behavioral correction for a hook reason. */
export function stopHookReason(decision: GateDecision): string {
  return decision.additionalContext === undefined
    ? decision.message
    : `${decision.message}\n\n${decision.additionalContext}`;
}
