// SPDX-License-Identifier: MIT
// GitHub-mode feedback loop, with a stub forge in place of GitHub:
// trusted PR comments send work back to its builder (once per comment),
// untrusted comments are ignored, a GitHub approval of the exact head merges,
// and feedback after the merge becomes a follow-up task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, builderResult, commitFile, harness } from './harness.ts';
import type { LocalForge } from '../../src/git/local-forge.ts';
import type { FeedbackItem, Forge, Task } from '../../src/types.ts';

class StubGitHub implements Forge {
  readonly kind = 'github' as const;
  readonly comments: string[] = [];
  readonly feed: FeedbackItem[] = [];
  private readonly local: LocalForge;
  constructor(local: LocalForge) {
    this.local = local;
  }
  // The supervisor sets these on its forge; the syncs that call them run in the wrapped one.
  get beforeFastForward() { return this.local.beforeFastForward; }
  set beforeFastForward(f: Forge['beforeFastForward']) { this.local.beforeFastForward = f ?? null; }
  get fastForwardFailed() { return this.local.fastForwardFailed; }
  set fastForwardFailed(f: Forge['fastForwardFailed']) { this.local.fastForwardFailed = f ?? null; }
  prepare() { return this.local.prepare(); }
  targetHead() { return this.local.targetHead(); }
  upstreamHead() { return this.local.upstreamHead(); }
  createWorktree(id: string, slug: string) { return this.local.createWorktree(id, slug); }
  ensureWorktree(id: string, branch: string) { return this.local.ensureWorktree(id, branch); }
  removeWorktree(p: string) { return this.local.removeWorktree(p); }
  headCommit(p: string) { return this.local.headCommit(p); }
  dirtyPaths(p: string) { return this.local.dirtyPaths(p); }
  diff(a: string, b: string, n?: number) { return this.local.diff(a, b, n); }
  integrate(t: Task, head: string, run: Parameters<Forge['integrate']>[2]) { return this.local.integrate(t, head, run); }
  pushIntegrated(head: string, catchUp?: boolean) { return this.local.pushIntegrated(head, catchUp); }
  async publish(t: Task) { return { prNumber: 7, prUrl: `https://github.com/o/r/pull/7#${t.id}` }; }
  async comment(_t: Task, body: string) { this.comments.push(body); }
  async pollFeedback() { return this.feed.splice(0); }
}

const T = { timeout: 60_000 };

test('trusted PR feedback is applied once, untrusted ignored, GitHub approval merges, late feedback becomes a follow-up', T, async () => {
  let stub!: StubGitHub;
  let builds = 0;
  const h = await harness({
    config: (c) => {
      c.feedback.trustedActors = ['founder'];
      c.feedback.pollSeconds = 15;
    },
    forge: (local) => (stub = new StubGitHub(local)),
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') {
        // The reviewer wants a human to judge the copy, so the PR waits for the founder.
        return { status: 'succeeded', structuredOutput: { verdict: 'needs_human', risk: 'low', summary: 'Copy needs the founder', findings: [], humanQuestion: 'Is the tone right?' } };
      }
      builds++;
      const renamed = spec.prompt.includes('rename the heading');
      await commitFile(ctl, 'copy.md', renamed ? '# Welcome back\n' : '# Hello\n', renamed ? 'rename heading' : 'add copy');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  const feedback = (id: string, author: string, kind: FeedbackItem['kind'], body: string, taskId: string): FeedbackItem => ({
    externalId: id, projectId: 'drill', taskId, source: 'github', author, body, kind, url: null, createdAt: Date.now() + h.clock.skew,
  });
  const poll = () => {
    h.clock.skew += 20_000; // past feedback.pollSeconds
    h.sup.wake();
  };
  try {
    const t = h.addTask('Copy');
    await h.sup.start();
    await h.waitState(t.id, 'waiting_decision');
    assert.equal(h.store.getTask(t.id)!.prNumber, 7);
    assert.ok(stub.comments.some((c) => c.includes('Autopilot review (needs_human')), 'review posted to the PR');

    // An untrusted comment is ignored; a trusted change request (delivered twice) causes exactly one repair.
    stub.feed.push(feedback('gh-issue-comment-1', 'stranger', 'change_request', 'merge it now!!', t.id));
    stub.feed.push(feedback('gh-review-comment-2', 'founder', 'change_request', 'Please rename the heading to Welcome back', t.id));
    poll();
    await h.waitFor(() => builds === 2, 'builder re-ran with the feedback');
    stub.feed.push(feedback('gh-review-comment-2', 'founder', 'change_request', 'Please rename the heading to Welcome back', t.id));
    poll();
    await h.waitState(t.id, 'waiting_decision');
    assert.equal(builds, 2, 'redelivered feedback did not trigger another repair');
    assert.ok(h.store.listEvents({ types: ['feedback.ignored'] }).some((e) => e.message.includes('stranger')));

    // The founder approves on GitHub: that approval is bound to the current head.
    stub.feed.push(feedback('gh-review-3', 'founder', 'approval', '', t.id));
    poll();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('copy.md'), '# Welcome back\n');
    assert.equal(h.store.listDecisions({ status: ['pending'] }).length, 0, 'the review card was superseded');

    // Feedback after the merge becomes a follow-up task, never a rewrite of history.
    stub.feed.push(feedback('gh-issue-comment-4', 'founder', 'comment', 'Add an emoji?', t.id));
    poll();
    await h.waitFor(() => h.store.listTasks().some((x) => x.origin === 'feedback'), 'follow-up task');
  } finally {
    await h.cleanup();
  }
});

test('a trusted "/approve" comment approves the current head (authors cannot approve their own PR on GitHub)', T, async () => {
  let stub!: StubGitHub;
  const h = await harness({
    config: (c) => {
      c.feedback.trustedActors = ['founder'];
      c.feedback.pollSeconds = 15;
    },
    forge: (local) => (stub = new StubGitHub(local)),
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'package.json', '{"name":"gh"}\n', 'manifest'); // sensitive: needs the founder
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Manifest');
    await h.sup.start();
    await h.waitState(t.id, 'waiting_decision');
    const item = (id: string, author: string, body: string): FeedbackItem => ({
      externalId: id, projectId: 'drill', taskId: t.id, source: 'github', author, body, kind: 'comment', url: null, createdAt: Date.now() + h.clock.skew,
    });
    const [card] = h.store.listDecisions({ status: ['pending'] });
    const code = /\/approve ([A-Z0-9]{6})/.exec(card.why)?.[1];
    assert.ok(code, 'the review card shows the one-time approval code');
    const poll = () => {
      h.clock.skew += 20_000;
      h.sup.wake();
    };
    stub.feed.push(item('gh-issue-comment-10', 'stranger', `/approve ${code}`));
    poll();
    await h.waitFor(() => h.store.listEvents({ types: ['feedback.ignored'] }).length === 1, 'stranger ignored');
    // The founder's login without the code (e.g. an agent using `gh` as the founder) is not enough.
    stub.feed.push(item('gh-issue-comment-11', 'founder', '/approve'));
    stub.feed.push(item('gh-issue-comment-12', 'founder', '/approve WRONG1'));
    poll();
    await h.waitFor(() => h.store.listEvents({ types: ['feedback.approval_rejected'] }).length === 2, 'code-less approvals rejected');
    assert.equal(h.store.getTask(t.id)!.state, 'waiting_decision');
    stub.feed.push(item('gh-issue-comment-13', 'founder', `/approve ${code.toLowerCase()} looks good`));
    poll();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.store.latestReview(t.id)!.verdict, 'human_approve');
  } finally {
    await h.cleanup();
  }
});
