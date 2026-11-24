// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTOPILOT_MARKER,
  ForeignCommitsError,
  GitHubForge,
  PUBLISHED_REF_PREFIX,
  classifyMergeFailure,
  parseJsonStream,
  parsePrUrl,
  prNumberOf,
} from '../src/git/github-forge.ts';
import type { GitHubForgeOptions } from '../src/git/github-forge.ts';
import { git } from '../src/git/git.ts';
import type { CheckResult, Task } from '../src/types.ts';

// Keep the developer's own git configuration (signing, hooks, default branch) out of these tests.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const AUTHOR = ['-c', 'user.name=Test Founder', '-c', 'user.email=founder@example.com'];
const PASSED: CheckResult = { name: 'test', command: ['npm', 'test'], status: 'passed', durationMs: 5, outputTail: '' };
const PR_URL = 'https://github.com/o/r/pull/7';

interface FakeReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  exec?: string[];
}

interface GhCall {
  argv: string[];
  stdin: string;
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-git-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function sh(cwd: string, ...args: string[]): Promise<string> {
  return (await git(args, { cwd })).stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  fs.writeFileSync(path.join(cwd, file), content);
  await sh(cwd, 'add', '-A');
  await sh(cwd, ...AUTHOR, 'commit', '-q', '-m', message);
  return sh(cwd, 'rev-parse', 'HEAD');
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The fake gh behind a #!/bin/sh wrapper, with its call log and canned replies baked in. */
function fakeGh(dir: string, replies: Record<string, FakeReply | FakeReply[]>) {
  const log = path.join(dir, 'gh-calls.jsonl');
  const responses = path.join(dir, 'gh-replies.json');
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(responses, JSON.stringify(replies));
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `FAKE_GH_LOG=${shQuote(log)}`,
      `FAKE_GH_RESPONSES=${shQuote(responses)}`,
      'export FAKE_GH_LOG FAKE_GH_RESPONSES',
      `exec ${shQuote(process.execPath)} ${shQuote(FAKE_GH)} "$@"`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    /** Replace the canned replies (and restart their sequences). */
    reply(next: Record<string, FakeReply | FakeReply[]>) {
      fs.writeFileSync(responses, JSON.stringify(next));
      fs.rmSync(`${responses}.counts.json`, { force: true });
    },
    calls(): GhCall[] {
      if (!fs.existsSync(log)) return [];
      return fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GhCall);
    },
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    projectId: 'demo',
    title: 'Add feature',
    objective: 'do it',
    nonGoals: [],
    acceptanceCriteria: [],
    role: 'full-stack',
    kind: 'build',
    priority: 3,
    risk: 'low',
    ownedPaths: [],
    dependsOn: [],
    state: 'merging',
    stateReason: null,
    origin: 'human',
    hypothesis: null,
    branch: null,
    worktree: null,
    baseCommit: null,
    headCommit: null,
    prNumber: null,
    prUrl: null,
    attempts: 1,
    repairCycles: 0,
    lastSessionId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 1,
    notes: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** A local bare repo plays GitHub's origin; gh is the fake. */
async function setup(t: TestContext, replies: Record<string, FakeReply | FakeReply[]> = {}, over: Partial<GitHubForgeOptions> = {}) {
  const dir = tempDir(t);
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  await sh(seed, 'init', '-q', '-b', 'main');
  await commitFile(seed, 'README.md', 'hello\n', 'initial');
  const origin = path.join(dir, 'origin.git');
  await sh(dir, 'clone', '-q', '--bare', seed, origin);
  const gh = fakeGh(dir, { 'pr create': { stdout: `${PR_URL}\n` }, ...replies });
  const forge = new GitHubForge({
    source: origin,
    home: path.join(dir, 'home'),
    targetBranch: 'main',
    branchPrefix: 'autopilot/',
    strategy: 'squash',
    repo: 'o/r',
    ghBin: gh.bin,
    confirmDelayMs: 5,
    ...over,
  });
  await forge.prepare();
  return { dir, origin, gh, forge };
}

async function taskWithCommit(forge: GitHubForge) {
  const wt = await forge.createWorktree('T-1', 'add feature');
  const head = await commitFile(wt.path, 'feature.txt', 'feature\n', 'add feature');
  const task = makeTask({ id: 'T-1', title: 'Add feature', branch: wt.branch, worktree: wt.path, baseCommit: wt.baseCommit, headCommit: head });
  return { wt, head, task };
}

/** Someone commits on GitHub, on top of origin's copy of `branch` (e.g. "Commit suggestion"). */
async function commitOnGitHub(dir: string, origin: string, branch: string, file: string, content: string, message: string): Promise<string> {
  const clone = fs.mkdtempSync(path.join(dir, 'github-'));
  await sh(dir, 'clone', '-q', '--branch', branch, origin, clone);
  const sha = await commitFile(clone, file, content, message);
  await sh(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  return sha;
}

/** What GitHub does on a squash merge: one commit with `head`'s tree on origin's main. */
async function githubSquash(forge: GitHubForge, origin: string, head: string, subject: string): Promise<string> {
  await sh(forge.repoPath, 'push', '-q', 'origin', `${head}:refs/test/objects`); // make head's objects available there
  const tree = await sh(origin, 'rev-parse', `${head}^{tree}`);
  return sh(origin, ...AUTHOR, 'commit-tree', tree, '-p', await sh(origin, 'rev-parse', 'refs/heads/main'), '-m', subject);
}

/** fake-gh "exec" that moves origin's main, as GitHub does when it merges. */
const moveOriginMain = (origin: string, sha: string) => ['git', `--git-dir=${origin}`, 'update-ref', 'refs/heads/main', sha];

const prView = (state: string, head: string, mergeCommit: string | null = null): FakeReply => ({
  stdout: JSON.stringify({ state, mergeCommit: mergeCommit ? { oid: mergeCommit } : null, headRefOid: head }),
});

test('publish pushes the branch and opens a PR; later publishes force-push over its own pushes and edit it', async (t) => {
  const { origin, gh, forge } = await setup(t, { 'pr edit': {} });
  assert.equal(forge.kind, 'github');
  const { wt, head, task } = await taskWithCommit(forge);

  const first = await forge.publish(task, 'First body');
  assert.deepEqual(first, { prNumber: 7, prUrl: PR_URL });
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), head);
  assert.equal(await sh(forge.repoPath, 'rev-parse', `${PUBLISHED_REF_PREFIX}${wt.branch}`), head, 'the push is recorded as the next lease');
  const [create] = gh.calls();
  assert.deepEqual(create.argv, ['pr', 'create', '--repo', 'o/r', '--base', 'main', '--head', wt.branch, '--title', 'Add feature (T-1)', '--body-file', '-']);
  assert.equal(create.stdin, 'First body');

  // A repair rewrote the branch: the push replaces our own earlier push and the PR body is refreshed.
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '--amend', '-m', 'add feature (repaired)');
  const amended = await forge.headCommit(wt.path);
  const second = await forge.publish({ ...task, prNumber: 7, prUrl: first.prUrl, headCommit: amended }, 'Second body');
  assert.deepEqual(second, first);
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), amended);
  const calls = gh.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].argv, ['pr', 'edit', '7', '--repo', 'o/r', '--body-file', '-']);
  assert.equal(calls[1].stdin, 'Second body');

  // The record of the last push is lost (crash right after a push): our own commit on origin is
  // recognized from the branch history, so publishing still works.
  await sh(forge.repoPath, 'update-ref', '-d', `${PUBLISHED_REF_PREFIX}${wt.branch}`);
  await forge.publish({ ...task, prNumber: 7, prUrl: first.prUrl }, 'Third body');
  assert.equal(await sh(forge.repoPath, 'rev-parse', `${PUBLISHED_REF_PREFIX}${wt.branch}`), amended);
  await sh(forge.repoPath, 'update-ref', '-d', `${PUBLISHED_REF_PREFIX}${wt.branch}`);
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '--amend', '-m', 'add feature (repaired again)');
  await forge.publish({ ...task, prNumber: 7, prUrl: first.prUrl }, 'Fourth body');
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), await forge.headCommit(wt.path));

  await assert.rejects(forge.publish({ ...task, branch: null }, 'x'), /has no branch/);
});

test('publish never overwrites commits that others pushed to the PR branch', async (t) => {
  const { dir, origin, forge } = await setup(t, { 'pr edit': {} });
  const { wt, task } = await taskWithCommit(forge);
  const first = await forge.publish(task, 'Body');
  const suggestion = await commitOnGitHub(dir, origin, wt.branch, 'feature.txt', 'feature, as suggested\n', 'Apply suggestion from founder');

  // A fetch updates refs/remotes/origin/*; the lease must not be fooled by that.
  await forge.prepare();
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '--amend', '-m', 'add feature (repaired without the suggestion)');
  await assert.rejects(forge.publish({ ...task, prNumber: 7, prUrl: first.prUrl }, 'Body 2'), (err: unknown) => {
    assert.ok(err instanceof ForeignCommitsError);
    assert.match(err.message, /refusing to overwrite/);
    return true;
  });
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), suggestion, 'the suggestion is still on the PR branch');
});

test('ensureWorktree fast-forwards onto commits added on GitHub, so the next publish keeps them', async (t) => {
  const { dir, origin, forge } = await setup(t, { 'pr edit': {} });
  const { wt, task } = await taskWithCommit(forge);
  await forge.publish(task, 'Body');
  const suggestion = await commitOnGitHub(dir, origin, wt.branch, 'feature.txt', 'feature, as suggested\n', 'Apply suggestion from founder');

  const again = await forge.ensureWorktree('T-1', wt.branch);
  assert.equal(again.path, wt.path);
  assert.equal(await forge.headCommit(wt.path), suggestion);
  assert.equal(fs.readFileSync(path.join(wt.path, 'feature.txt'), 'utf8'), 'feature, as suggested\n');
  assert.deepEqual(await forge.dirtyPaths(wt.path), []);

  const next = await commitFile(wt.path, 'more.txt', 'more\n', 'builder follow-up');
  await forge.publish({ ...task, prNumber: 7, prUrl: PR_URL }, 'Body 2');
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), next);
  await sh(origin, 'merge-base', '--is-ancestor', suggestion, next); // throws if the suggestion was dropped

  // Local commits are never rewritten: with unpublished local work, a diverged origin is left alone.
  await commitOnGitHub(dir, origin, wt.branch, 'other.txt', 'other\n', 'Another suggestion');
  const local = await commitFile(wt.path, 'local.txt', 'local\n', 'unpublished local work');
  await forge.ensureWorktree('T-1', wt.branch);
  assert.equal(await forge.headCommit(wt.path), local);
});

test('publish adopts a PR that already exists for the branch', async (t) => {
  const { gh, forge } = await setup(t, {
    'pr create': { code: 1, stderr: 'a pull request for branch "autopilot/t-1-add-feature" into branch "main" already exists:\nhttps://github.com/o/r/pull/9\n' },
    'pr edit': {},
  });
  const { task } = await taskWithCommit(forge);
  assert.deepEqual(await forge.publish(task, 'Body'), { prNumber: 9, prUrl: 'https://github.com/o/r/pull/9' });
  assert.deepEqual(
    gh.calls().map((c) => c.argv.slice(0, 3)),
    [
      ['pr', 'create', '--repo'],
      ['pr', 'edit', '9'],
    ],
  );
  gh.reply({ 'pr create': { code: 1, stderr: 'GraphQL: Resource not accessible by integration\n' } });
  await assert.rejects(forge.publish(task, 'Body'), /Resource not accessible/);
});

test('integrate merges through gh with --match-head-commit, then fast-forwards the local target', async (t) => {
  const { origin, gh, forge } = await setup(t);
  const { head, task } = await taskWithCommit(forge);
  await forge.publish(task, 'Body');

  const squash = await githubSquash(forge, origin, head, 'Add feature (T-1)');
  gh.reply({ 'pr merge': { exec: moveOriginMain(origin, squash) }, 'pr view': prView('MERGED', head, squash) });

  const seen: string[] = [];
  const res = await forge.integrate({ ...task, prNumber: 7 }, head, async (cwd) => {
    seen.push(cwd);
    assert.ok(fs.existsSync(path.join(cwd, 'feature.txt')), 'checks run on the locally merged tree');
    return [PASSED];
  });
  assert.equal(res.status, 'merged', res.details);
  assert.equal(res.mergedCommit, squash);
  assert.deepEqual(res.checks, [PASSED]);
  assert.deepEqual(seen, [forge.integrationPath]);
  assert.equal(await forge.targetHead(), squash, 'local target fast-forwarded to origin');
  assert.equal(forge.syncStatus(), 'fast_forwarded');

  const merge = gh.calls().find((c) => c.argv[0] === 'pr' && c.argv[1] === 'merge');
  assert.ok(merge, 'gh pr merge was called');
  assert.deepEqual(merge.argv.slice(0, 8), ['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--match-head-commit', head]);
  assert.ok(merge.argv.includes(`Autopilot-Task: T-1\nAutopilot-Head: ${head}`));
  assert.ok(!merge.argv.includes('--admin'), 'never bypasses branch protection');
});

test('when the source does not confirm the sync after a merge, the merge notes say so and the local target stays', async (t) => {
  class ConfirmFailsAfterMerge extends GitHubForge {
    merged = false;
    protected async gh(args: string[]) {
      if (args[0] === 'pr' && args[1] === 'merge') this.merged = true;
      return super.gh(args);
    }
    protected async remoteBranchHead(branch: string): Promise<string | null> {
      if (this.merged) throw new Error('the source could not be reached');
      return super.remoteBranchHead(branch);
    }
  }
  const dir = tempDir(t);
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  await sh(seed, 'init', '-q', '-b', 'main');
  await commitFile(seed, 'README.md', 'hello\n', 'initial');
  const origin = path.join(dir, 'origin.git');
  await sh(dir, 'clone', '-q', '--bare', seed, origin);
  const gh = fakeGh(dir, { 'pr create': { stdout: `${PR_URL}\n` } });
  const forge = new ConfirmFailsAfterMerge({ source: origin, home: path.join(dir, 'home'), targetBranch: 'main', branchPrefix: 'autopilot/', strategy: 'squash', repo: 'o/r', ghBin: gh.bin, confirmDelayMs: 5 });
  await forge.prepare();
  const { head, task } = await taskWithCommit(forge);
  const before = await forge.targetHead();
  await forge.publish(task, 'Body');
  const squash = await githubSquash(forge, origin, head, 'Add feature (T-1)');
  gh.reply({ 'pr merge': { exec: moveOriginMain(origin, squash) }, 'pr view': prView('MERGED', head, squash) });
  const res = await forge.integrate({ ...task, prNumber: 7 }, head, async () => [PASSED]);
  assert.equal(res.status, 'merged', res.details);
  assert.match(res.details, /the source did not confirm origin's main, so the local main was not updated/);
  assert.equal(forge.syncStatus(), 'unconfirmed');
  assert.equal(await forge.targetHead(), before);
});

test('integrate pushes the checked head before merging when the last publish did not get through', async (t) => {
  const { origin, gh, forge } = await setup(t, { 'pr edit': {} });
  const { wt, task } = await taskWithCommit(forge);
  await forge.publish(task, 'Body');
  const h2 = await commitFile(wt.path, 'more.txt', 'more\n', 'more work'); // its publish "failed"

  const squash = await githubSquash(forge, origin, h2, 'Add feature (T-1)');
  gh.reply({
    // GitHub shows the new head on the PR, then the merge.
    'pr view': [prView('OPEN', h2), prView('MERGED', h2, squash)],
    'pr merge': { exec: moveOriginMain(origin, squash) },
  });
  const res = await forge.integrate({ ...task, prNumber: 7, headCommit: h2 }, h2, async () => [PASSED]);
  assert.equal(res.status, 'merged', res.details);
  assert.equal(res.mergedCommit, squash);
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), h2, 'the PR branch shows the checked head');
  assert.deepEqual(
    gh.calls().map((c) => c.argv.slice(0, 2).join(' ')),
    ['pr create', 'pr view', 'pr merge', 'pr view'],
  );
});

test('integrate opens the pull request itself when publish never managed to', async (t) => {
  const { origin, gh, forge } = await setup(t);
  const { head, task } = await taskWithCommit(forge);
  const squash = await githubSquash(forge, origin, head, 'Add feature (T-1)');
  gh.reply({
    'pr create': { stdout: `${PR_URL}\n` },
    'pr merge': { exec: moveOriginMain(origin, squash) },
    'pr view': prView('MERGED', head, squash),
  });
  const res = await forge.integrate(task, head, async () => [PASSED]);
  assert.equal(res.status, 'merged', res.details);
  assert.equal(res.mergedCommit, squash);
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${task.branch}`), head, 'the branch was pushed first');
  const calls = gh.calls();
  assert.deepEqual(calls.map((c) => c.argv.slice(0, 3).join(' ')), ['pr create --repo', 'pr merge 7', 'pr view 7']);
  assert.match(calls[0].stdin, /Opened by StayOn Autopilot when T-1 was ready to merge/);
});

test('integrate never overwrites commits others pushed to the PR; the task goes back for repair', async (t) => {
  const { dir, origin, gh, forge } = await setup(t, { 'pr edit': {} });
  const { wt, head, task } = await taskWithCommit(forge);
  await forge.publish(task, 'Body');
  const suggestion = await commitOnGitHub(dir, origin, wt.branch, 'feature.txt', 'feature, as suggested\n', 'Apply suggestion from founder');
  const pr = { ...task, prNumber: 7, prUrl: PR_URL };

  const seen: string[] = [];
  const res = await forge.integrate(pr, head, async (cwd) => {
    seen.push(cwd);
    return [PASSED];
  });
  assert.equal(res.status, 'conflict');
  assert.match(res.details, /commits the autopilot did not push/);
  assert.deepEqual(seen, [], 'no checks for a head GitHub would not merge');
  assert.equal(await sh(origin, 'rev-parse', `refs/heads/${wt.branch}`), suggestion);
  assert.ok(!gh.calls().some((c) => c.argv[1] === 'merge'));

  // The repair run starts from the suggestion, and then that head merges.
  await forge.ensureWorktree('T-1', wt.branch);
  assert.equal(await forge.headCommit(wt.path), suggestion);
  const squash = await githubSquash(forge, origin, suggestion, 'Add feature (T-1)');
  gh.reply({ 'pr merge': { exec: moveOriginMain(origin, squash) }, 'pr view': prView('MERGED', suggestion, squash) });
  const merged = await forge.integrate({ ...pr, headCommit: suggestion }, suggestion, async () => [PASSED]);
  assert.equal(merged.status, 'merged', merged.details);
  assert.equal(await forge.targetHead(), squash);
});

test('a merge is only reported once GitHub confirms it', async (t) => {
  const { origin, gh, forge } = await setup(t, { 'pr edit': {} });
  const { head, task } = await taskWithCommit(forge);
  await forge.publish(task, 'Body');
  const pr = { ...task, prNumber: 7, prUrl: PR_URL };
  const before = await forge.targetHead();
  const views = () => gh.calls().filter((c) => c.argv[1] === 'view').length;

  // gh exits 0 after only queueing the PR, and the state cannot be read: not merged.
  gh.reply({ 'pr merge': { stdout: '! Pull request #7 will be added to the merge queue\n' }, 'pr view': { code: 1, stderr: 'HTTP 502: Bad Gateway\n' } });
  const unconfirmed = await forge.integrate(pr, head, async () => [PASSED]);
  assert.equal(unconfirmed.status, 'error');
  assert.equal(unconfirmed.mergedCommit, null);
  assert.match(unconfirmed.details, /could not be confirmed/);
  assert.equal(views(), 3, 'the view is retried');
  assert.equal(await forge.targetHead(), before);

  // Still open after gh returned (merge queue, auto-merge): blocked, not merged.
  gh.reply({ 'pr merge': {}, 'pr view': prView('OPEN', head) });
  const queued = await forge.integrate(pr, head, async () => [PASSED]);
  assert.equal(queued.status, 'blocked_by_forge');
  assert.match(queued.details, /merge queue/);

  // The view fails once, then confirms; without a merge commit in the answer, origin's freshly
  // fetched head is reported.
  const squash = await githubSquash(forge, origin, head, 'Add feature (T-1)');
  gh.reply({ 'pr merge': { exec: moveOriginMain(origin, squash) }, 'pr view': [{ code: 1, stderr: 'HTTP 502\n' }, prView('MERGED', head)] });
  const merged = await forge.integrate(pr, head, async () => [PASSED]);
  assert.equal(merged.status, 'merged', merged.details);
  assert.equal(merged.mergedCommit, squash);
  assert.equal(await forge.targetHead(), squash);
});

test('integrate maps a branch-protection refusal to blocked_by_forge and leaves the target alone', async (t) => {
  const { gh, forge } = await setup(t, {
    'pr merge': { code: 1, stderr: 'X Pull request o/r#7 is not mergeable: required status checks "ci" are expected.\n' },
  });
  const { head, task } = await taskWithCommit(forge);
  const before = await forge.targetHead();

  const res = await forge.integrate({ ...task, prNumber: 7 }, head, async () => [PASSED]);
  assert.equal(res.status, 'blocked_by_forge');
  assert.equal(res.mergedCommit, null);
  assert.match(res.details, /required status checks/);
  assert.deepEqual(res.checks, [PASSED], 'local checks are still reported');
  assert.equal(await forge.targetHead(), before);
  assert.equal(await sh(forge.integrationPath, 'rev-parse', 'HEAD'), before, 'the dry-run merge was discarded');
  assert.equal(await sh(forge.integrationPath, 'status', '--porcelain'), '');
  const merge = gh.calls().find((c) => c.argv[1] === 'merge');
  assert.ok(merge?.argv.includes('--match-head-commit'));
});

test('the merge strategy uses --merge; a head GitHub does not show yet is retried, not re-checked', async (t) => {
  const { gh, forge } = await setup(t, {
    'pr merge': { code: 1, stderr: 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n' },
  }, { strategy: 'merge' });
  const { head, task } = await taskWithCommit(forge);
  const res = await forge.integrate({ ...task, prNumber: 7 }, head, async () => [PASSED]);
  assert.equal(res.status, 'error');
  assert.match(res.details, /does not show .* as the head of PR #7/);
  const merge = gh.calls().find((c) => c.argv[1] === 'merge');
  assert.deepEqual(merge?.argv.slice(0, 8), ['pr', 'merge', '7', '--repo', 'o/r', '--merge', '--match-head-commit', head]);
});

test('integrate treats a PR that GitHub already merged as merged', async (t) => {
  const { gh, forge } = await setup(t);
  const { head, task } = await taskWithCommit(forge);
  const mergeCommit = 'f'.repeat(40);
  gh.reply({
    'pr merge': { code: 1, stderr: 'X Pull request o/r#7 was already merged\n' },
    'pr view': prView('MERGED', head, mergeCommit),
  });
  const res = await forge.integrate({ ...task, prNumber: 7 }, head, async () => [PASSED]);
  assert.equal(res.status, 'merged', res.details);
  assert.equal(res.mergedCommit, mergeCommit);
  assert.match(res.details, /already merged/);

  // Merged, but at another head than the one checked here: not this task's merge.
  gh.reply({ 'pr merge': { code: 1, stderr: 'X Pull request o/r#7 was already merged\n' }, 'pr view': prView('MERGED', 'e'.repeat(40), mergeCommit) });
  const other = await forge.integrate({ ...task, prNumber: 7 }, head, async () => [PASSED]);
  assert.equal(other.status, 'error');
  assert.match(other.details, /merged at eeeeeeeeee/);
});

test('integrate stops before GitHub on a stale head or failing local checks', async (t) => {
  const { gh, forge } = await setup(t, { 'pr merge': {} });
  const { wt, head, task } = await taskWithCommit(forge);

  const stale = await forge.integrate({ ...task, prNumber: 7 }, wt.baseCommit, async () => [PASSED]);
  assert.equal(stale.status, 'stale_head');

  const failing = await forge.integrate({ ...task, prNumber: 7 }, head, async () => [{ ...PASSED, status: 'failed' }]);
  assert.equal(failing.status, 'checks_failed');

  assert.deepEqual(gh.calls(), [], 'gh was never asked to merge');
});

test('merge failures are classified', () => {
  const cases: [string, string][] = [
    ['X Pull request o/r#7 is not mergeable: required status checks "ci" are expected.', 'blocked_by_forge'],
    ['GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)', 'blocked_by_forge'],
    ['GraphQL: Changes must be made through a pull request. Protected branch update failed', 'blocked_by_forge'],
    ['GraphQL: Repository rule violations found', 'blocked_by_forge'],
    ['GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)', 'blocked_by_forge'],
    ['X Pull request o/r#7 is not mergeable: the base branch policy prohibits the merge.', 'blocked_by_forge'],
    ['X Pull request o/r#7 is not mergeable: the merge commit cannot be cleanly created.', 'conflict'],
    ['X Pull request o/r#7 is not mergeable: the head branch is not up to date with the base branch.', 'conflict'],
    ['GraphQL: Head branch is out of date. Review and try the merge again. (mergePullRequest)', 'conflict'],
    ['GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)', 'stale_head'],
    ['error connecting to api.github.com', 'error'],
    ['unknown flag: --match-head-commit', 'error'],
  ];
  for (const [text, status] of cases) assert.equal(classifyMergeFailure(text), status, text);
});

test('comment posts with the autopilot marker; tasks without a PR are skipped', async (t) => {
  const { gh, forge } = await setup(t, { 'pr comment': {} });
  const task = makeTask({ branch: 'autopilot/t-1-x', prNumber: 7 });
  await forge.comment(task, 'Checks passed.');
  await forge.comment({ ...task, prNumber: null }, 'nobody hears this');
  const calls = gh.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['pr', 'comment', '7', '--repo', 'o/r', '--body-file', '-']);
  assert.equal(calls[0].stdin, `Checks passed.\n\n${AUTOPILOT_MARKER}`);
});

test('pollFeedback maps comments, reviews and review comments; skips our own and old items', async (t) => {
  const since = Date.parse('2026-11-20T00:00:00Z');
  const fresh = '2026-11-21T10:00:00Z';
  const later = '2026-11-21T11:00:00Z';
  const old = '2026-11-19T10:00:00Z';
  const user = (login: string) => ({ login });
  const issue = (n: number) => `https://api.github.com/repos/o/r/issues/${n}`;
  const pull = (n: number) => `https://api.github.com/repos/o/r/pulls/${n}`;
  // Repository-wide comment lists, two pages joined the way `gh api --paginate` prints them.
  const issueComments =
    JSON.stringify([
      { id: 1, issue_url: issue(7), user: user('founder'), body: 'Can we use the brand color?', created_at: fresh, html_url: 'https://github.com/o/r/pull/7#issuecomment-1' },
      { id: 2, issue_url: issue(7), user: user('autopilot-bot'), body: `Checks passed.\n\n${AUTOPILOT_MARKER}`, created_at: fresh },
      { id: 4, issue_url: issue(99), user: user('someone'), body: 'An unrelated issue', created_at: fresh },
    ]) + JSON.stringify([{ id: 3, issue_url: issue(7), user: user('founder'), body: 'old note', created_at: old }]);
  const reviewComments = JSON.stringify([
    { id: 20, pull_request_url: pull(7), user: user('lead'), body: 'Rename this?', path: 'src/a.ts', line: 12, created_at: fresh, html_url: 'https://github.com/o/r/pull/7#discussion_r20' },
    { id: 21, pull_request_url: pull(7), user: user('lead'), body: `Done. ${AUTOPILOT_MARKER}`, path: 'src/a.ts', line: 3, created_at: fresh },
    { id: 22, pull_request_url: pull(8), user: user('lead'), body: 'Late nit after the merge', path: 'b.ts', line: 1, created_at: later },
  ]);
  const reviews = JSON.stringify([
    { id: 10, user: user('lead'), body: '', state: 'CHANGES_REQUESTED', submitted_at: fresh, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-10' },
    { id: 11, user: user('lead'), body: 'Ship it', state: 'APPROVED', submitted_at: fresh, commit_id: 'abc123' },
    { id: 12, user: user('lead'), body: '', state: 'COMMENTED', submitted_at: fresh },
    { id: 13, user: user('lead'), body: 'stale thought', state: 'COMMENTED', submitted_at: old },
    { id: 14, user: user('lead'), body: 'draft', state: 'PENDING' },
  ]);
  const { gh, forge } = await setup(t, {
    'api repos/o/r/issues/comments': { stdout: issueComments },
    'api repos/o/r/pulls/comments': { stdout: reviewComments },
    'api repos/o/r/pulls/7/reviews': { stdout: reviews },
    'api repos/o/r/pulls/9/reviews': { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
  });
  const open = makeTask({ id: 'T-1', projectId: 'demo', state: 'review_ready', branch: 'autopilot/t-1-x', prNumber: 7 });
  const merged = makeTask({ id: 'T-3', state: 'integrated', branch: 'autopilot/t-3-x', prNumber: 8 });
  const gone = makeTask({ id: 'T-4', state: 'waiting_decision', branch: 'autopilot/t-4-x', prNumber: 9 });
  const withoutPr = makeTask({ id: 'T-2', branch: null, prNumber: null });

  const items = await forge.pollFeedback(since, [open, merged, gone, withoutPr]);
  const at = Date.parse(fresh);
  const base = { projectId: 'demo', taskId: 'T-1', source: 'github' as const, createdAt: at, commitId: null };
  assert.deepEqual(items, [
    { ...base, externalId: 'gh-issue-comment-1', author: 'founder', body: 'Can we use the brand color?', kind: 'question', url: 'https://github.com/o/r/pull/7#issuecomment-1' },
    { ...base, externalId: 'gh-review-comment-20', author: 'lead', body: '[src/a.ts:12] Rename this?', kind: 'question', url: 'https://github.com/o/r/pull/7#discussion_r20' },
    { ...base, externalId: 'gh-review-10', author: 'lead', body: '', kind: 'change_request', url: 'https://github.com/o/r/pull/7#pullrequestreview-10' },
    { ...base, externalId: 'gh-review-11', author: 'lead', body: 'Ship it', kind: 'approval', url: null, commitId: 'abc123' },
    { ...base, taskId: 'T-3', createdAt: Date.parse(later), externalId: 'gh-review-comment-22', author: 'lead', body: '[b.ts:1] Late nit after the merge', kind: 'comment', url: null },
  ]);

  // Two repository-wide calls, plus reviews for PRs still in play (not the merged one).
  const iso = '2026-11-20T00:00:00.000Z';
  assert.deepEqual(
    gh.calls().map((c) => c.argv),
    [
      ['api', '--paginate', `repos/o/r/issues/comments?since=${iso}&per_page=100`],
      ['api', '--paginate', `repos/o/r/pulls/comments?since=${iso}&per_page=100`],
      ['api', '--paginate', 'repos/o/r/pulls/7/reviews?per_page=100'],
      ['api', '--paginate', 'repos/o/r/pulls/9/reviews?per_page=100'],
    ],
  );

  // Any other failure surfaces, so the caller does not advance its cursor past unseen feedback.
  gh.reply({ 'api repos/o/r/issues/comments': { stdout: '[]' }, 'api repos/o/r/pulls/comments': { code: 1, stderr: 'gh: API rate limit exceeded (HTTP 403)\n' } });
  await assert.rejects(forge.pollFeedback(since, [open]), /rate limit/);
  assert.deepEqual(await forge.pollFeedback(since, [withoutPr]), [], 'nothing to ask without PRs');
});

test('JSON stream, PR URL and PR number parsing', () => {
  assert.deepEqual(parseJsonStream(''), []);
  assert.deepEqual(parseJsonStream('[]\n'), []);
  assert.deepEqual(parseJsonStream('[{"a":1}][{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseJsonStream('[{"a":1}]\n[{"a":2}]\n'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseJsonStream('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseJsonStream('[{"body":"tricky ][ \\"} text"}][]'), [{ body: 'tricky ][ "} text' }]);
  assert.throws(() => parseJsonStream('[{"a":1}'), /truncated/);
  assert.throws(() => parseJsonStream('oops'), /unexpected/);

  assert.deepEqual(parsePrUrl('Creating pull request for x into main\n\nhttps://github.com/o/r/pull/12\n'), {
    prNumber: 12,
    prUrl: 'https://github.com/o/r/pull/12',
  });
  assert.equal(parsePrUrl('no url here'), null);

  assert.equal(prNumberOf({ issue_url: 'https://api.github.com/repos/o/r/issues/12' }), 12);
  assert.equal(prNumberOf({ pull_request_url: 'https://ghe.example.com/api/v3/repos/o/r/pulls/5' }), 5);
  assert.equal(prNumberOf({ html_url: 'https://github.com/o/r/pull/3#discussion_r1' }), 3);
  assert.equal(prNumberOf({ html_url: 'https://github.com/o/r/issues/3#issuecomment-1' }), null);
  assert.equal(prNumberOf('nope'), null);

  assert.throws(
    () => new GitHubForge({ source: '/tmp/x', home: '/tmp/y', targetBranch: 'main', branchPrefix: 'autopilot/', strategy: 'squash', repo: 'not a repo' }),
    /owner\/name/,
  );
});
