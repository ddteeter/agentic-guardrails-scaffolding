#!/usr/bin/env node
// Sync the fixer agents from the plugin (the single source of truth) into
// .claude/agents/, so this repo's dogfooded loop uses the same definitions with
// no dual maintenance. Runs as part of `npm run build` (and therefore `prepare`,
// pre-push, and CI). `.claude/agents/` is generated and gitignored — never edit
// it directly; edit guardrails-plugin/agents/ and rebuild.
//
// Also emits Copilot-format fixers to .github/agents/*.agent.md. Unlike
// .claude/agents/, that directory is COMMITTED — the Copilot cloud agent reads
// it from the default branch — so a CI drift-guard (`git diff --exit-code --
// .github/agents`) keeps the committed output in sync with the source.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const from = path.join(root, 'guardrails-plugin', 'agents');
const to = path.join(root, '.claude', 'agents');
const githubAgents = path.join(root, '.github', 'agents');

// Clear the destination first so a source file that was renamed or deleted
// can't leave a stale generated copy behind (`.claude/agents/` is gitignored, so
// a leftover would persist silently — the exact drift this script prevents).
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const agents = readdirSync(from).filter((file) => file.endsWith('.md'));
for (const file of agents) {
  copyFileSync(path.join(from, file), path.join(to, file));
}
console.log(
  `synced ${agents.length} agent(s): guardrails-plugin/agents → .claude/agents`,
);

// Copilot fixer tool allowlist (Copilot tool names, NOT Claude's). Read+edit
// family only; `bash` and `agent`/`task` are withheld so the fixer can't shell
// out or fan out (the latter reinforced by `agents: []`).
const COPILOT_TOOLS = [
  'view',
  'edit',
  'create',
  'apply_patch',
  'str_replace_editor',
];

// Map the CC model tier keyword → a Copilot model id from guardrails.config.json.
const cfg = (() => {
  try {
    return JSON.parse(
      readFileSync(path.join(root, 'guardrails.config.json'), 'utf8'),
    );
  } catch {
    return {};
  }
})();
const MODEL_FOR = {
  haiku: cfg.copilotFastModel,
  sonnet: cfg.copilotThoroughModel,
};

function frontmatterField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

function toCopilotAgent(source) {
  const parts = source.split(/^---$/m);
  // parts[0] = '' , parts[1] = frontmatter , parts.slice(2) = body
  const fm = parts[1];
  // Strip ALL leading newlines (not just one): the source has a blank line
  // after its closing frontmatter `---`, and `lines.push('---', '', body, '')`
  // below already inserts the single separator blank line. Stripping only one
  // newline here would leave a second, spurious blank line that prettier (run
  // by lint-staged at commit) collapses away — making the raw `npm run build`
  // output permanently disagree with the committed, prettier-clean file and
  // fail the CI drift-guard on every run.
  const body = parts.slice(2).join('---').replace(/^\n+/, '');
  const name = frontmatterField(fm, 'name');
  const description = frontmatterField(fm, 'description');
  const model = MODEL_FOR[frontmatterField(fm, 'model')];
  const lines = ['---', `name: ${name}`, `description: ${description}`];
  lines.push(`tools: [${COPILOT_TOOLS.join(', ')}]`);
  lines.push('agents: []');
  if (model) lines.push(`model: ${model}`);
  lines.push('---', '', body.trimEnd(), '');
  return lines.join('\n');
}

rmSync(githubAgents, { recursive: true, force: true });
mkdirSync(githubAgents, { recursive: true });
for (const file of agents) {
  const source = readFileSync(path.join(from, file), 'utf8');
  const target = file.replace(/\.md$/, '.agent.md');
  writeFileSync(path.join(githubAgents, target), toCopilotAgent(source));
}
console.log(
  `synced ${agents.length} agent(s): guardrails-plugin/agents → .github/agents (.agent.md)`,
);
