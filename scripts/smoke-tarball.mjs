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
  path.join(fixture, 'node_modules', '.bin', 'guardrails-core'),
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
const guardrails = path.join(
  fixture,
  'node_modules',
  '.bin',
  'guardrails-core',
);
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
// `init --apply` merges a `prepare` script into package.json, and npm treats a
// failed `prepare` as a failed install. Nothing above can catch a broken one:
// npm runs `prepare` on an ARGUMENT-LESS `npm install` and on `npm ci`, never
// on the `npm install <path>` form every other leg here uses. A stale bin name
// in that script therefore sails through this whole script while making the
// scaffolded repo uninstallable -- `npm ci` is the first command the shipped
// CI workflow runs, so it would fail before ever reaching the gate.
const reinstall = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
  cwd: fixture,
  encoding: 'utf8',
});
if (reinstall.status !== 0) {
  fail(
    'a scaffolded repo cannot reinstall its own dependencies -- check the ' +
      '`prepare` script `init --apply` merged into package.json.\n' +
      `stdout:\n${reinstall.stdout}\nstderr:\n${reinstall.stderr}`,
  );
}
// ...and the point of that script is its side effect, not its exit code: it is
// what puts a fresh clone or a teammate's checkout onto the commit gate.
const hooksPath = run('git', ['config', '--get', 'core.hooksPath'], fixture);
if (hooksPath.trim() !== '.githooks') {
  fail(
    `the prepare script ran but core.hooksPath is "${hooksPath.trim()}", not ` +
      '".githooks" -- the commit gate is not installed',
  );
}
console.log('smoke-tarball: OK — a scaffolded repo can still `npm ci`');

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

// 7. eslint acceptance. Every leg above runs with `eslint=off`, so the eslint
// adapter -- the analyzer the per-turn Stop gate actually leans on -- had never
// been exercised from a real install. Everything else in the suite runs against
// the npm-workspace symlink, which bypasses `files`, the bin shebang, and ESM
// resolution entirely.
//
// The config is deliberately PLUGIN-FREE. The point is to prove the path works
// out of the tarball, not to re-test the plugin ecosystem: pulling in
// typescript-eslint/unicorn/sonarjs would make this leg slow and would tie it
// to peer-dependency constraints that are a separate concern.
run(
  'npm',
  [
    'install',
    '--save-dev',
    '--no-audit',
    '--no-fund',
    path.join(root, 'node_modules', 'eslint'),
  ],
  fixture,
);
writeFileSync(
  path.join(fixture, 'eslint.config.js'),
  `export default [
  {
    files: ['**/*.ts'],
    rules: { 'no-unused-labels': 'error' },
  },
];
`,
);
// Deliberately free of type annotations despite the .ts extension: this config
// installs no TypeScript parser, so a `: void` here would be reported as
// `eslint/parse-error` and this leg would prove nothing about rule reporting.
// The file only has to reach the eslint adapter as a changed TS file.
writeFileSync(
  path.join(sourceDirectory, 'lint-me.ts'),
  'export function go() {\n  unused: for (;;) { break; }\n}\n',
);
// `guardrails.config.json` is SEED-ONCE, so `init --analyzers=...` cannot
// change the config the first leg already seeded (nor can `--force`, by
// design). Editing the file directly is both what actually works and what a
// consumer does.
const configPath = path.join(fixture, 'guardrails.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.analyzers = {
  eslint: 'required',
  tsc: 'off',
  knip: 'off',
  'dependency-cruiser': 'off',
  stryker: 'off',
};
writeFileSync(configPath, `${JSON.stringify(config, undefined, 2)}\n`);

const eslintVerify = spawnSync(guardrails, ['verify'], {
  cwd: fixture,
  encoding: 'utf8',
});
if (eslintVerify.status === 0) {
  fail(
    'eslint-enabled verify exited 0 on a file with a lint error. ' +
      `stdout:\n${eslintVerify.stdout}\nstderr:\n${eslintVerify.stderr}`,
  );
}
if (!eslintVerify.stderr.includes('no-unused-labels')) {
  fail(
    'eslint-enabled verify did not report the planted rule violation. ' +
      `stdout:\n${eslintVerify.stdout}\nstderr:\n${eslintVerify.stderr}`,
  );
}
console.log('smoke-tarball: OK — eslint runs and reports from the tarball');

// 8. The peer-range check must not report the DEVELOPMENT repo's dependency
// graph. This fixture installs TypeScript by local path, which npm satisfies
// with a symlink -- and `npm ls --all` walks straight through it into the
// linked target's own tree. CI caught the adapter reporting seven findings
// that way, all belonging to this repo rather than the fixture, including
// "chai violates a range required by node_modules/typescript" (TypeScript
// requires no such thing). The adapter now reports only packages physically
// inside the repo it was asked about; this is the end-to-end proof, and it is
// free because the link already exists above.
const peerConfig = JSON.parse(readFileSync(configPath, 'utf8'));
peerConfig.analyzers = {
  'npm-peers': 'required',
  eslint: 'off',
  tsc: 'off',
  knip: 'off',
  'dependency-cruiser': 'off',
  stryker: 'off',
};
writeFileSync(configPath, `${JSON.stringify(peerConfig, undefined, 2)}\n`);
const peerVerify = spawnSync(guardrails, ['gate', '--mode=ci'], {
  cwd: fixture,
  encoding: 'utf8',
});
if (peerVerify.stderr.includes('peer-range-violation')) {
  fail(
    "the peer-range check reported findings from the linked dependency's own " +
      `tree rather than this repo's. stderr:\n${peerVerify.stderr}`,
  );
}

console.log(
  "smoke-tarball: OK — peer check ignores a linked dependency's tree",
);
