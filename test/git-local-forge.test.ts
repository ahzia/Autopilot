// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalForge, ORIGIN_FETCH_REFSPEC, auditRepoConfig, findIntegrationCommit, oneLine } from '../src/git/local-forge.ts';
import type { LocalForgeOptions } from '../src/git/local-forge.ts';
import {
  GitError,
  git,
  gitEnv,
  isSafeBranchName,
  parseConfigList,
  parseNameStatus,
  parseNumstat,
  parseStatusPorcelain,
  parseTrailers,
  parseWorktreeList,
  redactUrlCredentials,
  revParse,
  runCommand,
} from '../src/git/git.ts';
import type { GitOptions } from '../src/git/git.ts';
import type { CheckResult, Task } from '../src/types.ts';
import { SAFE_GIT_FLAGS, findSecrets, scrubbedEnv } from '../src/util.ts';

// Keep the developer's own git configuration (signing, hooks, default branch) out of these tests.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// A worker run's own git ignores replace refs (GIT_NO_REPLACE_OBJECTS, GIT_GRAFT_FILE, and
// core.useReplaceRefs=false in GIT_CONFIG_PARAMETERS): keep that out of the plain git these tests
// compare the forge with, or they fail when a builder runs them.
for (const key of ['GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete process.env[key];

const AUTHOR = ['-c', 'user.name=Test Founder', '-c', 'user.email=founder@example.com'];

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-git-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function sh(cwd: string, ...args: string[]): Promise<string> {
  return (await git(args, { cwd })).stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  await sh(cwd, 'add', '-A');
  await sh(cwd, ...AUTHOR, 'commit', '-q', '-m', message);
  return sh(cwd, 'rev-parse', 'HEAD');
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

/** Source repo (non-bare, main checked out) plus a prepared forge. */
async function setup(t: TestContext, over: Partial<LocalForgeOptions> = {}) {
  const dir = tempDir(t);
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  await sh(source, 'init', '-q', '-b', 'main');
  await commitFile(source, 'README.md', 'line one\nline two\n', 'initial');
  const forge = new LocalForge({
    source,
    home: path.join(dir, 'home'),
    targetBranch: 'main',
    branchPrefix: 'autopilot/',
    strategy: 'squash',
    pushIntegratedTo: null,
    ...over,
  });
  await forge.prepare();
  return { dir, source, forge };
}

/** A task worktree with one commit writing `file`. */
async function buildTask(forge: LocalForge, id: string, file: string, content: string) {
  const wt = await forge.createWorktree(id, `change ${file}`);
  const head = await commitFile(wt.path, file, content, `${id}: change ${file}`);
  const task = makeTask({ id, title: `Change ${file}`, branch: wt.branch, worktree: wt.path, baseCommit: wt.baseCommit, headCommit: head });
  return { wt, head, task };
}

function checks(status: CheckResult['status'] = 'passed', seen: string[] = []) {
  return async (cwd: string): Promise<CheckResult[]> => {
    seen.push(cwd);
    return [{ name: 'test', command: ['npm', 'test'], status, durationMs: 5, outputTail: '' }];
  };
}

/** An executable stand-in for ssh (GIT_SSH) that records its pid and environment, then hangs. */
function fakeSsh(dir: string): { script: string; out: string } {
  const script = path.join(dir, 'fake-ssh.cjs');
  const out = path.join(dir, 'fake-ssh.json');
  const shebang = /\s/.test(process.execPath) ? '#!/usr/bin/env node' : `#!${process.execPath}`;
  fs.writeFileSync(
    script,
    `${shebang}\nrequire('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, prompt: process.env.GIT_TERMINAL_PROMPT ?? null }));\nsetTimeout(() => {}, 30000);\n`,
  );
  fs.chmodSync(script, 0o755);
  return { script, out };
}

async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: gone
    }
    if (Date.now() > deadline) assert.fail(`process ${pid} is still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('prepare makes a private bare clone that tracks the source', async (t) => {
  const { source, forge } = await setup(t);
  assert.equal(forge.kind, 'local');
  assert.equal(forge.repoPath, path.join(forge.home, 'repo.git'));
  assert.equal(await sh(forge.repoPath, 'rev-parse', '--is-bare-repository'), 'true');
  const sourceMain = await sh(source, 'rev-parse', 'main');
  assert.equal(await forge.targetHead(), sourceMain);
  assert.equal(await sh(forge.repoPath, 'rev-parse', 'refs/remotes/origin/main'), sourceMain);
  assert.equal(forge.syncStatus(), 'up_to_date');
  assert.equal(await forge.prepare(), forge.repoPath, 'a second prepare reuses the clone');
  assert.equal(forge.syncStatus(), 'up_to_date');

  const wrong = new LocalForge({
    source,
    home: path.join(path.dirname(forge.home), 'home2'),
    targetBranch: 'develop',
    branchPrefix: 'autopilot/',
    strategy: 'squash',
    pushIntegratedTo: null,
  });
  await assert.rejects(wrong.prepare(), /has no branch "develop"/);
});

test('createWorktree branches from the target; headCommit, dirtyPaths and diff describe the work', async (t) => {
  const { forge } = await setup(t);
  const base = await forge.targetHead();
  const wt = await forge.createWorktree('T-7', 'Add onboarding flow!');
  assert.equal(wt.branch, 'autopilot/t-7-add-onboarding-flow');
  assert.equal(wt.path, path.join(forge.home, 'worktrees', 'T-7'));
  assert.equal(wt.baseCommit, base);
  assert.equal(await forge.headCommit(wt.path), base);
  assert.deepEqual(await forge.dirtyPaths(wt.path), []);

  fs.writeFileSync(path.join(wt.path, 'README.md'), 'line one\nline 2\n');
  fs.mkdirSync(path.join(wt.path, 'src'));
  fs.writeFileSync(path.join(wt.path, 'src', 'onboarding.ts'), 'export const steps = 3;\nexport const done = false;\n');
  fs.writeFileSync(path.join(wt.path, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
  assert.deepEqual((await forge.dirtyPaths(wt.path)).sort(), ['README.md', 'logo.bin', 'src/onboarding.ts']);

  await sh(wt.path, 'add', '-A');
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '-m', 'onboarding');
  const head = await forge.headCommit(wt.path);
  assert.notEqual(head, base);
  assert.deepEqual(await forge.dirtyPaths(wt.path), []);
  assert.equal(await forge.targetHead(), base, 'task commits never move the target');

  const d = await forge.diff(base, head);
  assert.equal(d.baseCommit, base);
  assert.equal(d.headCommit, head);
  assert.equal(d.truncated, false);
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.deepEqual(byPath['README.md'], { path: 'README.md', added: 1, deleted: 1, status: 'M' });
  assert.deepEqual(byPath['src/onboarding.ts'], { path: 'src/onboarding.ts', added: 2, deleted: 0, status: 'A' });
  assert.deepEqual(byPath['logo.bin'], { path: 'logo.bin', added: 0, deleted: 0, status: 'A' }, 'binary files count 0/0');
  assert.equal(d.files.length, 3);
  assert.match(d.patch, /\+export const steps = 3;/);

  const small = await forge.diff(base, head, 120);
  assert.equal(small.truncated, true);
  assert.ok(Buffer.byteLength(small.patch) <= 120);
  assert.ok(small.patch === '' || small.patch.endsWith('\n'), 'cut at a line boundary');

  // Renames are listed as delete + add, so path policies see both sides.
  await sh(wt.path, 'mv', 'README.md', 'docs.md');
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '-m', 'rename');
  const renamed = await forge.diff(head, await forge.headCommit(wt.path));
  assert.deepEqual(renamed.files.map((f) => [f.path, f.status]).sort(), [
    ['README.md', 'D'],
    ['docs.md', 'A'],
  ]);
});

test('diff stops reading a huge patch once the limit is reached', async (t) => {
  const { forge } = await setup(t);
  const base = await forge.targetHead();
  const wt = await forge.createWorktree('T-1', 'vendored');
  fs.writeFileSync(path.join(wt.path, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(60_000)); // 6 MB
  await sh(wt.path, 'add', '-A');
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '-m', 'vendor everything');
  const d = await forge.diff(base, await forge.headCommit(wt.path), 4096);
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.patch) <= 4096 && d.patch.endsWith('\n'));
  assert.deepEqual(d.files, [{ path: 'big.txt', added: 60_000, deleted: 0, status: 'A' }]);
});

test('integrate squashes onto the target with trailers, and is idempotent', async (t) => {
  const { forge } = await setup(t);
  const before = await forge.targetHead();
  const { head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');

  const seen: string[] = [];
  const res = await forge.integrate(task, head, async (cwd) => {
    seen.push(cwd);
    assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'feature\n', 'checks see the merged tree');
    return checks()(cwd);
  });
  assert.equal(res.status, 'merged', res.details);
  assert.deepEqual(seen, [forge.integrationPath]);
  assert.equal(res.checks.length, 1);
  const target = await forge.targetHead();
  assert.equal(res.mergedCommit, target);
  assert.notEqual(target, before);

  const message = await sh(forge.repoPath, 'log', '-1', '--format=%B', 'main');
  assert.equal(message, `Change feature.txt (T-1)\n\nAutopilot-Task: T-1\nAutopilot-Head: ${head}`);
  assert.equal(await sh(forge.repoPath, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'), 'StayOn Autopilot <autopilot@localhost>|StayOn Autopilot <autopilot@localhost>');
  assert.equal(await sh(forge.repoPath, 'rev-list', '--parents', '-n1', 'main'), `${target} ${before}`, 'squash: a single parent');
  assert.equal(await sh(forge.repoPath, 'show', 'main:feature.txt'), 'feature');

  const again = await forge.integrate(task, head, checks('passed', seen));
  assert.deepEqual(again, { status: 'merged', mergedCommit: target, checks: [], details: 'already integrated', foundOnTarget: true });
  assert.equal(seen.length, 1, 'no second check run');
  assert.equal(await forge.targetHead(), target);
});

test('merge strategy records a merge commit by the configured identity', async (t) => {
  const { forge } = await setup(t, { strategy: 'merge', identity: { name: 'Bot', email: 'bot@example.com' } });
  const before = await forge.targetHead();
  const { head, task } = await buildTask(forge, 'T-2', 'feature.txt', 'feature\n');
  const res = await forge.integrate(task, head, checks());
  assert.equal(res.status, 'merged', res.details);
  assert.equal(await sh(forge.repoPath, 'rev-list', '--parents', '-n1', 'main'), `${res.mergedCommit} ${before} ${head}`);
  assert.equal(await sh(forge.repoPath, 'log', '-1', '--format=%an <%ae>', 'main'), 'Bot <bot@example.com>');
  const again = await forge.integrate(task, head, checks());
  assert.equal(again.details, 'already integrated');
  assert.equal(again.mergedCommit, res.mergedCommit);
});

test('a task commit cannot fake an earlier integration of another task (merge strategy)', async (t) => {
  const { forge } = await setup(t, { strategy: 'merge' });
  const two = await buildTask(forge, 'T-2', 'two.txt', 'two\n');

  // T-1's builder writes T-2's subject and trailers into its own commit; with the merge strategy
  // that commit becomes reachable from the target through the merge's second parent.
  const wt1 = await forge.createWorktree('T-1', 'spoof');
  fs.writeFileSync(path.join(wt1.path, 'one.txt'), 'one\n');
  await sh(wt1.path, 'add', '-A');
  await sh(wt1.path, ...AUTHOR, 'commit', '-q', '-m', `Change two.txt (T-2)\n\nAutopilot-Task: T-2\nAutopilot-Head: ${two.head}`);
  const one = await forge.integrate(makeTask({ id: 'T-1', branch: wt1.branch }), await forge.headCommit(wt1.path), checks());
  assert.equal(one.status, 'merged', one.details);

  const res = await forge.integrate(two.task, two.head, checks());
  assert.equal(res.status, 'merged', res.details);
  assert.notEqual(res.details, 'already integrated');
  assert.equal(await sh(forge.repoPath, 'show', 'main:two.txt'), 'two', "T-2's work really landed");
});

test('a conflicting second task reports conflict and leaves the target unchanged', async (t) => {
  const { forge } = await setup(t);
  const one = await buildTask(forge, 'T-1', 'README.md', 'line ONE from T-1\nline two\n');
  const two = await buildTask(forge, 'T-2', 'README.md', 'line one by T-2\nline two\n');

  const first = await forge.integrate(one.task, one.head, checks());
  assert.equal(first.status, 'merged', first.details);
  const target = await forge.targetHead();

  const seen: string[] = [];
  const second = await forge.integrate(two.task, two.head, checks('passed', seen));
  assert.equal(second.status, 'conflict');
  assert.equal(second.mergedCommit, null);
  assert.match(second.details, /README\.md/);
  assert.deepEqual(seen, [], 'no checks on a conflicted merge');
  assert.equal(await forge.targetHead(), target);
  assert.equal(await sh(forge.integrationPath, 'status', '--porcelain'), '', 'integration worktree is clean again');
  assert.equal(await sh(forge.integrationPath, 'rev-parse', 'HEAD'), target);
});

test('failing or crashing checks leave the target unchanged', async (t) => {
  const { forge } = await setup(t);
  const before = await forge.targetHead();
  const { head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');

  const res = await forge.integrate(task, head, checks('failed'));
  assert.equal(res.status, 'checks_failed');
  assert.equal(res.mergedCommit, null);
  assert.deepEqual(res.checks.map((c) => c.status), ['failed']);
  assert.match(res.details, /test \(failed\)/);
  assert.equal(await forge.targetHead(), before);
  assert.equal(fs.existsSync(path.join(forge.integrationPath, 'feature.txt')), false, 'merged files are reset');

  const timeout = await forge.integrate(task, head, checks('timeout'));
  assert.equal(timeout.status, 'checks_failed');

  const crashed = await forge.integrate(task, head, async () => {
    throw new Error('npm exploded');
  });
  assert.equal(crashed.status, 'error');
  assert.match(crashed.details, /npm exploded/);
  assert.equal(await forge.targetHead(), before);

  // Skipped checks do not block, and the same head can still be integrated afterwards.
  const ok = await forge.integrate(task, head, checks('skipped'));
  assert.equal(ok.status, 'merged', ok.details);
});

test('a target that moves while the checks run is never overwritten (compare-and-swap)', async (t) => {
  const { forge } = await setup(t);
  const { head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');
  let moved = '';
  const res = await forge.integrate(task, head, async (cwd) => {
    // Someone else moves the target while the checks run.
    const tree = await sh(forge.repoPath, 'rev-parse', 'main^{tree}');
    moved = await sh(forge.repoPath, ...AUTHOR, 'commit-tree', tree, '-p', 'main', '-m', 'moved elsewhere');
    await sh(forge.repoPath, 'update-ref', 'refs/heads/main', moved);
    return checks()(cwd);
  });
  assert.equal(res.status, 'stale_head');
  assert.equal(res.details, 'target moved');
  assert.equal(res.mergedCommit, null);
  assert.equal(await forge.targetHead(), moved, 'the other writer wins');

  // The next attempt merges onto the moved target.
  const again = await forge.integrate(task, head, checks());
  assert.equal(again.status, 'merged', again.details);
  assert.equal(await sh(forge.repoPath, 'rev-parse', 'main^'), moved);
});

test('stale heads and missing branches are reported, not thrown', async (t) => {
  const { forge } = await setup(t);
  const before = await forge.targetHead();
  const { wt, head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');
  const seen: string[] = [];

  const stale = await forge.integrate(task, wt.baseCommit, checks('passed', seen));
  assert.equal(stale.status, 'stale_head');
  assert.match(stale.details, new RegExp(head));

  const noBranch = await forge.integrate({ ...task, branch: null }, head, checks('passed', seen));
  assert.equal(noBranch.status, 'error');
  assert.match(noBranch.details, /has no branch/);

  const gone = await forge.integrate({ ...task, branch: 'autopilot/t-1-missing' }, head, checks('passed', seen));
  assert.equal(gone.status, 'error');
  assert.match(gone.details, /not found/);

  const bogus = await forge.integrate(task, '--upload-pack=evil', checks('passed', seen));
  assert.equal(bogus.status, 'error');

  assert.deepEqual(seen, []);
  assert.equal(await forge.targetHead(), before);
});

test('a branch whose changes are already on the target integrates as "no changes"', async (t) => {
  const { forge } = await setup(t);
  const wt = await forge.createWorktree('T-3', 'noop');
  await commitFile(wt.path, 'tmp.txt', 'x\n', 'add tmp');
  fs.rmSync(path.join(wt.path, 'tmp.txt'));
  await sh(wt.path, 'add', '-A');
  await sh(wt.path, ...AUTHOR, 'commit', '-q', '-m', 'remove tmp');
  const head = await forge.headCommit(wt.path);
  const before = await forge.targetHead();
  const res = await forge.integrate(makeTask({ id: 'T-3', branch: wt.branch }), head, checks());
  assert.deepEqual(res, { status: 'merged', mergedCommit: before, checks: [], details: 'no changes', foundOnTarget: true });
  assert.equal(await forge.targetHead(), before);
});

test('pushIntegratedTo pushes integrated commits to a branch of the source', async (t) => {
  const { source, forge } = await setup(t, { pushIntegratedTo: 'autopilot/main' });
  const sourceMain = await sh(source, 'rev-parse', 'main');
  const { head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');
  const res = await forge.integrate(task, head, checks());
  assert.equal(res.status, 'merged', res.details);
  assert.equal(await sh(source, 'branch', '--list', 'autopilot/main'), '', 'integrate() itself pushes nothing');
  assert.equal(await forge.pushIntegrated(res.mergedCommit!), 'pushed to autopilot/main');
  assert.equal(await sh(source, 'rev-parse', 'refs/heads/autopilot/main'), res.mergedCommit);
  assert.equal(await sh(source, 'rev-parse', 'main'), sourceMain, "the source's checked-out branch is untouched");
  assert.equal(await forge.pushIntegrated(res.mergedCommit!), '', 'nothing left to push');

  // A refused push is a warning, not a failed integration.
  const { forge: refused } = await setup(t, { pushIntegratedTo: 'main' });
  const other = await buildTask(refused, 'T-2', 'other.txt', 'other\n');
  const res2 = await refused.integrate(other.task, other.head, checks());
  assert.equal(res2.status, 'merged');
  assert.match(await refused.pushIntegrated(res2.mergedCommit!), /warning: push to main failed/);
});

test('a failed push to pushIntegratedTo is caught up by the next push, also after a sync', async (t) => {
  const { dir, source, forge } = await setup(t, { pushIntegratedTo: 'autopilot/main' });
  const away = path.join(dir, 'source-away');
  const one = await buildTask(forge, 'T-1', 'one.txt', 'one\n');
  const res = await forge.integrate(one.task, one.head, checks());
  assert.equal(res.status, 'merged', res.details);
  fs.renameSync(source, away);
  assert.match(await forge.pushIntegrated(res.mergedCommit!), /warning: push to autopilot\/main failed/);
  fs.renameSync(away, source);

  // The same head again (e.g. after a crash): already integrated, and the push is retried.
  const again = await forge.integrate(one.task, one.head, checks());
  assert.equal(again.mergedCommit, res.mergedCommit);
  assert.equal(again.details, 'already integrated');
  assert.equal(await forge.pushIntegrated(again.mergedCommit!), 'pushed to autopilot/main');
  assert.equal(await sh(source, 'rev-parse', 'refs/heads/autopilot/main'), res.mergedCommit);

  const two = await buildTask(forge, 'T-2', 'two.txt', 'two\n');
  const res2 = await forge.integrate(two.task, two.head, checks());
  fs.renameSync(source, away);
  assert.match(await forge.pushIntegrated(res2.mergedCommit!), /warning: push/);
  assert.match(forge.pushWarning() ?? '', /push to autopilot\/main failed/);
  await forge.prepare();
  assert.equal(await forge.pushIntegrated(res2.mergedCommit!, true), '', 'offline, the catch-up does not even try');
  fs.renameSync(away, source);
  await forge.prepare();
  assert.equal(await sh(source, 'rev-parse', 'refs/heads/autopilot/main'), res.mergedCommit, 'prepare() itself pushes nothing');
  assert.equal(await forge.pushIntegrated(res2.mergedCommit!, true), 'pushed to autopilot/main');
  assert.equal(forge.pushWarning(), null);
  assert.equal(await sh(source, 'rev-parse', 'refs/heads/autopilot/main'), res2.mergedCommit, 'caught up after the sync');
});

test('prepare fast-forwards when the source gains commits and reports divergence', async (t) => {
  const { source, forge } = await setup(t);
  const newer = await commitFile(source, 'NEWS.md', 'news\n', 'founder commit');
  await forge.prepare();
  assert.equal(forge.syncStatus(), 'fast_forwarded');
  assert.equal(await forge.targetHead(), newer);
  await forge.prepare();
  assert.equal(forge.syncStatus(), 'up_to_date');

  // Integrated work the source does not have yet is not divergence...
  const { head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');
  const res = await forge.integrate(task, head, checks());
  assert.equal(res.status, 'merged', res.details);
  await forge.prepare();
  assert.equal(forge.syncStatus(), 'up_to_date');
  assert.equal(await forge.targetHead(), res.mergedCommit);

  // ...but new founder commits on the old main are: the local target is left alone.
  await commitFile(source, 'NEWS.md', 'more news\n', 'another founder commit');
  await forge.prepare();
  assert.equal(forge.syncStatus(), 'diverged');
  assert.equal(await forge.targetHead(), res.mergedCommit);
});

test('syncStatus is no_remote when the source loses the target branch; the local target stays', async (t) => {
  const { source, forge } = await setup(t);
  const target = await forge.targetHead();
  await sh(source, 'checkout', '-q', '-b', 'other');
  await sh(source, 'branch', '-q', '-D', 'main');
  await forge.prepare();
  assert.equal(forge.syncStatus(), 'no_remote');
  assert.equal(await forge.targetHead(), target);
});

test('prepare keeps working offline and accepts URL sources', async (t) => {
  const { dir, source, forge } = await setup(t);
  const target = await forge.targetHead();
  fs.renameSync(source, path.join(dir, 'source-moved'));
  assert.equal(await forge.prepare(), forge.repoPath, 'an unreachable source is not fatal');
  assert.ok(forge.fetchError());
  assert.equal(await forge.targetHead(), target);
  fs.renameSync(path.join(dir, 'source-moved'), source);
  await forge.prepare();
  assert.equal(forge.fetchError(), null);

  const viaUrl = new LocalForge({
    source: `file://${source}`,
    home: path.join(dir, 'home-url'),
    targetBranch: 'main',
    branchPrefix: 'autopilot/',
    strategy: 'squash',
    pushIntegratedTo: null,
  });
  assert.equal(viaUrl.source, `file://${source}`, 'URLs are not resolved as paths');
  await viaUrl.prepare();
  assert.equal(await viaUrl.targetHead(), target);
});

test('errors never show credentials from the source URL', async (t) => {
  const token = 's3cr3tPassw0rdValue';
  const url = `https://x-access-token:${token}@127.0.0.1:9/o/r.git`;
  const err = new GitError(['clone', '--bare', '--', url, '/tmp/x'], 128, `fatal: unable to access '${url}/': Failed to connect`);
  for (const text of [err.message, err.args.join(' '), err.stderr]) assert.ok(!text.includes(token), text);
  assert.match(err.message, /https:\/\/\*\*\*@127\.0\.0\.1:9\/o\/r\.git/);
  assert.equal(redactUrlCredentials('see https://u:p@h/x and ssh://git@h/y, not a@b.c'), 'see https://***@h/x and ssh://***@h/y, not a@b.c');

  // A real failing clone (an unknown transport fails at once, without any network).
  const dir = tempDir(t);
  const forge = new LocalForge({
    source: `nosuchtransport://deploy:${token}@example.invalid/o/r.git`,
    home: path.join(dir, 'home'),
    targetBranch: 'main',
    branchPrefix: 'autopilot/',
    strategy: 'squash',
    pushIntegratedTo: null,
  });
  await assert.rejects(forge.prepare(), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(!e.message.includes(token), e.message);
    assert.match(e.message, /nosuchtransport:\/\/\*\*\*@example\.invalid/);
    return true;
  });
  assert.throws(() => new LocalForge({ source: '-oProxyCommand=evil', home: dir, targetBranch: 'main', branchPrefix: '', strategy: 'squash', pushIntegratedTo: null }), /invalid source/);
});

test('worker-written hooks and fsmonitor never run in the supervisor; risky config is refused', async (t) => {
  const { dir, forge } = await setup(t);
  const marker = path.join(dir, 'ran.txt');
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(hooks);
  const script = `#!/bin/sh\necho "$0" >> '${marker}'\n`;
  for (const name of ['reference-transaction', 'post-checkout', 'post-merge', 'post-commit', 'pre-push', 'fsmonitor']) {
    for (const where of [hooks, path.join(forge.repoPath, 'hooks')]) {
      fs.writeFileSync(path.join(where, name), script);
      fs.chmodSync(path.join(where, name), 0o755);
    }
  }
  // What a worker could write into the shared repository config from its worktree.
  await sh(forge.repoPath, 'config', 'core.hooksPath', hooks);
  await sh(forge.repoPath, 'config', 'core.fsmonitor', path.join(hooks, 'fsmonitor'));
  // Sanity check: plain git (without our hardening) does run them.
  await runCommand('git', ['update-ref', 'refs/heads/probe', 'main'], { cwd: forge.repoPath });
  assert.ok(fs.existsSync(marker), 'the hooks work');
  fs.rmSync(marker);
  await runCommand('git', ['update-ref', '-d', 'refs/heads/probe'], { cwd: forge.repoPath });
  fs.rmSync(marker, { force: true });

  const { wt, head, task } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');
  assert.deepEqual(await forge.dirtyPaths(wt.path), []);
  const res = await forge.integrate(task, head, checks());
  assert.equal(res.status, 'merged', res.details);
  await forge.prepare();
  assert.equal(fs.existsSync(marker), false, 'no hook or fsmonitor program ran');

  // Settings that run programs or reach other servers are refused, before any git work.
  await sh(forge.repoPath, 'config', 'core.sshCommand', `touch ${marker}`);
  await assert.rejects(forge.prepare(), /settings the autopilot did not write \(core\.sshcommand\)/);
  await assert.rejects(forge.createWorktree('T-2', 'next'), /core\.sshcommand/);
  const blocked = await forge.integrate(task, head, checks());
  assert.equal(blocked.status, 'error');
  assert.match(blocked.details, /core\.sshcommand/);
  await sh(forge.repoPath, 'config', '--unset', 'core.sshCommand');

  // origin's URL and refspec are simply put back.
  await sh(forge.repoPath, 'config', 'remote.origin.url', path.join(dir, 'attacker.git'));
  await sh(forge.repoPath, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
  await forge.prepare();
  assert.equal(forge.fetchError(), null);
  assert.equal(await sh(forge.repoPath, 'config', '--get', 'remote.origin.url'), forge.source);
  assert.equal(await sh(forge.repoPath, 'config', '--get-all', 'remote.origin.fetch'), ORIGIN_FETCH_REFSPEC);
  assert.equal(fs.existsSync(marker), false);
});

test('replace refs a worker writes never change what the forge diffs, scans or merges', async (t) => {
  const { forge } = await setup(t);
  const target = await forge.targetHead();
  const wt = await forge.createWorktree('T-1', 'feature');
  // Plain git, as a builder runs it in its worktree (it honors replace refs).
  const worker = async (...args: string[]) => {
    const r = await runCommand('git', [...AUTHOR, ...args], { cwd: wt.path });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };
  const hidden = '.autopilot/evil.json';
  const real = [hidden, 'feature.txt'];
  fs.mkdirSync(path.join(wt.path, '.autopilot'));
  fs.writeFileSync(path.join(wt.path, hidden), 'aws_key = "AKIAABCDEFGHIJKLMNOP"\n');
  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'feature\n');
  // A stand-in for the target commit that already has the hidden file, then the real work on top.
  await worker('add', hidden);
  const fakeTarget = await worker('commit-tree', await worker('write-tree'), '-m', 'initial');
  await worker('replace', target, fakeTarget);
  await worker('add', 'feature.txt');
  await worker('commit', '-q', '-m', 'feature');
  const head = await worker('rev-parse', 'HEAD');
  assert.equal(await worker('diff', '--name-only', target, head), 'feature.txt', 'sanity check: plain git hides the file');

  const paths = async (from: string, to: string) => (await forge.diff(from, to, 2_000_000)).files.map((f) => f.path).sort();
  assert.deepEqual(await paths(target, head), real);
  assert.deepEqual(findSecrets((await forge.diff(target, head, 2_000_000)).patch).map((s) => s.file), [hidden]);
  // Whatever environment a caller passes, and with the supervisor's flags and scrubbed environment.
  assert.equal((await git(['ls-tree', '--name-only', target], { cwd: forge.repoPath, env: { ...process.env } })).stdout.trim(), 'README.md');
  const scrubbed = await runCommand('git', [...SAFE_GIT_FLAGS, 'ls-tree', '--name-only', target], { cwd: forge.repoPath, env: scrubbedEnv() });
  assert.equal(scrubbed.stdout.trim(), 'README.md');

  // The merge is built from the real objects, so what was diffed is exactly what lands.
  const task = makeTask({ branch: wt.branch, worktree: wt.path, baseCommit: target, headCommit: head });
  const res = await forge.integrate(task, head, checks());
  assert.equal(res.status, 'merged', res.details);
  assert.equal(await sh(forge.repoPath, 'rev-parse', `${res.mergedCommit}^1`), target);
  assert.deepEqual(await paths(target, res.mergedCommit!), real);

  // The GitHub variant: a clean stand-in for the head itself (git push sends the real head).
  await worker('replace', '-d', target);
  await worker('rm', '-q', '--cached', hidden);
  await worker('replace', head, await worker('commit-tree', await worker('write-tree'), '-p', target, '-m', 'feature'));
  assert.equal(await worker('diff', '--name-only', target, head), 'feature.txt', 'sanity check: plain git hides the file');
  assert.deepEqual(await paths(target, head), real);
});

test('leftover lock files or a broken index never block later integrations', async (t) => {
  const { forge } = await setup(t);
  const one = await buildTask(forge, 'T-1', 'one.txt', 'one\n');
  assert.equal((await forge.integrate(one.task, one.head, checks())).status, 'merged');

  // A supervisor crash or a killed git leaves the integration worktree's locks behind.
  const admin = await sh(forge.integrationPath, 'rev-parse', '--absolute-git-dir');
  fs.writeFileSync(path.join(admin, 'index.lock'), '');
  fs.writeFileSync(path.join(admin, 'HEAD.lock'), '');
  const two = await buildTask(forge, 'T-2', 'two.txt', 'two\n');
  for (let i = 0; i < 2; i++) {
    const res = await forge.integrate(two.task, two.head, checks());
    assert.equal(res.status, 'merged', res.details);
  }
  assert.equal(fs.existsSync(path.join(admin, 'index.lock')), false);

  // A corrupt index makes the worktree unusable: it is rebuilt.
  fs.writeFileSync(path.join(admin, 'index'), 'not an index');
  const three = await buildTask(forge, 'T-3', 'three.txt', 'three\n');
  const res = await forge.integrate(three.task, three.head, checks());
  assert.equal(res.status, 'merged', res.details);
  assert.equal(await sh(forge.repoPath, 'show', 'main:three.txt'), 'three');
  assert.equal(await sh(forge.integrationPath, 'status', '--porcelain'), '');
});

test('the integration worktree recovers from an interrupted run and keeps ignored files', async (t) => {
  const { source, forge } = await setup(t);
  await commitFile(source, '.gitignore', 'node_modules/\n', 'ignore dependencies');
  await forge.prepare();
  const one = await buildTask(forge, 'T-1', 'README.md', 'one\n');
  const two = await buildTask(forge, 'T-2', 'README.md', 'two\n');
  const first = await forge.integrate(one.task, one.head, async (cwd) => {
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', 'dep.js'), 'installed');
    return checks()(cwd);
  });
  assert.equal(first.status, 'merged', first.details);

  // A crash mid-merge leaves a conflicted index and stray files behind.
  const wt = forge.integrationPath;
  await git(['merge', '--squash', two.head], { cwd: wt, allowFail: true });
  fs.writeFileSync(path.join(wt, 'stray.txt'), 'left behind');
  assert.notEqual(await sh(wt, 'status', '--porcelain'), '');

  const three = await buildTask(forge, 'T-3', 'three.txt', 'three\n');
  const res = await forge.integrate(three.task, three.head, async (cwd) => {
    assert.equal(fs.existsSync(path.join(cwd, 'stray.txt')), false, 'untracked leftovers are cleaned');
    assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), 'one\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'node_modules', 'dep.js'), 'utf8'), 'installed', 'ignored files survive');
    return checks()(cwd);
  });
  assert.equal(res.status, 'merged', res.details);
  assert.equal(await sh(forge.repoPath, 'show', 'main:three.txt'), 'three');
});

test('ensureWorktree reattaches a task branch after removeWorktree', async (t) => {
  const { dir, forge } = await setup(t);
  const { wt, head } = await buildTask(forge, 'T-1', 'feature.txt', 'feature\n');

  await forge.removeWorktree(wt.path);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(await revParse(forge.repoPath, `refs/heads/${wt.branch}`), head, 'the branch survives');

  const again = await forge.ensureWorktree('T-1', wt.branch);
  assert.deepEqual(again, { path: wt.path, branch: wt.branch, baseCommit: wt.baseCommit });
  assert.equal(await forge.headCommit(again.path), head);
  assert.equal(await sh(again.path, 'symbolic-ref', '--short', 'HEAD'), wt.branch);

  // A live worktree is reused as it is, uncommitted work included.
  fs.writeFileSync(path.join(again.path, 'wip.txt'), 'wip\n');
  assert.equal((await forge.ensureWorktree('T-1', wt.branch)).path, wt.path);
  assert.deepEqual(await forge.dirtyPaths(wt.path), ['wip.txt']);

  // A directory deleted behind git's back is pruned and recreated.
  fs.rmSync(wt.path, { recursive: true, force: true });
  assert.equal(await forge.headCommit((await forge.ensureWorktree('T-1', wt.branch)).path), head);

  // createWorktree on an existing branch attaches it instead of failing.
  await forge.removeWorktree(wt.path);
  const recreated = await forge.createWorktree('T-1', 'change feature.txt');
  assert.equal(recreated.branch, wt.branch);
  assert.equal(await forge.headCommit(recreated.path), head);

  await assert.rejects(forge.ensureWorktree('T-9', 'autopilot/t-9-nope'), /does not exist/);

  // removeWorktree never deletes directories outside its worktrees dir.
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  await forge.removeWorktree(outside);
  assert.equal(fs.existsSync(outside), true);
});

test('a half-created task worktree (interrupted worktree add) is rebuilt, never reused', async (t) => {
  const { source, forge } = await setup(t);
  await commitFile(source, 'src/app.ts', 'export {};\n', 'more files');
  await forge.prepare();
  const wt = await forge.createWorktree('T-1', 'half');
  const lockFile = path.join(await sh(wt.path, 'rev-parse', '--absolute-git-dir'), 'locked');

  // What a killed `git worktree add` leaves: the branch, a partial checkout, no index, the lock.
  fs.writeFileSync(lockFile, 'initializing');
  fs.rmSync(path.join(path.dirname(lockFile), 'index'));
  fs.rmSync(path.join(wt.path, 'src'), { recursive: true });
  const again = await forge.createWorktree('T-1', 'half');
  assert.deepEqual(again, wt);
  assert.equal(await sh(again.path, 'ls-files'), 'README.md\nsrc/app.ts');
  assert.ok(fs.existsSync(path.join(again.path, 'src', 'app.ts')));
  assert.deepEqual(await forge.dirtyPaths(again.path), []);
  assert.equal(fs.existsSync(lockFile), false);

  // The directory may be gone too, leaving only a locked registration that blocks `worktree add`.
  fs.writeFileSync(lockFile, 'initializing');
  fs.rmSync(wt.path, { recursive: true, force: true });
  const third = await forge.ensureWorktree('T-1', wt.branch);
  assert.equal(third.path, wt.path);
  assert.deepEqual(await forge.dirtyPaths(third.path), []);
  assert.equal(await sh(third.path, 'symbolic-ref', '--short', 'HEAD'), wt.branch);
});

test('LocalForge has no pull requests: publish, comment and pollFeedback do nothing', async (t) => {
  const dir = tempDir(t);
  const forge = new LocalForge({ source: dir, home: path.join(dir, 'home'), targetBranch: 'main', branchPrefix: 'autopilot/', strategy: 'squash', pushIntegratedTo: null });
  const task = makeTask({ branch: 'autopilot/t-1-x', prNumber: 3 });
  assert.deepEqual(await forge.publish(task, 'body'), { prNumber: null, prUrl: null });
  assert.equal(await forge.comment(task, 'hello'), undefined);
  assert.deepEqual(await forge.pollFeedback(0, [task]), []);
  assert.equal(fs.existsSync(path.join(dir, 'home')), false, 'nothing was created');
});

test('git and runCommand report failures, timeouts and lingering grandchildren without hanging', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(git(['no-such-subcommand'], { cwd: dir }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.notEqual(err.code, 0);
    assert.deepEqual(err.args, ['no-such-subcommand']);
    return true;
  });
  const soft = await git(['no-such-subcommand'], { cwd: dir, allowFail: true });
  assert.notEqual(soft.code, 0);

  const missingCwd = await runCommand('git', ['--version'], { cwd: path.join(dir, 'nope') });
  assert.equal(missingCwd.code, -1);
  assert.match(missingCwd.stderr, /working directory does not exist/);

  const missingProgram = await runCommand(path.join(dir, 'no-such-program'), [], { cwd: dir });
  assert.equal(missingProgram.code, -1);
  assert.match(missingProgram.stderr, /ENOENT/);

  const echoed = await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd: dir, input: 'hello', maxStdoutBytes: 3 });
  assert.deepEqual([echoed.code, echoed.stdout, echoed.stdoutTruncated, echoed.stopped], [0, 'hel', true, false]);

  // stopAtMaxStdout ends a process that would otherwise write forever.
  const endless = "const b = Buffer.alloc(65536, 120); (function w() { process.stdout.write(b, w); })()";
  const stopped = await runCommand(process.execPath, ['-e', endless], { cwd: dir, maxStdoutBytes: 10, stopAtMaxStdout: true, timeoutMs: 20_000 });
  assert.deepEqual([stopped.stdout, stopped.stdoutTruncated, stopped.stopped, stopped.timedOut], ['x'.repeat(10), true, true, false]);

  let started = Date.now();
  const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: dir, timeoutMs: 200 });
  assert.deepEqual([slow.code, slow.timedOut], [-1, true]);
  assert.match(slow.stderr, /timed out after 200 ms/);
  assert.ok(Date.now() - started < 3000);

  // The child exits at once but leaves a grandchild holding stdout/stderr open for 2 s.
  const lingering =
    "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'inherit', detached: true }).unref(); console.log('parent done')";
  started = Date.now();
  const res = await runCommand(process.execPath, ['-e', lingering], { cwd: dir });
  assert.deepEqual([res.code, res.stdout.trim()], [0, 'parent done']);
  assert.ok(Date.now() - started < 1800, 'did not wait for the grandchild');
});

test('a timed-out git is stopped together with what it started; prompts are always off', async (t) => {
  const dir = tempDir(t);
  const { script, out } = fakeSsh(dir);
  // The caller even asks for prompts: git() overrides that.
  const env = { ...process.env, GIT_SSH: script, GIT_SSH_VARIANT: 'ssh', GIT_TERMINAL_PROMPT: '1' };
  const res = await git(['ls-remote', 'ssh://example.invalid/repo.git'], { cwd: dir, env, timeoutMs: 2000, allowFail: true });
  assert.deepEqual([res.code, res.timedOut], [-1, true]);
  const ssh = JSON.parse(fs.readFileSync(out, 'utf8')) as { pid: number; prompt: string | null };
  assert.equal(ssh.prompt, '0', 'GIT_TERMINAL_PROMPT is forced to 0');
  await waitUntilGone(ssh.pid);
});

test('git commands still running when the process exits are stopped with it', async (t) => {
  const dir = tempDir(t);
  const { script, out } = fakeSsh(dir);
  const gitModule = new URL('../src/git/git.ts', import.meta.url).href;
  const program = [
    `import { git } from ${JSON.stringify(gitModule)};`,
    `import { existsSync } from 'node:fs';`,
    `void git(['ls-remote', 'ssh://example.invalid/repo.git'], { cwd: ${JSON.stringify(dir)}, env: { ...process.env, GIT_SSH: ${JSON.stringify(script)}, GIT_SSH_VARIANT: 'ssh' }, allowFail: true });`,
    `const poll = setInterval(() => { if (existsSync(${JSON.stringify(out)})) { clearInterval(poll); process.exit(0); } }, 20);`,
  ].join('\n');
  const res = await runCommand(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: dir, timeoutMs: 20_000 });
  assert.equal(res.code, 0, res.stderr);
  const ssh = JSON.parse(fs.readFileSync(out, 'utf8')) as { pid: number };
  await waitUntilGone(ssh.pid);
});

test('git output parsers', () => {
  assert.deepEqual(parseNumstat('2\t1\ta.txt\0-\t-\tbin.dat\0' + '0\t0\t\0old.txt\0new.txt\0'), [
    { path: 'a.txt', oldPath: null, added: 2, deleted: 1, binary: false },
    { path: 'bin.dat', oldPath: null, added: 0, deleted: 0, binary: true },
    { path: 'new.txt', oldPath: 'old.txt', added: 0, deleted: 0, binary: false },
  ]);
  assert.deepEqual(parseNumstat('3\t0\tsrc/{a => b}/x.ts\n1\t1\told name.txt => new.txt\n4\t2\t"caf\\303\\251.txt"\n'), [
    { path: 'src/b/x.ts', oldPath: 'src/a/x.ts', added: 3, deleted: 0, binary: false },
    { path: 'new.txt', oldPath: 'old name.txt', added: 1, deleted: 1, binary: false },
    { path: 'café.txt', oldPath: null, added: 4, deleted: 2, binary: false },
  ]);
  assert.deepEqual(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0A\0sp ace.txt\0'), [
    { status: 'M', path: 'a.txt', oldPath: null, score: null },
    { status: 'R', path: 'new.txt', oldPath: 'old.txt', score: 100 },
    { status: 'A', path: 'sp ace.txt', oldPath: null, score: null },
  ]);
  assert.deepEqual(parseNameStatus('M\ta.txt\nR087\told.txt\tnew.txt\nD\t"tab\\there"\n'), [
    { status: 'M', path: 'a.txt', oldPath: null, score: null },
    { status: 'R', path: 'new.txt', oldPath: 'old.txt', score: 87 },
    { status: 'D', path: 'tab\there', oldPath: null, score: null },
  ]);
  assert.deepEqual(parseStatusPorcelain(' M a.txt\0?? new dir/x.txt\0R  new.txt\0old.txt\0'), ['a.txt', 'new dir/x.txt', 'new.txt', 'old.txt']);
  assert.deepEqual(
    parseWorktreeList(
      'worktree /h/repo.git\nbare\n\nworktree /h/worktrees/T-1\nHEAD abc\nbranch refs/heads/autopilot/t-1-x\nlocked initializing\n\nworktree /h/worktrees/_integration\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n',
    ),
    [
      { path: '/h/repo.git', head: null, branch: null, bare: true, detached: false, prunable: false, locked: null },
      { path: '/h/worktrees/T-1', head: 'abc', branch: 'refs/heads/autopilot/t-1-x', bare: false, detached: false, prunable: false, locked: 'initializing' },
      { path: '/h/worktrees/_integration', head: 'def', branch: null, bare: false, detached: true, prunable: true, locked: null },
    ],
  );
  assert.deepEqual(parseTrailers('Title\n\nAutopilot-Task: T-1\nautopilot-head:  abc \nCo-authored-by: A <a@b>\n'), {
    'autopilot-task': ['T-1'],
    'autopilot-head': ['abc'],
    'co-authored-by': ['A <a@b>'],
  });
  assert.deepEqual(parseConfigList('core.bare\ntrue\0remote.origin.url\n/x\ny\0flag\0'), [
    ['core.bare', 'true'],
    ['remote.origin.url', '/x\ny'],
    ['flag', ''],
  ]);

  // Records of `git log -z --format=%H%x1f%(trailers:only,unfold)%x1f%s`.
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const rec = (sha: string, task: string, head: string, subject: string) => `${sha}\x1fAutopilot-Task: ${task}\nAutopilot-Head: ${head}\n\x1f${subject}\0`;
  const log = rec(a, 'T-2', b, 'Other (T-2)') + rec(b, 'T-1', a, 'This (T-1)');
  assert.equal(findIntegrationCommit(log, 'T-1', a), b);
  assert.equal(findIntegrationCommit(log, 'T-1', b), null, 'both trailers must match');
  assert.equal(findIntegrationCommit(log, 'T-3', a), null);
  assert.equal(findIntegrationCommit(rec(b, 'T-1', a, 'Sneaky (T-2)'), 'T-1', a), null, 'the subject must name the task');
  assert.equal(findIntegrationCommit(rec(b, 'T-1', a, 'This (T-1) (#7)'), 'T-1', a), b, "GitHub's PR suffix is fine");
  assert.equal(findIntegrationCommit(`${b}\x1f\x1fThis (T-1)\0`, 'T-1', a), null, 'no trailer block');

  // Titles cannot smuggle lines, field separators or bidi overrides into commit subjects.
  assert.equal(oneLine('Fix\x1fit‮\n\nAutopilot-Task: T-9'), 'Fix it Autopilot-Task: T-9');
  assert.equal(oneLine('   '), 'Autopilot task');

  const ours: [string, string][] = [
    ['core.bare', 'true'],
    ['remote.origin.url', '/src/repo'],
    ['remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
    ['core.hookspath', '.husky/_'],
    ['core.fsmonitor', 'true'],
    ['user.name', 'Builder'],
    ['lfs.repositoryformatversion', '0'],
    ['remote.origin.prune', 'true'],
  ];
  const expected = { url: '/src/repo', fetch: ORIGIN_FETCH_REFSPEC };
  assert.deepEqual(auditRepoConfig(ours, expected), { unsafe: [], resetUrl: false, resetFetch: false });
  assert.equal(auditRepoConfig([...ours.slice(0, 1), ['remote.origin.url', '/src/repo/'], ...ours.slice(2)], expected).resetUrl, true, 'only the exact source');
  const risky: [string, string][] = [
    ['core.sshcommand', 'x'],
    ['remote.origin.pushurl', 'x'],
    ['remote.origin.uploadpack', 'x'],
    ['url.https://evil/.insteadof', 'https://github.com/'],
    ['filter.x.smudge', 'x'],
    ['merge.x.driver', 'x'],
    ['diff.x.textconv', 'x'],
    ['includeif.gitdir:/x/.path', '/y'],
    ['credential.helper', 'x'],
    ['http.proxy', 'http://evil'],
    ['submodule.recurse', 'true'],
    ['extensions.worktreeconfig', 'true'],
  ];
  assert.deepEqual(auditRepoConfig([...ours, ...risky], expected).unsafe, risky.map(([key]) => key));
  assert.deepEqual(auditRepoConfig([...ours, ['remote.origin.url', '/elsewhere']], expected).resetUrl, true, 'two URLs');
  assert.deepEqual(auditRepoConfig([['remote.origin.url', '/other'], ['remote.origin.fetch', '+refs/heads/*:refs/heads/*']], expected), {
    unsafe: [],
    resetUrl: true,
    resetFetch: true,
  });

  for (const ok of ['main', 'autopilot/t-1-add-x', 'release/1.2']) assert.ok(isSafeBranchName(ok), ok);
  for (const bad of ['', '-x', 'a..b', 'a/.hidden', 'x.lock', 'a b', 'a/', 'HEAD', 'a//b']) assert.ok(!isSafeBranchName(bad), bad);
});

test('the upstream query sees the owner\'s hasconfig:remote.*.url includes, as the fetch does', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-hasconfig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const founder = path.join(dir, 'founder');
  const url = 'file:///nonexistent-autopilot-test/repo.git';
  const g = (...args: string[]) => git(['-c', 'user.name=F', '-c', 'user.email=f@example.com', '-C', founder, ...args], { cwd: dir });
  fs.mkdirSync(founder);
  await g('init', '-q', '-b', 'main');
  await g('commit', '-q', '--allow-empty', '-m', 'A');
  // The source is reachable only through an insteadOf that an include conditioned on origin's URL adds.
  const inc = path.join(dir, 'inc.gitconfig');
  fs.writeFileSync(inc, `[url "file://${founder}"]\n\tinsteadOf = ${url}\n`);
  const global = path.join(dir, 'global.gitconfig');
  fs.writeFileSync(global, `[includeIf "hasconfig:remote.*.url:file:///nonexistent-autopilot-test/**"]\n\tpath = ${inc}\n`);
  class OwnerConfigForge extends LocalForge {
    protected run(args: string[], cwd: string, opts: Omit<GitOptions, 'cwd'> = {}) {
      return super.run(args, cwd, { ...opts, env: gitEnv({ GIT_CONFIG_GLOBAL: global }) });
    }
  }
  const forge = new OwnerConfigForge({ source: url, home: path.join(dir, 'home'), targetBranch: 'main', branchPrefix: 'ap/', strategy: 'squash', pushIntegratedTo: null });
  await forge.prepare();
  await g('commit', '-q', '--allow-empty', '-m', 'B');
  const b = (await g('rev-parse', 'HEAD')).stdout.trim();
  await forge.prepare();
  assert.equal(forge.syncStatus(), 'fast_forwarded');
  assert.equal(await forge.targetHead(), b);
  assert.equal(forge.upstreamHead(), b);
});

test("the supervisor's own git environment drops repository redirects and GitHub tokens", () => {
  const redirects = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
  const tokens = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  const env = scrubbedEnv({ PATH: '/usr/bin', GIT_AUTHOR_NAME: 'kept', ...Object.fromEntries([...redirects, ...tokens].map((key) => [key, `/x/${key}`])) });
  for (const key of [...redirects, ...tokens]) assert.equal(env[key], undefined, key);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.GIT_AUTHOR_NAME, 'kept');
});

test("autopilot init --create makes its repository where asked, even with a git hook's GIT_DIR inherited", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-init-gitdir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const decoy = path.join(dir, 'decoy.git');
  await git(['init', '-q', '--bare', decoy], { cwd: dir });
  const source = path.join(dir, 'new');
  const cli = path.resolve(import.meta.dirname, '..', 'bin', 'autopilot.ts');
  const args = [cli, 'init', 'demo', '--home', path.join(dir, 'home'), '--source', source, '--create', '--runner', 'fake'];
  const r = await runCommand(process.execPath, args, { cwd: dir, env: { ...process.env, GIT_DIR: decoy } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await git(['log', '--format=%s'], { cwd: source })).stdout.trim(), 'Initial commit');
  assert.equal((await git(['rev-list', '--all'], { cwd: decoy, allowFail: true })).stdout.trim(), '', 'nothing was written to the other repository');
});

test("autopilot doctor asks the source itself, not a repository that a git hook's GIT_DIR names", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-doctor-gitdir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A real repository with a main branch, and a source address where nothing exists.
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  await git(['init', '-q', '-b', 'main'], { cwd: real });
  await git([...AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'A'], { cwd: real });
  const missing = 'file:///nonexistent-autopilot-doctor/repo.git';
  // The repository that GIT_DIR names maps the missing source to the real one.
  const decoy = path.join(dir, 'decoy');
  fs.mkdirSync(decoy);
  await git(['init', '-q'], { cwd: decoy });
  await git(['config', `url.file://${real}.insteadOf`, missing], { cwd: decoy });
  const cli = path.resolve(import.meta.dirname, '..', 'bin', 'autopilot.ts');
  const home = path.join(dir, 'home');
  const init = await runCommand(process.execPath, [cli, 'init', 'demo', '--home', home, '--source', missing, '--runner', 'fake'], { cwd: dir });
  assert.equal(init.code, 0, init.stderr);
  // Only git on the PATH, so doctor's other checks have nothing to run.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gitBin = (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'git')).find((p) => fs.existsSync(p));
  assert.ok(gitBin, 'git is on the PATH');
  fs.symlinkSync(gitBin, path.join(bin, 'git'));
  const doctor = await runCommand(process.execPath, [cli, 'doctor', '--home', home], { cwd: dir, env: { ...process.env, PATH: bin, GIT_DIR: path.join(decoy, '.git') } });
  assert.equal(doctor.code, 0, doctor.stderr);
  const line = doctor.stdout.split('\n').find((l) => l.includes('project demo')) ?? '';
  assert.match(line, /cannot see branch main in file:\/\/\/nonexistent-autopilot-doctor\/repo\.git/);
});
