// SPDX-License-Identifier: MIT
// Regression drills for defects found by the adversarial core review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, builderResult, commitFile, git, harness, type Harness } from './harness.ts';
import type { ProjectConfig } from '../../src/config.ts';
import type { RunSpec } from '../../src/types.ts';

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

test('a secret committed and removed again in a later commit is still caught', T, async () => {
  const key = `sk-ant-${'b'.repeat(40)}`;
  let builds = 0;
  const h = await harness({
    config: (c) => {
      c.integration.strategy = 'merge'; // the target keeps every commit of the branch
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      if (builds === 1) {
        await commitFile(ctl, 'config.ts', `export const key = "${key}";\n`, 'oops');
        await commitFile(ctl, 'config.ts', 'export const key = process.env.API_KEY;\n', 'read key from env');
      } else {
        const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
        await ctl.git(['reset', '--soft', base]);
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-m', 'read key from env']);
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Config');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(builds, 2, 'the branch with the secret in its history was sent back');
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('Secret-looking content was committed (Anthropic API key in config.ts)')));
    assert.match(h.readTarget('config.ts')!, /process\.env/);
    assert.equal(git(h.bare, 'log', '-p', 'main').includes(key), false, 'no commit on main contains the key');
  } finally {
    await h.cleanup();
  }
});

test('a .env file that a branch reaches only by renaming another file is still caught', T, async () => {
  for (const variant of ['in an ordinary commit', 'inside a merge commit']) {
    let builds = 0;
    const id = ['-c', 'user.name=F', '-c', 'user.email=f@x'];
    const h = await harness({
      behavior: (spec) => async (ctl) => {
        if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
        builds++;
        if (builds === 1) {
          await commitFile(ctl, 'settings.txt', 'DB_PASSWORD=hunter2hunter2\n', 'add settings');
          if (variant === 'inside a merge commit') {
            // Both parents of the merge hold settings.txt, so with rename detection the combined
            // diff of the merge shows nothing at all.
            const mine = (await ctl.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            await ctl.git(['checkout', '-q', '-b', 'side']);
            await commitFile(ctl, 'y.md', 'y\n', 'side work');
            await ctl.git(['checkout', '-q', mine]);
            await commitFile(ctl, 'x.md', 'x\n', 'more work');
            await ctl.git([...id, 'merge', '-q', '--no-ff', '--no-commit', 'side']);
          }
          // A rename without content changes: `git log -M` prints "rename to .env" and no "+++ b/.env".
          await ctl.git(['mv', 'settings.txt', '.env']);
          await ctl.git([...id, 'commit', '-q', '-m', 'move settings to .env']);
        } else {
          const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
          await ctl.git(['reset', '--soft', base]);
          await ctl.git(['rm', '-q', '--cached', '.env']);
          await commitFile(ctl, 'settings.example', 'DB_PASSWORD=\n', 'placeholders only');
        }
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      },
    });
    try {
      const t = h.addTask('Settings');
      await h.sup.start();
      await h.waitState(t.id, 'integrated');
      assert.equal(builds, 2, `the branch that renamed a file to .env was sent back (${variant})`);
      assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('Secret-looking content was committed (environment file in .env)')), variant);
      assert.equal(h.readTarget('.env'), null, variant);
    } finally {
      await h.cleanup();
    }
  }
});

test('a secret that only a merge commit adds is caught', T, async () => {
  let builds = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      const asWorker = (...args: string[]) => ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', ...args]);
      if (builds === 1) {
        const branch = (await ctl.git(['symbolic-ref', '--short', 'HEAD'])).trim();
        await ctl.git(['checkout', '-q', '-b', 'side-work']);
        await commitFile(ctl, 'side.txt', 'side\n', 'side work');
        await ctl.git(['checkout', '-q', branch]);
        await commitFile(ctl, 'own.txt', 'own\n', 'own work');
        await asWorker('merge', '-q', '--no-ff', '--no-commit', 'side-work');
        ctl.writeFile('creds.ts', `export const id = "AKIA${'C'.repeat(16)}";\n`);
        await ctl.git(['add', 'creds.ts']);
        await asWorker('commit', '-q', '--no-edit');
      } else {
        const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
        await ctl.git(['rm', '-q', 'creds.ts']);
        await ctl.git(['reset', '--soft', base]);
        await asWorker('commit', '-q', '-m', 'side and own work');
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Merger');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(builds, 2);
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('AWS access key in creds.ts')));
    assert.equal(h.readTarget('creds.ts'), null);
    assert.equal(h.readTarget('side.txt'), 'side\n');
  } finally {
    await h.cleanup();
  }
});

test('a secret in a root commit is caught even when the repository config hides root commits', T, async () => {
  const h = await harness({
    config: (c) => {
      c.execution.maxRepairCycles = 0; // stop after the first finding
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      // log.showRoot=false hides root commits from `git log -p`; then start an unrelated history.
      await ctl.git(['config', 'log.showRoot', 'false']);
      await ctl.git(['checkout', '-q', '--orphan', 'fresh']);
      await commitFile(ctl, 'z.txt', `token = "ghp_${'B'.repeat(36)}"\n`, 'root');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Orphan');
    await h.sup.start();
    await h.waitState(t.id, 'exhausted');
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('GitHub token in z.txt')));
  } finally {
    await h.cleanup();
  }
});

test('a secret after more than 2 MB of other changes is still caught', T, async () => {
  const token = `ghp_${'A'.repeat(36)}`;
  let builds = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      if (builds === 1) {
        ctl.writeFile('a-data/fixture.txt', 'x'.repeat(2_100_000)); // one long line, diffed before z/
        ctl.writeFile('z/client.ts', `export const token = "${token}";\n`);
      } else {
        const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
        await ctl.git(['reset', '--soft', base]);
        ctl.writeFile('z/client.ts', 'export const token = process.env.GH_TOKEN;\n');
      }
      await ctl.git(['add', '-A']);
      await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-m', 'client']);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Client');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(builds, 2);
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('GitHub token in z/client.ts')));
    assert.match(h.readTarget('z/client.ts')!, /process\.env/);
  } finally {
    await h.cleanup();
  }
});

test('a branch whose history is too large to scan for secrets is never published or merged', T, async () => {
  let builds = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      if (builds === 1) {
        // More patch text than the scan reads (32 MiB): unscanned commits must not go anywhere.
        await commitFile(ctl, 'big/data.txt', `${'x'.repeat(99)}\n`.repeat(340_000), 'generated data');
      } else {
        const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
        await ctl.git(['rm', '-q', 'big/data.txt']);
        await ctl.git(['reset', '--soft', base]);
        await commitFile(ctl, 'big/README.md', 'generated at build time\n', 'document the data');
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Data');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(builds, 2);
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => n.text.includes('the secret scan could not check all of its commits')));
    assert.equal(h.readTarget('big/data.txt'), null);
    assert.equal(h.readTarget('big/README.md'), 'generated at build time\n');
    // A history git cannot read fails closed as well.
    const sup = h.sup as any;
    const unreadable = await sup.scanCommits(sup.runtimes.get('drill'), 'f'.repeat(40), h.store.getTask(t.id)!.headCommit);
    assert.deepEqual(unreadable.secrets, []);
    assert.match(unreadable.incomplete, /^git log failed: /);
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

test('reviewers and planners get no git command that can write files (git diff/log/show --output)', T, async () => {
  const specs: RunSpec[] = [];
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
      c.planner.cooldownMinutes = 60;
    },
    behavior: (spec) => async (ctl) => {
      specs.push(spec);
      if (spec.role === 'planner') return { status: 'succeeded', structuredOutput: { summary: 'nothing new', newTasks: [], acceptTaskIds: [], cancelTaskIds: [], questions: [] } };
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'r.txt', 'r\n', 'r');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Reviewed');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    await h.waitFor(() => specs.some((s) => s.role === 'planner'), 'a planner run');
    const gitRules = (s: RunSpec) => s.allowedTools.filter((r) => /^Bash\(git (diff|log|show)\b/.test(r));
    assert.deepEqual(gitRules(specs.find((s) => s.role === 'planner')!), [], 'the planner reads files with Read/Glob/Grep');

    // The reviewer: exact rules (nothing can be appended) for the commands its prompt names.
    const reviewer = specs.find((s) => s.role === 'reviewer')!;
    const { baseCommit: base, headCommit: head } = h.store.getTask(t.id)!;
    const commands = [`git diff ${base} ${head}`, `git diff --stat ${base} ${head}`, `git log --oneline ${base}..${head}`];
    assert.deepEqual(gitRules(reviewer), commands.map((c) => `Bash(${c})`));
    for (const c of commands) assert.ok(reviewer.prompt.includes(`- ${c}\n`), `the prompt names: ${c}`);
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
