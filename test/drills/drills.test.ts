// SPDX-License-Identifier: MIT
// End-to-end failure drills (see docs/architecture.md, "Failure drills").
// Each drill runs the real supervisor, LocalForge and check runner against a
// temporary git repository with scripted fake agents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approve, builderResult, commitFile, git, harness, type Harness } from './harness.ts';
import { LocalForge } from '../../src/git/local-forge.ts';
import { sha256Hex } from '../../src/util.ts';
import type { RunSpec } from '../../src/types.ts';

const T = { timeout: 60_000 };
const id = (spec: RunSpec) => spec.env.AUTOPILOT_TASK_ID;

test('two builders run in parallel and both tasks auto-merge', T, async () => {
  let active = 0;
  let peak = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      active++;
      peak = Math.max(peak, active);
      await ctl.sleep(300);
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      active--;
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta');
    const c = h.addTask('Gamma');
    const d = h.addTask('Delta');
    await h.sup.start();
    for (const t of [a, b, c, d]) await h.waitState(t.id, 'integrated');
    assert.equal(peak, 2, 'two builders worked at the same time, never more than maxBuilders');
    assert.equal(h.readTarget(`work/${a.id}.txt`), `${a.id}\n`);
    assert.equal(h.readTarget(`work/${b.id}.txt`), `${b.id}\n`);
    const log = h.store.listEvents({ types: ['merge.completed'] });
    assert.equal(log.length, 4);
    assert.equal(h.store.pendingDecisionCount(), 0, 'routine work needs no card');
  } finally {
    await h.cleanup();
  }
});

test('a blocking decision yields; other work continues; the answer resumes the same session', T, async () => {
  let h!: Harness;
  const resumes: (string | null | undefined)[] = [];
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (spec.prompt.includes('Tone task')) {
        resumes.push(spec.resumeSessionId);
        if (!spec.prompt.includes('ANSWERED')) {
          const r = await h.callTool(spec, 'request_decision', {
            question: 'Which tone?',
            options: [
              { id: 'warm', label: 'Warm' },
              { id: 'brief', label: 'Brief' },
            ],
            recommendation: 'warm',
            recommendationReason: 'Fits the product',
          });
          assert.equal(r.status, 200, JSON.stringify(r.body));
          return { status: 'succeeded', structuredOutput: builderResult('needs_decision') };
        }
      } else {
        await ctl.sleep(400);
      }
      await commitFile(ctl, `work/${id(spec)}.txt`, 'x\n', `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const tone = h.addTask('Tone task');
    const other = h.addTask('Other task');
    await h.sup.start();
    await h.waitState(tone.id, 'waiting_decision');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    assert.ok(card, 'a card was created');
    assert.deepEqual(card.blockedTaskIds, [tone.id]);
    await h.waitState(other.id, 'integrated'); // unrelated work kept going
    assert.equal(h.store.getTask(tone.id)!.state, 'waiting_decision');
    assert.equal(h.notifier.sent.length >= 1, true, 'founder was notified');

    const firstSession = h.store.getTask(tone.id)!.lastSessionId;
    const res = h.store.respond({ decisionId: card.id, revision: card.revision, optionId: 'brief', actor: 'founder', idempotencyKey: 'drill-key-0001' });
    assert.equal(res.status, 'saved');
    h.sup.wake();
    await h.waitState(tone.id, 'integrated');
    assert.equal(resumes.length, 2);
    assert.equal(resumes[1], firstSession, 'resumed the original session');
    assert.ok(h.store.getTask(tone.id)!.notes.some((n) => n.source === 'decision' && n.text.includes('Brief')));
  } finally {
    await h.cleanup();
  }
});

test('an answer saved while the supervisor is down is delivered after restart', T, async () => {
  let h!: Harness;
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (!spec.prompt.includes('ANSWERED')) {
        await h.callTool(spec, 'request_decision', { question: 'Color?', options: [{ id: 'a', label: 'Blue' }, { id: 'b', label: 'Green' }], recommendation: 'a', recommendationReason: 'brand' });
        return { status: 'succeeded', structuredOutput: builderResult('needs_decision') };
      }
      await commitFile(ctl, 'color.txt', 'green\n', 'color');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Color');
    await h.sup.start();
    await h.waitState(t.id, 'waiting_decision');
    await h.sup.stop();
    const [card] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(h.store.respond({ decisionId: card.id, revision: 1, optionId: 'b', actor: 'f', idempotencyKey: 'offline-0001' }).status, 'saved');
    assert.equal(h.store.respond({ decisionId: card.id, revision: 1, optionId: 'b', actor: 'f', idempotencyKey: 'offline-0001' }).status, 'duplicate');
    await h.restart();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('color.txt'), 'green\n');
  } finally {
    await h.cleanup();
  }
});

test('a crashed worker loses its lease and cannot publish when it comes back', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, 'fresh\n', 'fresh attempt');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Crashy');
    // Simulate a worker from a previous supervisor that crashed mid-run.
    const ghost = h.store.claim(t.id, ['ready'], 'building', 'R-ghost', 60_000)!;
    h.store.createRun({ id: 'R-ghost', projectId: 'drill', taskId: t.id, role: 'builder', generation: ghost.generation, tokenHash: sha256Hex('ghost-token'), cwd: h.tmp, sessionId: null, logPath: null });
    await h.sup.start(); // restart recovery breaks the orphaned lease
    await h.waitState(t.id, 'integrated');
    assert.equal(h.store.getRun('R-ghost')!.status, 'lost');
    // The ghost returns: its tool calls and its result are fenced out.
    const late = await h.agentApi.callTool('ghost-token', 'report_progress', { note: 'I am back' });
    assert.equal(late.status, 401, 'finished runs cannot call tools');
    assert.equal(h.store.release(t.id, 'R-ghost', ghost.generation, 'checking', 'late'), null);
  } finally {
    await h.cleanup();
  }
});

test('an expired lease from a hung job is broken and the task is rebuilt', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'hung.txt', 'ok\n', 'after hang');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    await h.sup.start();
    // A foreign worker holds the task with a short lease and then stops heartbeating.
    const t = h.store.createTask({ projectId: 'drill', title: 'Hung', objective: 'x', origin: 'human', state: 'proposed', ownedPaths: ['hung/**'] });
    const claimed = h.store.claim(t.id, ['proposed'], 'building', 'R-foreign', 1_000)!;
    assert.ok(claimed);
    h.clock.skew += 5_000; // the lease is now expired while the supervisor is running
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.ok(h.store.getTask(t.id)!.leaseGeneration > claimed.generation + 1, 'broken lease bumped the fence');
    assert.equal(h.store.listEvents({ taskId: t.id, types: ['task.lease_broken'] }).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('conflicting edits: the second merge conflicts, the builder resolves it, then it merges', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      const tid = id(spec);
      if (spec.prompt.includes('Merge conflict')) {
        try {
          await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'merge', 'main']);
        } catch {
          /* conflict expected */
        }
        ctl.writeFile('shared.txt', 'first\nsecond\n');
        await ctl.git(['add', 'shared.txt']);
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '--no-edit', '-m', 'resolve conflict']);
        return { status: 'succeeded', structuredOutput: builderResult('completed', 'resolved') };
      }
      await ctl.sleep(spec.prompt.includes('Second') ? 600 : 50);
      await commitFile(ctl, 'shared.txt', spec.prompt.includes('Second') ? 'second\n' : 'first\n', `edit by ${tid}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const a = h.addTask('First', { ownedPaths: ['first/**'] });
    const b = h.addTask('Second', { ownedPaths: ['second/**'] });
    await h.sup.start();
    await h.waitState(a.id, 'integrated');
    await h.waitState(b.id, 'integrated');
    const bt = h.store.getTask(b.id)!;
    assert.equal(bt.repairCycles, 1);
    assert.ok(bt.notes.some((n) => n.text.includes('Merge conflict')));
    assert.equal(h.readTarget('shared.txt'), 'first\nsecond\n');
  } finally {
    await h.cleanup();
  }
});

test('green on the branch but red after integration: no merge, repair, then merge', T, async () => {
  const h = await harness({
    config: (c) => {
      c.checks.commands = [
        { name: 'not-both', run: [process.execPath, '-e', "const f=require('fs');process.exit(f.existsSync('a.txt')&&f.existsSync('b.txt')?1:0)"], timeoutSeconds: 30 },
      ];
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (spec.prompt.includes('Checks failed after merging')) {
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'merge', 'main', '--no-edit']);
        await ctl.git(['rm', '-q', 'b.txt']);
        ctl.writeFile('c.txt', 'c\n');
        await ctl.git(['add', 'c.txt']);
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-m', 'rename b to c']);
        return { status: 'succeeded', structuredOutput: builderResult('completed', 'fixed integration') };
      }
      const isA = spec.prompt.includes('Task A');
      await ctl.sleep(isA ? 50 : 700);
      await commitFile(ctl, isA ? 'a.txt' : 'b.txt', 'x\n', isA ? 'a' : 'b');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const a = h.addTask('Task A', { ownedPaths: ['a/**'] });
    const b = h.addTask('Task B', { ownedPaths: ['b/**'] });
    await h.sup.start();
    await h.waitState(a.id, 'integrated');
    await h.waitState(b.id, 'integrated');
    assert.equal(h.readTarget('b.txt'), null);
    assert.equal(h.readTarget('c.txt'), 'c\n');
    const integrationChecks = h.store.db.prepare("SELECT status FROM checks WHERE task_id = ? AND scope = 'integration'").all(b.id) as { status: string }[];
    assert.ok(integrationChecks.some((c) => c.status === 'failed'), 'integration failure was recorded');
  } finally {
    await h.cleanup();
  }
});

test('usage limit pauses new runs without burning attempts, then resumes', T, async () => {
  let calls = 0;
  let h!: Harness;
  h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      calls++;
      if (calls === 1) {
        return { status: 'usage_limited', isError: true, resultText: 'Claude usage limit reached', usageResetAt: Date.now() + h.clock.skew + 120_000 };
      }
      await commitFile(ctl, 'u.txt', 'u\n', 'u');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Usage');
    await h.sup.start();
    await h.waitFor(() => !!h.store.usagePausedUntil(), 'usage pause');
    const task = h.store.getTask(t.id)!;
    assert.equal(task.state, 'ready');
    assert.equal(task.attempts, 0, 'a usage limit does not consume an attempt');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, 1, 'no new runs while paused');
    h.clock.skew += 5 * 60_000;
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(calls, 2);
  } finally {
    await h.cleanup();
  }
});

test('a usage warning throttles to one builder at a time (quota governor)', T, async () => {
  let active = 0;
  let warned = false;
  const startsAfterWarning: number[] = [];
  const h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 3;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (warned) startsAfterWarning.push(active);
      active++;
      if (!warned) {
        warned = true;
        ctl.emit({ type: 'activity', summary: 'rate limit allowed_warning, resets 2026-11-24T18:00:00.000Z' });
      }
      await ctl.sleep(250);
      await commitFile(ctl, `q/${id(spec)}.txt`, 'q\n', 'q');
      active--;
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const tasks = ['Q1', 'Q2', 'Q3', 'Q4'].map((t) => h.addTask(t));
    await h.sup.start();
    for (const t of tasks) await h.waitState(t.id, 'integrated');
    assert.ok(h.store.listEvents({ types: ['usage.warning'] }).length >= 1);
    // Builders already running when the warning arrived may finish, but every later start
    // happened with no other builder running.
    const late = startsAfterWarning.slice(startsAfterWarning.findIndex((n) => n === 0));
    assert.ok(late.length >= 1 && late.every((n) => n === 0), `later starts saw ${JSON.stringify(startsAfterWarning)}`);
  } finally {
    await h.cleanup();
  }
});

test('a branch that edits protected policy files is rejected and must revert them', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (spec.prompt.includes('Protected files')) {
        await ctl.git(['rm', '-q', '-r', '.autopilot']);
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-m', 'revert policy edit']);
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      }
      await commitFile(ctl, '.autopilot/policy.json', '{"autoMerge":"everything"}\n', 'widen my own permissions');
      await commitFile(ctl, 'feature.txt', 'f\n', 'feature');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Sneaky');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('.autopilot/policy.json'), null);
    assert.equal(h.readTarget('feature.txt'), 'f\n');
    assert.ok(h.store.listEvents({ types: ['merge.classified'] }).some((e) => e.message.includes('reject')));
  } finally {
    await h.cleanup();
  }
});

test('a builder that moves the target branch is caught, the branch restored and the project paused', T, async () => {
  let tampered = false;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (!tampered) {
        tampered = true;
        await commitFile(ctl, 'sneaky.txt', 'unreviewed\n', 'sneaky');
        // Worktrees share refs with the private clone: try to publish without review.
        await ctl.git(['update-ref', 'refs/heads/main', 'HEAD']);
        await ctl.sleep(2_000); // still running when the supervisor notices
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Sneaky');
    await h.sup.start();
    await h.waitFor(() => h.store.listEvents({ types: ['security.target_moved'] }).length === 1, 'tamper detected');
    assert.equal(h.store.getProject('drill')!.paused, true, 'project paused');
    assert.equal(h.readTarget('sneaky.txt'), null, 'the unreviewed commit is not on main');
    const [card] = h.store.listDecisions({ status: ['pending'] }).filter((d) => d.dedupeKey?.startsWith('target-moved:'));
    assert.ok(card, 'urgent card');
    assert.equal(card.priority, 'urgent');
    // The founder checks and resumes; the task then goes through the normal gate.
    h.store.respond({ decisionId: card.id, revision: 1, optionId: 'resume', actor: 'f', idempotencyKey: 'resume-target-1' });
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('sneaky.txt'), 'unreviewed\n');
    const log = execFileSync('git', ['log', '-1', '--format=%B', 'main'], { cwd: h.bare, encoding: 'utf8' });
    assert.match(log, /Autopilot-Task: T-1/, 'it arrived through a reviewed, recorded merge');
  } finally {
    await h.cleanup();
  }
});

test('a forged "own merge" for a queued task is caught like any other move of the target branch', T, async () => {
  let h!: Harness;
  let forged = '';
  let queuedId = '';
  let attackerDeny: string[] = [];
  const integrating = join(mkdtempSync(join(tmpdir(), 'ap-integrating-')), 'marker');
  h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 3;
      // Slow integration checks: one task merges while another waits in merge_ready.
      const slow = "if (process.cwd().includes('_integration')) { require('fs').writeFileSync(process.argv[1], ''); setTimeout(() => {}, 3000); }";
      c.checks.commands = [{ name: 'slow-integration', run: [process.execPath, '-e', slow, integrating], timeoutSeconds: 60 }];
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      if (!spec.prompt.includes('Attacker')) return { status: 'succeeded', structuredOutput: builderResult('completed') };
      attackerDeny = spec.disallowedTools;
      // Strike while one merge runs its integration checks and another task is queued behind it.
      const tasks = () => h.store.listTasks({ projectId: 'drill' });
      while (!existsSync(integrating) || !tasks().some((t) => t.state === 'merge_ready')) await ctl.sleep(20);
      // A perfect copy of the supervisor's own merge commit for the queued task, with extra content.
      const queued = tasks().find((t) => t.state === 'merge_ready')!;
      queuedId = queued.id;
      const main = (await ctl.git(['rev-parse', 'refs/heads/main'])).trim();
      ctl.writeFile('evil.txt', 'unreviewed\n');
      await ctl.git(['add', 'evil.txt']);
      const tree = (await ctl.git(['write-tree'])).trim();
      const message = `${queued.title} (${queued.id})\n\nAutopilot-Task: ${queued.id}\nAutopilot-Head: ${queued.headCommit}\n`;
      forged = (await ctl.git(['-c', 'user.name=StayOn Autopilot', '-c', 'user.email=autopilot@localhost', 'commit-tree', tree, '-p', main, '-m', message])).trim();
      await ctl.git(['fetch', '-q', '.', `${forged}:refs/heads/main`]);
      await ctl.git(['rm', '-q', '-f', 'evil.txt']);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    h.addTask('Alpha');
    h.addTask('Beta');
    h.addTask('Attacker');
    await h.sup.start();
    await h.waitFor(() => h.store.listEvents({ types: ['security.target_moved'] }).length > 0, 'tamper detected');
    // Usually the forged commit itself is found; had a merge already started on top of it, that merge is.
    const { actual } = h.store.listEvents({ types: ['security.target_moved'] })[0].data as { actual: string };
    assert.ok(actual === forged || git(h.bare, 'rev-parse', `${actual}^1`) === forged, 'the forged commit was caught');
    assert.equal(h.store.getProject('drill')!.paused, true, 'project paused');
    assert.notEqual(git(h.bare, 'rev-parse', 'main'), actual, 'main restored');
    assert.equal(h.readTarget('evil.txt'), null);
    const card = h.store.listDecisions({ status: ['pending'] }).find((d) => d.dedupeKey?.startsWith('target-moved:'));
    assert.equal(card?.priority, 'urgent');
    assert.notEqual(h.store.getTask(queuedId)!.state, 'integrated', 'the forged commit did not pass for the queued merge');
    // Defense in depth: builders are also denied the commands that forge commits or move refs.
    for (const rule of ['Bash(git commit-tree:*)', 'Bash(git replace:*)', 'Bash(git branch -M:*)', 'Bash(git branch --force:*)']) {
      assert.ok(attackerDeny.includes(rule), rule);
    }
  } finally {
    await h.cleanup();
    rmSync(dirname(integrating), { recursive: true, force: true });
  }
});

/**
 * What a supervisor that died in the middle of a merge leaves behind: the target head it recorded,
 * one task merging (leased by the dead process) and one queued in merge_ready, both checked and
 * approved on their heads.
 */
async function crashedWhileMerging(h: Harness) {
  const forge = new LocalForge({ source: h.src, home: dirname(h.bare), targetBranch: 'main', branchPrefix: h.cfg.repo.branchPrefix, strategy: 'squash', pushIntegratedTo: null });
  await forge.prepare();
  const target = await forge.targetHead();
  h.store.setKv('target_head:drill', target);
  const queue = async (title: string) => {
    const t = h.addTask(title);
    const wt = await forge.createWorktree(t.id, title);
    writeFileSync(join(wt.path, `${t.id}.txt`), `${t.id}\n`);
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', `work ${t.id}`);
    const head = git(wt.path, 'rev-parse', 'HEAD');
    h.store.patchTask(t.id, { branch: wt.branch, worktree: wt.path, baseCommit: target, headCommit: head });
    h.store.recordChecks(t.id, head, 'branch', [{ name: 'no-broken-marker', command: ['node'], status: 'passed', durationMs: 1, outputTail: '' }]);
    h.store.recordReview({ taskId: t.id, runId: null, headCommit: head, verdict: 'approve', risk: 'low', summary: 'ok', findings: [] });
    const checked = h.store.claim(t.id, ['ready'], 'checking', 'sup-dead:checks', 60_000)!;
    return h.store.release(t.id, 'sup-dead:checks', checked.generation, 'merge_ready', 'checked and reviewed')!;
  };
  const interrupted = await queue('Interrupted');
  const queued = await queue('Queued');
  h.store.claim(interrupted.id, ['merge_ready'], 'merging', 'sup-dead:merge', 60_000);
  return { forge, target, interrupted: h.store.getTask(interrupted.id)!, queued };
}

/** No model runs: these drills only exercise restart recovery and merging. */
const noRuns = () => async () => {
  throw new Error('no model run expected');
};

test('a merge that a crash cut off before it was recorded is kept after the restart', T, async () => {
  const h = await harness({ behavior: noRuns });
  try {
    const { forge, interrupted, queued } = await crashedWhileMerging(h);
    const merged = await forge.integrate(interrupted, interrupted.headCommit!, async () => [], (commit, base) => h.store.setKv('merge_pending:drill', JSON.stringify({ taskId: interrupted.id, base, commit }))); // ... then the process died
    assert.equal(merged.status, 'merged', merged.details);
    await h.sup.start();
    await h.waitState(interrupted.id, 'integrated');
    await h.waitState(queued.id, 'integrated');
    assert.equal(h.store.listEvents({ types: ['security.target_moved'] }).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
    assert.equal(git(h.bare, 'rev-parse', 'main~1'), merged.mergedCommit, 'kept, not merged a second time');
    assert.equal(h.store.listRuns({}).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('after a restart, an unrecorded commit that is not the interrupted merge is tampering', T, async () => {
  for (const variant of ['for the queued task', 'for the interrupted task at another head']) {
    const h = await harness({ behavior: noRuns });
    try {
      const { target, interrupted, queued } = await crashedWhileMerging(h);
      // While the supervisor was down, main was moved to a commit dressed up as one of its merges.
      const named = variant === 'for the queued task' ? queued : interrupted;
      const message = `${named.title} (${named.id})\n\nAutopilot-Task: ${named.id}\nAutopilot-Head: ${queued.headCommit}\n`;
      const forged = git(h.bare, 'commit-tree', `${queued.headCommit}^{tree}`, '-p', target, '-m', message);
      git(h.bare, 'update-ref', 'refs/heads/main', forged);
      await h.sup.start();
      await h.waitFor(() => h.store.listEvents({ types: ['security.target_moved'] }).length === 1, `tamper detected (${variant})`);
      assert.equal(h.store.getProject('drill')!.paused, true, variant);
      assert.equal(git(h.bare, 'rev-parse', 'main'), target, `main restored (${variant})`);
      assert.equal(h.store.listTasks({ states: ['integrated'] }).length, 0, variant);
    } finally {
      await h.cleanup();
    }
  }
});

test('sensitive changes need the founder; approval is bound to the exact revision', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'package.json', '{"name":"x"}\n', 'add manifest');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Manifest');
    await h.sup.start();
    await h.waitState(t.id, 'waiting_decision');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(card.kind, 'review');
    const head1 = h.store.getTask(t.id)!.headCommit;
    assert.equal(card.artifactRef, head1);

    // Someone changes the branch after the card was shown: the old approval must not merge it.
    const wt = h.store.getTask(t.id)!.worktree!;
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-c', 'user.name=X', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-m', 'late change'], { cwd: wt });
    assert.equal(h.store.respond({ decisionId: card.id, revision: card.revision, optionId: 'approve', actor: 'f', idempotencyKey: 'approve-0001' }).status, 'saved');
    h.sup.wake();
    await h.waitFor(() => h.store.listDecisions({ status: ['pending'] }).some((d) => d.artifactRef && d.artifactRef !== head1), 'a new card for the new revision');
    assert.notEqual(h.store.getTask(t.id)!.state, 'integrated');
    const [card2] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(h.store.respond({ decisionId: card2.id, revision: card2.revision, optionId: 'approve', actor: 'f', idempotencyKey: 'approve-0002' }).status, 'saved');
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('package.json'), '{"name":"x"}\n');
  } finally {
    await h.cleanup();
  }
});

test('reviewer change requests go back to the builder with the findings', T, async () => {
  let reviews = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') {
        reviews++;
        if (reviews === 1) {
          return {
            status: 'succeeded',
            structuredOutput: { verdict: 'request_changes', risk: 'low', summary: 'Missing test', findings: [{ severity: 'major', file: 'r.txt', issue: 'add a test' }] },
          };
        }
        return { status: 'succeeded', structuredOutput: approve };
      }
      if (spec.prompt.includes('add a test')) {
        await commitFile(ctl, 'r.test.txt', 'test\n', 'add test');
      } else {
        await commitFile(ctl, 'r.txt', 'r\n', 'r');
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Reviewed');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(reviews, 2);
    assert.equal(h.readTarget('r.test.txt'), 'test\n');
    assert.equal(h.store.getTask(t.id)!.repairCycles, 1);
  } finally {
    await h.cleanup();
  }
});

test('an auth failure pauses everything and asks the founder once; resume continues', T, async () => {
  let calls = 0;
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      calls++;
      if (calls === 1) return { status: 'failed', isError: true, error: 'auth: OAuth session expired and could not be refreshed' };
      await commitFile(ctl, 'auth.txt', 'ok\n', 'ok');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Needs login');
    await h.sup.start();
    await h.waitFor(() => h.store.isPausedAll(), 'global pause');
    const cards = h.store.listDecisions({ status: ['pending'] });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].dedupeKey, 'auth');
    assert.equal(h.store.getTask(t.id)!.attempts, 0);
    h.store.respond({ decisionId: cards[0].id, revision: 1, optionId: 'resume', actor: 'f', idempotencyKey: 'auth-resume-1' });
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.store.isPausedAll(), false);
  } finally {
    await h.cleanup();
  }
});

test('repeated failures exhaust the budget, create one diagnostic card, and retry on answer', T, async () => {
  let calls = 0;
  const h = await harness({
    config: (c) => {
      c.execution.maxAttempts = 2;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      calls++;
      if (calls <= 2) return { status: 'failed', isError: true, error: 'tool crashed' };
      await commitFile(ctl, 'eventually.txt', 'ok\n', 'ok');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Flaky');
    await h.sup.start();
    await h.waitState(t.id, 'exhausted');
    const cards = h.store.listDecisions({ status: ['pending'] });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'diagnostic');
    h.store.respond({ decisionId: cards[0].id, revision: 1, optionId: 'retry', comment: 'try a smaller step', actor: 'f', idempotencyKey: 'retry-0001' });
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(calls, 3);
  } finally {
    await h.cleanup();
  }
});

test('a check step that keeps crashing stops after three tries with one card; retry re-runs checks', T, async () => {
  let crashes = 0;
  let healthy = false;
  const h = await harness({
    checks: () => ({
      setup: async () => [],
      run: async () => {
        if (!healthy) {
          crashes++;
          throw new Error('disk full');
        }
        return [{ name: 'no-broken-marker', command: ['true'], status: 'passed', durationMs: 1, outputTail: '' }];
      },
    }),
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'job.txt', 'ok\n', 'job');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Job');
    await h.sup.start();
    await h.waitState(t.id, 'waiting_decision');
    assert.equal(crashes, 3, 'bounded retries');
    const [card] = h.store.listDecisions({ status: ['pending'] });
    assert.equal(card.kind, 'diagnostic');
    healthy = true;
    h.store.respond({ decisionId: card.id, revision: 1, optionId: 'retry_checks', actor: 'f', idempotencyKey: 'retry-checks-1' });
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.store.listRuns({ taskId: t.id }).filter((r) => r.role === 'builder').length, 1, 'the builder was not re-run');
  } finally {
    await h.cleanup();
  }
});

test('the planner creates dependent tasks; dependents wait for their dependency', T, async () => {
  const order: string[] = [];
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
      c.planner.cooldownMinutes = 60;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'planner') {
        return {
          status: 'succeeded',
          structuredOutput: {
            summary: 'foundation first',
            newTasks: [
              { key: 'base', title: 'Scaffold', objective: 'base', nonGoals: [], acceptanceCriteria: ['exists'], role: 'full-stack', kind: 'build', priority: 1, risk: 'low', ownedPaths: ['**'], dependsOn: [] },
              { key: 'ui', title: 'Screen', objective: 'ui', nonGoals: [], acceptanceCriteria: ['exists'], role: 'frontend', kind: 'build', priority: 2, risk: 'low', ownedPaths: ['ui/**'], dependsOn: ['base'] },
              { key: 'api', title: 'Endpoint', objective: 'api', nonGoals: [], acceptanceCriteria: ['exists'], role: 'backend', kind: 'build', priority: 2, risk: 'low', ownedPaths: ['api/**'], dependsOn: ['base'] },
            ],
            acceptTaskIds: [],
            cancelTaskIds: [],
            questions: [],
          },
        };
      }
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      const title = /# Task T-\d+: (.*)/.exec(spec.prompt)![1];
      order.push(title);
      await commitFile(ctl, `${title.toLowerCase()}.txt`, 'x\n', title);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => h.store.listTasks().length === 3, 'planned tasks');
    await h.waitFor(() => h.store.listTasks().every((t) => t.state === 'integrated'), 'all integrated');
    assert.equal(order[0], 'Scaffold', 'the foundation runs first');
    const screen = h.store.listTasks().find((t) => t.title === 'Screen')!;
    const scaffold = h.store.listTasks().find((t) => t.title === 'Scaffold')!;
    assert.deepEqual(screen.dependsOn, [scaffold.id]);
  } finally {
    await h.cleanup();
  }
});
