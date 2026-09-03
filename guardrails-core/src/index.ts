/**
 * Public library surface of guardrails-core. The CLI (`src/cli.ts`) and the
 * shipped machinery are re-exported here; runtimes call the compiled
 * `dist/index.mjs` (or the `guardrails` bin) — never the TypeScript source.
 */
export {
  hasErrors,
  isViolation,
  recurrenceKey,
  type Severity,
  type Violation,
} from './violation.js';
export {
  createSession,
  type RecurrenceCounts,
  type SessionState,
} from './state.js';
export { auditDiff, type AuditFinding, type AuditKind } from './audit.js';
export {
  decideGate,
  type GateConfig,
  type GateDecision,
  type GateInput,
  type GateOutcome,
} from './gate-decision.js';
export {
  runStopGate,
  stopHookReason,
  type StopGateOptions,
  type StopGateResult,
} from './gate.js';
export {
  runVerify,
  type VerifyOptions,
  type VerifyResult,
} from './verify/index.js';
export { runAutofix, type AutofixOptions } from './autofix.js';
export {
  defaultConfig,
  loadConfig,
  toGateConfig,
  type RepoConfig,
  type SanctionedSuppression,
} from './config.js';
export { spawnExec, type Exec, type ExecResult } from './exec.js';
