// SPDX-License-Identifier: MIT
// Domain model and module contracts for StayOn Autopilot.
// Every module imports from here; change these contracts deliberately.

// ---------------------------------------------------------------- projects

/** Merge/operation profile selected per project (see docs/policy.md). */
export type Profile = 'supervised' | 'balanced_autopilot' | 'integration_only' | 'pause';

export type RiskClass = 'low' | 'medium' | 'high' | 'unknown';

// ------------------------------------------------------------------- tasks

/**
 * Task lifecycle. "integrated" means merged into the target branch; it does
 * not mean released or validated with users.
 *
 *   proposed -> ready -> building -> checking -> review_ready -> reviewing
 *     -> merge_ready -> merging -> integrated
 *   building/reviewing/merging may yield to waiting_decision; failures go back
 *   to ready (repair) until the budget is spent, then exhausted.
 */
export type TaskState =
  | 'proposed'
  | 'ready'
  | 'building'
  | 'checking'
  | 'review_ready'
  | 'reviewing'
  | 'merge_ready'
  | 'merging'
  | 'waiting_decision'
  | 'integrated'
  | 'exhausted'
  | 'cancelled';

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['integrated', 'exhausted', 'cancelled'];

/** States in which some worker or supervisor job holds the task's lease. */
export const LEASED_TASK_STATES: readonly TaskState[] = ['building', 'checking', 'reviewing', 'merging'];

export type TaskKind = 'build' | 'experiment' | 'fix' | 'integration' | 'research' | 'content';

export type TaskOrigin = 'planner' | 'human' | 'agent' | 'feedback' | 'supervisor';

export interface Task {
  id: string; // "T-12", unique across the database
  projectId: string;
  title: string;
  objective: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  /** Free-form role hint chosen by the planner, e.g. "full-stack", "frontend". */
  role: string;
  kind: TaskKind;
  /** 1 (highest) .. 5 (lowest). */
  priority: number;
  risk: RiskClass;
  /** Path globs this task expects to own. ["**"] means exclusive (nothing else runs in parallel). */
  ownedPaths: string[];
  /** Task ids that must be integrated before this task may start. */
  dependsOn: string[];
  state: TaskState;
  stateReason: string | null;
  origin: TaskOrigin;
  /** Experiment hypothesis (under the project's exploration charter); null for ordinary tasks. */
  hypothesis: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** Builder runs started for this task (crashes and repairs both count). */
  attempts: number;
  /** Repair cycles consumed by failed checks, review change requests or merge conflicts. */
  repairCycles: number;
  /** Session id of the last builder run, used to resume with full context. */
  lastSessionId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  /** Fencing token: incremented on every claim; writes from older generations are rejected. */
  leaseGeneration: number;
  /** Durable context handed to the next run: summaries, review findings, decision answers. */
  notes: TaskNote[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskNote {
  at: number;
  source: 'builder' | 'reviewer' | 'checks' | 'decision' | 'merge' | 'feedback' | 'supervisor' | 'human';
  text: string;
}

export interface NewTaskInput {
  projectId: string;
  title: string;
  objective: string;
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  role?: string;
  kind?: TaskKind;
  priority?: number;
  risk?: RiskClass;
  ownedPaths?: string[];
  dependsOn?: string[];
  origin: TaskOrigin;
  hypothesis?: string | null;
  /** Initial state; defaults to "ready" for human/planner tasks and "proposed" for agent proposals. */
  state?: 'proposed' | 'ready';
}

// -------------------------------------------------------------------- runs

export type RunRole = 'planner' | 'builder' | 'reviewer';

export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'yielded' // ended early on purpose, e.g. waiting for a decision
  | 'usage_limited'
  | 'lost' // heartbeat/lease expired or supervisor restarted while it ran
  | 'killed'
  | 'timeout';

export interface Run {
  id: string; // "R-40"
  projectId: string;
  taskId: string | null; // null for planner runs
  role: RunRole;
  status: RunStatus;
  /** Lease generation of the task at claim time (fencing token). */
  generation: number;
  sessionId: string | null;
  resumedSessionId: string | null;
  pid: number | null;
  cwd: string;
  startedAt: number;
  heartbeatAt: number;
  endedAt: number | null;
  /** Parsed structured output (BuilderResult / ReviewerResult / PlannerResult) when present. */
  result: unknown;
  resultText: string | null;
  error: string | null;
  costUsd: number | null;
  numTurns: number | null;
  logPath: string | null;
}

/** Final structured output a builder must return. */
export interface BuilderResult {
  status: 'completed' | 'needs_decision' | 'blocked' | 'failed';
  summary: string;
  changes: string[];
  testsRun: { command: string; passed: boolean; notes?: string }[];
  acceptance: { criterion: string; met: boolean; evidence: string }[];
  limitations: string[];
  followUps: { title: string; objective: string }[];
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

/** Final structured output a reviewer must return. */
export interface ReviewerResult {
  verdict: 'approve' | 'request_changes' | 'needs_human';
  risk: RiskClass;
  summary: string;
  findings: ReviewFinding[];
  /** Required when verdict is needs_human: the exact question for the founder. */
  humanQuestion?: string;
}

export interface PlannedTask {
  /** Local key so new tasks can depend on each other within one plan. */
  key: string;
  title: string;
  objective: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  role: string;
  kind: TaskKind;
  priority: number;
  risk: RiskClass;
  ownedPaths: string[];
  /** Keys of tasks in this plan, or ids of existing tasks. */
  dependsOn: string[];
  hypothesis?: string;
}

export interface PlannerQuestion {
  question: string;
  why: string;
  options: DecisionOption[];
  recommendation: string;
  recommendationReason: string;
}

/** Final structured output a planner must return. */
export interface PlannerResult {
  summary: string;
  newTasks: PlannedTask[];
  /** Agent-proposed tasks (state "proposed") the planner accepts into the queue. */
  acceptTaskIds: string[];
  cancelTaskIds: string[];
  questions: PlannerQuestion[];
}

// --------------------------------------------------------------- decisions

/**
 * choice: product/design clarification. review: judge a concrete result.
 * authorization: permission for one exact operation on one exact artifact.
 * diagnostic: work could not progress; founder chooses how to proceed.
 * info: no answer required (digest-like), can be acknowledged.
 */
export type DecisionKind = 'choice' | 'review' | 'authorization' | 'diagnostic' | 'info';

export type DecisionStatus = 'pending' | 'answered' | 'superseded' | 'cancelled';

export type DecisionPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface DecisionOption {
  id: string;
  label: string;
  tradeoff?: string;
  /** Consequential options need an explicit tap; swipe shortcuts never select them. */
  consequential?: boolean;
  /** The founder must add a comment with this option (e.g. "Request changes"). */
  requiresComment?: boolean;
}

export interface DecisionLink {
  label: string;
  url: string;
}

export interface DecisionAnswer {
  optionId: string | null;
  comment: string | null;
  actor: string;
  revision: number;
  at: number;
}

export interface Decision {
  id: string; // "D-7"
  projectId: string;
  /** Task that raised the question (null for planner/project-level questions). */
  taskId: string | null;
  /** Every task that waits on this answer (dedupe can merge several). */
  blockedTaskIds: string[];
  kind: DecisionKind;
  revision: number;
  status: DecisionStatus;
  question: string;
  why: string;
  options: DecisionOption[];
  recommendation: string | null; // option id
  recommendationReason: string;
  allowComment: boolean;
  /** Blocking decisions stop the task; non-blocking ones let it continue with the recommendation. */
  blocking: boolean;
  priority: DecisionPriority;
  /** What waits on this answer, in plain words. */
  blockedSummary: string;
  /** What keeps going meanwhile, in plain words. */
  continuesSummary: string;
  links: DecisionLink[];
  /** Exact commit sha or artifact hash the question is about (review/authorization). */
  artifactRef: string | null;
  createdBy: 'agent' | 'planner' | 'reviewer' | 'supervisor';
  createdByRun: string | null;
  /** Identical open questions are merged on this key. */
  dedupeKey: string | null;
  deferredUntil: number | null;
  answer: DecisionAnswer | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewDecisionInput {
  projectId: string;
  taskId?: string | null;
  kind: DecisionKind;
  question: string;
  why?: string;
  options?: DecisionOption[];
  recommendation?: string | null;
  recommendationReason?: string;
  allowComment?: boolean;
  blocking?: boolean;
  priority?: DecisionPriority;
  blockedSummary?: string;
  continuesSummary?: string;
  links?: DecisionLink[];
  artifactRef?: string | null;
  createdBy: Decision['createdBy'];
  createdByRun?: string | null;
  dedupeKey?: string | null;
}

export interface DecisionResponseInput {
  decisionId: string;
  revision: number;
  optionId?: string | null;
  comment?: string | null;
  actor: string;
  idempotencyKey: string;
}

export type DecisionResponseOutcome =
  | { status: 'saved'; decision: Decision }
  | { status: 'duplicate'; decision: Decision }
  | { status: 'stale_revision'; currentRevision: number }
  | { status: 'not_pending'; decisionStatus: DecisionStatus }
  | { status: 'invalid'; reason: string }
  | { status: 'not_found' };

// ---------------------------------------------------------- checks/reviews

export type CheckStatus = 'passed' | 'failed' | 'error' | 'timeout' | 'skipped';

export interface CheckResult {
  name: string;
  command: string[];
  status: CheckStatus;
  durationMs: number;
  /** Last lines of combined output, redacted of obvious secrets. */
  outputTail: string;
}

export interface CheckRecord extends CheckResult {
  id: number;
  taskId: string;
  headCommit: string;
  /** "branch" = task branch alone, "integration" = merged with the current target. */
  scope: 'branch' | 'integration';
  at: number;
}

export interface ReviewRecord {
  id: number;
  taskId: string;
  runId: string | null;
  headCommit: string;
  verdict: ReviewerResult['verdict'] | 'human_approve' | 'human_request_changes';
  risk: RiskClass;
  summary: string;
  findings: ReviewFinding[];
  at: number;
}

// --------------------------------------------------------------- feedback

export interface FeedbackItem {
  /** Stable id from the source, e.g. "gh-review-comment-123". Used for dedupe. */
  externalId: string;
  projectId: string;
  taskId: string | null;
  source: 'github' | 'inbox';
  author: string;
  body: string;
  kind: 'comment' | 'change_request' | 'approval' | 'question';
  url: string | null;
  createdAt: number;
  /** For reviews: the commit the review was given on (GitHub review commit_id). */
  commitId?: string | null;
}

// ----------------------------------------------------------------- events

export interface AuditEvent {
  id: number;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  decisionId: string | null;
  type: string;
  message: string;
  data: unknown;
  at: number;
}

export interface OutboxItem {
  id: number;
  kind: 'decision_answered' | 'notify' | 'feedback_received';
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  processedAt: number | null;
}

// ------------------------------------------------------- module contracts

export type Clock = () => number;

/** What the supervisor asks a runner to execute. */
export interface RunSpec {
  runId: string;
  role: RunRole;
  cwd: string;
  prompt: string;
  appendSystemPrompt: string;
  /** Fresh session id to assign (uuid); ignored when resumeSessionId is set. */
  sessionId: string;
  /** Resume this session instead of starting fresh. */
  resumeSessionId?: string | null;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  permissionMode: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan';
  allowedTools: string[];
  disallowedTools: string[];
  /** Full --mcp-config object: { mcpServers: { name: { command, args, env } } }. The CLI runner writes it to a private file. */
  mcpConfig: Record<string, unknown> | null;
  /** JSON Schema for --json-schema structured output. */
  jsonSchema: Record<string, unknown> | null;
  /** Extra settings JSON passed with --settings (e.g. sandbox). */
  settings: Record<string, unknown> | null;
  /** --setting-sources value (e.g. ["project","local"]); null = Claude Code default. */
  settingSources: string[] | null;
  /** Extra readable directories (--add-dir), e.g. the founder's documents. */
  addDirs?: string[];
  maxTurns: number;
  timeoutMs: number;
  /** Kill the run if no stream event arrives for this long. */
  idleTimeoutMs: number;
  /** Extra environment; the runner strips API-key variables when auth is subscription. */
  env: Record<string, string>;
  logPath: string;
}

export type RunEvent =
  | { type: 'started'; pid: number }
  | { type: 'session'; sessionId: string }
  | { type: 'activity'; summary: string } // any stream event; used as heartbeat
  | { type: 'tool_use'; tool: string }
  | { type: 'text'; text: string };

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'usage_limited' | 'killed' | 'timeout';
  sessionId: string | null;
  structuredOutput: unknown;
  resultText: string | null;
  isError: boolean;
  terminalReason: string | null;
  /** Epoch ms when the usage limit resets, when the runner could parse it. */
  usageResetAt: number | null;
  costUsd: number | null;
  numTurns: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface RunHandle {
  runId: string;
  pid: number | null;
  done: Promise<RunOutcome>;
  kill(reason: string): void;
}

export interface Runner {
  start(spec: RunSpec, onEvent: (e: RunEvent) => void): RunHandle;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  /** "A" added, "M" modified, "D" deleted, "R" renamed. */
  status: string;
}

export interface DiffSummary {
  baseCommit: string;
  headCommit: string;
  files: DiffFile[];
  /** Unified diff, truncated to a size limit for prompts. */
  patch: string;
  truncated: boolean;
}

export type IntegrationStatus =
  | 'merged'
  | 'conflict'
  | 'checks_failed'
  | 'stale_head'
  | 'blocked_by_forge' // e.g. GitHub branch protection requires something we lack
  | 'error';

export interface IntegrationResult {
  status: IntegrationStatus;
  mergedCommit: string | null;
  checks: CheckResult[];
  details: string;
}

export interface PublishResult {
  prNumber: number | null;
  prUrl: string | null;
}

/** Git hosting adapter. LocalForge integrates in a private clone; GitHubForge uses PRs. */
export interface Forge {
  readonly kind: 'local' | 'github';
  /** Make sure the autopilot's private clone exists and is up to date. Returns the clone path. */
  prepare(): Promise<string>;
  /** Current commit of the target branch. */
  targetHead(): Promise<string>;
  createWorktree(taskId: string, slug: string): Promise<WorktreeInfo>;
  /** Reattach to an existing task branch (after a crash or for a repair run). */
  ensureWorktree(taskId: string, branch: string): Promise<WorktreeInfo>;
  removeWorktree(path: string): Promise<void>;
  headCommit(worktreePath: string): Promise<string>;
  /** Uncommitted changes present in a worktree (paths). */
  dirtyPaths(worktreePath: string): Promise<string[]>;
  diff(baseCommit: string, headCommit: string, maxPatchBytes?: number): Promise<DiffSummary>;
  /** Push the branch and open/update a PR (GitHub) or no-op (local). */
  publish(task: Task, body: string): Promise<PublishResult>;
  /**
   * Merge exactly expectedHead of the task branch into the target branch,
   * running integration checks on the merged tree before the target moves.
   */
  integrate(task: Task, expectedHead: string, runChecks: (cwd: string) => Promise<CheckResult[]>): Promise<IntegrationResult>;
  /** Post a comment on the task's PR (GitHub) or no-op (local). */
  comment(task: Task, body: string): Promise<void>;
  /** New feedback since a cursor (GitHub); local returns []. */
  pollFeedback(since: number, tasks: Task[]): Promise<FeedbackItem[]>;
}

export interface CheckRunner {
  /** Run the project's setup commands once per worktree (idempotent marker). */
  setup(cwd: string): Promise<CheckResult[]>;
  run(cwd: string): Promise<CheckResult[]>;
}

export interface Notifier {
  notify(n: { title: string; body: string; url?: string; priority?: DecisionPriority }): Promise<void>;
}

/** Handles tool calls that worker agents make through the MCP bridge. */
export interface AgentToolHandler {
  /** token = the run's bearer token; returns an HTTP-style status and JSON body. */
  callTool(token: string, name: string, args: unknown): Promise<{ status: number; body: unknown }>;
}

/** Operations the HTTP/inbox layer may ask the supervisor to perform. */
export interface SupervisorActions {
  /** Something changed (e.g. a decision was answered); run a scheduling pass soon. */
  wake(): void;
  pauseAll(reason: string): void;
  resumeAll(reason: string): void;
  pauseProject(projectId: string, reason: string): void;
  resumeProject(projectId: string, reason: string): void;
  addTask(input: { projectId: string; title: string; objective: string; acceptanceCriteria?: string[] }): Task;
  retryTask(taskId: string): Task;
  cancelTask(taskId: string): Task;
  /** The task branch's changes (base..head) for review on the phone; null when there is nothing to show. */
  taskDiff?(taskId: string): Promise<DiffSummary | null>;
}
