// SPDX-License-Identifier: MIT
// Tools that worker agents call while they run. Claude Code reaches them via
// the stdio MCP bridge (src/mcp/server.ts), which forwards every call to the
// supervisor's HTTP API, which hands it to AgentApi.callTool.
//
// Every call carries the run's bearer token. Calls from runs that lost their
// task lease are fenced off with 409, so a worker the supervisor replaced
// cannot keep acting on the task. Arguments come from a model: everything is
// validated and bounded before it reaches the store.
//
// Cards that agents file can never pass for the supervisor's own control cards
// (merge reviews, login/usage pauses, diagnostics), which the supervisor acts
// on when they are answered: agent cards are always stored as 'choice' cards,
// and their dedupe keys live in the 'agent:' namespace.
//
// Importing this module has no side effects: the MCP bridge imports
// TOOL_DEFINITIONS from it and must not open the database, so Store is a
// type-only import.

import type { Store } from './store.ts';
import type { AgentToolHandler, Decision, DecisionKind, DecisionLink, DecisionOption, DecisionPriority, Run, RunRole, Task, TaskKind } from './types.ts';
import { redactSecrets, sha256Hex } from './util.ts';

// ------------------------------------------------------------------ limits

/** Bounds for model-supplied arguments, shared by the JSON schemas and the validators. */
export const LIMITS = {
  question: 500,
  why: 2000,
  recommendationReason: 2000,
  minOptions: 2,
  maxOptions: 6,
  optionLabel: 120,
  optionTradeoff: 500,
  summary: 1000,
  links: 10,
  linkLabel: 120,
  url: 2000,
  title: 120,
  objective: 2000,
  criteria: 10,
  criterion: 500,
  role: 40,
  ownedPaths: 20,
  ownedPath: 200,
  hypothesis: 1000,
  progressNote: 1000,
} as const;

const OPTION_ID_RE = /^[a-z0-9_-]{1,40}$/;
const DEDUPE_KEY_RE = /^[a-z0-9:_-]{1,80}$/;
const DECISION_ID_RE = /^D-[0-9]{1,9}$/;

const DECISION_PRIORITIES: readonly DecisionPriority[] = ['low', 'normal', 'high', 'urgent'];
type AgentDecisionKind = Extract<DecisionKind, 'choice' | 'review'>;
const AGENT_DECISION_KINDS: readonly AgentDecisionKind[] = ['choice', 'review'];
type ProposalKind = Extract<TaskKind, 'build' | 'fix' | 'experiment' | 'research'>;
const PROPOSAL_KINDS: readonly ProposalKind[] = ['build', 'fix', 'experiment', 'research'];

export const DEFAULT_MAX_PROPOSALS_PER_RUN = 3;
/** Unanswered cards one run may have open at once (guards the founder's inbox against a looping agent). */
export const DEFAULT_MAX_OPEN_DECISIONS_PER_RUN = 5;

/**
 * Kind of every card an agent files, whichever kind it asked for. The
 * supervisor treats a 'review' card as its own merge-approval card: an
 * 'approve' answer re-verifies and merges the branch as it stands, any other
 * answer counts as "request changes" and spends a repair cycle, and pending
 * review cards are closed when the task is repaired or merged. An agent's
 * "please judge this result" question must instead resume the agent with the
 * answer, which is exactly how 'choice' cards are handled.
 */
export const AGENT_CARD_KIND: Extract<DecisionKind, 'choice'> = 'choice';

/**
 * Namespace of agent dedupe keys. The supervisor keys its own control cards
 * ('auth', 'usage', 'prepare:<project>', 'forge-blocked:<project>',
 * 'planner-failing:<project>', 'plan:<slug>', ...) and acts on those keys when
 * the cards are answered (e.g. 'auth' + 'resume' lifts the global pause). No
 * supervisor key starts with this prefix, so agents only ever merge with
 * each other.
 */
export const AGENT_DEDUPE_PREFIX = 'agent:';

/** The dedupe key stored for an agent-supplied key (null stays null). */
export function agentDedupeKey(key: string | null): string | null {
  return key === null ? null : `${AGENT_DEDUPE_PREFIX}${key}`;
}

// -------------------------------------------------------- tool definitions

export type AgentToolName = 'get_task_context' | 'request_decision' | 'check_decision' | 'propose_task' | 'report_progress';

/** JSON Schema object describing a tool's arguments (MCP inputSchema). */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: AgentToolName;
  /** Written for the model: when to use the tool, what it returns, its limits. */
  description: string;
  roles: readonly RunRole[];
  inputSchema: JsonSchema;
}

const OPTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: OPTION_ID_RE.source, description: 'Short stable id: lowercase letters, digits, "_" or "-" (e.g. "local_only").' },
    label: { type: 'string', maxLength: LIMITS.optionLabel, description: 'What the founder taps: a few plain words (e.g. "Keep data on the device").' },
    tradeoff: { type: 'string', maxLength: LIMITS.optionTradeoff, description: 'One sentence on the cost or consequence of choosing this option.' },
  },
  required: ['id', 'label'],
  additionalProperties: false,
};

const LINK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: LIMITS.linkLabel, description: 'Short link text.' },
    url: { type: 'string', maxLength: LIMITS.url, description: 'Absolute http:// or https:// URL.' },
  },
  required: ['label', 'url'],
  additionalProperties: false,
};

// Roles must match the MCP tools the supervisor allows each role (its
// allowedTools; planners run in dontAsk mode, where anything else is denied).
// Planners ask the founder through the `questions` field of their structured
// result, so they are offered report_progress only.
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'get_task_context',
    roles: ['builder', 'reviewer'],
    description: [
      'Get the authoritative brief for the task this run is working on.',
      'Returns the task (objective, non-goals, acceptance criteria, owned paths, dependencies, branch, base commit, attempt and repair counters),',
      'the latest task notes (earlier run summaries, check failures, review findings, founder answers),',
      "every decision card raised for this task with its status and the founder's answer,",
      'and the project charter with its protected paths (never edit them) and sensitive paths (changes there always get founder review).',
      'Call it at the start of a run and again after you are resumed. Takes no arguments.',
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'request_decision',
    roles: ['builder'],
    description: [
      "Ask the founder a question. It becomes a card in the founder's phone inbox; they answer by tapping an option or writing a comment, often hours later.",
      'Use it only for genuine product, design or scope decisions you cannot settle from the task, the documents or the code;',
      'never for things you can look up, test or cheaply change later, and never to ask permission to do the task itself.',
      'The founder sees only the card, so make it self-contained: one clear question, a short why,',
      'either no options (free-text answer) or 2-6 options (2-4 read best on a phone) with short labels and honest tradeoffs, and the option you recommend with your reason.',
      'blocking=true (the default) means correct work is impossible without the answer: the call returns at once and the answer never arrives during this run,',
      'so commit everything that does not depend on it and end your run with status needs_decision; you will be resumed with the answer.',
      'blocking=false means you continue now with your recommendation, keep it easy to change, and note the assumption in your summary.',
      'The answer only informs your work: it never merges, rejects or discards your branch by itself.',
      "priority 'urgent' is accepted only for blocking questions about security or data-loss risks.",
      'Give a stable dedupeKey when other tasks may need the same answer, so the questions merge into one card.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: LIMITS.question, description: 'The question exactly as the founder should read it; self-contained and answerable in seconds.' },
        why: { type: 'string', maxLength: LIMITS.why, description: 'Why this needs the founder and what depends on the answer, in plain words.' },
        options: {
          type: 'array',
          maxItems: LIMITS.maxOptions,
          items: OPTION_SCHEMA,
          description: 'Omit for a free-text answer, or give 2-6 mutually exclusive options with unique ids.',
        },
        recommendation: { type: 'string', description: 'Id of the option you recommend. Required when options are given.' },
        recommendationReason: { type: 'string', maxLength: LIMITS.recommendationReason, description: 'Why you recommend that option.' },
        blocking: {
          type: 'boolean',
          description: 'true (default): you cannot finish correctly without the answer. false: you proceed with your recommendation now.',
        },
        priority: {
          type: 'string',
          enum: [...DECISION_PRIORITIES],
          description: "Default 'normal'. Use 'high' when it blocks important work; 'urgent' only for blocking security or data-loss questions.",
        },
        kind: {
          type: 'string',
          enum: [...AGENT_DECISION_KINDS],
          description:
            "'choice' (default) for product, design or scope choices; 'review' when the founder should judge a concrete result you link to (preview, screenshot). Both are answered and delivered to you the same way.",
        },
        dedupeKey: {
          type: 'string',
          pattern: DEDUPE_KEY_RE.source,
          description: "Stable topic key: open agent questions with the same key merge into one card, e.g. 'auth:session-storage'.",
        },
        links: { type: 'array', maxItems: LIMITS.links, items: LINK_SCHEMA, description: 'Links that help the founder answer (preview URL, issue, design).' },
        blockedSummary: { type: 'string', maxLength: LIMITS.summary, description: 'What waits for the answer, in plain words.' },
        continuesSummary: { type: 'string', maxLength: LIMITS.summary, description: 'What keeps going meanwhile, in plain words.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_decision',
    roles: ['builder'],
    description: [
      'Look up a decision card of this project by id (for example D-7):',
      "its status (pending, answered, superseded or cancelled), its revision, and the founder's answer once answered (chosen option id and label, plus any comment).",
      'Use it to see whether an answer has arrived before you rely on an assumption.',
      'Do not poll in a loop: answers to blocking questions are delivered when the supervisor resumes you.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        decisionId: { type: 'string', pattern: DECISION_ID_RE.source, description: 'Decision id returned by request_decision or listed by get_task_context, e.g. "D-7".' },
      },
      required: ['decisionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_task',
    roles: ['builder', 'reviewer'],
    description: [
      'Propose a follow-up task you discovered while working: a bug outside your owned paths, missing tests, a needed refactor or an experiment worth running.',
      "It is created in state 'proposed'; the coordinator triages it and may schedule it later, possibly for another agent.",
      'Do not start it yourself and do not widen your current task instead.',
      'Keep it small and independently verifiable, with concrete acceptance criteria and enough context for an agent that never saw your session.',
      `Only a few proposals are accepted per run (${DEFAULT_MAX_PROPOSALS_PER_RUN} by default); list minor follow-ups in your final summary instead.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: LIMITS.title, description: "Short imperative title, e.g. 'Add retry to sync upload'." },
        objective: { type: 'string', maxLength: LIMITS.objective, description: 'What to achieve and why, with the context another agent needs.' },
        acceptanceCriteria: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.criteria,
          items: { type: 'string', maxLength: LIMITS.criterion },
          description: '1-10 concrete, verifiable outcomes.',
        },
        role: { type: 'string', maxLength: LIMITS.role, description: "Optional role hint such as 'frontend', 'backend' or 'full-stack'." },
        kind: { type: 'string', enum: [...PROPOSAL_KINDS], description: "'build' (default), 'fix', 'experiment' or 'research'." },
        priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 (most urgent) to 5 (nice to have); default 3.' },
        ownedPaths: {
          type: 'array',
          maxItems: LIMITS.ownedPaths,
          items: { type: 'string', maxLength: LIMITS.ownedPath },
          description: "Repository-relative path globs the task would change, e.g. ['src/sync/**'].",
        },
        hypothesis: { type: 'string', maxLength: LIMITS.hypothesis, description: 'For experiments: what you expect to learn or improve, and how to tell.' },
      },
      required: ['title', 'objective', 'acceptanceCriteria'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_progress',
    roles: ['builder', 'reviewer', 'planner'],
    description: [
      "Post a one- or two-sentence progress note to the founder's activity feed; it also tells the supervisor this run is alive.",
      'Use it after finishing a milestone or before a long step such as a full test suite.',
      'Do not use it for questions (use request_decision) or for your final report (that belongs in your final structured output).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', maxLength: LIMITS.progressNote, description: 'What you just finished or are starting, in one or two sentences.' },
      },
      required: ['note'],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES: readonly AgentToolName[] = TOOL_DEFINITIONS.map((d) => d.name);

export function toolsForRole(role: RunRole): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((d) => d.roles.includes(role));
}

/** role -> tools that role may call (and that the MCP bridge lists for it). */
export const ROLE_TOOLS: Readonly<Record<RunRole, readonly AgentToolName[]>> = {
  builder: toolsForRole('builder').map((d) => d.name),
  reviewer: toolsForRole('reviewer').map((d) => d.name),
  planner: toolsForRole('planner').map((d) => d.name),
};

export function isAgentToolName(name: unknown): name is AgentToolName {
  return typeof name === 'string' && (TOOL_NAMES as readonly string[]).includes(name);
}

/** Tools whose successful calls change state (and therefore trigger onChange). */
const STATE_CHANGING_TOOLS: ReadonlySet<AgentToolName> = new Set<AgentToolName>(['request_decision', 'propose_task', 'report_progress']);

// -------------------------------------------------------------- messages

export const LEASE_LOST_MESSAGE = 'Your lease on this task was lost (the supervisor reassigned it). Stop working, do not commit further, and end your run.';

const blockingInstructions = (decisionId: string) =>
  `Recorded as ${decisionId}. Do NOT wait for the answer. Finish and commit any work that does not depend on it, then end your run with status needs_decision; you will be resumed with the answer.`;

const NON_BLOCKING_INSTRUCTIONS = 'Recorded. Continue with your recommended option, keep it easy to change, and note the assumption in your summary.';

const BACKLOG_WARNING =
  "The founder's inbox is full: only ask questions that truly block; for reversible choices pick the recommendation and record the assumption.";

const PROPOSAL_NOTE = 'The coordinator will triage it; do not start it yourself.';

function guidanceFor(role: RunRole, task: Task, protectedPaths: readonly string[]): string {
  if (role === 'reviewer') {
    return [
      `You are reviewing ${task.id}. Do not modify, commit or push anything:`,
      'read the code, inspect the diff, run read-only commands or the tests, and give your verdict and findings in your final structured output.',
      'Use propose_task for follow-up work instead of fixing it yourself.',
    ].join(' ');
  }
  return [
    `Work only inside this worktree (branch ${task.branch ?? 'of this task'}).`,
    'Commit in small logical commits with clear messages; uncommitted work may be lost.',
    'Do not push, merge or open pull requests: the supervisor integrates your branch after checks and review.',
    `Never edit protected paths (${protectedPaths.length ? protectedPaths.join(', ') : 'none configured'}).`,
    'Stay within the objective and owned paths: use propose_task for other work and request_decision only for genuine founder decisions.',
  ].join(' ');
}

// -------------------------------------------------------------- validation

type Args = Record<string, unknown>;

/** A model sent arguments that do not fit the tool's contract (HTTP 400). */
export class InvalidArgsError extends Error {}

const isObj = (v: unknown): v is Args => typeof v === 'object' && v !== null && !Array.isArray(v);

// Tabs and line breaks are fine in prose; other control characters are not.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINE_BREAKS = /[\r\n]/;

interface TextRule {
  max: number;
  required?: boolean;
  /** Reject line breaks (titles, labels, paths). */
  singleLine?: boolean;
  pattern?: RegExp;
  /** Explains `pattern` in the error message. */
  hint?: string;
  oneOf?: readonly string[];
}

/** Validate one string: trimmed and bounded; an empty optional string counts as absent. */
function checkText(value: unknown, name: string, rule: TextRule): string | undefined {
  if (value === undefined || value === null) {
    if (rule.required) throw new InvalidArgsError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new InvalidArgsError(`${name} must be a string`);
  const s = value.trim();
  if (!s) {
    if (rule.required) throw new InvalidArgsError(`${name} must not be empty`);
    return undefined;
  }
  // For enums, listing the valid values is the most useful message.
  if (rule.oneOf && !rule.oneOf.includes(s)) throw new InvalidArgsError(`${name} must be one of: ${rule.oneOf.join(', ')} (got "${s.slice(0, 40)}")`);
  if (s.length > rule.max) throw new InvalidArgsError(`${name} is too long (${s.length} characters, max ${rule.max})`);
  if (CONTROL_CHARS.test(s)) throw new InvalidArgsError(`${name} contains control characters`);
  if (rule.singleLine && LINE_BREAKS.test(s)) throw new InvalidArgsError(`${name} must be a single line`);
  if (rule.pattern && !rule.pattern.test(s)) throw new InvalidArgsError(`${name} ${rule.hint ?? `must match ${rule.pattern.source}`}`);
  return s;
}

const optText = (o: Args, key: string, rule: TextRule, path = ''): string | undefined => checkText(o[key], `${path}${key}`, rule);

const reqText = (o: Args, key: string, rule: Omit<TextRule, 'required'>, path = ''): string =>
  checkText(o[key], `${path}${key}`, { ...rule, required: true }) as string;

function optBool(o: Args, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new InvalidArgsError(`${key} must be true or false`);
  return v;
}

function optInt(o: Args, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new InvalidArgsError(`${key} must be a whole number from ${min} to ${max}`);
  return v;
}

/** An optional array (absent = empty) with at most `max` entries. */
function optArray(o: Args, key: string, max: number): unknown[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InvalidArgsError(`${key} must be an array`);
  if (v.length > max) throw new InvalidArgsError(`${key} has too many entries (${v.length}, max ${max})`);
  return v;
}

function textList(o: Args, key: string, rule: { maxItems: number; minItems?: number; item: Omit<TextRule, 'required'> }): string[] {
  const min = rule.minItems ?? 0;
  if (min > 0 && (o[key] === undefined || o[key] === null)) throw new InvalidArgsError(`${key} is required`);
  const out = optArray(o, key, rule.maxItems).map((v, i) => checkText(v, `${key}[${i}]`, { ...rule.item, required: true }) as string);
  if (out.length < min) throw new InvalidArgsError(`${key} needs at least ${min} ${min === 1 ? 'entry' : 'entries'}`);
  return out;
}

function parseOptions(value: unknown): DecisionOption[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InvalidArgsError('options must be an array of {id, label, tradeoff?} objects');
  if (value.length === 1 || value.length > LIMITS.maxOptions) {
    throw new InvalidArgsError(`options must be omitted (free-text answer) or contain ${LIMITS.minOptions} to ${LIMITS.maxOptions} entries (got ${value.length})`);
  }
  const seen = new Set<string>();
  return value.map((raw, i): DecisionOption => {
    const path = `options[${i}].`;
    if (!isObj(raw)) throw new InvalidArgsError(`options[${i}] must be an object with id and label`);
    const id = reqText(raw, 'id', { max: 40, pattern: OPTION_ID_RE, hint: 'must be 1-40 characters of a-z, 0-9, "_" or "-" (e.g. "local_only")' }, path);
    if (seen.has(id)) throw new InvalidArgsError(`option id "${id}" is used more than once; option ids must be unique`);
    seen.add(id);
    const label = reqText(raw, 'label', { max: LIMITS.optionLabel, singleLine: true }, path);
    const tradeoff = optText(raw, 'tradeoff', { max: LIMITS.optionTradeoff }, path);
    return tradeoff ? { id, label, tradeoff } : { id, label };
  });
}

function parseLinks(o: Args): DecisionLink[] {
  return optArray(o, 'links', LIMITS.links).map((raw, i) => {
    const path = `links[${i}].`;
    if (!isObj(raw)) throw new InvalidArgsError(`links[${i}] must be an object with label and url`);
    const label = reqText(raw, 'label', { max: LIMITS.linkLabel, singleLine: true }, path);
    const url = reqText(raw, 'url', { max: LIMITS.url, singleLine: true }, path);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InvalidArgsError(`${path}url must be an absolute http(s) URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new InvalidArgsError(`${path}url must use http or https`);
    if (parsed.username || parsed.password) throw new InvalidArgsError(`${path}url must not contain credentials`);
    return { label, url: parsed.href };
  });
}

/** Repository-relative glob: no absolute, home-relative or parent-escaping paths. */
function isRepoGlob(p: string): boolean {
  return !p.startsWith('/') && !p.startsWith('~') && !p.includes('\\') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..');
}

export interface DecisionRequest {
  question: string;
  why: string;
  options: DecisionOption[];
  recommendation: string | null;
  recommendationReason: string;
  blocking: boolean;
  priority: DecisionPriority;
  /** Kind the agent asked for; the card is stored as AGENT_CARD_KIND either way. */
  kind: AgentDecisionKind;
  /** Key as the agent gave it; it is stored under AGENT_DEDUPE_PREFIX. */
  dedupeKey: string | null;
  links: DecisionLink[];
  blockedSummary: string;
  continuesSummary: string;
}

/**
 * Validate request_decision arguments. Planner questions are forced
 * non-blocking: planners are not offered the tool today (they ask through
 * their structured result), and this keeps the guarantee if they ever are.
 */
export function parseDecisionRequest(args: Args, role: RunRole): DecisionRequest {
  const question = reqText(args, 'question', { max: LIMITS.question });
  const why = optText(args, 'why', { max: LIMITS.why }) ?? '';
  const options = parseOptions(args.options);
  const recommendation = optText(args, 'recommendation', { max: 200, singleLine: true }) ?? null;
  if (options.length > 0 && !recommendation) {
    throw new InvalidArgsError('recommendation is required when options are given: set it to the id of the option you recommend');
  }
  if (recommendation && !options.some((o) => o.id === recommendation)) {
    throw new InvalidArgsError(
      options.length
        ? `recommendation "${recommendation}" must be one of the option ids: ${options.map((o) => o.id).join(', ')}`
        : 'recommendation needs options: give 2-6 options, or omit recommendation for a free-text question',
    );
  }
  const recommendationReason = optText(args, 'recommendationReason', { max: LIMITS.recommendationReason }) ?? '';
  const requestedBlocking = optBool(args, 'blocking');
  // Planner questions never stop work; builder questions block unless they say otherwise.
  const blocking = role === 'planner' ? false : (requestedBlocking ?? true);
  const priority = (optText(args, 'priority', { max: 10, oneOf: DECISION_PRIORITIES }) ?? 'normal') as DecisionPriority;
  if (priority === 'urgent' && !blocking) {
    throw new InvalidArgsError(
      role === 'planner'
        ? "priority 'urgent' is not available for planner questions (they never block); use 'high'"
        : "priority 'urgent' is only accepted for blocking questions about security or data-loss risks; use 'high', or set blocking to true",
    );
  }
  const kind = (optText(args, 'kind', { max: 10, oneOf: AGENT_DECISION_KINDS }) ?? 'choice') as AgentDecisionKind;
  const dedupeKey =
    optText(args, 'dedupeKey', { max: 80, pattern: DEDUPE_KEY_RE, hint: 'must be 1-80 characters of a-z, 0-9, ":", "_" or "-" (e.g. "auth:session-storage")' }) ?? null;
  return {
    question,
    why,
    options,
    recommendation,
    recommendationReason,
    blocking,
    priority,
    kind,
    dedupeKey,
    links: parseLinks(args),
    blockedSummary: optText(args, 'blockedSummary', { max: LIMITS.summary }) ?? '',
    continuesSummary: optText(args, 'continuesSummary', { max: LIMITS.summary }) ?? '',
  };
}

export interface TaskProposal {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  role: string | undefined;
  kind: ProposalKind;
  priority: number | undefined;
  ownedPaths: string[];
  hypothesis: string | null;
}

/** Validate propose_task arguments. */
export function parseTaskProposal(args: Args): TaskProposal {
  const title = reqText(args, 'title', { max: LIMITS.title, singleLine: true });
  const objective = reqText(args, 'objective', { max: LIMITS.objective });
  const acceptanceCriteria = textList(args, 'acceptanceCriteria', { minItems: 1, maxItems: LIMITS.criteria, item: { max: LIMITS.criterion } });
  const role = optText(args, 'role', { max: LIMITS.role, singleLine: true });
  const kind = (optText(args, 'kind', { max: 20, oneOf: PROPOSAL_KINDS }) ?? 'build') as ProposalKind;
  const priority = optInt(args, 'priority', 1, 5);
  const ownedPaths = textList(args, 'ownedPaths', { maxItems: LIMITS.ownedPaths, item: { max: LIMITS.ownedPath, singleLine: true } });
  const badPath = ownedPaths.find((p) => !isRepoGlob(p));
  if (badPath !== undefined) throw new InvalidArgsError(`ownedPaths entry "${badPath.slice(0, 80)}" must be a repository-relative glob such as "src/sync/**"`);
  const hypothesis = optText(args, 'hypothesis', { max: LIMITS.hypothesis }) ?? null;
  return { title, objective, acceptanceCriteria, role, kind, priority, ownedPaths, hypothesis };
}

/** Tool arguments as an object; absent arguments count as {}. */
function toArgs(args: unknown): Args {
  if (args === undefined || args === null) return {};
  if (!isObj(args)) throw new InvalidArgsError('arguments must be a JSON object');
  return args;
}

// ------------------------------------------------------------------- views

function answerView(d: Decision) {
  if (!d.answer) return null;
  const { optionId, comment, revision, at } = d.answer;
  const optionLabel = optionId ? (d.options.find((o) => o.id === optionId)?.label ?? null) : null;
  return { optionId, optionLabel, comment, revision, at };
}

const idNumber = (id: string): number => Number(id.slice(id.indexOf('-') + 1)) || 0;

// ------------------------------------------------------------------- api

export interface ToolResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ToolResponse => ({ status: 200, body });
const failure = (status: number, error: string, message: string): ToolResponse => ({ status, body: { error, message } });

const MAX_TOKEN_LENGTH = 1024;
const MAX_CONTEXT_NOTES = 20;
const MAX_CONTEXT_DECISIONS = 50;

export interface AgentApiOptions {
  /** Called after a tool changed state (new card, proposal, progress note), e.g. to wake the scheduler. */
  onChange?: () => void;
  /** Proposals accepted per run (default 3). */
  maxProposalsPerRun?: number;
  /** Unanswered cards a single run may have open at once (default 5). */
  maxOpenDecisionsPerRun?: number;
}

const countOption = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback);

export class AgentApi implements AgentToolHandler {
  private readonly store: Store;
  private readonly onChange: (() => void) | undefined;
  private readonly maxProposalsPerRun: number;
  private readonly maxOpenDecisionsPerRun: number;

  constructor(store: Store, opts: AgentApiOptions = {}) {
    this.store = store;
    this.onChange = opts.onChange;
    this.maxProposalsPerRun = countOption(opts.maxProposalsPerRun, DEFAULT_MAX_PROPOSALS_PER_RUN);
    this.maxOpenDecisionsPerRun = countOption(opts.maxOpenDecisionsPerRun, DEFAULT_MAX_OPEN_DECISIONS_PER_RUN);
  }

  /** The running run that owns this bearer token, or null (unknown token or finished run). */
  authenticate(token: string): Run | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const run = this.store.runByTokenHash(sha256Hex(token));
    return run && run.status === 'running' ? run : null;
  }

  /**
   * Authenticate, fence, authorize, validate and execute one tool call.
   * Never throws: every outcome is an HTTP-style status with a JSON body.
   */
  async callTool(token: string, name: string, args: unknown): Promise<ToolResponse> {
    const toolName = String(name).slice(0, 80);
    try {
      const run = this.authenticate(token);
      if (!run) {
        return failure(401, 'unauthorized', 'Unknown or finished run token: this run can no longer use autopilot tools. Finish your current step and end your run.');
      }
      // Fencing: a builder/reviewer whose lease was broken or reassigned must stop.
      if (run.taskId !== null && !this.store.isLeaseValid(run.taskId, run.id, run.generation)) {
        return failure(409, 'lease_lost', LEASE_LOST_MESSAGE);
      }
      const allowed = ROLE_TOOLS[run.role] ?? [];
      if (!isAgentToolName(name)) {
        return failure(404, 'unknown_tool', `Unknown tool "${toolName}". Tools available to ${run.role} runs: ${allowed.join(', ')}.`);
      }
      if (!allowed.includes(name)) {
        return failure(403, 'forbidden', `${name} is not available to ${run.role} runs. Tools you can use: ${allowed.join(', ')}.`);
      }
      const response = this.dispatch(run, name, toArgs(args));
      if (response.status === 200 && STATE_CHANGING_TOOLS.has(name)) this.notifyChange();
      return response;
    } catch (err) {
      if (err instanceof InvalidArgsError) return failure(400, 'invalid', `Invalid arguments for ${toolName}: ${err.message}.`);
      const detail = err instanceof Error ? err.message : String(err);
      return failure(500, 'internal', `Internal error while handling ${toolName}: ${detail.slice(0, 200)}`);
    }
  }

  private dispatch(run: Run, name: AgentToolName, args: Args): ToolResponse {
    switch (name) {
      case 'get_task_context':
        return this.taskContext(run);
      case 'request_decision':
        return this.requestDecision(run, args);
      case 'check_decision':
        return this.checkDecision(run, args);
      case 'propose_task':
        return this.proposeTask(run, args);
      case 'report_progress':
        return this.reportProgress(run, args);
    }
  }

  private notifyChange(): void {
    try {
      this.onChange?.();
    } catch {
      // A failing listener must not turn a recorded change into an error for the agent.
    }
  }

  // ------------------------------------------------------------ handlers

  private taskContext(run: Run): ToolResponse {
    const task = run.taskId ? this.store.getTask(run.taskId) : null;
    if (!task) return failure(404, 'not_found', 'This run is not attached to an existing task.');
    const project = this.store.getProject(run.projectId);
    const protectedPaths = project?.config?.integration?.protectedPaths ?? [];
    const decisions = this.store
      .listDecisions({ taskId: task.id, limit: MAX_CONTEXT_DECISIONS })
      .sort((a, b) => a.createdAt - b.createdAt || idNumber(a.id) - idNumber(b.id))
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        blocking: d.blocking,
        question: d.question,
        options: d.options,
        recommendation: d.recommendation,
        answer: answerView(d),
      }));
    return ok({
      task: {
        id: task.id,
        title: task.title,
        objective: task.objective,
        nonGoals: task.nonGoals,
        acceptanceCriteria: task.acceptanceCriteria,
        role: task.role,
        kind: task.kind,
        risk: task.risk,
        ownedPaths: task.ownedPaths,
        dependsOn: task.dependsOn,
        hypothesis: task.hypothesis,
        branch: task.branch,
        baseCommit: task.baseCommit,
        attempts: task.attempts,
        repairCycles: task.repairCycles,
      },
      notes: task.notes.slice(-MAX_CONTEXT_NOTES),
      decisions,
      project: {
        id: run.projectId,
        name: project?.name ?? run.projectId,
        charter: project?.config?.charter ?? '',
        protectedPaths,
        sensitivePaths: project?.config?.integration?.sensitivePaths ?? [],
      },
      guidance: guidanceFor(run.role, task, protectedPaths),
    });
  }

  private requestDecision(run: Run, args: Args): ToolResponse {
    const req = parseDecisionRequest(args, run.role);
    const maxPending = this.store.getProject(run.projectId)?.config?.inbox?.maxPendingDecisions;
    // The namespaced key is used for the merge check too, so a supervisor card
    // with the bare key neither absorbs this question nor exempts it from the cap.
    const dedupeKey = agentDedupeKey(req.dedupeKey);
    return this.store.tx(() => {
      const pending = this.store.listDecisions({ projectId: run.projectId, status: ['pending'], limit: 10_000 });
      const mergesIntoOpenCard = dedupeKey !== null && pending.some((d) => d.dedupeKey === dedupeKey);
      const openFromRun = pending.filter((d) => d.createdByRun === run.id).length;
      if (!mergesIntoOpenCard && openFromRun >= this.maxOpenDecisionsPerRun) {
        return failure(
          429,
          'limit_reached',
          `This run already has ${openFromRun} unanswered questions (limit ${this.maxOpenDecisionsPerRun}). Do not ask more: decide reversible details yourself and record the assumptions in your summary.`,
        );
      }
      const { decision, deduped } = this.store.createDecision({
        projectId: run.projectId,
        taskId: run.taskId,
        kind: AGENT_CARD_KIND,
        question: req.question,
        why: req.why,
        options: req.options,
        recommendation: req.recommendation,
        recommendationReason: req.recommendationReason,
        blocking: req.blocking,
        priority: req.priority,
        blockedSummary: req.blockedSummary,
        continuesSummary: req.continuesSummary,
        links: req.links,
        createdBy: run.role === 'planner' ? 'planner' : 'agent',
        createdByRun: run.id,
        dedupeKey,
      });
      const body: Record<string, unknown> = {
        decisionId: decision.id,
        deduped,
        status: 'pending',
        blocking: req.blocking,
        instructions: req.blocking ? blockingInstructions(decision.id) : NON_BLOCKING_INSTRUCTIONS,
      };
      // Counted after this card is filed: a card that fills the inbox already warns.
      if (typeof maxPending === 'number' && this.store.pendingDecisionCount(run.projectId) >= maxPending) body.backlogWarning = BACKLOG_WARNING;
      return ok(body);
    });
  }

  private checkDecision(run: Run, args: Args): ToolResponse {
    const raw = reqText(args, 'decisionId', { max: 40, singleLine: true });
    const id = raw.toUpperCase();
    if (!DECISION_ID_RE.test(id)) throw new InvalidArgsError(`decisionId must look like "D-7" (got "${raw.slice(0, 20)}")`);
    const d = this.store.getDecision(id);
    // Decisions of other projects are reported as missing, not as forbidden.
    if (!d || d.projectId !== run.projectId) return failure(404, 'not_found', `Decision ${id} does not exist in this project.`);
    return ok({ id: d.id, status: d.status, revision: d.revision, answer: answerView(d) });
  }

  private proposeTask(run: Run, args: Args): ToolResponse {
    const p = parseTaskProposal(args);
    return this.store.tx(() => {
      const already = this.proposalCount(run);
      if (already >= this.maxProposalsPerRun) {
        return failure(
          429,
          'limit_reached',
          `This run already proposed ${already} task(s) (limit ${this.maxProposalsPerRun}). List further follow-ups in your final summary instead.`,
        );
      }
      const task = this.store.createTask({
        projectId: run.projectId,
        title: p.title,
        objective: p.objective,
        acceptanceCriteria: p.acceptanceCriteria,
        role: p.role,
        kind: p.kind,
        priority: p.priority,
        ownedPaths: p.ownedPaths,
        hypothesis: p.hypothesis,
        origin: 'agent',
        state: 'proposed',
      });
      const from = run.taskId ? ` while working on ${run.taskId}` : '';
      this.store.addNote(task.id, run.role === 'reviewer' ? 'reviewer' : 'builder', `Proposed by ${run.id} (${run.role})${from}.`);
      this.store.event({
        projectId: run.projectId,
        taskId: task.id,
        runId: run.id,
        type: 'task.proposed',
        message: `${run.id} proposed ${task.id}: ${task.title}`,
        data: { fromTaskId: run.taskId, role: run.role },
      });
      return ok({ taskId: task.id, state: 'proposed', note: PROPOSAL_NOTE });
    });
  }

  /** Proposals this run already made, counted from the durable audit log. */
  private proposalCount(run: Run): number {
    return this.store
      .listEvents({ projectId: run.projectId, types: ['task.proposed'], since: run.startedAt, limit: 10_000 })
      .filter((e) => e.runId === run.id).length;
  }

  private reportProgress(run: Run, args: Args): ToolResponse {
    // Progress notes land in logs and the activity feed: strip obvious secrets.
    const note = redactSecrets(reqText(args, 'note', { max: LIMITS.progressNote }));
    this.store.tx(() => {
      this.store.event({ projectId: run.projectId, taskId: run.taskId, runId: run.id, type: 'run.progress', message: `${run.id}: ${note}` });
      this.store.touchRun(run.id);
    });
    return ok({ ok: true });
  }
}
