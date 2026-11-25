// SPDX-License-Identifier: MIT
// Target-branch integrity drills (see docs/architecture.md, "Target branch integrity"): what the
// supervisor accepts as the source repository moving on, and that legitimate syncs and merges
// never raise a false tamper card. Worktrees share refs with the private clone, so a worker can
// write refs/heads/<target> and refs/remotes/origin/<target> alike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { approve, builderResult, commitFile, git, harness, type Harness } from './harness.ts';
import type { CommandResult, GitOptions, GitResult } from '../../src/git/git.ts';
import { GitHubForge } from '../../src/git/github-forge.ts';
import { LocalForge } from '../../src/git/local-forge.ts';
import type { IntegrationResult, RunSpec, Task } from '../../src/types.ts';

const T = { timeout: 60_000 };
const MIN = 60_000;
const id = (spec: RunSpec) => spec.env.AUTOPILOT_TASK_ID;

/** No model runs: these drills only exercise syncs and checks. */
const noRuns = () => async () => {
  throw new Error('no model run expected');
};

const optionsOf = (local: LocalForge) => ({
  source: local.source,
  home: local.home,
  targetBranch: local.targetBranch,
  branchPrefix: local.branchPrefix,
  strategy: local.strategy,
  pushIntegratedTo: local.pushIntegratedTo,
});

/**
 * The real LocalForge, but a drill can act right before or right after its fetch, as a worker
 * racing the sync would (before: after the config audit; after: before the source is asked).
 */
class RacedFetch extends LocalForge {
  beforeFetch: (() => void) | null = null;
  afterFetch: (() => void) | null = null;
  constructor(local: LocalForge) {
    super(optionsOf(local));
  }
  protected async fetchOrigin(): Promise<boolean> {
    const before = this.beforeFetch;
    this.beforeFetch = null;
    before?.();
    const ok = await super.fetchOrigin();
    const after = this.afterFetch;
    this.afterFetch = null;
    after?.();
    return ok;
  }
}

/**
 * GitHub's side of a merge, without GitHub: the task head is squash-merged on the source
 * repository, then the local target is synced the way GitHubForge.afterMerge does it, and
 * `afterSync` runs (a worker acting before the supervisor records the result).
 */
class MergesOnSource extends LocalForge {
  readonly kind: 'local' | 'github' = 'github';
  readonly afterSync: () => void;
  constructor(local: LocalForge, afterSync: () => void) {
    super(optionsOf(local));
    this.afterSync = afterSync;
  }
  async integrate(task: Task, expectedHead: string): Promise<IntegrationResult> {
    this.confirmedUpstream = null;
    git(this.repoPath, 'push', '-q', this.source, `${expectedHead}:refs/pull/${task.id}/head`);
    const message = `${task.title} (${task.id})\n\nAutopilot-Task: ${task.id}\nAutopilot-Head: ${expectedHead}`;
    const merged = git(this.source, 'commit-tree', `${expectedHead}^{tree}`, '-p', 'refs/heads/main', '-m', message);
    git(this.source, 'update-ref', 'refs/heads/main', merged);
    if (await this.fetchOrigin()) await this.syncTarget();
    this.afterSync();
    return { status: 'merged', mergedCommit: merged, checks: [], details: `merged on the source as ${merged.slice(0, 10)}` };
  }
}

/**
 * A commit on top of `parent` that adds evil.txt, written with plumbing into the shared object
 * store. By default it has the parent's other files; `from` gives another commit's files.
 */
function forgeCommit(cwd: string, parent: string, opts: { from?: string; message?: string } = {}): string {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: 'unreviewed\n', encoding: 'utf8' }).trim();
  const listing = execFileSync('git', ['ls-tree', `${opts.from ?? parent}^{tree}`], { cwd, encoding: 'utf8' });
  const tree = execFileSync('git', ['mktree'], { cwd, input: `${listing}100644 blob ${blob}\tevil.txt\n`, encoding: 'utf8' }).trim();
  return git(cwd, 'commit-tree', tree, '-p', parent, '-m', opts.message ?? 'sync');
}

/** Whether the founder's source repository has the commit (it was pushed there). */
function sourceHas(h: Harness, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: h.src, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The source's pushIntegratedTo branch, or null while nothing was pushed there. */
function pushedHead(h: Harness): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/autopilot/main'], { cwd: h.src, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Counts the forge's syncs and target reads, so a drill can wait until a sync has been checked. */
function instrument(local: LocalForge) {
  const counts = { prepares: 0, reads: 0 };
  const prepare = local.prepare.bind(local);
  const targetHead = local.targetHead.bind(local);
  local.prepare = async () => {
    try {
      return await prepare();
    } finally {
      counts.prepares++;
    }
  };
  local.targetHead = async () => {
    counts.reads++;
    return targetHead();
  };
  return counts;
}

/**
 * Make the 10-minute repository sync due, then wait until it ran and the target was checked
 * after it (the sync's own check, then a later tick's), or the project was paused.
 */
async function syncNow(h: Harness, counts: { prepares: number; reads: number }): Promise<void> {
  const prepares = counts.prepares;
  h.clock.skew += 11 * MIN;
  await h.waitFor(() => counts.prepares > prepares, 'repository sync');
  const reads = counts.reads;
  await h.waitFor(() => counts.reads >= reads + 2 || h.store.getProject('drill')!.paused, 'target check after the sync');
}

const tamperEvents = (h: Harness) => h.store.listEvents({ types: ['security.target_moved'] });
const tamperCard = (h: Harness) => h.store.listDecisions({ status: ['pending'] }).find((d) => d.dedupeKey?.startsWith('target-moved:'));

test('a forged origin/main behind a ref lock never moves main at the next sync', T, async () => {
  let h!: Harness;
  let counts!: ReturnType<typeof instrument>;
  let forged = '';
  let lock = '';
  h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 1;
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    forge: (local) => {
      counts = instrument(local);
      return local;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      const common = (await ctl.git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
      forged = forgeCommit(spec.cwd, (await ctl.git(['rev-parse', 'refs/heads/main'])).trim());
      // Only origin's tracking ref is written, never main, so every tick's check passes; the ref
      // lock makes the periodic `git fetch origin` fail instead of overwriting it.
      await ctl.git(['fetch', '-q', '.', `${forged}:refs/remotes/origin/main`]);
      lock = join(common, 'refs', 'remotes', 'origin', 'main.lock');
      writeFileSync(lock, '');
      // Its own task stays out of the merge queue, so nothing legitimate moves main meanwhile.
      return { status: 'succeeded', structuredOutput: builderResult('blocked', 'need input') };
    },
  });
  try {
    h.addTask('Attacker');
    await h.sup.start();
    await h.waitFor(() => !!lock, 'attack staged');
    const recorded = h.store.getKv('target_head:drill');
    assert.ok(recorded);
    assert.equal(git(h.bare, 'rev-parse', 'refs/remotes/origin/main'), forged, 'origin/main is forged');

    await syncNow(h, counts);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main was not fast-forwarded to the forged commit');
    assert.equal(h.store.getKv('target_head:drill'), recorded, 'the forged commit was not recorded');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(sourceHas(h, forged), false, 'nothing reached the source repository');
    assert.equal(tamperEvents(h).length, 0, 'main never moved, so there is nothing to restore');
    assert.equal(h.store.getProject('drill')!.paused, false);
  } finally {
    if (lock) rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('main moved together with origin/main just before a sync is caught, restored and never pushed', T, async () => {
  let h!: Harness;
  let forged = '';
  let lock = '';
  h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 1;
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, 'w\n', 'work');
      if (forged) return { status: 'succeeded', structuredOutput: builderResult('completed') };
      const common = git(spec.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      forged = forgeCommit(spec.cwd, git(spec.cwd, 'rev-parse', 'refs/heads/main'));
      // All synchronous, so no supervisor tick runs in between (a real worker would time it from
      // repo.git/FETCH_HEAD): main and origin/main move together, and the fetch cannot repair
      // origin/main because of the ref lock.
      git(spec.cwd, 'fetch', '-q', '.', `${forged}:refs/heads/main`, `${forged}:refs/remotes/origin/main`);
      lock = join(common, 'refs', 'remotes', 'origin', 'main.lock');
      writeFileSync(lock, '');
      h.clock.skew += 11 * MIN; // the 10-minute repository sync is due now
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Attacker');
    await h.sup.start();
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    const { expected, actual, restored } = tamperEvents(h)[0].data as { expected: string; actual: string; restored: boolean };
    assert.equal(actual, forged);
    assert.equal(restored, true);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), expected, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), expected, 'the forged commit was never recorded');
    assert.equal(h.store.getProject('drill')!.paused, true, 'project paused');
    assert.equal(tamperCard(h)?.priority, 'urgent');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(sourceHas(h, forged), false, 'nothing reached the source repository');

    // The founder checks and resumes: the task's own work merges through the gate, without the
    // forged commit, and only that is pushed.
    rmSync(lock, { force: true });
    h.store.respond({ decisionId: tamperCard(h)!.id, revision: 1, optionId: 'resume', actor: 'f', idempotencyKey: 'resume-target-1' });
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(h.readTarget(`work/${t.id}.txt`), 'w\n');
    assert.equal(sourceHas(h, forged), false);
    assert.equal(tamperEvents(h).length, 1);
  } finally {
    if (lock) rmSync(lock, { force: true });
    await h.cleanup();
  }
});

/** A bare repository of the worker's, at `path`, whose main is `head`. */
function workerRepository(h: Harness, path: string, head: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '--bare');
  git(h.bare, 'push', '-q', path, `${head}:refs/heads/main`);
  return path;
}

const setOriginUrl = (h: Harness, url: string) => git(h.bare, 'config', '--file', join(h.bare, 'config'), 'remote.origin.url', url);

test('a moved main is not taken as upstream when the source cannot vouch for it at the sync', T, async () => {
  const variants = [
    // A worker that keeps rewriting repo.git/config wins the race with the config audit: the
    // fetch, and anything else that goes through origin's URL, reaches its repository.
    'origin repointed to a repository of the worker right before the fetch',
    'origin/main rewritten right after the fetch',
    'the source unreachable right after the fetch',
  ];
  for (const variant of variants) {
    let forge!: RacedFetch;
    let counts!: ReturnType<typeof instrument>;
    const h = await harness({
      behavior: noRuns,
      forge: (local) => {
        forge = new RacedFetch(local);
        counts = instrument(forge);
        return forge;
      },
    });
    const away = `${h.src}-away`;
    try {
      await h.sup.start();
      await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
      const expected = h.store.getKv('target_head:drill')!;
      const forged = forgeCommit(h.bare, expected);
      if (variant === variants[0]) {
        const theirs = workerRepository(h, join(h.tmp, 'theirs.git'), forged);
        forge.beforeFetch = () => {
          setOriginUrl(h, theirs);
          git(h.bare, 'update-ref', 'refs/heads/main', forged);
        };
      } else {
        // Right after the supervisor's fetch, before it asks the source for its head.
        forge.afterFetch = () => {
          if (variant === variants[2]) renameSync(h.src, away);
          git(h.bare, 'update-ref', 'refs/remotes/origin/main', forged);
          git(h.bare, 'update-ref', 'refs/heads/main', forged);
        };
      }
      await syncNow(h, counts);
      await h.waitFor(() => tamperEvents(h).length === 1, `tamper detected (${variant})`);
      assert.equal(forge.syncStatus(), 'unconfirmed', variant);
      assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), expected, `main restored (${variant})`);
      assert.equal(h.store.getKv('target_head:drill'), expected, variant);
      assert.equal(h.store.getProject('drill')!.paused, true, variant);
    } finally {
      try {
        renameSync(away, h.src);
      } catch {
        // never moved
      }
      await h.cleanup();
    }
  }
});

test('origin redirected between the config audit and the fetch never moves main, and none of it reaches the source', T, async () => {
  for (const variant of ["origin's URL rewritten", 'a url.<base>.insteadOf rule for the source added']) {
    let forge!: RacedFetch;
    let counts!: ReturnType<typeof instrument>;
    const h = await harness({
      config: (c) => {
        c.repo.pushIntegratedTo = 'autopilot/main';
      },
      forge: (local) => {
        forge = new RacedFetch(local);
        counts = instrument(forge);
        return forge;
      },
      behavior: (spec) => async (ctl) => {
        if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
        await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      },
    });
    try {
      await h.sup.start();
      await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
      const recorded = h.store.getKv('target_head:drill')!;
      const forged = forgeCommit(h.bare, recorded);
      const theirs = workerRepository(h, join(h.tmp, 'theirs.git'), forged);
      // The worker's repository then answers the fetch, and any other git command in repo.git
      // that names origin or the source.
      const rule = `url.${theirs}.insteadOf`;
      forge.beforeFetch = () => {
        if (variant === "origin's URL rewritten") setOriginUrl(h, theirs);
        else git(h.bare, 'config', '--file', join(h.bare, 'config'), rule, h.src);
      };
      await syncNow(h, counts);
      assert.equal(forge.syncStatus(), 'unconfirmed', `the source itself reports another head (${variant})`);
      assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, `main was not fast-forwarded to the forged head (${variant})`);
      assert.equal(h.store.getKv('target_head:drill'), recorded, variant);
      assert.equal(tamperEvents(h).length, 0, `main never moved (${variant})`);

      // The worker covers its tracks (the next audit would refuse the rule; it puts origin's URL
      // back): work merges, and only it is pushed to the source.
      if (variant !== "origin's URL rewritten") git(h.bare, 'config', '--file', join(h.bare, 'config'), '--unset', rule);
      const t = h.addTask('Feature');
      await h.waitState(t.id, 'integrated');
      await h.waitFor(() => pushedHead(h) === git(h.bare, 'rev-parse', 'refs/heads/main'), `merged work pushed (${variant})`);
      assert.equal(h.readTarget('evil.txt'), null, variant);
      assert.equal(sourceHas(h, forged), false, `the forged commit never reached the source (${variant})`);
      assert.equal(tamperEvents(h).length, 0, variant);
      assert.equal(h.store.getProject('drill')!.paused, false, variant);
    } finally {
      await h.cleanup();
    }
  }
});

test('a relative origin URL that names the source from the supervisor\'s directory is put back, never trusted', T, async () => {
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    forge: (local) => {
      counts = instrument(local);
      return local;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  const cwd = process.cwd();
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    // The supervisor runs from another directory than git, which runs in repo.git: one relative
    // URL, written once, names the source from the supervisor's directory and a repository of
    // the worker's from repo.git.
    process.chdir('/');
    const url = relative(process.cwd(), h.src);
    const forged = forgeCommit(h.bare, recorded);
    workerRepository(h, resolve(h.bare, url), forged);
    setOriginUrl(h, url);

    await syncNow(h, counts);
    assert.equal(git(h.bare, 'config', '--file', join(h.bare, 'config'), 'remote.origin.url'), h.src, 'origin is the source again');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main was not fast-forwarded to the forged head');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(tamperEvents(h).length, 0, 'main never moved');

    const t = h.addTask('Feature');
    await h.waitState(t.id, 'integrated');
    await h.waitFor(() => pushedHead(h) === git(h.bare, 'rev-parse', 'refs/heads/main'), 'merged work pushed to the source');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(sourceHas(h, forged), false, 'the forged commit never reached the source');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
  } finally {
    process.chdir(cwd);
    await h.cleanup();
  }
});

/** GitHubForge, with GitHub played by the source repository itself: no gh, no network. */
class GitHubOnSource extends GitHubForge {
  /** Runs once GitHub has merged, before the forge syncs with the source again. */
  merging: () => void = () => undefined;
  /** Runs when a merge job looks for an earlier integration of the task on the local target. */
  finding: (taskId: string, head: string) => void = () => undefined;
  protected async findIntegrated(taskId: string, head: string): Promise<string | null> {
    this.finding(taskId, head);
    return super.findIntegrated(taskId, head);
  }
  private merged = '';
  private head = '';
  protected async gh(args: string[]): Promise<CommandResult> {
    const reply = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', stdoutTruncated: false, stopped: false, timedOut: false });
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === 'pr' && args[1] === 'create') return reply('https://github.com/o/r/pull/7\n');
    if (args[0] === 'pr' && args[1] === 'merge') {
      this.head = arg('--match-head-commit');
      this.merged = git(this.source, 'commit-tree', `${this.head}^{tree}`, '-p', 'refs/heads/main', '-m', `${arg('--subject')}\n\n${arg('--body')}`);
      git(this.source, 'update-ref', 'refs/heads/main', this.merged);
      this.merging();
      return reply();
    }
    if (args[0] === 'pr' && args[1] === 'view') return reply(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: this.merged }, headRefOid: this.head }));
    return reply('[]');
  }
}

test('GitHub: origin repointed while a merge runs never brings a worker\'s head into main', T, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-drill-github-'));
  try {
    const src = join(tmp, 'source');
    mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, 'README.md'), '# drill\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'initial');
    const forge = new GitHubOnSource({ source: src, home: join(tmp, 'home'), targetBranch: 'main', branchPrefix: 'autopilot/', strategy: 'squash', repo: 'o/r', confirmDelayMs: 0 });
    await forge.prepare();
    const base = await forge.targetHead();
    const wt = await forge.createWorktree('T-1', 'feature');
    writeFileSync(join(wt.path, 'feature.txt'), 'feature\n');
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'feature');
    const head = git(wt.path, 'rev-parse', 'HEAD');
    const task = { id: 'T-1', projectId: 'drill', title: 'Feature', objective: 'Feature', branch: wt.branch, worktree: wt.path, headCommit: head, prNumber: null, prUrl: null } as Task;

    // After the forge's config audit, while GitHub merges, a worker repoints origin to a
    // repository of its own whose main is a forged commit on top of main.
    const forged = forgeCommit(forge.repoPath, base);
    const theirs = join(tmp, 'theirs.git');
    git(tmp, 'init', '-q', '--bare', theirs);
    git(forge.repoPath, 'push', '-q', theirs, `${forged}:refs/heads/main`);
    forge.merging = () => git(forge.repoPath, 'config', '--file', join(forge.repoPath, 'config'), 'remote.origin.url', theirs);
    const result = await forge.integrate(task, head, async () => []);
    assert.equal(result.status, 'merged', result.details);
    assert.equal(forge.syncStatus(), 'unconfirmed', 'the source itself reports GitHub\'s merge');
    assert.equal(await forge.targetHead(), base, 'main was not fast-forwarded to the forged head');
    assert.notEqual(forge.upstreamHead(), forged);

    // The next sync's audit puts origin's URL back, and main follows GitHub's merge.
    await forge.prepare();
    assert.equal(await forge.targetHead(), result.mergedCommit);
    assert.equal(forge.upstreamHead(), result.mergedCommit);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a head moved in just before a sync is caught before anything is pushed to the source', T, async () => {
  let h!: Harness;
  let forged = '';
  h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 1;
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, 'w\n', 'work');
      if (forged) return { status: 'succeeded', structuredOutput: builderResult('completed') };
      // Synchronously, right as the repository sync comes due; the fetch itself works.
      forged = forgeCommit(spec.cwd, git(spec.cwd, 'rev-parse', 'refs/heads/main'));
      git(spec.cwd, 'fetch', '-q', '.', `${forged}:refs/heads/main`);
      h.clock.skew += 11 * MIN;
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    h.addTask('Attacker');
    await h.sup.start();
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    assert.equal(h.store.getProject('drill')!.paused, true);
    assert.notEqual(git(h.bare, 'rev-parse', 'refs/heads/main'), forged, 'main restored');
    assert.equal(sourceHas(h, forged), false, 'the catch-up push never sent the unchecked head');
    assert.equal(pushedHead(h), null);
  } finally {
    await h.cleanup();
  }
});

test('a merge built on a head moved in after the merge check is caught before it is pushed', T, async () => {
  let forged = '';
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    forge: (local) => {
      const integrate = local.integrate.bind(local);
      local.integrate = async (task, head, runChecks) => {
        if (task.title === 'Two' && !forged) {
          // A worker moves main between the supervisor's check and the merge that builds on it.
          forged = forgeCommit(local.repoPath, git(local.repoPath, 'rev-parse', 'refs/heads/main'));
          git(local.repoPath, 'update-ref', 'refs/heads/main', forged);
        }
        return integrate(task, head, runChecks);
      };
      return local;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const one = h.addTask('One');
    await h.sup.start();
    await h.waitState(one.id, 'integrated');
    await h.waitFor(() => pushedHead(h) === git(h.bare, 'rev-parse', 'refs/heads/main'), 'first merge pushed');
    const pushed = pushedHead(h);
    const two = h.addTask('Two');
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    assert.equal(h.store.getProject('drill')!.paused, true);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), h.store.getKv('target_head:drill'), 'main restored');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.notEqual(h.store.getTask(two.id)!.state, 'integrated');
    assert.equal(sourceHas(h, forged), false, 'the merge on the moved head was never pushed');
    assert.equal(pushedHead(h), pushed);
  } finally {
    await h.cleanup();
  }
});

test('a head moved between the sync check and its record is never recorded', T, async () => {
  let counts!: ReturnType<typeof instrument>;
  let strike = false;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => {
      counts = instrument(local);
      const prepare = local.prepare.bind(local);
      const targetHead = local.targetHead.bind(local);
      let armed = false;
      local.prepare = async () => {
        const path = await prepare();
        armed = strike;
        strike = false;
        return path;
      };
      local.targetHead = async () => {
        const head = await targetHead();
        if (armed) {
          // A worker moves main right after the supervisor read it for the sync's check.
          armed = false;
          git(local.repoPath, 'update-ref', 'refs/heads/main', forgeCommit(local.repoPath, head));
        }
        return head;
      };
      return local;
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const expected = h.store.getKv('target_head:drill');
    strike = true;
    await syncNow(h, counts);
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    assert.equal(h.store.getKv('target_head:drill'), expected, 'the moved head was never recorded');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), expected, 'main restored');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(h.store.getProject('drill')!.paused, true);
  } finally {
    await h.cleanup();
  }
});

test('a head moved between the merge check and its record is never recorded or pushed', T, async () => {
  let forged = '';
  let merged = '';
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    forge: (local) => {
      const integrate = local.integrate.bind(local);
      local.integrate = async (task, head, runChecks) => {
        const result = await integrate(task, head, runChecks);
        if (result.status === 'merged' && result.mergedCommit && !forged) {
          // A worker moves main on top of the fresh merge before the supervisor records it.
          merged = result.mergedCommit;
          forged = forgeCommit(local.repoPath, merged);
          git(local.repoPath, 'update-ref', 'refs/heads/main', forged);
        }
        return result;
      };
      return local;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('One');
    await h.sup.start();
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    assert.equal(h.store.getKv('target_head:drill'), merged, 'the checked merge was recorded, not the moved head');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), merged, 'main restored to the merge');
    assert.equal(h.store.getTask(t.id)!.state, 'integrated', 'the task itself merged');
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(sourceHas(h, forged), false, 'only the checked merge may be pushed');
    assert.equal(h.store.getProject('drill')!.paused, true);
  } finally {
    await h.cleanup();
  }
});

test('an "already integrated" or "no changes" result on a moved main is tampering, not a merge', T, async () => {
  for (const variant of ['already integrated', 'no changes']) {
    let forged = '';
    let target = '';
    let details = '';
    const h = await harness({
      config: (c) => {
        c.repo.pushIntegratedTo = 'autopilot/main';
      },
      forge: (local) => {
        const integrate = local.integrate.bind(local);
        local.integrate = async (task, head, runChecks) => {
          if (!forged) {
            // Right before the merge looks at main, a worker puts a commit there that leaves the
            // forge nothing to do: a copy of its own merge commit for this task, or the task's
            // files, each with extra content.
            target = git(local.repoPath, 'rev-parse', 'refs/heads/main');
            forged =
              variant === 'already integrated'
                ? forgeCommit(local.repoPath, target, { message: `${task.title} (${task.id})\n\nAutopilot-Task: ${task.id}\nAutopilot-Head: ${head}\n` })
                : forgeCommit(local.repoPath, target, { from: head });
            git(local.repoPath, 'update-ref', 'refs/heads/main', forged);
          }
          const result = await integrate(task, head, runChecks);
          details ||= result.details;
          return result;
        };
        return local;
      },
      behavior: (spec) => async (ctl) => {
        if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
        await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      },
    });
    try {
      const t = h.addTask('One');
      await h.sup.start();
      await h.waitFor(() => tamperEvents(h).length === 1, `tamper detected (${variant})`);
      assert.equal(details, variant, 'the forge found nothing to do');
      assert.equal(h.store.getKv('target_head:drill'), target, `nothing new recorded (${variant})`);
      assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), target, `main restored (${variant})`);
      assert.notEqual(h.store.getTask(t.id)!.state, 'integrated', variant);
      assert.equal(h.readTarget('evil.txt'), null, variant);
      assert.equal(sourceHas(h, forged), false, variant);
      assert.equal(h.store.getProject('drill')!.paused, true, variant);
    } finally {
      await h.cleanup();
    }
  }
});

test('after a merge on GitHub, only the head the source confirms is recorded', T, async () => {
  for (const variant of ['a plain merge', 'main moved right after the sync']) {
    let h!: Harness;
    let forged = '';
    h = await harness({
      forge: (local) =>
        new MergesOnSource(local, () => {
          if (variant === 'a plain merge') return;
          forged = forgeCommit(h.bare, git(h.bare, 'rev-parse', 'refs/heads/main'));
          git(h.bare, 'update-ref', 'refs/heads/main', forged);
        }),
      behavior: (spec) => async (ctl) => {
        if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
        await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      },
    });
    try {
      await h.sup.start();
      await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
      const before = h.store.getKv('target_head:drill');
      const t = h.addTask('One');
      h.sup.wake();
      await h.waitState(t.id, 'integrated');
      const upstream = git(h.src, 'rev-parse', 'refs/heads/main');
      if (variant === 'a plain merge') {
        await h.waitFor(() => h.store.getKv('target_head:drill') === upstream, 'the merged head recorded');
        assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream);
        assert.equal(h.readTarget(`work/${t.id}.txt`), `${t.id}\n`);
        assert.equal(tamperEvents(h).length, 0);
        assert.equal(h.store.getProject('drill')!.paused, false);
      } else {
        await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
        assert.equal(h.store.getKv('target_head:drill'), before, 'the moved head was never recorded');
        assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), before, 'main restored');
        assert.equal(h.readTarget('evil.txt'), null);
        assert.equal(h.store.getProject('drill')!.paused, true);
      }
    } finally {
      await h.cleanup();
    }
  }
});

test('GitHub: a copy of a task\'s integration commit put on the local main is not taken for "already integrated"', T, async () => {
  let h!: Harness;
  let before = '';
  let planted = '';
  h = await harness({
    forge: (local) => {
      const gh = new GitHubOnSource({ source: local.source, home: local.home, targetBranch: 'main', branchPrefix: 'autopilot/', strategy: 'squash', repo: 'o/r', confirmDelayMs: 0 });
      // Inside the merge job, after its target check: a worker commits on main with the subject
      // and trailers of the merging task's integration, and moves main to it.
      gh.finding = (taskId, head) => {
        gh.finding = () => undefined;
        before = git(h.bare, 'rev-parse', 'refs/heads/main');
        const t = h.store.getTask(taskId)!;
        planted = forgeCommit(h.bare, before, { message: `${t.title} (${taskId})\n\nAutopilot-Task: ${taskId}\nAutopilot-Head: ${head}` });
        git(h.bare, 'update-ref', 'refs/heads/main', planted);
      };
      return gh;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Feature');
    await h.sup.start();
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    assert.notEqual(h.store.getTask(t.id)!.state, 'integrated', 'the task is not closed without a merge');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), before, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), before);
    assert.equal(h.readTarget('evil.txt'), null);
    assert.equal(h.store.getProject('drill')!.paused, true);
    assert.equal(sourceHas(h, planted), false);
  } finally {
    await h.cleanup();
  }
});

test('a real upstream push is fast-forwarded and accepted with no card, and work merges on top', T, async () => {
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    forge: (local) => {
      counts = instrument(local);
      return local;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    // The founder commits on the source's main.
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');

    await syncNow(h, counts);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream, 'fast-forwarded to the source');
    assert.equal(h.store.getKv('target_head:drill'), upstream, 'accepted and recorded');

    const t = h.addTask('Feature');
    await h.waitState(t.id, 'integrated');
    assert.equal(git(h.bare, 'rev-parse', 'main^'), upstream, 'merged on top of the upstream commit');
    assert.equal(h.readTarget('FOUNDER.md'), 'founder\n');
    await h.waitFor(() => pushedHead(h) === git(h.bare, 'rev-parse', 'main'), 'merged work pushed');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
  } finally {
    await h.cleanup();
  }
});

test('offline, work continues from the recorded head; back online, the push catches up', T, async () => {
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    forge: (local) => {
      counts = instrument(local);
      return local;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  const away = `${h.src}-away`;
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    renameSync(h.src, away); // the source repository is unreachable from now on

    const one = h.addTask('One');
    await h.waitState(one.id, 'integrated');
    await syncNow(h, counts); // the fetch fails: nothing moves, nothing is flagged
    const two = h.addTask('Two');
    await h.waitState(two.id, 'integrated');
    const head = git(h.bare, 'rev-parse', 'refs/heads/main');
    assert.equal(h.store.getKv('target_head:drill'), head);
    assert.equal(h.readTarget(`work/${one.id}.txt`), `${one.id}\n`);
    assert.equal(h.readTarget(`work/${two.id}.txt`), `${two.id}\n`);

    renameSync(away, h.src);
    await syncNow(h, counts);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), head, 'the local work stays');
    await h.waitFor(() => pushedHead(h) === head, 'the push caught up after the sync');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
  } finally {
    try {
      renameSync(away, h.src);
    } catch {
      // already back
    }
    await h.cleanup();
  }
});

/**
 * What a supervisor that died in the middle of a merge leaves behind (as in drills.test.ts): the
 * target head it recorded, one task merging (leased by the dead process) and one queued in
 * merge_ready, both checked and approved on their heads. `forge` plays the dead process's part.
 */
async function crashedWhileMerging(h: Harness) {
  const forge = new LocalForge({ source: h.src, home: dirname(h.bare), targetBranch: 'main', branchPrefix: h.cfg.repo.branchPrefix, strategy: h.cfg.integration.strategy, pushIntegratedTo: null });
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

test('a merge a crash cut off is still kept when the restart after it ends before its first check', T, async () => {
  for (const variant of ['the restart died during its repository sync', 'the project stayed paused through a restart']) {
    let dieInSync = variant === 'the restart died during its repository sync';
    const h = await harness({
      behavior: noRuns,
      forge: (local) => {
        if (dieInSync) {
          dieInSync = false; // only the first restart's forge
          local.prepare = async () => {
            throw new Error('killed during the repository sync');
          };
        }
        return local;
      },
    });
    try {
      const { forge, interrupted, queued } = await crashedWhileMerging(h);
      const merged = await forge.integrate(interrupted, interrupted.headCommit!, async () => [], (commit, base) => h.store.setKv('merge_pending:drill', JSON.stringify({ taskId: interrupted.id, base, commit }))); // ... then the process died
      assert.equal(merged.status, 'merged', merged.details);
      if (variant === 'the project stayed paused through a restart') h.store.setProjectPaused('drill', true, 'paused by the founder');
      await h.sup.start(); // crash recovery, but no target check before the next restart
      if (variant === 'the restart died during its repository sync') {
        await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the sync failed');
      }
      await h.restart();
      if (variant === 'the project stayed paused through a restart') h.sup.resumeProject('drill', 'resumed by the founder');
      const done = () => [interrupted.id, queued.id].every((t) => h.store.getTask(t)!.state === 'integrated');
      await h.waitFor(() => done() || h.store.getProject('drill')!.paused, `queue continued (${variant})`);
      assert.equal(tamperEvents(h).length, 0, variant);
      assert.equal(h.store.getProject('drill')!.paused, false, variant);
      assert.equal(h.store.getTask(interrupted.id)!.state, 'integrated', variant);
      assert.equal(git(h.bare, 'rev-parse', 'main~1'), merged.mergedCommit, `kept, not merged a second time (${variant})`);
      assert.equal(h.store.getKv('target_head:drill'), git(h.bare, 'rev-parse', 'main'), variant);
      assert.equal(h.store.listRuns({}).length, 0, variant);
    } finally {
      await h.cleanup();
    }
  }
});

test('a copy of the merge in flight that a worker put on main is not kept when the supervisor dies', T, async () => {
  for (const variant of ['during the integration checks', 'after the merge was announced, before main moved']) {
    const h = await harness({ behavior: noRuns, config: (c) => void (c.repo.pushIntegratedTo = 'autopilot/main') });
    try {
      const { forge, target, interrupted, queued } = await crashedWhileMerging(h);
      let planted = '';
      // While the dead process's merge ran its checks (ticks skip the target check then), a worker
      // copied the parent, subject and trailers of the integration commit in flight onto other
      // content and moved main to it.
      const plant = (integrationWorktree: string) => {
        planted = forgeCommit(h.bare, target, { message: git(integrationWorktree, 'log', '-1', '--format=%B', 'HEAD') });
        git(h.bare, 'update-ref', 'refs/heads/main', planted);
      };
      const died = new Error('the process died');
      const announce = (commit: string, base: string) => {
        h.store.setKv('merge_pending:drill', JSON.stringify({ taskId: interrupted.id, base, commit }));
        if (variant === 'after the merge was announced, before main moved') throw died;
      };
      await forge
        .integrate(
          interrupted,
          interrupted.headCommit!,
          async (cwd) => {
            plant(cwd);
            if (variant === 'during the integration checks') throw died;
            return [];
          },
          announce,
        )
        .catch(() => undefined);
      assert.ok(planted, variant);
      await h.sup.start();
      await h.waitFor(() => tamperEvents(h).length === 1, `tamper detected (${variant})`);
      assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), target, `main restored (${variant})`);
      assert.equal(h.store.getKv('target_head:drill'), target, variant);
      assert.equal(h.store.getProject('drill')!.paused, true, variant);
      assert.notEqual(h.store.getTask(interrupted.id)!.state, 'integrated', variant);
      assert.notEqual(h.store.getTask(queued.id)!.state, 'integrated', variant);
      assert.equal(sourceHas(h, planted), false, `nothing pushed (${variant})`);
    } finally {
      await h.cleanup();
    }
  }
});

test('a merge job drops the record of an earlier attempt that died before moving main', T, async () => {
  let h!: Harness;
  let atJobStart: string | null | undefined;
  let atFirstStep: string | null | undefined;
  h = await harness({
    behavior: noRuns,
    forge: (local) => {
      const integrate = local.integrate.bind(local);
      local.integrate = async (task, head, runChecks, beforeMove) => {
        if (atJobStart === undefined) atJobStart = h.store.getKv('merge_pending:drill');
        return integrate(task, head, runChecks, beforeMove);
      };
      const diff = local.diff.bind(local);
      local.diff = async (base, head, max) => {
        if (atFirstStep === undefined) atFirstStep = h.store.getKv('merge_pending:drill'); // the job reads its diff first
        return diff(base, head, max);
      };
      return local;
    },
  });
  try {
    const { forge, target, interrupted } = await crashedWhileMerging(h);
    // The dead process's merge job stored its commit, then died before its compare-and-swap.
    await forge
      .integrate(interrupted, interrupted.headCommit!, async () => [], (commit, base) => {
        h.store.setKv('merge_pending:drill', JSON.stringify({ taskId: interrupted.id, base, commit }));
        throw new Error('the process died');
      })
      .catch(() => undefined);
    assert.ok(h.store.getKv('merge_pending:drill'), 'the dead job left its record');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), target);
    await h.sup.start(); // main is where it was: the task is merged again
    await h.waitState(interrupted.id, 'integrated');
    assert.equal(atFirstStep, null, "the dead job's record is gone before the new merge job does anything else");
    assert.equal(atJobStart, null, "the new merge job does not run with the dead job's record");
    assert.equal(tamperEvents(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('the crash-recovery exception ends with the first check after a restart, also for later restarts', T, async () => {
  let h!: Harness;
  let pauseAtCheck = true;
  h = await harness({
    behavior: noRuns,
    forge: (local) => {
      const targetHead = local.targetHead.bind(local);
      local.targetHead = async () => {
        const head = await targetHead();
        if (pauseAtCheck) {
          // The founder pauses the project while its first check after the restart runs, so the
          // interrupted task stays queued.
          pauseAtCheck = false;
          h.sup.pauseProject('drill', 'paused by the founder');
        }
        return head;
      };
      return local;
    },
  });
  try {
    // The crash came before the merge moved main: the first check finds main where it was.
    const { forge, target, interrupted } = await crashedWhileMerging(h);
    await h.sup.start();
    await h.waitFor(() => h.store.getProject('drill')!.paused, 'first check after the restart');
    await h.restart(); // (waits for that check to finish)
    // While the supervisor was down, main was moved to exactly the merge it would have made.
    const copy = await forge.integrate(interrupted, interrupted.headCommit!, async () => []);
    assert.equal(copy.status, 'merged', copy.details);
    h.sup.resumeProject('drill', 'resumed by the founder');
    await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
    assert.equal((tamperEvents(h)[0].data as { actual: string }).actual, copy.mergedCommit);
    assert.equal(git(h.bare, 'rev-parse', 'main'), target, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), target);
    assert.equal(h.store.getProject('drill')!.paused, true);
    assert.notEqual(h.store.getTask(interrupted.id)!.state, 'integrated');
  } finally {
    await h.cleanup();
  }
});

test('a merge is recorded before anything else can fail, so a failure right after it raises no tamper card', T, async () => {
  const h = await harness({
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  // Storing the integration checks fails once (say, the database is busy), right after the merge
  // moved main.
  const recordChecks = h.store.recordChecks.bind(h.store);
  let failures = 0;
  h.store.recordChecks = (taskId, headCommit, scope, results) => {
    if (scope === 'integration' && failures++ === 0) throw new Error('database is locked');
    recordChecks(taskId, headCommit, scope, results);
  };
  try {
    const t = h.addTask('One');
    await h.sup.start();
    await h.waitFor(() => h.store.getTask(t.id)!.state === 'integrated' || h.store.getProject('drill')!.paused, 'merged or paused');
    assert.ok(failures > 0, 'the failure happened');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
    assert.equal(h.store.getTask(t.id)!.state, 'integrated');
    const main = git(h.bare, 'rev-parse', 'refs/heads/main');
    assert.equal(h.store.getKv('target_head:drill'), main);
    assert.equal(git(h.bare, 'rev-list', '--count', '--first-parent', 'refs/heads/main'), '2', 'merged once, not twice');
    assert.equal(h.readTarget(`work/${t.id}.txt`), `${t.id}\n`);
  } finally {
    await h.cleanup();
  }
});

/**
 * GitHub refusing a merge, without GitHub: as GitHubForge.integrate() does, the local target is
 * first synced with the source (fast-forwarded to the head the source confirms); then
 * `afterSync` runs (a worker acting before the supervisor looks) and the merge is refused.
 */
class RefusedOnSource extends LocalForge {
  readonly kind: 'local' | 'github' = 'github';
  readonly afterSync: () => void;
  constructor(local: LocalForge, afterSync: () => void) {
    super(optionsOf(local));
    this.afterSync = afterSync;
  }
  async integrate(): Promise<IntegrationResult> {
    this.confirmedUpstream = null;
    if (await this.fetchOrigin()) await this.syncTarget();
    this.afterSync();
    return { status: 'blocked_by_forge', mergedCommit: null, checks: [], details: 'base branch policy prohibits the merge' };
  }
}

test('when GitHub refuses a merge after its sync moved main, only the head the source confirms is recorded', T, async () => {
  for (const variant of ['the sync fast-forwarded main', 'main moved right after the sync']) {
    let h!: Harness;
    let counts!: ReturnType<typeof instrument>;
    h = await harness({
      forge: (local) => {
        const forge = new RefusedOnSource(local, () => {
          if (variant === 'main moved right after the sync') git(h.bare, 'update-ref', 'refs/heads/main', forgeCommit(h.bare, git(h.bare, 'rev-parse', 'refs/heads/main')));
        });
        counts = instrument(forge);
        return forge;
      },
      behavior: (spec) => async (ctl) => {
        if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
        await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
        return { status: 'succeeded', structuredOutput: builderResult('completed') };
      },
    });
    try {
      await h.sup.start();
      await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
      const before = h.store.getKv('target_head:drill');
      // The founder commits on the source's main; the next sync is the merge's own.
      writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
      git(h.src, 'add', 'FOUNDER.md');
      git(h.src, 'commit', '-q', '-m', 'founder commit');
      const upstream = git(h.src, 'rev-parse', 'main');
      const t = h.addTask('One');
      h.sup.wake();
      await h.waitState(t.id, 'waiting_decision');
      assert.ok(h.store.listDecisions({ status: ['pending'] }).some((d) => d.dedupeKey === 'forge-blocked:drill'), `refusal reported (${variant})`);
      const reads = counts.reads;
      await h.waitFor(() => counts.reads >= reads + 2 || h.store.getProject('drill')!.paused, `target checked after the merge (${variant})`);
      if (variant === 'the sync fast-forwarded main') {
        assert.equal(tamperEvents(h).length, 0);
        assert.equal(h.store.getProject('drill')!.paused, false);
        assert.equal(h.store.getKv('target_head:drill'), upstream, 'the fast-forward was recorded');
        assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream);
      } else {
        await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
        assert.equal(h.store.getKv('target_head:drill'), before, 'the moved head was never recorded');
        assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), before, 'main restored');
        assert.equal(h.readTarget('evil.txt'), null);
        assert.equal(h.store.getProject('drill')!.paused, true);
      }
    } finally {
      await h.cleanup();
    }
  }
});

test('a sync a crash cut off before its record is kept by a restart that cannot reach the source', T, async () => {
  for (const variant of ['main where the sync left it', 'main moved past it while the supervisor was down']) {
    let crash = false;
    const h = await harness({
      behavior: noRuns,
      forge: (local) => {
        const prepare = local.prepare.bind(local);
        local.prepare = async () => {
          const path = await prepare();
          if (crash) {
            // The process dies right after the sync moved main, before the supervisor checked
            // and recorded it.
            crash = false;
            throw new Error('killed right after the repository sync');
          }
          return path;
        };
        return local;
      },
    });
    const away = `${h.src}-away`;
    try {
      await h.sup.start();
      await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
      const recorded = h.store.getKv('target_head:drill')!;
      writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
      git(h.src, 'add', 'FOUNDER.md');
      git(h.src, 'commit', '-q', '-m', 'founder commit');
      const upstream = git(h.src, 'rev-parse', 'main');
      crash = true;
      h.clock.skew += 11 * MIN;
      await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the sync, then the crash');
      assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream, 'the sync moved main');
      assert.equal(h.store.getKv('target_head:drill'), recorded, 'the crash came before the record');

      renameSync(h.src, away); // the restart cannot reach the source
      const moved = variant === 'main where the sync left it' ? upstream : forgeCommit(h.bare, upstream);
      git(h.bare, 'update-ref', 'refs/heads/main', moved);
      await h.restart();
      if (variant === 'main where the sync left it') {
        await h.waitFor(() => h.store.getKv('target_head:drill') === upstream || h.store.getProject('drill')!.paused, 'the sync recorded');
        assert.equal(tamperEvents(h).length, 0);
        assert.equal(h.store.getProject('drill')!.paused, false);
        assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream);
        assert.equal(h.readTarget('FOUNDER.md'), 'founder\n');
      } else {
        await h.waitFor(() => tamperEvents(h).length === 1, 'tamper detected');
        assert.equal((tamperEvents(h)[0].data as { actual: string }).actual, moved);
        assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
        assert.equal(h.store.getKv('target_head:drill'), recorded);
        assert.equal(h.store.getProject('drill')!.paused, true);
      }
    } finally {
      try {
        renameSync(away, h.src);
      } catch {
        // never moved
      }
      await h.cleanup();
    }
  }
});

test('a fast-forward is remembered only until its check, so a head the source dropped is never taken from it', T, async () => {
  let forge!: RacedFetch;
  let counts!: ReturnType<typeof instrument>;
  let strikeOn: string | null = null;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => {
      forge = new RacedFetch(local);
      const prepare = forge.prepare.bind(forge);
      forge.prepare = async () => {
        const path = await prepare();
        if (strikeOn) {
          // A worker moves main past the sync's fast-forward before the supervisor checks it.
          git(forge.repoPath, 'update-ref', 'refs/heads/main', forgeCommit(forge.repoPath, strikeOn));
          strikeOn = null;
        }
        return path;
      };
      counts = instrument(forge);
      return forge;
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    strikeOn = dropped;
    await syncNow(h, counts);
    await h.waitFor(() => tamperEvents(h).length === 1, 'the moved head caught at the sync check');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');

    // The founder drops the commit from the source again (say it leaked a secret) and resumes.
    // At the next sync, right after the fetch, a worker puts main on the dropped commit.
    git(h.src, 'reset', '-q', '--hard', recorded);
    h.sup.resumeProject('drill', 'resumed by the founder');
    forge.afterFetch = () => git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await syncNow(h, counts);
    await h.waitFor(() => tamperEvents(h).length === 2, 'the dropped head caught');
    assert.equal((tamperEvents(h)[0].data as { actual: string }).actual, dropped, 'the latest event');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(h.readTarget('LEAK.md'), null);
    assert.equal(h.store.getProject('drill')!.paused, true);
  } finally {
    await h.cleanup();
  }
});

/**
 * GitHub merging after the founder pushed, without GitHub: as GitHubForge.integrate() does, the
 * local target is synced with the source before the merge (fast-forwarded to the founder's
 * commit); the task head is squash-merged on the source; and the sync after the merge cannot
 * move main, because another git process holds its lock for a moment (afterMerge only warns).
 */
class MergedWhileLocked extends LocalForge {
  readonly kind: 'local' | 'github' = 'github';
  constructor(local: LocalForge) {
    super(optionsOf(local));
  }
  async integrate(task: Task, expectedHead: string): Promise<IntegrationResult> {
    this.confirmedUpstream = null;
    if (await this.fetchOrigin()) await this.syncTarget();
    git(this.repoPath, 'push', '-q', this.source, `${expectedHead}:refs/pull/${task.id}/head`);
    const message = `${task.title} (${task.id})\n\nAutopilot-Task: ${task.id}\nAutopilot-Head: ${expectedHead}`;
    const merged = git(this.source, 'commit-tree', `${expectedHead}^{tree}`, '-p', 'refs/heads/main', '-m', message);
    git(this.source, 'update-ref', 'refs/heads/main', merged);
    const lock = join(this.repoPath, 'refs', 'heads', 'main.lock');
    writeFileSync(lock, '');
    let details = `merged on the source as ${merged.slice(0, 10)}`;
    try {
      if (await this.fetchOrigin()) await this.syncTarget();
    } catch (err) {
      details += `; warning: could not update the local main: ${(err as Error).message}`;
    } finally {
      rmSync(lock, { force: true });
    }
    return { status: 'merged', mergedCommit: merged, checks: [], details };
  }
}

test('when the sync after a GitHub merge cannot move main, the move of the sync before it is still recorded', T, async () => {
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    forge: (local) => {
      const forge = new MergedWhileLocked(local);
      counts = instrument(forge);
      return forge;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    // The founder commits on the source's main; the next sync is the merge's own.
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');
    const t = h.addTask('One');
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    const reads = counts.reads;
    await h.waitFor(() => counts.reads >= reads + 2 || h.store.getProject('drill')!.paused, 'target checked after the merge');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
    assert.equal(h.store.getKv('target_head:drill'), upstream, 'the fast-forward before the merge was recorded');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream, 'the sync after the merge could not move main');
    assert.notEqual(git(h.src, 'rev-parse', 'main'), upstream, 'GitHub merged on top of the founder commit');

    // The next sync brings GitHub's merge.
    await syncNow(h, counts);
    const merged = git(h.src, 'rev-parse', 'main');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), merged);
    assert.equal(h.store.getKv('target_head:drill'), merged);
    assert.equal(h.readTarget(`work/${t.id}.txt`), `${t.id}\n`);
    assert.equal(tamperEvents(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

/** MergedWhileLocked, where a worker can also act right after the fetch of a later sync. */
class MergedWhileLockedRaced extends MergedWhileLocked {
  afterFetch: (() => void) | null = null;
  protected async fetchOrigin(): Promise<boolean> {
    const ok = await super.fetchOrigin();
    const after = this.afterFetch;
    this.afterFetch = null;
    after?.();
    return ok;
  }
}

test('the heads a GitHub merge\'s syncs stored are forgotten at its check, so one the source dropped is never taken from them', T, async () => {
  let forge!: MergedWhileLockedRaced;
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    forge: (local) => {
      forge = new MergedWhileLockedRaced(local);
      counts = instrument(forge);
      return forge;
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');
    const t = h.addTask('One');
    h.sup.wake();
    await h.waitState(t.id, 'integrated');
    const reads = counts.reads;
    await h.waitFor(() => counts.reads >= reads + 2 || h.store.getProject('drill')!.paused, 'target checked after the merge');
    assert.equal(h.store.getKv('target_head:drill'), upstream, 'the fast-forward before the merge was recorded');
    const merged = git(h.src, 'rev-parse', 'main');
    assert.notEqual(merged, upstream, 'GitHub merged on top of the founder commit');

    // The founder takes GitHub's merge back out of the source. At the next sync, right after
    // the fetch, a worker puts main on it.
    git(h.src, 'reset', '-q', '--hard', upstream);
    forge.afterFetch = () => git(h.bare, 'update-ref', 'refs/heads/main', merged);
    await syncNow(h, counts);
    assert.equal(tamperEvents(h).length, 1, 'the dropped merge caught');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), upstream);
    assert.equal(h.readTarget(`work/${t.id}.txt`), null);
    assert.equal(h.store.getProject('drill')!.paused, true);
  } finally {
    await h.cleanup();
  }
});

/** The real LocalForge, but the process can die right after a sync's fast-forward moved main. */
class DiesAfterFastForward extends LocalForge {
  die = false;
  constructor(local: LocalForge) {
    super(optionsOf(local));
  }
  protected async run(args: string[], cwd: string, opts: Omit<GitOptions, 'cwd'> = {}): Promise<GitResult> {
    const result = await super.run(args, cwd, opts);
    if (this.die && args[0] === 'update-ref' && result.code === 0) {
      this.die = false;
      throw new Error('killed right after the fast-forward');
    }
    return result;
  }
}

test('a sync cut off right after its fast-forward is kept by a restart that cannot reach the source', T, async () => {
  let forge!: DiesAfterFastForward;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => (forge = new DiesAfterFastForward(local)),
  });
  const away = `${h.src}-away`;
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');
    forge.die = true;
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the fast-forward, then the crash');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream, 'the sync moved main');
    assert.equal(h.store.getKv('target_head:drill'), recorded, 'the crash came before the record');

    renameSync(h.src, away); // the restart cannot reach the source
    await h.restart();
    await h.waitFor(() => h.store.getKv('target_head:drill') === upstream || h.store.getProject('drill')!.paused, 'the sync recorded');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream);
  } finally {
    try {
      renameSync(away, h.src);
    } catch {
      // never moved
    }
    await h.cleanup();
  }
});

test('when the head a sync is about to fast-forward to cannot be stored, main does not move', T, async () => {
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => {
      counts = instrument(local);
      return local;
    },
  });
  const setKv = h.store.setKv.bind(h.store);
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');
    let failures = 0;
    h.store.setKv = (...args: Parameters<typeof setKv>) => {
      if (args[0].startsWith('upstream_heads:') && args[1] !== null) {
        failures++;
        throw new Error('database is locked');
      }
      return setKv(...args);
    };
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    assert.equal(failures, 1);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main did not move');
    assert.equal(h.store.getKv('target_head:drill'), recorded);

    h.store.setKv = setKv; // the store works again: the retry moves main and records it
    await syncNow(h, counts);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream);
    assert.equal(h.store.getKv('target_head:drill'), upstream);
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
  } finally {
    h.store.setKv = setKv;
    await h.cleanup();
  }
});

/** The real LocalForge, but a drill can make it lose the exit status of a fast-forward that moved main, then die. */
class FlakyCas extends LocalForge {
  /** Report failure for the next fast-forward of main that succeeded (as a kill after git's rename would). */
  lie = false;
  /** Then throw from prepare(), before the supervisor's check (as a crash would). */
  dieAfter = false;
  constructor(local: LocalForge) {
    super(optionsOf(local));
  }
  protected async run(args: string[], cwd: string, opts: Omit<GitOptions, 'cwd'> = {}): Promise<GitResult> {
    const result = await super.run(args, cwd, opts);
    if (this.lie && args[0] === 'update-ref' && args[1] === 'refs/heads/main' && result.code === 0) {
      this.lie = false;
      return { ...result, code: 143, stderr: 'terminated' };
    }
    return result;
  }
  async prepare(): Promise<string> {
    const path = await super.prepare();
    if (this.dieAfter) {
      this.dieAfter = false;
      throw new Error('killed before the check');
    }
    return path;
  }
}

test('a fast-forward whose exit status was lost after it moved main is kept by a restart that cannot reach the source', T, async () => {
  let forge!: FlakyCas;
  const h = await harness({ behavior: noRuns, forge: (local) => (forge = new FlakyCas(local)) });
  const away = `${h.src}-away`;
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');
    forge.lie = true;
    forge.dieAfter = true;
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the sync, then the crash');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream, 'the sync moved main');
    renameSync(h.src, away);
    await h.restart();
    await h.waitFor(() => h.store.getKv('target_head:drill') === upstream || h.store.getProject('drill')!.paused, 'the restart check');
    assert.equal(tamperEvents(h).length, 0);
    assert.equal(h.store.getProject('drill')!.paused, false);
    assert.equal(h.store.getKv('target_head:drill'), upstream);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), upstream);
  } finally {
    try {
      renameSync(away, h.src);
    } catch {
      // never moved
    }
    await h.cleanup();
  }
});

test('a head whose failed fast-forward could not be dropped from the store is still never taken from it', T, async () => {
  let forge!: RacedFetch;
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    behavior: noRuns,
    forge: (local) => {
      forge = new RacedFetch(local);
      counts = instrument(forge);
      return forge;
    },
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  const setKv = h.store.setKv.bind(h.store);
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    // The sync stores the head, its fast-forward fails on a held ref lock, and dropping the head
    // from the store fails once too (say, the database is busy).
    let failures = 0;
    h.store.setKv = (...args: Parameters<typeof setKv>) => {
      if (args[0] === 'upstream_heads:drill' && typeof args[1] === 'string' && !args[1].includes(dropped) && failures === 0) {
        failures++;
        throw new Error('database is locked');
      }
      return setKv(...args);
    };
    forge.afterFetch = () => writeFileSync(lock, '');
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    h.store.setKv = setKv;
    rmSync(lock, { force: true });
    assert.equal(failures, 1);
    assert.ok(h.store.getKv('upstream_heads:drill')?.includes(dropped), 'the drop did not reach the store');
    // The founder drops the commit upstream; a worker puts main on it.
    git(h.src, 'reset', '-q', '--hard', recorded);
    git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await syncNow(h, counts);
    assert.equal(tamperEvents(h).length, 1, 'the dropped head caught');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(h.readTarget('LEAK.md'), null);
    assert.notEqual(pushedHead(h), dropped, 'never pushed to the source');
  } finally {
    h.store.setKv = setKv;
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

/** A worker breaks the shared config right after a sync's fast-forward failed, so the read of main after it fails too. */
class UnreadableAfterCas extends LocalForge {
  armed = false;
  constructor(local: LocalForge) {
    super(optionsOf(local));
  }
  protected async run(args: string[], cwd: string, opts: Omit<GitOptions, 'cwd'> = {}): Promise<GitResult> {
    const result = await super.run(args, cwd, opts);
    if (this.armed && args[0] === 'update-ref' && args[1] === 'refs/heads/main' && result.code !== 0) {
      this.armed = false;
      execFileSync('cp', [join(this.repoPath, 'config'), join(this.repoPath, 'config.saved')]);
      writeFileSync(join(this.repoPath, 'config'), '\n[broken\n', { flag: 'a' });
    }
    return result;
  }
  restoreConfig(): void {
    execFileSync('mv', [join(this.repoPath, 'config.saved'), join(this.repoPath, 'config')]);
  }
}

test('a head whose failed fast-forward was followed by a failed read of main is never taken from the store', T, async () => {
  let forge!: UnreadableAfterCas;
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    behavior: noRuns,
    forge: (local) => {
      forge = new UnreadableAfterCas(local);
      counts = instrument(forge);
      return forge;
    },
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    // The fast-forward fails on a held ref lock, and the read of main after it fails as well.
    writeFileSync(lock, '');
    forge.armed = true;
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    forge.restoreConfig();
    rmSync(lock, { force: true });
    assert.equal(forge.armed, false, 'the fast-forward failed and the config broke after it');
    assert.match(h.store.listEvents({ types: ['project.prepare_failed'] })[0].message, /rev-parse/);
    assert.ok(!(h.store.getKv('upstream_heads:drill') ?? '').includes(dropped), 'the head was dropped');
    // The founder drops the commit upstream; a worker puts main on it.
    git(h.src, 'reset', '-q', '--hard', recorded);
    git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await syncNow(h, counts);
    assert.equal(tamperEvents(h).length, 1, 'the dropped head caught');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.notEqual(pushedHead(h), dropped);
  } finally {
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('a head whose fast-forward failed is not vouched for by the confirmation of that same sync either', T, async () => {
  let forge!: RacedFetch;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => (forge = new RacedFetch(local)),
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'FOUNDER.md'), 'founder\n');
    git(h.src, 'add', 'FOUNDER.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const upstream = git(h.src, 'rev-parse', 'main');
    forge.afterFetch = () => writeFileSync(lock, '');
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    rmSync(lock, { force: true });
    // Until the next sync the forge still reports the head that sync confirmed: a worker puts main on it.
    assert.equal(forge.upstreamHead(), upstream);
    git(h.bare, 'update-ref', 'refs/heads/main', upstream);
    const rt = (h.sup as any).runtimes.get('drill');
    assert.equal(await (h.sup as any).isUpstreamAdvance(rt, recorded, upstream), false);
  } finally {
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('a head whose fast-forward failed is not taken by a restart either, after the source dropped it', T, async () => {
  let forge!: RacedFetch;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    behavior: noRuns,
    forge: (local) => (forge = new RacedFetch(local)),
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    forge.afterFetch = () => writeFileSync(lock, '');
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    rmSync(lock, { force: true });
    // The founder drops the commit upstream; a worker puts main on it; the supervisor restarts.
    git(h.src, 'reset', '-q', '--hard', recorded);
    git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await h.restart();
    await h.waitFor(() => tamperEvents(h).length > 0 || pushedHead(h) === dropped, 'the restart check');
    assert.equal(tamperEvents(h).length, 1, 'the dropped head caught');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(h.readTarget('LEAK.md'), null);
    assert.notEqual(pushedHead(h), dropped);
  } finally {
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('a head stored by a sync that could not move main is forgotten, so a head the source dropped is never taken from it', T, async () => {
  let forge!: RacedFetch;
  let counts!: ReturnType<typeof instrument>;
  const h = await harness({
    config: (c) => {
      c.repo.pushIntegratedTo = 'autopilot/main';
    },
    behavior: noRuns,
    forge: (local) => {
      forge = new RacedFetch(local);
      counts = instrument(forge);
      return forge;
    },
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    // Another git process holds main's lock during the sync that confirms the founder's commit:
    // the fast-forward fails, and so does the sync, before any check.
    forge.afterFetch = () => writeFileSync(lock, '');
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    rmSync(lock, { force: true });
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'the sync could not move main');

    // The founder drops the commit from the source (it leaked a secret). Before the retry, a
    // worker puts main on it.
    git(h.src, 'reset', '-q', '--hard', recorded);
    git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await syncNow(h, counts);
    assert.equal(tamperEvents(h).length, 1, 'the dropped head caught');
    assert.equal((tamperEvents(h)[0].data as { actual: string }).actual, dropped);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(h.readTarget('LEAK.md'), null);
    assert.notEqual(pushedHead(h), dropped, 'never pushed to the source');
    assert.equal(h.store.getProject('drill')!.paused, true);
  } finally {
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('a head stored by a failed sync is forgotten even when a worker moves main while the failure is handled', T, async () => {
  let forge!: RacedFetch;
  let counts!: ReturnType<typeof instrument>;
  let strike: (() => void) | null = null;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => {
      forge = new RacedFetch(local);
      counts = instrument(forge);
      const prepare = forge.prepare.bind(forge);
      forge.prepare = async () => {
        try {
          return await prepare();
        } catch (err) {
          const s = strike;
          strike = null;
          s?.();
          throw err;
        }
      };
      return forge;
    },
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    // A worker holds main's lock during the sync, and moves main elsewhere as soon as the sync
    // has failed, while the supervisor handles the failure; then it puts main back.
    forge.afterFetch = () => writeFileSync(lock, '');
    strike = () => {
      rmSync(lock, { force: true });
      git(h.bare, 'update-ref', 'refs/heads/main', forgeCommit(h.bare, recorded));
    };
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    git(h.bare, 'update-ref', 'refs/heads/main', recorded);

    git(h.src, 'reset', '-q', '--hard', recorded);
    git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await syncNow(h, counts);
    assert.equal(tamperEvents(h).length, 1, 'the dropped head caught');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(h.readTarget('LEAK.md'), null);
  } finally {
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('a head stored by a failed sync is forgotten even when a worker puts main on it while the failure is handled', T, async () => {
  let forge!: RacedFetch;
  let counts!: ReturnType<typeof instrument>;
  let strike: (() => void) | null = null;
  const h = await harness({
    behavior: noRuns,
    forge: (local) => {
      forge = new RacedFetch(local);
      counts = instrument(forge);
      const prepare = forge.prepare.bind(forge);
      forge.prepare = async () => {
        try {
          return await prepare();
        } catch (err) {
          const s = strike;
          strike = null;
          s?.();
          throw err;
        }
      };
      return forge;
    },
  });
  const lock = join(h.bare, 'refs', 'heads', 'main.lock');
  try {
    await h.sup.start();
    await h.waitFor(() => !!h.store.getKv('target_head:drill'), 'first sync recorded');
    const recorded = h.store.getKv('target_head:drill')!;
    writeFileSync(join(h.src, 'LEAK.md'), 'oops\n');
    git(h.src, 'add', 'LEAK.md');
    git(h.src, 'commit', '-q', '-m', 'founder commit');
    const dropped = git(h.src, 'rev-parse', 'main');
    // A worker holds main's lock during the sync, and puts main on the head the sync stored as
    // soon as the sync has failed, while the supervisor handles the failure; then it puts main back.
    forge.afterFetch = () => writeFileSync(lock, '');
    strike = () => {
      rmSync(lock, { force: true });
      git(h.bare, 'update-ref', 'refs/heads/main', dropped); // the source still has it here
    };
    h.clock.skew += 11 * MIN;
    await h.waitFor(() => h.store.listEvents({ types: ['project.prepare_failed'] }).length > 0, 'the failed sync');
    git(h.bare, 'update-ref', 'refs/heads/main', recorded);

    git(h.src, 'reset', '-q', '--hard', recorded);
    git(h.bare, 'update-ref', 'refs/heads/main', dropped);
    await syncNow(h, counts);
    assert.equal(tamperEvents(h).length, 1, 'the dropped head caught');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded, 'main restored');
    assert.equal(h.store.getKv('target_head:drill'), recorded);
    assert.equal(h.readTarget('LEAK.md'), null);
  } finally {
    rmSync(lock, { force: true });
    await h.cleanup();
  }
});

test('a target moved while a merge measures the branch never hides commits from the secret scan or the merge policy', T, async () => {
  const key = ['AKIA', 'Q7Z2LM4N8P3R5T6V'].join(''); // assembled here, so this file holds no key-shaped text
  let first = '';
  let recorded = '';
  let moveBack = false;
  const h = await harness({
    behavior: noRuns,
    config: (c) => void (c.repo.pushIntegratedTo = 'autopilot/main'),
    forge: (local) => {
      const diff = local.diff.bind(local);
      local.diff = async (base, head, max) => {
        if (moveBack) {
          moveBack = false;
          git(local.repoPath, 'update-ref', 'refs/heads/main', recorded); // ... and back before the merge's own check
        }
        return diff(base, head, max);
      };
      return local;
    },
  });
  try {
    const setup = new LocalForge({ source: h.src, home: dirname(h.bare), targetBranch: 'main', branchPrefix: h.cfg.repo.branchPrefix, strategy: h.cfg.integration.strategy, pushIntegratedTo: null });
    await setup.prepare();
    recorded = await setup.targetHead();
    h.store.setKv('target_head:drill', recorded);
    // A branch whose first commit adds a key and whose second adds a feature, checked and approved.
    const t = h.addTask('Feature');
    const wt = await setup.createWorktree(t.id, 'feature');
    writeFileSync(join(wt.path, 'creds.txt'), `aws_access_key_id = ${key}\n`);
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'config');
    first = git(wt.path, 'rev-parse', 'HEAD');
    writeFileSync(join(wt.path, 'feature.txt'), 'feature\n');
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'feature');
    const head = git(wt.path, 'rev-parse', 'HEAD');
    h.store.patchTask(t.id, { branch: wt.branch, worktree: wt.path, baseCommit: recorded, headCommit: head });
    h.store.recordChecks(t.id, head, 'branch', [{ name: 'no-broken-marker', command: ['node'], status: 'passed', durationMs: 1, outputTail: '' }]);
    h.store.recordReview({ taskId: t.id, runId: null, headCommit: head, verdict: 'approve', risk: 'low', summary: 'ok', findings: [] });
    const checked = h.store.claim(t.id, ['ready'], 'checking', 'x:checks', 60_000)!;
    h.store.release(t.id, 'x:checks', checked.generation, 'merge_ready', 'checked and reviewed');
    // Right after the tick's target check, as the merge job claims the task, a worker moves main
    // onto the branch's first commit, so that main and the branch meet there ...
    const claim = h.store.claim.bind(h.store);
    h.store.claim = (id, from, to, owner, ttl) => {
      const r = claim(id, from, to, owner, ttl);
      if (r && to === 'merging' && !moveBack) {
        git(h.bare, 'update-ref', 'refs/heads/main', first);
        moveBack = true;
      }
      return r;
    };
    await h.sup.start();
    // The note stays; the state moves on once a repair run starts (none may run here).
    const sentBack = () => h.store.getTask(t.id)!.notes.some((n) => n.text.includes('AWS access key in creds.txt'));
    await h.waitFor(() => sentBack() || h.store.getTask(t.id)!.state === 'integrated', 'the merge decided');
    assert.notEqual(h.store.getTask(t.id)!.state, 'integrated');
    assert.ok(sentBack(), 'sent back for the key in its first commit');
    assert.equal(h.readTarget('creds.txt'), null);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), recorded);
    assert.equal(sourceHas(h, first), false, 'nothing with the key was pushed');
  } finally {
    await h.cleanup();
  }
});

test('on GitHub, a branch that took in the head a running merge job synced is measured from that head', T, async () => {
  const key = ['AKIA', 'Q7Z2LM4N8P3R5T6V'].join(''); // assembled here, so this file holds no key-shaped text
  const dir = mkdtempSync(join(tmpdir(), 'ap-drill-hold-'));
  const hold = join(dir, 'hold');
  const integrating = join(dir, 'integrating');
  writeFileSync(hold, '');
  // The first integration check waits while `hold` exists, so that merge job stays open.
  const held = `const fs=require('fs');const [hold,integ]=process.argv.slice(1);if(process.cwd().includes('_integration')&&!fs.existsSync(integ)){fs.writeFileSync(integ,'');const t=setInterval(()=>{if(!fs.existsSync(hold))clearInterval(t)},50)}`;
  let upstream = '';
  let repairer = '';
  let tookIn = false;
  let h!: Harness;
  h = await harness({
    config: (c) => {
      c.execution.maxBuilders = 2;
      c.checks.commands = [{ name: 'held', run: [process.execPath, '-e', held, hold, integrating], timeoutSeconds: 120 }];
    },
    forge: (local) => new GitHubOnSource({ source: local.source, home: local.home, targetBranch: 'main', branchPrefix: 'autopilot/', strategy: 'squash', repo: 'o/r', confirmDelayMs: 0 }),
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (spec.prompt.includes('Repairer') && !tookIn) {
        repairer = id(spec);
        // Conflict repair while the other task's merge job runs: take in the main that job synced.
        while (!existsSync(integrating)) await ctl.sleep(20);
        await ctl.git(['-c', 'user.name=B', '-c', 'user.email=b@example.invalid', 'merge', '-q', '--no-edit', 'main']);
        tookIn = true;
      }
      await commitFile(ctl, `work/${id(spec)}.txt`, `${id(spec)}\n`, `work ${id(spec)}`);
      if (spec.prompt.includes('First') && !upstream) {
        // After the first sync, the founder pushes a fixture holding a key-shaped string. The merge
        // job's own sync takes it in; the supervisor records it only when that job ends.
        const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: h.src, input: `aws_access_key_id = ${key}\n`, encoding: 'utf8' }).trim();
        const listing = execFileSync('git', ['ls-tree', 'refs/heads/main'], { cwd: h.src, encoding: 'utf8' });
        const tree = execFileSync('git', ['mktree'], { cwd: h.src, input: `${listing}100644 blob ${blob}\tscanner-fixture.txt\n`, encoding: 'utf8' }).trim();
        upstream = git(h.src, 'commit-tree', tree, '-p', 'refs/heads/main', '-m', 'Add a fixture for the scanner tests');
        git(h.src, 'update-ref', 'refs/heads/main', upstream);
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    h.addTask('First');
    h.addTask('Repairer');
    await h.sup.start();
    const secretNote = () => h.store.getTask(repairer)!.notes.some((n) => n.text.includes('Secret-looking content'));
    await h.waitFor(() => tookIn && (h.store.getTask(repairer)!.state === 'merge_ready' || secretNote()), 'the repairer published and reviewed');
    assert.equal(git(h.bare, 'merge-base', '--is-ancestor', upstream, h.store.getTask(repairer)!.headCommit!), '', 'the branch took in the synced head');
    assert.notEqual(h.store.getKv('target_head:drill'), upstream, 'while the merge job still runs');
    assert.equal(secretNote(), false, "the founder's fixture is not taken for the branch's secret");
    assert.deepEqual((await h.sup.taskDiff(repairer))!.files.map((f) => f.path), [`work/${repairer}.txt`]);
    rmSync(hold, { force: true });
    await h.waitFor(() => h.store.listTasks({}).every((t) => t.state === 'integrated'), 'both integrated');
    assert.equal(tamperEvents(h).length, 0);
  } finally {
    rmSync(hold, { force: true });
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
