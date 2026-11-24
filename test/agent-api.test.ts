// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { defaultConfig } from '../src/config.ts';
import {
  AgentApi,
  InvalidArgsError,
  LEASE_LOST_MESSAGE,
  ROLE_TOOLS,
  TOOL_DEFINITIONS,
  agentDedupeKey,
  parseDecisionRequest,
  parseTaskProposal,
  toolsForRole,
} from '../src/agent-api.ts';
import type { NewDecisionInput, RunRole, RunSpec } from '../src/types.ts';
import { randomToken, sha256Hex } from '../src/util.ts';
import { approve, builderResult, commitFile, harness, type Harness } from './drills/harness.ts';

const LEASE_MS = 60_000;

function setup(opts: { maxProposalsPerRun?: number; maxOpenDecisionsPerRun?: number; maxPendingDecisions?: number; onChange?: () => void } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = Store.open(':memory:', clock.now);
  const cfg = defaultConfig('demo', 'Demo', '/tmp/demo');
  cfg.charter = 'Calm, offline-first habit tracker.';
  if (opts.maxPendingDecisions) cfg.inbox.maxPendingDecisions = opts.maxPendingDecisions;
  store.upsertProject(cfg);
  const counter = { changes: 0 };
  const api = new AgentApi(store, {
    onChange: opts.onChange ?? (() => void counter.changes++),
    maxProposalsPerRun: opts.maxProposalsPerRun,
    maxOpenDecisionsPerRun: opts.maxOpenDecisionsPerRun,
  });
  return { store, clock, api, counter };
}

/** A fresh task claimed by a new builder/reviewer run, the way the supervisor does it. */
function startTaskRun(store: Store, opts: { role?: 'builder' | 'reviewer'; projectId?: string } = {}) {
  const role = opts.role ?? 'builder';
  const projectId = opts.projectId ?? 'demo';
  const task = store.createTask({
    projectId,
    title: 'Onboarding',
    objective: 'Build the onboarding flow',
    origin: 'human',
    acceptanceCriteria: ['New users see a welcome screen'],
    ownedPaths: ['src/onboarding/**'],
  });
  const runId = store.nextId('R');
  const claim = store.claim(task.id, ['ready'], role === 'builder' ? 'building' : 'reviewing', runId, LEASE_MS);
  assert.ok(claim, 'task claimed');
  const token = randomToken();
  const run = store.createRun({ id: runId, projectId, taskId: task.id, role, generation: claim.generation, tokenHash: sha256Hex(token), cwd: '/tmp/wt', sessionId: null, logPath: null });
  return { task, run, token };
}

function startPlannerRun(store: Store, projectId = 'demo') {
  const token = randomToken();
  const run = store.createRun({ projectId, taskId: null, role: 'planner', generation: 0, tokenHash: sha256Hex(token), cwd: '/tmp/clone', sessionId: null, logPath: null });
  return { run, token };
}

const OPTIONS = [
  { id: 'sample', label: 'Show one sample habit', tradeoff: 'Faster start, but may feel prescriptive' },
  { id: 'blank', label: 'Start empty' },
];

const QUESTION = {
  question: 'What should a new user see first?',
  why: 'The empty state sets the tone of the whole app.',
  options: OPTIONS,
  recommendation: 'sample',
  recommendationReason: 'Shows the value immediately.',
};

/** Response body as a loose record, for assertions. */
const json = (res: { body: unknown }) => res.body as Record<string, any>;

test('only tokens of running runs authenticate', async () => {
  const { store, api } = setup();
  const { run, token } = startTaskRun(store);
  assert.equal(api.authenticate(token)?.id, run.id);
  assert.equal(api.authenticate('not-a-token'), null);
  assert.equal(api.authenticate(''), null);

  const bad = await api.callTool('not-a-token', 'get_task_context', {});
  assert.equal(bad.status, 401);
  assert.equal(json(bad).error, 'unauthorized');
  assert.equal((await api.callTool('', 'get_task_context', {})).status, 401);
  assert.equal((await api.callTool(token, 'get_task_context', {})).status, 200);

  store.finishRun(run.id, { status: 'succeeded' });
  assert.equal(api.authenticate(token), null);
  assert.equal((await api.callTool(token, 'report_progress', { note: 'still here' })).status, 401);
  assert.equal(store.listEvents({ types: ['run.progress'] }).length, 0, 'nothing recorded for a finished run');
});

test('builder calls are fenced by the task lease', async () => {
  const { store, clock, api } = setup();
  const { task, run, token } = startTaskRun(store);
  assert.equal((await api.callTool(token, 'get_task_context', {})).status, 200);

  // The supervisor breaks the lease (it believed the run hung) and requeues the task.
  assert.ok(store.breakLease(task.id, run.id, 'ready', 'heartbeat lost'));
  const calls: [string, unknown][] = [
    ['get_task_context', {}],
    ['report_progress', { note: 'still working' }],
    ['request_decision', QUESTION],
    ['no_such_tool', {}],
  ];
  for (const [name, args] of calls) {
    const res = await api.callTool(token, name, args);
    assert.equal(res.status, 409, name);
    assert.deepEqual(res.body, { error: 'lease_lost', message: LEASE_LOST_MESSAGE });
  }
  assert.equal(store.pendingDecisionCount('demo'), 0, 'a fenced run cannot file cards');

  // Another run now owns the task: the old token stays fenced, the new one works.
  const runId = store.nextId('R');
  const reclaim = store.claim(task.id, ['ready'], 'building', runId, LEASE_MS)!;
  const token2 = randomToken();
  store.createRun({ id: runId, projectId: 'demo', taskId: task.id, role: 'builder', generation: reclaim.generation, tokenHash: sha256Hex(token2), cwd: '/tmp/wt', sessionId: null, logPath: null });
  assert.equal((await api.callTool(token, 'get_task_context', {})).status, 409);
  assert.equal((await api.callTool(token2, 'get_task_context', {})).status, 200);

  // An expired lease fences too, before anyone breaks it.
  clock.advance(LEASE_MS + 1);
  assert.equal((await api.callTool(token2, 'report_progress', { note: 'late' })).status, 409);
});

test('reviewer calls are fenced by the task lease too', async () => {
  const { store, clock, api } = setup();
  const { task, run, token } = startTaskRun(store, { role: 'reviewer' });
  assert.equal((await api.callTool(token, 'get_task_context', {})).status, 200);

  // The supervisor gives up on the review run and queues the task for a new review.
  assert.ok(store.breakLease(task.id, run.id, 'review_ready', 'review run hung'));
  const proposal = { title: 'Add retry', objective: 'Retry uploads', acceptanceCriteria: ['Retries 3 times'] };
  const calls: [string, unknown][] = [
    ['get_task_context', {}],
    ['report_progress', { note: 'Still reading the diff' }],
    ['propose_task', proposal],
    ['request_decision', QUESTION],
  ];
  for (const [name, args] of calls) {
    const res = await api.callTool(token, name, args);
    assert.equal(res.status, 409, name);
    assert.deepEqual(res.body, { error: 'lease_lost', message: LEASE_LOST_MESSAGE });
  }
  assert.equal(store.listTasks({ states: ['proposed'] }).length, 0, 'a fenced reviewer cannot file proposals');
  assert.equal(store.listEvents({ types: ['run.progress'] }).length, 0, 'nor post progress');

  // A second review run owns the task now; the first stays fenced, and an expired lease fences the second.
  const runId = store.nextId('R');
  const reclaim = store.claim(task.id, ['review_ready'], 'reviewing', runId, LEASE_MS)!;
  const token2 = randomToken();
  store.createRun({ id: runId, projectId: 'demo', taskId: task.id, role: 'reviewer', generation: reclaim.generation, tokenHash: sha256Hex(token2), cwd: '/tmp/wt', sessionId: null, logPath: null });
  assert.equal((await api.callTool(token, 'get_task_context', {})).status, 409);
  assert.equal((await api.callTool(token2, 'propose_task', proposal)).status, 200);
  clock.advance(LEASE_MS + 1);
  assert.equal((await api.callTool(token2, 'get_task_context', {})).status, 409);
});

test('tools are limited to the roles that may use them', async () => {
  const { store, api } = setup();
  const reviewer = startTaskRun(store, { role: 'reviewer' });
  const planner = startPlannerRun(store);

  const forbidden = await api.callTool(reviewer.token, 'request_decision', QUESTION);
  assert.equal(forbidden.status, 403);
  assert.equal(json(forbidden).error, 'forbidden');
  assert.match(json(forbidden).message, /not available to reviewer runs/);
  assert.equal((await api.callTool(reviewer.token, 'check_decision', { decisionId: 'D-1' })).status, 403);
  assert.equal((await api.callTool(reviewer.token, 'get_task_context', {})).status, 200);
  assert.equal((await api.callTool(reviewer.token, 'report_progress', { note: 'Reading the diff' })).status, 200);

  // Planners only report progress: their questions go in the structured plan result,
  // and the supervisor's planner allow-list has no other autopilot tool.
  for (const [name, args] of [
    ['get_task_context', {}],
    ['propose_task', { title: 'x', objective: 'y', acceptanceCriteria: ['z'] }],
    ['request_decision', QUESTION],
    ['check_decision', { decisionId: 'D-1' }],
  ] as const) {
    const res = await api.callTool(planner.token, name, args);
    assert.equal(res.status, 403, name);
    assert.match(json(res).message, /Tools you can use: report_progress\./);
  }
  assert.equal((await api.callTool(planner.token, 'report_progress', { note: 'Reading the docs' })).status, 200);
  assert.equal(store.pendingDecisionCount('demo'), 0);
  assert.equal(store.listTasks({ states: ['proposed'] }).length, 0);

  for (const name of ['delete_everything', 'constructor', '__proto__', 'toString', '']) {
    const res = await api.callTool(planner.token, name, {});
    assert.equal(res.status, 404, name);
    assert.equal(json(res).error, 'unknown_tool');
  }

  // The exported map matches the definitions the MCP bridge lists.
  assert.deepEqual([...ROLE_TOOLS.builder].sort(), ['check_decision', 'get_task_context', 'propose_task', 'report_progress', 'request_decision']);
  assert.deepEqual([...ROLE_TOOLS.reviewer].sort(), ['get_task_context', 'propose_task', 'report_progress']);
  assert.deepEqual([...ROLE_TOOLS.planner].sort(), ['report_progress']);
  for (const def of TOOL_DEFINITIONS) {
    assert.equal(def.inputSchema.type, 'object', def.name);
    assert.ok(def.description.length > 80, `${def.name} has a real description`);
    for (const role of ['builder', 'reviewer', 'planner'] as const) {
      assert.equal(toolsForRole(role).includes(def), def.roles.includes(role), `${def.name} for ${role}`);
    }
  }
});

test('request_decision rejects malformed questions', async () => {
  const { store, api, counter } = setup();
  const { token } = startTaskRun(store);
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `opt${i}`, label: `Option ${i}` }));
  const cases: [unknown, RegExp][] = [
    [{}, /question is required/],
    [{ question: '   ' }, /question must not be empty/],
    [{ question: 'x'.repeat(501) }, /question is too long/],
    [{ question: 'Q?', options: OPTIONS }, /recommendation is required/],
    [{ question: 'Q?', options: OPTIONS, recommendation: 'other' }, /must be one of the option ids: sample, blank/],
    [{ question: 'Q?', recommendation: 'sample' }, /recommendation needs options/],
    [{ question: 'Q?', options: [{ id: 'Bad Id', label: 'A' }, { id: 'b', label: 'B' }], recommendation: 'b' }, /options\[0\]\.id must be 1-40 characters/],
    [{ question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], recommendation: 'a' }, /must be unique/],
    [{ question: 'Q?', options: [{ id: 'a', label: '' }, { id: 'b', label: 'B' }], recommendation: 'a' }, /options\[0\]\.label must not be empty/],
    [{ question: 'Q?', options: ['a', 'b'], recommendation: 'a' }, /options\[0\] must be an object/],
    [{ question: 'Q?', options: opts(7), recommendation: 'opt0' }, /2 to 6 entries \(got 7\)/],
    [{ question: 'Q?', options: opts(1), recommendation: 'opt0' }, /2 to 6 entries \(got 1\)/],
    [{ question: 'Q?', options: 'a or b' }, /options must be an array/],
    [{ ...QUESTION, blocking: false, priority: 'urgent' }, /'urgent' is only accepted for blocking questions/],
    [{ ...QUESTION, priority: 'asap' }, /priority must be one of: low, normal, high, urgent/],
    [{ ...QUESTION, blocking: 'yes' }, /blocking must be true or false/],
    [{ ...QUESTION, kind: 'authorization' }, /kind must be one of: choice, review/],
    [{ ...QUESTION, dedupeKey: 'Brand Color' }, /dedupeKey must be 1-80 characters/],
    [{ ...QUESTION, links: [{ label: 'Preview', url: 'javascript:alert(1)' }] }, /must use http or https/],
    [{ ...QUESTION, links: [{ label: 'Preview', url: 'https://user:pw@example.com/' }] }, /must not contain credentials/],
    [{ ...QUESTION, links: [{ label: 'Preview', url: '/relative' }] }, /absolute http\(s\) URL/],
    [{ ...QUESTION, links: Array(11).fill({ label: 'L', url: 'https://example.com' }) }, /links has too many entries/],
    [{ ...QUESTION, why: 'bad \u0000 byte' }, /why contains control characters/],
    ['Should I?', /arguments must be a JSON object/],
    [[QUESTION], /arguments must be a JSON object/],
  ];
  for (const [args, pattern] of cases) {
    const res = await api.callTool(token, 'request_decision', args);
    assert.equal(res.status, 400, JSON.stringify(args).slice(0, 100));
    assert.equal(json(res).error, 'invalid');
    assert.match(json(res).message, pattern);
  }
  assert.equal(store.pendingDecisionCount('demo'), 0, 'no card was filed');
  assert.equal(counter.changes, 0, 'failed calls do not signal a change');
});

test('request_decision files a blocking card for the builder task and merges duplicates', async () => {
  const { store, api, counter } = setup();
  const a = startTaskRun(store);
  const res = await api.callTool(a.token, 'request_decision', {
    ...QUESTION,
    dedupeKey: 'onboarding:empty-state',
    links: [{ label: 'Preview', url: 'https://preview.example.com/onboarding' }],
    blockedSummary: 'The welcome screen layout',
  });
  assert.equal(res.status, 200);
  const out = json(res);
  assert.equal(out.deduped, false);
  assert.equal(out.status, 'pending');
  assert.equal(out.blocking, true);
  assert.match(out.decisionId, /^D-\d+$/);
  assert.equal(
    out.instructions,
    `Recorded as ${out.decisionId}. Do NOT wait for the answer. Finish and commit any work that does not depend on it, then end your run with status needs_decision; you will be resumed with the answer.`,
  );
  assert.equal(out.backlogWarning, undefined);

  const card = store.getDecision(out.decisionId)!;
  assert.equal(card.taskId, a.task.id);
  assert.equal(card.blocking, true);
  assert.equal(card.kind, 'choice');
  assert.equal(card.priority, 'normal');
  assert.equal(card.createdBy, 'agent');
  assert.equal(card.createdByRun, a.run.id);
  assert.equal(card.recommendation, 'sample');
  assert.equal(card.dedupeKey, 'agent:onboarding:empty-state', 'agent keys are stored in their own namespace');
  assert.equal(card.blockedSummary, 'The welcome screen layout');
  assert.deepEqual(card.options, OPTIONS);
  assert.deepEqual(card.links, [{ label: 'Preview', url: 'https://preview.example.com/onboarding' }]);
  assert.deepEqual(store.pendingBlockingFor(a.task.id).map((d) => d.id), [card.id]);
  assert.equal(counter.changes, 1);

  // Another builder asks the same thing: one card now blocks both tasks.
  const b = startTaskRun(store);
  const dup = await api.callTool(b.token, 'request_decision', { ...QUESTION, question: 'Empty state for new users?', dedupeKey: 'onboarding:empty-state' });
  assert.equal(dup.status, 200);
  assert.equal(json(dup).deduped, true);
  assert.equal(json(dup).decisionId, card.id);
  assert.deepEqual(store.getDecision(card.id)!.blockedTaskIds.sort(), [a.task.id, b.task.id].sort());
  assert.equal(store.pendingDecisionCount('demo'), 1);

  // 'urgent' is accepted for a blocking question.
  const urgent = await api.callTool(b.token, 'request_decision', {
    question: 'A dev key was committed. Rotate it before continuing?',
    options: [
      { id: 'rotate', label: 'Rotate now' },
      { id: 'later', label: 'Rotate after the demo' },
    ],
    recommendation: 'rotate',
    priority: 'urgent',
  });
  assert.equal(urgent.status, 200);
  assert.equal(store.getDecision(json(urgent).decisionId)!.priority, 'urgent');
  assert.equal(counter.changes, 3);
});

/** A control card the way the supervisor files it (login, usage, repository, forge or planner trouble). */
const supervisorCard = (dedupeKey: string): NewDecisionInput => ({
  projectId: 'demo',
  kind: 'diagnostic',
  question: `Supervisor card ${dedupeKey}`,
  options: [{ id: 'resume', label: 'I fixed it — resume' }],
  recommendation: 'resume',
  blocking: false,
  priority: 'urgent',
  createdBy: 'supervisor',
  dedupeKey,
});

// Keys the supervisor files its own cards under and acts on when they are answered.
const SUPERVISOR_KEYS = ['auth', 'usage', 'prepare:demo', 'forge-blocked:demo', 'planner-failing:demo', 'plan:which-sign-in-provider'];

test('agent dedupe keys never meet the keys of supervisor control cards', async () => {
  const { store, api } = setup();
  const signIn = {
    question: 'Which sign-in provider should we use?',
    options: [
      { id: 'resume', label: 'Email magic link' },
      { id: 'google', label: 'Google' },
    ],
    recommendation: 'resume',
    blocking: false,
  };
  assert.equal(agentDedupeKey(null), null);

  // Agent first: the supervisor's control card is still filed as its own card.
  for (const key of SUPERVISOR_KEYS) {
    const { token } = startTaskRun(store);
    const asked = await api.callTool(token, 'request_decision', { ...signIn, dedupeKey: key });
    assert.equal(asked.status, 200, key);
    assert.equal(json(asked).deduped, false, key);
    const agentCard = store.getDecision(json(asked).decisionId)!;
    assert.equal(agentCard.dedupeKey, `agent:${key}`);
    const control = store.createDecision(supervisorCard(key));
    assert.equal(control.deduped, false, `the supervisor's ${key} card is not merged into the agent's question`);
    assert.equal(control.decision.question, `Supervisor card ${key}`);
    assert.equal(control.decision.dedupeKey, key);
  }

  // Supervisor first: an agent question with the same bare key gets its own card.
  const fresh = setup();
  const control = fresh.store.createDecision(supervisorCard('auth')).decision;
  const { token } = startTaskRun(fresh.store);
  const asked = await fresh.api.callTool(token, 'request_decision', { ...signIn, dedupeKey: 'auth' });
  assert.equal(json(asked).deduped, false);
  assert.notEqual(json(asked).decisionId, control.id);
  assert.deepEqual(fresh.store.getDecision(control.id)!.options.map((o) => o.id), ['resume'], 'control card untouched');

  // Agents still merge with each other on the same key.
  const other = startTaskRun(fresh.store);
  const dup = await fresh.api.callTool(other.token, 'request_decision', { ...signIn, question: 'Sign-in provider?', dedupeKey: 'auth' });
  assert.equal(json(dup).deduped, true);
  assert.equal(json(dup).decisionId, json(asked).decisionId);
});

test('a key shared with a supervisor card does not lift the per-run question cap', async () => {
  const { store, api } = setup({ maxOpenDecisionsPerRun: 1 });
  store.createDecision(supervisorCard('usage'));
  const { token } = startTaskRun(store);
  assert.equal((await api.callTool(token, 'request_decision', { question: 'First?', blocking: false })).status, 200);
  const capped = await api.callTool(token, 'request_decision', { question: 'Second?', blocking: false, dedupeKey: 'usage' });
  assert.equal(capped.status, 429, 'the bare key matches only the supervisor card, so this is a new question');
  assert.equal(store.pendingDecisionCount('demo'), 2);
});

test("a 'review' request is filed as a choice card the supervisor answers back to the agent", async () => {
  const { store, api } = setup();
  const { task, token } = startTaskRun(store);
  const res = await api.callTool(token, 'request_decision', {
    question: 'Does the onboarding preview look right before I build the rest?',
    kind: 'review',
    options: [
      { id: 'approve', label: 'Looks good' },
      { id: 'changes', label: 'Change it' },
    ],
    recommendation: 'approve',
    links: [{ label: 'Preview', url: 'https://preview.example.com/onboarding' }],
  });
  assert.equal(res.status, 200);
  const card = store.getDecision(json(res).decisionId)!;
  // A stored 'review' card would be taken for the supervisor's merge approval of the branch head.
  assert.equal(card.kind, 'choice');
  assert.equal(card.createdBy, 'agent');
  assert.equal(card.artifactRef, null);
  assert.deepEqual(store.pendingBlockingFor(task.id).map((d) => d.id), [card.id]);
  assert.equal(json(await api.callTool(token, 'get_task_context', {})).decisions[0].kind, 'choice');
  assert.equal(parseDecisionRequest({ question: 'Q?', kind: 'review' }, 'builder').kind, 'review', 'the requested kind is still validated and reported');
});

test('builders may ask non-blocking questions; planner questions never block', async () => {
  const { store, api } = setup();
  const builder = startTaskRun(store);
  const soft = await api.callTool(builder.token, 'request_decision', { question: 'Which accent colour do you prefer?', blocking: false });
  assert.equal(soft.status, 200);
  assert.equal(json(soft).blocking, false);
  assert.equal(json(soft).instructions, 'Recorded. Continue with your recommended option, keep it easy to change, and note the assumption in your summary.');
  const softCard = store.getDecision(json(soft).decisionId)!;
  assert.equal(softCard.blocking, false);
  assert.equal(softCard.taskId, builder.task.id);
  assert.deepEqual(softCard.options, []);
  assert.equal(store.pendingBlockingFor(builder.task.id).length, 0);

  // Planners are not offered the tool (see the role test); should they ever be, their questions cannot block.
  assert.equal(parseDecisionRequest({ ...QUESTION, blocking: true }, 'planner').blocking, false);
  assert.throws(() => parseDecisionRequest({ ...QUESTION, priority: 'urgent' }, 'planner'), /not available for planner questions/);
});

test('request_decision warns about a full inbox and caps open questions per run', async () => {
  const { store, api } = setup({ maxPendingDecisions: 2, maxOpenDecisionsPerRun: 3 });
  const builder = startTaskRun(store);
  const ask = (n: number, extra: Record<string, unknown> = {}) => api.callTool(builder.token, 'request_decision', { question: `Question ${n}?`, blocking: false, ...extra });

  const first = await ask(1, { dedupeKey: 'topic:one' });
  assert.equal(first.status, 200);
  assert.equal(json(first).backlogWarning, undefined);
  const second = await ask(2);
  assert.equal(
    json(second).backlogWarning,
    "The founder's inbox is full: only ask questions that truly block; for reversible choices pick the recommendation and record the assumption.",
  );
  assert.equal((await ask(3)).status, 200);

  const capped = await ask(4);
  assert.equal(capped.status, 429);
  assert.equal(json(capped).error, 'limit_reached');
  // A question that merges into an open card adds nothing and is still accepted.
  const merged = await ask(5, { dedupeKey: 'topic:one' });
  assert.equal(merged.status, 200);
  assert.equal(json(merged).deduped, true);
  // Once the founder answers one, the run may ask again.
  const answered = store.respond({ decisionId: json(first).decisionId, revision: 1, comment: 'Keep it simple', actor: 'founder', idempotencyKey: 'key-0000001' });
  assert.equal(answered.status, 'saved');
  assert.equal((await ask(6)).status, 200);
  assert.equal(store.pendingDecisionCount('demo'), 3);
});

test('check_decision reports status and answer, only within the project', async () => {
  const { store, api, counter } = setup();
  store.upsertProject(defaultConfig('other', 'Other', '/tmp/other'));
  const { token } = startTaskRun(store);
  const asked = json(await api.callTool(token, 'request_decision', QUESTION));
  const changes = counter.changes;

  const pending = await api.callTool(token, 'check_decision', { decisionId: asked.decisionId });
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.body, { id: asked.decisionId, status: 'pending', revision: 1, answer: null });

  store.respond({ decisionId: asked.decisionId, revision: 1, optionId: 'blank', comment: 'Keep it calm', actor: 'founder', idempotencyKey: 'key-0000002' });
  const answered = json(await api.callTool(token, 'check_decision', { decisionId: asked.decisionId.toLowerCase() }));
  assert.equal(answered.id, asked.decisionId);
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer.optionId, 'blank');
  assert.equal(answered.answer.optionLabel, 'Start empty');
  assert.equal(answered.answer.comment, 'Keep it calm');
  assert.equal(answered.answer.actor, undefined, 'who answered is not exposed to agents');
  assert.equal(counter.changes, changes, 'checking is not a change');

  const foreign = store.createDecision({ projectId: 'other', kind: 'choice', question: 'Other project internals?', createdBy: 'supervisor' }).decision;
  const denied = await api.callTool(token, 'check_decision', { decisionId: foreign.id });
  assert.equal(denied.status, 404);
  assert.equal(json(denied).error, 'not_found');
  assert.doesNotMatch(JSON.stringify(denied.body), /internals/);

  assert.equal((await api.callTool(token, 'check_decision', { decisionId: 'D-999' })).status, 404);
  assert.equal((await api.callTool(token, 'check_decision', { decisionId: 'T-1' })).status, 400);
  assert.equal((await api.callTool(token, 'check_decision', {})).status, 400);

  // Planners read the decisions in their prompt instead.
  const planner = startPlannerRun(store);
  assert.equal((await api.callTool(planner.token, 'check_decision', { decisionId: asked.decisionId })).status, 403);
});

test('propose_task files proposed tasks up to the per-run limit', async () => {
  const { store, api, counter } = setup();
  const { run, token, task: current } = startTaskRun(store);
  const proposal = {
    title: 'Add retry to sync upload',
    objective: 'Uploads fail on flaky networks; retry them with backoff.',
    acceptanceCriteria: ['A failed upload is retried 3 times', 'Tests cover the retry path'],
    kind: 'fix',
    priority: 2,
    ownedPaths: ['src/sync/**'],
  };
  const res = await api.callTool(token, 'propose_task', proposal);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(json(res)).sort(), ['note', 'state', 'taskId']);
  assert.equal(json(res).state, 'proposed');
  assert.equal(json(res).note, 'The coordinator will triage it; do not start it yourself.');

  const created = store.getTask(json(res).taskId)!;
  assert.equal(created.state, 'proposed');
  assert.equal(created.origin, 'agent');
  assert.equal(created.kind, 'fix');
  assert.equal(created.priority, 2);
  assert.deepEqual(created.ownedPaths, ['src/sync/**']);
  assert.deepEqual(created.acceptanceCriteria, proposal.acceptanceCriteria);
  assert.match(created.notes[0].text, new RegExp(`${run.id}.*${current.id}`));
  const events = store.listEvents({ types: ['task.proposed'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, run.id);
  assert.equal(events[0].taskId, created.id);
  assert.equal(counter.changes, 1);

  for (const title of ['Follow-up 2', 'Follow-up 3']) assert.equal((await api.callTool(token, 'propose_task', { ...proposal, title })).status, 200);
  const over = await api.callTool(token, 'propose_task', { ...proposal, title: 'One too many' });
  assert.equal(over.status, 429);
  assert.equal(json(over).error, 'limit_reached');
  assert.equal(store.listTasks({ states: ['proposed'] }).length, 3);
  assert.equal(counter.changes, 3);

  // The limit is per run: a reviewer run may still propose.
  const reviewer = startTaskRun(store, { role: 'reviewer' });
  const fromReviewer = await api.callTool(reviewer.token, 'propose_task', { ...proposal, title: 'Reviewer follow-up' });
  assert.equal(fromReviewer.status, 200);
  assert.equal(store.getTask(json(fromReviewer).taskId)!.notes[0].source, 'reviewer');
});

test('propose_task honours a custom limit and validates the proposal', async () => {
  const { store, api } = setup({ maxProposalsPerRun: 1 });
  const { token } = startTaskRun(store);
  const base = { title: 'Add retry', objective: 'Retry uploads', acceptanceCriteria: ['Retries 3 times'] };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...base, title: undefined }, /title is required/],
    [{ ...base, title: 'x'.repeat(121) }, /title is too long/],
    [{ ...base, title: 'Two\nlines' }, /title must be a single line/],
    [{ ...base, objective: 'x'.repeat(2001) }, /objective is too long/],
    [{ ...base, acceptanceCriteria: undefined }, /acceptanceCriteria is required/],
    [{ ...base, acceptanceCriteria: [] }, /acceptanceCriteria needs at least 1 entry/],
    [{ ...base, acceptanceCriteria: Array(11).fill('ok') }, /acceptanceCriteria has too many entries/],
    [{ ...base, acceptanceCriteria: ['ok', 42] }, /acceptanceCriteria\[1\] must be a string/],
    [{ ...base, kind: 'integration' }, /kind must be one of: build, fix, experiment, research/],
    [{ ...base, priority: 0 }, /priority must be a whole number from 1 to 5/],
    [{ ...base, priority: 2.5 }, /priority must be a whole number/],
    [{ ...base, ownedPaths: ['../outside/**'] }, /repository-relative glob/],
    [{ ...base, ownedPaths: ['/etc/**'] }, /repository-relative glob/],
    [{ ...base, ownedPaths: 'src/**' }, /ownedPaths must be an array/],
  ];
  for (const [args, pattern] of cases) {
    const res = await api.callTool(token, 'propose_task', args);
    assert.equal(res.status, 400, JSON.stringify(args).slice(0, 100));
    assert.match(json(res).message, pattern);
  }
  assert.equal(store.listTasks({ states: ['proposed'] }).length, 0, 'invalid proposals do not count');
  assert.equal((await api.callTool(token, 'propose_task', base)).status, 200);
  assert.equal((await api.callTool(token, 'propose_task', { ...base, title: 'Second' })).status, 429);
});

test('report_progress records a redacted note and touches the run', async () => {
  const { store, clock, api, counter } = setup();
  const { run, token } = startTaskRun(store);
  clock.advance(5_000);
  const res = await api.callTool(token, 'report_progress', { note: 'Form done; running the suite with token=abcdef1234567890' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(store.getRun(run.id)!.heartbeatAt, clock.now());
  const events = store.listEvents({ types: ['run.progress'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, run.id);
  assert.equal(events[0].taskId, run.taskId);
  assert.match(events[0].message, /Form done; running the suite/);
  assert.doesNotMatch(events[0].message, /abcdef1234567890/, 'secrets are redacted');
  assert.equal(counter.changes, 1);

  for (const args of [{}, { note: '' }, { note: 'x'.repeat(1001) }, { note: 42 }]) {
    assert.equal((await api.callTool(token, 'report_progress', args)).status, 400, JSON.stringify(args).slice(0, 40));
  }

  // Planner runs have no task lease; they only need to be running.
  const planner = startPlannerRun(store);
  assert.equal((await api.callTool(planner.token, 'report_progress', { note: 'Reading the docs' })).status, 200);
});

test('get_task_context returns the brief, recent notes, decisions and project rules', async () => {
  const { store, api, counter } = setup();
  const { task, token } = startTaskRun(store);
  for (let i = 1; i <= 25; i++) store.addNote(task.id, 'checks', `note ${i}`);
  const asked = json(await api.callTool(token, 'request_decision', QUESTION));
  store.respond({ decisionId: asked.decisionId, revision: 1, optionId: 'sample', actor: 'founder', idempotencyKey: 'key-0000003' });
  const changes = counter.changes;

  const res = await api.callTool(token, 'get_task_context', undefined);
  assert.equal(res.status, 200);
  const ctx = json(res);
  assert.deepEqual(Object.keys(ctx).sort(), ['decisions', 'guidance', 'notes', 'project', 'task']);
  assert.deepEqual(
    Object.keys(ctx.task).sort(),
    ['acceptanceCriteria', 'attempts', 'baseCommit', 'branch', 'dependsOn', 'hypothesis', 'id', 'kind', 'nonGoals', 'objective', 'ownedPaths', 'repairCycles', 'risk', 'role', 'title'].sort(),
  );
  assert.equal(ctx.task.id, task.id);
  assert.equal(ctx.task.objective, 'Build the onboarding flow');
  assert.deepEqual(ctx.task.acceptanceCriteria, ['New users see a welcome screen']);
  assert.deepEqual(ctx.task.ownedPaths, ['src/onboarding/**']);

  assert.equal(ctx.notes.length, 20, 'latest 20 notes');
  assert.equal(ctx.notes[0].text, 'note 6');
  assert.equal(ctx.notes[19].text, 'note 25');

  assert.equal(ctx.decisions.length, 1);
  const d = ctx.decisions[0];
  assert.equal(d.id, asked.decisionId);
  assert.equal(d.kind, 'choice');
  assert.equal(d.status, 'answered');
  assert.equal(d.question, QUESTION.question);
  assert.deepEqual(d.options, OPTIONS);
  assert.equal(d.recommendation, 'sample');
  assert.equal(d.answer.optionId, 'sample');
  assert.equal(d.answer.optionLabel, 'Show one sample habit');

  assert.equal(ctx.project.id, 'demo');
  assert.equal(ctx.project.name, 'Demo');
  assert.equal(ctx.project.charter, 'Calm, offline-first habit tracker.');
  assert.ok(ctx.project.protectedPaths.includes('.autopilot/**'));
  assert.ok(ctx.project.sensitivePaths.includes('.github/**'));
  assert.match(ctx.guidance, /Do not push/);
  assert.match(ctx.guidance, /\.autopilot\/\*\*/);
  assert.equal(counter.changes, changes, 'reading context is not a change');

  // Reviewers get review rules instead of builder rules.
  const reviewer = startTaskRun(store, { role: 'reviewer' });
  assert.match(json(await api.callTool(reviewer.token, 'get_task_context', {})).guidance, /Do not modify, commit or push/);
});

test('callTool never throws, even when the store fails or a listener throws', async () => {
  const { store, api } = setup({
    onChange: () => {
      throw new Error('listener exploded');
    },
  });
  const { token } = startTaskRun(store);
  assert.equal((await api.callTool(token, 'report_progress', { note: 'still fine' })).status, 200, 'a failing onChange does not fail the call');

  store.close();
  const broken = await api.callTool(token, 'get_task_context', {});
  assert.equal(broken.status, 500);
  assert.equal(json(broken).error, 'internal');
  assert.equal(typeof json(broken).message, 'string');
});

test('argument parsers normalize model input', () => {
  const req = parseDecisionRequest(
    { question: '  Which plan?  ', options: OPTIONS, recommendation: 'blank', links: [{ label: 'Docs', url: 'HTTPS://Example.com/a b' }] },
    'builder',
  );
  assert.equal(req.question, 'Which plan?');
  assert.equal(req.blocking, true);
  assert.equal(req.priority, 'normal');
  assert.equal(req.kind, 'choice');
  assert.equal(req.dedupeKey, null);
  assert.deepEqual(req.links, [{ label: 'Docs', url: 'https://example.com/a%20b' }]);
  assert.equal(parseDecisionRequest({ question: 'Q?', blocking: true }, 'planner').blocking, false);
  assert.throws(() => parseDecisionRequest({}, 'builder'), InvalidArgsError);

  const p = parseTaskProposal({ title: ' Retry ', objective: 'Retry uploads', acceptanceCriteria: [' works '], role: '', hypothesis: '  ' });
  assert.equal(p.title, 'Retry');
  assert.deepEqual(p.acceptanceCriteria, ['works']);
  assert.equal(p.kind, 'build');
  assert.equal(p.role, undefined, 'empty optional strings count as absent');
  assert.equal(p.hypothesis, null);
  assert.deepEqual(p.ownedPaths, []);
});

// ------------------------------------------------------------------ drills
//
// The supervisor acts on some cards when they are answered: its merge reviews,
// its login/usage pause cards and its diagnostics. These drills run the real
// supervisor (test/drills/harness.ts: git repo, LocalForge, checks) with
// scripted agents that call AgentApi, to show that nothing an agent files is
// taken for one of those cards, and that the role table matches what the
// supervisor allows each role.

const DRILL = { timeout: 60_000 };

/** Directory a drill task owns ('Onboarding' -> 'onboarding'), from its first owned glob. */
const ownedDir = (h: Harness, taskId: string) => h.store.getTask(taskId)!.ownedPaths[0].replace(/\/\*\*$/, '');

test("drill: an agent 'review' question goes back to the builder, whatever option the founder picks", DRILL, async () => {
  const runsByTask = new Map<string, RunSpec[]>();
  let h!: Harness;
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      const taskId = spec.env.AUTOPILOT_TASK_ID;
      const runs = runsByTask.get(taskId) ?? [];
      runsByTask.set(taskId, [...runs, spec]);
      const dir = ownedDir(h, taskId);
      if (runs.length === 0) {
        await commitFile(ctl, `${dir}/part1.txt`, 'first half\n', 'first half');
        const res = await h.callTool(spec, 'request_decision', {
          question: 'Does the preview look right before I build the rest?',
          kind: 'review',
          options: [
            { id: 'approve', label: 'Looks good' },
            { id: 'tweak', label: 'Needs tweaks' },
          ],
          recommendation: 'approve',
          links: [{ label: 'Preview', url: 'https://preview.example.com' }],
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return { status: 'succeeded', structuredOutput: builderResult('needs_decision', 'First half done; the founder reviews the preview.') };
      }
      await commitFile(ctl, `${dir}/part2.txt`, 'second half\n', 'second half');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    // 'approve' is the option id the supervisor's own merge cards use; 'tweak' + comment reads like "request changes".
    const answers = new Map([
      [h.addTask('Onboarding').id, { optionId: 'approve' }],
      [h.addTask('Pricing').id, { optionId: 'tweak', comment: 'Use the brand colour.' }],
    ]);
    await h.sup.start();
    for (const [taskId, answer] of answers) {
      await h.waitState(taskId, 'waiting_decision');
      const [card] = h.store.pendingBlockingFor(taskId);
      assert.equal(card.kind, 'choice');
      const saved = h.store.respond({ decisionId: card.id, revision: card.revision, actor: 'founder', idempotencyKey: `drill-answer-${taskId}`, ...answer });
      assert.equal(saved.status, 'saved');
    }
    h.sup.wake();
    for (const taskId of answers.keys()) {
      const t = await h.waitState(taskId, ['integrated', 'exhausted', 'cancelled']);
      assert.equal(t.state, 'integrated', taskId);
      assert.equal(t.repairCycles, 0, 'the answer was not taken as a change request');
      assert.ok(!t.notes.some((n) => /requested changes/i.test(n.text)), 'no "Founder requested changes" note');
      const runs = runsByTask.get(taskId)!;
      assert.equal(runs.length, 2, 'the builder was resumed once, with the answer');
      assert.equal(runs[1].resumeSessionId, runs[0].sessionId, 'in its original session');
      assert.match(runs[1].prompt, /ANSWERED/);
      const dir = ownedDir(h, taskId);
      assert.equal(h.readTarget(`${dir}/part1.txt`), 'first half\n');
      assert.equal(h.readTarget(`${dir}/part2.txt`), 'second half\n', 'the finished work was integrated, not the half-built branch');
    }
  } finally {
    await h.cleanup();
  }
});

test("drill: an agent question keyed like a supervisor card cannot lift the founder's pause", DRILL, async () => {
  let h!: Harness;
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      // A model (or an injected document) picks the supervisor's 'usage' key and a 'resume' option.
      const res = await h.callTool(spec, 'request_decision', {
        question: 'Should applicants upload a resume or fill in a form?',
        options: [
          { id: 'resume', label: 'Upload a resume' },
          { id: 'form', label: 'Fill in a form' },
        ],
        recommendation: 'resume',
        blocking: false,
        dedupeKey: 'usage',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await commitFile(ctl, 'apply-flow/form.txt', 'resume upload\n', 'apply flow');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Apply flow');
    await h.sup.start();
    await h.waitFor(() => h.store.pendingDecisionCount('drill') === 1, 'the agent card');
    h.sup.pauseAll('founder hit the kill switch');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(card.dedupeKey, 'agent:usage');
    const saved = h.store.respond({ decisionId: card.id, revision: card.revision, optionId: 'resume', actor: 'founder', idempotencyKey: 'drill-usage-resume' });
    assert.equal(saved.status, 'saved');
    h.sup.wake();
    await h.waitFor(() => h.store.getTask(t.id)!.notes.some((n) => n.source === 'decision' && n.text.includes(card.id)), 'the answer reaching the task');
    assert.equal(h.store.isPausedAll(), true, "the founder's pause holds");
    assert.deepEqual(h.store.listEvents({ types: ['resume.all'] }), []);
  } finally {
    await h.cleanup();
  }
});

test('drill: the supervisor allows each role exactly the autopilot tools the bridge lists for it', DRILL, async () => {
  const firstSpec = new Map<RunRole, RunSpec>();
  let planned = false;
  const alpha = { key: 'alpha', title: 'Alpha', objective: 'Add alpha', nonGoals: [], acceptanceCriteria: ['alpha exists'], role: 'full-stack', kind: 'build', priority: 3, risk: 'low', ownedPaths: ['alpha/**'], dependsOn: [] };
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
    },
    behavior: (spec) => async (ctl) => {
      if (!firstSpec.has(spec.role)) firstSpec.set(spec.role, spec);
      if (spec.role === 'planner') {
        const newTasks = planned ? [] : [alpha];
        planned = true;
        return { status: 'succeeded', structuredOutput: { summary: 'One task.', newTasks, acceptTaskIds: [], cancelTaskIds: [], questions: [] } };
      }
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'alpha/index.txt', 'alpha\n', 'alpha');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => firstSpec.size === 3, 'a planner, a builder and a reviewer run');
    const prefix = 'mcp__autopilot__';
    for (const [role, spec] of firstSpec) {
      const allowed = spec.allowedTools.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length));
      assert.deepEqual(allowed.sort(), [...ROLE_TOOLS[role]].sort(), `${role}: allowed autopilot tools = tools the bridge lists`);
      const bridge = (spec.mcpConfig as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers.autopilot;
      assert.equal(bridge.env.AUTOPILOT_ROLE, role, `the ${role} bridge filters by its own role`);
    }
  } finally {
    await h.cleanup();
  }
});
