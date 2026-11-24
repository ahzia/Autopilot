// SPDX-License-Identifier: MIT
// GitHubForge: the same private clone, worktrees and local merge simulation as LocalForge, but
// work lands through GitHub pull requests using the `gh` CLI. It never bypasses branch
// protection (no --admin): when GitHub says no, the result is blocked_by_forge.
//
// Task branches are force-pushed (repairs rewrite them), but never over commits the autopilot did
// not make. Every push records its sha in refs/autopilot/published/<branch>, the explicit
// --force-with-lease value of the next push. When origin has moved on anyway (a reviewer used
// "Commit suggestion" or "Update branch" on GitHub), the push only goes ahead if origin's commit is
// already part of the local branch; ensureWorktree() fast-forwards onto such commits before a
// builder run. Otherwise the push is refused with ForeignCommitsError and nothing is overwritten.

import { existsSync } from 'node:fs';
import { TERMINAL_TASK_STATES } from '../types.ts';
import type { CheckResult, FeedbackItem, IntegrationResult, PublishResult, Task, WorktreeInfo } from '../types.ts';
import { sleep } from '../util.ts';
import { GitError, gitEnv, hasCommit, isAncestor, isSafeBranchName, mergeBase, revParse, runCommand } from './git.ts';
import type { CommandResult } from './git.ts';
import { CHECKOUT_TIMEOUT_MS, LocalForge, clip, errorResult, oneLine, short } from './local-forge.ts';
import type { LocalForgeOptions, RunChecks } from './local-forge.ts';

/** Appended to every comment we post, so feedback polling can skip our own words. */
export const AUTOPILOT_MARKER = '<!-- autopilot -->';

/** Prefix of the refs that keep the sha of the autopilot's last push of each task branch. */
export const PUBLISHED_REF_PREFIX = 'refs/autopilot/published/';

const GH_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const REMOTE_QUERY_TIMEOUT_MS = 2 * 60_000;
/** The best-effort fetch before a builder run must not hold the run up for long when offline. */
const ADOPT_FETCH_TIMEOUT_MS = 30_000;
/** `gh pr view` attempts while confirming a merge. */
const CONFIRM_ATTEMPTS = 3;
/** `gh pr view` attempts while waiting for GitHub to show a freshly pushed head on the PR. */
const HEAD_WAIT_ATTEMPTS = 5;

export interface GitHubForgeOptions extends Omit<LocalForgeOptions, 'pushIntegratedTo'> {
  /** "owner/name". */
  repo: string;
  /** gh executable (default "gh"). */
  ghBin?: string;
  /** Ignored: GitHub integrations land through pull requests. */
  pushIntegratedTo?: string | null;
  /** Pause between `gh pr view` attempts while confirming a merge (default 1000 ms). */
  confirmDelayMs?: number;
}

export class GhError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly args: string[];
  constructor(args: string[], code: number, stderr: string, message?: string) {
    const detail = stderr.trim() ? `: ${clip(stderr, 1500)}` : '';
    super(message ?? `gh ${args.slice(0, 3).join(' ')} failed (exit ${code})${detail}`);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

/** origin's copy of a task branch has commits the autopilot did not push; pushing would drop them. */
export class ForeignCommitsError extends Error {
  readonly branch: string;
  readonly remoteHead: string;
  constructor(branch: string, remoteHead: string) {
    super(
      `origin's ${branch} is at ${short(remoteHead)}, which has commits the autopilot did not push ` +
        `(e.g. a suggestion committed on GitHub); refusing to overwrite them. ` +
        `Merge them into the task branch (git merge refs/remotes/origin/${branch}) and publish again.`,
    );
    this.name = 'ForeignCommitsError';
    this.branch = branch;
    this.remoteHead = remoteHead;
  }
}

interface PrView {
  state: string;
  mergeCommit: string | null;
  headRefOid: string | null;
}

/** What pushing a task branch did; "missing": origin no longer has it and it was not recreated. */
export type PushOutcome = 'pushed' | 'up_to_date' | 'missing';

export class GitHubForge extends LocalForge {
  readonly kind: 'local' | 'github' = 'github';
  readonly repo: string;
  readonly ghBin: string;
  private readonly confirmDelayMs: number;

  constructor(opts: GitHubForgeOptions) {
    super({ ...opts, pushIntegratedTo: null });
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
      throw new Error(`forge: invalid GitHub repo ${JSON.stringify(opts.repo)} (expected "owner/name")`);
    }
    this.repo = opts.repo;
    this.ghBin = opts.ghBin ?? 'gh';
    this.confirmDelayMs = Math.max(0, opts.confirmDelayMs ?? 1000);
  }

  /** Push the task branch (never over others' commits), then open its PR or refresh the PR body. */
  async publish(task: Task, body: string): Promise<PublishResult> {
    const branch = requireBranch(task);
    await this.assertSafeRepoConfig();
    await this.pushTaskBranch(branch, true);
    if (task.prNumber != null) {
      await this.editBody(task.prNumber, body);
      return { prNumber: task.prNumber, prUrl: task.prUrl };
    }
    return this.openPullRequest(task, branch, body, true);
  }

  /**
   * As LocalForge's, then take in commits others added on top of the published branch (a review
   * suggestion committed on GitHub, "Update branch"), so the next builder run starts from them.
   */
  async ensureWorktree(taskId: string, branch: string): Promise<WorktreeInfo> {
    const info = await super.ensureWorktree(taskId, branch);
    if (!(await this.adoptRemoteCommits(info.path, branch))) return info;
    const baseCommit = (await mergeBase(this.repoPath, `refs/heads/${branch}`, this.targetRef)) ?? info.baseCommit;
    return { ...info, baseCommit };
  }

  /**
   * Check the branch head, make the PR show exactly that head, dry-run the merge and checks locally
   * (the local target is not moved), then ask GitHub to merge exactly expectedHead and
   * fast-forward the local target to origin's.
   */
  async integrate(task: Task, expectedHead: string, runChecks: RunChecks): Promise<IntegrationResult> {
    try {
      const gate = await this.checkBranchHead(task, expectedHead);
      if ('result' in gate) return gate.result;
      const branch = requireBranch(task);
      await this.assertSafeRepoConfig();

      // Simulate on the freshest target we can see (best effort when offline).
      if (await this.fetchOrigin()) await this.syncTarget();
      const already = await this.findIntegrated(task.id, gate.head);
      if (already) return { status: 'merged', mergedCommit: already, checks: [], details: 'already integrated' };

      // GitHub must merge what is checked here, so the PR branch has to show this head (an
      // earlier publish may have failed). A branch origin no longer has belongs to a merged or
      // closed PR: it is not recreated, and gh reports what happened to the PR.
      let pushed: PushOutcome;
      try {
        pushed = await this.pushTaskBranch(branch, task.prNumber == null);
      } catch (err) {
        if (!(err instanceof ForeignCommitsError)) throw err;
        // Someone added commits to the PR branch: the builder must take them in before merging.
        return { status: 'conflict', mergedCommit: null, checks: [], details: err.message };
      }

      const sim = await this.simulateMerge(task, gate.head, runChecks);
      if (sim.status === 'failed') return sim.result;
      await this.resetIntegration(sim.targetHead); // dry run: discard the local merge commit
      const checks = sim.status === 'ready' ? sim.checks : [];

      let prNumber = task.prNumber;
      if (prNumber == null) {
        // publish() never opened the PR (it failed earlier): open it now, then merge it.
        prNumber = (await this.openPullRequest(task, branch, defaultPrBody(task), false)).prNumber;
      } else if (pushed === 'pushed') {
        await this.waitForPrHead(String(prNumber), gate.head); // GitHub updates PR heads asynchronously
      }
      return await this.mergePullRequest(task, prNumber, gate.head, checks);
    } catch (err) {
      return errorResult(err);
    }
  }

  async comment(task: Task, body: string): Promise<void> {
    if (task.prNumber == null) return;
    await this.gh(['pr', 'comment', String(task.prNumber), '--repo', this.repo, '--body-file', '-'], `${body}\n\n${AUTOPILOT_MARKER}`);
  }

  /**
   * Comments, reviews and inline review comments on the tasks' PRs created at or after `since`.
   * Comments come from two repository-wide calls, however many PRs there are; reviews (which have
   * no repository-wide endpoint) are fetched only for tasks that are still in play. A PR that no
   * longer exists (404/410) has no feedback; any other failure throws, so the caller keeps its
   * cursor and nothing is skipped.
   */
  async pollFeedback(since: number, tasks: Task[]): Promise<FeedbackItem[]> {
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const iso = new Date(from).toISOString();
    const byPr = new Map<number, Task>();
    for (const task of tasks) if (task.prNumber != null) byPr.set(task.prNumber, task);
    if (byPr.size === 0) return [];

    const api = `repos/${this.repo}`;
    const items: FeedbackItem[] = [];
    const collect = (raws: unknown[], source: GitHubFeedbackSource) => {
      for (const raw of raws) {
        const task = byPr.get(prNumberOf(raw) ?? -1);
        if (task) items.push(...feedbackFromGitHub(task, source, [raw], from));
      }
    };
    collect(await this.ghApi(`${api}/issues/comments?since=${iso}&per_page=100`), 'issue-comment');
    collect(await this.ghApi(`${api}/pulls/comments?since=${iso}&per_page=100`), 'review-comment');
    for (const [n, task] of byPr) {
      if (TERMINAL_TASK_STATES.includes(task.state)) continue;
      items.push(...feedbackFromGitHub(task, 'review', await this.ghApi(`${api}/pulls/${n}/reviews?per_page=100`, true), from));
    }
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  // ------------------------------------------------------- branch pushes

  /**
   * Push the local task branch to origin's branch of the same name, never dropping commits the
   * autopilot did not make (see the file comment). `create`: the branch may be created on origin.
   */
  protected async pushTaskBranch(branch: string, create: boolean): Promise<PushOutcome> {
    const local = await revParse(this.repoPath, `refs/heads/${branch}`);
    if (!local) throw new Error(`branch ${branch} does not exist in ${this.repoPath}`);
    const leaseRef = `${PUBLISHED_REF_PREFIX}${branch}`;
    const lastPushed = await revParse(this.repoPath, leaseRef);
    const done = async (outcome: PushOutcome): Promise<PushOutcome> => {
      await this.run(['update-ref', leaseRef, local], this.repoPath);
      return outcome;
    };

    // Usual case: origin still has what we pushed last time (or, before the first push, nothing).
    if (lastPushed || create) {
      const first = await this.pushBranch(branch, local, lastPushed);
      if (first !== 'stale') return done(first);
    }
    // origin is not where we left it (someone pushed, or a crash lost our record): look first.
    const remote = await this.remoteBranchHead(branch);
    if (remote === local) return done('up_to_date');
    if (remote === null) {
      if (!create) return 'missing';
      if ((await this.pushBranch(branch, local, null)) === 'stale') throw new Error(`origin's ${branch} appeared while pushing it; try again`);
      return done('pushed');
    }
    if (!(await this.isOwnHistory(branch, local, remote))) throw new ForeignCommitsError(branch, remote);
    if ((await this.pushBranch(branch, local, remote)) === 'stale') throw new Error(`origin's ${branch} changed while pushing it; try again`);
    return done('pushed');
  }

  /** Push `sha` to origin's branch, leased on origin's current value being `expect` (null: absent). */
  private async pushBranch(branch: string, sha: string, expect: string | null): Promise<'pushed' | 'up_to_date' | 'stale'> {
    const dst = `refs/heads/${branch}`;
    const args = ['push', '--porcelain', `--force-with-lease=${dst}:${expect ?? ''}`, 'origin', `${sha}:${dst}`];
    const r = await this.run(args, this.repoPath, { allowFail: true, timeoutMs: PUSH_TIMEOUT_MS });
    // Porcelain status line: "<flag>\t<src>:<dst>\t<summary>"; "=" is up to date, "!" rejected.
    const line = r.stdout.split('\n').find((l) => l.split('\t')[1]?.endsWith(`:${dst}`));
    if (r.code === 0) return line?.startsWith('=') ? 'up_to_date' : 'pushed';
    if (line?.startsWith('!') && line.includes('stale info')) return 'stale';
    throw new GitError(args, r.code, [r.stderr.trim(), line ?? ''].filter(Boolean).join('\n'));
  }

  /** Where origin's branch is right now (null when it does not exist). Throws when origin is unreachable. */
  private async remoteBranchHead(branch: string): Promise<string | null> {
    const ref = `refs/heads/${branch}`;
    const r = await this.run(['ls-remote', 'origin', ref], this.repoPath, { timeoutMs: REMOTE_QUERY_TIMEOUT_MS });
    for (const line of r.stdout.split('\n')) {
      const [sha, name] = line.split('\t');
      // ls-remote matches patterns by tail ("x/refs/heads/b" too): only the exact ref counts.
      if (name?.trim() === ref && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
    return null;
  }

  /**
   * May origin's `remote` be replaced by `local`? Yes when it is already part of the local branch
   * (a fast-forward), or was itself a tip of the local branch at some point: our own earlier push
   * of a commit a repair has since rewritten (git's --force-if-includes uses the same rule).
   */
  private async isOwnHistory(branch: string, local: string, remote: string): Promise<boolean> {
    if (!(await hasCommit(this.repoPath, remote))) return false;
    if (await isAncestor(this.repoPath, remote, local)) return true;
    const log = await this.run(['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'], this.repoPath, { allowFail: true });
    return log.code === 0 && log.stdout.split('\n').some((line) => line.trim() === remote);
  }

  /**
   * Fast-forward the task branch (and its worktree) onto origin's copy when origin is strictly
   * ahead. Never rewrites local commits; offline, unpublished branches or local edits that would
   * be overwritten leave everything as it is.
   */
  private async adoptRemoteCommits(worktree: string, branch: string): Promise<boolean> {
    try {
      const tracking = `refs/remotes/origin/${branch}`;
      const fetchArgs = ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${tracking}`];
      const fetched = await this.run(fetchArgs, this.repoPath, { allowFail: true, timeoutMs: ADOPT_FETCH_TIMEOUT_MS });
      if (fetched.code !== 0) return false;
      const remote = await revParse(this.repoPath, tracking);
      const local = await revParse(this.repoPath, `refs/heads/${branch}`);
      if (!remote || !local || remote === local || !(await isAncestor(this.repoPath, local, remote))) return false;
      const ff = await this.run(['merge', '--ff-only', '--quiet', remote], worktree, { allowFail: true, timeoutMs: CHECKOUT_TIMEOUT_MS });
      return ff.code === 0;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------- pull requests

  /** gh pr create; a PR that already exists for the branch (crash after creating it) is adopted. */
  private async openPullRequest(task: Task, branch: string, body: string, refreshBody: boolean): Promise<{ prNumber: number; prUrl: string }> {
    const args = ['pr', 'create', '--repo', this.repo, '--base', this.targetBranch, '--head', branch];
    args.push('--title', `${oneLine(task.title)} (${task.id})`, '--body-file', '-');
    const res = await this.gh(args, body, true);
    if (res.code === 0) {
      const pr = parsePrUrl(res.stdout);
      if (!pr) throw new GhError(args, 0, res.stdout, `gh pr create printed no pull request URL: ${clip(res.stdout || res.stderr, 500)}`);
      return pr;
    }
    const existing = /already exists/i.test(res.stderr) ? parsePrUrl(res.stderr) : null;
    if (!existing) throw new GhError(args, res.code, res.stderr.trim() ? res.stderr : res.stdout);
    if (refreshBody) await this.editBody(existing.prNumber, body);
    return existing;
  }

  private async mergePullRequest(task: Task, prNumber: number, head: string, checks: CheckResult[]): Promise<IntegrationResult> {
    const n = String(prNumber);
    const args = ['pr', 'merge', n, '--repo', this.repo, this.strategy === 'squash' ? '--squash' : '--merge'];
    // --match-head-commit: GitHub refuses if the PR head is not exactly what was checked.
    // Subject/body carry the same trailers as local integrations (used for idempotency).
    args.push('--match-head-commit', head, '--subject', `${oneLine(task.title)} (${task.id})`);
    args.push('--body', `Autopilot-Task: ${task.id}\nAutopilot-Head: ${head}`);
    const res = await this.gh(args, undefined, true);
    if (res.code === 0) {
      // Report "merged" only once GitHub confirms it: gh also exits 0 after merely queueing a PR.
      const view = await this.confirmMerged(n);
      if (!view) {
        return { status: 'error', mergedCommit: null, checks, details: `gh pr merge reported success, but PR #${n} could not be confirmed as merged (gh pr view failed); the next attempt checks again` };
      }
      if (view.state !== 'MERGED') {
        return { status: 'blocked_by_forge', mergedCommit: null, checks, details: `gh pr merge returned, but PR #${n} is ${view.state || 'not merged'} (merge queue or auto-merge?)` };
      }
      return this.afterMerge(view, checks, `merged PR #${n}`);
    }

    const text = [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join('\n') || `gh pr merge exited with ${res.code}`;
    if (/already merged/i.test(text)) {
      const view = await this.confirmMerged(n);
      if (view?.state === 'MERGED' && view.headRefOid === head) return this.afterMerge(view, checks, `PR #${n} was already merged`);
      if (view?.state === 'MERGED') {
        return { status: 'error', mergedCommit: null, checks, details: `PR #${n} was merged at ${short(view.headRefOid)}, not at the checked head ${short(head)}` };
      }
    }
    const status = classifyMergeFailure(text);
    if (status === 'stale_head') {
      // The branch was just pushed (or verified) at `head`, so GitHub is still processing the push
      // or someone pushed to the PR meanwhile. Retrying is right; re-checking the same head is not.
      return {
        status: 'error',
        mergedCommit: null,
        checks,
        details: clip(`GitHub does not show ${short(head)} as the head of PR #${n} (still processing the push, or someone pushed to ${task.branch}): ${text}`),
      };
    }
    return { status, mergedCommit: null, checks, details: clip(text) };
  }

  /** gh pr view, retried a little while the PR does not show as merged. Null when every view failed. */
  private async confirmMerged(n: string): Promise<PrView | null> {
    let last: PrView | null = null;
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(this.confirmDelayMs * attempt);
      const view = await this.viewPr(n).catch(() => null);
      if (view?.state === 'MERGED') return view;
      last = view ?? last;
    }
    return last;
  }

  /** After pushing a new head, give GitHub a moment to show it on the open PR (best effort). */
  private async waitForPrHead(n: string, head: string): Promise<void> {
    for (let attempt = 0; attempt < HEAD_WAIT_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(this.confirmDelayMs);
      const view = await this.viewPr(n).catch(() => null);
      if (!view || view.state !== 'OPEN' || view.headRefOid === head) return;
    }
  }

  /**
   * GitHub merged: bring the local target up to origin's and report the merge commit. The merge
   * already happened, so local trouble here only adds warnings; it never turns into an error.
   */
  private async afterMerge(view: PrView, checks: CheckResult[], details: string): Promise<IntegrationResult> {
    let note = details;
    let originHead: string | null = null;
    try {
      if (await this.fetchOrigin()) {
        originHead = await revParse(this.repoPath, this.remoteTargetRef);
        if ((await this.syncTarget()) === 'diverged') note += `; warning: local ${this.targetBranch} has diverged from origin`;
      } else {
        note += `; warning: fetch after merge failed: ${clip(this.fetchError() ?? '', 300)}`;
      }
    } catch (err) {
      note += `; warning: could not update the local ${this.targetBranch}: ${clip(err instanceof Error ? err.message : String(err), 300)}`;
    }
    // Without GitHub's merge commit, a freshly fetched origin head is the answer; a stale one is not.
    return { status: 'merged', mergedCommit: view.mergeCommit ?? originHead, checks, details: note };
  }

  private async viewPr(n: string): Promise<PrView> {
    const res = await this.gh(['pr', 'view', n, '--repo', this.repo, '--json', 'state,mergeCommit,headRefOid']);
    const data: unknown = JSON.parse(res.stdout);
    const pr = isRecord(data) ? data : {};
    const mergeCommit = isRecord(pr.mergeCommit) && typeof pr.mergeCommit.oid === 'string' ? pr.mergeCommit.oid : null;
    return {
      state: typeof pr.state === 'string' ? pr.state : '',
      mergeCommit,
      headRefOid: typeof pr.headRefOid === 'string' ? pr.headRefOid : null,
    };
  }

  private async editBody(prNumber: number, body: string): Promise<void> {
    await this.gh(['pr', 'edit', String(prNumber), '--repo', this.repo, '--body-file', '-'], body);
  }

  /** gh api --paginate; `missingOk`: a 404/410 (the PR is gone) yields no items instead of an error. */
  private async ghApi(path: string, missingOk = false): Promise<unknown[]> {
    const args = ['api', '--paginate', path];
    const res = await this.gh(args, undefined, true);
    if (res.code === 0) return parseJsonStream(res.stdout);
    if (missingOk && /\bHTTP 4(?:04|10)\b/.test(`${res.stderr}\n${res.stdout}`)) return [];
    throw new GhError(args, res.code, res.stderr.trim() ? res.stderr : res.stdout);
  }

  /** Run gh without a shell; prompts and update notices are disabled. */
  protected async gh(args: string[], input?: string, allowFail = false): Promise<CommandResult> {
    const res = await runCommand(this.ghBin, args, {
      cwd: existsSync(this.home) ? this.home : process.cwd(),
      env: gitEnv({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' }),
      timeoutMs: GH_TIMEOUT_MS,
      input: input ?? '',
    });
    if (res.code !== 0 && !allowFail) throw new GhError(args, res.code, res.stderr.trim() ? res.stderr : res.stdout);
    return res;
  }
}

// ------------------------------------------------------------ helpers

export type GitHubFeedbackSource = 'issue-comment' | 'review' | 'review-comment';

const EXTERNAL_ID_PREFIX: Record<GitHubFeedbackSource, string> = {
  'issue-comment': 'gh-issue-comment-',
  review: 'gh-review-',
  'review-comment': 'gh-review-comment-',
};

/** Map raw GitHub API objects to feedback, skipping our own comments, empty reviews and old items. */
export function feedbackFromGitHub(task: Task, source: GitHubFeedbackSource, raws: unknown[], since: number): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const raw of raws) {
    if (!isRecord(raw) || (typeof raw.id !== 'number' && typeof raw.id !== 'string')) continue;
    const body = typeof raw.body === 'string' ? raw.body : '';
    if (body.includes(AUTOPILOT_MARKER)) continue;
    const state = source === 'review' && typeof raw.state === 'string' ? raw.state : null;
    if (state === 'PENDING') continue; // not submitted yet
    const verdict = state === 'CHANGES_REQUESTED' || state === 'APPROVED';
    if (!body.trim() && !verdict) continue;
    const when = source === 'review' ? raw.submitted_at : raw.created_at;
    const createdAt = typeof when === 'string' ? Date.parse(when) : NaN;
    if (!Number.isFinite(createdAt) || createdAt < since) continue;
    const user = isRecord(raw.user) ? raw.user : null;
    items.push({
      externalId: `${EXTERNAL_ID_PREFIX[source]}${raw.id}`,
      projectId: task.projectId,
      taskId: task.id,
      source: 'github',
      author: typeof user?.login === 'string' ? user.login : 'unknown',
      body: source === 'review-comment' ? withLocation(raw, body) : body,
      kind:
        state === 'CHANGES_REQUESTED' ? 'change_request' : state === 'APPROVED' ? 'approval' : body.trim().endsWith('?') ? 'question' : 'comment',
      url: typeof raw.html_url === 'string' ? raw.html_url : null,
      createdAt,
      // The commit a review was given on, so an approval is bound to that exact revision.
      commitId: source === 'review' && typeof raw.commit_id === 'string' ? raw.commit_id : null,
    });
  }
  return items;
}

/** Pull request number of a repository-wide issue comment or review comment. */
export function prNumberOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  for (const field of ['issue_url', 'pull_request_url']) {
    const value = raw[field];
    const m = typeof value === 'string' ? /\/(?:issues|pulls)\/(\d+)$/.exec(value) : null;
    if (m) return Number(m[1]);
  }
  const html = raw.html_url;
  const m = typeof html === 'string' ? /\/pull\/(\d+)(?:[#\/?]|$)/.exec(html) : null;
  return m ? Number(m[1]) : null;
}

/** Map `gh pr merge` failure text to an integration status. Unknown failures are plain errors. */
export function classifyMergeFailure(text: string): 'stale_head' | 'conflict' | 'blocked_by_forge' | 'error' {
  if (/head branch was modified|expected head/i.test(text)) return 'stale_head';
  // A branch that must be up to date with the base (BEHIND) is repaired like a conflict: the
  // builder merges the target into its branch.
  if (/cannot be cleanly created|merge conflict|not up to date with the base branch|head branch is (?:out of date|behind)/i.test(text)) return 'conflict';
  const blocked =
    /required status check|status checks? (?:are|is|have|has)\b|required (?:pull request )?reviews?|reviews? (?:is|are) required|approving review|protected branch|branch protection|not mergeable|repository rule|base branch policy|merge queue|merges are not allowed/i;
  return blocked.test(text) ? 'blocked_by_forge' : 'error';
}

/** Last pull request URL in gh output, with its number. */
export function parsePrUrl(text: string): { prNumber: number; prUrl: string } | null {
  const last = [...text.matchAll(/https?:\/\/[^\s"'<>]+\/pull\/(\d+)/g)].at(-1);
  return last ? { prNumber: Number(last[1]), prUrl: last[0] } : null;
}

/**
 * Parse concatenated JSON documents: `gh api --paginate` joins pages as "[...][...]", --jq gives
 * JSON lines. Top-level arrays are flattened into one list.
 */
export function parseJsonStream(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"' && depth > 0) {
      inString = true;
    } else if (c === '[' || c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === ']' || c === '}') {
      if (--depth < 0) throw new Error(`unexpected "${c}" at offset ${i} in JSON stream`);
      if (depth === 0) {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (Array.isArray(value)) for (const v of value) values.push(v);
        else values.push(value);
      }
    } else if (depth === 0 && !/\s/.test(c)) {
      throw new Error(`unexpected ${JSON.stringify(c)} at offset ${i} in JSON stream`);
    }
  }
  if (depth !== 0 || inString) throw new Error('truncated JSON stream');
  return values;
}

function requireBranch(task: Task): string {
  if (!task.branch) throw new Error(`task ${task.id} has no branch`);
  if (!isSafeBranchName(task.branch)) throw new Error(`task ${task.id} has an invalid branch name ${JSON.stringify(task.branch)}`);
  return task.branch;
}

/** Body for a PR that integrate() has to open itself because publish() never managed to. */
function defaultPrBody(task: Task): string {
  return `${task.objective.trim()}\n\n_Opened by StayOn Autopilot when ${task.id} was ready to merge._`;
}

/** Prefix an inline review comment with its file location so a builder can find it. */
function withLocation(raw: Record<string, unknown>, body: string): string {
  if (typeof raw.path !== 'string') return body;
  const line = typeof raw.line === 'number' ? raw.line : typeof raw.original_line === 'number' ? raw.original_line : null;
  return `[${raw.path}${line !== null ? `:${line}` : ''}] ${body}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
