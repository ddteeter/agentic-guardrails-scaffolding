/**
 * `guardrails init` — detect, plan, apply.
 *
 * This is the assembly point for the whole scaffolder: `detect` reads the
 * consumer's repo, `buildDesiredFiles` says what should be in it, `planScaffold`
 * decides what to do with each path, and `applyScaffold` does it. Nothing here
 * makes a classification or a merge decision of its own — those belong to the
 * pure modules that can be proven without a filesystem.
 *
 * THE safety property, stated once: `init` writes nothing unless `--apply` was
 * passed. There is no interactive mode and no TTY probe — spec §6.2 makes a
 * non-TTY `init` identical to `--plan`, and the judgement layer that would ask
 * the questions is the adoption skill (§7), which drives this command through
 * `--plan --json` and then `--apply`. So the read-only path is simply the
 * default, and `--apply` is the only way past it.
 *
 * `InitDependencies` restates the slice of `cli-core.ts`'s `CliDependencies` this command
 * needs, rather than importing it: `cli-core` dispatches to here, and importing
 * back would be a dependency cycle. `CliDependencies` satisfies it structurally.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { Exec } from '../exec.js';
import { packageVersion } from '../package-root.js';
import type { AnalyzerMode } from '../verify/analyzer-policy.js';
import { ANALYZER_TOOLS } from '../verify/index.js';
import {
  applyScaffold,
  type ApplyDependencies,
  type ApplyResult,
} from './apply.js';
import { detect, type RepoFacts } from './detect.js';
import {
  foreignHooksPath,
  HOOKS_DIRECTORY,
  HOOKS_SCRIPT_PATH,
  PUSH_HOOK_SCRIPT_PATH,
} from './hooks-path.js';
import {
  planScaffold,
  type ScaffoldDecisions,
  type ScaffoldPlan,
} from './plan.js';
import { buildDesiredFiles, canonicalKey } from './templates.js';

export interface InitDependencies {
  readonly exec: Exec;
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const INIT_USAGE =
  'usage: guardrails-core init [--plan] [--json] [--apply] [--force] ' +
  '[--analyzers=<tool>=<off|auto|required>[,...]] ' +
  '[--enforcement=warn|block] [--distribution=solo|team]\n';

/**
 * Scaffolded files that must carry the executable bit. git silently SKIPS a
 * hook it cannot execute, which looks exactly like a working install right up
 * until the gate never fires — so this is not cosmetic.
 */
const EXECUTABLE_PATHS: ReadonlySet<string> = new Set([
  HOOKS_SCRIPT_PATH,
  PUSH_HOOK_SCRIPT_PATH,
]);

type Enforcement = ScaffoldDecisions['enforcement'];
type Distribution = ScaffoldDecisions['distribution'];

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--plan',
  '--json',
  '--apply',
  '--force',
]);

const VALUE_FLAG_PREFIXES: readonly string[] = [
  '--analyzers=',
  '--enforcement=',
  '--distribution=',
];

/**
 * `adopting-guardrails` is deliberately excluded from every path `init` writes
 * -- a document explaining how to adopt guardrails cannot be delivered BY
 * adoption (see `templates.ts`'s ADOPTION_TIME_SKILL). It ships in the tarball
 * instead, readable the moment `npm install` finishes.
 *
 * That left a narrow but real gap: nothing ever NAMED it, so an agent had to
 * already know the file existed to read the document explaining what to do.
 * Printing the path on both human paths puts it exactly where an agent is
 * deciding which analyzers and enforcement level to choose. It is not printed
 * under `--json`, whose consumers parse the payload.
 */
const GUIDANCE_POINTER =
  'Next: read node_modules/guardrails-core/guidance/adopting-guardrails.md ' +
  'for how to choose analyzers and enforcement, and which configs init ' +
  'deliberately does not write for you.\n';

const ANALYZER_MODES: readonly AnalyzerMode[] = ['off', 'auto', 'required'];
const ENFORCEMENTS: readonly Enforcement[] = ['warn', 'block'];
const DISTRIBUTIONS: readonly Distribution[] = ['solo', 'team'];

interface InitOptions {
  readonly apply: boolean;
  readonly shouldPrintJson: boolean;
  readonly decisions: ScaffoldDecisions;
}

/** A discriminated union rather than two optional fields: it is what lets the
 *  caller read `options` without a guard whose false branch cannot happen. */
type FlagParse =
  | { readonly kind: 'options'; readonly options: InitOptions }
  | { readonly kind: 'error'; readonly message: string };

function flagValue(
  rest: readonly string[],
  prefix: string,
): string | undefined {
  return rest
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function isKnownArgument(argument: string): boolean {
  return (
    BOOLEAN_FLAGS.has(argument) ||
    VALUE_FLAG_PREFIXES.some((prefix) => argument.startsWith(prefix))
  );
}

/**
 * One `tool=mode` pair. Both halves are validated against the real analyzer
 * registry, so a typo fails loudly here instead of leaving an analyzer running
 * that the author believes they turned off.
 */
function parseAnalyzerPair(
  pair: string,
): readonly [string, AnalyzerMode] | undefined {
  const separatorAt = pair.indexOf('=');
  const tool = pair.slice(0, separatorAt);
  const mode = ANALYZER_MODES.find(
    (choice) => choice === pair.slice(separatorAt + 1),
  );
  if (mode === undefined || !ANALYZER_TOOLS.includes(tool)) {
    return undefined;
  }
  return [tool, mode];
}

/**
`undefined` means the value was malformed; an absent flag means `{}`.
*/
function parseAnalyzers(
  value: string | undefined,
): Record<string, AnalyzerMode> | undefined {
  if (value === undefined) {
    return {};
  }
  const analyzers: Record<string, AnalyzerMode> = {};
  for (const pair of value.split(',')) {
    const parsed = parseAnalyzerPair(pair);
    if (parsed === undefined) {
      return undefined;
    }
    analyzers[parsed[0]] = parsed[1];
  }
  return analyzers;
}

/**
 * No `--enforcement` seeds `block`, matching what `docs/adoption.md` and the
 * `adopting-guardrails` skill already tell adopters to choose: a greenfield or
 * already-clean repo starts enforcing, and `warn` is a migration tool for an
 * existing backlog.
 *
 * It defaulted to `warn`, which made the README's own `init --apply` produce
 * advisory commit/push/CI gates -- and `guardrails.config.json` is SEED-ONCE,
 * so the flag cannot repair that afterwards. `warn` fails quiet (a type error
 * commits, and the first violation reaches the base branch where diff-scoped
 * checks no longer see it); `block` fails loud, and a loud first run is the one
 * an adopter can act on. Same direction as every other defensive default here.
 */
function parseEnforcement(value: string | undefined): Enforcement | undefined {
  return value === undefined
    ? 'block'
    : ENFORCEMENTS.find((choice) => choice === value);
}

function parseDistribution(
  value: string | undefined,
): Distribution | undefined {
  return value === undefined
    ? 'solo'
    : DISTRIBUTIONS.find((choice) => choice === value);
}

function invalid(message: string): FlagParse {
  return { kind: 'error', message };
}

function parseInitFlags(rest: readonly string[]): FlagParse {
  const unknown = rest.find((argument) => !isKnownArgument(argument));
  if (unknown !== undefined) {
    return invalid(`unrecognised option "${unknown}"`);
  }
  // Refused rather than resolved in either direction: whichever one silently
  // won, the other would have been a request the command ignored -- and on the
  // write side that is not a mistake worth guessing about.
  if (rest.includes('--plan') && rest.includes('--apply')) {
    return invalid('--plan and --apply are mutually exclusive');
  }
  const analyzers = parseAnalyzers(flagValue(rest, '--analyzers='));
  if (analyzers === undefined) {
    return invalid(
      '--analyzers expects <tool>=<mode> pairs, where <tool> is one of ' +
        `${ANALYZER_TOOLS.join(', ')} and <mode> is one of ` +
        ANALYZER_MODES.join(', '),
    );
  }
  const enforcement = parseEnforcement(flagValue(rest, '--enforcement='));
  if (enforcement === undefined) {
    return invalid('--enforcement expects warn or block');
  }
  const distribution = parseDistribution(flagValue(rest, '--distribution='));
  if (distribution === undefined) {
    return invalid('--distribution expects solo or team');
  }
  return {
    kind: 'options',
    options: {
      apply: rest.includes('--apply'),
      shouldPrintJson: rest.includes('--json'),
      decisions: {
        analyzers,
        enforcement,
        distribution,
        shouldForce: rest.includes('--force'),
      },
    },
  };
}

function readIfPresent(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
}

/**
 * What is on disk today, for exactly the paths `init` intends to write.
 *
 * The existence check guards the READ rather than filtering an already-read
 * value: `current[key] = undefined` and an absent key are indistinguishable to
 * `planScaffold`, so a post-read filter would be a branch no test could
 * observe -- whereas skipping the read is provable, since reading a file that
 * is not there throws.
 */
function readCurrent(
  repoRoot: string,
  desired: Readonly<Record<string, string>>,
): Record<string, string> {
  const current: Record<string, string> = {};
  for (const filePath of Object.keys(desired)) {
    const fullPath = path.join(repoRoot, filePath);
    if (existsSync(fullPath)) {
      current[filePath] = readFileSync(fullPath, 'utf8');
    }
  }
  return current;
}

/**
 * `applyScaffold`'s `setHooksPath` seam is synchronous, but repointing
 * `core.hooksPath` is a `git` call through the async `Exec` seam (only
 * `src/exec.ts` may touch `node:child_process`). So apply RECORDS the request
 * through `onHooksPath` and the command performs it afterwards.
 *
 * A latch object rather than a bare `let` in the caller: TypeScript narrows a
 * `let` initialised to `false` and never *visibly* reassigned, so the check
 * after the run reads as statically dead. A latch whose reads and writes both
 * cross a function boundary states the same thing without the false alarm --
 * and unlike a plain mutable holder (`{ requested: false }`), its initial
 * value is observable, so "starts unset" is a property a test can prove.
 */
interface HooksPathLatch {
  /**
  True once apply has asked for `core.hooksPath` to be repointed.
  */
  readonly requested: () => boolean;
  readonly request: () => void;
}

function hooksPathLatch(): HooksPathLatch {
  let isRequested = false;
  return {
    requested: () => isRequested,
    request: () => {
      isRequested = true;
    },
  };
}

function fileSystemApplyDependencies(
  repoRoot: string,
  onHooksPath: () => void,
): ApplyDependencies {
  return {
    readFile: readIfPresent,
    writeFile: (filePath, content) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
      if (
        EXECUTABLE_PATHS.has(canonicalKey(path.relative(repoRoot, filePath)))
      ) {
        chmodSync(filePath, 0o755);
      }
    },
    setHooksPath: onHooksPath,
  };
}

function printWarnings(
  dependencies: InitDependencies,
  warnings: readonly string[],
): void {
  for (const warning of warnings) {
    dependencies.stderr(`  warning: ${warning}\n`);
  }
}

function printPlan(
  dependencies: InitDependencies,
  facts: RepoFacts,
  plan: ScaffoldPlan,
  shouldPrintJson: boolean,
): void {
  if (shouldPrintJson) {
    dependencies.stdout(
      `${JSON.stringify(
        {
          repoRoot: facts.repoRoot,
          baseBranch: facts.baseBranch,
          actions: plan.actions,
          warnings: plan.warnings,
        },
        undefined,
        2,
      )}\n`,
    );
    return;
  }
  dependencies.stdout(
    `guardrails init: plan for ${facts.repoRoot} — nothing is written ` +
      `without --apply.\n`,
  );
  for (const action of plan.actions) {
    dependencies.stdout(
      `  ${action.kind}: ${action.path} — ${action.reason}\n`,
    );
  }
  printWarnings(dependencies, plan.warnings);
  dependencies.stdout(GUIDANCE_POINTER);
}

function printApply(
  dependencies: InitDependencies,
  plan: ScaffoldPlan,
  result: ApplyResult,
  shouldPrintJson: boolean,
): void {
  const warnings = [...plan.warnings, ...result.warnings];
  if (shouldPrintJson) {
    dependencies.stdout(
      `${JSON.stringify(
        { written: result.written, skipped: result.skipped, warnings },
        undefined,
        2,
      )}\n`,
    );
    return;
  }
  dependencies.stdout(
    result.written.length === 0
      ? 'guardrails init: nothing to do; the scaffold is up to date.\n'
      : `guardrails init: wrote ${result.written.length} file(s).\n`,
  );
  for (const file of result.written) {
    dependencies.stdout(`  wrote: ${file}\n`);
  }
  printWarnings(dependencies, warnings);
  dependencies.stdout(GUIDANCE_POINTER);
}

export async function initCommand(
  dependencies: InitDependencies,
  rest: readonly string[],
): Promise<number> {
  // An explicit request for help is not a mistake the way an unrecognised
  // flag is -- short-circuits before flag validation so it prints usage and
  // exits 0 regardless of what else is on the command line.
  if (rest.includes('--help')) {
    dependencies.stdout(INIT_USAGE);
    return 0;
  }
  const parsed = parseInitFlags(rest);
  if (parsed.kind === 'error') {
    dependencies.stderr(`guardrails init: ${parsed.message}\n`);
    dependencies.stderr(INIT_USAGE);
    return 1;
  }
  const { decisions } = parsed.options;
  const facts = await detect({
    exec: dependencies.exec,
    cwd: dependencies.cwd,
  });
  const desired = buildDesiredFiles(facts, decisions);
  const plan = planScaffold({
    facts,
    decisions,
    desired,
    current: readCurrent(facts.repoRoot, desired),
  });
  if (!parsed.options.apply) {
    printPlan(dependencies, facts, plan, parsed.options.shouldPrintJson);
    return 0;
  }
  const latch = hooksPathLatch();
  const result = applyScaffold(
    plan,
    desired,
    facts.repoRoot,
    fileSystemApplyDependencies(facts.repoRoot, latch.request),
    packageVersion(),
  );
  // A consumer who already points `core.hooksPath` somewhere else keeps it:
  // repointing would silently disable every hook they have, and `prepare` would
  // re-disable it on every install. `planScaffold` has already warned about it
  // (see `hooks-path.ts`), and `printApply` prints that warning below.
  if (latch.requested() && foreignHooksPath(facts.hooksPath) === undefined) {
    await dependencies.exec(
      'git',
      ['config', 'core.hooksPath', HOOKS_DIRECTORY],
      {
        cwd: facts.repoRoot,
      },
    );
  }
  printApply(dependencies, plan, result, parsed.options.shouldPrintJson);
  return 0;
}
