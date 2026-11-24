// SPDX-License-Identifier: MIT
// Durable state: tasks with fenced leases, runs, revision-bound decisions,
// an outbox for reliable delivery, and an append-only audit log.
// All methods are synchronous (node:sqlite) and safe to call from one process;
// short-lived CLI processes may write concurrently thanks to WAL + busy_timeout.

import type { DB } from './db.ts';
import { openDb } from './db.ts';
import { configHash, type ProjectConfig } from './config.ts';
import type {
  AuditEvent,
  CheckRecord,
  CheckResult,
  Clock,
  Decision,
  DecisionAnswer,
  DecisionResponseInput,
  DecisionResponseOutcome,
  FeedbackItem,
  NewDecisionInput,
  NewTaskInput,
  OutboxItem,
  ReviewRecord,
  Run,
  RunRole,
  RunStatus,
  Task,
  TaskNote,
  TaskState,
} from './types.ts';

// ------------------------------------------------------------ state machine

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  proposed: ['ready', 'cancelled'],
  ready: ['building', 'waiting_decision', 'proposed', 'cancelled'],
  building: ['checking', 'ready', 'waiting_decision', 'exhausted', 'integrated', 'cancelled'],
  checking: ['review_ready', 'merge_ready', 'ready', 'waiting_decision', 'exhausted', 'cancelled'],
  review_ready: ['reviewing', 'merge_ready', 'ready', 'waiting_decision', 'checking', 'exhausted', 'cancelled'],
  reviewing: ['merge_ready', 'ready', 'review_ready', 'waiting_decision', 'exhausted', 'cancelled'],
  merge_ready: ['merging', 'ready', 'checking', 'waiting_decision', 'exhausted', 'cancelled'],
  merging: ['integrated', 'ready', 'checking', 'merge_ready', 'waiting_decision', 'exhausted', 'cancelled'],
  waiting_decision: ['ready', 'checking', 'review_ready', 'merge_ready', 'exhausted', 'cancelled'],
  integrated: [],
  exhausted: ['ready', 'cancelled'],
  cancelled: [],
};

export class StateError extends Error {}

export interface ProjectRow {
  id: string;
  name: string;
  config: ProjectConfig;
  configHash: string;
  paused: boolean;
  pauseReason: string | null;
  lastPlannedAt: number | null;
  feedbackCursor: number;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, any>;

const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class Store {
  readonly db: DB;
  readonly now: Clock;
  private txDepth = 0;

  constructor(db: DB, now: Clock = Date.now) {
    this.db = db;
    this.now = now;
  }

  static open(path: string, now: Clock = Date.now): Store {
    return new Store(openDb(path), now);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn in a transaction (BEGIN IMMEDIATE); nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `sp${this.txDepth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const out = fn();
        this.db.exec(`RELEASE ${sp}`);
        return out;
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${sp}`);
        this.db.exec(`RELEASE ${sp}`);
        throw err;
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  private get(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  nextId(prefix: 'T' | 'D' | 'R'): string {
    return this.tx(() => {
      this.run('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', prefix);
      const r = this.get('SELECT value FROM counters WHERE name = ?', prefix)!;
      return `${prefix}-${r.value}`;
    });
  }

  // -------------------------------------------------------------------- kv

  getKv(key: string): string | null {
    return (this.get('SELECT value FROM kv WHERE key = ?', key)?.value as string) ?? null;
  }

  setKv(key: string, value: string | null): void {
    if (value === null) this.run('DELETE FROM kv WHERE key = ?', key);
    else this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** Global pause (kill switch) for all projects. */
  isPausedAll(): boolean {
    return this.getKv('paused_all') === '1';
  }

  setPausedAll(paused: boolean, reason: string): void {
    this.tx(() => {
      this.setKv('paused_all', paused ? '1' : null);
      this.event({ type: paused ? 'pause.all' : 'resume.all', message: paused ? `Paused everything: ${reason}` : `Resumed: ${reason}` });
    });
  }

  /** Account-wide usage-limit pause (subscription limits are shared across projects). */
  usagePausedUntil(): number | null {
    const v = this.getKv('usage_paused_until');
    return v ? Number(v) : null;
  }

  setUsagePause(until: number | null, reason: string): void {
    this.tx(() => {
      this.setKv('usage_paused_until', until === null ? null : String(until));
      if (until !== null) {
        this.event({ type: 'usage.paused', message: `Usage limit: pausing new runs until ${new Date(until).toISOString()} (${reason})` });
      } else {
        this.event({ type: 'usage.resumed', message: `Usage pause cleared (${reason})` });
      }
    });
  }

  // -------------------------------------------------------------- projects

  upsertProject(cfg: ProjectConfig): ProjectRow {
    const now = this.now();
    const hash = configHash(cfg);
    return this.tx(() => {
      const existing = this.get('SELECT id, config_hash FROM projects WHERE id = ?', cfg.id);
      if (existing) {
        this.run('UPDATE projects SET name = ?, config_json = ?, config_hash = ?, updated_at = ? WHERE id = ?', cfg.name, j(cfg), hash, now, cfg.id);
      } else {
        this.run(
          'INSERT INTO projects (id, name, config_json, config_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          cfg.id,
          cfg.name,
          j(cfg),
          hash,
          now,
          now,
        );
      }
      if (!existing || existing.config_hash !== hash) {
        this.run('INSERT OR IGNORE INTO policy_versions (project_id, hash, config_json, at) VALUES (?, ?, ?, ?)', cfg.id, hash, j(cfg), now);
        this.event({ projectId: cfg.id, type: 'policy.version', message: `Policy ${hash} in force (profile ${cfg.profile})`, data: { hash } });
      }
      return this.getProject(cfg.id)!;
    });
  }

  private toProject(r: Row): ProjectRow {
    return {
      id: r.id,
      name: r.name,
      config: pj<ProjectConfig>(r.config_json, null as unknown as ProjectConfig),
      configHash: r.config_hash,
      paused: !!r.paused,
      pauseReason: r.pause_reason ?? null,
      lastPlannedAt: r.last_planned_at ?? null,
      feedbackCursor: r.feedback_cursor ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  getProject(id: string): ProjectRow | null {
    const r = this.get('SELECT * FROM projects WHERE id = ?', id);
    return r ? this.toProject(r) : null;
  }

  listProjects(): ProjectRow[] {
    return this.all('SELECT * FROM projects ORDER BY id').map((r) => this.toProject(r));
  }

  setProjectPaused(id: string, paused: boolean, reason: string): void {
    this.tx(() => {
      this.run('UPDATE projects SET paused = ?, pause_reason = ?, updated_at = ? WHERE id = ?', paused ? 1 : 0, paused ? reason : null, this.now(), id);
      this.event({ projectId: id, type: paused ? 'project.paused' : 'project.resumed', message: paused ? `Paused: ${reason}` : `Resumed: ${reason}` });
    });
  }

  setProjectPlannedAt(id: string, at: number): void {
    this.run('UPDATE projects SET last_planned_at = ?, updated_at = ? WHERE id = ?', at, this.now(), id);
  }

  setFeedbackCursor(id: string, cursor: number): void {
    this.run('UPDATE projects SET feedback_cursor = ?, updated_at = ? WHERE id = ?', cursor, this.now(), id);
  }

  // ----------------------------------------------------------------- tasks

  private toTask(r: Row): Task {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      objective: r.objective,
      nonGoals: pj(r.non_goals, []),
      acceptanceCriteria: pj(r.acceptance, []),
      role: r.role,
      kind: r.kind,
      priority: r.priority,
      risk: r.risk,
      ownedPaths: pj(r.owned_paths, []),
      dependsOn: pj(r.depends_on, []),
      state: r.state,
      stateReason: r.state_reason ?? null,
      origin: r.origin,
      hypothesis: r.hypothesis ?? null,
      branch: r.branch ?? null,
      worktree: r.worktree ?? null,
      baseCommit: r.base_commit ?? null,
      headCommit: r.head_commit ?? null,
      prNumber: r.pr_number ?? null,
      prUrl: r.pr_url ?? null,
      attempts: r.attempts,
      repairCycles: r.repair_cycles,
      lastSessionId: r.last_session_id ?? null,
      leaseOwner: r.lease_owner ?? null,
      leaseExpiresAt: r.lease_expires_at ?? null,
      leaseGeneration: r.lease_generation,
      notes: pj(r.notes, []),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  createTask(input: NewTaskInput): Task {
    const now = this.now();
    return this.tx(() => {
      if (!this.getProject(input.projectId)) throw new StateError(`unknown project ${input.projectId}`);
      const id = this.nextId('T');
      const state = input.state ?? (input.origin === 'agent' ? 'proposed' : 'ready');
      const priority = Math.min(5, Math.max(1, Math.round(input.priority ?? 3)));
      this.run(
        `INSERT INTO tasks (id, project_id, title, objective, non_goals, acceptance, role, kind, priority, risk,
          owned_paths, depends_on, state, origin, hypothesis, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.title.trim().slice(0, 200),
        input.objective.trim(),
        j(input.nonGoals ?? []),
        j(input.acceptanceCriteria ?? []),
        input.role?.trim() || 'full-stack',
        input.kind ?? 'build',
        priority,
        input.risk ?? 'unknown',
        j(input.ownedPaths ?? []),
        j(input.dependsOn ?? []),
        state,
        input.origin,
        input.hypothesis ?? null,
        now,
        now,
      );
      this.event({ projectId: input.projectId, taskId: id, type: 'task.created', message: `${id} created (${state}): ${input.title}`, data: { origin: input.origin } });
      return this.getTask(id)!;
    });
  }

  getTask(id: string): Task | null {
    const r = this.get('SELECT * FROM tasks WHERE id = ?', id);
    return r ? this.toTask(r) : null;
  }

  listTasks(filter: { projectId?: string; states?: readonly TaskState[] } = {}): Task[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.states && filter.states.length) {
      where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
      params.push(...filter.states);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority ASC, created_at ASC`;
    return this.all(sql, ...params).map((r) => this.toTask(r));
  }

  private static readonly PATCHABLE: Record<string, string> = {
    title: 'title',
    objective: 'objective',
    role: 'role',
    priority: 'priority',
    risk: 'risk',
    stateReason: 'state_reason',
    branch: 'branch',
    worktree: 'worktree',
    baseCommit: 'base_commit',
    headCommit: 'head_commit',
    prNumber: 'pr_number',
    prUrl: 'pr_url',
    attempts: 'attempts',
    repairCycles: 'repair_cycles',
    lastSessionId: 'last_session_id',
    hypothesis: 'hypothesis',
  };
  private static readonly PATCHABLE_JSON: Record<string, string> = {
    nonGoals: 'non_goals',
    acceptanceCriteria: 'acceptance',
    ownedPaths: 'owned_paths',
    dependsOn: 'depends_on',
  };

  /** Update descriptive fields (not state or lease). */
  patchTask(id: string, patch: Partial<Task>): Task {
    const sets: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (Store.PATCHABLE[k]) {
        sets.push(`${Store.PATCHABLE[k]} = ?`);
        params.push(v ?? null);
      } else if (Store.PATCHABLE_JSON[k]) {
        sets.push(`${Store.PATCHABLE_JSON[k]} = ?`);
        params.push(j(v));
      } else {
        throw new StateError(`patchTask cannot set ${k}`);
      }
    }
    if (!sets.length) return this.getTask(id)!;
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.getTask(id)!;
  }

  /**
   * Move a task between states (unleased transitions only). Throws when the
   * current state is not in `from` or the transition is not allowed.
   */
  transition(id: string, from: TaskState | readonly TaskState[], to: TaskState, reason: string, patch: Partial<Task> = {}): Task {
    return this.tx(() => {
      const t = this.getTask(id);
      if (!t) throw new StateError(`unknown task ${id}`);
      const froms = Array.isArray(from) ? from : [from as TaskState];
      if (!froms.includes(t.state)) throw new StateError(`${id} is ${t.state}, expected ${froms.join('|')}`);
      if (t.state !== to && !TASK_TRANSITIONS[t.state].includes(to)) throw new StateError(`${id}: ${t.state} -> ${to} is not allowed`);
      if (t.leaseOwner) throw new StateError(`${id} is leased by ${t.leaseOwner}; use release()`);
      if (Object.keys(patch).length) this.patchTask(id, patch);
      this.run('UPDATE tasks SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?', to, reason, this.now(), id);
      if (t.state !== to) {
        this.event({ projectId: t.projectId, taskId: id, type: 'task.state', message: `${id}: ${t.state} -> ${to} (${reason})`, data: { from: t.state, to } });
      }
      return this.getTask(id)!;
    });
  }

  /**
   * Atomically claim an unleased task in one of `from` states, move it to `to`
   * and bump the fencing generation. Returns null if someone else won.
   */
  claim(id: string, from: readonly TaskState[], to: TaskState, owner: string, ttlMs: number): { task: Task; generation: number } | null {
    return this.tx(() => {
      const now = this.now();
      const placeholders = from.map(() => '?').join(',');
      const res = this.run(
        `UPDATE tasks SET state = ?, lease_owner = ?, lease_expires_at = ?, lease_generation = lease_generation + 1, updated_at = ?
         WHERE id = ? AND state IN (${placeholders}) AND lease_owner IS NULL`,
        to,
        owner,
        now + ttlMs,
        now,
        id,
        ...from,
      );
      if (Number(res.changes) !== 1) return null;
      const task = this.getTask(id)!;
      this.event({ projectId: task.projectId, taskId: id, type: 'task.claimed', message: `${id} -> ${to} claimed by ${owner} (gen ${task.leaseGeneration})`, data: { owner, generation: task.leaseGeneration } });
      return { task, generation: task.leaseGeneration };
    });
  }

  isLeaseValid(id: string, owner: string, generation: number): boolean {
    const r = this.get('SELECT lease_owner, lease_generation, lease_expires_at FROM tasks WHERE id = ?', id);
    return !!r && r.lease_owner === owner && r.lease_generation === generation && (r.lease_expires_at ?? 0) > this.now();
  }

  /** Extend a lease; false means the lease was lost (fenced out). */
  heartbeat(id: string, owner: string, generation: number, ttlMs: number): boolean {
    const now = this.now();
    const res = this.run(
      'UPDATE tasks SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?',
      now + ttlMs,
      id,
      owner,
      generation,
      now,
    );
    return Number(res.changes) === 1;
  }

  /**
   * Release a lease held by owner/generation and move the task to `to`.
   * Returns null (and changes nothing) if the caller no longer holds the lease.
   */
  release(id: string, owner: string, generation: number, to: TaskState, reason: string, patch: Partial<Task> = {}): Task | null {
    return this.tx(() => {
      const t = this.getTask(id);
      if (!t || t.leaseOwner !== owner || t.leaseGeneration !== generation) return null;
      if (t.state !== to && !TASK_TRANSITIONS[t.state].includes(to)) throw new StateError(`${id}: ${t.state} -> ${to} is not allowed`);
      if (Object.keys(patch).length) this.patchTask(id, patch);
      this.run('UPDATE tasks SET state = ?, state_reason = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?', to, reason, this.now(), id);
      this.event({ projectId: t.projectId, taskId: id, type: 'task.state', message: `${id}: ${t.state} -> ${to} (${reason})`, data: { from: t.state, to, owner } });
      return this.getTask(id)!;
    });
  }

  /**
   * Extend a lease even if it already expired, as long as the caller still owns
   * it (same owner and generation). Used for work that is provably alive, e.g.
   * after the machine slept longer than the lease TTL.
   */
  renewLease(id: string, owner: string, generation: number, ttlMs: number): boolean {
    const res = this.run(
      'UPDATE tasks SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND lease_generation = ?',
      this.now() + ttlMs,
      id,
      owner,
      generation,
    );
    return Number(res.changes) === 1;
  }

  /** Tasks whose lease expired (owner crashed, hung or the supervisor restarted). */
  expiredLeases(): Task[] {
    return this.all('SELECT * FROM tasks WHERE lease_owner IS NOT NULL AND lease_expires_at <= ?', this.now()).map((r) => this.toTask(r));
  }

  /** Leases held by owners for which `isStale(owner)` is true (e.g. previous supervisor boot). */
  leasesHeldBy(predicate: (owner: string) => boolean): Task[] {
    return this.all('SELECT * FROM tasks WHERE lease_owner IS NOT NULL')
      .map((r) => this.toTask(r))
      .filter((t) => predicate(t.leaseOwner!));
  }

  /** Forcefully drop an expired/stale lease and move the task to `to`. Fences the old owner. */
  breakLease(id: string, expectedOwner: string, to: TaskState, reason: string, patch: Partial<Task> = {}): Task | null {
    return this.tx(() => {
      const t = this.getTask(id);
      if (!t || t.leaseOwner !== expectedOwner) return null;
      if (t.state !== to && !TASK_TRANSITIONS[t.state].includes(to)) throw new StateError(`${id}: ${t.state} -> ${to} is not allowed`);
      if (Object.keys(patch).length) this.patchTask(id, patch);
      this.run(
        'UPDATE tasks SET state = ?, state_reason = ?, lease_owner = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1, updated_at = ? WHERE id = ?',
        to,
        reason,
        this.now(),
        id,
      );
      this.event({ projectId: t.projectId, taskId: id, type: 'task.lease_broken', message: `${id}: lease of ${expectedOwner} broken -> ${to} (${reason})`, data: { owner: expectedOwner } });
      return this.getTask(id)!;
    });
  }

  addNote(id: string, source: TaskNote['source'], text: string): void {
    this.tx(() => {
      const t = this.getTask(id);
      if (!t) return;
      const notes = [...t.notes, { at: this.now(), source, text: text.slice(0, 8000) }].slice(-40);
      this.run('UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?', j(notes), this.now(), id);
    });
  }

  // ------------------------------------------------------------------ runs

  private toRun(r: Row): Run {
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id ?? null,
      role: r.role,
      status: r.status,
      generation: r.generation,
      sessionId: r.session_id ?? null,
      resumedSessionId: r.resumed_session_id ?? null,
      pid: r.pid ?? null,
      cwd: r.cwd,
      startedAt: r.started_at,
      heartbeatAt: r.heartbeat_at,
      endedAt: r.ended_at ?? null,
      result: pj(r.result_json, null),
      resultText: r.result_text ?? null,
      error: r.error ?? null,
      costUsd: r.cost_usd ?? null,
      numTurns: r.num_turns ?? null,
      logPath: r.log_path ?? null,
    };
  }

  createRun(input: {
    projectId: string;
    taskId: string | null;
    role: RunRole;
    generation: number;
    tokenHash: string;
    cwd: string;
    sessionId: string | null;
    resumedSessionId?: string | null;
    logPath: string | null;
    id?: string;
  }): Run {
    const now = this.now();
    return this.tx(() => {
      const id = input.id ?? this.nextId('R');
      this.run(
        `INSERT INTO runs (id, project_id, task_id, role, status, generation, token_hash, session_id, resumed_session_id, cwd, started_at, heartbeat_at, log_path)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.taskId,
        input.role,
        input.generation,
        input.tokenHash,
        input.sessionId,
        input.resumedSessionId ?? null,
        input.cwd,
        now,
        now,
        input.logPath,
      );
      this.event({ projectId: input.projectId, taskId: input.taskId, runId: id, type: 'run.started', message: `${id} ${input.role} started${input.taskId ? ` for ${input.taskId}` : ''}` });
      return this.getRun(id)!;
    });
  }

  getRun(id: string): Run | null {
    const r = this.get('SELECT * FROM runs WHERE id = ?', id);
    return r ? this.toRun(r) : null;
  }

  runByTokenHash(hash: string): Run | null {
    const r = this.get('SELECT * FROM runs WHERE token_hash = ?', hash);
    return r ? this.toRun(r) : null;
  }

  listRuns(filter: { status?: RunStatus[]; taskId?: string; projectId?: string; role?: RunRole; limit?: number } = {}): Run[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.role) {
      where.push('role = ?');
      params.push(filter.role);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
    params.push(filter.limit ?? 200);
    return this.all(sql, ...params).map((r) => this.toRun(r));
  }

  touchRun(id: string, patch: { pid?: number | null; sessionId?: string | null } = {}): void {
    const sets = ['heartbeat_at = ?'];
    const params: any[] = [this.now()];
    if (patch.pid !== undefined) {
      sets.push('pid = ?');
      params.push(patch.pid);
    }
    if (patch.sessionId !== undefined) {
      sets.push('session_id = ?');
      params.push(patch.sessionId);
    }
    params.push(id);
    this.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  /** Finish a run once; later calls for the same run are ignored. Returns false if already finished. */
  finishRun(
    id: string,
    out: { status: Exclude<RunStatus, 'running'>; result?: unknown; resultText?: string | null; error?: string | null; costUsd?: number | null; numTurns?: number | null; sessionId?: string | null },
  ): boolean {
    return this.tx(() => {
      const res = this.run(
        `UPDATE runs SET status = ?, result_json = ?, result_text = ?, error = ?, cost_usd = ?, num_turns = ?,
           session_id = COALESCE(?, session_id), ended_at = ? WHERE id = ? AND status = 'running'`,
        out.status,
        out.result === undefined ? null : j(out.result),
        out.resultText ?? null,
        out.error ?? null,
        out.costUsd ?? null,
        out.numTurns ?? null,
        out.sessionId ?? null,
        this.now(),
        id,
      );
      if (Number(res.changes) !== 1) return false;
      const r = this.getRun(id)!;
      this.event({
        projectId: r.projectId,
        taskId: r.taskId,
        runId: id,
        type: 'run.ended',
        message: `${id} ${r.role} ${out.status}${out.error ? `: ${out.error.slice(0, 200)}` : ''}`,
        data: { status: out.status, costUsd: out.costUsd ?? null },
      });
      return true;
    });
  }

  // ------------------------------------------------------------- decisions

  private toDecision(r: Row): Decision {
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id ?? null,
      blockedTaskIds: pj(r.blocked_task_ids, []),
      kind: r.kind,
      revision: r.revision,
      status: r.status,
      question: r.question,
      why: r.why,
      options: pj(r.options, []),
      recommendation: r.recommendation ?? null,
      recommendationReason: r.recommendation_reason,
      allowComment: !!r.allow_comment,
      blocking: !!r.blocking,
      priority: r.priority,
      blockedSummary: r.blocked_summary,
      continuesSummary: r.continues_summary,
      links: pj(r.links, []),
      artifactRef: r.artifact_ref ?? null,
      createdBy: r.created_by,
      createdByRun: r.created_by_run ?? null,
      dedupeKey: r.dedupe_key ?? null,
      deferredUntil: r.deferred_until ?? null,
      answer: pj<DecisionAnswer | null>(r.answer_json, null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Create a decision card. If an open card with the same dedupe key exists,
   * the task is attached to it instead and `deduped` is true.
   */
  createDecision(input: NewDecisionInput): { decision: Decision; deduped: boolean } {
    const now = this.now();
    return this.tx(() => {
      const blocking = input.blocking ?? true;
      if (input.dedupeKey) {
        const existing = this.get("SELECT * FROM decisions WHERE project_id = ? AND dedupe_key = ? AND status = 'pending'", input.projectId, input.dedupeKey);
        if (existing) {
          const d = this.toDecision(existing);
          if (input.taskId && blocking && !d.blockedTaskIds.includes(input.taskId)) {
            const ids = [...d.blockedTaskIds, input.taskId];
            this.run('UPDATE decisions SET blocked_task_ids = ?, blocking = 1, updated_at = ? WHERE id = ?', j(ids), now, d.id);
          }
          this.event({ projectId: input.projectId, taskId: input.taskId ?? null, decisionId: d.id, type: 'decision.deduped', message: `Merged duplicate question into ${d.id}` });
          return { decision: this.getDecision(d.id)!, deduped: true };
        }
      }
      const options = (input.options ?? []).map((o) => ({ ...o, id: String(o.id).slice(0, 60), label: String(o.label).slice(0, 200) }));
      const ids = new Set(options.map((o) => o.id));
      if (ids.size !== options.length) throw new StateError('decision option ids must be unique');
      if (input.recommendation && !ids.has(input.recommendation)) throw new StateError(`recommendation ${input.recommendation} is not an option`);
      const id = this.nextId('D');
      this.run(
        `INSERT INTO decisions (id, project_id, task_id, blocked_task_ids, kind, revision, status, question, why, options, recommendation,
           recommendation_reason, allow_comment, blocking, priority, blocked_summary, continues_summary, links, artifact_ref,
           created_by, created_by_run, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.taskId ?? null,
        j(input.taskId && blocking ? [input.taskId] : []),
        input.kind,
        input.question.trim().slice(0, 1000),
        (input.why ?? '').slice(0, 4000),
        j(options),
        input.recommendation ?? null,
        (input.recommendationReason ?? '').slice(0, 2000),
        input.allowComment === false ? 0 : 1,
        blocking ? 1 : 0,
        input.priority ?? 'normal',
        (input.blockedSummary ?? '').slice(0, 1000),
        (input.continuesSummary ?? '').slice(0, 1000),
        j((input.links ?? []).filter((l) => /^https?:\/\//.test(l.url) || l.url.startsWith('/')).slice(0, 12)),
        input.artifactRef ?? null,
        input.createdBy,
        input.createdByRun ?? null,
        input.dedupeKey ?? null,
        now,
        now,
      );
      this.event({ projectId: input.projectId, taskId: input.taskId ?? null, decisionId: id, type: 'decision.created', message: `${id} (${input.kind}${blocking ? ', blocking' : ''}): ${input.question.slice(0, 160)}` });
      this.enqueue('notify', { decisionId: id });
      return { decision: this.getDecision(id)!, deduped: false };
    });
  }

  getDecision(id: string): Decision | null {
    const r = this.get('SELECT * FROM decisions WHERE id = ?', id);
    return r ? this.toDecision(r) : null;
  }

  listDecisions(filter: { projectId?: string; status?: Decision['status'][]; taskId?: string; limit?: number; newestFirst?: boolean } = {}): Decision[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter.taskId) {
      where.push("(task_id = ? OR EXISTS (SELECT 1 FROM json_each(blocked_task_ids) WHERE value = ?))");
      params.push(filter.taskId, filter.taskId);
    }
    const order = filter.newestFirst
      ? 'updated_at DESC, created_at DESC'
      : `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at ASC`;
    params.push(filter.limit ?? 500);
    return this.all(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`, ...params).map((r) =>
      this.toDecision(r),
    );
  }

  /**
   * Pending blocking decisions that a task waits on. Only blockedTaskIds count:
   * a task that asked a non-blocking question is not parked because another
   * task later merged a blocking duplicate into the same card.
   */
  pendingBlockingFor(taskId: string): Decision[] {
    return this.listDecisions({ taskId, status: ['pending'] }).filter((d) => d.blocking && d.blockedTaskIds.includes(taskId));
  }

  /**
   * Stop a task from waiting on a card. A card shared with other tasks stays
   * open for them; a card nobody else waits on is closed with `status`.
   */
  detachTaskFromDecisions(taskId: string, status: 'superseded' | 'cancelled', reason: string): void {
    this.tx(() => {
      for (const d of this.listDecisions({ taskId, status: ['pending'] })) {
        const others = d.blockedTaskIds.filter((id) => id !== taskId);
        const ownedElsewhere = d.taskId !== null && d.taskId !== taskId;
        if (others.length || ownedElsewhere) {
          this.run('UPDATE decisions SET blocked_task_ids = ?, updated_at = ? WHERE id = ?', j(others), this.now(), d.id);
          this.event({ projectId: d.projectId, taskId, decisionId: d.id, type: 'decision.detached', message: `${taskId} no longer waits on ${d.id} (${reason})` });
        } else {
          this.closeDecision(d.id, status, reason);
        }
      }
    });
  }

  /** Whether the founder rejected this exact revision (it must never merge as is). */
  founderRejected(taskId: string, headCommit: string): boolean {
    return !!this.get("SELECT 1 FROM reviews WHERE task_id = ? AND head_commit = ? AND verdict = 'human_request_changes' LIMIT 1", taskId, headCommit);
  }

  pendingDecisionCount(projectId?: string): number {
    const r = projectId
      ? this.get("SELECT COUNT(*) AS n FROM decisions WHERE status = 'pending' AND project_id = ?", projectId)
      : this.get("SELECT COUNT(*) AS n FROM decisions WHERE status = 'pending'");
    return Number(r?.n ?? 0);
  }

  /**
   * Change a pending card's content (new artifact, new options). Bumps the
   * revision so answers to the old version are rejected.
   */
  reviseDecision(id: string, patch: Partial<Pick<Decision, 'question' | 'why' | 'options' | 'recommendation' | 'recommendationReason' | 'links' | 'artifactRef' | 'priority' | 'blockedSummary' | 'continuesSummary'>>): Decision {
    return this.tx(() => {
      const d = this.getDecision(id);
      if (!d) throw new StateError(`unknown decision ${id}`);
      if (d.status !== 'pending') throw new StateError(`${id} is ${d.status}`);
      const next = { ...d, ...patch };
      if (next.recommendation && !next.options.some((o) => o.id === next.recommendation)) throw new StateError('recommendation is not an option');
      this.run(
        `UPDATE decisions SET revision = revision + 1, question = ?, why = ?, options = ?, recommendation = ?, recommendation_reason = ?,
           links = ?, artifact_ref = ?, priority = ?, blocked_summary = ?, continues_summary = ?, updated_at = ? WHERE id = ?`,
        next.question,
        next.why,
        j(next.options),
        next.recommendation,
        next.recommendationReason,
        j(next.links),
        next.artifactRef,
        next.priority,
        next.blockedSummary,
        next.continuesSummary,
        this.now(),
        id,
      );
      const out = this.getDecision(id)!;
      this.event({ projectId: d.projectId, taskId: d.taskId, decisionId: id, type: 'decision.revised', message: `${id} revised to r${out.revision}` });
      return out;
    });
  }

  /** Close a pending card without an answer (task cancelled, question obsolete). */
  closeDecision(id: string, status: 'superseded' | 'cancelled', reason: string): void {
    this.tx(() => {
      const d = this.getDecision(id);
      if (!d || d.status !== 'pending') return;
      this.run('UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?', status, this.now(), id);
      this.event({ projectId: d.projectId, taskId: d.taskId, decisionId: id, type: `decision.${status}`, message: `${id} ${status}: ${reason}` });
    });
  }

  deferDecision(id: string, until: number): Decision | null {
    this.run("UPDATE decisions SET deferred_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'", until, this.now(), id);
    return this.getDecision(id);
  }

  /**
   * Save a founder response. Transactional: validates the revision, stores the
   * answer, and enqueues delivery in the outbox in the same commit. Retries with
   * the same idempotency key return "duplicate" with the stored decision.
   */
  respond(input: DecisionResponseInput): DecisionResponseOutcome {
    return this.tx(() => {
      const key = String(input.idempotencyKey ?? '').slice(0, 200);
      if (key.length < 8) return { status: 'invalid', reason: 'idempotency key missing' };
      const prior = this.get('SELECT decision_id FROM decision_responses WHERE idempotency_key = ?', key);
      if (prior) {
        if (prior.decision_id !== input.decisionId) return { status: 'invalid', reason: 'idempotency key reused for another decision' };
        return { status: 'duplicate', decision: this.getDecision(input.decisionId)! };
      }
      const d = this.getDecision(input.decisionId);
      if (!d) return { status: 'not_found' };
      if (d.status !== 'pending') return { status: 'not_pending', decisionStatus: d.status };
      if (input.revision !== d.revision) return { status: 'stale_revision', currentRevision: d.revision };
      const optionId = input.optionId ?? null;
      const comment = input.comment?.trim() ? input.comment.trim().slice(0, 4000) : null;
      if (comment && !d.allowComment) return { status: 'invalid', reason: 'comments are not accepted on this card' };
      if (!optionId && !comment) return { status: 'invalid', reason: 'choose an option or write a comment' };
      if (optionId) {
        const opt = d.options.find((o) => o.id === optionId);
        if (!opt) return { status: 'invalid', reason: `unknown option ${optionId}` };
        if (opt.requiresComment && !comment) return { status: 'invalid', reason: `"${opt.label}" needs a comment` };
      } else if (d.options.length && d.kind === 'authorization') {
        return { status: 'invalid', reason: 'authorization cards need an explicit option' };
      }
      const now = this.now();
      const actor = String(input.actor || 'founder').slice(0, 100);
      this.run(
        'INSERT INTO decision_responses (decision_id, revision, option_id, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        d.id,
        d.revision,
        optionId,
        comment,
        actor,
        key,
        now,
      );
      const answer: DecisionAnswer = { optionId, comment, actor, revision: d.revision, at: now };
      this.run("UPDATE decisions SET status = 'answered', answer_json = ?, answered_at = ?, updated_at = ? WHERE id = ?", j(answer), now, now, d.id);
      this.enqueue('decision_answered', { decisionId: d.id, revision: d.revision });
      const label = optionId ? d.options.find((o) => o.id === optionId)?.label ?? optionId : 'comment';
      this.event({ projectId: d.projectId, taskId: d.taskId, decisionId: d.id, type: 'decision.answered', message: `${d.id} answered: ${label}${comment ? ` — "${comment.slice(0, 120)}"` : ''}`, data: { actor } });
      return { status: 'saved', decision: this.getDecision(d.id)! };
    });
  }

  // ---------------------------------------------------------------- outbox

  enqueue(kind: OutboxItem['kind'], payload: Record<string, unknown>): void {
    this.run('INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)', kind, j(payload), this.now());
  }

  pendingOutbox(limit = 50): OutboxItem[] {
    return this.all('SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY id ASC LIMIT ?', limit).map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: pj(r.payload, {}),
      createdAt: r.created_at,
      attempts: r.attempts,
      processedAt: r.processed_at ?? null,
    }));
  }

  completeOutbox(id: number): void {
    this.run('UPDATE outbox SET processed_at = ? WHERE id = ?', this.now(), id);
  }

  failOutbox(id: number, error: string, giveUpAfter = 20): void {
    this.run(
      'UPDATE outbox SET attempts = attempts + 1, last_error = ?, processed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END WHERE id = ?',
      error.slice(0, 1000),
      giveUpAfter,
      this.now(),
      id,
    );
  }

  // ---------------------------------------------------------------- events

  event(e: { projectId?: string | null; taskId?: string | null; runId?: string | null; decisionId?: string | null; type: string; message: string; data?: unknown }): void {
    this.run(
      'INSERT INTO events (project_id, task_id, run_id, decision_id, type, message, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      e.projectId ?? null,
      e.taskId ?? null,
      e.runId ?? null,
      e.decisionId ?? null,
      e.type,
      e.message.slice(0, 2000),
      e.data === undefined ? null : j(e.data),
      this.now(),
    );
  }

  listEvents(filter: { projectId?: string; taskId?: string; since?: number; types?: string[]; limit?: number } = {}): AuditEvent[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.since) {
      where.push('at >= ?');
      params.push(filter.since);
    }
    if (filter.types?.length) {
      where.push(`type IN (${filter.types.map(() => '?').join(',')})`);
      params.push(...filter.types);
    }
    params.push(filter.limit ?? 200);
    return this.all(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params).map((r) => ({
      id: r.id,
      projectId: r.project_id ?? null,
      taskId: r.task_id ?? null,
      runId: r.run_id ?? null,
      decisionId: r.decision_id ?? null,
      type: r.type,
      message: r.message,
      data: pj(r.data, null),
      at: r.at,
    }));
  }

  // -------------------------------------------------------- checks/reviews

  recordChecks(taskId: string, headCommit: string, scope: CheckRecord['scope'], results: CheckResult[]): void {
    this.tx(() => {
      for (const c of results) {
        this.run(
          'INSERT INTO checks (task_id, head_commit, scope, name, command, status, duration_ms, output_tail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          taskId,
          headCommit,
          scope,
          c.name,
          j(c.command),
          c.status,
          Math.round(c.durationMs),
          c.outputTail.slice(-6000),
          this.now(),
        );
      }
    });
  }

  /** Latest result per check name for a task head. */
  latestChecks(taskId: string, headCommit: string, scope: CheckRecord['scope']): CheckRecord[] {
    const rows = this.all('SELECT * FROM checks WHERE task_id = ? AND head_commit = ? AND scope = ? ORDER BY id DESC', taskId, headCommit, scope);
    const seen = new Set<string>();
    const out: CheckRecord[] = [];
    for (const r of rows) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      out.push({
        id: r.id,
        taskId: r.task_id,
        headCommit: r.head_commit,
        scope: r.scope,
        name: r.name,
        command: pj(r.command, []),
        status: r.status,
        durationMs: r.duration_ms,
        outputTail: r.output_tail,
        at: r.at,
      });
    }
    return out.reverse();
  }

  recordReview(r: Omit<ReviewRecord, 'id' | 'at'>): ReviewRecord {
    return this.tx(() => {
      const res = this.run(
        'INSERT INTO reviews (task_id, run_id, head_commit, verdict, risk, summary, findings, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        r.taskId,
        r.runId,
        r.headCommit,
        r.verdict,
        r.risk,
        r.summary.slice(0, 8000),
        j(r.findings),
        this.now(),
      );
      return this.reviewRow(this.get('SELECT * FROM reviews WHERE id = ?', Number(res.lastInsertRowid))!);
    });
  }

  private reviewRow(r: Row): ReviewRecord {
    return {
      id: r.id,
      taskId: r.task_id,
      runId: r.run_id ?? null,
      headCommit: r.head_commit,
      verdict: r.verdict,
      risk: r.risk,
      summary: r.summary,
      findings: pj(r.findings, []),
      at: r.at,
    };
  }

  latestReview(taskId: string, headCommit?: string): ReviewRecord | null {
    const r = headCommit
      ? this.get('SELECT * FROM reviews WHERE task_id = ? AND head_commit = ? ORDER BY id DESC LIMIT 1', taskId, headCommit)
      : this.get('SELECT * FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 1', taskId);
    return r ? this.reviewRow(r) : null;
  }

  // -------------------------------------------------------------- feedback

  /** Insert feedback once; returns false when the external id was already seen. */
  insertFeedback(f: FeedbackItem): boolean {
    const res = this.run(
      'INSERT OR IGNORE INTO feedback (external_id, project_id, task_id, source, author, body, kind, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.externalId,
      f.projectId,
      f.taskId,
      f.source,
      f.author,
      f.body.slice(0, 8000),
      f.kind,
      f.url,
      f.createdAt,
    );
    return Number(res.changes) === 1;
  }

  unprocessedFeedback(projectId: string): FeedbackItem[] {
    return this.all('SELECT * FROM feedback WHERE project_id = ? AND processed_at IS NULL ORDER BY created_at ASC', projectId).map((r) => ({
      externalId: r.external_id,
      projectId: r.project_id,
      taskId: r.task_id ?? null,
      source: r.source,
      author: r.author,
      body: r.body,
      kind: r.kind,
      url: r.url ?? null,
      createdAt: r.created_at,
    }));
  }

  markFeedbackProcessed(externalId: string): void {
    this.run('UPDATE feedback SET processed_at = ? WHERE external_id = ?', this.now(), externalId);
  }

  // ------------------------------------------------------------ inbox auth

  addPairingCode(codeHash: string, expiresAt: number): void {
    this.run('INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)', codeHash, expiresAt);
  }

  /** Single use: true only the first time an unexpired code is consumed. */
  consumePairingCode(codeHash: string): boolean {
    const res = this.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', this.now(), codeHash, this.now());
    return Number(res.changes) === 1;
  }

  createInboxSession(tokenHash: string, csrf: string, userAgent: string | null, ttlMs: number): void {
    const now = this.now();
    this.run(
      'INSERT INTO inbox_sessions (token_hash, csrf, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      tokenHash,
      csrf,
      userAgent?.slice(0, 300) ?? null,
      now,
      now,
      now + ttlMs,
    );
  }

  getInboxSession(tokenHash: string): { csrf: string; expiresAt: number } | null {
    const r = this.get('SELECT csrf, expires_at FROM inbox_sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, this.now());
    if (!r) return null;
    this.run('UPDATE inbox_sessions SET last_seen_at = ? WHERE token_hash = ?', this.now(), tokenHash);
    return { csrf: r.csrf, expiresAt: r.expires_at };
  }

  deleteInboxSession(tokenHash: string): void {
    this.run('DELETE FROM inbox_sessions WHERE token_hash = ?', tokenHash);
  }

  revokeAllInboxSessions(): void {
    this.run('DELETE FROM inbox_sessions');
  }

  // ------------------------------------------------------------ web push

  addPushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null): void {
    this.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      userAgent?.slice(0, 300) ?? null,
      this.now(),
    );
  }

  listPushSubscriptions(): { endpoint: string; keys: { p256dh: string; auth: string } }[] {
    return this.all('SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at').map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }

  removePushSubscription(endpoint: string): void {
    this.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }

  /** Record a delivery result; subscriptions failing 10 times in a row are dropped. */
  markPushResult(endpoint: string, ok: boolean): void {
    if (ok) this.run('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?', this.now(), endpoint);
    else {
      this.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?', endpoint);
      this.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND failures >= 10', endpoint);
    }
  }
}
