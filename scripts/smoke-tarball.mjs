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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
  'copilot/agents/guardrail-fixer.agent.md',
  'copilot/agents/guardrail-fixer-thorough.agent.md',
  'copilot/hooks/guardrails.json',
  'githooks/pre-commit',
]) {
  if (!existsSync(path.join(installed, 'templates', relative))) {
    fail(`the tarball is missing templates/${relative}`);
  }
}

// 5. The bin must resolve and the ESM entry must load. `guardrails` with no
//    subcommand prints usage and exits 1 — a real exercise of argv parsing and
//    every top-level import, without needing a git repo or any analyzer.
//    NOTE (piece 4): replace this with `init --plan` once that command exists;
//    it exercises far more of the install path.
let usage = '';
try {
  run(path.join(fixture, 'node_modules', '.bin', 'guardrails'), [], fixture);
  fail(
    '`guardrails` with no arguments exited 0; expected the usage banner and exit 1',
  );
} catch (error) {
  usage = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  if (error.status !== 1) {
    fail(
      `\`guardrails\` exited ${error.status}, expected 1. Output:\n${usage}`,
    );
  }
}
if (!usage.includes('usage: guardrails')) {
  fail(`the CLI ran but printed no usage banner. Output:\n${usage}`);
}

console.log('smoke-tarball: OK — tarball installs and the CLI runs from it');
