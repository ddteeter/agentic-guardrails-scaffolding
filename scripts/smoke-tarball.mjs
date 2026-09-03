#!/usr/bin/env node
/**
 * Prove the published artifact works, not just the source tree.
 *
 * Everything else in the suite runs against this repo, where the npm workspace
 * symlinks `guardrails-core` into `node_modules` — so `files`, the bin shebang,
 * and ESM resolution are all bypassed. A consumer gets none of that. This packs
 * the real tarball, installs it into a throwaway repo the way a consumer would,
 * and runs the CLI out of it.
 *
 * Failure here means a first adoption fails at the first command.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageDirectory = path.join(root, 'guardrails-core');

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function fail(message) {
  console.error(`smoke-tarball: ${message}`);
  process.exit(1);
}

// 1. Pack the real tarball.
const packOutput = run(
  'npm',
  ['pack', '--pack-destination', tmpdir()],
  packageDirectory,
);
const tarballName = packOutput.trim().split('\n').at(-1);
const tarball = path.join(tmpdir(), tarballName);
if (!existsSync(tarball)) {
  fail(`npm pack reported "${tarballName}" but no file exists at ${tarball}`);
}
console.log(`smoke-tarball: packed ${tarballName}`);

// 2. Install it into a throwaway repo, exactly as a consumer would.
const fixture = mkdtempSync(path.join(tmpdir(), 'guardrails-smoke-'));
writeFileSync(
  path.join(fixture, 'package.json'),
  `${JSON.stringify({ name: 'smoke-fixture', version: '1.0.0', private: true }, undefined, 2)}\n`,
);
run('npm', ['install', '--no-audit', '--no-fund', tarball], fixture);
console.log(`smoke-tarball: installed into ${fixture}`);

// 3. The package must carry every directory `files` promises.
const installed = path.join(fixture, 'node_modules', 'guardrails-core');
for (const directory of ['dist', 'guidance', 'templates']) {
  const target = path.join(installed, directory);
  if (!existsSync(target) || readdirSync(target).length === 0) {
    fail(
      `the tarball is missing "${directory}/" — check "files" in guardrails-core/package.json`,
    );
  }
}

// 4. The templates a consumer's install depends on must have survived packing.
for (const relative of [
  'claude/agents/guardrail-fixer.md',
  'claude/agents/guardrail-fixer-thorough.md',
  'claude/settings.hooks.json',
  'codex/agents/guardrail-fixer.toml',
  'codex/agents/guardrail-fixer-thorough.toml',
  'codex/hooks.json',
  'copilot/agents/guardrail-fixer.agent.md',
  'copilot/agents/guardrail-fixer-thorough.agent.md',
  'copilot/hooks/guardrails.json',
  'githooks/pre-commit',
  'workflows/guardrails.yml',
]) {
  if (!existsSync(path.join(installed, 'templates', relative))) {
    fail(`the tarball is missing templates/${relative}`);
  }
}

// 4b. The subpath every generated hook command imports. `files` and the
//     templates checks above prove the BYTES shipped; this proves the
//     `exports` map actually publishes them under the name hooks use.
//     Resolved, never imported: importing cli.mjs would run the CLI, which
//     reads stdin and would hang here.
const resolveProbe = spawnSync(
  process.execPath,
  [
    '-e',
    "const { createRequire } = require('node:module');" +
      "console.log(createRequire(process.cwd() + '/probe.cjs')" +
      ".resolve('guardrails-core/cli'));",
  ],
  { cwd: fixture, encoding: 'utf8' },
);
if (resolveProbe.status !== 0 || !resolveProbe.stdout.includes('cli.mjs')) {
  fail(
    'the packed package does not publish `guardrails-core/cli` — every ' +
      'generated hook command imports that subpath:\n' +
      `${resolveProbe.stdout}${resolveProbe.stderr}`,
  );
}

// 5. `guardrails init --plan` exercises far more of the install path than the
//    usage banner does: template resolution from INSIDE the installed
//    package (`packageRoot()` must find `templates/` and `guidance/` under
//    `node_modules/guardrails-core`, not this repo's source tree), detection,
//    and plan computation. This is precisely what a first adoption depends
//    on. The fixture is not a git repo, so `resolveRepoRoot` falls back to
//    `cwd` — that is a legitimate path (spec-sanctioned degrade, not a bug),
//    and `init --plan` must still produce a plan rather than crash.
const plan = run(
  path.join(fixture, 'node_modules', '.bin', 'guardrails'),
  ['init', '--plan'],
  fixture,
);
if (!plan.startsWith('guardrails init: plan for ')) {
  fail(`\`guardrails init --plan\` printed no plan header. Output:\n${plan}`);
}
if (!/^ {2}(create|update|merge|drift|unchanged): /m.test(plan)) {
  fail(
    `\`guardrails init --plan\` printed no planned action. Output:\n${plan}`,
  );
}

console.log('smoke-tarball: OK — tarball installs and the CLI runs from it');

// 6. Greenfield acceptance: Vite's react-ts shape is an unborn repository with
// a solution-style root tsconfig. This is the combination the first adoption
// actually hits, and neither a workspace test nor `init --plan` proves it.
run('git', ['init', '-b', 'main'], fixture);
run(
  'git',
  ['config', 'user.email', 'guardrails-smoke@example.invalid'],
  fixture,
);
run('git', ['config', 'user.name', 'Guardrails smoke'], fixture);
// Model a normal TypeScript greenfield repository. Without these standard
// ignores, `git add .` would intentionally stage the installed package and its
// compiled Stryker directives; the commit audit is correct to inspect anything
// the user actually asks Git to commit.
writeFileSync(
  path.join(fixture, '.gitignore'),
  'node_modules/\n*.tsbuildinfo\n',
);
run(
  'npm',
  [
    'install',
    '--save-dev',
    '--no-audit',
    '--no-fund',
    path.join(root, 'node_modules', 'typescript'),
  ],
  fixture,
);
writeFileSync(
  path.join(fixture, 'tsconfig.json'),
  `${JSON.stringify(
    {
      files: [],
      references: [{ path: './tsconfig.app.json' }],
    },
    undefined,
    2,
  )}\n`,
);
writeFileSync(
  path.join(fixture, 'tsconfig.app.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        composite: true,
        strict: true,
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      include: ['src'],
    },
    undefined,
    2,
  )}\n`,
);
const sourceDirectory = path.join(fixture, 'src');
mkdirSync(sourceDirectory, { recursive: true });
writeFileSync(
  path.join(sourceDirectory, 'main.ts'),
  'const answer: string = 42;\nconsole.log(answer);\n',
);
const guardrails = path.join(fixture, 'node_modules', '.bin', 'guardrails');
run(
  guardrails,
  [
    'init',
    '--apply',
    '--enforcement=block',
    '--analyzers=eslint=off,tsc=required,knip=off,dependency-cruiser=off,stryker=off',
  ],
  fixture,
);
const claudeSettings = readFileSync(
  path.join(fixture, '.claude', 'settings.json'),
  'utf8',
);
if (!claudeSettings.includes('scope-check')) {
  fail('scaffolded Claude settings omitted the fixer scope-lock hook');
}
const failingVerify = spawnSync(guardrails, ['verify'], {
  cwd: fixture,
  encoding: 'utf8',
});
if (failingVerify.status === 0 || !failingVerify.stderr.includes('[TS2322]')) {
  fail(
    'solution-style tsconfig did not fail closed on a referenced-project type error. ' +
      `stdout:\n${failingVerify.stdout}\nstderr:\n${failingVerify.stderr}`,
  );
}

// Correct the error, then prove the same unborn repo can make its first commit
// under enforcement:block through the scaffolded pre-commit hook.
writeFileSync(
  path.join(sourceDirectory, 'main.ts'),
  'const answer: string = "42";\nconsole.log(answer);\n',
);
run(guardrails, ['verify'], fixture);
run('git', ['add', '.'], fixture);
run('git', ['commit', '-m', 'initial greenfield commit'], fixture);
console.log(
  'smoke-tarball: OK — solution tsconfig, unborn branch, and first blocking commit work',
);
