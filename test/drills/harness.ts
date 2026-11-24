// SPDX-License-Identifier: MIT
// Shared harness for end-to-end supervisor drills: a real git source repo,
// the real LocalForge, real check commands, an in-memory store with a skewable
// clock, and scripted fake agents.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentApi } from '../../src/agent-api.ts';
import { CommandCheckRunner } from '../../src/checks.ts';
import { defaultConfig, validateConfig, type ProjectConfig } from '../../src/config.ts';
import { LocalForge } from '../../src/git/local-forge.ts';
import { resolveHome } from '../../src/home.ts';
import { MemoryNotifier } from '../../src/notify.ts';
import { FakeRunner, commitFile, type FakeBehavior, type FakeControl } from '../../src/runner/fake.ts';
import { Store } from '../../src/store.ts';
import { Supervisor } from '../../src/supervisor.ts';
import type { CheckRunner, Forge, RunSpec, Task, TaskState } from '../../src/types.ts';

export { commitFile };
export type { FakeControl };

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

/** A builder result object in the shape the supervisor expects. */
export function builderResult(status: 'completed' | 'needs_decision' | 'blocked' | 'failed', summary = 'done') {
  return { status, summary, changes: [], testsRun: [], acceptance: [], limitations: [], followUps: [] };
}

export const approve = { verdict: 'approve', risk: 'low', summary: 'looks good', findings: [] };

export interface Harness {
  store: Store;
  sup: Supervisor;
  agentApi: AgentApi;
  cfg: ProjectConfig;
  src: string;
  tmp: string;
  /** The autopilot's private bare clone. */
  bare: string;
  /** Content of a file on the integrated target branch, or null. */
  readTarget(path: string): string | null;
  notifier: MemoryNotifier;
  clock: { skew: number };
  /** The run token handed to a fake agent (from its MCP config). */
  tokenOf(spec: RunSpec): string;
  callTool(spec: RunSpec, name: string, args: unknown): Promise<{ status: number; body: any }>;
  addTask(title: string, extra?: Partial<Parameters<Store['createTask']>[0]>): Task;
  waitFor(pred: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  waitState(taskId: string, state: TaskState | TaskState[], timeoutMs?: number): Promise<Task>;
  /** Start a second supervisor on the same store (restart drills). */
  restart(): Promise<Supervisor>;
  cleanup(): Promise<void>;
}

export async function harness(opts: {
  behavior: (spec: RunSpec) => FakeBehavior;
  config?: (cfg: ProjectConfig) => void;
  checks?: (cfg: ProjectConfig) => CheckRunner;
  /** Wrap the real LocalForge (e.g. to emulate GitHub). */
  forge?: (local: LocalForge) => Forge;
}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-drill-'));
  const src = join(tmp, 'source');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, 'README.md'), '# drill\n');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'initial');

  const clock = { skew: 0 };
  const store = Store.open(':memory:', () => Date.now() + clock.skew);
  const raw = defaultConfig('drill', 'Drill', src);
  raw.execution.runner = 'fake';
  raw.execution.maxBuilders = 2;
  raw.planner.enabled = false;
  raw.checks.commands = [{ name: 'no-broken-marker', run: [process.execPath, '-e', "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"], timeoutSeconds: 30 }];
  opts.config?.(raw);
  const cfg = validateConfig(JSON.parse(JSON.stringify(raw)));
  const home = resolveHome(join(tmp, 'home'));
  const notifier = new MemoryNotifier();
  const agentApi = new AgentApi(store);
  const make = () =>
    new Supervisor({
      store,
      home,
      apiUrl: 'http://127.0.0.1:9', // fake agents call AgentApi directly
      mcpServerPath: '/unused',
      loadConfigs: () => ({ configs: [cfg], errors: [] }),
      makeRunner: () => new FakeRunner(opts.behavior),
      makeForge: (c) => {
        const local = new LocalForge({
          source: c.repo.source,
          home: home.projectDir(c.id),
          targetBranch: c.repo.targetBranch,
          branchPrefix: c.repo.branchPrefix,
          strategy: c.integration.strategy,
          pushIntegratedTo: c.repo.pushIntegratedTo,
        });
        return opts.forge ? opts.forge(local) : local;
      },
      makeChecks: (c) => opts.checks?.(c) ?? new CommandCheckRunner(c.checks),
      makeNotifier: () => notifier,
      tickMs: 40,
      log: () => undefined,
    });
  let sup = make();
  store.upsertProject(cfg);

  const tokenOf = (spec: RunSpec) => (spec.mcpConfig as any).mcpServers.autopilot.env.AUTOPILOT_RUN_TOKEN as string;
  const h: Harness = {
    store,
    get sup() {
      return sup;
    },
    agentApi,
    cfg,
    src,
    tmp,
    bare: join(home.projectDir(cfg.id), 'repo.git'),
    readTarget(path: string) {
      try {
        return execFileSync('git', ['show', `refs/heads/${cfg.repo.targetBranch}:${path}`], { cwd: join(home.projectDir(cfg.id), 'repo.git'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    },
    notifier,
    clock,
    tokenOf,
    callTool: (spec, name, args) => agentApi.callTool(tokenOf(spec), name, args) as Promise<{ status: number; body: any }>,
    addTask: (title, extra = {}) =>
      store.createTask({ projectId: 'drill', title, objective: title, origin: 'human', state: 'ready', ownedPaths: [`${title.toLowerCase().replace(/\W+/g, '-')}/**`], ...extra }),
    async waitFor(pred, what, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      const tasks = store.listTasks().map((t) => `${t.id}:${t.state}(${t.stateReason ?? ''})`).join(', ');
      throw new Error(`timed out waiting for ${what}; tasks: ${tasks}`);
    },
    async waitState(taskId, state, timeoutMs) {
      const states = Array.isArray(state) ? state : [state];
      await h.waitFor(() => states.includes(store.getTask(taskId)!.state), `${taskId} -> ${states.join('|')}`, timeoutMs);
      return store.getTask(taskId)!;
    },
    async restart() {
      await sup.stop();
      sup = make();
      await sup.start();
      return sup;
    },
    async cleanup() {
      await sup.stop().catch(() => undefined);
      store.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return h;
}

/** Behaviour helper: builders write `<dir>/<task>.txt` and complete; reviewers approve. */
export function simpleBehavior(overrides: { builder?: (spec: RunSpec, ctl: FakeControl) => Promise<any> | null } = {}) {
  return (spec: RunSpec): FakeBehavior =>
    async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      const custom = overrides.builder?.(spec, ctl);
      if (custom) return custom;
      const id = spec.env.AUTOPILOT_TASK_ID;
      await commitFile(ctl, `work/${id}.txt`, `${id}\n`, `work for ${id}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    };
}
