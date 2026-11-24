// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StateError } from '../src/store.ts';
import { defaultConfig } from '../src/config.ts';

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = Store.open(':memory:', clock.now);
  store.upsertProject(defaultConfig('demo', 'Demo', '/tmp/demo'));
  return { store, clock };
}

test('task claim is atomic and fenced by generation', () => {
  const { store, clock } = setup();
  const task = store.createTask({ projectId: 'demo', title: 'A', objective: 'do a', origin: 'human' });
  assert.equal(task.state, 'ready');

  const a = store.claim(task.id, ['ready'], 'building', 'R-a', 1000);
  assert.ok(a);
  assert.equal(a.generation, 1);
  assert.equal(store.claim(task.id, ['ready'], 'building', 'R-b', 1000), null, 'second claimer loses');

  assert.ok(store.heartbeat(task.id, 'R-a', 1, 1000));
  clock.advance(1500);
  assert.equal(store.heartbeat(task.id, 'R-a', 1, 1000), false, 'expired lease cannot be extended');
  assert.deepEqual(store.expiredLeases().map((t) => t.id), [task.id]);

  const broken = store.breakLease(task.id, 'R-a', 'ready', 'lease expired');
  assert.ok(broken);
  assert.equal(broken.leaseGeneration, 2, 'breaking bumps the fence');

  const b = store.claim(task.id, ['ready'], 'building', 'R-b', 1000);
  assert.ok(b);
  assert.equal(b.generation, 3);
  // The old worker comes back and tries to publish its result: rejected.
  assert.equal(store.release(task.id, 'R-a', 1, 'checking', 'late result'), null);
  assert.equal(store.getTask(task.id)!.state, 'building');
  assert.ok(store.release(task.id, 'R-b', 3, 'checking', 'done'));
  assert.equal(store.getTask(task.id)!.state, 'checking');
});

test('transitions follow the state machine', () => {
  const { store } = setup();
  const task = store.createTask({ projectId: 'demo', title: 'A', objective: 'x', origin: 'agent' });
  assert.equal(task.state, 'proposed');
  assert.throws(() => store.transition(task.id, 'proposed', 'integrated', 'nope'), StateError);
  store.transition(task.id, 'proposed', 'ready', 'triaged');
  assert.throws(() => store.transition(task.id, 'proposed', 'ready', 'again'), StateError);
});

test('decision responses are revision-bound and idempotent', () => {
  const { store } = setup();
  const task = store.createTask({ projectId: 'demo', title: 'Onboarding', objective: 'x', origin: 'human' });
  const { decision } = store.createDecision({
    projectId: 'demo',
    taskId: task.id,
    kind: 'choice',
    question: 'Which empty state?',
    options: [
      { id: 'example', label: 'Show one sample' },
      { id: 'blank', label: 'Start empty' },
    ],
    recommendation: 'example',
    createdBy: 'agent',
  });
  assert.equal(decision.revision, 1);
  assert.deepEqual(store.pendingBlockingFor(task.id).map((d) => d.id), [decision.id]);

  const revised = store.reviseDecision(decision.id, { question: 'Which empty state for Today?' });
  assert.equal(revised.revision, 2);

  const stale = store.respond({ decisionId: decision.id, revision: 1, optionId: 'blank', actor: 'founder', idempotencyKey: 'key-00000001' });
  assert.equal(stale.status, 'stale_revision');

  const bad = store.respond({ decisionId: decision.id, revision: 2, optionId: 'nope', actor: 'founder', idempotencyKey: 'key-00000002' });
  assert.equal(bad.status, 'invalid');

  const ok = store.respond({ decisionId: decision.id, revision: 2, optionId: 'blank', actor: 'founder', idempotencyKey: 'key-00000003' });
  assert.equal(ok.status, 'saved');
  const dup = store.respond({ decisionId: decision.id, revision: 2, optionId: 'blank', actor: 'founder', idempotencyKey: 'key-00000003' });
  assert.equal(dup.status, 'duplicate');
  const second = store.respond({ decisionId: decision.id, revision: 2, optionId: 'example', actor: 'founder', idempotencyKey: 'key-00000004' });
  assert.equal(second.status, 'not_pending');

  const outbox = store.pendingOutbox();
  assert.equal(outbox.filter((o) => o.kind === 'decision_answered').length, 1, 'exactly one delivery event');
  assert.equal(store.pendingBlockingFor(task.id).length, 0);
});

test('duplicate questions merge into one card that blocks both tasks', () => {
  const { store } = setup();
  const t1 = store.createTask({ projectId: 'demo', title: 'A', objective: 'x', origin: 'human' });
  const t2 = store.createTask({ projectId: 'demo', title: 'B', objective: 'y', origin: 'human' });
  const q = { projectId: 'demo', kind: 'choice' as const, question: 'Brand color?', dedupeKey: 'brand-color', createdBy: 'agent' as const };
  const a = store.createDecision({ ...q, taskId: t1.id });
  const b = store.createDecision({ ...q, taskId: t2.id });
  assert.equal(b.deduped, true);
  assert.equal(a.decision.id, b.decision.id);
  assert.deepEqual(store.getDecision(a.decision.id)!.blockedTaskIds.sort(), [t1.id, t2.id].sort());
});

test('requiresComment options and comment-only answers', () => {
  const { store } = setup();
  const { decision } = store.createDecision({
    projectId: 'demo',
    kind: 'review',
    question: 'Accept this layout?',
    options: [
      { id: 'approve', label: 'Approve this revision' },
      { id: 'changes', label: 'Request changes', requiresComment: true },
    ],
    createdBy: 'supervisor',
  });
  const r1 = store.respond({ decisionId: decision.id, revision: 1, optionId: 'changes', actor: 'f', idempotencyKey: 'k-12345678' });
  assert.equal(r1.status, 'invalid');
  const r2 = store.respond({ decisionId: decision.id, revision: 1, optionId: 'changes', comment: 'Bigger buttons', actor: 'f', idempotencyKey: 'k-12345679' });
  assert.equal(r2.status, 'saved');
});
