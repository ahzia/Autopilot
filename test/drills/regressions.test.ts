// SPDX-License-Identifier: MIT
// Regression drills for defects found by the adversarial core review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, builderResult, commitFile, harness, type Harness } from './harness.ts';
import type { ProjectConfig } from '../../src/config.ts';

const T = { timeout: 60_000 };

test('a policy file changed while running only applies after the founder confirms', T, async () => {
  let cfgNow!: ProjectConfig;
  let h!: Harness;
  h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 0; // nothing runs; we only watch policy handling
    },
    behavior: () => async () => ({ status: 'succeeded' }),
  });
  try {
    cfgNow = h.cfg;
    await h.sup.start();
    // Simulate an edit on disk (by anyone, including a builder running as the same user).
    const edited: ProjectConfig = { ...cfgNow, integration: { ...cfgNow.integration, maxAutoMergeLines: 99999 } };
    (h.sup as any).opts.loadConfigs = () => ({ configs: [edited], errors: [] });
    (h.sup as any).lastConfigSync = 0;
    h.sup.wake();
    await h.waitFor(() => h.store.listDecisions({ status: ['pending'] }).some((d) => d.dedupeKey?.startsWith('policy:')), 'policy card');
    const rt = (h.sup as any).runtimes.get('drill');
    assert.equal(rt.cfg.integration.maxAutoMergeLines, cfgNow.integration.maxAutoMergeLines, 'old policy still in force');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(card.kind, 'authorization');
    assert.equal(card.options.find((o) => o.id === 'apply_policy')!.consequential, true, 'needs an explicit tap');
    h.store.respond({ decisionId: card.id, revision: 1, optionId: 'apply_policy', actor: 'f', idempotencyKey: 'policy-apply-1' });
    h.sup.wake();
    await h.waitFor(() => (h.sup as any).runtimes.get('drill').cfg.integration.maxAutoMergeLines === 99999, 'applied after approval');
    assert.equal((h.sup as any).runtimes.get('drill'), rt, 'runtime updated in place (in-flight jobs keep their flags)');
  } finally {
    await h.cleanup();
  }
});

test('a revision the founder rejected never merges, even if the builder changes nothing', T, async () => {
  let builds = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      if (builds === 1) await commitFile(ctl, 'package.json', '{"name":"v1"}\n', 'v1');
      // Later runs do nothing at all.
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Manifest');
    await h.sup.start();
    await h.waitState(t.id, 'waiting_decision');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    h.store.respond({ decisionId: card.id, revision: 1, optionId: 'changes', comment: 'Use a different name', actor: 'f', idempotencyKey: 'reject-1' });
    h.sup.wake();
    await h.waitState(t.id, 'exhausted', 30_000);
    assert.equal(h.readTarget('package.json'), null, 'the rejected revision was never merged');
    assert.ok(h.store.founderRejected(t.id, card.artifactRef!));
  } finally {
    await h.cleanup();
  }
});

test('cancelling one task keeps a shared card open for the other task waiting on it', T, async () => {
  let h!: Harness;
  h = await harness({
    behavior: (spec) => async () => {
      if (spec.role !== 'builder') return { status: 'succeeded', structuredOutput: approve };
      await h.callTool(spec, 'request_decision', {
        question: 'Brand color?',
        options: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }],
        recommendation: 'blue',
        recommendationReason: 'brand',
        dedupeKey: 'brand-color',
      });
      return { status: 'succeeded', structuredOutput: builderResult('needs_decision') };
    },
  });
  try {
    const a = h.addTask('Header');
    const b = h.addTask('Footer');
    await h.sup.start();
    await h.waitState(a.id, 'waiting_decision');
    await h.waitState(b.id, 'waiting_decision');
    const cards = h.store.listDecisions({ status: ['pending'] });
    assert.equal(cards.length, 1, 'one deduplicated card');
    h.sup.cancelTask(a.id);
    const [still] = h.store.listDecisions({ status: ['pending'] });
    assert.ok(still, 'card stays open');
    assert.deepEqual(still.blockedTaskIds, [b.id]);
  } finally {
    await h.cleanup();
  }
});

test('a task cannot be cancelled while it is being merged', T, async () => {
  const h = await harness({ behavior: () => async () => ({ status: 'succeeded' }) });
  try {
    const t = h.store.createTask({ projectId: 'drill', title: 'M', objective: 'x', origin: 'human', state: 'proposed' });
    h.store.claim(t.id, ['proposed'], 'merging', 'sup-x:merge', 60_000);
    assert.throws(() => h.sup.cancelTask(t.id), /being merged/);
  } finally {
    await h.cleanup();
  }
});

test('secret-looking content is never published or merged', T, async () => {
  let builds = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      if (builds === 1) {
        await commitFile(ctl, 'config.ts', `export const key = "sk-ant-${'a'.repeat(40)}";\n`, 'oops');
      } else {
        // Fix: rewrite the unpublished branch without the secret.
        const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
        await ctl.git(['reset', '--soft', base]);
        ctl.writeFile('config.ts', 'export const key = process.env.API_KEY;\n');
        await ctl.git(['add', 'config.ts']);
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-m', 'read key from env']);
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Config');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(builds, 2);
    assert.match(h.readTarget('config.ts')!, /process\.env/);
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('Secret-looking content')));
  } finally {
    await h.cleanup();
  }
});

test('a replace ref cannot hide a change from the merge gate', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      const asWorker = (...args: string[]) => ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', ...args]);
      if (spec.prompt.includes('Protected files')) {
        await ctl.git(['rm', '-q', '-r', '.autopilot']);
        await asWorker('commit', '-m', 'revert policy edit');
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      }
      // Make the target commit read as if it already had the policy file, then add it for real.
      const target = (await ctl.git(['rev-parse', 'HEAD'])).trim();
      ctl.writeFile('.autopilot/policy.json', '{"autoMerge":"everything"}\n');
      await ctl.git(['add', '.autopilot/policy.json']);
      const standIn = (await asWorker('commit-tree', (await ctl.git(['write-tree'])).trim(), '-m', 'initial')).trim();
      await ctl.git(['replace', target, standIn]);
      ctl.writeFile('feature.txt', 'f\n');
      await ctl.git(['add', 'feature.txt']);
      await asWorker('commit', '-m', 'feature and policy');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Hidden');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.ok(h.store.listEvents({ types: ['merge.classified'] }).some((e) => e.message.includes('reject')), 'the hidden policy edit was seen');
    assert.equal(h.readTarget('.autopilot/policy.json'), null);
    assert.equal(h.readTarget('feature.txt'), 'f\n');
  } finally {
    await h.cleanup();
  }
});

test('an answer that arrives before the asking run ends resumes it without a second card', T, async () => {
  let h!: Harness;
  let asked = 0;
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (!spec.prompt.includes('ANSWERED')) {
        asked++;
        const r = await h.callTool(spec, 'request_decision', { question: 'Size?', options: [{ id: 's', label: 'Small' }, { id: 'l', label: 'Large' }], recommendation: 's', recommendationReason: 'r' });
        // The founder answers instantly, while this run is still finishing.
        h.store.respond({ decisionId: r.body.decisionId, revision: 1, optionId: 'l', actor: 'f', idempotencyKey: 'fast-answer-1' });
        return { status: 'succeeded', structuredOutput: builderResult('needs_decision') };
      }
      await commitFile(ctl, 'size.txt', 'large\n', 'size');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Size');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(asked, 1);
    assert.equal(h.store.listDecisions({}).length, 1, 'no redundant diagnostic card');
  } finally {
    await h.cleanup();
  }
});

test('if a builder leaves the worktree on another branch, the task branch follows its work', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await ctl.git(['checkout', '-q', '-b', 'scratch']);
      await commitFile(ctl, 'moved.txt', 'here\n', 'work on the wrong branch');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Wanderer');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('moved.txt'), 'here\n');
  } finally {
    await h.cleanup();
  }
});

test('after merging main into its branch, a task is judged only on its own changes', T, async () => {
  let h!: Harness;
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (spec.prompt.includes('Manifest')) {
        await commitFile(ctl, 'package.json', '{"name":"x"}\n', 'manifest'); // sensitive: needs the founder
      } else {
        // Wait until the manifest is on main, then bring main in before finishing.
        while (h.readTarget('package.json') === null) await ctl.sleep(50);
        await commitFile(ctl, 'b.txt', 'b\n', 'b');
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'merge', '--no-edit', 'main']);
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const a = h.addTask('Manifest', { ownedPaths: ['package.json'] });
    const b = h.addTask('Plain', { ownedPaths: ['b/**'] });
    await h.sup.start();
    await h.waitState(a.id, 'waiting_decision');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    h.store.respond({ decisionId: card.id, revision: 1, optionId: 'approve', actor: 'f', idempotencyKey: 'approve-manifest' });
    h.sup.wake();
    await h.waitState(a.id, 'integrated');
    await h.waitState(b.id, 'integrated');
    // B carried package.json in its history via main, but it was judged on b.txt only: no card.
    assert.equal(h.store.listDecisions({}).filter((d) => d.taskId === b.id).length, 0);
  } finally {
    await h.cleanup();
  }
});
