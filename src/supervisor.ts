// SPDX-License-Identifier: MIT
// The supervisor: ordinary code that schedules model runs, never a model itself.
// It claims tasks with fenced leases, launches builder/reviewer/planner runs,
// runs deterministic checks, classifies merges, integrates serially, turns
// exceptions into decision cards, and resumes blocked work when answers arrive.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { killAllCheckProcesses } from './checks.ts';
import { configHash, DEFAULT_DISALLOWED_TOOLS, profileAllowsDispatch, stableStringify, type ProjectConfig } from './config.ts';
import { git, redact, type GitOptions } from './git/git.ts';
import { findIntegrationCommit } from './git/local-forge.ts';
import type { Home } from './home.ts';
import { classifyMerge, reviewCardText, type MergeVerdict } from './policy/merge-policy.ts';
import { ownershipOverlaps } from './policy/glob.ts';
import {
  BUILDER_RESULT_SCHEMA,
  PLANNER_RESULT_SCHEMA,
  REVIEWER_RESULT_SCHEMA,
  builderPrompt,
  builderSystemPrompt,
  parseBuilderResult,
  parsePlannerResult,
  parseReviewerResult,
  plannerPrompt,
  plannerSystemPrompt,
  prBody,
  reviewerCheckCommands,
  reviewerGitCommands,
  reviewerPrompt,
  reviewerSystemPrompt,
} from './prompts.ts';
import { StateError, type Store } from './store.ts';
import type {
  BuilderResult,
  CheckRunner,
  Decision,
  DiffSummary,
  Forge,
  IntegrationResult,
  Notifier,
  Run,
  RunEvent,
  RunHandle,
  RunOutcome,
  RunRole,
  RunSpec,
  Runner,
  SupervisorActions,
  Task,
  TaskState,
} from './types.ts';
import { findSecrets, NEVER_AUTO_COMMIT, randomToken, SAFE_GIT_FLAGS, scrubbedEnv, secretKinds, sha256Hex, slugify, uuid } from './util.ts';

/** git over builder-controlled worktrees: no repository hooks/helpers, no credentials in the environment. */
const safeGit = (args: string[], opts: Omit<GitOptions, 'env'>) => git([...SAFE_GIT_FLAGS, ...args], { ...opts, env: scrubbedEnv() });

/** The secret scan reads at most this much patch text of a branch's commits; beyond it, it fails closed. */
const SECRET_SCAN_MAX_BYTES = 32 * 1024 * 1024;

export interface ProjectRuntime {
  cfg: ProjectConfig;
  forge: Forge;
  checks: CheckRunner;
  runner: Runner;
  notifier: Notifier;
  barePath: string | null;
  preparedAt: number | null;
  prepareError: string | null;
  /** Background repository sync in progress (never blocks the shared tick). */
  preparing: boolean;
  /** Background GitHub feedback poll in progress. */
  polling: boolean;
  merging: boolean;
  checkJobs: number;
  plannerRunId: string | null;
  lastFeedbackPoll: number;
}

export interface SupervisorOptions {
  store: Store;
  home: Home;
  /** Base URL of this supervisor's HTTP API, handed to the MCP bridge of each run. */
  apiUrl: string;
  /** Absolute path to src/mcp/server.ts. */
  mcpServerPath: string;
  loadConfigs(): { configs: ProjectConfig[]; errors: { id: string; message: string }[] };
  makeRunner(cfg: ProjectConfig): Runner;
  makeForge(cfg: ProjectConfig): Forge;
  makeChecks(cfg: ProjectConfig): CheckRunner;
  makeNotifier(cfg: ProjectConfig): Notifier;
  /** Apply config files from disk at start without asking (the founder just edited them). */
  acceptDiskConfig?: boolean;
  tickMs?: number;
  log?: (line: string) => void;
}

interface ActiveRun {
  runId: string;
  role: RunRole;
  projectId: string;
  taskId: string | null;
  generation: number;
  handle: RunHandle;
  lastBeat: number;
}

interface Job {
  owner: string;
  taskId: string;
  generation: number;
  ttlMs: number;
}

/**
 * Pre-approved builder tools per permission mode. In "auto" mode Claude Code's
 * classifier judges shell, web and out-of-tree actions, so we pre-approve only
 * read-only tools; with acceptEdits the mode covers in-tree edits and Bash must
 * be allowed explicitly; dontAsk denies anything not listed.
 */
function builderTools(mode: RunSpec['permissionMode']): string[] {
  const read = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Task'];
  if (mode === 'auto' || mode === 'bypassPermissions') return read;
  if (mode === 'acceptEdits') return [...read, 'Bash', 'WebSearch', 'WebFetch'];
  return [...read, 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebSearch', 'WebFetch'];
}
/**
 * Reviewers and planners. Their only prefix rules are for commands without an option that writes
 * files: git diff, log and show have --output=<file>, and check commands have their own (eslint -o,
 * --fix). A reviewer gets exact rules for the commands its prompt names (reviewerGitCommands,
 * reviewerCheckCommands).
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git ls-files:*)', 'Bash(ls:*)'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/**
 * Builders never need GitHub or ref-rewriting git commands; the supervisor does all
 * publishing and integration. (Defense in depth: the target-branch integrity check
 * and the merge gate do not rely on these rules.)
 */
const BUILDER_DENY = [
  'Bash(gh pr:*)',
  'Bash(gh api:*)',
  'Bash(gh issue:*)',
  'Bash(gh repo:*)',
  'Bash(gh release:*)',
  'Bash(gh auth:*)',
  'Bash(gh secret:*)',
  'Bash(git update-ref:*)',
  'Bash(git branch -f:*)',
  'Bash(git branch --force:*)',
  'Bash(git branch -D:*)',
  'Bash(git branch -M:*)',
  'Bash(git commit-tree:*)',
  'Bash(git replace:*)',
  'Bash(git push:*)',
  'Bash(git -C:*)',
  'Bash(git config:*)',
  'Bash(git remote:*)',
  'Bash(git worktree:*)',
];
/** Nothing an agent runs should read credentials. (The autopilot's own state: see stateDeny.) */
const CREDENTIAL_DENY = [
  'Read(~/.ssh/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.aws/**)',
  'Read(~/.npmrc)',
  'Read(~/.netrc)',
  'Edit(~/.ssh/**)',
  'Edit(~/.claude/settings.json)',
  'Bash(gh auth token:*)',
  'Bash(security find-generic-password:*)',
];

/**
 * The autopilot's database, token, policies and run logs. Worktrees live under the
 * same home, so only these files are denied (absolute-path rules use a leading //).
 */
function stateDeny(root: string): string[] {
  const abs = `//${root.replace(/^\/+/, '')}`;
  return [
    `Read(${abs}/autopilot.db*)`,
    `Edit(${abs}/autopilot.db*)`,
    `Read(${abs}/claude-oauth-token)`,
    `Edit(${abs}/claude-oauth-token)`,
    `Read(${abs}/projects/*/config.json)`,
    `Edit(${abs}/projects/*/config.json)`,
    `Edit(${abs}/server.json)`,
    `Read(${abs}/runs/**)`,
  ];
}
const MCP = (names: string[]) => names.map((n) => `mcp__autopilot__${n}`);
const IN_FLIGHT: TaskState[] = ['building', 'checking', 'review_ready', 'reviewing', 'merge_ready', 'merging', 'waiting_decision'];
const OPEN: TaskState[] = ['ready', 'building', 'checking', 'review_ready', 'reviewing', 'merge_ready', 'merging'];
const MIN = 60_000;

export class Supervisor implements SupervisorActions {
  readonly store: Store;
  readonly bootId = `sup-${randomToken(6)}`;
  private readonly opts: SupervisorOptions;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly jobs = new Map<string, Job>();
  private timer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private stopping = false;
  private lastConfigSync = 0;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.store = opts.store;
  }

  private now(): number {
    return this.store.now();
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => process.stderr.write(`[autopilot] ${l}\n`)))(line);
  }

  /** Track a background promise so stop() can wait for it and errors are never unhandled. */
  private track<T>(p: Promise<T>, what: string): void {
    const wrapped = p
      .catch((err) => {
        this.log(`${what} failed: ${(err as Error).stack ?? err}`);
        this.store.event({ type: 'supervisor.error', message: `${what}: ${(err as Error).message ?? err}` });
      })
      .finally(() => {
        this.pending.delete(wrapped);
        this.wake();
      });
    this.pending.add(wrapped);
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.recoverAfterRestart();
    this.syncProjects(true);
    // Policy cards from a previous process refer to proposals that are no longer held in memory.
    for (const d of this.store.listDecisions({ status: ['pending'] })) {
      const held = this.pendingPolicies.get(d.projectId);
      if (d.dedupeKey?.startsWith('policy:') && (!held || configHash(held) !== d.artifactRef)) this.store.closeDecision(d.id, 'superseded', 'the supervisor restarted');
    }
    this.store.event({ type: 'supervisor.started', message: `Supervisor ${this.bootId} started` });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 5000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const r of this.runs.values()) r.handle.kill('supervisor stopping');
    killAllCheckProcesses(); // setup/check commands must not outlive the supervisor
    const deadline = this.now() + 15_000;
    while (this.pending.size && this.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, 500))]);
    }
    this.store.event({ type: 'supervisor.stopped', message: `Supervisor ${this.bootId} stopped` });
  }

  /** Schedule a scheduling pass soon (coalesced). */
  wake(): void {
    if (this.stopping || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.tick();
    }, 50);
  }

  /** Runs/leases left over from a previous supervisor process. */
  private recoverAfterRestart(): void {
    for (const run of this.store.listRuns({ status: ['running'], limit: 1000 })) {
      killStaleProcess(run);
      this.store.finishRun(run.id, { status: 'lost', error: 'supervisor restarted while the run was active' });
    }
    for (const t of this.store.leasesHeldBy(() => true)) {
      const to = recoveryState(t.state);
      // One transaction: once the lease is broken, no later restart would find the merge again.
      this.store.tx(() => {
        const recovered = this.store.breakLease(t.id, t.leaseOwner!, to, 'supervisor restarted');
        if (!recovered || t.state !== 'merging') return;
        const ids = this.interruptedMerges(t.projectId);
        if (!ids.includes(t.id)) this.store.setKv(`interrupted_merges:${t.projectId}`, JSON.stringify([...ids, t.id]));
      });
      if (t.state === 'building') this.store.addNote(t.id, 'supervisor', 'The previous run was interrupted by a supervisor restart; continue from the current branch state.');
    }
  }

  /**
   * The project's tasks whose merge a previous supervisor process left unfinished, as crash
   * recovery found them (see isOwnMergeOnTop). Stored, so that a crash before the project's first
   * target check after the restart does not lose them, and kept only until that check or the
   * start of any worker run of the project (endCrashRecovery).
   */
  private interruptedMerges(projectId: string): string[] {
    return this.kvList(`interrupted_merges:${projectId}`);
  }

  /** The merge a merge job is about to move the target to (written before its compare-and-swap). */
  private pendingMerge(projectId: string): { taskId: string; base: string; commit: string } | null {
    try {
      const v = JSON.parse(this.store.getKv(`merge_pending:${projectId}`) ?? 'null');
      return v && typeof v.taskId === 'string' && typeof v.base === 'string' && typeof v.commit === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  private endCrashRecovery(projectId: string): void {
    this.store.setKv(`interrupted_merges:${projectId}`, null);
  }

  /**
   * Heads of the source's branch that the project's forge was about to fast-forward the target
   * to, as the source confirmed them (Forge.beforeFastForward), since the target was last
   * checked after a sync (see isUpstreamAdvance). Stored before the target moves, so that a crash
   * between the move and its record does not look like tampering, even to a restart that cannot
   * reach the source; dropped once that check has run (forgetUpstream).
   */
  private upstreamHeads(projectId: string): string[] {
    return this.kvList(`upstream_heads:${projectId}`);
  }

  /** Heads dropped by unrememberUpstream in this process, so that a drop the store failed to keep still counts. */
  private readonly unvouched = new Set<string>();

  private rememberUpstream(projectId: string, head: string): void {
    const heads = this.upstreamHeads(projectId);
    if (!heads.includes(head)) this.store.setKv(`upstream_heads:${projectId}`, JSON.stringify([...heads, head].slice(-10)));
    this.unvouched.delete(`${projectId}:${head}`);
  }

  private unrememberUpstream(projectId: string, head: string): void {
    this.unvouched.add(`${projectId}:${head}`); // first: a store error must not leave it vouched for
    const heads = this.upstreamHeads(projectId);
    if (heads.includes(head)) this.store.setKv(`upstream_heads:${projectId}`, JSON.stringify(heads.filter((h) => h !== head)));
  }

  private forgetUpstream(projectId: string): void {
    this.store.setKv(`upstream_heads:${projectId}`, null);
    for (const key of this.unvouched) if (key.startsWith(`${projectId}:`)) this.unvouched.delete(key);
  }

  /** A JSON list of strings kept in the kv table; a malformed value reads as empty. */
  private kvList(key: string): string[] {
    try {
      const items: unknown = JSON.parse(this.store.getKv(key) ?? '[]');
      return Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------ the loop

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        if (this.now() - this.lastConfigSync > 30_000) this.syncProjects(false);
        this.heartbeatLiveWork();
        this.expireLeases();
        await this.processOutbox();
        for (const rt of this.runtimes.values()) {
          if (this.stopping) break;
          try {
            await this.tickProject(rt);
          } catch (err) {
            this.log(`tick ${rt.cfg.id}: ${(err as Error).stack ?? err}`);
          }
        }
      } while (this.again && !this.stopping);
    } finally {
      this.ticking = false;
    }
  }

  private syncProjects(initial: boolean): void {
    this.lastConfigSync = this.now();
    const { configs, errors } = this.opts.loadConfigs();
    for (const e of errors) {
      const existing = this.store.getProject(e.id);
      if (existing && !existing.paused) this.store.setProjectPaused(e.id, true, `invalid config: ${e.message.slice(0, 300)}`);
      if (initial) this.log(`project ${e.id}: ${e.message}`);
    }
    for (const cfg of configs) {
      const rt = this.runtimes.get(cfg.id);
      if (rt && configHash(rt.cfg) === configHash(cfg)) continue;
      // A policy file that changes after start might have been written by a builder (they run
      // as the same user), so changes only apply after the founder confirms on a card.
      if (rt) {
        this.proposePolicyChange(rt.cfg, cfg);
        continue;
      }
      const row = this.store.getProject(cfg.id);
      if (row?.config && row.configHash !== configHash(cfg) && !this.opts.acceptDiskConfig) {
        this.applyConfig(row.config, undefined); // keep running on the last approved policy
        this.proposePolicyChange(row.config, cfg);
        continue;
      }
      if (!row && !initial && !this.opts.acceptDiskConfig) {
        this.proposePolicyChange(null, cfg); // a project that appeared while running
        continue;
      }
      this.applyConfig(cfg, undefined);
    }
  }

  /** Install a validated config: create the runtime, or update it in place so in-flight jobs keep working. */
  private applyConfig(cfg: ProjectConfig, rt: ProjectRuntime | undefined): void {
    let parts: Pick<ProjectRuntime, 'forge' | 'checks' | 'runner' | 'notifier'>;
    try {
      parts = { forge: this.opts.makeForge(cfg), checks: this.opts.makeChecks(cfg), runner: this.opts.makeRunner(cfg), notifier: this.opts.makeNotifier(cfg) };
    } catch (err) {
      // Fail closed for this project only; never take the whole supervisor down.
      if (!this.store.getProject(cfg.id)) this.store.upsertProject(cfg);
      this.store.setProjectPaused(cfg.id, true, `invalid config: ${(err as Error).message}`.slice(0, 300));
      return;
    }
    parts.forge.beforeFastForward = (head) => this.rememberUpstream(cfg.id, head);
    parts.forge.fastForwardFailed = (head) => this.unrememberUpstream(cfg.id, head);
    const before = this.store.getProject(cfg.id);
    this.store.upsertProject(cfg);
    if (before?.paused && before.pauseReason?.startsWith('invalid config')) this.store.setProjectPaused(cfg.id, false, 'config is valid again');
    if (rt) {
      Object.assign(rt, { cfg, ...parts, preparedAt: null, prepareError: null });
    } else {
      this.runtimes.set(cfg.id, { cfg, ...parts, barePath: null, preparedAt: null, prepareError: null, preparing: false, polling: false, merging: false, checkJobs: 0, plannerRunId: null, lastFeedbackPoll: 0 });
    }
  }

  private readonly pendingPolicies = new Map<string, ProjectConfig>();

  private proposePolicyChange(current: ProjectConfig | null, next: ProjectConfig): void {
    const hash = configHash(next);
    if (this.store.getKv(`policy_declined:${next.id}`) === hash) return;
    if (this.pendingPolicies.has(next.id) && configHash(this.pendingPolicies.get(next.id)!) === hash) return;
    this.pendingPolicies.set(next.id, next);
    if (!this.store.getProject(next.id)) this.store.upsertProject({ ...next, profile: 'pause' }); // so the card has a project; nothing runs
    for (const d of this.store.listDecisions({ projectId: next.id, status: ['pending'] })) {
      if (d.dedupeKey?.startsWith(`policy:${next.id}:`) && d.artifactRef !== hash) this.store.closeDecision(d.id, 'superseded', 'the policy file changed again');
    }
    const changed = current ? (Object.keys(next) as (keyof ProjectConfig)[]).filter((k) => stableStringify(next[k]) !== stableStringify(current[k])) : [];
    this.store.createDecision({
      projectId: next.id,
      kind: 'authorization',
      priority: 'high',
      question: current ? `Apply the changed policy file for ${next.name}?` : `Start the new project ${next.name}?`,
      why: current
        ? `config.json changed on disk (sections: ${changed.join(', ') || 'formatting only'}). Builders run as your user and could edit it, so changes wait for you. Until then the project keeps running on the current policy.${next.profile !== current.profile ? `\nProfile: ${current.profile} → ${next.profile}.` : ''}`
        : `A new project config appeared while the autopilot was running (source ${next.repo.source}, profile ${next.profile}). It starts only after you confirm. Start the autopilot with --accept-config to skip this when you add projects yourself.`,
      options: [
        { id: 'apply_policy', label: current ? 'Apply the new policy' : 'Start this project', consequential: true },
        { id: 'keep_policy', label: current ? 'Keep the current policy' : 'Ignore it' },
      ],
      recommendation: null,
      blocking: false,
      artifactRef: hash,
      createdBy: 'supervisor',
      dedupeKey: `policy:${next.id}:${hash}`,
    });
  }

  private answerPolicyCard(d: Decision): void {
    const next = this.pendingPolicies.get(d.projectId);
    if (!next || configHash(next) !== d.artifactRef) return; // superseded by a later edit or a restart
    this.pendingPolicies.delete(d.projectId);
    if (d.answer?.optionId === 'apply_policy') {
      this.applyConfig(next, this.runtimes.get(d.projectId));
      this.store.event({ projectId: d.projectId, decisionId: d.id, type: 'policy.applied', message: `Founder applied policy ${d.artifactRef} (${d.id})` });
    } else {
      this.store.setKv(`policy_declined:${d.projectId}`, d.artifactRef);
      this.store.event({ projectId: d.projectId, decisionId: d.id, type: 'policy.declined', message: `Founder kept the current policy (${d.id})` });
    }
  }

  /** Live processes and supervisor jobs keep their leases while they are alive. */
  private heartbeatLiveWork(): void {
    const now = this.now();
    for (const r of this.runs.values()) {
      if (!r.taskId || now - r.lastBeat < 15_000) continue;
      r.lastBeat = now;
      const rt = this.runtimes.get(r.projectId);
      const ttl = rt ? this.runLeaseMs(rt.cfg) : 15 * MIN;
      if (!this.store.heartbeat(r.taskId, r.runId, r.generation, ttl)) r.handle.kill('lease lost');
    }
    for (const j of this.jobs.values()) this.store.heartbeat(j.taskId, j.owner, j.generation, j.ttlMs);
  }

  private expireLeases(): void {
    for (const t of this.store.expiredLeases()) {
      const owner = t.leaseOwner!;
      const active = this.runs.get(owner);
      // Work this process can see alive (e.g. after the laptop slept past the TTL) keeps
      // its lease; hung processes are caught by the runner's idle timeout instead.
      const job = [...this.jobs.values()].find((j) => j.owner === owner && j.taskId === t.id);
      if ((active && active.taskId === t.id) || job) {
        const rt = this.runtimes.get(t.projectId);
        this.store.renewLease(t.id, owner, t.leaseGeneration, job?.ttlMs ?? (rt ? this.runLeaseMs(rt.cfg) : 15 * MIN));
        continue;
      }
      const run = owner.startsWith('R-') ? this.store.getRun(owner) : null;
      if (run && run.status === 'running') this.store.finishRun(run.id, { status: 'lost', error: 'lease expired without heartbeat' });
      this.store.breakLease(t.id, owner, recoveryState(t.state), 'lease expired');
    }
  }

  private async tickProject(rt: ProjectRuntime): Promise<void> {
    const p = this.store.getProject(rt.cfg.id);
    if (!p) return;
    const pausedAll = this.store.isPausedAll();
    if (pausedAll || p.paused || !profileAllowsDispatch(rt.cfg)) return;

    // Repository sync runs in the background so one slow or unreachable repository never
    // stalls other projects, answer delivery or lease handling. The merge job is the only
    // thing allowed to move the target while it runs, so sync and the integrity check wait.
    if (rt.preparing) return;
    if (!rt.merging && (!rt.preparedAt || (rt.prepareError && this.now() - rt.preparedAt > 2 * MIN) || this.now() - rt.preparedAt > 10 * MIN)) {
      rt.preparing = true;
      this.track(this.prepare(rt).finally(() => (rt.preparing = false)), `prepare ${rt.cfg.id}`);
      return;
    }
    if (rt.prepareError || !rt.barePath) return;
    if (!rt.merging && !(await this.verifyTarget(rt))) return;

    if (rt.forge.kind === 'github' && !rt.polling) {
      rt.polling = true;
      this.track(this.pollFeedback(rt).finally(() => (rt.polling = false)), `feedback ${rt.cfg.id}`);
    }
    this.processFeedback(rt);

    // Deterministic work continues during a usage-limit pause; model runs do not.
    this.startChecks(rt);
    this.startMerge(rt);
    const usageUntil = this.store.usagePausedUntil();
    if (usageUntil && usageUntil > this.now()) return;
    if (usageUntil) this.store.setUsagePause(null, 'pause window elapsed');
    if (Number(this.store.getKv('api_backoff_until') ?? '0') > this.now()) return; // transient API trouble
    this.startReviews(rt);
    this.startBuilders(rt);
    this.maybePlan(rt);
  }

  /**
   * Worktrees share refs with the private clone, so a builder could move the
   * target branch (git update-ref, branch -f, push .). Only the supervisor may:
   * compare with the last head it recorded; on mismatch restore it, pause the
   * project and raise an urgent card. Returns false when tampering was found.
   */
  private async verifyTarget(rt: ProjectRuntime): Promise<boolean> {
    const key = `target_head:${rt.cfg.id}`;
    const expected = this.store.getKv(key);
    const actual = await rt.forge.targetHead().catch(() => null);
    if (!actual) return true;
    if (!expected) {
      this.store.setKv(key, actual);
      return true;
    }
    if (actual === expected) return true;
    if (await this.isOwnMergeOnTop(rt, expected, actual)) {
      this.store.setKv(key, actual); // our own merge (seen after a crash between merge and record)
      return true;
    }
    // Re-read after the awaits above: a legitimate change may have been recorded meanwhile.
    const latest = this.store.getKv(key);
    if (latest !== expected) return latest === actual ? true : this.verifyTarget(rt);
    const target = rt.cfg.repo.targetBranch;
    const restore = rt.barePath ? await safeGit(['update-ref', `refs/heads/${target}`, expected, actual], { cwd: rt.barePath, allowFail: true }) : null;
    const restored = !!restore && restore.code === 0;
    const suspects = this.store.listTasks({ projectId: rt.cfg.id, states: ['building', 'reviewing'] }).map((t) => t.id);
    this.pauseProject(rt.cfg.id, `${target} moved outside the supervisor`);
    this.store.event({
      projectId: rt.cfg.id,
      type: 'security.target_moved',
      message: `${target} was moved to ${actual.slice(0, 10)} outside the supervisor; ${restored ? 'restored to' : 'could NOT restore'} ${expected.slice(0, 10)}`,
      data: { expected, actual, restored, suspects },
    });
    this.store.createDecision({
      projectId: rt.cfg.id,
      kind: 'diagnostic',
      priority: 'urgent',
      question: `Something other than the supervisor moved ${target} in ${rt.cfg.name}'s autopilot repository.`,
      why: `Expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}. ${restored ? 'The branch was restored, so nothing from that change can be merged or pushed.' : 'Restoring failed: inspect the repository before resuming.'}\n\nA builder may have run a git command that rewrites shared refs. Running at the time: ${suspects.join(', ') || 'none'}. The project is paused. Inspect with: git -C ${rt.barePath ?? '<repo>'} show ${actual.slice(0, 12)}`,
      options: [{ id: 'resume', label: 'I checked it — resume the project' }],
      recommendation: null,
      blocking: false,
      createdBy: 'supervisor',
      dedupeKey: `target-moved:${rt.cfg.id}:${actual.slice(0, 12)}`,
    });
    return false;
  }

  /**
   * True when `actual` is the integration commit of the merge that a crash interrupted between
   * moving the target and recording it: exactly the commit that merge job announced
   * (merge_pending) once its integration checks had passed, right before its compare-and-swap,
   * directly on top of `expected`, for the one task that was merging when a previous supervisor
   * process stopped (crash recovery left it in merge_ready), and made for that task's recorded
   * head. Only during startup crash recovery, until the project's first target check after the
   * restart (should a restart die before that check, the next one still counts) and before any
   * worker of the project runs: at any other time an unrecorded move is tampering, however its
   * commit looks, since a worker can write any parent and trailers. A copy that a worker made of
   * the merge in flight while it ran (ticks skip the target check during a merge) is a different
   * commit. A process running as the same OS user could still forge the record itself; only
   * OS-level isolation prevents that (see docs/architecture.md).
   */
  private async isOwnMergeOnTop(rt: ProjectRuntime, expected: string, actual: string): Promise<boolean> {
    const interrupted = this.interruptedMerges(rt.cfg.id);
    if (!rt.barePath || interrupted.length !== 1) return false;
    const t = this.store.getTask(interrupted[0]);
    if (!t?.headCommit || t.projectId !== rt.cfg.id || (t.state !== 'merge_ready' && t.state !== 'merging')) return false;
    // Only the exact commit the merge job announced right before its compare-and-swap, once its
    // checks had passed: while a merge runs (ticks skip the target check) a worker can copy its
    // parent, subject and trailers onto other content, but not that commit.
    const pending = this.pendingMerge(rt.cfg.id);
    if (!pending || pending.taskId !== t.id || pending.base !== expected || pending.commit !== actual) return false;
    const parent = await safeGit(['rev-parse', '--verify', '--quiet', `${actual}^1`], { cwd: rt.barePath, allowFail: true });
    if (parent.stdout.trim() !== expected) return false;
    // The same test the forge uses to find its own integration of a task head (subject and trailers).
    const format = '--format=%H%x1f%(trailers:only,unfold)%x1f%s';
    const log = await safeGit(['log', '-1', '-z', '--no-show-signature', format, actual, '--'], { cwd: rt.barePath, allowFail: true });
    return findIntegrationCommit(log.stdout, t.id, t.headCommit) === actual;
  }

  /**
   * True when `actual`, an unrecorded target head, is the source repository's own branch head as
   * the forge confirmed it from the source at its last sync, or at any sync whose fast-forward
   * has not been checked yet (upstreamHeads: a crash may have come in between), and
   * fast-forwards the recorded head `expected`. refs/remotes/origin/* never decides this: a
   * worker can write it, and make the fetch that would correct it fail (a ref lock).
   */
  private async isUpstreamAdvance(rt: ProjectRuntime, expected: string, actual: string): Promise<boolean> {
    if (!rt.barePath) return false;
    // A head whose fast-forward failed in this process: neither the forge's last confirmation nor
    // the stored list vouches for it.
    if (this.unvouched.has(`${rt.cfg.id}:${actual}`)) return false;
    if (rt.forge.upstreamHead() !== actual && !this.upstreamHeads(rt.cfg.id).includes(actual)) return false;
    const ff = await safeGit(['merge-base', '--is-ancestor', expected, actual], { cwd: rt.barePath, allowFail: true });
    return ff.code === 0;
  }

  /**
   * After a merge the forge reported as done, or any GitHub integration, check the target against
   * the recorded head `expected`. Returns the head to record: exactly the one checked, never a
   * fresh read (a worker could move the target in between); null when there is nothing new to
   * record; false when the target was moved behind the supervisor's back. A new integration commit
   * must sit directly on the recorded head. An "already integrated" or "no changes" result moved
   * nothing, so its commit must already be in the recorded history (after a GitHub integration,
   * the recorded history plus the source's confirmed head). After a GitHub integration, whatever
   * its outcome (it syncs with the source before merging, so even a refused merge may have
   * fast-forwarded the local target), the local target may only have moved to the source's
   * confirmed head.
   */
  private async checkMerged(rt: ProjectRuntime, result: IntegrationResult, expected: string): Promise<string | null | false> {
    const cwd = rt.barePath!;
    const merged = result.mergedCommit;
    if (result.movedTarget && merged) {
      const parent = await safeGit(['rev-parse', '--verify', '--quiet', `${merged}^1`], { cwd, allowFail: true });
      return parent.stdout.trim() === expected ? merged : false;
    }
    if (rt.forge.kind === 'local') {
      if (!merged) return null;
      const known = await safeGit(['merge-base', '--is-ancestor', merged, expected], { cwd, allowFail: true });
      return known.code === 0 ? null : false;
    }
    const actual = await rt.forge.targetHead().catch(() => null);
    const advanced = actual && actual !== expected && (await this.isUpstreamAdvance(rt, expected, actual)) ? actual : null;
    if (result.foundOnTarget && merged) {
      // Found on the local target rather than merged on GitHub now: it must be in the history recorded here.
      const known = await safeGit(['merge-base', '--is-ancestor', merged, advanced ?? expected], { cwd, allowFail: true });
      if (known.code !== 0) return false;
    }
    return advanced;
  }

  private async prepare(rt: ProjectRuntime): Promise<void> {
    rt.preparedAt = this.now();
    try {
      rt.barePath = await rt.forge.prepare();
      const key = `target_head:${rt.cfg.id}`;
      try {
        // Accept a moved target only when it is a fast-forward to the source repository's
        // branch as the source itself reports it (someone pushed upstream); anything else is
        // tampering (e.g. after a restart). Offline, nothing was fast-forwarded to accept.
        // Record exactly the head checked here, never a fresh read: a worker could move the
        // target in between.
        const expected = this.store.getKv(key);
        const actual = await rt.forge.targetHead().catch(() => null);
        if (actual && actual !== expected) {
          if (!expected || (await this.isUpstreamAdvance(rt, expected, actual))) this.store.setKv(key, actual);
          else if (!(await this.verifyTarget(rt))) return; // (verifyTarget records the merge a crash cut off)
        }
      } finally {
        // Crash recovery ends with the first check after a restart, before any worker of the
        // project can start: from now on every unrecorded move of the target is tampering. The
        // syncs' fast-forwards have been checked too.
        this.endCrashRecovery(rt.cfg.id);
        this.forgetUpstream(rt.cfg.id);
      }
      // Only now may integrated work leave the clone, and only the head that was checked:
      // catch up on a push that failed or was cut short.
      const checked = this.store.getKv(key);
      if (checked) await rt.forge.pushIntegrated(checked, true);
      if (rt.prepareError) this.store.event({ projectId: rt.cfg.id, type: 'project.prepared', message: 'Repository ready again' });
      rt.prepareError = null;
      for (const d of this.store.listDecisions({ projectId: rt.cfg.id, status: ['pending'] })) {
        if (d.dedupeKey === `prepare:${rt.cfg.id}`) this.store.closeDecision(d.id, 'superseded', 'repository is ready');
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      rt.prepareError = msg;
      this.store.event({ projectId: rt.cfg.id, type: 'project.prepare_failed', message: msg.slice(0, 500) });
      this.store.createDecision({
        projectId: rt.cfg.id,
        kind: 'diagnostic',
        question: `Autopilot cannot prepare the repository for ${rt.cfg.name}.`,
        why: `${msg.slice(0, 1500)}\n\nSource: ${rt.cfg.repo.source}. Fix the repository or config, then retry.`,
        options: [{ id: 'retry_prepare', label: 'Retry now' }],
        recommendation: 'retry_prepare',
        recommendationReason: 'Retry after fixing the cause.',
        blocking: false,
        priority: 'high',
        createdBy: 'supervisor',
        dedupeKey: `prepare:${rt.cfg.id}`,
      });
    }
  }

  // ------------------------------------------------------------ outbox

  private async processOutbox(): Promise<void> {
    const items = this.store.pendingOutbox(100);
    const notifyByProject = new Map<string, { ids: number[]; decisions: Decision[] }>();
    for (const item of items) {
      try {
        if (item.kind === 'decision_answered') {
          this.onDecisionAnswered(String(item.payload.decisionId));
          this.store.completeOutbox(item.id);
        } else if (item.kind === 'notify') {
          const d = this.store.getDecision(String(item.payload.decisionId));
          if (!d || d.status !== 'pending') {
            this.store.completeOutbox(item.id);
            continue;
          }
          const g = notifyByProject.get(d.projectId) ?? { ids: [], decisions: [] };
          g.ids.push(item.id);
          g.decisions.push(d);
          notifyByProject.set(d.projectId, g);
        } else {
          this.store.completeOutbox(item.id);
        }
      } catch (err) {
        this.store.failOutbox(item.id, (err as Error).message ?? String(err));
        this.log(`outbox ${item.id}: ${(err as Error).stack ?? err}`);
      }
    }
    for (const [projectId, g] of notifyByProject) {
      const rt = this.runtimes.get(projectId);
      try {
        if (rt) {
          const urgent = g.decisions.some((d) => d.priority === 'urgent');
          const high = g.decisions.some((d) => d.priority === 'high');
          // Push services are third parties: send counts only, never the question text.
          await rt.notifier.notify({
            title: `${rt.cfg.name}: ${g.decisions.length === 1 ? 'a decision needs you' : `${g.decisions.length} decisions need you`}`,
            body: 'Open the Autopilot inbox to answer.',
            url: rt.cfg.inbox.publicUrl ?? undefined,
            priority: urgent ? 'urgent' : high ? 'high' : 'normal',
          });
        }
        for (const id of g.ids) this.store.completeOutbox(id);
      } catch (err) {
        for (const id of g.ids) this.store.failOutbox(id, (err as Error).message ?? String(err));
      }
    }
  }

  private onDecisionAnswered(decisionId: string): void {
    const d = this.store.getDecision(decisionId);
    if (!d || d.status !== 'answered' || !d.answer) return;
    const opt = d.answer.optionId ? d.options.find((o) => o.id === d.answer!.optionId) : null;
    const label = opt?.label ?? (d.answer.optionId ? d.answer.optionId : 'comment only');
    const text = `Founder answered ${d.id} ("${d.question}"): ${label}${d.answer.comment ? ` — comment: "${d.answer.comment}"` : ''}`;

    // Project-level cards.
    if (d.dedupeKey === 'auth' || d.dedupeKey === 'usage') {
      if (d.answer.optionId === 'resume') this.resumeAll(`founder answered ${d.id}`);
    }
    if (d.dedupeKey?.startsWith('target-moved:') && d.answer.optionId === 'resume') {
      this.resumeProject(d.projectId, `founder checked the target branch (${d.id})`);
    }
    if (d.dedupeKey?.startsWith('policy:')) this.answerPolicyCard(d);
    if (d.dedupeKey?.startsWith('planner-failing:')) {
      this.store.setKv(`job_errors:plan:${d.projectId}`, null);
      this.store.setProjectPlannedAt(d.projectId, 0);
    }
    if (d.dedupeKey?.startsWith('prepare:')) {
      const rt = this.runtimes.get(d.projectId);
      if (rt) rt.preparedAt = null;
    }
    if (!d.taskId && d.createdBy === 'planner') this.store.setProjectPlannedAt(d.projectId, 0);

    const taskIds = [...new Set([d.taskId, ...d.blockedTaskIds].filter((x): x is string => !!x))];
    for (const id of taskIds) {
      const t = this.store.getTask(id);
      if (!t) continue;
      this.store.addNote(t.id, 'decision', text);
      try {
        // Only the supervisor's own merge review cards decide merges; a builder's
        // "please look at this" question is answered like any other choice.
        if (d.kind === 'review' && d.createdBy === 'supervisor') this.applyReviewAnswer(t, d);
        else if (d.kind === 'diagnostic') this.applyDiagnosticAnswer(t, d);
        else this.applyChoiceAnswer(t, d, label);
      } catch (err) {
        if (!(err instanceof StateError)) throw err;
        this.store.event({ projectId: t.projectId, taskId: t.id, decisionId: d.id, type: 'decision.not_applied', message: err.message });
      }
    }
    this.wake();
  }

  private applyChoiceAnswer(t: Task, d: Decision, label: string): void {
    if (t.state === 'waiting_decision' && !t.leaseOwner && this.store.pendingBlockingFor(t.id).length === 0) {
      this.store.transition(t.id, 'waiting_decision', 'ready', `decision ${d.id} answered`);
      return;
    }
    const differs = !!d.answer?.optionId && !!d.recommendation && d.answer.optionId !== d.recommendation;
    if (!differs || t.state === 'cancelled' || t.state === 'waiting_decision') return;
    // A non-blocking question was answered differently from the recommendation the work
    // proceeded with. If the task is already integrated, change it now; if it is still in
    // flight, queue the change to run right after it lands so the answer is never lost.
    const inFlight = t.state !== 'integrated';
    this.store.createTask({
      projectId: t.projectId,
      title: `Apply founder decision ${d.id}: ${label}`.slice(0, 120),
      objective: `Task ${t.id} ("${t.title}") ${inFlight ? 'is being built' : 'was integrated'} with the recommended option for "${d.question}". The founder chose "${label}" instead${d.answer!.comment ? ` and commented: "${d.answer!.comment}"` : ''}. Change the implementation accordingly, keeping the rest intact. If ${t.id} already applied this choice, verify it and finish without changes.`,
      acceptanceCriteria: [`The behaviour reflects "${label}"`, 'Existing checks pass'],
      ownedPaths: t.ownedPaths,
      dependsOn: inFlight ? [t.id] : [],
      priority: 2,
      risk: t.risk,
      kind: inFlight ? 'research' : 'build', // in-flight: completing with no changes is fine if it was already applied
      origin: 'supervisor',
      state: 'ready',
    });
  }

  private applyReviewAnswer(t: Task, d: Decision): void {
    if (t.state !== 'waiting_decision' || t.leaseOwner) return;
    if (d.answer?.optionId === 'approve') {
      if (t.headCommit && t.headCommit === d.artifactRef) {
        this.store.recordReview({
          taskId: t.id,
          runId: null,
          headCommit: t.headCommit,
          verdict: 'human_approve',
          risk: t.risk,
          summary: `Approved by the founder in the inbox (${d.id})${d.answer.comment ? `: ${d.answer.comment}` : ''}`,
          findings: [],
        });
        this.store.transition(t.id, 'waiting_decision', 'merge_ready', `approved by founder (${d.id})`);
      } else {
        this.store.transition(t.id, 'waiting_decision', 'checking', 'branch changed after the card was created; re-verifying');
      }
    } else if (d.answer?.optionId === 'retry_merge') {
      this.store.transition(t.id, 'waiting_decision', 'merge_ready', `founder asked to retry the merge (${d.id})`);
    } else {
      // Bind the rejection to the revision the card showed, so that exact commit can never
      // be merged later, even if an agent review approves it again.
      const rejected = d.artifactRef ?? t.headCommit;
      if (rejected) {
        this.store.recordReview({ taskId: t.id, runId: null, headCommit: rejected, verdict: 'human_request_changes', risk: t.risk, summary: `Founder requested changes (${d.id}): ${d.answer?.comment ?? '(no comment)'}`, findings: [] });
      }
      this.repairUnleased(t, `Founder requested changes on ${d.id}: ${d.answer?.comment ?? '(no comment)'}`);
    }
  }

  private applyDiagnosticAnswer(t: Task, d: Decision): void {
    const opt = d.answer?.optionId;
    if (opt === 'cancel') {
      if (d.taskId === t.id) this.cancelTask(t.id); // project-wide cards never cancel the tasks attached to them
      return;
    }
    if (opt === 'retry_review' && t.state === 'waiting_decision') {
      this.store.transition(t.id, 'waiting_decision', 'review_ready', `founder asked to retry the review (${d.id})`);
      return;
    }
    if (opt === 'retry_merge' && t.state === 'waiting_decision') {
      this.store.transition(t.id, 'waiting_decision', 'merge_ready', `founder asked to retry the merge (${d.id})`);
      return;
    }
    if (opt === 'retry_checks' && t.state === 'waiting_decision') {
      this.store.transition(t.id, 'waiting_decision', 'checking', `founder asked to re-run the checks (${d.id})`);
      return;
    }
    if (['exhausted', 'waiting_decision'].includes(t.state) && !t.leaseOwner && this.store.pendingBlockingFor(t.id).length === 0) {
      this.store.transition(t.id, t.state, 'ready', `founder chose to continue (${d.id})`, { attempts: 0, repairCycles: 0 });
    }
  }

  // ------------------------------------------------------------ builders

  private runLeaseMs(cfg: ProjectConfig): number {
    return Math.max(cfg.execution.idleTimeoutMinutes * MIN * 1.5, 5 * MIN);
  }

  /**
   * Busy slots for a role, counted from the moment a task is claimed (task state),
   * not when its process starts: launching involves async worktree setup, and a
   * tick in between must not see a free slot.
   */
  private activeRuns(projectId: string, role: RunRole): number {
    if (role === 'planner') return this.runtimes.get(projectId)?.plannerRunId ? 1 : 0;
    return this.store.listTasks({ projectId, states: [role === 'builder' ? 'building' : 'reviewing'] }).length;
  }

  /** Busy slots of a role across all projects (they share one subscription). */
  private totalActive(role: 'builder' | 'reviewer'): number {
    return this.store.listTasks({ states: [role === 'builder' ? 'building' : 'reviewing'] }).length;
  }

  private depsSatisfied(t: Task): boolean {
    return t.dependsOn.every((id) => {
      const dep = this.store.getTask(id);
      return !dep || dep.state === 'integrated' || dep.state === 'cancelled';
    });
  }

  private startBuilders(rt: ProjectRuntime): void {
    const cfg = rt.cfg;
    const active = this.activeRuns(cfg.id, 'builder');
    let slots = cfg.execution.maxBuilders - active;
    if (slots <= 0) return;
    if (this.store.pendingDecisionCount(cfg.id) >= cfg.inbox.maxPendingDecisions) slots = active === 0 ? 1 : 0; // backpressure
    if (this.quotaWarningActive()) slots = Math.min(slots, this.totalActive('builder') === 0 ? 1 : 0); // quota governor
    if (rt.forge.kind === 'github') {
      const openPrs = this.store.listTasks({ projectId: cfg.id, states: IN_FLIGHT }).filter((t) => t.prNumber).length;
      if (openPrs >= cfg.integration.maxOpenPrs) slots = 0;
    }
    const inFlight = this.store.listTasks({ projectId: cfg.id, states: IN_FLIGHT });
    for (const t of this.store.listTasks({ projectId: cfg.id, states: ['ready'] })) {
      if (slots <= 0) break;
      if (!this.depsSatisfied(t)) continue;
      if (inFlight.some((o) => o.id !== t.id && ownershipOverlaps(o.ownedPaths, t.ownedPaths))) continue;
      const runId = this.store.nextId('R');
      const claimed = this.store.claim(t.id, ['ready'], 'building', runId, this.runLeaseMs(cfg));
      if (!claimed) continue;
      slots--;
      inFlight.push(claimed.task);
      this.holdLaunchLease(runId, t.id, claimed.generation, this.runLeaseMs(cfg));
      this.track(this.launchBuilder(rt, claimed.task, runId, claimed.generation).finally(() => this.jobs.delete(`launch:${runId}`)), `launch builder ${t.id}`);
    }
  }

  /** Keep a claimed task's lease alive while its workspace is prepared (setup can be slow). */
  private holdLaunchLease(runId: string, taskId: string, generation: number, ttlMs: number): void {
    this.jobs.set(`launch:${runId}`, { owner: runId, taskId, generation, ttlMs });
  }

  /** Whether new model runs may start now (checked again right before spawning). */
  private mayStartRuns(projectId: string): boolean {
    return !this.stopping && !this.store.isPausedAll() && !this.store.getProject(projectId)?.paused;
  }

  private async launchBuilder(rt: ProjectRuntime, task: Task, runId: string, generation: number): Promise<void> {
    const cfg = rt.cfg;
    let t = task;
    try {
      if (t.branch && rt.barePath) {
        const exists = await safeGit(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: rt.barePath, allowFail: true });
        if (exists.code !== 0) {
          // The branch is gone (deleted by hand or by a cleanup): start this task over.
          this.store.addNote(t.id, 'supervisor', `Branch ${t.branch} no longer existed, so the task starts over on a fresh branch.`);
          t = this.store.patchTask(t.id, { branch: null, worktree: null, baseCommit: null, headCommit: null, lastSessionId: null, prNumber: null, prUrl: null });
        }
      }
      const wt = t.branch ? await rt.forge.ensureWorktree(t.id, t.branch) : await rt.forge.createWorktree(t.id, slugify(t.title));
      t = this.store.patchTask(t.id, { branch: wt.branch, worktree: wt.path, baseCommit: t.baseCommit ?? wt.baseCommit, attempts: t.attempts + 1 });
      const setup = await rt.checks.setup(wt.path);
      const failedSetup = setup.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
      if (failedSetup.length) this.store.addNote(t.id, 'checks', `Workspace setup failed: ${failedSetup.map((r) => `${r.name}: ${r.outputTail.slice(-400)}`).join('\n')}`);
    } catch (err) {
      // No run row exists yet. Count the attempt so a broken workspace cannot loop forever.
      const why = `workspace error: ${(err as Error).message}`.slice(0, 300);
      if (this.ownsLease(t.id, runId, generation)) {
        if (t.attempts + 1 >= cfg.execution.maxAttempts) this.exhaust({ ...t, attempts: t.attempts + 1 }, runId, generation, why);
        else this.store.release(t.id, runId, generation, 'ready', why, { attempts: t.attempts + 1 });
      }
      throw err;
    }
    // The world may have changed during setup: the lease, a pause, or a shutdown.
    if (!this.ownsLease(t.id, runId, generation)) return;
    if (!this.mayStartRuns(cfg.id)) {
      this.store.release(t.id, runId, generation, 'ready', 'paused before the run started', { attempts: Math.max(0, t.attempts - 1) });
      return;
    }
    const resumed = !!t.lastSessionId;
    const decisions = this.store.listDecisions({ taskId: t.id }).filter((d) => d.status === 'pending' || d.status === 'answered');
    const reason = t.stateReason ?? 'continuing';
    this.startRun(rt, {
      runId,
      role: 'builder',
      task: t,
      generation,
      cwd: t.worktree!,
      prompt: builderPrompt(cfg, t, { decisions, resumed, reason }),
      system: builderSystemPrompt(cfg, t),
      resumeSessionId: t.lastSessionId,
      permissionMode: cfg.execution.permissionMode,
      allowedTools: [...builderTools(cfg.execution.permissionMode), ...cfg.execution.allowedTools, ...MCP(['get_task_context', 'request_decision', 'check_decision', 'propose_task', 'report_progress'])],
      // The defaults always apply, even when a project customizes its own deny list.
      disallowedTools: [...DEFAULT_DISALLOWED_TOOLS, ...BUILDER_DENY, ...CREDENTIAL_DENY, ...stateDeny(this.opts.home.root), ...cfg.execution.disallowedTools],
      jsonSchema: BUILDER_RESULT_SCHEMA,
      model: cfg.execution.model,
      onDone: (out) => this.onBuilderDone(rt, runId, out),
    });
  }

  private startRun(
    rt: ProjectRuntime,
    r: {
      runId: string;
      role: RunRole;
      task: Task | null;
      generation: number;
      cwd: string;
      prompt: string;
      system: string;
      resumeSessionId: string | null;
      permissionMode: RunSpec['permissionMode'];
      allowedTools: string[];
      disallowedTools: string[];
      jsonSchema: Record<string, unknown>;
      model: string | null;
      onDone: (out: RunOutcome) => Promise<void>;
    },
  ): void {
    const cfg = rt.cfg;
    this.endCrashRecovery(cfg.id); // crash recovery never outlasts the first worker run (see prepare)
    if (this.stopping) {
      // Shutdown began while this run was being prepared: never spawn it.
      if (r.task && this.ownsLease(r.task.id, r.runId, r.generation)) {
        const back: TaskState = r.role === 'reviewer' ? 'review_ready' : 'ready';
        this.store.release(r.task.id, r.runId, r.generation, back, 'supervisor stopping', r.role === 'builder' ? { attempts: Math.max(0, r.task.attempts - 1) } : {});
      }
      if (r.role === 'planner') rt.plannerRunId = null;
      return;
    }
    const token = randomToken();
    const sessionId = uuid();
    const logPath = join(this.opts.home.runDir(r.runId), 'stream.jsonl');
    this.store.createRun({
      id: r.runId,
      projectId: cfg.id,
      taskId: r.task?.id ?? null,
      role: r.role,
      generation: r.generation,
      tokenHash: sha256Hex(token),
      cwd: r.cwd,
      sessionId: r.resumeSessionId ? null : sessionId,
      resumedSessionId: r.resumeSessionId,
      logPath,
    });
    const docDirs = [...new Set(cfg.docs.map((d) => dirname(d)))].filter((d) => existsSync(d));
    const mcpConfig = {
      mcpServers: {
        autopilot: {
          command: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', this.opts.mcpServerPath],
          env: { AUTOPILOT_API_URL: this.opts.apiUrl, AUTOPILOT_RUN_TOKEN: token, AUTOPILOT_ROLE: r.role },
          // Tool search would otherwise defer MCP tools; agents must always see these.
          alwaysLoad: true,
        },
      },
    };
    // The runner writes this config (with the run token) to a private 0600 file next to the
    // run log and passes its path, so the token never appears on a command line.
    const spec: RunSpec = {
      runId: r.runId,
      role: r.role,
      cwd: r.cwd,
      prompt: r.prompt,
      appendSystemPrompt: r.system,
      sessionId,
      resumeSessionId: r.resumeSessionId,
      model: r.model ?? undefined,
      effort: cfg.execution.effort ?? undefined,
      permissionMode: r.permissionMode,
      allowedTools: [...new Set(r.allowedTools)],
      disallowedTools: [...new Set(r.disallowedTools)],
      mcpConfig,
      jsonSchema: r.jsonSchema,
      settings: cfg.execution.sandbox && r.role === 'builder' ? { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } } : null,
      // Reviewers and planners never load settings/hooks/env from a branch; builders follow
      // the policy (default: the founder's user settings only).
      settingSources: r.role === 'builder' ? cfg.execution.settingSources : ['user'],
      addDirs: docDirs,
      maxTurns: cfg.execution.maxTurns,
      timeoutMs: cfg.execution.runTimeoutMinutes * MIN,
      idleTimeoutMs: cfg.execution.idleTimeoutMinutes * MIN,
      // Startup failures then still end with a structured result message. The run's git ignores
      // replace refs and grafts like the supervisor's own (FORCED_GIT_ENV in git/git.ts), so a
      // reviewer sees what would merge. Git before 2.42 let core.useReplaceRefs=true in the
      // repository's config (workers can write it) outrank GIT_NO_REPLACE_OBJECTS, so the run's
      // git also gets core.useReplaceRefs=false the way `git -c` passes settings on: appended to
      // GIT_CONFIG_PARAMETERS, which every git version reads after all config files.
      env: {
        AUTOPILOT_TASK_ID: r.task?.id ?? '',
        AUTOPILOT_ROLE: r.role,
        CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_GRAFT_FILE: '/dev/null/no-grafts',
        GIT_CONFIG_PARAMETERS: [process.env.GIT_CONFIG_PARAMETERS, "'core.useReplaceRefs=false'"].filter(Boolean).join(' '),
      },
      logPath,
    };
    const handle = rt.runner.start(spec, (e) => this.onRunEvent(r.runId, e));
    this.runs.set(r.runId, { runId: r.runId, role: r.role, projectId: cfg.id, taskId: r.task?.id ?? null, generation: r.generation, handle, lastBeat: this.now() });
    if (handle.pid) this.store.touchRun(r.runId, { pid: handle.pid });
    this.track(
      handle.done.then(async (out) => {
        this.runs.delete(r.runId);
        await r.onDone(out);
      }),
      `${r.role} run ${r.runId}`,
    );
  }

  private onRunEvent(runId: string, e: RunEvent): void {
    const active = this.runs.get(runId);
    if (e.type === 'activity' && /^rate limit allowed_warning/.test(e.summary)) this.noteQuotaWarning();
    if (e.type === 'started') {
      this.store.touchRun(runId, { pid: e.pid || null });
      return;
    }
    if (e.type === 'session') {
      this.store.touchRun(runId, { sessionId: e.sessionId });
      if (active?.taskId && active.role === 'builder') {
        const t = this.store.getTask(active.taskId);
        if (t && t.leaseOwner === runId && t.leaseGeneration === active.generation) this.store.patchTask(t.id, { lastSessionId: e.sessionId });
      }
      return;
    }
    if (!active || this.now() - active.lastBeat < 10_000) return;
    active.lastBeat = this.now();
    this.store.touchRun(runId);
    if (active.taskId) {
      const rt = this.runtimes.get(active.projectId);
      if (!this.store.heartbeat(active.taskId, runId, active.generation, rt ? this.runLeaseMs(rt.cfg) : 15 * MIN)) active.handle.kill('lease lost');
    }
  }

  /**
   * Quota governor: Claude Code reported that usage is close to the plan limit
   * (rate_limit_event "allowed_warning"). Run at most one builder for a while so
   * the account does not hit a hard stop mid-task. Limits are shared across projects.
   */
  private noteQuotaWarning(): void {
    const now = this.now();
    if (Number(this.store.getKv('quota_warning_until') ?? '0') < now) {
      this.store.event({ type: 'usage.warning', message: 'Approaching the plan usage limit: running one builder at a time for 30 minutes' });
    }
    this.store.setKv('quota_warning_until', String(now + 30 * MIN));
  }

  private quotaWarningActive(): boolean {
    return Number(this.store.getKv('quota_warning_until') ?? '0') > this.now();
  }

  /** True when the run still holds its task lease (ignoring expiry not yet processed). */
  private ownsLease(taskId: string, runId: string, generation: number): Task | null {
    const t = this.store.getTask(taskId);
    return t && t.leaseOwner === runId && t.leaseGeneration === generation ? t : null;
  }

  /** Handle failures shared by all roles. Returns true when the outcome was fully handled. */
  private handleRunFailure(rt: ProjectRuntime, run: Run, out: RunOutcome): { handled: boolean; countAttempt: boolean } {
    if (out.status === 'usage_limited') {
      // Several concurrent runs hit the same limit: escalate the backoff once, and never
      // shorten a pause that is already known to last longer.
      const current = this.store.usagePausedUntil();
      const active = !!current && current > this.now();
      const level = Number(this.store.getKv('usage_backoff_level') ?? '0');
      const until = out.usageResetAt && out.usageResetAt > this.now() ? out.usageResetAt + MIN : this.now() + Math.min(15 * 2 ** level, 240) * MIN;
      if (!active) this.store.setKv('usage_backoff_level', String(level + 1));
      if (!active || until > current!) this.store.setUsagePause(until, out.resultText?.slice(0, 200) ?? 'usage limit');
      return { handled: true, countAttempt: false };
    }
    if (out.status === 'failed' && out.error?.startsWith('transient:')) {
      // Overload/5xx/network trouble is not the task's fault: back off briefly, keep attempts.
      const now = this.now();
      const until = Number(this.store.getKv('api_backoff_until') ?? '0');
      if (until <= now) {
        const level = Number(this.store.getKv('api_backoff_level') ?? '0');
        this.store.setKv('api_backoff_level', String(Math.min(level + 1, 5)));
        this.store.setKv('api_backoff_until', String(now + Math.min(2 * 2 ** level, 30) * MIN));
        this.store.event({ projectId: rt.cfg.id, runId: run.id, type: 'api.backoff', message: `Transient API trouble (${out.error.slice(0, 120)}); pausing new runs for ${Math.min(2 * 2 ** level, 30)} min` });
      }
      return { handled: true, countAttempt: false };
    }
    if (out.status === 'failed' && out.error?.startsWith('auth:')) {
      this.pauseAll('Claude Code is not authenticated');
      this.store.createDecision({
        projectId: rt.cfg.id,
        kind: 'diagnostic',
        question: 'Claude Code is not logged in for unattended runs.',
        why: `Workers failed with: ${out.error.slice(0, 300)}\n\nOn the computer running the autopilot, run \`claude auth login\` (or \`claude setup-token\` and set CLAUDE_CODE_OAUTH_TOKEN), then tap Resume. Everything is paused until then.`,
        options: [{ id: 'resume', label: 'I logged in — resume' }],
        recommendation: 'resume',
        recommendationReason: 'Resume after logging in.',
        blocking: false,
        priority: 'urgent',
        createdBy: 'supervisor',
        dedupeKey: 'auth',
      });
      return { handled: true, countAttempt: false };
    }
    if (out.status === 'killed') return { handled: true, countAttempt: false };
    if (out.status === 'failed' && run.resumedSessionId && /no conversation found|session.*not found|could not resume/i.test(`${out.error} ${out.resultText}`)) {
      if (run.taskId) this.store.patchTask(run.taskId, { lastSessionId: null });
      return { handled: true, countAttempt: false };
    }
    return { handled: false, countAttempt: true };
  }

  private async onBuilderDone(rt: ProjectRuntime, runId: string, out: RunOutcome): Promise<void> {
    const run = this.store.getRun(runId)!;
    const result = parseBuilderResult(out.structuredOutput);
    const t = this.ownsLease(run.taskId!, runId, run.generation);
    const status = out.status === 'succeeded' && !result ? 'failed' : out.status;
    const finished = this.store.finishRun(runId, {
      status: t ? (status === 'succeeded' && result?.status === 'needs_decision' ? 'yielded' : status) : 'lost',
      result: result ?? out.structuredOutput,
      resultText: out.resultText,
      error: out.error ?? (out.status === 'succeeded' && !result ? 'no valid structured result' : null),
      costUsd: out.costUsd,
      numTurns: out.numTurns,
      sessionId: out.sessionId,
    });
    if (!t || !finished) return; // fenced out: someone else owns the task now
    if (out.sessionId) this.store.patchTask(t.id, { lastSessionId: out.sessionId });
    if (out.status === 'succeeded') {
      this.store.setKv('usage_backoff_level', null);
      this.store.setKv('api_backoff_level', null);
    }

    const fail = out.status === 'succeeded' ? { handled: false, countAttempt: true } : this.handleRunFailure(rt, run, out);
    if (fail.handled) {
      this.store.release(t.id, runId, run.generation, 'ready', `run ${out.status}: ${(out.error ?? '').slice(0, 200)}`, { attempts: Math.max(0, t.attempts - (fail.countAttempt ? 0 : 1)) });
      return;
    }

    try {
      await this.finishBuilderRun(rt, t, run, out, result);
    } catch (err) {
      // Never leave the task leased by a finished run: count the attempt and move on.
      if (this.ownsLease(t.id, runId, run.generation)) {
        const why = `supervisor error after ${runId}: ${(err as Error).message}`.slice(0, 300);
        if (t.attempts >= rt.cfg.execution.maxAttempts) this.exhaust(t, runId, run.generation, why);
        else this.store.release(t.id, runId, run.generation, 'ready', why);
      }
      throw err;
    }
  }

  /**
   * Make sure the work is on the task branch: commit leftovers (never secret-looking files)
   * and pull the branch along if the run left the worktree on another branch.
   */
  private async settleWorktree(t: Task, runId: string): Promise<string[]> {
    const wt = t.worktree!;
    const notes: string[] = [];
    const id = ['-c', 'user.name=StayOn Autopilot', '-c', 'user.email=autopilot@localhost', '-c', 'commit.gpgsign=false'];
    const head = await safeGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: wt, allowFail: true });
    if (head.stdout.trim() !== `refs/heads/${t.branch}`) {
      await safeGit(['checkout', '-B', t.branch!], { cwd: wt, allowFail: true });
      notes.push(`The run left the worktree off ${t.branch}; the task branch now points at that work. Stay on ${t.branch}.`);
    }
    await safeGit(['add', '-u'], { cwd: wt, allowFail: true });
    const untracked = (await safeGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: wt, allowFail: true })).stdout.split('\0').filter(Boolean);
    const skipped = untracked.filter((p) => NEVER_AUTO_COMMIT.test(p));
    const add = untracked.filter((p) => !NEVER_AUTO_COMMIT.test(p));
    if (add.length) await safeGit(['add', '--', ...add], { cwd: wt, allowFail: true });
    const staged = await safeGit(['diff', '--cached', '--quiet'], { cwd: wt, allowFail: true });
    if (staged.code !== 0) {
      await safeGit([...id, 'commit', '--no-verify', '-m', `autopilot: uncommitted changes at end of ${runId}`], { cwd: wt, allowFail: true });
    }
    if (skipped.length) notes.push(`Left uncommitted (look like secrets or keys; never commit them): ${skipped.slice(0, 10).join(', ')}`);
    return notes;
  }

  private async finishBuilderRun(rt: ProjectRuntime, t: Task, run: Run, out: RunOutcome, result: BuilderResult | null): Promise<void> {
    const runId = run.id;
    const previousHead = t.headCommit;
    for (const n of await this.settleWorktree(t, runId)) this.store.addNote(t.id, 'supervisor', n);
    const head = await rt.forge.headCommit(t.worktree!);
    this.store.patchTask(t.id, { headCommit: head });
    if (result) {
      this.store.addNote(t.id, 'builder', `${runId} (${result.status}): ${result.summary}${result.limitations.length ? `\nLimitations: ${result.limitations.join('; ')}` : ''}`);
      for (const f of result.followUps.slice(0, 3)) {
        this.store.createTask({ projectId: t.projectId, title: f.title || 'Follow-up', objective: f.objective || f.title, origin: 'agent', state: 'proposed', ownedPaths: t.ownedPaths });
      }
    }

    if (out.status !== 'succeeded' || !result || result.status === 'failed') {
      const why = out.status !== 'succeeded' ? `${out.status}: ${out.error ?? ''}` : result ? `builder reported failure: ${result.summary}` : 'no valid structured result';
      if (t.attempts >= rt.cfg.execution.maxAttempts) {
        this.exhaust(t, runId, run.generation, `Builder failed ${t.attempts} times. Last: ${why}`);
      } else {
        this.store.release(t.id, runId, run.generation, 'ready', why.slice(0, 300));
        this.store.addNote(t.id, 'supervisor', `Run ${runId} did not finish: ${why.slice(0, 1500)}`);
      }
      return;
    }

    const blockingDecisions = this.store.pendingBlockingFor(t.id);
    if (blockingDecisions.length || result.status === 'needs_decision' || result.status === 'blocked') {
      const askedThisRun = this.store.listDecisions({ taskId: t.id }).filter((d) => d.createdByRun === runId);
      if (!blockingDecisions.length && result.status === 'needs_decision' && askedThisRun.length) {
        // The founder answered before the run finished: continue right away, no extra card.
        this.store.release(t.id, runId, run.generation, 'ready', `answered while ${runId} was finishing`);
        return;
      }
      if (!blockingDecisions.length) {
        this.store.createDecision({
          projectId: t.projectId,
          taskId: t.id,
          kind: 'diagnostic',
          question: `${t.id} "${t.title}" is ${result.status === 'blocked' ? 'blocked' : 'waiting for a decision'}.`,
          why: result.summary.slice(0, 3000),
          options: [
            { id: 'retry', label: 'Continue (reply in the comment)' },
            { id: 'cancel', label: 'Cancel this task', consequential: true },
          ],
          recommendation: 'retry',
          recommendationReason: 'Add guidance in the comment and the builder continues from where it stopped.',
          blocking: true,
          createdBy: 'supervisor',
          createdByRun: runId,
          dedupeKey: `blocked:${t.id}:${head.slice(0, 12)}`,
        });
      }
      this.store.release(t.id, runId, run.generation, 'waiting_decision', `waiting on ${this.store.pendingBlockingFor(t.id).map((d) => d.id).join(', ')}`);
      return;
    }

    if (t.baseCommit && head === t.baseCommit) {
      if (t.kind === 'research') {
        this.store.release(t.id, runId, run.generation, 'integrated', 'completed without code changes');
      } else {
        this.repairLeased(rt, t, runId, run.generation, 'The run reported completion but made no commits on the task branch.');
      }
      return;
    }
    if (previousHead && head === previousHead && (t.repairCycles > 0 || this.store.founderRejected(t.id, head))) {
      this.repairLeased(rt, t, runId, run.generation, 'The repair run made no new commits; the previous problems are still there.');
      return;
    }

    // Never publish (or later merge) something that looks like a secret, in any commit of the branch.
    const base = await this.diffBase(rt, t, head);
    const scan = await this.scanCommits(rt, base, head);
    if (scan.secrets.length) {
      this.repairLeased(
        rt,
        t,
        runId,
        run.generation,
        `Secret-looking content was committed (${scan.secrets.map((s) => `${s.kind} in ${s.file}`).join('; ')}). Remove it and rewrite this branch's history so no commit contains it (the branch was not published), e.g. with an interactive-free \`git reset --soft ${base.slice(0, 12)}\` and a fresh commit. Use placeholders or .env.example instead.`,
      );
      return;
    }
    if (scan.incomplete) {
      this.repairLeased(rt, t, runId, run.generation, `The branch was not published: the secret scan could not check all of its commits (${scan.incomplete}).`);
      return;
    }

    try {
      const pub = await rt.forge.publish(this.store.getTask(t.id)!, prBody(t, result, []));
      if (pub.prNumber) this.store.patchTask(t.id, { prNumber: pub.prNumber, prUrl: pub.prUrl });
    } catch (err) {
      this.store.addNote(t.id, 'supervisor', `Publishing the branch failed: ${(err as Error).message.slice(0, 500)}`);
    }
    this.store.release(t.id, runId, run.generation, 'checking', `${runId} completed`);
  }

  /**
   * The base to diff a task against: where its branch meets the current target. After a
   * builder merges the target into its branch (conflict repair), this excludes other
   * tasks' changes, so review and policy judge only this task's work.
   */
  private async diffBase(rt: ProjectRuntime, t: Task, head: string): Promise<string> {
    if (rt.barePath) {
      const mb = await safeGit(['merge-base', `refs/heads/${rt.cfg.repo.targetBranch}`, head], { cwd: rt.barePath, allowFail: true });
      const sha = mb.stdout.trim();
      if (mb.code === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
    return t.baseCommit ?? head;
  }

  /**
   * Secret-looking values added by any commit in base..head, not only by the branch's net change:
   * a secret committed and removed again is still in the history that a push publishes and the
   * "merge" strategy keeps. Merge commits count with the changes they make themselves (--cc), root
   * commits (an unrelated history) with all their content (--root, whatever log.showRoot says).
   * The full message of every commit is scanned too: the same push and strategy keep it.
   * When the history cannot be read completely (git failed, or more than SECRET_SCAN_MAX_BYTES of
   * patches or of messages), `incomplete` says why; callers treat that like a finding, so nothing
   * unscanned is published or merged.
   */
  private async scanCommits(rt: ProjectRuntime, base: string, head: string): Promise<{ secrets: { file: string; kind: string }[]; incomplete: string | null }> {
    if (!rt.barePath) return { secrets: [], incomplete: 'the repository is not ready' };
    const range = `${base}..${head}`;
    const opts = { cwd: rt.barePath, allowFail: true, maxStdoutBytes: SECRET_SCAN_MAX_BYTES, stopAtMaxStdout: true };
    const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature', '--format=%H'];
    const patches = await safeGit(['log', '-p', '--cc', '--root', '-M', ...flags, range, '--'], opts);
    // Merge commits once more without rename detection, for file names only: a merge that just
    // renames a file every parent holds (to .env, say) is in no parent's way, so the combined diff
    // above shows nothing for it. Lines stay with the pass above, which does not report again a
    // line that the target added to a file this branch renamed.
    const merges = await safeGit(['log', '-p', '--merges', '--cc', '--no-renames', ...flags, range, '--'], opts);
    // One NUL-terminated "<sha>\n<message>" record per commit, in UTF-8 whatever
    // i18n.logOutputEncoding in the (worker-writable) repository config says. Not caught here: text
    // after a NUL (git commit refuses one, `git hash-object --literally` does not, and %B stops
    // there), and a message whose own encoding header (e.g. UTF-16LE) re-codes it into other text.
    const messages = await safeGit(['log', '-z', '--no-show-signature', '--encoding=UTF-8', '--format=%H%n%B', range, '--'], opts);
    const secrets = findSecrets(patches.stdout);
    for (const s of findSecrets(merges.stdout)) {
      if (s.kind === 'environment file' && !secrets.some((x) => x.file === s.file && x.kind === s.kind)) secrets.push(s);
    }
    for (const record of messages.stdout.split('\0')) {
      const nl = record.indexOf('\n');
      if (nl < 0) continue;
      for (const kind of secretKinds(record.slice(nl + 1))) secrets.push({ file: `the message of commit ${record.slice(0, 12)}`, kind });
    }
    const limit = `${SECRET_SCAN_MAX_BYTES / 1024 / 1024} MiB`;
    const rewrite = `e.g. with an interactive-free \`git reset --soft ${base.slice(0, 12)}\` and a fresh commit`;
    if (patches.stdoutTruncated || merges.stdoutTruncated) {
      return { secrets, incomplete: `its commits change more than ${limit} of text: keep generated and very large files out of the branch history, ${rewrite}` };
    }
    if (messages.stdoutTruncated) return { secrets, incomplete: `its commit messages hold more than ${limit} of text: shorten them, ${rewrite}` };
    for (const r of [patches, merges, messages]) {
      if (r.code !== 0) return { secrets, incomplete: `git log failed: ${redact(r.stderr.trim() || `exit ${r.code}`).slice(0, 300)}` };
    }
    return { secrets, incomplete: null };
  }

  private exhaust(t: Task, owner: string, generation: number, why: string): void {
    this.store.release(t.id, owner, generation, 'exhausted', why.slice(0, 300));
    this.diagnosticCard(t, why);
  }

  private diagnosticCard(t: Task, why: string): void {
    this.store.createDecision({
      projectId: t.projectId,
      taskId: t.id,
      kind: 'diagnostic',
      question: `${t.id} "${t.title}" is stuck. Try again or cancel?`,
      why: why.slice(0, 3000),
      options: [
        { id: 'retry', label: 'Try again', tradeoff: 'Resets the attempt budget; add guidance in the comment.' },
        { id: 'cancel', label: 'Cancel this task', consequential: true },
      ],
      recommendation: 'retry',
      recommendationReason: 'Most failures are fixable with a hint; cancel if the task is no longer wanted.',
      blocking: false,
      createdBy: 'supervisor',
      dedupeKey: `stuck:${t.id}:${t.attempts}:${t.repairCycles}`,
    });
  }

  /** Send a leased task back for repair, or exhaust it when the repair budget is spent. */
  private repairLeased(rt: ProjectRuntime, t: Task, owner: string, generation: number, reason: string): void {
    const cycles = t.repairCycles + 1;
    this.supersedeReviewCards(t.id, 'task went back for repair');
    if (cycles > rt.cfg.execution.maxRepairCycles) {
      this.store.addNote(t.id, 'supervisor', reason);
      this.store.release(t.id, owner, generation, 'exhausted', `repair budget spent: ${reason}`.slice(0, 300), { repairCycles: cycles });
      this.diagnosticCard({ ...t, repairCycles: cycles }, `Repair budget (${rt.cfg.execution.maxRepairCycles}) spent. Last problem: ${reason}`);
      return;
    }
    this.store.addNote(t.id, 'supervisor', reason);
    this.store.release(t.id, owner, generation, 'ready', `repair: ${reason}`.slice(0, 300), { repairCycles: cycles });
  }

  private repairUnleased(t: Task, reason: string): void {
    const cfg = this.runtimes.get(t.projectId)?.cfg;
    const cycles = t.repairCycles + 1;
    this.supersedeReviewCards(t.id, 'task went back for repair');
    this.store.addNote(t.id, 'supervisor', reason);
    if (cfg && cycles > cfg.execution.maxRepairCycles + 1) {
      this.store.transition(t.id, t.state, 'exhausted', `repair budget spent: ${reason}`.slice(0, 300), { repairCycles: cycles });
      this.diagnosticCard({ ...t, repairCycles: cycles }, reason);
      return;
    }
    this.store.transition(t.id, t.state, 'ready', `repair: ${reason}`.slice(0, 300), { repairCycles: cycles });
  }

  private supersedeReviewCards(taskId: string, reason: string): void {
    for (const d of this.store.listDecisions({ taskId, status: ['pending'] })) {
      if (d.kind === 'review' && d.createdBy === 'supervisor') this.store.closeDecision(d.id, 'superseded', reason);
    }
  }

  // ------------------------------------------------------------ checks

  private startChecks(rt: ProjectRuntime): void {
    for (const t of this.store.listTasks({ projectId: rt.cfg.id, states: ['checking'] })) {
      if (rt.checkJobs >= 2) return;
      if (t.leaseOwner) continue;
      const owner = `${this.bootId}:checks`;
      const ttl = Math.max(30 * MIN, rt.cfg.checks.commands.reduce((s, c) => s + c.timeoutSeconds * 1000, 0) * 2);
      const claimed = this.store.claim(t.id, ['checking'], 'checking', owner, ttl);
      if (!claimed) continue;
      rt.checkJobs++;
      const key = `${owner}:${t.id}`;
      this.jobs.set(key, { owner, taskId: t.id, generation: claimed.generation, ttlMs: ttl });
      this.track(
        this.runChecks(rt, claimed.task, owner, claimed.generation).finally(() => {
          rt.checkJobs--;
          this.jobs.delete(key);
        }),
        `checks ${t.id}`,
      );
    }
  }

  private async runChecks(rt: ProjectRuntime, task: Task, owner: string, generation: number): Promise<void> {
    let t = task;
    try {
      if (!t.worktree || !existsSync(t.worktree)) {
        const wt = await rt.forge.ensureWorktree(t.id, t.branch!);
        t = this.store.patchTask(t.id, { worktree: wt.path });
      }
      const head = await rt.forge.headCommit(t.worktree!);
      if (head !== t.headCommit) t = this.store.patchTask(t.id, { headCommit: head });
      const setup = await rt.checks.setup(t.worktree!);
      const results = [...setup.filter((r) => r.status !== 'passed'), ...(await rt.checks.run(t.worktree!))];
      this.store.recordChecks(t.id, head, 'branch', results);
      const failed = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
      if (failed.length) {
        const detail = failed.map((r) => `${r.name} ${r.status}:\n${r.outputTail.slice(-1500)}`).join('\n\n');
        this.repairLeased(rt, t, owner, generation, `Checks failed on ${head.slice(0, 10)}:\n${detail}`);
        return;
      }
      this.store.setKv(`job_errors:checks:${t.id}`, null);
      const next: TaskState = rt.cfg.integration.requireAgentReview && rt.cfg.execution.maxReviewers > 0 ? 'review_ready' : 'merge_ready';
      this.store.release(t.id, owner, generation, next, results.length ? 'checks passed' : 'no checks configured');
    } catch (err) {
      this.jobFailure(t, owner, generation, 'checks', err, 'checking');
      throw err;
    }
  }

  /**
   * A supervisor job (checks/merge) crashed. Retry a few times, then stop
   * looping and ask the founder with one diagnostic card.
   */
  private jobFailure(t: Task, owner: string, generation: number, kind: 'checks' | 'merge' | 'review', err: unknown, retryState: TaskState): void {
    if (!this.ownsLease(t.id, owner, generation)) return;
    const key = `job_errors:${kind}:${t.id}`;
    const n = Number(this.store.getKv(key) ?? '0') + 1;
    const msg = `${kind} job error: ${(err as Error)?.message ?? err}`.slice(0, 300);
    const retry = kind === 'merge' ? 'retry_merge' : kind === 'review' ? 'retry_review' : 'retry_checks';
    if (n >= 3) {
      this.store.setKv(key, null);
      this.store.release(t.id, owner, generation, 'waiting_decision', msg);
      this.store.createDecision({
        projectId: t.projectId,
        taskId: t.id,
        kind: 'diagnostic',
        question: `The ${kind === 'checks' ? 'check' : kind} step for ${t.id} "${t.title}" keeps failing.`,
        why: `${msg}\n\nThis is an autopilot or environment problem, not the builder's work. Fix the cause (see \`autopilot logs\` / the supervisor output), then retry.`,
        options: [
          { id: retry, label: 'Retry' },
          { id: 'cancel', label: 'Cancel this task', consequential: true },
        ],
        recommendation: retry,
        recommendationReason: 'Retry once the cause is fixed.',
        blocking: true,
        createdBy: 'supervisor',
        dedupeKey: `job:${kind}:${t.id}`,
      });
      return;
    }
    this.store.setKv(key, String(n));
    this.store.release(t.id, owner, generation, retryState, msg);
  }

  // ------------------------------------------------------------ reviews

  private startReviews(rt: ProjectRuntime): void {
    const cfg = rt.cfg;
    let slots = cfg.execution.maxReviewers - this.activeRuns(cfg.id, 'reviewer');
    for (const t of this.store.listTasks({ projectId: cfg.id, states: ['review_ready'] })) {
      if (slots <= 0) return;
      if (t.leaseOwner) continue;
      const runId = this.store.nextId('R');
      const claimed = this.store.claim(t.id, ['review_ready'], 'reviewing', runId, this.runLeaseMs(cfg));
      if (!claimed) continue;
      slots--;
      this.holdLaunchLease(runId, t.id, claimed.generation, this.runLeaseMs(cfg));
      this.track(this.launchReviewer(rt, claimed.task, runId, claimed.generation).finally(() => this.jobs.delete(`launch:${runId}`)), `launch reviewer ${t.id}`);
    }
  }

  private async launchReviewer(rt: ProjectRuntime, t: Task, runId: string, generation: number): Promise<void> {
    const cfg = rt.cfg;
    let diff;
    try {
      if (!t.worktree || !existsSync(t.worktree)) {
        const wt = await rt.forge.ensureWorktree(t.id, t.branch!);
        t = this.store.patchTask(t.id, { worktree: wt.path });
      }
      diff = await rt.forge.diff(await this.diffBase(rt, t, t.headCommit!), t.headCommit!, 120_000);
    } catch (err) {
      // Bounded: a persistent setup problem ends in one card instead of a hot retry loop.
      this.jobFailure(t, runId, generation, 'review', err, 'review_ready');
      throw err;
    }
    if (!this.ownsLease(t.id, runId, generation)) return;
    if (!this.mayStartRuns(cfg.id)) {
      this.store.release(t.id, runId, generation, 'review_ready', 'paused before the review started');
      return;
    }
    this.store.setKv(`job_errors:review:${t.id}`, null);
    const checks = this.store.latestChecks(t.id, t.headCommit!, 'branch');
    const lastBuild = this.store.listRuns({ taskId: t.id, limit: 10 }).find((r) => r.role === 'builder' && r.result);
    const builderSummary = (lastBuild?.result as BuilderResult | null)?.summary ?? '';
    // Exact rules (no ":*"), so nothing can be appended to these commands.
    const checkCommands = reviewerCheckCommands(cfg.checks.commands);
    const checkTools = checkCommands.map((c) => `Bash(${c})`);
    const gitTools = reviewerGitCommands(diff.baseCommit, diff.headCommit).map((c) => `Bash(${c})`);
    this.startRun(rt, {
      runId,
      role: 'reviewer',
      task: t,
      generation,
      cwd: t.worktree!,
      prompt: reviewerPrompt(t, diff, checks, builderSummary, checkCommands),
      system: reviewerSystemPrompt(cfg),
      resumeSessionId: null,
      permissionMode: 'dontAsk',
      allowedTools: [...READ_ONLY_TOOLS, ...gitTools, ...checkTools, ...MCP(['get_task_context', 'report_progress', 'propose_task'])],
      disallowedTools: [...WRITE_TOOLS, ...DEFAULT_DISALLOWED_TOOLS, ...BUILDER_DENY, ...CREDENTIAL_DENY, ...stateDeny(this.opts.home.root), ...cfg.execution.disallowedTools],
      jsonSchema: REVIEWER_RESULT_SCHEMA,
      model: cfg.execution.reviewerModel ?? cfg.execution.model,
      onDone: (out) => this.onReviewerDone(rt, runId, out),
    });
  }

  private async onReviewerDone(rt: ProjectRuntime, runId: string, out: RunOutcome): Promise<void> {
    const run = this.store.getRun(runId)!;
    const result = parseReviewerResult(out.structuredOutput);
    const t = this.ownsLease(run.taskId!, runId, run.generation);
    const finished = this.store.finishRun(runId, {
      status: t ? (out.status === 'succeeded' && !result ? 'failed' : out.status) : 'lost',
      result: result ?? out.structuredOutput,
      resultText: out.resultText,
      error: out.error ?? (out.status === 'succeeded' && !result ? 'no valid structured result' : null),
      costUsd: out.costUsd,
      numTurns: out.numTurns,
      sessionId: out.sessionId,
    });
    if (!t || !finished) return;
    if (out.status !== 'succeeded' || !result) {
      const fail = out.status === 'succeeded' ? { handled: false, countAttempt: true } : this.handleRunFailure(rt, run, out);
      // Consecutive failures since the last successful review (older history does not count).
      let failures = 0;
      for (const r of this.store.listRuns({ taskId: t.id, role: 'reviewer', limit: 20 })) {
        if (r.status === 'failed' || r.status === 'timeout') failures++;
        else if (r.status === 'succeeded') break;
      }
      if (!fail.handled && failures >= 3) {
        this.store.release(t.id, runId, run.generation, 'waiting_decision', 'reviewer keeps failing');
        this.reviewCard(rt, t, null, 'The automated reviewer failed repeatedly, so this change needs your review.');
        return;
      }
      this.store.release(t.id, runId, run.generation, 'review_ready', `review run ${out.status}`);
      return;
    }
    this.store.recordReview({ taskId: t.id, runId, headCommit: t.headCommit!, verdict: result.verdict, risk: result.risk, summary: result.summary, findings: result.findings });
    const findingText = result.findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ''}`).join('\n');
    this.store.addNote(t.id, 'reviewer', `${runId} ${result.verdict} (risk ${result.risk}): ${result.summary}${findingText ? `\n${findingText}` : ''}`);
    if (rt.forge.kind === 'github' && t.prNumber) {
      await rt.forge
        .comment(t, `**Autopilot review (${result.verdict}, risk ${result.risk})** of ${t.headCommit!.slice(0, 10)}\n\n${result.summary}${findingText ? `\n\n${findingText}` : ''}`)
        .catch(() => undefined);
    }
    if (result.verdict === 'approve') {
      this.store.release(t.id, runId, run.generation, 'merge_ready', `approved by ${runId}`);
    } else if (result.verdict === 'request_changes') {
      this.repairLeased(rt, t, runId, run.generation, `Reviewer requested changes:\n${result.summary}\n${findingText}`);
    } else {
      this.store.release(t.id, runId, run.generation, 'waiting_decision', 'reviewer asks for a founder judgement');
      this.reviewCard(rt, t, null, result.humanQuestion || result.summary);
    }
  }

  // ------------------------------------------------------------ merging

  private startMerge(rt: ProjectRuntime): void {
    if (rt.merging) return;
    const t = this.store.listTasks({ projectId: rt.cfg.id, states: ['merge_ready'] }).find((x) => !x.leaseOwner);
    if (!t) return;
    const owner = `${this.bootId}:merge`;
    const ttl = Math.max(30 * MIN, rt.cfg.checks.commands.reduce((s, c) => s + c.timeoutSeconds * 1000, 0) * 2);
    const claimed = this.store.claim(t.id, ['merge_ready'], 'merging', owner, ttl);
    if (!claimed) return;
    rt.merging = true;
    const key = `${owner}:${t.id}`;
    this.jobs.set(key, { owner, taskId: t.id, generation: claimed.generation, ttlMs: ttl });
    this.track(
      this.mergeTask(rt, claimed.task, owner, claimed.generation).finally(() => {
        rt.merging = false;
        this.jobs.delete(key);
      }),
      `merge ${t.id}`,
    );
  }

  private async mergeTask(rt: ProjectRuntime, t: Task, owner: string, generation: number): Promise<void> {
    const cfg = rt.cfg;
    try {
      // A record left by a merge job that died before its compare-and-swap belongs to that job, and
      // crash recovery is over once merges run: this job stores its own once its checks pass.
      this.store.setKv(`merge_pending:${rt.cfg.id}`, null);
      const head = t.headCommit!;
      // The branch ref is the source of truth (not whatever the worktree has checked out).
      const ref = await safeGit(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: rt.barePath!, allowFail: true });
      const branchHead = ref.stdout.trim();
      if (!branchHead) {
        this.repairLeased(rt, t, owner, generation, `The task branch ${t.branch} is missing; rebuild the change.`);
        return;
      }
      if (branchHead !== head) {
        // Bounded: something that keeps moving the branch ends in one card, not a loop.
        this.store.patchTask(t.id, { headCommit: branchHead });
        this.jobFailure(t, owner, generation, 'merge', new Error('the branch moved after it was checked and reviewed'), 'checking');
        return;
      }
      if (this.store.founderRejected(t.id, head)) {
        this.repairLeased(rt, t, owner, generation, 'The founder requested changes on this exact revision; apply the requested changes.');
        return;
      }
      const base = await this.diffBase(rt, t, head);
      const diff = await rt.forge.diff(base, head, 2_000_000);
      const scan = await this.scanCommits(rt, base, head);
      if (scan.secrets.length) {
        this.repairLeased(rt, t, owner, generation, `Secret-looking content is in this branch (${scan.secrets.map((s) => `${s.kind} in ${s.file}`).join('; ')}). Remove it from every commit before it can merge.`);
        return;
      }
      if (scan.incomplete) {
        this.repairLeased(rt, t, owner, generation, `Not merged: the secret scan could not check all of this branch's commits (${scan.incomplete}).`);
        return;
      }
      const checks = this.store.latestChecks(t.id, head, 'branch');
      const review = this.store.latestReview(t.id, head);
      const openChangeRequests = this.store.unprocessedFeedback(t.projectId).filter((f) => f.taskId === t.id && f.kind === 'change_request').length;
      const inputs = { task: t, config: cfg, diff, checks, review, pendingBlocking: this.store.pendingBlockingFor(t.id).length, openChangeRequests };
      let verdict: MergeVerdict = classifyMerge(inputs);
      const humanApproved = review?.verdict === 'human_approve' && review.headCommit === head;
      if (verdict.action === 'human_review' && humanApproved) {
        verdict = { ...verdict, action: 'auto_merge', reasons: ['approved by the founder for this exact revision'] };
      }
      this.store.event({ projectId: t.projectId, taskId: t.id, type: 'merge.classified', message: `${t.id}: ${verdict.action} (${verdict.reasons.join('; ').slice(0, 300)})`, data: verdict });

      if (verdict.action === 'reject') {
        this.repairLeased(rt, t, owner, generation, `Protected files were changed (${verdict.protectedFiles.join(', ')}). Revert those changes; builders may not modify policy files.`);
        return;
      }
      if (verdict.action === 'repair') {
        this.repairLeased(rt, t, owner, generation, `Not mergeable yet: ${verdict.reasons.join('; ')}`);
        return;
      }
      if (verdict.action === 'human_review') {
        this.store.release(t.id, owner, generation, 'waiting_decision', 'needs a founder merge decision');
        this.reviewCard(rt, this.store.getTask(t.id)!, { verdict, inputs }, null);
        return;
      }

      // Never integrate on top of a target that something else moved.
      if (!(await this.verifyTarget(rt))) {
        this.store.release(t.id, owner, generation, 'merge_ready', 'target branch integrity check failed; project paused');
        return;
      }
      if (!this.ownsLease(t.id, owner, generation)) return; // e.g. cancelled while we classified
      const expectedTarget = this.store.getKv(`target_head:${rt.cfg.id}`);
      const result = await rt.forge.integrate(t, head, async (cwd) => {
        const setup = await rt.checks.setup(cwd);
        return [...setup.filter((r) => r.status !== 'passed'), ...(await rt.checks.run(cwd))];
      }, (commit, base) => this.store.setKv(`merge_pending:${rt.cfg.id}`, JSON.stringify({ taskId: t.id, base, commit })));
      // Close the window between the check above and the merge (see checkMerged). The head that
      // passes is recorded before anything else can fail: unrecorded, our own merge would read as
      // tampering at the next check. A GitHub integration may have moved the local target to the
      // source's head even when the merge itself failed.
      const checked = expectedTarget && rt.barePath && (result.status === 'merged' || rt.forge.kind === 'github') ? await this.checkMerged(rt, result, expectedTarget) : null;
      if (checked) this.store.setKv(`target_head:${rt.cfg.id}`, checked);
      this.store.setKv(`merge_pending:${rt.cfg.id}`, null);
      this.forgetUpstream(rt.cfg.id); // the integration's own syncs have been checked
      if (result.checks.length) this.store.recordChecks(t.id, head, 'integration', result.checks);
      if (checked === false) {
        this.store.setKv(`target_head:${rt.cfg.id}`, expectedTarget!);
        await this.verifyTarget(rt);
        this.store.release(t.id, owner, generation, 'merge_ready', 'target moved during the merge; project paused');
        return;
      }
      switch (result.status) {
        case 'merged': {
          // The merge passed the check above: only now may it leave the clone.
          const recorded = this.store.getKv(`target_head:${rt.cfg.id}`);
          if (recorded) await rt.forge.pushIntegrated(recorded);
          this.store.setKv(`job_errors:merge:${t.id}`, null);
          this.store.release(t.id, owner, generation, 'integrated', humanApproved ? 'merged after founder approval' : 'auto-merged', {});
          this.store.event({
            projectId: t.projectId,
            taskId: t.id,
            type: 'merge.completed',
            message: `${t.id} "${t.title}" integrated into ${cfg.repo.targetBranch} (${(result.mergedCommit ?? '').slice(0, 10)})${humanApproved ? ' after founder approval' : ' automatically'}`,
            data: { mergedCommit: result.mergedCommit, prUrl: t.prUrl, auto: !humanApproved },
          });
          this.supersedeReviewCards(t.id, 'merged');
          if (t.worktree) await rt.forge.removeWorktree(t.worktree).catch(() => undefined);
          break;
        }
        case 'conflict':
          this.repairLeased(rt, t, owner, generation, `Merge conflict with the latest ${cfg.repo.targetBranch}: ${result.details}\nMerge ${cfg.repo.targetBranch} into your branch (git merge ${cfg.repo.targetBranch}), resolve the conflicts preserving both intents, re-run the tests and commit.`);
          break;
        case 'checks_failed':
          this.repairLeased(
            rt,
            t,
            owner,
            generation,
            `Checks failed after merging with the latest ${cfg.repo.targetBranch}:\n${result.checks.filter((c) => c.status !== 'passed').map((c) => `${c.name} ${c.status}:\n${c.outputTail.slice(-1500)}`).join('\n\n')}\nMerge ${cfg.repo.targetBranch} into your branch and fix the integration problem.`,
          );
          break;
        case 'stale_head':
          this.jobFailure(t, owner, generation, 'merge', new Error(`stale: ${result.details}`), 'checking');
          break;
        case 'blocked_by_forge':
          this.store.release(t.id, owner, generation, 'waiting_decision', 'GitHub refused the merge');
          this.store.createDecision({
            projectId: t.projectId,
            taskId: t.id,
            kind: 'diagnostic',
            question: `GitHub refused to merge ${t.id}. Change the repository settings or merge manually?`,
            why: `${result.details.slice(0, 1500)}\n\nThe balanced profile needs branch rules that its own reviewer identity can satisfy. Either relax the rule for autopilot PRs, add a separate reviewer identity, or merge the PR yourself; then retry.`,
            // Project-wide card (several tasks may wait on it), so no per-task "cancel" here.
            options: [{ id: 'retry_merge', label: 'I changed the settings or merged it — retry' }],
            recommendation: 'retry_merge',
            recommendationReason: 'Fix once; later PRs will merge automatically. Cancel individual tasks from the board if needed.',
            links: t.prUrl ? [{ label: 'Pull request', url: t.prUrl }] : [],
            blocking: true,
            createdBy: 'supervisor',
            dedupeKey: `forge-blocked:${t.projectId}`,
          });
          break;
        default:
          this.store.addNote(t.id, 'merge', `Merge error: ${result.details}`);
          this.jobFailure(t, owner, generation, 'merge', new Error(result.details), 'merge_ready');
      }
      if (result.status !== 'error') this.store.setKv(`job_errors:merge:${t.id}`, null);
    } catch (err) {
      this.jobFailure(t, owner, generation, 'merge', err, 'merge_ready');
      throw err;
    }
  }

  private reviewCard(rt: ProjectRuntime, t: Task, ctx: { verdict: MergeVerdict; inputs: Parameters<typeof classifyMerge>[0] } | null, reviewerText: string | null): void {
    const text = ctx ? reviewCardText(ctx.verdict, ctx.inputs) : { question: `Review ${t.id} "${t.title}"?`, why: reviewerText ?? '' };
    const review = this.store.latestReview(t.id, t.headCommit ?? undefined);
    const links = [{ label: 'Task details', url: `/#task=${t.id}` }];
    if (t.prUrl) links.unshift({ label: 'Pull request', url: t.prUrl });
    const agentApproved = review?.verdict === 'approve';
    // GitHub does not let a PR's author approve it, so GitHub mode accepts "/approve CODE"
    // from a trusted account. The code is shown only here, so a process that merely holds
    // the founder's GitHub login cannot approve by commenting.
    let githubHint = '';
    if (rt.forge.kind === 'github' && t.headCommit) {
      const code = randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
      this.store.setKv(`approve_code:${t.id}:${t.headCommit}`, code);
      githubHint = `\n\nOn GitHub you can also comment: /approve ${code}`;
    }
    this.store.createDecision({
      projectId: t.projectId,
      taskId: t.id,
      kind: 'review',
      question: text.question,
      why: `${text.why}${githubHint}`,
      options: [
        // Merging something that policy flagged takes an explicit tap, never a swipe.
        { id: 'approve', label: 'Merge this revision', tradeoff: 'Integrates exactly this commit; any later change needs a new review.', consequential: true },
        { id: 'changes', label: 'Request changes', requiresComment: true, tradeoff: 'The builder revises it using your comment.' },
      ],
      recommendation: agentApproved ? 'approve' : null,
      recommendationReason: agentApproved ? `The independent reviewer approved it (risk ${review!.risk}); it only needs you because of policy: ${ctx?.verdict.reasons.join('; ') ?? 'reviewer request'}.` : '',
      blocking: true,
      priority: 'normal',
      artifactRef: t.headCommit,
      links,
      blockedSummary: `${t.id} waits for your merge decision.`,
      continuesSummary: 'Other tasks keep running.',
      createdBy: 'supervisor',
      dedupeKey: `review:${t.id}:${(t.headCommit ?? '').slice(0, 12)}`,
    });
  }

  // ------------------------------------------------------------ planner

  private maybePlan(rt: ProjectRuntime): void {
    const cfg = rt.cfg;
    if (!cfg.planner.enabled || rt.plannerRunId) return;
    const tasks = this.store.listTasks({ projectId: cfg.id });
    const open = tasks.filter((t) => OPEN.includes(t.state)).length;
    const proposed = tasks.filter((t) => t.state === 'proposed').length;
    if (open >= cfg.planner.minQueue && proposed === 0) return;
    const p = this.store.getProject(cfg.id)!;
    if (p.lastPlannedAt && this.now() - p.lastPlannedAt < cfg.planner.cooldownMinutes * MIN) return;
    if (this.store.pendingDecisionCount(cfg.id) >= cfg.inbox.maxPendingDecisions) return;
    const ready = tasks.filter((t) => t.state === 'ready').length;
    const capacity = Math.min(cfg.planner.maxTasksPerPlan, cfg.planner.maxQueue - ready);
    if (capacity <= 0 && proposed === 0) return;
    const runId = this.store.nextId('R');
    rt.plannerRunId = runId;
    this.store.setProjectPlannedAt(cfg.id, this.now());
    this.track(
      this.launchPlanner(rt, runId, Math.max(0, capacity)).catch((err) => {
        rt.plannerRunId = null;
        this.plannerFailed(rt, `could not start the planner: ${(err as Error).message}`);
        throw err;
      }),
      `planner ${cfg.id}`,
    );
  }

  /** Count consecutive planner failures (start-up or run); the third one becomes a card. */
  private plannerFailed(rt: ProjectRuntime, why: string): void {
    const key = `job_errors:plan:${rt.cfg.id}`;
    const n = Number(this.store.getKv(key) ?? '0') + 1;
    this.store.setKv(key, String(n));
    if (n < 3) return;
    this.store.createDecision({
      projectId: rt.cfg.id,
      kind: 'diagnostic',
      question: `The planner for ${rt.cfg.name} failed ${n} times in a row.`,
      why: `Last problem: ${why.slice(0, 1000)}\n\nCheck the documents and config, or add tasks yourself. New planning waits for your answer.`,
      options: [{ id: 'retry_plan', label: 'Try planning again' }],
      recommendation: 'retry_plan',
      recommendationReason: 'Retry after fixing the cause.',
      blocking: false,
      createdBy: 'supervisor',
      dedupeKey: `planner-failing:${rt.cfg.id}`,
    });
    this.store.setProjectPlannedAt(rt.cfg.id, this.now() + 365 * 24 * 60 * MIN); // hold planning until answered
  }

  private async plannerCheckout(rt: ProjectRuntime): Promise<string> {
    const bare = rt.barePath ?? (await rt.forge.prepare());
    const dir = join(this.opts.home.projectDir(rt.cfg.id), 'worktrees', '_planner');
    const ref = `refs/heads/${rt.cfg.repo.targetBranch}`;
    if (!existsSync(dir)) {
      await safeGit(['worktree', 'prune'], { cwd: bare, allowFail: true });
      await safeGit(['worktree', 'add', '--detach', '--force', dir, ref], { cwd: bare });
    } else {
      await safeGit(['checkout', '--detach', '--force', ref], { cwd: dir });
      await safeGit(['clean', '-fd'], { cwd: dir, allowFail: true });
    }
    return dir;
  }

  private async launchPlanner(rt: ProjectRuntime, runId: string, capacity: number): Promise<void> {
    const cfg = rt.cfg;
    const dir = await this.plannerCheckout(rt);
    const tree = await safeGit(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, allowFail: true });
    const repoTree = summarizeTree(tree.stdout.split('\n').filter(Boolean));
    const tasks = this.store.listTasks({ projectId: cfg.id });
    const recentIntegrated = this.store
      .listEvents({ projectId: cfg.id, types: ['merge.completed'], limit: 15 })
      .map((e) => e.message);
    const decisions = this.store.listDecisions({ projectId: cfg.id, limit: 60, newestFirst: true }).filter((d) => d.kind === 'choice' && (d.status === 'pending' || d.status === 'answered'));
    this.startRun(rt, {
      runId,
      role: 'planner',
      task: null,
      generation: 0,
      cwd: dir,
      prompt: plannerPrompt(cfg, { tasks, decisions, capacity, repoTree, recentIntegrated }),
      system: plannerSystemPrompt(cfg),
      resumeSessionId: null,
      permissionMode: 'dontAsk',
      allowedTools: [...READ_ONLY_TOOLS, 'WebSearch', 'WebFetch', ...MCP(['report_progress'])],
      disallowedTools: [...WRITE_TOOLS, ...DEFAULT_DISALLOWED_TOOLS, ...BUILDER_DENY, ...CREDENTIAL_DENY, ...stateDeny(this.opts.home.root), ...cfg.execution.disallowedTools],
      jsonSchema: PLANNER_RESULT_SCHEMA,
      model: cfg.execution.plannerModel ?? cfg.execution.model,
      onDone: (out) => this.onPlannerDone(rt, runId, out, capacity),
    });
  }

  private async onPlannerDone(rt: ProjectRuntime, runId: string, out: RunOutcome, capacity: number): Promise<void> {
    rt.plannerRunId = null;
    const run = this.store.getRun(runId)!;
    const result = parsePlannerResult(out.structuredOutput);
    this.store.finishRun(runId, {
      status: out.status === 'succeeded' && !result ? 'failed' : out.status,
      result: result ?? out.structuredOutput,
      resultText: out.resultText,
      error: out.error ?? (out.status === 'succeeded' && !result ? 'no valid structured result' : null),
      costUsd: out.costUsd,
      numTurns: out.numTurns,
      sessionId: out.sessionId,
    });
    if (out.status !== 'succeeded' || !result) {
      const fail = out.status === 'succeeded' ? { handled: false } : this.handleRunFailure(rt, run, out);
      if (!fail.handled) this.plannerFailed(rt, (out.error ?? out.resultText ?? 'no valid plan').toString());
      else this.store.setProjectPlannedAt(rt.cfg.id, 0); // usage/auth/kill: plan again once allowed
      return;
    }
    this.store.setKv(`job_errors:plan:${rt.cfg.id}`, null);
    this.applyPlan(rt, runId, result, capacity);
  }

  private applyPlan(rt: ProjectRuntime, runId: string, plan: NonNullable<ReturnType<typeof parsePlannerResult>>, capacity: number): void {
    const cfg = rt.cfg;
    const existing = this.store.listTasks({ projectId: cfg.id });
    const byTitle = new Map(existing.filter((t) => t.state !== 'cancelled').map((t) => [normalizeTitle(t.title), t.id] as const));
    // Decide first: duplicates map to the task they repeat; beyond capacity is cut, and so is
    // anything that depends on a cut task (it must not run before its foundation exists).
    const keyToId = new Map<string, string>();
    const toCreate: typeof plan.newTasks = [];
    const cut = new Set<string>();
    for (const pt of plan.newTasks) {
      const dup = byTitle.get(normalizeTitle(pt.title));
      if (dup) keyToId.set(pt.key, dup);
      else if (toCreate.length < capacity) toCreate.push(pt);
      else cut.add(pt.key);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const pt of [...toCreate]) {
        if (pt.dependsOn.some((d) => cut.has(d))) {
          toCreate.splice(toCreate.indexOf(pt), 1);
          cut.add(pt.key);
          changed = true;
        }
      }
    }
    if (cut.size) this.store.event({ projectId: cfg.id, runId, type: 'plan.capped', message: `Planner ${runId}: deferred ${cut.size} task(s) over capacity or depending on them` });
    const created: Task[] = [];
    for (const pt of toCreate) {
      if (byTitle.has(normalizeTitle(pt.title))) continue;
      const t = this.store.createTask({
        projectId: cfg.id,
        title: pt.title,
        objective: pt.objective,
        nonGoals: pt.nonGoals,
        acceptanceCriteria: pt.acceptanceCriteria,
        role: pt.role,
        kind: pt.kind,
        priority: pt.priority,
        risk: pt.risk,
        ownedPaths: pt.ownedPaths,
        dependsOn: [],
        origin: 'planner',
        hypothesis: pt.hypothesis ?? null,
        state: 'ready',
      });
      byTitle.set(normalizeTitle(pt.title), t.id);
      keyToId.set(pt.key, t.id);
      created.push(t);
    }
    const known = new Set(existing.map((t) => t.id));
    const createdIds = new Set(created.map((t) => t.id));
    for (const pt of plan.newTasks) {
      const id = keyToId.get(pt.key);
      if (!id || !createdIds.has(id)) continue;
      const deps = pt.dependsOn.map((d) => keyToId.get(d) ?? (known.has(d) ? d : null)).filter((d): d is string => !!d && d !== id);
      if (deps.length) this.store.patchTask(id, { dependsOn: deps });
    }
    breakDependencyCycles(this.store, created.map((t) => t.id));
    for (const id of plan.acceptTaskIds) {
      const t = this.store.getTask(id);
      if (t && t.projectId === cfg.id && t.state === 'proposed') this.store.transition(id, 'proposed', 'ready', `accepted by planner ${runId}`);
    }
    for (const id of plan.cancelTaskIds) {
      const t = this.store.getTask(id);
      if (t && t.projectId === cfg.id && ['proposed', 'ready'].includes(t.state) && !t.leaseOwner) {
        this.store.transition(id, t.state, 'cancelled', `cancelled by planner ${runId}`);
      }
    }
    for (const q of plan.questions.slice(0, 2)) {
      const options = q.options.filter((o) => o.id && o.label);
      // A recommendation that is not one of the options is dropped, not re-pinned to another option.
      const valid = options.some((o) => o.id === q.recommendation);
      try {
        this.store.createDecision({
          projectId: cfg.id,
          kind: 'choice',
          question: q.question,
          why: q.why,
          options,
          recommendation: valid ? q.recommendation : null,
          recommendationReason: valid ? q.recommendationReason : '',
          blocking: false,
          createdBy: 'planner',
          createdByRun: runId,
          dedupeKey: `plan:${slugify(q.question, 60)}`,
          continuesSummary: 'Work continues on the recommended direction until you answer.',
        });
      } catch (err) {
        this.store.event({ projectId: cfg.id, runId, type: 'plan.question_rejected', message: (err as Error).message });
      }
    }
    this.store.event({
      projectId: cfg.id,
      runId,
      type: 'plan.applied',
      message: `Planner ${runId}: ${created.length} new task(s)${plan.acceptTaskIds.length ? `, accepted ${plan.acceptTaskIds.length}` : ''}${plan.cancelTaskIds.length ? `, cancelled ${plan.cancelTaskIds.length}` : ''}. ${plan.summary.slice(0, 300)}`,
    });
  }

  // ------------------------------------------------------------ feedback

  private async pollFeedback(rt: ProjectRuntime): Promise<void> {
    if (this.now() - rt.lastFeedbackPoll < rt.cfg.feedback.pollSeconds * 1000) return;
    rt.lastFeedbackPoll = this.now();
    const p = this.store.getProject(rt.cfg.id)!;
    const since = (p.feedbackCursor || this.now() - 60 * MIN) - 2 * MIN; // overlap window; dedupe by id
    const tasks = this.store.listTasks({ projectId: rt.cfg.id }).filter((t) => t.prNumber && t.state !== 'cancelled');
    if (!tasks.length) return;
    try {
      const items = await rt.forge.pollFeedback(since, tasks);
      for (const f of items) this.store.insertFeedback(f);
      this.store.setFeedbackCursor(rt.cfg.id, this.now());
    } catch (err) {
      this.store.event({ projectId: rt.cfg.id, type: 'feedback.poll_failed', message: (err as Error).message.slice(0, 300) });
    }
  }

  private processFeedback(rt: ProjectRuntime): void {
    const trusted = new Set(rt.cfg.feedback.trustedActors.map((a) => a.toLowerCase()));
    for (const f of this.store.unprocessedFeedback(rt.cfg.id)) {
      const t = f.taskId ? this.store.getTask(f.taskId) : null;
      if (!t || !trusted.has(f.author.toLowerCase())) {
        this.store.markFeedbackProcessed(f.externalId);
        this.store.event({ projectId: rt.cfg.id, taskId: f.taskId, type: 'feedback.ignored', message: `Ignored ${f.kind} from ${f.author} (not a trusted actor or unknown task)` });
        continue;
      }
      if (t.leaseOwner) continue; // handle after the current run/job releases the task
      this.store.markFeedbackProcessed(f.externalId);
      const quoted = `${f.kind} from ${f.author}${f.url ? ` (${f.url})` : ''}: "${f.body.slice(0, 2000)}"`;
      // GitHub never lets a PR's author approve it, and autopilot PRs are opened with the
      // founder's login, so "/approve CODE" from a trusted account approves, where CODE is the
      // one shown on the inbox card for this exact revision (an agent holding the same login
      // does not see it). A real GitHub approval must have been given on the current commit.
      const cmd = f.kind !== 'approval' ? /^\s*\/(?:autopilot\s+)?approve\b\s*([A-Za-z0-9]{4,12})?/i.exec(f.body) : null;
      if (f.kind === 'approval' || cmd) {
        const issued = t.headCommit ? this.store.getKv(`approve_code:${t.id}:${t.headCommit}`) : null;
        const valid = f.kind === 'approval' ? !f.commitId || f.commitId === t.headCommit : !!issued && !!cmd?.[1] && cmd[1].toUpperCase() === issued;
        if (!valid) {
          this.store.event({ projectId: rt.cfg.id, taskId: t.id, type: 'feedback.approval_rejected', message: `Ignored approval from ${f.author}: ${f.kind === 'approval' ? 'it was for an older revision' : 'missing or wrong approval code'}` });
          continue;
        }
        if (t.headCommit && ['waiting_decision', 'review_ready', 'merge_ready'].includes(t.state)) {
          this.store.recordReview({ taskId: t.id, runId: null, headCommit: t.headCommit, verdict: 'human_approve', risk: t.risk, summary: `Approved on GitHub by ${f.author}`, findings: [] });
          this.supersedeReviewCards(t.id, 'approved on GitHub');
          if (t.state === 'waiting_decision' && this.store.pendingBlockingFor(t.id).length === 0) this.store.transition(t.id, 'waiting_decision', 'merge_ready', `approved on GitHub by ${f.author}`);
        }
        continue;
      }
      if (t.state === 'integrated') {
        this.store.createTask({
          projectId: t.projectId,
          title: `Follow up on feedback for ${t.id}`.slice(0, 120),
          objective: `After ${t.id} ("${t.title}") was merged, the founder left feedback: ${quoted}. Address it in a new change.`,
          acceptanceCriteria: ['The feedback is addressed', 'Existing checks pass'],
          ownedPaths: t.ownedPaths,
          priority: 2,
          origin: 'feedback',
          state: 'ready',
        });
        continue;
      }
      this.store.addNote(t.id, 'feedback', quoted);
      if (['review_ready', 'merge_ready', 'checking', 'waiting_decision'].includes(t.state)) {
        if (t.headCommit) {
          this.store.recordReview({ taskId: t.id, runId: null, headCommit: t.headCommit, verdict: 'human_request_changes', risk: t.risk, summary: `Change request on GitHub from ${f.author}`, findings: [] });
        }
        try {
          this.repairUnleased(t, `Founder feedback on the PR: ${quoted}`);
        } catch (err) {
          // Never drop founder feedback silently; the recorded rejection already blocks this revision.
          this.store.event({ projectId: rt.cfg.id, taskId: t.id, type: 'feedback.not_applied', message: `${(err as Error).message}`.slice(0, 300) });
        }
      }
      void rt.forge.comment(t, `Got it — ${t.id} will be revised to address this feedback.`).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ actions

  pauseAll(reason: string): void {
    this.store.setPausedAll(true, reason);
    for (const r of this.runs.values()) r.handle.kill(`paused: ${reason}`);
  }

  resumeAll(reason: string): void {
    this.store.setPausedAll(false, reason);
    if (this.store.usagePausedUntil()) this.store.setUsagePause(null, reason);
    this.wake();
  }

  pauseProject(projectId: string, reason: string): void {
    this.store.setProjectPaused(projectId, true, reason);
    for (const r of this.runs.values()) if (r.projectId === projectId) r.handle.kill(`paused: ${reason}`);
  }

  resumeProject(projectId: string, reason: string): void {
    this.store.setProjectPaused(projectId, false, reason);
    this.wake();
  }

  addTask(input: { projectId: string; title: string; objective: string; acceptanceCriteria?: string[] }): Task {
    const t = this.store.createTask({ ...input, origin: 'human', state: 'ready' });
    this.wake();
    return t;
  }

  retryTask(taskId: string): Task {
    const t = this.store.getTask(taskId);
    if (!t) throw new StateError(`unknown task ${taskId}`);
    if (t.leaseOwner) throw new StateError(`${taskId} is busy (${t.state})`);
    const out = this.store.transition(taskId, ['exhausted', 'waiting_decision'], 'ready', 'retried by founder', { attempts: 0, repairCycles: 0 });
    // Cards shared with other tasks stay open for them.
    this.store.detachTaskFromDecisions(taskId, 'superseded', 'task retried');
    this.wake();
    return out;
  }

  cancelTask(taskId: string): Task {
    const t = this.store.getTask(taskId);
    if (!t) throw new StateError(`unknown task ${taskId}`);
    if (t.state === 'integrated' || t.state === 'cancelled') return t;
    // A merge in progress cannot be stopped safely; it finishes within moments.
    if (t.state === 'merging') throw new StateError(`${taskId} is being merged right now; cancel it after the merge finishes (or revert it then)`);
    if (t.leaseOwner) {
      this.runs.get(t.leaseOwner)?.handle.kill('task cancelled');
      this.store.breakLease(t.id, t.leaseOwner, 'cancelled', 'cancelled by founder');
    } else {
      this.store.transition(t.id, t.state, 'cancelled', 'cancelled by founder');
    }
    this.store.detachTaskFromDecisions(taskId, 'cancelled', 'task cancelled');
    const rt = this.runtimes.get(t.projectId);
    if (rt && t.worktree) this.track(rt.forge.removeWorktree(t.worktree), `remove worktree ${t.id}`);
    this.wake();
    return this.store.getTask(taskId)!;
  }

  async taskDiff(taskId: string): Promise<DiffSummary | null> {
    const t = this.store.getTask(taskId);
    const rt = t ? this.runtimes.get(t.projectId) : undefined;
    if (!t || !rt || !t.headCommit) return null;
    try {
      const base = await this.diffBase(rt, t, t.headCommit);
      if (base === t.headCommit) return null;
      return await rt.forge.diff(base, t.headCommit, 300_000);
    } catch {
      return null; // e.g. the branch was cleaned up after merge
    }
  }

  /** Snapshot for status displays and tests. */
  snapshot(): { runs: { runId: string; role: RunRole; taskId: string | null; projectId: string }[]; merging: string[] } {
    return {
      runs: [...this.runs.values()].map((r) => ({ runId: r.runId, role: r.role, taskId: r.taskId, projectId: r.projectId })),
      merging: [...this.runtimes.values()].filter((r) => r.merging).map((r) => r.cfg.id),
    };
  }

  /** Wait until no background work is pending (tests). */
  async idle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.tick();
      if (!this.pending.size && !this.runs.size && !this.ticking) return;
      await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, 20))]);
    }
    throw new Error('supervisor did not become idle');
  }
}

// ------------------------------------------------------------ helpers

function recoveryState(s: TaskState): TaskState {
  if (s === 'building') return 'ready';
  if (s === 'reviewing') return 'review_ready';
  if (s === 'merging') return 'merge_ready';
  return s; // checking stays checking (re-run)
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Remove dependency edges that close a cycle among the given tasks (planner mistakes). */
function breakDependencyCycles(store: Store, ids: string[]): void {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    visiting.add(id);
    const t = store.getTask(id);
    if (t) {
      const keep: string[] = [];
      for (const dep of t.dependsOn) {
        if (visiting.has(dep)) {
          store.event({ projectId: t.projectId, taskId: id, type: 'plan.cycle_removed', message: `Removed dependency ${id} -> ${dep} (cycle)` });
          continue;
        }
        visit(dep);
        keep.push(dep);
      }
      if (keep.length !== t.dependsOn.length) store.patchTask(id, { dependsOn: keep });
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids) visit(id);
}

/** Collapse a file list into a short directory overview for the planner prompt. */
export function summarizeTree(files: string[], maxLines = 60): string {
  if (!files.length) return '';
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => (k.endsWith('/') ? `${k} (${n} files)` : k));
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more`].join('\n') : lines.join('\n');
}

/** Kill a worker process left over from a previous supervisor (best effort, macOS/Linux). */
function killStaleProcess(run: Run): void {
  if (!run.pid) return;
  try {
    process.kill(run.pid, 0);
  } catch {
    return; // not alive
  }
  // Guard against pid reuse: only kill the exact worker, identified by the session id it
  // was started with (--session-id / --resume), never just any process named "claude".
  const session = run.resumedSessionId ?? run.sessionId;
  if (!session) return;
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(run.pid)], { encoding: 'utf8' });
    if (!cmd.includes(session)) return;
  } catch {
    return;
  }
  try {
    process.kill(-run.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(run.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}
