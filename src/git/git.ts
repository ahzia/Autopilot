// SPDX-License-Identifier: MIT
// Shell-free helpers around the git CLI, plus parsers for git's machine-readable output.
// Every process is spawned with an argument array; nothing ever goes through a shell.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { redactSecrets, tail } from '../util.ts';

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** How long to wait for output pipes to close once the process has exited. */
const EXIT_DRAIN_MS = 500;

/** After SIGTERM, how long a stopped process tree gets before SIGKILL. */
export const KILL_GRACE_MS = 2_000;

// ------------------------------------------------------------ processes

/**
 * On POSIX every command leads its own process group, so a timeout stops the whole tree (git and
 * the ssh, remote helpers or `git reset --hard` it started), not only the direct child.
 */
const USE_PROCESS_GROUPS = process.platform !== 'win32';

/**
 * Process groups that may still be running, mapped to whether they were already sent SIGTERM.
 * Our own groups no longer receive the terminal's Ctrl-C, so they are stopped when we exit.
 */
const liveGroups = new Map<number, boolean>();
let exitHookInstalled = false;

function trackGroup(pgid: number): void {
  liveGroups.set(pgid, false);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [id, terminated] of liveGroups) {
      try {
        process.kill(-id, terminated ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // already gone
      }
    }
  });
}

/** Signal the child's whole process group (or just the child where groups are unavailable). */
function signalTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return false;
  try {
    if (USE_PROCESS_GROUPS) process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    return false; // ESRCH: nothing left to signal
  }
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Stop the process tree after this long (default 120 s). The result then has code -1 and timedOut. */
  timeoutMs?: number;
  /** Written to stdin. stdin is always closed, so a child never waits for input. */
  input?: string;
  /** Keep at most this many bytes of stdout. */
  maxStdoutBytes?: number;
  /** Stop the process as soon as stdout exceeds maxStdoutBytes instead of reading it to the end. */
  stopAtMaxStdout?: boolean;
}

export interface CommandResult {
  /** Exit code; -1 when the process could not start, timed out or was killed by a signal. */
  code: number;
  stdout: string;
  stderr: string;
  /** stdout was cut at maxStdoutBytes. */
  stdoutTruncated: boolean;
  /** The process was stopped on purpose once stdout reached maxStdoutBytes (stopAtMaxStdout). */
  stopped: boolean;
  timedOut: boolean;
}

/** Run a program with an argument array (never a shell) and collect its output. Never rejects. */
export function runCommand(cmd: string, args: string[], opts: CommandOptions): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const limit = opts.maxStdoutBytes;
  return new Promise((resolve) => {
    const fail = (stderr: string) =>
      resolve({ code: -1, stdout: '', stderr, stdoutTruncated: false, stopped: false, timedOut: false });
    // A missing cwd makes spawn report "spawn <cmd> ENOENT", which wrongly blames the program.
    if (!existsSync(opts.cwd)) return fail(`working directory does not exist: ${opts.cwd}`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: USE_PROCESS_GROUPS,
        windowsHide: true,
      });
    } catch (err) {
      return fail(`cannot start ${cmd}: ${(err as Error).message}`);
    }
    if (USE_PROCESS_GROUPS && child.pid !== undefined) trackGroup(child.pid);

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let stdoutTruncated = false;
    let stopped = false;
    let timedOut = false;
    let terminated = false;
    let spawnError: Error | null = null;
    let settled = false;

    /** SIGTERM lets git remove its lock files and stop its helpers; SIGKILL whatever ignores it. */
    const terminate = () => {
      if (terminated || !signalTree(child, 'SIGTERM')) return;
      terminated = true;
      const pgid = child.pid;
      if (pgid !== undefined && USE_PROCESS_GROUPS) liveGroups.set(pgid, true);
      // Unref'd: should this process exit first, the exit hook sends the SIGKILL instead.
      setTimeout(() => {
        signalTree(child, 'SIGKILL');
        if (pgid !== undefined) liveGroups.delete(pgid);
      }, KILL_GRACE_MS).unref();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (limit === undefined) return void out.push(chunk);
      const room = limit - outBytes;
      if (room > 0) {
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        out.push(kept);
        outBytes += kept.length;
      }
      if (chunk.length <= room) return;
      stdoutTruncated = true;
      if (opts.stopAtMaxStdout && !stopped) {
        stopped = true;
        child.stdout.destroy(); // the writer gets EPIPE/SIGPIPE on its next write
        terminate();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => void errOut.push(chunk));
    // Errors on our end of the pipes (e.g. after destroy) must never crash the caller.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {}); // the child may exit before reading its input (EPIPE)
    child.stdin.end(opts.input ?? '');

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A stopped group stays tracked until its SIGKILL escalation has run (see terminate).
      if (child.pid !== undefined && !terminated) liveGroups.delete(child.pid);
      const notes = [Buffer.concat(errOut).toString('utf8')];
      if (spawnError) notes.push(spawnError.message);
      if (timedOut) notes.push(`${cmd} timed out after ${timeoutMs} ms`);
      resolve({
        code: timedOut || code === null ? -1 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: notes.filter(Boolean).join('\n'),
        stdoutTruncated,
        stopped,
        timedOut,
      });
    };
    child.on('error', (err) => {
      spawnError = err;
      if (child.pid === undefined) finish(null); // never started (e.g. ENOENT)
    });
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => {
      // A grandchild (an ssh ControlPersist master, say) can hold our pipes open long after the
      // process itself exited, and 'close' waits for the pipes. Let them drain briefly, then stop.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, EXIT_DRAIN_MS).unref();
    });
  });
}

// ------------------------------------------------------------ redaction

/** Hide the user-info part of URLs: "https://user:token@host/x" -> "https://***@host/x". */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\/\s'"]+@/gi, '$1***@');
}

/** URL credentials and other obvious secrets removed, for messages that reach events or the inbox. */
export function redact(text: string): string {
  return redactSecrets(redactUrlCredentials(text));
}

// ------------------------------------------------------------------ git

export class GitError extends Error {
  readonly code: number;
  readonly stderr: string;
  /** The arguments, with URL credentials hidden. */
  readonly args: string[];
  constructor(args: string[], code: number, stderr: string) {
    const safeArgs = args.map(redactUrlCredentials);
    const safeStderr = redactUrlCredentials(stderr);
    const detail = safeStderr.trim() ? `: ${tail(safeStderr.trim(), 1500)}` : '';
    super(redactSecrets(`git ${safeArgs.join(' ')} failed (exit ${code})${detail}`));
    this.name = 'GitError';
    this.code = code;
    this.stderr = safeStderr;
    this.args = safeArgs;
  }
}

export interface GitOptions {
  cwd: string;
  /** Defaults to gitEnv() (process.env without repository-redirecting variables). Prompts, replace refs and grafts stay off. */
  env?: NodeJS.ProcessEnv;
  /** Default 120 s. */
  timeoutMs?: number;
  /** Return non-zero exits instead of throwing GitError. */
  allowFail?: boolean;
  input?: string;
  maxStdoutBytes?: number;
  /** See CommandOptions.stopAtMaxStdout; a process stopped this way is not an error. */
  stopAtMaxStdout?: boolean;
}

export type GitResult = CommandResult;

/**
 * Settings forced on every git command: no hooks, no fsmonitor hook/daemon, no untracked cache
 * (a doctored one could hide files from `git status`), no ext:: transport. Workers can write the
 * shared repository's config, index and hooks directory (their commits go through it), and none
 * of that may run programs inside the supervisor. Same values as SAFE_GIT_FLAGS in util.ts.
 * Replace refs are off through the environment too (FORCED_GIT_ENV), but git before 2.42 let a
 * repository's core.useReplaceRefs=true switch them back on; command-line config always wins.
 */
export const HARDENING_CONFIG: readonly string[] = [
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.useReplaceRefs=false',
];

/**
 * Variables that silently point git at another repository. Git sets several of them while running
 * hooks, so a supervisor (or test run) started from a hook would otherwise operate on the wrong repo.
 */
const REPO_REDIRECT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/**
 * Environment forced on every git command: never prompt, and ignore replace refs and grafts.
 * Workers can write refs/replace/* and info/grafts in the shared repository; honoring them would
 * let the supervisor diff, scan and review objects and history other than the ones the refs
 * really point at (and that merges and pushes then use). Every worker run gets the last two too
 * (Supervisor.startRun), so a reviewer's own git commands show the same commits. The graft file
 * is one that cannot exist (/dev/null is no directory), so git reads no grafts and says nothing;
 * GIT_GRAFT_FILE=/dev/null itself makes git print a deprecation hint on every command.
 */
const FORCED_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/no-grafts' } as const;

/** process.env without repository-redirecting variables, with FORCED_GIT_ENV, plus `extra`. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of REPO_REDIRECT_VARS) delete env[key];
  return { ...env, ...FORCED_GIT_ENV, ...extra };
}

/**
 * Run git without a shell, with HARDENING_CONFIG and FORCED_GIT_ENV always applied.
 * Throws GitError on a non-zero exit unless allowFail is set.
 */
export async function git(args: string[], opts: GitOptions): Promise<GitResult> {
  const res = await runCommand('git', [...HARDENING_CONFIG, ...args], {
    cwd: opts.cwd,
    env: { ...(opts.env ?? gitEnv()), ...FORCED_GIT_ENV },
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    input: opts.input,
    maxStdoutBytes: opts.maxStdoutBytes,
    stopAtMaxStdout: opts.stopAtMaxStdout,
  });
  if (res.code !== 0 && !opts.allowFail && !res.stopped) {
    throw new GitError(args, res.code, res.stderr.trim() ? res.stderr : res.stdout);
  }
  return res;
}

// ------------------------------------------------------------- validation

/** Reject revision arguments git could mistake for options (or that hide whitespace/NULs). */
export function assertRevArg(rev: string): void {
  if (!rev || rev.startsWith('-') || /[\s\0]/.test(rev)) throw new Error(`unsafe git revision argument: ${JSON.stringify(rev)}`);
}

/** Conservative subset of git's branch-name rules (see git check-ref-format). */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 200 || !/^[A-Za-z0-9._\/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name === 'HEAD' || name.includes('..') || name.endsWith('.')) return false;
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

// ---------------------------------------------------------- ref helpers

/** Commit sha a ref resolves to, or null when it does not exist. */
export async function revParse(cwd: string, ref: string): Promise<string | null> {
  assertRevArg(ref);
  const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
  const r = await git(args, { cwd, allowFail: true });
  if (r.code === 0) return r.stdout.trim() || null;
  if (r.code === 1) return null;
  throw new GitError(args, r.code, r.stderr);
}

/** True when commit `a` is an ancestor of (or equal to) commit `b`. */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  assertRevArg(a);
  assertRevArg(b);
  const args = ['merge-base', '--is-ancestor', a, b];
  const r = await git(args, { cwd, allowFail: true });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new GitError(args, r.code, r.stderr);
}

/** Best common ancestor of two commits, or null when the histories are unrelated. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  assertRevArg(a);
  assertRevArg(b);
  const args = ['merge-base', a, b];
  const r = await git(args, { cwd, allowFail: true });
  if (r.code === 0) return r.stdout.trim() || null;
  if (r.code === 1) return null;
  throw new GitError(args, r.code, r.stderr);
}

/** True when the object store has `sha` as a commit. */
export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  assertRevArg(sha);
  return (await git(['cat-file', '-e', `${sha}^{commit}`], { cwd, allowFail: true })).code === 0;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  if (!isSafeBranchName(branch)) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
  const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`];
  const r = await git(args, { cwd, allowFail: true });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new GitError(args, r.code, r.stderr);
}

/** Paths with unresolved merge conflicts in a worktree. */
export async function listConflicts(cwd: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd });
  return [...new Set(r.stdout.split('\0').filter(Boolean))];
}

// -------------------------------------------------------------- parsers

export interface NumstatEntry {
  path: string;
  /** Source path when git detected a rename or copy. */
  oldPath: string | null;
  added: number;
  deleted: number;
  /** Binary files report "-" counts; they count as 0 added / 0 deleted. */
  binary: boolean;
}

export interface NameStatusEntry {
  /** One letter: A, M, D, R, C, T, U or X. */
  status: string;
  path: string;
  oldPath: string | null;
  /** Similarity score of a rename/copy (R100 -> 100). */
  score: number | null;
}

/** Parse `git diff --numstat` output, NUL-separated (-z, preferred) or line-based. */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const entry = (added: string, deleted: string, path: string, oldPath: string | null): NumstatEntry => {
    const binary = added === '-' || deleted === '-';
    return { path, oldPath, added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary };
  };
  if (output.includes('\0')) {
    // "<added>\t<deleted>\t<path>\0", or for renames "<added>\t<deleted>\t\0<old>\0<new>\0".
    const tokens = output.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
      if (!m) continue;
      if (m[3] !== '') {
        entries.push(entry(m[1], m[2], m[3], null));
      } else {
        const oldPath = tokens[++i] ?? '';
        entries.push(entry(m[1], m[2], tokens[++i] ?? '', oldPath));
      }
    }
    return entries;
  }
  for (const line of output.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const { path, oldPath } = splitRenamePath(m[3]);
    entries.push(entry(m[1], m[2], path, oldPath));
  }
  return entries;
}

/** Parse `git diff --name-status` output, NUL-separated (-z, preferred) or line-based. */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  const entry = (code: string, path: string, oldPath: string | null): NameStatusEntry => {
    const score = code.length > 1 && /^\d+$/.test(code.slice(1)) ? Number(code.slice(1)) : null;
    return { status: code[0], path, oldPath, score };
  };
  const hasTwoPaths = (code: string) => code[0] === 'R' || code[0] === 'C';
  if (output.includes('\0')) {
    // "<status>\0<path>\0", or for renames/copies "R100\0<old>\0<new>\0".
    const tokens = output.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const code = tokens[i];
      if (!/^[A-Z]\d*$/.test(code)) continue;
      if (hasTwoPaths(code)) {
        const oldPath = tokens[++i] ?? '';
        entries.push(entry(code, tokens[++i] ?? '', oldPath));
      } else {
        entries.push(entry(code, tokens[++i] ?? '', null));
      }
    }
    return entries;
  }
  for (const line of output.split('\n')) {
    const fields = line.split('\t');
    const code = fields[0];
    if (!code || !/^[A-Z]\d*$/.test(code) || fields.length < 2) continue;
    if (hasTwoPaths(code) && fields.length >= 3) entries.push(entry(code, unquotePath(fields[2]), unquotePath(fields[1])));
    else entries.push(entry(code, unquotePath(fields[1]), null));
  }
  return entries;
}

/** Paths from `git status --porcelain=v1 -z` (renames contribute both the new and the old path). */
export function parseStatusPorcelain(output: string): string[] {
  const paths: string[] = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4 || t[2] !== ' ') continue;
    paths.push(t.slice(3));
    // In -z mode a rename/copy entry is "XY <new>\0<old>\0".
    if ('RC'.includes(t[0]) || 'RC'.includes(t[1])) {
      const from = tokens[++i];
      if (from) paths.push(from);
    }
  }
  return paths;
}

export interface WorktreeListEntry {
  path: string;
  head: string | null;
  /** Full ref ("refs/heads/x"), or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
  /** Lock reason ("" when locked without one), or null when not locked. */
  locked: string | null;
}

/** Parse `git worktree list --porcelain` (records separated by blank lines). */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let cur: WorktreeListEntry | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null, bare: false, detached: false, prunable: false, locked: null };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim();
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = line.slice('locked'.length).trim();
    }
  }
  return entries;
}

/** "Key: value" lines of a commit message, keyed by lowercased key; repeated keys keep every value. */
export function parseTrailers(message: string): Record<string, string[]> {
  const trailers: Record<string, string[]> = {};
  for (const line of message.split('\n')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(\S.*?)\s*$/.exec(line);
    if (m) (trailers[m[1].toLowerCase()] ??= []).push(m[2]);
  }
  return trailers;
}

/** Parse `git config --null --list` output ("key\nvalue\0" per entry) into [key, value] pairs. */
export function parseConfigList(output: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const nl = record.indexOf('\n');
    // A key without "=value" (a bare boolean) has no newline.
    entries.push(nl < 0 ? [record, ''] : [record.slice(0, nl), record.slice(nl + 1)]);
  }
  return entries;
}

/** Undo git's C-style quoting of unusual paths ("\"a\\tb\"", octal-escaped UTF-8 bytes). */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const s = p.slice(1, -1);
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes: number[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length;
      continue;
    }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 4;
    } else {
      const next = s[i + 1] ?? '';
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 2;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Expand numstat's rename notation: "a => b" or "dir/{a => b}/file". */
function splitRenamePath(raw: string): { path: string; oldPath: string | null } {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (brace) {
    const [, pre, from, to, post] = brace;
    const tidy = (s: string) => s.replace(/\/{2,}/g, '/').replace(/^\//, '');
    return { path: unquotePath(tidy(pre + to + post)), oldPath: unquotePath(tidy(pre + from + post)) };
  }
  const arrow = raw.split(' => ');
  if (arrow.length === 2) return { path: unquotePath(arrow[1]), oldPath: unquotePath(arrow[0]) };
  return { path: unquotePath(raw), oldPath: null };
}
