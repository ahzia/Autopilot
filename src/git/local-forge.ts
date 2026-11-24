// SPDX-License-Identifier: MIT
// LocalForge: integrates task branches inside the autopilot's private clone; no hosting service.
//
// Layout under <home> (e.g. ~/.stayon-autopilot/projects/<id>):
//   repo.git/                private BARE clone, so the target branch is never checked out
//                            and can be moved safely with compare-and-swap update-ref
//   worktrees/<taskId>/      one worktree per task branch (builders work here)
//   worktrees/_integration/  detached worktree where merges are made and checked
//
// The supervisor serializes integrate() calls per project; update-ref compare-and-swap still
// protects the target if something else (e.g. a concurrent prepare()) moves it meanwhile.
//
// Builders commit through repo.git, so they can also write its config and hooks. Every git
// command runs with hooks and fsmonitor disabled (HARDENING_CONFIG in git.ts), and the repository
// config is audited before checkouts, merges and network access (auditRepoConfig below).

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CheckResult,
  DiffFile,
  DiffSummary,
  FeedbackItem,
  Forge,
  IntegrationResult,
  PublishResult,
  Task,
  WorktreeInfo,
} from '../types.ts';
import { randomToken, slugify, tail } from '../util.ts';
import {
  GitError,
  assertRevArg,
  branchExists,
  git,
  gitEnv,
  isAncestor,
  isSafeBranchName,
  listConflicts,
  mergeBase,
  parseConfigList,
  parseNameStatus,
  parseNumstat,
  parseStatusPorcelain,
  parseTrailers,
  parseWorktreeList,
  redact,
  redactUrlCredentials,
  revParse,
} from './git.ts';
import type { GitOptions, GitResult } from './git.ts';

export type SyncStatus = 'up_to_date' | 'fast_forwarded' | 'diverged' | 'no_remote';

export type RunChecks = (cwd: string) => Promise<CheckResult[]>;

export interface LocalForgeOptions {
  /** Local path or git URL of the founder's repository. */
  source: string;
  /** Project data dir, e.g. ~/.stayon-autopilot/projects/<id>. */
  home: string;
  targetBranch: string;
  branchPrefix: string;
  strategy: 'squash' | 'merge';
  /** Branch in the source that receives integrated commits; null keeps them in the private clone. */
  pushIntegratedTo: string | null;
  /** Author/committer of integration commits. */
  identity?: { name: string; email: string };
}

export const DEFAULT_IDENTITY = { name: 'StayOn Autopilot', email: 'autopilot@localhost' };

/** How many first-parent target commits are searched for an earlier integration of the same head. */
export const IDEMPOTENCY_SEARCH_DEPTH = 200;

/** The only fetch refspec origin may have: track origin's branches under refs/remotes/origin/*. */
export const ORIGIN_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

/** Checkouts (worktree add, checkout, reset --hard, merge) of big repositories, or with LFS, can be slow. */
export const CHECKOUT_TIMEOUT_MS = 30 * 60_000;

const INTEGRATION_DIR = '_integration';
const CLONE_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10 * 60_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Outcome of merging a task head onto the target inside the integration worktree. */
export type MergeSimulation =
  /** Merge committed in the integration worktree and checks passed; the target has not moved. */
  | { status: 'ready'; targetHead: string; commit: string; checks: CheckResult[] }
  /** The target already contains everything from the task head. */
  | { status: 'no_changes'; targetHead: string }
  /** conflict / checks_failed / error; the integration worktree was reset. */
  | { status: 'failed'; result: IntegrationResult };

export class LocalForge implements Forge {
  readonly kind: 'local' | 'github' = 'local';
  readonly source: string;
  readonly home: string;
  readonly repoPath: string;
  readonly worktreesDir: string;
  readonly integrationPath: string;
  readonly targetBranch: string;
  readonly branchPrefix: string;
  readonly strategy: 'squash' | 'merge';
  readonly pushIntegratedTo: string | null;
  readonly identity: { name: string; email: string };
  private lastSync: SyncStatus = 'no_remote';
  private lastFetchError: string | null = null;
  private lastPushWarning: string | null = null;

  constructor(opts: LocalForgeOptions) {
    if (!opts.source) throw new Error('forge: source is required');
    if (opts.source.startsWith('-')) throw new Error(`forge: invalid source ${JSON.stringify(redactUrlCredentials(opts.source))}`);
    if (!opts.home) throw new Error('forge: home is required');
    if (!isSafeBranchName(opts.targetBranch)) throw new Error(`forge: invalid targetBranch ${JSON.stringify(opts.targetBranch)}`);
    if (!/^[A-Za-z0-9._\/-]{0,40}$/.test(opts.branchPrefix) || opts.branchPrefix.startsWith('-')) {
      throw new Error(`forge: invalid branchPrefix ${JSON.stringify(opts.branchPrefix)}`);
    }
    if (opts.pushIntegratedTo !== null && !isSafeBranchName(opts.pushIntegratedTo)) {
      throw new Error(`forge: invalid pushIntegratedTo ${JSON.stringify(opts.pushIntegratedTo)}`);
    }
    const identity = opts.identity ?? DEFAULT_IDENTITY;
    if (!identity.name.trim() || !identity.email.trim() || /[\n<>]/.test(identity.name + identity.email)) {
      throw new Error('forge: identity needs a plain name and email');
    }
    this.source = isUrlLike(opts.source) ? opts.source : resolve(opts.source);
    this.home = resolve(opts.home);
    this.repoPath = join(this.home, 'repo.git');
    this.worktreesDir = join(this.home, 'worktrees');
    this.integrationPath = join(this.worktreesDir, INTEGRATION_DIR);
    this.targetBranch = opts.targetBranch;
    this.branchPrefix = opts.branchPrefix;
    this.strategy = opts.strategy;
    this.pushIntegratedTo = opts.pushIntegratedTo;
    this.identity = { name: identity.name, email: identity.email };
  }

  protected get targetRef(): string {
    return `refs/heads/${this.targetBranch}`;
  }

  protected get remoteTargetRef(): string {
    return `refs/remotes/origin/${this.targetBranch}`;
  }

  /** The source for messages: credentials in its URL are hidden. */
  protected get displaySource(): string {
    return redactUrlCredentials(this.source);
  }

  /** How the local target related to origin at the last prepare() (or GitHub integration). */
  syncStatus(): SyncStatus {
    return this.lastSync;
  }

  /** Why the last fetch failed (e.g. offline), or null when it succeeded. Informational only. */
  fetchError(): string | null {
    return this.lastFetchError;
  }

  /** Why the last push of integrated work to pushIntegratedTo failed, or null. Informational only. */
  pushWarning(): string | null {
    return this.lastPushWarning;
  }

  /** Branch name for a task: <prefix><taskId lowercased>-<slug>. */
  branchFor(taskId: string, slug: string): string {
    assertTaskId(taskId);
    const branch = `${this.branchPrefix}${taskId.toLowerCase()}-${slugify(slug)}`;
    if (!isSafeBranchName(branch)) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
    return branch;
  }

  worktreePathFor(taskId: string): string {
    assertTaskId(taskId);
    return join(this.worktreesDir, taskId);
  }

  // ----------------------------------------------------------- clone

  async prepare(): Promise<string> {
    await mkdir(this.worktreesDir, { recursive: true });
    if (existsSync(this.repoPath)) {
      await this.assertBareClone();
      await this.assertSafeRepoConfig();
      await this.fetchOrigin(); // offline is fine: keep working from what we have
      await this.run(['worktree', 'prune'], this.repoPath, { allowFail: true });
    } else {
      await this.cloneSource();
    }
    await this.ensureLocalTarget();
    await this.syncTarget();
    // Catch up on a push of integrated work that failed or was cut short (needs fresh remote refs).
    if (this.pushIntegratedTo && this.lastFetchError === null) await this.pushIntegratedWork(true);
    return this.repoPath;
  }

  async targetHead(): Promise<string> {
    const sha = await revParse(this.repoPath, this.targetRef);
    if (!sha) throw new Error(`target branch ${this.targetBranch} not found in ${this.repoPath} (run prepare() first)`);
    return sha;
  }

  /** git fetch origin --prune; failures (offline) are remembered, never thrown. */
  protected async fetchOrigin(): Promise<boolean> {
    const r = await this.run(['fetch', '--quiet', '--prune', 'origin'], this.repoPath, { allowFail: true, timeoutMs: FETCH_TIMEOUT_MS });
    this.lastFetchError = r.code === 0 ? null : redact(r.stderr.trim()) || `git fetch exited with ${r.code}`;
    return r.code === 0;
  }

  /** Fast-forward the local target to origin's when origin is strictly ahead; never rewrites it. */
  protected async syncTarget(): Promise<SyncStatus> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await revParse(this.repoPath, this.remoteTargetRef);
      const local = await revParse(this.repoPath, this.targetRef);
      if (!remote || !local) return (this.lastSync = 'no_remote');
      if (remote === local) return (this.lastSync = 'up_to_date');
      if (await isAncestor(this.repoPath, local, remote)) {
        const args = ['update-ref', this.targetRef, remote, local];
        const cas = await this.run(args, this.repoPath, { allowFail: true });
        if (cas.code === 0) return (this.lastSync = 'fast_forwarded');
        // Unchanged target means a real failure (e.g. a stale lock), not a race: report it.
        if ((await revParse(this.repoPath, this.targetRef)) === local) throw new GitError(args, cas.code, cas.stderr);
        continue; // the target moved under us; look again
      }
      // Local ahead of origin is normal: integrated work that origin does not have (yet).
      if (await isAncestor(this.repoPath, remote, local)) return (this.lastSync = 'up_to_date');
      return (this.lastSync = 'diverged');
    }
    throw new Error(`target branch ${this.targetBranch} kept moving while syncing with origin`);
  }

  private async cloneSource(): Promise<void> {
    // Clone next to the final location and rename, so a crash never leaves a half-made clone.
    for (const name of readdirSync(this.home)) {
      if (name.startsWith('repo.git.tmp-')) await rm(join(this.home, name), { recursive: true, force: true });
    }
    const tmp = `${this.repoPath}.tmp-${randomToken(6)}`;
    try {
      await this.run(['clone', '--bare', '--quiet', '--', this.source, tmp], this.home, { timeoutMs: CLONE_TIMEOUT_MS });
      // Bare clones have no fetch refspec; track origin's branches under refs/remotes/origin/*.
      await this.run(['config', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC], tmp);
      await this.run(['fetch', '--quiet', 'origin'], tmp, { timeoutMs: FETCH_TIMEOUT_MS });
      await rename(tmp, this.repoPath);
      this.lastFetchError = null;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  private async assertBareClone(): Promise<void> {
    const looksBare = existsSync(join(this.repoPath, 'HEAD')) && existsSync(join(this.repoPath, 'objects'));
    const r = looksBare ? await this.run(['rev-parse', '--is-bare-repository'], this.repoPath, { allowFail: true }) : null;
    if (!r || r.code !== 0 || r.stdout.trim() !== 'true') {
      throw new Error(`${this.repoPath} exists but is not a bare git repository; move it away so the autopilot can clone again`);
    }
  }

  private async ensureLocalTarget(): Promise<void> {
    if (await revParse(this.repoPath, this.targetRef)) return;
    const remote = await revParse(this.repoPath, this.remoteTargetRef);
    if (!remote) {
      const why = this.lastFetchError ? ` (last fetch failed: ${clip(this.lastFetchError, 300)})` : '';
      throw new Error(`source ${this.displaySource} has no branch "${this.targetBranch}"${why}`);
    }
    // Empty old value: create only if it still does not exist.
    await this.run(['update-ref', this.targetRef, remote, ''], this.repoPath);
  }

  /**
   * Workers can write repo.git/config. Before git checks out, merges or talks to origin for the
   * supervisor, make sure the config holds nothing that runs programs or reaches other servers,
   * and that origin's URL and refspec are ours (a source changed in the project config lands here).
   */
  protected async assertSafeRepoConfig(): Promise<void> {
    const file = join(this.repoPath, 'config');
    const listed = await this.run(['config', '--file', file, '--null', '--list'], this.repoPath);
    const audit = auditRepoConfig(parseConfigList(listed.stdout), { url: this.source, fetch: ORIGIN_FETCH_REFSPEC });
    if (audit.unsafe.length) {
      throw new Error(
        `refusing to run git in ${this.repoPath}: its config has settings the autopilot did not write ` +
          `(${audit.unsafe.map(redactUrlCredentials).join(', ')}); a worker may have added them. ` +
          `Remove them (git config --file ${file} --unset-all <key>), then retry.`,
      );
    }
    if (audit.resetUrl) await this.run(['config', '--file', file, '--replace-all', 'remote.origin.url', this.source], this.repoPath);
    if (audit.resetFetch) await this.run(['config', '--file', file, '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC], this.repoPath);
  }

  /**
   * Push the target head to origin's pushIntegratedTo branch when origin does not have it yet;
   * this also catches up on pushes that failed earlier or were cut short by a crash. Never throws.
   * Returns a note for result details: '' when there was nothing to push.
   */
  protected async pushIntegratedWork(onlyFastForward: boolean): Promise<string> {
    const dest = this.pushIntegratedTo;
    if (!dest) return '';
    try {
      const head = await revParse(this.repoPath, this.targetRef);
      if (!head) return '';
      const there = await revParse(this.repoPath, `refs/remotes/origin/${dest}`);
      if (there === head) return '';
      if (there === null) {
        // Not created yet: only worth creating once we have work that origin's target lacks.
        const originTarget = await revParse(this.repoPath, this.remoteTargetRef);
        if (originTarget && (await isAncestor(this.repoPath, head, originTarget))) return '';
      } else if (onlyFastForward && !(await isAncestor(this.repoPath, there, head))) {
        return ''; // it has diverged: a plain push would be refused (integrate() reports that)
      }
      const r = await this.run(['push', '--quiet', 'origin', `${head}:refs/heads/${dest}`], this.repoPath, {
        allowFail: true,
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      this.lastPushWarning = r.code === 0 ? null : `push to ${dest} failed: ${clip(r.stderr || `exit ${r.code}`, 500)}`;
    } catch (err) {
      this.lastPushWarning = `push to ${dest} failed: ${clip(err instanceof Error ? err.message : String(err), 500)}`;
    }
    return this.lastPushWarning ? `warning: ${this.lastPushWarning}` : `pushed to ${dest}`;
  }

  // ------------------------------------------------------- worktrees

  async createWorktree(taskId: string, slug: string): Promise<WorktreeInfo> {
    const branch = this.branchFor(taskId, slug);
    // A crash between creating the branch and recording it leaves the branch behind: reattach it.
    if (await branchExists(this.repoPath, branch)) return this.ensureWorktree(taskId, branch);
    await this.assertSafeRepoConfig();
    const path = this.worktreePathFor(taskId);
    await mkdir(this.worktreesDir, { recursive: true });
    if (existsSync(path)) await this.removeWorktree(path); // leftover of an older attempt
    await this.run(['worktree', 'prune'], this.repoPath, { allowFail: true });
    const base = await this.targetHead();
    await this.run(['worktree', 'add', '--quiet', '-b', branch, path, base], this.repoPath, { timeoutMs: CHECKOUT_TIMEOUT_MS });
    return { path, branch, baseCommit: base };
  }

  async ensureWorktree(taskId: string, branch: string): Promise<WorktreeInfo> {
    if (!isSafeBranchName(branch)) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
    let path = this.worktreePathFor(taskId);
    if (!(await branchExists(this.repoPath, branch))) throw new Error(`branch ${branch} does not exist in ${this.repoPath}`);
    await this.assertSafeRepoConfig();
    const here = await this.inspectWorktree(path);
    if (!here.valid || here.branch !== branch) {
      await this.run(['worktree', 'prune'], this.repoPath, { allowFail: true });
      const { live, broken } = await this.worktreesOn(branch);
      if (live) {
        path = live; // already checked out in another live worktree: reuse it rather than lose its state
      } else {
        // Clear what would block `worktree add`: our own directory, and broken (e.g. half-created)
        // registrations of this branch inside our worktrees dir.
        for (const p of new Set([path, ...broken])) await this.removeWorktree(p);
        await mkdir(this.worktreesDir, { recursive: true });
        // Short branch name on purpose: "refs/heads/x" would give a detached HEAD.
        await this.run(['worktree', 'add', '--quiet', path, branch], this.repoPath, { timeoutMs: CHECKOUT_TIMEOUT_MS });
      }
    }
    const baseCommit = (await mergeBase(this.repoPath, `refs/heads/${branch}`, this.targetRef)) ?? (await this.targetHead());
    return { path, branch, baseCommit };
  }

  /** Remove a worktree inside our worktrees dir, even a locked or half-created one. */
  async removeWorktree(path: string): Promise<void> {
    const abs = resolve(path);
    // Only ever touch worktrees inside our own worktrees dir.
    if (!isWithin(abs, this.worktreesDir)) return;
    const haveRepo = existsSync(this.repoPath);
    if (haveRepo) {
      // An interrupted `worktree add` leaves an "initializing" lock that blocks remove and prune.
      await this.run(['worktree', 'unlock', abs], this.repoPath, { allowFail: true });
      await this.run(['worktree', 'remove', '--force', '--force', abs], this.repoPath, { allowFail: true });
    }
    if (existsSync(abs)) await rm(abs, { recursive: true, force: true });
    if (haveRepo) await this.run(['worktree', 'prune'], this.repoPath, { allowFail: true });
  }

  async headCommit(worktreePath: string): Promise<string> {
    assertCheckout(worktreePath);
    return (await this.run(['rev-parse', '--verify', 'HEAD'], worktreePath)).stdout.trim();
  }

  async dirtyPaths(worktreePath: string): Promise<string[]> {
    assertCheckout(worktreePath);
    await this.assertSafeRepoConfig(); // status may run clean filters from the repository config
    const r = await this.run(['status', '--porcelain=v1', '-uall', '-z'], worktreePath);
    return parseStatusPorcelain(r.stdout);
  }

  /**
   * Is `path` a complete, live worktree of our clone, and which branch is checked out there
   * (null = detached)?
   */
  protected async inspectWorktree(path: string): Promise<{ valid: boolean; branch: string | null }> {
    const invalid = { valid: false, branch: null };
    // Without a .git entry git would search parent directories and might find an unrelated repo.
    if (!existsSync(join(path, '.git'))) return invalid;
    const r = await this.run(['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'], path, { allowFail: true });
    if (r.code !== 0) return invalid;
    const [top, common, gitDir] = r.stdout.trim().split('\n');
    if (!top || !common || !gitDir || realOrResolved(top) !== realOrResolved(path)) return invalid;
    if (realOrResolved(resolve(path, common)) !== realOrResolved(this.repoPath)) return invalid;
    // `git worktree add` holds an "initializing" lock until its checkout completes; a worktree that
    // still has it was interrupted (timeout, crash) and its index and files are incomplete.
    if (readLockReason(join(gitDir, 'locked'))?.startsWith('initializing')) return invalid;
    const head = await this.run(['symbolic-ref', '--quiet', 'HEAD'], path, { allowFail: true });
    const ref = head.code === 0 ? head.stdout.trim() : '';
    return { valid: true, branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null };
  }

  /** The live worktree that has `branch` checked out, and broken registrations of it in our dir. */
  private async worktreesOn(branch: string): Promise<{ live: string | null; broken: string[] }> {
    const r = await this.run(['worktree', 'list', '--porcelain'], this.repoPath);
    let live: string | null = null;
    const broken: string[] = [];
    for (const w of parseWorktreeList(r.stdout)) {
      if (w.bare || w.branch !== `refs/heads/${branch}`) continue;
      const info = w.prunable ? null : await this.inspectWorktree(w.path);
      if (info?.valid && info.branch === branch) live ??= w.path;
      else if (isWithin(w.path, this.worktreesDir)) broken.push(w.path);
    }
    return { live, broken };
  }

  // ------------------------------------------------------------ diff

  /**
   * Files and patch between two commits. Files are listed WITHOUT rename detection, so a rename
   * shows up as D <old> + A <new> and path policies see both sides; the patch keeps rename
   * detection because it is only read by people and reviewer agents. Patch generation stops once
   * maxPatchBytes is reached, so a huge commit cannot make diff() slow or fail.
   */
  async diff(baseCommit: string, headCommit: string, maxPatchBytes = 200_000): Promise<DiffSummary> {
    assertRevArg(baseCommit);
    assertRevArg(headCommit);
    const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
    const range = [baseCommit, headCommit, '--'];
    const [numstat, nameStatus, patch] = await Promise.all([
      this.run([...diffArgs, '--no-renames', '--numstat', '-z', ...range], this.repoPath),
      this.run([...diffArgs, '--no-renames', '--name-status', '-z', ...range], this.repoPath),
      this.run([...diffArgs, '-M', ...range], this.repoPath, { maxStdoutBytes: Math.max(0, maxPatchBytes), stopAtMaxStdout: true }),
    ]);
    const counts = new Map(parseNumstat(numstat.stdout).map((e) => [e.path, e]));
    const files: DiffFile[] = parseNameStatus(nameStatus.stdout).map((e) => ({
      path: e.path,
      added: counts.get(e.path)?.added ?? 0,
      deleted: counts.get(e.path)?.deleted ?? 0,
      status: normalizeStatus(e.status),
    }));
    let text = patch.stdout;
    if (patch.stdoutTruncated) {
      // Cut at a line boundary; this also drops a multi-byte character split by the byte limit.
      const nl = text.lastIndexOf('\n');
      text = nl >= 0 ? text.slice(0, nl + 1) : '';
    }
    return { baseCommit, headCommit, files, patch: text, truncated: patch.stdoutTruncated };
  }

  // ---------------------------------------------------- hosting hooks

  async publish(_task: Task, _body: string): Promise<PublishResult> {
    return { prNumber: null, prUrl: null };
  }

  async comment(_task: Task, _body: string): Promise<void> {}

  async pollFeedback(_since: number, _tasks: Task[]): Promise<FeedbackItem[]> {
    return [];
  }

  // ------------------------------------------------------- integrate

  async integrate(task: Task, expectedHead: string, runChecks: RunChecks): Promise<IntegrationResult> {
    try {
      const gate = await this.checkBranchHead(task, expectedHead);
      if ('result' in gate) return gate.result;
      await this.assertSafeRepoConfig();
      const already = await this.findIntegrated(task.id, gate.head);
      if (already) return await this.withPush({ status: 'merged', mergedCommit: already, checks: [], details: 'already integrated' });

      const sim = await this.simulateMerge(task, gate.head, runChecks);
      if (sim.status === 'failed') return sim.result;
      if (sim.status === 'no_changes') {
        return await this.withPush({ status: 'merged', mergedCommit: sim.targetHead, checks: [], details: 'no changes' });
      }

      // Compare-and-swap: move the target only from the commit the merge was built on.
      const moved = await this.run(['update-ref', this.targetRef, sim.commit, sim.targetHead], this.repoPath, { allowFail: true });
      if (moved.code !== 0) {
        if ((await revParse(this.repoPath, this.targetRef)) !== sim.targetHead) {
          return { status: 'stale_head', mergedCommit: null, checks: sim.checks, details: 'target moved' };
        }
        // The target did not move, yet could not be updated (e.g. a stale ref lock): not a race.
        return errorResult(`could not move ${this.targetBranch} to ${short(sim.commit)}: ${moved.stderr.trim() || `exit ${moved.code}`}`);
      }
      const details = `integrated ${task.id} (${short(gate.head)}) into ${this.targetBranch} as ${short(sim.commit)}`;
      return await this.withPush({ status: 'merged', mergedCommit: sim.commit, checks: sim.checks, details });
    } catch (err) {
      return errorResult(err);
    }
  }

  /** Push integrated work to pushIntegratedTo (if configured) and note what happened in details. */
  private async withPush(result: IntegrationResult): Promise<IntegrationResult> {
    const note = await this.pushIntegratedWork(false);
    return note ? { ...result, details: `${result.details}; ${note}` } : result;
  }

  /** The task branch must still point at expectedHead. Returns the full sha, or a final result. */
  protected async checkBranchHead(task: Task, expectedHead: string): Promise<{ head: string } | { result: IntegrationResult }> {
    if (!task.branch) return { result: errorResult(`task ${task.id} has no branch`) };
    if (!isSafeBranchName(task.branch)) return { result: errorResult(`task ${task.id} has an invalid branch name ${JSON.stringify(task.branch)}`) };
    if (!/^[0-9a-f]{7,64}$/i.test(expectedHead)) return { result: errorResult(`invalid expected head ${JSON.stringify(expectedHead)}`) };
    const branchHead = await revParse(this.repoPath, `refs/heads/${task.branch}`);
    if (!branchHead) return { result: errorResult(`branch ${task.branch} not found in ${this.repoPath}`) };
    const want = (await revParse(this.repoPath, expectedHead)) ?? expectedHead.toLowerCase();
    if (branchHead !== want) {
      return {
        result: { status: 'stale_head', mergedCommit: null, checks: [], details: `branch ${task.branch} is at ${branchHead}, expected ${expectedHead}` },
      };
    }
    return { head: want };
  }

  /**
   * The target commit (last 200 on its first-parent chain) that integrated this task head, if any.
   * Integration commits, ours and GitHub's, are always first-parent on the target; a task's own
   * commits (reachable through a merge commit's second parent) could carry forged trailers, so
   * they are never searched. Only the final trailer block counts, and the subject must name the task.
   */
  protected async findIntegrated(taskId: string, head: string): Promise<string | null> {
    const format = '--format=%H%x1f%(trailers:only,unfold)%x1f%s';
    const r = await this.run(['log', '-z', '--first-parent', `-n${IDEMPOTENCY_SEARCH_DEPTH}`, format, this.targetRef, '--'], this.repoPath);
    return findIntegrationCommit(r.stdout, taskId, head);
  }

  /**
   * Merge `head` onto the current target in the integration worktree, commit it with the
   * Autopilot trailers and run the checks there. Never moves the target branch.
   */
  protected async simulateMerge(task: Task, head: string, runChecks: RunChecks): Promise<MergeSimulation> {
    const base = await this.targetHead();
    const wt = await this.prepareIntegrationWorktree(base);
    const env = this.integrationEnv();

    const mergeArgs =
      this.strategy === 'squash'
        ? [...this.identityConfig(), '-c', 'merge.ff=true', 'merge', '--squash', '--no-verify-signatures', '--quiet', head]
        : [...this.identityConfig(), 'merge', '--no-ff', '--no-commit', '--no-verify-signatures', '--quiet', head];
    const merge = await this.run(mergeArgs, wt, { allowFail: true, env, timeoutMs: CHECKOUT_TIMEOUT_MS });
    if (merge.code !== 0) {
      const conflicts = await listConflicts(wt).catch(() => [] as string[]);
      await this.resetIntegration(base);
      if (conflicts.length) {
        return failed({ status: 'conflict', mergedCommit: null, checks: [], details: `merge conflict in ${conflicts.length} file(s): ${listSome(conflicts)}` });
      }
      return failed(errorResult(`git merge failed: ${merge.stderr.trim() || merge.stdout.trim() || `exit ${merge.code}`}`));
    }

    if (!(await this.hasMergeToCommit(wt))) {
      await this.resetIntegration(base);
      return { status: 'no_changes', targetHead: base };
    }

    const message = `${oneLine(task.title)} (${task.id})\n\nAutopilot-Task: ${task.id}\nAutopilot-Head: ${head}\n`;
    await this.run([...this.identityConfig(), 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '-F', '-'], wt, {
      env,
      input: message,
    });
    const commit = (await this.run(['rev-parse', '--verify', 'HEAD'], wt)).stdout.trim();

    let checks: CheckResult[];
    try {
      checks = await runChecks(wt);
    } catch (err) {
      await this.resetIntegration(base);
      return failed(errorResult(`integration checks could not run: ${err instanceof Error ? err.message : String(err)}`));
    }
    const failing = checks.filter((c) => c.status !== 'passed' && c.status !== 'skipped');
    if (failing.length) {
      await this.resetIntegration(base);
      return failed({
        status: 'checks_failed',
        mergedCommit: null,
        checks,
        details: `integration checks failed: ${failing.map((c) => `${c.name} (${c.status})`).join(', ')}`,
      });
    }
    return { status: 'ready', targetHead: base, commit, checks };
  }

  /** Squash: anything staged? Merge: is a merge in progress (no MERGE_HEAD means "Already up to date")? */
  private async hasMergeToCommit(wt: string): Promise<boolean> {
    if (this.strategy === 'squash') {
      const staged = await this.run(['diff', '--cached', '--quiet'], wt, { allowFail: true });
      if (staged.code !== 0 && staged.code !== 1) throw new Error(`git diff --cached failed: ${staged.stderr.trim()}`);
      return staged.code === 1;
    }
    return (await revParse(wt, 'MERGE_HEAD')) !== null;
  }

  /**
   * The integration worktree, detached and clean at `base`. Ignored files (node_modules) survive.
   * Leftovers of a crash or a killed git (lock files, a broken index) never block integration:
   * if the worktree cannot be reset it is rebuilt from scratch.
   */
  protected async prepareIntegrationWorktree(base: string): Promise<string> {
    const wt = this.integrationPath;
    if ((await this.inspectWorktree(wt)).valid) {
      try {
        await this.clearStaleLocks(wt);
        const opts = { timeoutMs: CHECKOUT_TIMEOUT_MS };
        await this.run(['reset', '--quiet', '--hard'], wt, { ...opts, allowFail: true }); // drops merge/squash state
        await this.run(['checkout', '--quiet', '--detach', '--force', base], wt, opts);
        await this.run(['reset', '--quiet', '--hard', base], wt, opts);
        await this.run(['clean', '-f', '-d', '--quiet'], wt, opts);
        return wt;
      } catch {
        // Unusable: rebuild it below (ignored files such as node_modules are lost this once).
      }
    }
    await mkdir(this.worktreesDir, { recursive: true });
    await this.removeWorktree(wt);
    await this.run(['worktree', 'add', '--quiet', '--detach', wt, base], this.repoPath, { timeoutMs: CHECKOUT_TIMEOUT_MS });
    return wt;
  }

  /**
   * integrate() calls are serialized and the integration worktree is private, so any lock file in
   * its own admin dir (index.lock, HEAD.lock, ...) was left behind by a killed git or a crash.
   */
  private async clearStaleLocks(wt: string): Promise<void> {
    const r = await this.run(['rev-parse', '--absolute-git-dir'], wt, { allowFail: true });
    const gitDir = r.code === 0 ? r.stdout.trim() : '';
    // Only repo.git/worktrees/<id>, never the shared repository itself.
    if (!gitDir || !isWithin(gitDir, join(this.repoPath, 'worktrees'))) return;
    for (const name of readdirSync(gitDir)) {
      if (name.endsWith('.lock')) await rm(join(gitDir, name), { force: true });
    }
  }

  /** Best effort: put the integration worktree back to `base` (the next run cleans up anyway). */
  protected async resetIntegration(base: string): Promise<void> {
    const opts = { allowFail: true, timeoutMs: CHECKOUT_TIMEOUT_MS };
    await this.run(['reset', '--quiet', '--hard', base], this.integrationPath, opts);
    await this.run(['clean', '-f', '-d', '--quiet'], this.integrationPath, opts);
  }

  /** -c flags that make our identity the author and committer of integration commits. */
  private identityConfig(): string[] {
    return ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`];
  }

  /** Inherited author/committer variables would override -c user.*; never open an editor. */
  private integrationEnv(): NodeJS.ProcessEnv {
    const env = gitEnv({ GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' });
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[key];
    return env;
  }

  protected run(args: string[], cwd: string, opts: Omit<GitOptions, 'cwd'> = {}): Promise<GitResult> {
    return git(args, { ...opts, cwd });
  }
}

// ------------------------------------------------------------ helpers

/**
 * Find, in `git log -z --format=%H%x1f%(trailers:only,unfold)%x1f%s` output, the commit whose
 * subject names the task ("... (T-1)") and whose trailer block has both Autopilot trailers.
 */
export function findIntegrationCommit(log: string, taskId: string, head: string): string | null {
  const wantHead = head.toLowerCase();
  for (const record of log.split('\0')) {
    const [rawSha, trailerText, ...subject] = record.replace(/^\n+/, '').split('\x1f');
    const sha = (rawSha ?? '').trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha) || trailerText === undefined) continue;
    if (!subjectNamesTask(subject.join('\x1f'), taskId)) continue;
    const trailers = parseTrailers(trailerText);
    const taskOk = trailers['autopilot-task']?.includes(taskId);
    const headOk = trailers['autopilot-head']?.some((h) => h.toLowerCase() === wantHead);
    if (taskOk && headOk) return sha;
  }
  return null;
}

/** Integration subjects end with "(<taskId>)", or "(<taskId>) (#<n>)" if GitHub appended the PR number. */
function subjectNamesTask(subject: string, taskId: string): boolean {
  return subject.trim().replace(/ \(#\d+\)$/, '').endsWith(`(${taskId})`);
}

export interface RepoConfigAudit {
  /** Keys that make git run programs or reach other servers; the forge refuses to work with them. */
  unsafe: string[];
  /** remote.origin.url is missing, repeated or not the configured source: reset it. */
  resetUrl: boolean;
  /** remote.origin.fetch is not exactly our refspec: reset it. */
  resetFetch: boolean;
}

/**
 * Repository-level settings that would make git run programs or contact other servers when the
 * supervisor fetches, pushes, checks out or merges. (Hooks and fsmonitor are disabled on every
 * command instead, see HARDENING_CONFIG.) Keys come from `git config --list`: section and
 * variable names lowercased, subsection names as written.
 */
const UNSAFE_CONFIG_KEYS: readonly RegExp[] = [
  /^core\.(sshcommand|askpass|gitproxy|alternaterefscommand|worktree)$/,
  /^(credential|filter|gpg|url|http|include|includeif|protocol|uploadpack|uploadarchive)\./,
  /^merge\..+\.driver$/,
  /^diff\.(external|.+\.(command|textconv))$/,
  /^lfs\.(customtransfer\.|standalonetransferagent$|extension\.)/,
  /^(fetch|transfer)\.bundleuri$/,
  /^(submodule\.recurse|fetch\.recursesubmodules|push\.recursesubmodules)$/,
  /^extensions\.worktreeconfig$/,
  /^remote\.origin\.(?!(url|fetch|prune|prunetags|tagopt)$)/,
];

/** Check repository config entries against what the autopilot itself writes. Pure; see assertSafeRepoConfig. */
export function auditRepoConfig(entries: [string, string][], expected: { url: string; fetch: string }): RepoConfigAudit {
  const unsafe = [...new Set(entries.map(([key]) => key).filter((key) => UNSAFE_CONFIG_KEYS.some((re) => re.test(key))))];
  const urls = entries.filter(([key]) => key === 'remote.origin.url').map(([, value]) => value);
  const fetches = entries.filter(([key]) => key === 'remote.origin.fetch').map(([, value]) => value);
  return {
    unsafe,
    resetUrl: urls.length !== 1 || !sameSource(urls[0], expected.url),
    resetFetch: fetches.length !== 1 || fetches[0] !== expected.fetch,
  };
}

export function errorResult(err: unknown): IntegrationResult {
  const message = err instanceof Error ? err.message : String(err);
  return { status: 'error', mergedCommit: null, checks: [], details: clip(message) };
}

function failed(result: IntegrationResult): MergeSimulation {
  return { status: 'failed', result };
}

/**
 * Commit subjects are one line; a title must not be able to forge trailer lines or the field
 * separators findIntegrated() reads, nor hide text behind bidirectional-override characters.
 */
export function oneLine(text: string, max = 150): string {
  const s = text
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s.length > max ? `${s.slice(0, max - 1)}…` : s) || 'Autopilot task';
}

/** Trimmed, redacted (secrets, URL credentials), size-limited text for result details. */
export function clip(text: string, max = 2000): string {
  return redact(tail(text.trim(), max));
}

export function short(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 10) || 'unknown';
}

function listSome(items: string[], max = 20): string {
  return items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');
}

function normalizeStatus(letter: string): string {
  if (letter === 'T') return 'M'; // type change (file <-> symlink) is a modification
  if (letter === 'C') return 'A';
  return letter;
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid task id ${JSON.stringify(taskId)}`);
}

/** Refuse to run git in a directory that is not a checkout (git would search parent directories). */
function assertCheckout(path: string): void {
  if (!existsSync(join(path, '.git'))) throw new Error(`${path} is not a git worktree`);
}

function isUrlLike(source: string): boolean {
  // scheme://… or scp-like user@host:path (a colon before the first slash).
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^\/]+:/.test(source);
}

/** Same repository location: URLs compare exactly, local paths after normalization. */
function sameSource(a: string, b: string): boolean {
  if (isUrlLike(a) || isUrlLike(b)) return a === b;
  return resolve(a) === resolve(b);
}

/** Reason in a worktree's `locked` file, or null when it is not locked. */
function readLockReason(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Real path of `p`; for a path that does not exist (yet), that of its nearest existing ancestor. */
function realOrResolved(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realOrResolved(parent), basename(abs));
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(realOrResolved(parent), realOrResolved(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
