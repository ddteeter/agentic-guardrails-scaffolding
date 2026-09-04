/**
 * The verify orchestrator (§2.2). Determines the TypeScript files a turn
 * touched, dispatches the adapters, and aggregates their output into one
 * normalized `Violation[]`. Pure Node; every shell-out goes through the
 * injected `Exec`, and tool binaries are resolved through `resolveBin` so the
 * CLI can point at the repo-local `node_modules/.bin`.
 *
 * Every analyzer declares a `scope` (see `ANALYZERS`); run-trigger and
 * check-extent are independent axes:
 *
 * - **`changed-files`** — runs only when the turn touched >=1 TS file. **ESLint**
 *   is genuinely diff-scoped: it receives the file list and lints only those.
 *   **`tsc` is changed-files-_triggered_ but whole-project-_checked_**
 *   (`-p tsconfig`), because TypeScript checking is inherently cross-file — a
 *   change in one file can surface an error in another.
 * - **`whole-project`** — runs whenever the rung is active, regardless of which
 *   files changed. knip and dependency-cruiser are whole-graph, and a
 *   dependency-only change (e.g. a `package.json` bump) still needs their
 *   hygiene checks.
 *
 * A consequence of the whole-project checks: `verify` assumes a clean baseline.
 * If the branch already has pre-existing `tsc` / knip / dependency-cruiser
 * errors, every turn will escalate on them until they're fixed (see README —
 * run `guardrails verify` clean before relying on the gate).
 *
 * A guard that RAN and then FAILED must never look like a guard that passed
 * either: eslint/tsc/knip/dependency-cruiser use a non-zero exit to report
 * *findings* (which parse into violations), so the one signal that separates a
 * crash/misconfiguration from a clean run is "non-zero exit, yet nothing
 * parsed" — `withExitCodeCheck` applies that rule uniformly. `stryker` is
 * different: absent a configured `break` threshold (this pack sets none), it
 * exits 0 even with surviving mutants, so ANY non-zero exit from it is a crash.
 * Its report is read from its own default, gitignored, cross-run-persistent
 * location (`reports/mutation/mutation.json`) — there is no CLI flag to
 * relocate it (`--jsonReporter.fileName` does not exist; only `--dashboard.*`
 * is a registered dotted option) and a `--configFile` would break
 * consumer-genericity. So `runStryker` deletes that path before every run,
 * making a stale report from a prior run unreadable, and treats a report
 * still missing afterward as `analyzer-failed` rather than clean — see
 * `runStryker`.
 */

import { readFile as fsReadFile, rm as fsRm } from 'node:fs/promises';
import path from 'node:path';

import type { Exec, ExecResult } from '../exec.js';
import { readJsonFile } from '../json-file.js';
import type { Violation } from '../violation.js';
import { loadWorkspaceResolver, withPackages } from '../workspaces.js';
import {
  type AnalyzerMode,
  analyzerMode,
  decideAnalyzer,
  declaredProviders,
} from './analyzer-policy.js';
import { parseDepcruiseJson } from './depcruise-adapter.js';
import { parseEslintJson } from './eslint-adapter.js';
import {
  isInsideNestedWorktree,
  isTestFile,
  isTypeScriptFile,
  mergeChangedFiles,
  nestedWorktreePaths,
  parseFileList,
  resolveBaseReference,
} from './git.js';
import { parseKnipJson } from './knip-adapter.js';
import { parseNpmLsJson } from './npm-peers-adapter.js';
import { parseStrykerJson } from './stryker-adapter.js';
import { parseTscOutput } from './tsc-adapter.js';

export interface VerifyOptions {
  repoRoot: string;
  baseBranch: string;
  exec: Exec;
  tsconfig?: string;
  resolveBin?: (tool: string) => string;
  /** Cadence rung. Heavy whole-graph analyzers (knip, dependency-cruiser) run
   *  only at commit/ci; the per-turn stop gate stays fast. Defaults to 'stop'. */
  profile?: 'stop' | 'commit' | 'ci';
  /**
   * Which change set the diff-scoped analyzers see.
   *
   * `'branch'` (the default) is everything since the merge-base — the right
   * question for a push or a CI run, which judge the branch as a whole.
   *
   * `'staged'` is only what is about to be committed. A pre-commit hook wants
   * this: under branch scope, stryker re-mutates every production file the
   * branch has touched on EVERY commit, so the cost of committing grows the
   * longer a branch runs. Each file is still mutation-gated in the commit that
   * changes it, and the push and CI rungs re-check the whole branch, so
   * nothing escapes — see the design doc's "Cadence rungs" section.
   */
  changedScope?: 'branch' | 'staged';
  /** File reader seam (stryker writes its JSON report to disk, not stdout).
   *  Defaults to node:fs/promises readFile; injected in tests. */
  readFile?: (filePath: string) => Promise<string>;
  /** File removal seam: `runStryker` deletes stryker's report path before
   *  every run, so a stale report from a prior run can never be mistaken for
   *  this one's. Defaults to node:fs/promises `rm` with `{ force: true }`
   *  (a missing file is not an error); injected in tests. */
  removeFile?: (filePath: string) => Promise<void>;
  /**
   * Per-analyzer opt-in (`RepoConfig.analyzers`). Absent → every analyzer is
   * `auto`. See `analyzer-policy.ts` for the truth table.
   */
  analyzers?: Readonly<Record<string, AnalyzerMode>>;
  /**
   * Package names the repo's own `package.json` declares. A provider named
   * there whose binary does not resolve is a broken install, not an opt-out.
   * Injected in tests; defaults to reading `<repoRoot>/package.json`.
   */
  declaredProviders?: ReadonlySet<string>;
}

export interface VerifyResult {
  violations: Violation[];
}

/** How much of a failed tool's stderr reaches the violation message. Five
 *  meaningful lines clears the deepest real case measured -- eslint puts its
 *  diagnosis on line 3, behind a banner and a version line -- without letting
 *  a stack trace become the whole manifest. */
const STDERR_DETAIL_LINES = 5;
const STDERR_DETAIL_CHARS = 500;

/**
 * The useful head of a tool's stderr, for a violation message that names *why*
 * the tool failed rather than just that it did. `undefined` when stderr carried
 * nothing.
 *
 * Blank lines are dropped; decorative banners are NOT. eslint's first line is
 * `Oops! Something went wrong! :(`, and teaching this function to recognise
 * that would hardcode a third-party tool's copy -- the class of coupling that
 * rots silently on upgrade, which this repo's guidance calls out by name.
 * Keeping several lines gets past every banner without knowing any of them.
 *
 * Before this, only the first line was kept, so the most likely first-adoption
 * failure -- eslint with no flat config -- reported exactly `Oops!` to an
 * unattended agent, with the actionable sentence three lines further down.
 */
function stderrDetail(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, STDERR_DETAIL_LINES);
  if (lines.length === 0) {
    return undefined;
  }
  const joined = lines.join('; ');
  return joined.length <= STDERR_DETAIL_CHARS
    ? joined
    : `${joined.slice(0, STDERR_DETAIL_CHARS)}…`;
}

/** A guard that ran and then crashed/misconfigured, distinct from
 *  `guardrails/analyzer-missing` (which means the binary never started). Named
 *  after the tool, its exit code, and — when present — the useful head of
 *  stderr, so a consumer can tell why without re-running it. */
function analyzerFailedViolation(
  tool: string,
  code: number,
  stderr: string,
): Violation {
  const head = stderrDetail(stderr);
  const detail = head === undefined ? '' : ` stderr: "${head}"`;
  return {
    ruleId: 'guardrails/analyzer-failed',
    file: 'package.json',
    message:
      `${tool} exited with code ${code} and produced no parseable violations — ` +
      `it either did not complete cleanly (a bad config, a crash, an ` +
      `unexpected flag) or reported only issue kinds this adapter does not ` +
      `map. A failed analyzer is a failed gate, not a clean one.` +
      detail,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

/**
 * eslint/tsc/knip/dependency-cruiser all use a non-zero exit to report
 * *findings* — that is the normal case and would have parsed into violations.
 * So the failure signal is the conjunction: non-zero exit AND nothing parsed.
 * `spawnFailed` is excluded because that case is reported separately as
 * `guardrails/analyzer-missing` by the caller's spawn tracking.
 */
function withExitCodeCheck(
  tool: string,
  execResult: ExecResult,
  violations: Violation[],
): Violation[] {
  if (
    execResult.spawnFailed !== true &&
    execResult.code !== 0 &&
    violations.length === 0
  ) {
    return [
      ...violations,
      analyzerFailedViolation(tool, execResult.code, execResult.stderr),
    ];
  }
  return violations;
}

/** `true` when a git invocation exited non-zero.
 *
 *  No spawn-failure guard is needed here any more: `resolveBaseReference` runs
 *  two git calls before either of these and returns early on `spawnFailed`, so
 *  by the time this is reached git has already been proven to start. Keeping a
 *  `spawnFailed !== true` half would be unreachable code that no test can
 *  exercise — and mutation testing says so. A tool that could not be STARTED is
 *  still reported only as `analyzer-missing`, never also as `analyzer-failed`. */
function gitCallFailed(result: ExecResult): boolean {
  return result.code !== 0;
}

async function changedTypeScriptFiles(
  options: VerifyOptions,
): Promise<{ files: string[]; violations: Violation[] }> {
  const { exec, repoRoot, baseBranch } = options;
  // Staged scope answers a different question -- "what is in this commit?" --
  // and answers it without a base ref at all. That is not just a shortcut: it
  // is why the pre-commit rung works unchanged on an unborn repository, where
  // there is no merge-base to resolve.
  if (options.changedScope === 'staged') {
    const staged = await exec(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
      { cwd: repoRoot },
    );
    if (staged.spawnFailed === true) {
      return { files: [], violations: [] };
    }
    if (gitCallFailed(staged)) {
      return {
        files: [],
        violations: [
          analyzerFailedViolation('git', staged.code, staged.stderr),
        ],
      };
    }
    return {
      files: parseFileList(staged.stdout).filter((file) =>
        isTypeScriptFile(file),
      ),
      violations: [],
    };
  }
  const base = await resolveBaseReference(exec, repoRoot, baseBranch);
  if (base.spawnFailed === true) {
    // A spawn failure is git being absent entirely; runVerify reports that
    // separately via its own tracker, so stay silent here rather than blaming
    // the base branch for it.
    return { files: [], violations: [] };
  }

  let tracked: ExecResult;
  if (base.ref === undefined) {
    const head = await exec(
      'git',
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      { cwd: repoRoot },
    );
    if (head.spawnFailed === true) {
      return { files: [], violations: [] };
    }
    if (head.code === 0) {
      return {
        files: [],
        violations: [unresolvableBaseViolation(baseBranch)],
      };
    }
    // An unborn repository has no base or HEAD yet. Its truthful changed set
    // is the whole index plus every untracked file; treating the absent base as
    // a configuration error would make the first guarded commit impossible.
    tracked = await exec('git', ['ls-files'], { cwd: repoRoot });
  } else {
    tracked = await exec(
      'git',
      ['diff', '--name-only', '--diff-filter=ACM', base.ref],
      { cwd: repoRoot },
    );
  }
  const untracked = await exec(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: repoRoot },
  );
  // Neither invocation's exit code carries a "findings" case (unlike the
  // analyzers above) — a non-zero git exit is always a failure.
  const failedGitCall = [tracked, untracked].find((result) =>
    gitCallFailed(result),
  );
  if (failedGitCall !== undefined) {
    return {
      files: [],
      violations: [
        analyzerFailedViolation(
          'git',
          failedGitCall.code,
          failedGitCall.stderr,
        ),
      ],
    };
  }
  const files = mergeChangedFiles(tracked.stdout, untracked.stdout).filter(
    (file) => isTypeScriptFile(file),
  );
  return { files, violations: [] };
}

/** knip is whole-graph (not diff-scoped) and seconds-scale, so it runs only at
 *  the commit/ci rungs — never on the per-turn stop gate — but independent of
 *  whether any `.ts` file changed (a dependency-only change, e.g. a
 *  `package.json` bump, still needs the dependency-hygiene checks). It
 *  assumes a knip-clean baseline, like tsc (see this file's header). */
async function runKnip(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
  const knip = await exec(resolveBin('knip'), ['--reporter', 'json'], {
    cwd: repoRoot,
  });
  return withExitCodeCheck('knip', knip, parseKnipJson(knip.stdout, repoRoot));
}

/**
 * npm's own peer-range verdict on the installed graph. Whole-graph and cheap,
 * so it sits at the commit rung beside knip.
 *
 * Deliberately NOT wrapped in `withExitCodeCheck`: `npm ls` exits 0 on a graph
 * it has just reported problems for (measured), so the parsed output is the
 * only signal -- an exit-code check would read a broken graph as clean.
 *
 * A spawn failure yields no violations rather than an error. This is a
 * diagnostic for an incoherent install, and an environment without npm on PATH
 * (or a repo on pnpm/yarn) is not a broken repo. A consumer who wants it
 * enforced sets `"npm-peers": "required"`.
 */
async function runNpmPeers(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const result = await options.exec(
    resolveBin('npm'),
    // `--long` for the per-node `path`, which is what lets the adapter drop a
    // linked dependency's foreign tree -- see its `isInsideRepo`.
    ['ls', '--json', '--all', '--long'],
    { cwd: options.repoRoot },
  );
  if (result.spawnFailed === true) {
    return [];
  }
  return parseNpmLsJson(result.stdout, options.repoRoot);
}

/** dependency-cruiser is whole-graph (not diff-scoped); like knip it runs at
 *  the commit/ci rungs only, independent of whether any `.ts` file changed. It
 *  assumes a dependency-cruiser-clean baseline, like tsc/knip. */
async function runDepcruise(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
  // Config-agnostic and layout-generic, exactly as runKnip: no `--config` (DC
  // auto-detects the consumer repo's own `.dependency-cruiser.{cjs,js,json}` /
  // `package.json#dependency-cruiser`) and no hardcoded target (cruise `.` from
  // repoRoot; the consumer's config `forbidden[].from/to` matchers + `exclude`/
  // `doNotFollow` do the scoping). A repo-specific target here would silently
  // break — a consumer repo has no `guardrails-core/src` directory.
  const result = await exec(
    resolveBin('depcruise'),
    ['--output-type', 'json', '.'],
    { cwd: repoRoot },
  );
  return withExitCodeCheck(
    'dependency-cruiser',
    result,
    parseDepcruiseJson(result.stdout, repoRoot),
  );
}

async function runEslint(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
  const eslint = await exec(
    resolveBin('eslint'),
    ['--format', 'json', '--no-warn-ignored', ...files],
    { cwd: repoRoot },
  );
  return withExitCodeCheck(
    'eslint',
    eslint,
    parseEslintJson(eslint.stdout, repoRoot),
  );
}

/** `tsc` is changed-files-TRIGGERED but whole-project-CHECKED: it takes no file
 *  list (`-p tsconfig`), so a change in one file can surface an error in
 *  another. It assumes a clean type-check baseline (see this file's header). */
async function runTsc(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
): Promise<Violation[]> {
  const { exec, repoRoot } = options;
  const tsconfig = options.tsconfig ?? 'tsconfig.json';
  const tscBin = resolveBin('tsc');
  const tsc = await exec(
    tscBin,
    ['--noEmit', '--pretty', 'false', '-p', tsconfig],
    { cwd: repoRoot },
  );
  const violations = withExitCodeCheck(
    'tsc',
    tsc,
    parseTscOutput(tsc.stdout, repoRoot),
  );
  if (tsc.spawnFailed === true) {
    return violations;
  }
  // A nonzero, non-spawn exit has already produced either a parsed diagnostic
  // or guardrails/analyzer-failed, so the following violations-length guard
  // returns the same array if this early return is emptied or forced false.
  // Stryker disable next-line ConditionalExpression,BlockStatement
  if (tsc.code !== 0) {
    return violations;
  }
  if (violations.length > 0) {
    return violations;
  }

  // `tsc -p` exits 0 while checking zero files for a solution-style root
  // config (`files: []`, `references: [...]`) such as Vite's react-ts starter.
  // Ask TypeScript for the resolved shape only after an apparently-clean run;
  // referenced projects require build mode so "clean" means they were checked.
  const shown = await exec(tscBin, ['--showConfig', '-p', tsconfig], {
    cwd: repoRoot,
  });
  if (shown.spawnFailed === true) {
    return [
      analyzerFailedViolation('tsc --showConfig', shown.code, shown.stderr),
    ];
  }
  if (shown.code !== 0) {
    return [
      analyzerFailedViolation('tsc --showConfig', shown.code, shown.stderr),
    ];
  }
  const references = resolvedProjectReferences(shown.stdout);
  if (references === undefined) {
    return [
      analyzerFailedViolation(
        'tsc --showConfig',
        0,
        'TypeScript produced an unreadable resolved configuration.',
      ),
    ];
  }
  if (!references) {
    return violations;
  }

  const built = await exec(
    tscBin,
    ['--build', '--noEmit', '--pretty', 'false', tsconfig],
    { cwd: repoRoot },
  );
  return withExitCodeCheck(
    'tsc --build',
    built,
    parseTscOutput(built.stdout, repoRoot),
  );
}

/** Whether TypeScript's resolved project has references. `undefined` means the
 * supposedly machine-readable `--showConfig` output could not be validated. */
function resolvedProjectReferences(stdout: string): boolean | undefined {
  let parsed: unknown;
  // prettier-ignore
  try {
    parsed = JSON.parse(stdout);
  }
  // Emptying this catch leaves parsed undefined, which the shape guard below
  // rejects with the same undefined result.
  // Stryker disable next-line BlockStatement
  catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const references = Reflect.get(parsed, 'references');
  return Array.isArray(references) && references.length > 0;
}

/** Stryker's own default JSON-reporter path. There is no supported way to
 *  relocate it per run: `--jsonReporter.fileName` is a config-file-only key,
 *  never registered as a CLI flag (only `--dashboard.*` is), and a
 *  `--configFile` would hardcode a guardrails-owned config into the
 *  consumer's stryker invocation, breaking consumer-genericity. So this path
 *  is fixed, gitignored, and persists across runs — which is exactly why
 *  `runStryker` deletes it before every run rather than trying to avoid it. */
const STRYKER_REPORT_PATH = path.join('reports', 'mutation', 'mutation.json');
const STRYKER_INCREMENTAL_PATH = path.join(
  'reports',
  'stryker-incremental.json',
);

function strykerReportMissingViolation(reportPath: string): Violation {
  return {
    ruleId: 'guardrails/analyzer-failed',
    file: 'package.json',
    message:
      `stryker exited 0 but its mutation report was not found at ` +
      `"${reportPath}" — treating the mutation check as failed, not clean. ` +
      `(A consumer that customises jsonReporter.fileName writes its report ` +
      `elsewhere; this failure is what catches that, instead of silently ` +
      `reporting a clean mutation gate.)`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

/** stryker is diff-scoped (changed production files) and CI/commit-only
 *  (mutation testing reruns the suite per mutant). Consumer-generic: no
 *  `--configFile` (stryker auto-detects the consumer's stryker.conf.json), and
 *  the `--mutate` list is the consumer's own changed files. The report is read
 *  from stryker's own default, gitignored, cross-run-persistent location
 *  (`STRYKER_REPORT_PATH`) — there is no flag to relocate it per run (see that
 *  constant's comment) — so stale output from a PRIOR run could otherwise be
 *  misread as this run's. `removeFile` deletes both the JSON report and
 *  Stryker's incremental cache BEFORE stryker runs. The latter is essential:
 *  Stryker can reuse survivor results when tests change but production does
 *  not, exactly the fixer-loop case where a new test is meant to kill a mutant.
 *
 *  Unlike the analyzers above, stryker exits 0 even with surviving mutants
 *  unless a `break` threshold is configured (this pack sets none) — so ANY
 *  non-zero exit here means a crash, never "findings", and is always a
 *  failure. A report still missing after a zero exit is also a failure
 *  (`analyzer-failed`, not clean): whether because stryker crashed
 *  internally without a non-zero exit, or because the consumer's own
 *  `stryker.conf.json` customises `jsonReporter.fileName` to write somewhere
 *  else — either way, the report is the only channel mutation results reach
 *  this process through, and finding none there must never read as clean. */
async function runStryker(
  options: VerifyOptions,
  resolveBin: (tool: string) => string,
  files: string[],
): Promise<Violation[]> {
  const production = files.filter(
    (file) => isTypeScriptFile(file) && !isTestFile(file),
  );
  if (production.length === 0) {
    return [];
  }
  const { exec, repoRoot } = options;
  const readFile =
    options.readFile ?? ((filePath) => fsReadFile(filePath, 'utf8'));
  const removeFile =
    options.removeFile ?? ((filePath) => fsRm(filePath, { force: true }));
  const reportPath = STRYKER_REPORT_PATH;

  await removeFile(path.join(repoRoot, reportPath));
  await removeFile(path.join(repoRoot, STRYKER_INCREMENTAL_PATH));

  const result = await exec(
    resolveBin('stryker'),
    [
      'run',
      '--incremental',
      '--reporters',
      'json',
      '--mutate',
      production.join(','),
    ],
    { cwd: repoRoot },
  );
  if (result.spawnFailed === true) {
    // Reported separately as guardrails/analyzer-missing by the caller.
    return [];
  }
  if (result.code !== 0) {
    return [analyzerFailedViolation('stryker', result.code, result.stderr)];
  }

  let report: string;
  try {
    report = await readFile(path.join(repoRoot, reportPath));
  } catch {
    return [strykerReportMissingViolation(reportPath)];
  }
  return parseStrykerJson(report, production);
}

type Rung = NonNullable<VerifyOptions['profile']>;
const RUNG_ORDER: Record<Rung, number> = { stop: 0, commit: 1, ci: 2 };

type Scope = 'whole-project' | 'changed-files';

interface Analyzer {
  tool: string;
  /** npm package providing the binary — named in the missing-analyzer message
   *  and kept in sync with peerDependencies by a test. */
  /**
   * The npm package a consumer installs to provide this tool.
   *
   * `npm-peers` names `npm`: not an installable dependency, but genuinely the
   * binary it shells out to. Keeping this field non-optional is a deliberate
   * mutation-testing choice -- an `undefined` guard here produces a provably
   * equivalent mutant that cannot be suppressed without also silencing a real
   * one on the same line (measured: killed 321 -> 320). The "not a peer
   * dependency" fact is recorded in `NON_PACKAGE_PROVIDERS` in
   * `test/peer-dependencies.test.ts` instead, where it costs no coverage.
   */
  provider: string;
  minRung: Rung;
  /** Run-trigger: 'changed-files' runs only when the turn changed >=1 TS file
   *  (and receives the list); 'whole-project' runs whenever the rung is active. */
  scope: Scope;
  run: (
    options: VerifyOptions,
    resolveBin: (tool: string) => string,
    files: string[],
  ) => Promise<Violation[]>;
}

/** The full analyzer registry, each entry gated by a minimum cadence rung and a
 *  run-trigger scope. Entries run serially in listed order, and that order is
 *  the order violations appear in the aggregated result. Adding an analyzer is
 *  a table entry plus its runner — no branching in `runVerify`.
 *
 *  Still open (deferred once more, now with a measurement in hand): running the
 *  commit-rung entries in parallel under a measured commit-gate budget. */
const ANALYZERS: Analyzer[] = [
  {
    tool: 'eslint',
    provider: 'eslint',
    minRung: 'stop',
    scope: 'changed-files',
    run: runEslint,
  },
  {
    tool: 'tsc',
    provider: 'typescript',
    minRung: 'stop',
    scope: 'changed-files',
    run: runTsc,
  },
  {
    tool: 'knip',
    provider: 'knip',
    minRung: 'commit',
    scope: 'whole-project',
    run: runKnip,
  },
  {
    // `npm` is the binary this analyzer runs, and no repo declares it as a
    // dependency -- so `decideAnalyzer('auto', false)` resolves to
    // run-but-never-report-missing: it runs by default and goes quiet where
    // npm is unavailable, which is what a diagnostic wants.
    tool: 'npm-peers',
    provider: 'npm',
    minRung: 'commit',
    scope: 'whole-project',
    run: runNpmPeers,
  },
  {
    tool: 'dependency-cruiser',
    provider: 'dependency-cruiser',
    minRung: 'commit',
    scope: 'whole-project',
    run: runDepcruise,
  },
  {
    tool: 'stryker',
    provider: '@stryker-mutator/core',
    minRung: 'commit',
    scope: 'changed-files',
    run: runStryker,
  },
];

/** The npm packages a consumer repo must provide. Exported so a test can hold it
 *  against guardrails-core's peerDependencies — an analyzer added without its
 *  declaration would surface as a runtime error instead of an install warning. */
export const ANALYZER_PROVIDERS: readonly string[] = ANALYZERS.map(
  (analyzer) => analyzer.provider,
);

/** The valid keys of `guardrails.config.json`'s `analyzers` block. Exported so
 *  `runVerify` can flag an unrecognised key rather than let a typo silently
 *  leave an analyzer running that the author believes disabled. */
export const ANALYZER_TOOLS: readonly string[] = ANALYZERS.map(
  (analyzer) => analyzer.tool,
);

function unknownAnalyzerViolations(
  analyzers: Readonly<Record<string, AnalyzerMode>>,
): Violation[] {
  return Object.keys(analyzers)
    .filter((key) => !ANALYZER_TOOLS.includes(key))
    .map((key) => ({
      ruleId: 'guardrails/analyzer-unknown',
      file: 'guardrails.config.json',
      message:
        `"${key}" in the "analyzers" block is not a known analyzer, so the ` +
        `entry has no effect. Known analyzers: ${ANALYZER_TOOLS.join(', ')}. ` +
        `Check for a typo: whatever you meant this entry to do — turn an ` +
        `analyzer off, or require it — did not happen.`,
      severity: 'warn' as const,
      fixable: false,
      tool: 'guardrails',
    }));
}

/**
 * A guard that could not RUN must never look like a guard that passed. Exit code
 * cannot carry that distinction — eslint exits 1 on findings, tsc on type errors
 * — so `spawnExec` flags the could-not-start case and this wrapper records which
 * commands hit it. Whether a failure becomes a violation is the opt-in policy's
 * call — see `analyzer-policy.ts`.
 */
function trackSpawnFailures(exec: Exec): { exec: Exec; failures: string[] } {
  const failures: string[] = [];
  const tracked: Exec = async (command, args, execOptions) => {
    const result = await exec(command, args, execOptions);
    if (result.spawnFailed === true) {
      failures.push(command);
    }
    return result;
  };
  return { exec: tracked, failures };
}

function missingToolViolation(tool: string, provider: string): Violation {
  return {
    ruleId: 'guardrails/analyzer-missing',
    file: 'package.json',
    message:
      `${tool} could not be started — it is not installed in this repo, so its ` +
      `checks did NOT run. Install it: \`npm install --save-dev ${provider}\`. ` +
      `A missing analyzer is a failed gate, not a clean one.`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

/**
 * The configured base branch resolves to nothing — neither locally nor as
 * `origin/<branch>`. Every diff-scoped analyzer would otherwise be skipped for
 * want of a changed-file list, and the run would read clean.
 */
function unresolvableBaseViolation(baseBranch: string): Violation {
  return {
    ruleId: 'guardrails/analyzer-failed',
    file: 'package.json',
    message:
      `base branch "${baseBranch}" could not be resolved, as itself or as ` +
      `"origin/${baseBranch}", so the changed-file set is unknown and every ` +
      `diff-scoped check was SKIPPED. Check \`baseBranch\` in ` +
      `guardrails.config.json, and in CI make sure the base branch is fetched ` +
      `(actions/checkout with fetch-depth: 0). An unknown diff is a failed ` +
      `gate, not a clean one.`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

interface SelectedAnalyzer {
  analyzer: Analyzer;
  /**
   * The provider package to name if this analyzer fails to spawn, or
   * `undefined` when its absence is a deliberate opt-out rather than an error.
   *
   * Carrying the package here rather than a boolean keeps the two facts that
   * must agree -- "report this as missing" and "there IS a package to name" --
   * in a single value. A separate boolean would need a redundant re-check of
   * `analyzer.provider` at the call site, on a branch no input could reach.
   */
  missingProvider: string | undefined;
}

/**
 * Which analyzers run this pass, and whether each one's absence is an error.
 * Pure: the opt-in policy, the cadence rung, and the changed-files trigger are
 * all decisions, so they are made here and `runVerify` is left with the I/O.
 */
function selectAnalyzers(
  analyzers: Readonly<Record<string, AnalyzerMode>>,
  declared: ReadonlySet<string>,
  profile: Rung,
  hasChangedFiles: boolean,
): SelectedAnalyzer[] {
  const selected: SelectedAnalyzer[] = [];
  for (const analyzer of ANALYZERS) {
    const decision = decideAnalyzer(
      analyzerMode(analyzers, analyzer.tool),
      declared.has(analyzer.provider),
    );
    if (!decision.run) {
      continue;
    }
    if (RUNG_ORDER[profile] < RUNG_ORDER[analyzer.minRung]) {
      continue;
    }
    if (analyzer.scope === 'changed-files' && !hasChangedFiles) {
      continue;
    }
    // `analyzer.provider` is already `string | undefined`, so a provider-less
    // analyzer lands on `undefined` here without a second guard -- and the call
    // site's `!== undefined` check then skips it for free.
    selected.push({
      analyzer,
      missingProvider: decision.reportMissing ? analyzer.provider : undefined,
    });
  }
  return selected;
}

export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const { exec, failures } = trackSpawnFailures(options.exec);
  const tracked = { ...options, exec };
  const { files, violations: gitViolations } =
    await changedTypeScriptFiles(tracked);
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  const profile = options.profile ?? 'stop';

  const violations: Violation[] = [...gitViolations];
  // git failing to start is catastrophic and was equally silent: no changed
  // files means every diff-scoped analyzer is skipped, and the gate passes.
  if (failures.length > 0) {
    violations.push(missingToolViolation('git', 'git'));
  }
  const analyzers = options.analyzers ?? {};
  // KNOWN LIMIT: only the repo ROOT's package.json is read. A monorepo that
  // declares its analyzer dependencies in member packages rather than at the
  // root has an empty declared set, so every analyzer is `auto`+undeclared and
  // a broken install degrades silently — the very failure the declared-provider
  // rule exists to prevent, in a layout this project supports. Workaround: name
  // the analyzer `"required"` in guardrails.config.json, which states the
  // dependency explicitly and restores the hard `analyzer-missing` error.
  // Enumerating workspace members instead is a design decision, not a cleanup;
  // it is recorded in plan.md's "Roadmap: analyzer opt-in" section.
  const declared =
    options.declaredProviders ??
    declaredProviders(
      readJsonFile(path.join(options.repoRoot, 'package.json')).parsed,
    );
  violations.push(...unknownAnalyzerViolations(analyzers));

  for (const { analyzer, missingProvider } of selectAnalyzers(
    analyzers,
    declared,
    profile,
    files.length > 0,
  )) {
    const before = failures.length;
    violations.push(...(await analyzer.run(tracked, resolveBin, files)));
    if (failures.length > before && missingProvider !== undefined) {
      violations.push(missingToolViolation(analyzer.tool, missingProvider));
    }
  }
  // A nested worktree is a whole second checkout of this repository, and every
  // analyzer that walks the tree reports it. Filtering HERE rather than inside
  // each adapter means one rule covers all of them -- including any analyzer
  // added later, which would otherwise have to remember to opt in.
  //
  // `options.exec`, not the `tracked` wrapper: a spawn failure recorded there
  // becomes a `guardrails/analyzer-missing` violation for git, which
  // `changedTypeScriptFiles` already reports. Routing this call through it
  // would report a missing git twice.
  // Filtering unconditionally rather than short-circuiting on an empty list:
  // with no nested worktrees the predicate is false for every violation, so a
  // fast path would only save one array copy while adding a branch no test can
  // distinguish.
  const nested = await nestedWorktreePaths(options.exec, options.repoRoot);
  const scoped = violations.filter(
    (violation) => !isInsideNestedWorktree(violation.file, nested),
  );

  // Attribution is per-file, so it happens here rather than inside any adapter.
  // Built once per run: the resolver reads the filesystem at construction and is
  // pure thereafter.
  return {
    violations: withPackages(scoped, loadWorkspaceResolver(options.repoRoot)),
  };
}
