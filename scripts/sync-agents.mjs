#!/usr/bin/env node
// Sync the fixer agents from the plugin (the single source of truth) into
// .claude/agents/, so this repo's dogfooded loop uses the same definitions with
// no dual maintenance. Runs as part of `npm run build` (and therefore `prepare`,
// pre-push, and CI). `.claude/agents/` is generated and gitignored — never edit
// it directly; edit guardrails-plugin/agents/ and rebuild.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const from = path.join(root, 'guardrails-plugin', 'agents');
const to = path.join(root, '.claude', 'agents');

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
