// SPDX-License-Identifier: MIT
// How the supervisor applies a planner's output: dedupe, caps, dependency
// cycles, accepting/cancelling proposals, and non-blocking founder questions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const T = { timeout: 60_000 };
const task = (key: string, title: string, dependsOn: string[] = [], ownedPaths = [`${key}/**`]) => ({
  key,
  title,
  objective: `do ${title}`,
  nonGoals: [],
  acceptanceCriteria: ['works'],
  role: 'full-stack',
  kind: 'build',
  priority: 3,
  risk: 'low',
  ownedPaths,
  dependsOn,
});

test('plans are deduplicated, capped, cycle-free, and may accept or cancel queued work', T, async () => {
  let plans = 0;
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
      c.planner.maxTasksPerPlan = 3;
      c.planner.cooldownMinutes = 60;
      c.execution.maxBuilders = 0; // keep everything queued so we can inspect the plan
    },
    behavior: (spec) => async () => {
      if (spec.role !== 'planner') throw new Error('only the planner should run');
      plans++;
      const proposed = /- (T-\d+) \[proposed\] Proposed idea/.exec(spec.prompt)?.[1];
      const doomed = /- (T-\d+) \[ready\] Obsolete/.exec(spec.prompt)?.[1];
      return {
        status: 'succeeded',
        structuredOutput: {
          summary: 'test plan',
          newTasks: [
            task('dup', 'Existing work'), // duplicate of an existing title (different case/punctuation)
            task('a', 'Alpha', ['c']),
            task('b', 'Beta', ['a']),
            task('c', 'Gamma', ['b']), // a -> c -> b -> a is a cycle
            task('d', 'Delta'), // over the cap of 3 new tasks
          ],
          acceptTaskIds: proposed ? [proposed] : [],
          cancelTaskIds: doomed ? [doomed, 'T-999'] : [],
          questions: [
            {
              question: 'Which audience first?',
              why: 'Shapes the copy.',
              options: [
                { id: 'students', label: 'Students' },
                { id: 'pros', label: 'Professionals' },
              ],
              recommendation: 'students',
              recommendationReason: 'Docs mention them first.',
            },
          ],
        },
      };
    },
  });
  try {
    h.store.createTask({ projectId: 'drill', title: 'existing WORK!', objective: 'x', origin: 'human', state: 'ready', ownedPaths: ['x/**'] });
    const proposed = h.store.createTask({ projectId: 'drill', title: 'Proposed idea', objective: 'x', origin: 'agent' });
    const obsolete = h.store.createTask({ projectId: 'drill', title: 'Obsolete', objective: 'x', origin: 'human', state: 'ready', ownedPaths: ['o/**'] });
    await h.sup.start();
    await h.waitFor(() => h.store.listEvents({ types: ['plan.applied'] }).length === 1, 'plan applied');

    const titles = h.store.listTasks().map((t) => t.title);
    assert.equal(titles.filter((t) => /existing work/i.test(t)).length, 1, 'duplicate skipped');
    assert.ok(!titles.includes('Delta'), 'capped at maxTasksPerPlan');
    const byTitle = (t: string) => h.store.listTasks().find((x) => x.title === t)!;
    const [alpha, beta, gamma] = [byTitle('Alpha'), byTitle('Beta'), byTitle('Gamma')];
    // Some edge of the 3-cycle was removed, the rest kept.
    const edges = [alpha, beta, gamma].reduce((n, t) => n + t.dependsOn.length, 0);
    assert.equal(edges, 2);
    assert.equal(h.store.listEvents({ types: ['plan.cycle_removed'] }).length, 1);

    assert.equal(h.store.getTask(proposed.id)!.state, 'ready', 'proposal accepted');
    assert.equal(h.store.getTask(obsolete.id)!.state, 'cancelled', 'obsolete task cancelled');

    const [q] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(q.kind, 'choice');
    assert.equal(q.blocking, false, 'planner questions never block work');
    assert.equal(q.createdBy, 'planner');
    assert.equal(plans, 1, 'cooldown prevents an immediate second plan');
  } finally {
    await h.cleanup();
  }
});

test('answering a planner question invites a new plan; a repeated question is merged', T, async () => {
  let plans = 0;
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
      c.planner.cooldownMinutes = 60;
      c.execution.maxBuilders = 0;
    },
    behavior: () => async () => {
      plans++;
      return {
        status: 'succeeded',
        structuredOutput: {
          summary: 'ask',
          newTasks: [],
          acceptTaskIds: [],
          cancelTaskIds: [],
          questions: [{ question: 'Dark mode first?', why: 'x', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], recommendation: 'y', recommendationReason: 'r' }],
        },
      };
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => plans === 1 && h.store.listDecisions({ status: ['pending'] }).length === 1, 'first plan');
    const [q] = h.store.listDecisions({ status: ['pending'] });
    h.store.respond({ decisionId: q.id, revision: 1, optionId: 'n', actor: 'f', idempotencyKey: 'plan-answer-1' });
    h.sup.wake();
    await h.waitFor(() => plans === 2, 'the answer resets the planner cooldown');
    // The second plan asked the same question again: it becomes a new card only because the first was answered.
    await h.waitFor(() => h.store.listDecisions({ status: ['pending'] }).length === 1, 'one open card');
    assert.equal(h.store.listDecisions({}).length, 2);
  } finally {
    await h.cleanup();
  }
});
