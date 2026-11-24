// SPDX-License-Identifier: MIT
// Merge policy: decides whether a finished task branch is merged without a click,
// becomes a founder review card, goes back to the builder, or is rejected outright.
// Pure and deterministic: everything it looks at is passed in.

import { profileAllowsAutoMerge } from '../config.ts';
import type { ProjectConfig } from '../config.ts';
import type { CheckRecord, DiffFile, DiffSummary, ReviewRecord, RiskClass, Task } from '../types.ts';
import { redactSecrets } from '../util.ts';
import { filesMatching, GlobError, globProblems, matchesAny } from './glob.ts';

export interface MergeInputs {
  task: Task;
  config: ProjectConfig;
  diff: DiffSummary;
  /** Latest branch-scope check records for diff.headCommit. */
  checks: CheckRecord[];
  /** Latest review of the task; only a review of diff.headCommit counts as one. */
  review: ReviewRecord | null;
  /** Blocking decisions still pending for this task. */
  pendingBlocking: number;
  /** Change requests (e.g. trusted PR comments) not yet addressed. */
  openChangeRequests: number;
}

export interface MergeVerdict {
  action: 'auto_merge' | 'human_review' | 'repair' | 'reject';
  reasons: string[];
  risk: RiskClass;
  sensitiveFiles: string[];
  protectedFiles: string[];
  changedLines: number;
}

/** A branch that deletes more files than this always needs a human. */
export const MAX_AUTO_MERGE_DELETIONS = 25;

const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, unknown: 1, high: 2 };
const RISK_BY_RANK: RiskClass[] = ['low', 'medium', 'high'];

/**
 * Classify a task branch. Steps short-circuit in order:
 *  1. protected files changed           -> reject
 *  2. a configured check lacks a passed record for this head -> repair
 *  3. review of this exact head (when required; a negative review always counts)
 *  4. pending blocking decisions / open change requests -> human_review
 *  5. auto-merge eligibility; every failed condition is listed -> human_review
 * A founder approval ("human_approve") of this exact head is itself the human
 * merge decision, so it skips step 5 (except under the "pause" profile); steps 1-4
 * still apply to it.
 * Throws GlobError (naming the setting) when the config holds an unusable glob: the
 * policy cannot be evaluated, so the merge job must fail loudly rather than guess.
 */
export function classifyMerge(i: MergeInputs): MergeVerdict {
  const { task, config, diff } = i;
  const ig = config.integration;
  assertUsableGlobs(ig);
  const touched = touchedPaths(diff);
  // Case-insensitive on purpose: on macOS "claude.md" or ".AUTOPILOT/x" is the same file.
  const protectedFiles = filesMatching(touched, ig.protectedPaths, { nocase: true });
  const sensitiveFiles = filesMatching(touched, ig.sensitivePaths, { nocase: true });
  const changedLines = diff.files.reduce((n, f) => n + lineCount(f.added) + lineCount(f.deleted), 0);
  const review = i.review && i.review.taskId === task.id ? i.review : null;
  const risk = combinedRisk(task.risk, review?.risk ?? null, sensitiveFiles.length > 0);
  const verdict = (action: MergeVerdict['action'], reasons: string[]): MergeVerdict => ({
    action,
    reasons,
    risk,
    sensitiveFiles,
    protectedFiles,
    changedLines,
  });

  // 1. Builders may not change policy files at all.
  if (protectedFiles.length > 0) return verdict('reject', [`changes protected policy files: ${listPaths(protectedFiles)}`]);
  if (!diff.headCommit) return verdict('human_review', ['the branch head commit is unknown']);

  // 2. Deterministic evidence for this exact head. Missing evidence is not success.
  const checkProblems = checkGaps(i);
  if (checkProblems.length > 0) return verdict('repair', checkProblems);

  // 3. Independent review of this exact revision.
  const current = review && review.headCommit === diff.headCommit ? review : null;
  if (ig.requireAgentReview && !current) return verdict('human_review', ['no independent review of this exact revision']);
  if (current) {
    const gate = reviewGate(current);
    if (gate) return verdict(gate.action, [gate.reason]);
  }

  // 4. Open questions or change requests about this task.
  const waiting: string[] = [];
  if (i.pendingBlocking > 0) waiting.push(`${plural(i.pendingBlocking, 'blocking decision')} still pending`);
  if (i.openChangeRequests > 0) waiting.push(plural(i.openChangeRequests, 'open change request'));
  if (waiting.length > 0) return verdict('human_review', waiting);

  if (current?.verdict === 'human_approve') {
    if (config.profile === 'pause') return verdict('human_review', ['profile pause: merging is paused']);
    return verdict('auto_merge', ['the founder approved this exact revision', checksSummary(config)]);
  }

  // 5. Auto-merge eligibility.
  const blockers = autoMergeBlockers(i, touched, sensitiveFiles, changedLines, review);
  if (blockers.length > 0) return verdict('human_review', blockers);
  return verdict('auto_merge', [
    checksSummary(config),
    current ? 'independent review approved this exact revision' : 'agent review is not required by policy',
    `${changedLines} changed lines (limit ${ig.maxAutoMergeLines})`,
  ]);
}

/** Short, phone-friendly text for a decision card about this verdict. */
export function reviewCardText(v: MergeVerdict, i: MergeInputs): { question: string; why: string } {
  const verb = v.action === 'reject' ? 'Discard' : v.action === 'repair' ? 'Repair' : 'Merge';
  const concern = cardConcern(v, i);
  const question = `${verb} ${i.task.id} "${clip(oneLine(i.task.title), 60)}"${concern ? ` (${concern})` : ''}?`;
  const reasons = v.reasons.length > 0 ? `: ${clip(v.reasons.join('; '), 600)}` : '';
  const why = [`${REASON_LABEL[v.action]}${reasons}.`, sizeLine(v, i.diff), checksLine(i), reviewLine(i), `Risk: ${v.risk}.`];
  return { question, why: why.join('\n') };
}

/** Every path the diff touches, including both sides of renames and copies. */
export function touchedPaths(diff: DiffSummary): string[] {
  const seen = new Set<string>();
  for (const f of diff.files) for (const p of renameSides(f.path)) seen.add(p);
  for (const p of patchHeaderPaths(diff.patch)) seen.add(p);
  return [...seen];
}

/**
 * Forges may flag binary files (git numstat reports "-" for their line counts). The flag
 * is not part of the DiffFile contract yet, so it is read defensively.
 */
type DiffFileMaybeBinary = DiffFile & { binary?: unknown };

/**
 * Added or modified binary files: git counts no lines for them and a reviewer cannot read
 * them, so maxAutoMergeLines would never limit them. Uses the forge's binary flag when
 * present, else the patch's "Binary files ... differ" lines (best effort: a truncated
 * patch may not reach every file).
 */
export function binaryFiles(diff: DiffSummary): string[] {
  const found = new Set<string>();
  for (const f of diff.files as DiffFileMaybeBinary[]) {
    if (f.binary === true && !isDeletion(f)) found.add(newSide(f.path));
  }
  for (const p of binaryPatchPaths(diff.patch)) found.add(p);
  return [...found];
}

// ------------------------------------------------------------------ helpers

const lineCount = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const isDeletion = (f: DiffFile): boolean => String(f.status ?? '').toUpperCase().startsWith('D');

/** Fail loudly, naming the setting, when a policy glob cannot be compiled. */
function assertUsableGlobs(ig: ProjectConfig['integration']): void {
  const settings = { protectedPaths: ig.protectedPaths, sensitivePaths: ig.sensitivePaths, allowedPaths: ig.allowedPaths };
  const problems = Object.entries(settings).flatMap(([name, globs]) => globProblems(globs).map((p) => `integration.${name}: ${p}`));
  if (problems.length > 0) throw new GlobError(`the merge policy cannot be evaluated: ${problems.join('; ')}`);
}
const rankOf = (r: RiskClass): number => RISK_RANK[r] ?? 1; // anything unexpected counts as medium

function combinedRisk(taskRisk: RiskClass, reviewRisk: RiskClass | null, sensitive: boolean): RiskClass {
  let rank = rankOf(taskRisk);
  if (reviewRisk) rank = Math.max(rank, rankOf(reviewRisk));
  if (sensitive) rank = Math.max(rank, RISK_RANK.medium);
  return RISK_BY_RANK[rank];
}

/** Latest record per check name for this task, head and branch scope. */
function latestChecks(i: MergeInputs): Map<string, CheckRecord> {
  const latest = new Map<string, CheckRecord>();
  for (const r of i.checks) {
    if (r.taskId !== i.task.id || r.headCommit !== i.diff.headCommit || r.scope !== 'branch') continue;
    const prev = latest.get(r.name);
    if (!prev || r.at > prev.at || (r.at === prev.at && r.id > prev.id)) latest.set(r.name, r);
  }
  return latest;
}

const CHECK_STATUS_TEXT: Record<string, string> = {
  failed: 'failed',
  error: 'could not run',
  timeout: 'timed out',
  skipped: 'was skipped',
};

function checkGaps(i: MergeInputs): string[] {
  const latest = latestChecks(i);
  const problems: string[] = [];
  for (const c of i.config.checks.commands) {
    const r = latest.get(c.name);
    if (!r) problems.push(`check "${c.name}" has no result for this revision`);
    else if (r.status !== 'passed') problems.push(`check "${c.name}" ${CHECK_STATUS_TEXT[r.status] ?? `ended with status ${r.status}`}`);
  }
  return problems;
}

function checksSummary(config: ProjectConfig): string {
  const n = config.checks.commands.length;
  if (n === 0) return 'no deterministic checks are configured';
  return n === 1 ? 'the configured check passed' : `all ${n} configured checks passed`;
}

const seriousFindings = (r: ReviewRecord): number =>
  (Array.isArray(r.findings) ? r.findings : []).filter((f) => f.severity === 'blocker' || f.severity === 'major').length;

function reviewGate(r: ReviewRecord): { action: 'repair' | 'human_review'; reason: string } | null {
  const serious = seriousFindings(r);
  switch (r.verdict) {
    case 'approve':
      // An approval that reports blocker/major findings contradicts itself.
      return serious > 0 ? { action: 'human_review', reason: `reviewer approved but reported ${plural(serious, 'blocker/major finding')}` } : null;
    case 'human_approve':
      return null;
    case 'request_changes':
      return { action: 'repair', reason: `reviewer requested changes${serious > 0 ? ` (${plural(serious, 'blocker/major finding')})` : ''}` };
    case 'human_request_changes':
      return { action: 'repair', reason: 'the founder requested changes' };
    case 'needs_human':
      return { action: 'human_review', reason: 'reviewer asked for a human decision' };
    default:
      return { action: 'human_review', reason: `unrecognized review verdict "${String(r.verdict)}"` };
  }
}

function autoMergeBlockers(
  i: MergeInputs,
  touched: string[],
  sensitiveFiles: string[],
  changedLines: number,
  review: ReviewRecord | null,
): string[] {
  const { config, diff, task } = i;
  const ig = config.integration;
  const out: string[] = [];
  if (!profileAllowsAutoMerge(config)) {
    const profileCould = profileAllowsAutoMerge({ ...config, integration: { ...ig, autoMerge: true } });
    out.push(profileCould ? 'auto-merge is turned off (integration.autoMerge is false)' : `profile ${config.profile} requires a human merge decision`);
  }
  if (diff.files.length === 0) out.push('the branch has no changes to merge');
  if (sensitiveFiles.length > 0) out.push(`changes sensitive files: ${listPaths(sensitiveFiles)}`);
  if (ig.allowedPaths.length > 0) {
    const outside = touched.filter((p) => !matchesAny(p, ig.allowedPaths));
    if (outside.length > 0) out.push(`changes files outside the auto-merge allowed paths: ${listPaths(outside)}`);
  }
  if (changedLines > ig.maxAutoMergeLines) out.push(`changes ${changedLines} lines (auto-merge limit ${ig.maxAutoMergeLines})`);
  const binaries = binaryFiles(diff);
  if (binaries.length > 0) out.push(`changes binary files, which are not line-counted or reviewable as text: ${listPaths(binaries)}`);
  if (task.risk === 'high') out.push('the task is rated high risk');
  if (review?.risk === 'high') out.push('the reviewer rated the change high risk');
  const deleted = diff.files.filter(isDeletion).length;
  if (deleted > MAX_AUTO_MERGE_DELETIONS) out.push(`deletes ${deleted} files (auto-merge limit ${MAX_AUTO_MERGE_DELETIONS})`);
  if (task.kind === 'integration') out.push('integration tasks always need a human merge decision');
  return out;
}

/** "a => b" and "dir/{a => b}/f" (git rename notation) name two paths; keep both sides. */
function renameSides(path: string): string[] {
  if (!path.includes(' => ')) return [path];
  const tidy = (s: string): string => s.replace(/\/{2,}/g, '/').replace(/^\//, '');
  const m = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (m) return [tidy(m[1] + m[2] + m[4]), tidy(m[1] + m[3] + m[4])];
  const at = path.indexOf(' => ');
  return [path, tidy(path.slice(0, at)), tidy(path.slice(at + 4))];
}

/** The destination of a path in git rename notation (the path itself otherwise). */
function newSide(path: string): string {
  const sides = renameSides(path);
  return sides[sides.length - 1];
}

/** New-side paths of "Binary files X and Y differ" patch lines; deletions are skipped. */
function binaryPatchPaths(patch: string): string[] {
  if (!patch) return [];
  const lines = patch.split('\n');
  if (!patch.endsWith('\n')) lines.pop(); // a truncated patch may end inside a line
  const out: string[] = [];
  for (const line of lines) {
    // Hunk lines always start with " ", "+", "-" or "\", so this only matches file headers.
    const m = /^Binary files (.+) differ$/.exec(line);
    const sides = m ? binarySides(m[1]) : null;
    if (!sides || sides[1] === '/dev/null') continue;
    const to = sides[1];
    out.push(to.startsWith('b/') ? to.slice(2) : to);
  }
  return out;
}

/**
 * Split "X and Y" from a binary-diff line. Names may themselves contain " and ", so prefer
 * the split where both sides name the same file (a/p and b/p), then one with /dev/null.
 */
function binarySides(body: string): [string, string] | null {
  const splits: Array<[string, string]> = [];
  for (let at = body.indexOf(' and '); at >= 0; at = body.indexOf(' and ', at + 1)) {
    splits.push([unquoteGitPath(body.slice(0, at)), unquoteGitPath(body.slice(at + 5))]);
  }
  const samePath = splits.find(([a, b]) => a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2));
  return samePath ?? splits.find(([a, b]) => a === '/dev/null' || b === '/dev/null') ?? splits[0] ?? null;
}

/** Paths named in per-file patch headers (rename/copy sources included). */
function patchHeaderPaths(patch: string): string[] {
  if (!patch) return [];
  const lines = patch.split('\n');
  if (!patch.endsWith('\n')) lines.pop(); // a truncated patch may end inside a path
  const out: string[] = [];
  let inHeader = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    const m = /^(rename from|rename to|copy from|copy to|---|\+\+\+) (.+)$/.exec(line);
    if (!m) continue;
    let p = unquoteGitPath(m[2].replace(/\t$/, '')); // git appends a tab after names with spaces
    if (p === '/dev/null') continue;
    if (m[1] === '---' && p.startsWith('a/')) p = p.slice(2);
    else if (m[1] === '+++' && p.startsWith('b/')) p = p.slice(2);
    if (p) out.push(p);
  }
  return out;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undo git's C-style path quoting ("caf\303\251.txt" -> café.txt). */
function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const parts: Buffer[] = [];
  let last = 0;
  for (const m of body.matchAll(/\\([0-7]{3}|[abtnvfr"\\])/g)) {
    const at = m.index ?? 0;
    parts.push(Buffer.from(body.slice(last, at), 'utf8'));
    const e = m[1];
    parts.push(Buffer.from([e.length === 3 ? parseInt(e, 8) & 0xff : C_ESCAPES[e]]));
    last = at + m[0].length;
  }
  parts.push(Buffer.from(body.slice(last), 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

// ------------------------------------------------------------- card text

const REASON_LABEL: Record<MergeVerdict['action'], string> = {
  auto_merge: 'Eligible for auto-merge',
  human_review: 'Needs your decision',
  repair: 'Needs repair',
  reject: 'Rejected',
};

const REVIEW_VERDICT_TEXT: Record<string, string> = {
  approve: 'approved',
  request_changes: 'changes requested',
  needs_human: 'needs a human',
  human_approve: 'approved by you',
  human_request_changes: 'changes requested by you',
};

/** Rough area labels for sensitive files, used in the card question. */
const SENSITIVE_AREAS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)(auth|oauth|login|sessions?)(\/|$)/i, 'auth'],
  [/(^|\/)(payments?|billing|stripe)(\/|$)/i, 'payments'],
  [/(^|\/)(\.env[^/]*|secrets?(\/.*)?|[^/]*\.(pem|key))$/i, 'secrets'],
  [/(^|\/)(migrations|supabase)(\/|$)|\.sql$/i, 'database'],
  [/(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?)$/i, 'dependency'],
  [/^\.github\//i, 'CI'],
  [/(^|\/)(dockerfile(\.[^/]*)?|docker-compose[^/]*\.ya?ml|vercel\.json|eas\.json|firebase\.json|[^/]*\.rules)$/i, 'deploy config'],
  [/(^|\/)(claude\.md|\.claude\/.*)$/i, 'agent instruction'],
  // Files that run code on the founder's machine or in CI (git hooks, editor tasks, direnv).
  [/(^|\/)(\.husky\/.*|\.pre-commit-config\.ya?ml|lefthook\.ya?ml|\.gitmodules|\.vscode\/.*|\.devcontainer\/.*|\.envrc)$/i, 'dev tooling'],
];

function sensitiveAreas(files: string[]): string {
  const found: string[] = [];
  for (const f of files) for (const [re, label] of SENSITIVE_AREAS) if (re.test(f) && !found.includes(label)) found.push(label);
  if (found.length === 0) return 'sensitive';
  if (found.length === 1) return found[0];
  if (found.length === 2) return `${found[0]} and ${found[1]}`;
  return `${found[0]}, ${found[1]} and other sensitive`;
}

function cardConcern(v: MergeVerdict, i: MergeInputs): string | null {
  if (v.protectedFiles.length > 0) return 'changes protected policy files';
  if (v.action === 'repair') return v.reasons.length === 1 ? clip(v.reasons[0], 48) : `${v.reasons.length} problems`;
  if (v.sensitiveFiles.length > 0) return `changes ${sensitiveAreas(v.sensitiveFiles)} files`;
  if (v.changedLines > i.config.integration.maxAutoMergeLines) return `${v.changedLines} changed lines`;
  if (binaryFiles(i.diff).length > 0) return 'changes binary files';
  if (v.risk === 'high') return 'high risk';
  const r = i.review && i.review.headCommit === i.diff.headCommit ? i.review : null;
  if (!r && i.config.integration.requireAgentReview) return 'not reviewed yet';
  if (r?.verdict === 'needs_human') return 'reviewer wants your call';
  if (r?.verdict === 'approve' && seriousFindings(r) > 0) return 'reviewer flagged issues';
  if (i.pendingBlocking > 0) return 'open questions first';
  if (i.openChangeRequests > 0) return 'change requests open';
  if (i.task.kind === 'integration') return 'integration task';
  return null;
}

function sizeLine(v: MergeVerdict, diff: DiffSummary): string {
  const added = diff.files.reduce((n, f) => n + lineCount(f.added), 0);
  const deleted = diff.files.reduce((n, f) => n + lineCount(f.deleted), 0);
  return `Size: ${plural(diff.files.length, 'file')}, ${v.changedLines} changed lines (+${added} / -${deleted}).`;
}

function checksLine(i: MergeInputs): string {
  const names = i.config.checks.commands.map((c) => c.name);
  if (names.length === 0) return 'Checks: none configured.';
  const latest = latestChecks(i);
  const passed = names.filter((n) => latest.get(n)?.status === 'passed');
  const others = names.filter((n) => latest.get(n)?.status !== 'passed').map((n) => `${n} ${latest.get(n)?.status ?? 'missing'}`);
  return `Checks: ${passed.length}/${names.length} passed${passed.length > 0 ? ` (${passed.join(', ')})` : ''}${others.length > 0 ? `; ${others.join(', ')}` : ''}.`;
}

function reviewLine(i: MergeInputs): string {
  const r = i.review;
  if (!r) return 'Review: none yet.';
  if (r.headCommit !== i.diff.headCommit) return `Review: only of an older revision (${r.headCommit.slice(0, 7)}).`;
  const serious = seriousFindings(r);
  const count = Array.isArray(r.findings) ? r.findings.length : 0;
  const findings = count > 0 ? `, ${plural(count, 'finding')}${serious > 0 ? ` (${serious} blocker/major)` : ''}` : '';
  const summary = clip(oneLine(redactSecrets(r.summary ?? '')), 300);
  return `Review (${REVIEW_VERDICT_TEXT[r.verdict] ?? r.verdict}, ${r.risk} risk${findings}): ${summary || 'no summary.'}`;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** First `max` characters (code points), with an ellipsis when cut. */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max).join('').trimEnd()}…`;
}

function listPaths(paths: string[], max = 5): string {
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}
