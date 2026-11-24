#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// SPDX-License-Identifier: MIT
// Live smoke test with REAL Claude Code workers (uses your subscription; a few minutes).
// Not part of `npm test`. Run after `claude auth login`:  npm run smoke [-- --model sonnet]
//
// It creates a throwaway repo and autopilot home under the OS temp dir, runs the real
// supervisor + HTTP agent bridge + claude -p runner on two small tasks, answers the
// decision card that the second task must raise, and prints a report.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentApi } from '../src/agent-api.ts';
import { CommandCheckRunner } from '../src/checks.ts';
import { defaultConfig, validateConfig } from '../src/config.ts';
import { LocalForge } from '../src/git/local-forge.ts';
import { resolveHome } from '../src/home.ts';
import { startHttpServer } from '../src/http/server.ts';
import { NullNotifier } from '../src/notify.ts';
import { ClaudeCliRunner } from '../src/runner/claude-cli.ts';
import { Store } from '../src/store.ts';
import { Supervisor } from '../src/supervisor.ts';
import type { SupervisorActions } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { model: { type: 'string', default: 'sonnet' }, keep: { type: 'boolean' }, timeout: { type: 'string', default: '20' } } });

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN')) delete env[k];
  return env;
}

const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', env: cleanEnv() });
let loggedIn = false;
try {
  loggedIn = !!JSON.parse(auth.stdout).loggedIn || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
} catch {
  /* not JSON */
}
if (auth.error || !loggedIn) {
  const why = auth.error
    ? 'the claude CLI was not found on PATH (install Claude Code first)'
    : 'the claude CLI is not logged in for unattended runs (run `claude auth login`, or set CLAUDE_CODE_OAUTH_TOKEN)';
  console.log(`SKIPPED: live smoke test not run — ${why}. Nothing was started and no usage was spent.`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'ap-live-'));
const src = join(tmp, 'repo');
mkdirSync(src);
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd: src, stdio: 'ignore' });
g('init', '-q', '-b', 'main');
writeFileSync(join(src, 'README.md'), '# Smoke test repo\n');
g('add', '.');
g('commit', '-q', '-m', 'initial');

const raw = defaultConfig('smoke', 'Smoke', src);
raw.execution.model = values.model!;
raw.execution.maxBuilders = 2;
raw.execution.maxTurns = 30;
raw.execution.runTimeoutMinutes = 10;
raw.planner.enabled = false;
raw.checks.commands = [{ name: 'files-exist', run: [process.execPath, '-e', "process.exit(require('fs').existsSync('hello.txt') || require('fs').existsSync('greeting.txt') ? 0 : 1)"], timeoutSeconds: 60 }];
const cfg = validateConfig(JSON.parse(JSON.stringify(raw)));
const home = resolveHome(join(tmp, 'home'));
const store = Store.open(home.dbPath);
store.upsertProject(cfg);

let supervisor: Supervisor | null = null;
const actions: SupervisorActions = {
  wake: () => supervisor?.wake(),
  pauseAll: (r) => supervisor?.pauseAll(r),
  resumeAll: (r) => supervisor?.resumeAll(r),
  pauseProject: (id, r) => supervisor?.pauseProject(id, r),
  resumeProject: (id, r) => supervisor?.resumeProject(id, r),
  addTask: (i) => supervisor!.addTask(i),
  retryTask: (id) => supervisor!.retryTask(id),
  cancelTask: (id) => supervisor!.cancelTask(id),
};
const agentTools = new AgentApi(store, { onChange: () => supervisor?.wake() });
const http = await startHttpServer({ store, agentTools, actions, staticDir: join(ROOT, 'src', 'inbox'), host: '127.0.0.1', port: 0 });
supervisor = new Supervisor({
  store,
  home,
  apiUrl: `http://127.0.0.1:${http.port}`,
  mcpServerPath: join(ROOT, 'src', 'mcp', 'server.ts'),
  loadConfigs: () => ({ configs: [cfg], errors: [] }),
  makeRunner: () => new ClaudeCliRunner({ claudeBin: 'claude' }),
  makeForge: (c) => new LocalForge({ source: c.repo.source, home: home.projectDir(c.id), targetBranch: c.repo.targetBranch, branchPrefix: c.repo.branchPrefix, strategy: c.integration.strategy, pushIntegratedTo: null }),
  makeChecks: (c) => new CommandCheckRunner(c.checks),
  makeNotifier: () => new NullNotifier(),
  tickMs: 1000,
  log: (l) => console.error(`  [supervisor] ${l}`),
});

const plain = store.createTask({
  projectId: 'smoke',
  title: 'Add hello.txt',
  objective: 'Create a file hello.txt at the repository root containing exactly the line "hello" and commit it.',
  acceptanceCriteria: ['hello.txt exists with the single line "hello"', 'the change is committed'],
  ownedPaths: ['hello.txt'],
  origin: 'human',
  state: 'ready',
});
const asking = store.createTask({
  projectId: 'smoke',
  title: 'Add a greeting in the founder-chosen language',
  objective:
    'Create greeting.txt with a one-line greeting. The language is a founder decision: call the request_decision tool with the options "en" (English) and "de" (German), recommend "en", then end your run with status needs_decision without creating the file. When resumed with the answer, write the greeting in that language and commit it.',
  acceptanceCriteria: ['greeting.txt contains one greeting line in the language the founder chose', 'the change is committed'],
  ownedPaths: ['greeting.txt'],
  origin: 'human',
  state: 'ready',
});

const started = Date.now();
const deadline = started + Number(values.timeout) * 60_000;
await supervisor.start();
let answered = false;
console.log(`Running 2 tasks with real Claude (${values.model}); this takes a few minutes…`);
while (Date.now() < deadline) {
  const card = store.listDecisions({ status: ['pending'] }).find((d) => d.taskId === asking.id);
  if (card && !answered) {
    const opt = card.options.find((o) => /de|german/i.test(`${o.id} ${o.label}`))?.id ?? card.options[0]?.id ?? null;
    const r = store.respond({ decisionId: card.id, revision: card.revision, optionId: opt, comment: opt ? null : 'German please', actor: 'smoke-test', idempotencyKey: `smoke-${card.id}` });
    console.log(`  card ${card.id} "${card.question}" answered with ${opt ?? '(comment)'}: ${r.status}`);
    answered = true;
    supervisor.wake();
  }
  const states = [plain, asking].map((t) => store.getTask(t.id)!.state);
  if (states.every((s) => ['integrated', 'exhausted', 'cancelled'].includes(s))) break;
  const other = store.listDecisions({ status: ['pending'] }).filter((d) => d.taskId !== asking.id || answered);
  if (other.some((d) => d.kind === 'diagnostic' && d.dedupeKey === 'auth')) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await supervisor.stop();
await http.close();

console.log('\n=== Live smoke report ===');
for (const t of [plain, asking].map((x) => store.getTask(x.id)!)) console.log(`${t.id} ${t.title}: ${t.state} (attempts ${t.attempts}, repairs ${t.repairCycles})`);
const runs = store.listRuns({ limit: 50 }).reverse();
for (const r of runs) console.log(`  ${r.id} ${r.role.padEnd(8)} ${r.status.padEnd(10)} turns=${r.numTurns ?? '-'} cost≈$${(r.costUsd ?? 0).toFixed(3)} ${r.error ? `error: ${r.error.slice(0, 120)}` : ''}`);
const decisions = store.listDecisions({});
console.log(`Decisions: ${decisions.map((d) => `${d.id} ${d.kind} ${d.status}`).join(', ') || 'none'}`);
const asked = decisions.some((d) => d.taskId === asking.id && d.createdBy === 'agent');
const yielded = runs.some((r) => r.taskId === asking.id && r.status === 'yielded');
const resumed = runs.some((r) => r.taskId === asking.id && r.resumedSessionId);
let main = '';
try {
  main = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: join(home.projectDir('smoke'), 'repo.git'), encoding: 'utf8' });
} catch {
  /* no repo */
}
console.log(`\nMCP request_decision used: ${asked ? 'yes' : 'NO'} · yielded: ${yielded ? 'yes' : 'NO'} · resumed with answer: ${resumed ? 'yes' : 'NO'}`);
console.log(`Merged into main:\n${main.split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n')}`);
console.log(`Duration: ${Math.round((Date.now() - started) / 1000)}s · run logs: ${home.root}/runs/<run-id>/stream.jsonl${values.keep ? '' : ' (pass --keep to keep them)'}`);
const bothIntegrated = [plain, asking].every((t) => store.getTask(t.id)!.state === 'integrated');
store.close();
const ok = bothIntegrated && asked && yielded && resumed;
console.log(ok ? '\nPASS: real workers built, asked, yielded, resumed and merged.' : '\nFAIL: see the report above.');
if (!values.keep) spawnSync('rm', ['-rf', tmp]);
process.exit(ok ? 0 : 1);
