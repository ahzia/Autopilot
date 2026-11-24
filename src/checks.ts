// SPDX-License-Identifier: MIT
// Deterministic check runner. The supervisor (never the model) runs the project's
// setup and check commands in a task worktree and records the evidence.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.ts';
import type { CheckResult, CheckRunner, CheckStatus } from './types.ts';
import { redactSecrets, sha256Hex, tail } from './util.ts';

const execFileAsync = promisify(execFile);

/**
 * Credentials that check commands (which execute builder-written code) must never see:
 * the ones the autopilot itself uses to reach Claude (API key, OAuth, Bedrock, Vertex,
 * Foundry) and GitHub. Defense in depth only: check code still runs as the founder's
 * user and can read credential files in the home directory.
 */
export const STRIPPED_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/** Variables that would point git at a repository other than the worktree. */
const GIT_LOCATION_VARS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/** Environment variables whose values are scrubbed from captured output. */
const SECRET_ENV_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH_?KEY|DATABASE_URL/i;

/** File name (inside the worktree's git dir) that records the setup state of the worktree. */
export const SETUP_MARKER = 'autopilot-setup-done';

/**
 * File names whose content decides what setup installs: dependency manifests, lockfiles,
 * package-manager settings and tool-version pins (asdf, mise, nvm, pyenv, rbenv).
 */
const DEPENDENCY_FILE_NAMES: ReadonlySet<string> = new Set([
  // JavaScript / TypeScript
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  '.npmrc',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  // Python
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'Pipfile',
  'Pipfile.lock',
  'setup.py',
  'setup.cfg',
  // Ruby, Go, Rust, PHP, Elixir, Dart/Flutter, Swift/iOS, JVM, .NET
  'Gemfile',
  'Gemfile.lock',
  'go.mod',
  'go.sum',
  'go.work',
  'go.work.sum',
  'Cargo.toml',
  'Cargo.lock',
  'composer.json',
  'composer.lock',
  'mix.exs',
  'mix.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'Package.swift',
  'Package.resolved',
  'Podfile',
  'Podfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.lockfile',
  'libs.versions.toml',
  'packages.lock.json',
  'Directory.Packages.props',
  // Tool-version pins
  '.tool-versions',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  'mise.toml',
  '.mise.toml',
]);
const DEPENDENCY_FILE_PATTERNS: readonly RegExp[] = [/^requirements.*\.(txt|in)$/i, /^constraints.*\.txt$/i, /\.gemspec$/i, /\.(cs|fs|vb)proj$/i];

/** Dependency files larger than this contribute only their size to the setup fingerprint. */
const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;

const KILL_GRACE_MS = 3000;
/** After the main process exits, how long leftovers may keep stdout/stderr open. */
const STDIO_DRAIN_MS = 1500;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 900;
const DEFAULT_SETUP_TIMEOUT_SECONDS = 1800;
/** Output kept beyond maxOutput so secrets near the cut are redacted before the tail is taken. */
const REDACTION_MARGIN = 8192;

export interface CheckRunnerOptions {
  /** Base environment (default process.env); credentials are removed before use. */
  env?: NodeJS.ProcessEnv;
  /** Characters of combined output kept per command (default 6000). */
  maxOutput?: number;
  now?: () => number;
  /** Timeout for each setup command (default 1800s; config has no setup timeout). */
  setupTimeoutSeconds?: number;
}

/** Per-worktree port base so parallel test servers in different worktrees do not collide. */
export function portBaseFor(cwd: string): number {
  const h = Number.parseInt(sha256Hex(resolve(cwd)).slice(0, 8), 16);
  return 40000 + (h % 900) * 10;
}

/** Environment for commands run in `cwd`: credentials and git location overrides removed. */
export function checkEnv(base: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const drop = new Set([...STRIPPED_ENV_VARS, ...GIT_LOCATION_VARS]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || drop.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  env.CI = '1';
  env.AUTOPILOT_PORT_BASE = String(portBaseFor(cwd));
  return env;
}

/**
 * Whether a repo-relative path is a dependency manifest, lockfile or version pin whose
 * change means setup must run again. Files inside node_modules belong to installed
 * packages, not to the project.
 */
export function isDependencyFile(path: string): boolean {
  const segments = path.split('/');
  if (segments.includes('node_modules')) return false;
  const name = segments[segments.length - 1] ?? '';
  return DEPENDENCY_FILE_NAMES.has(name) || DEPENDENCY_FILE_PATTERNS.some((re) => re.test(name));
}

// ------------------------------------------------------------ process groups

/**
 * Process groups (POSIX) of check commands that may still have live members, across all
 * runners. Commands run detached, so a terminal Ctrl-C never reaches them and they would
 * outlive the supervisor; the 'exit' hook installed by trackGroup is the last resort.
 * A group is forgotten only once it is known to be empty or its final SIGKILL was sent.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pgid: number): void {
  if (process.platform === 'win32') return;
  liveGroups.add(pgid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Synchronous, so it also runs on process.exit(); nothing runs after a SIGKILL of the supervisor.
    process.once('exit', killAllCheckProcesses);
  }
}

/**
 * SIGKILL every check command process group that may still be alive, from any runner.
 * Synchronous; runs automatically when the supervisor process exits.
 */
export function killAllCheckProcesses(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // ESRCH: the group is already gone
    }
  }
  liveGroups.clear();
}

/** Signal a command's whole process group; false when nothing is left in it (ESRCH). */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return false;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal); // negative pid = the whole process group
    return true;
  } catch {
    return false;
  }
}

/** Setup jobs in flight by marker path: at most one per worktree, across runner instances. */
const setupJobs = new Map<string, { fingerprint: string; job: Promise<CheckResult[]> }>();

// -------------------------------------------------------------------- runner

export class CommandCheckRunner implements CheckRunner {
  private readonly cfg: ProjectConfig['checks'];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly maxOutput: number;
  private readonly now: () => number;
  private readonly setupTimeoutMs: number;
  /** Literal secret values from the base environment, longest first. */
  private readonly secretValues: string[];
  /** Abort functions of the commands currently running. */
  private readonly running = new Set<() => void>();
  /** Bumped by killAll(); a run or setup that sees it change starts no further commands. */
  private stopGeneration = 0;

  constructor(cfg: ProjectConfig['checks'], opts: CheckRunnerOptions = {}) {
    this.cfg = cfg;
    this.baseEnv = opts.env ?? process.env;
    this.maxOutput = opts.maxOutput !== undefined && opts.maxOutput > 0 ? Math.floor(opts.maxOutput) : 6000;
    this.now = opts.now ?? Date.now;
    this.setupTimeoutMs = secondsToMs(opts.setupTimeoutSeconds, DEFAULT_SETUP_TIMEOUT_SECONDS);
    this.secretValues = secretValuesOf(this.baseEnv);
  }

  /**
   * Run the setup commands when the worktree needs them: the first time, and again whenever
   * the setup commands or a dependency manifest/lockfile changed since the last successful
   * setup (a reused worktree, such as the forge's integration worktree, keeps node_modules
   * across checkouts). The marker lives in the worktree's own git dir
   * (`git rev-parse --git-path`), so it never shows up in the builder's diff.
   * Stops at the first failing command; the marker is written only when all pass.
   */
  async setup(cwd: string): Promise<CheckResult[]> {
    if (this.cfg.setup.length === 0) return [];
    const started = this.now();
    if (!isDirectory(cwd)) {
      return [this.result('setup:git', ['git', 'rev-parse', '--git-path', SETUP_MARKER], 'error', started, '', `working directory does not exist: ${cwd}`)];
    }
    for (;;) {
      let marker: string;
      try {
        marker = await this.markerPath(cwd);
      } catch (err) {
        const note = `cannot locate the git directory of ${cwd}: ${errorMessage(err)}`;
        return [this.result('setup:git', ['git', 'rev-parse', '--git-path', SETUP_MARKER], 'error', started, '', note)];
      }
      let fingerprint: string;
      try {
        fingerprint = await this.setupFingerprint(cwd);
      } catch (err) {
        return [this.result('setup:git', ['git', ...LS_FILES_ARGS], 'error', started, '', `cannot list the files of ${cwd}: ${errorMessage(err)}`)];
      }
      if (markerFingerprint(marker) === fingerprint) return [];
      const inFlight = setupJobs.get(marker);
      if (inFlight?.fingerprint === fingerprint) return inFlight.job;
      if (inFlight) {
        // Never two setups in one worktree at once; once it is done, decide again.
        await inFlight.job.catch(() => undefined);
        continue;
      }
      const job: Promise<CheckResult[]> = this.runSetup(cwd, marker).finally(() => {
        if (setupJobs.get(marker)?.job === job) setupJobs.delete(marker);
      });
      setupJobs.set(marker, { fingerprint, job });
      return job;
    }
  }

  /** Run every configured check in order (all of them, so a repair sees every problem). */
  async run(cwd: string): Promise<CheckResult[]> {
    const generation = this.stopGeneration;
    const results: CheckResult[] = [];
    for (const c of this.cfg.commands) {
      if (this.stopGeneration !== generation) break; // killAll(): start nothing new
      results.push(await this.execute(c.name, c.run, cwd, secondsToMs(c.timeoutSeconds, DEFAULT_CHECK_TIMEOUT_SECONDS)));
    }
    return results;
  }

  /**
   * Kill the process groups of this runner's running commands and keep runs in progress
   * from starting further commands (e.g. on supervisor shutdown). Commands run in their own
   * process groups, so they would otherwise outlive the supervisor; if the process exits
   * first, the exit hook (killAllCheckProcesses) still kills them.
   */
  killAll(): void {
    this.stopGeneration++;
    for (const abort of [...this.running]) abort();
  }

  private async markerPath(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', SETUP_MARKER], {
      cwd,
      env: checkEnv(this.baseEnv, cwd),
      timeout: 30_000,
      encoding: 'utf8',
    });
    const p = stdout.replace(/\r?\n$/, '');
    if (!p) throw new Error('git rev-parse printed no path');
    // Relative output is relative to cwd; linked worktrees get an absolute per-worktree path.
    return resolve(cwd, p);
  }

  /**
   * What the installed state of a worktree depends on: the setup commands and the content
   * of every dependency file in the worktree (tracked, or untracked and not ignored).
   */
  private async setupFingerprint(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', LS_FILES_ARGS, {
      cwd,
      env: checkEnv(this.baseEnv, cwd),
      timeout: 60_000,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
    const files = [...new Set(stdout.split('\0').filter((p) => p !== '' && isDependencyFile(p)))].sort();
    const hash = createHash('sha256').update(JSON.stringify({ v: 1, setup: this.cfg.setup }));
    for (const f of files) hash.update(`\0${f}\0${fileDigest(resolve(cwd, f))}`);
    return hash.digest('hex');
  }

  private async runSetup(cwd: string, marker: string): Promise<CheckResult[]> {
    const generation = this.stopGeneration;
    const results: CheckResult[] = [];
    for (const argv of this.cfg.setup) {
      const r = await this.execute(`setup:${argv[0] ?? ''}`, argv, cwd, this.setupTimeoutMs);
      results.push(r);
      if (r.status !== 'passed') return results; // later setup steps depend on earlier ones
      if (this.stopGeneration !== generation) return results; // killAll(): no marker for an unfinished setup
    }
    try {
      // Fingerprint what setup left behind: a setup that rewrites a lockfile (e.g. "npm install")
      // must not make the next call run it again.
      const fingerprint = await this.setupFingerprint(cwd);
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `${JSON.stringify({ v: 2, at: this.now(), fingerprint })}\n`);
    } catch (err) {
      console.error(`[autopilot] could not write the setup marker for ${cwd}: ${errorMessage(err)}`);
    }
    return results;
  }

  /** Run one command in its own process group with a timeout; never rejects. */
  private execute(name: string, argv: readonly string[], cwd: string, timeoutMs: number): Promise<CheckResult> {
    const started = this.now();
    const command = [...argv];
    if (command.length === 0 || !command[0]) return Promise.resolve(this.result(name, command, 'error', started, '', 'empty command'));
    if (!isDirectory(cwd)) return Promise.resolve(this.result(name, command, 'error', started, '', `working directory does not exist: ${cwd}`));
    const output = new TailBuffer(this.maxOutput + REDACTION_MARGIN);

    return new Promise<CheckResult>((done) => {
      let spawned: ChildProcessByStdio<null, Readable, Readable>;
      try {
        // detached: the command leads a new process group, so a timeout can kill everything it started.
        spawned = spawn(command[0], command.slice(1), {
          cwd,
          env: checkEnv(this.baseEnv, cwd),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        done(this.result(name, command, 'error', started, '', `could not start ${command[0]}: ${errorMessage(err)}`));
        return;
      }
      const child = spawned;
      const pgid = child.pid;
      if (pgid !== undefined) trackGroup(pgid);
      const forgetGroup = (): void => {
        if (pgid !== undefined) liveGroups.delete(pgid);
      };
      let settled = false;
      let timedOut = false; // the deadline passed while the command was still running
      let aborted = false; // killAll() stopped the command while it was still running
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let deadline: NodeJS.Timeout | null = null;
      const timers: NodeJS.Timeout[] = [];

      /** Signal the group; once nothing is left in it, stop tracking it. */
      const signal = (sig: NodeJS.Signals): boolean => {
        const delivered = signalGroup(child, sig);
        if (!delivered) forgetGroup();
        return delivered;
      };
      const abort = (): void => {
        if (!exit) aborted = true;
        signal('SIGKILL');
      };
      const finish = (status: CheckStatus, note: string): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        for (const t of timers) clearTimeout(t);
        this.running.delete(abort);
        done(this.result(name, command, status, started, output.value(), note));
      };
      const conclude = (): void => {
        if (timedOut) return finish('timeout', `timed out after ${Math.round(timeoutMs / 1000)}s; process group terminated`);
        if (aborted) return finish('error', 'killed by the supervisor');
        if (!exit) return finish('error', 'process ended without an exit status');
        if (exit.code === 0) return finish('passed', '');
        finish('failed', exit.signal ? `terminated by signal ${exit.signal}` : `exited with code ${exit.code}`);
      };
      const stopWaitingForOutput = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
        conclude();
      };
      this.running.add(abort);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (s: string) => output.push(s));
      child.stderr.on('data', (s: string) => output.push(s));
      // Errors on our end of the pipes (e.g. after destroy) must never crash the supervisor.
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});

      child.on('error', (err) => {
        // Spawn failures (ENOENT, EACCES) arrive here and never produce an exit event.
        if (child.pid === undefined) finish('error', `could not start ${command[0]}: ${err.message}`);
      });
      child.on('exit', (code, sig) => {
        exit = { code, signal: sig };
        // Exited in time: its status is the result, even if leftovers keep the pipes open past the deadline.
        if (deadline) {
          clearTimeout(deadline);
          deadline = null;
        }
        // Clean up anything the command left running in its group (servers, watchers).
        if (signal('SIGTERM')) {
          setTimeout(() => {
            signalGroup(child, 'SIGKILL');
            forgetGroup();
          }, KILL_GRACE_MS).unref(); // the exit hook covers a supervisor that exits sooner
        }
        // 'close' normally follows at once; a leftover holding stdout open must not hang us.
        timers.push(setTimeout(stopWaitingForOutput, STDIO_DRAIN_MS));
      });
      child.on('close', conclude);

      deadline = setTimeout(() => {
        deadline = null;
        if (exit || settled) return;
        timedOut = true;
        signal('SIGTERM');
        timers.push(setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS));
        // Last resort if even SIGKILL does not end it (e.g. uninterruptible sleep).
        timers.push(setTimeout(stopWaitingForOutput, KILL_GRACE_MS + 2000));
      }, timeoutMs);
    });
  }

  private result(name: string, command: string[], status: CheckStatus, started: number, raw: string, note: string): CheckResult {
    return { name, command, status, durationMs: Math.max(0, this.now() - started), outputTail: this.formatOutput(raw, note) };
  }

  private formatOutput(raw: string, note: string): string {
    let text = cleanTerminalOutput(raw);
    if (note) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}[autopilot] ${note}`;
    // Redact before cutting: a secret straddling the cut would no longer be recognizable.
    for (const v of this.secretValues) if (text.includes(v)) text = text.split(v).join('[redacted]');
    return tail(redactPartialKeys(redactSecrets(text)), this.maxOutput);
  }
}

// ------------------------------------------------------------------ helpers

/** Tracked files plus untracked files that are not ignored, NUL-separated. */
const LS_FILES_ARGS: readonly string[] = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];

/** The fingerprint recorded by the last successful setup, or null (missing, unreadable, older format). */
function markerFingerprint(marker: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    const fingerprint = typeof parsed === 'object' && parsed !== null ? (parsed as { fingerprint?: unknown }).fingerprint : undefined;
    return typeof fingerprint === 'string' ? fingerprint : null;
  } catch {
    return null;
  }
}

/** Content digest of one file. Symlinks are not followed (a link to /dev/zero must not hang us). */
function fileDigest(path: string): string {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (!st.isFile()) return 'not-a-file';
    if (st.size > MAX_HASHED_FILE_BYTES) return `size:${st.size}`;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

/** Keeps the last `keep` characters of a stream without unbounded memory. */
class TailBuffer {
  private text = '';
  private dropped = false;
  private readonly keep: number;

  constructor(keep: number) {
    this.keep = keep;
  }

  push(s: string): void {
    this.text += s;
    if (this.text.length > this.keep * 2) {
      this.text = this.text.slice(-this.keep);
      this.dropped = true;
    }
  }

  value(): string {
    if (!this.dropped && this.text.length <= this.keep) return this.text;
    const t = this.text.slice(-this.keep);
    // The kept window starts mid-token; drop that fragment so no partial secret survives.
    const ws = /\s/.exec(t);
    return ws ? t.slice(ws.index + 1) : '';
  }
}

const ANSI_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Strip colors and collapse carriage-return progress lines to what a terminal would show. */
function cleanTerminalOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPES, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r').filter((p) => p !== '');
      return parts.length > 0 ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

/** Private-key blocks cut by the output window (BEGIN or END marker missing). */
function redactPartialKeys(text: string): string {
  let out = text;
  const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(out);
  if (end) out = `[redacted private key]${out.slice(end.index + end[0].length)}`;
  const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(out);
  if (begin) out = `${out.slice(0, begin.index)}[redacted private key]`;
  return out;
}

function secretValuesOf(env: NodeJS.ProcessEnv): string[] {
  const stripped = new Set(STRIPPED_ENV_VARS);
  const values = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8) continue;
    if (stripped.has(k.toUpperCase()) || SECRET_ENV_NAME.test(k)) values.add(v);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function secondsToMs(seconds: number | undefined, fallback: number): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
  return Math.round(s * 1000);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
