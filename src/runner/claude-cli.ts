// SPDX-License-Identifier: MIT
// Runs Claude Code headless (`claude -p --output-format stream-json`) as a child process.
//
// - The prompt goes to stdin (a positional prompt would be swallowed by variadic flags such
//   as --allowedTools), then stdin is closed.
// - The MCP config carries the run's bearer token, so it is handed over as a private 0600
//   file (removed when the run ends) rather than inline JSON that `ps` would show.
// - Each run gets its own process group (detached). Claude Code 2.1.x spawns Bash commands and
//   hooks detached too (process groups of their own, per its bundled code), so while claude
//   runs the runner also traces its descendants with `ps` and stops their groups as well:
//   SIGTERM first, SIGKILL after killGraceMs. Whatever is left of the tree when claude exits
//   on its own is stopped the same way.
// - Every stdout line and stderr chunk is appended to spec.logPath; stdout is parsed into
//   RunEvents and the final result message is classified by ./stream.ts.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunEvent, RunHandle, RunOutcome, Runner, RunSpec } from '../types.ts';
import { tail } from '../util.ts';
import { classifyResult, newStreamState, observeMessage, parseStreamLine, toRunEvents } from './stream.ts';

/** Removed from the inherited environment when stripApiKeys is on (subscription auth). */
export const API_KEY_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // Cloud providers and profiles outrank the subscription login, so they go too.
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
];

/**
 * Always removed from the inherited environment: they belong to a parent Claude Code session
 * (e.g. when the supervisor itself was started from inside Claude Code) and would make the
 * worker think it is nested, talk to the parent's socket, inherit its effort, or run in bare
 * mode (CLAUDE_CODE_SIMPLE ignores OAuth). CLAUDE_CODE_OAUTH_TOKEN is deliberately kept.
 * spec.env is applied afterwards, so a run can still set any of these on purpose.
 */
export const NESTED_SESSION_ENV_VARS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_PID',
  // Also injected by a hosting Claude Code / desktop session (observed in 2.1.x):
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_HOST_SHORT_TEMP_DIRS',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
  'CLAUDE_EFFORT',
  'MCP_CONNECTION_NONBLOCKING',
];

export interface ClaudeCliRunnerOptions {
  claudeBin: string;
  /** Environment to start from; defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Remove ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so runs use the subscription login (default true). */
  stripApiKeys?: boolean;
  /** Time between SIGTERM and SIGKILL (default 5000 ms). */
  killGraceMs?: number;
  /**
   * After the result message, how long claude may stay silent without exiting before the
   * runner stops it (default 60000 ms). The outcome then still comes from that result, so a
   * finished run is not reported as a timeout because something kept the process alive.
   */
  postResultExitMs?: number;
  /** Clock used to interpret usage-limit reset times. */
  now?: () => number;
}

export interface ClaudeArgsOptions {
  /**
   * Pass the MCP config as this file (Claude Code accepts files or JSON strings) instead of
   * inline JSON, which would show the run's bearer token in the process list.
   */
  mcpConfigPath?: string | null;
}

/** CLI arguments for a run, one array element per value. The prompt is NOT included (stdin). */
export function buildClaudeArgs(spec: RunSpec, opts: ClaudeArgsOptions = {}): string[] {
  // --permission-prompts none: nobody is watching, so anything that would ask is denied
  // (and shows up in the result's permission_denials) instead of waiting.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', spec.permissionMode, '--permission-prompts', 'none'];
  // Claude Code refuses bypassPermissions unless bypass is explicitly allowed for the session.
  if (spec.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
  args.push('--max-turns', String(spec.maxTurns));
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
  else args.push('--session-id', spec.sessionId);
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  // --add-dir is variadic: one flag per directory. Relative paths are resolved against the run's
  // cwd (as claude would), so a name starting with "-" cannot be mistaken for a flag.
  for (const dir of spec.addDirs ?? []) {
    if (dir) args.push('--add-dir', isAbsolute(dir) ? dir : resolve(spec.cwd, dir));
  }
  for (const tool of spec.allowedTools) args.push('--allowedTools', tool);
  for (const tool of spec.disallowedTools) args.push('--disallowedTools', tool);
  if (spec.mcpConfig) args.push('--mcp-config', opts.mcpConfigPath || JSON.stringify(spec.mcpConfig), '--strict-mcp-config');
  if (spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.settings) args.push('--settings', JSON.stringify(spec.settings));
  if (spec.settingSources) args.push('--setting-sources', spec.settingSources.join(','));
  return args;
}

/**
 * Checks on the session's init message, before any model work:
 * - the run must not bill an API key or helper (it must use the subscription login);
 * - the autopilot MCP bridge must be connected, or the agent could not ask the founder.
 * Returns an error with a prefix the supervisor understands, or null.
 */
export function initGuardProblem(init: Record<string, unknown>, spec: Pick<RunSpec, 'mcpConfig'>): string | null {
  const source = init.apiKeySource;
  if (typeof source === 'string' && (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|apiKeyHelper)$/i.test(source) || /api.?key/i.test(source))) {
    return `auth: this run would bill ${source} instead of the Claude subscription; remove that credential from the environment or settings`;
  }
  const servers = (spec.mcpConfig as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  if (servers && 'autopilot' in servers) {
    const list = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
    const ours = list.find((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && (s as Record<string, unknown>).name === 'autopilot');
    if (!ours) return 'mcp: the autopilot tool bridge was not loaded';
    if (ours.status !== 'connected') return `mcp: the autopilot tool bridge did not connect (${String(ours.status)})`;
  }
  return null;
}

/** Child environment: base env minus auth/nesting variables, then spec.env on top. */
export function buildClaudeEnv(spec: RunSpec, baseEnv: NodeJS.ProcessEnv, stripApiKeys: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (stripApiKeys) for (const key of API_KEY_ENV_VARS) delete env[key];
  for (const key of NESTED_SESSION_ENV_VARS) delete env[key];
  for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = value;
  return env;
}

const FLAGS_WITH_VALUE = new Set([
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--max-turns',
  '--append-system-prompt',
  '--resume',
  '--session-id',
  '--model',
  '--effort',
  '--add-dir',
  '--allowedTools',
  '--disallowedTools',
  '--mcp-config',
  '--json-schema',
  '--settings',
  '--setting-sources',
]);
/** Values that may contain secrets (MCP bearer tokens) or are long are logged by size only. */
const OPAQUE_VALUE_FLAGS = new Set(['--append-system-prompt', '--mcp-config', '--json-schema', '--settings']);

/** Arguments rendered for the run log without leaking prompts or tokens. */
export function describeArgs(args: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    out.push(arg);
    if (FLAGS_WITH_VALUE.has(arg) && i + 1 < args.length) {
      const value = args[++i];
      out.push(OPAQUE_VALUE_FLAGS.has(arg) ? `<${value.length} chars>` : JSON.stringify(value));
    }
  }
  return out.join(' ');
}

export class ClaudeCliRunner implements Runner {
  private readonly settings: RunnerSettings;

  constructor(opts: ClaudeCliRunnerOptions) {
    this.settings = {
      claudeBin: opts.claudeBin,
      baseEnv: opts.baseEnv ?? process.env,
      stripApiKeys: opts.stripApiKeys ?? true,
      killGraceMs: opts.killGraceMs ?? 5000,
      postResultExitMs: opts.postResultExitMs ?? 60_000,
      now: opts.now ?? Date.now,
    };
  }

  start(spec: RunSpec, onEvent: (e: RunEvent) => void): RunHandle {
    const run = new CliRun(spec, onEvent, this.settings);
    return { runId: spec.runId, pid: run.pid, done: run.done, kill: (reason: string) => run.kill(reason) };
  }
}

// ------------------------------------------------------------------ internals

interface RunnerSettings {
  claudeBin: string;
  baseEnv: NodeJS.ProcessEnv;
  stripApiKeys: boolean;
  killGraceMs: number;
  postResultExitMs: number;
  now: () => number;
}

const STDERR_TAIL_MAX = 8_000;
/** A single stdout line larger than this is logged and dropped instead of buffered forever. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
/** After the process exits, wait this long for stdio to close (a grandchild may hold our pipes). */
const CLOSE_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for the process group to disappear before resolving anyway. */
const KILL_WAIT_MS = 2_000;
/** Upper bound for one `ps` listing used to trace claude's descendants. */
const PS_TIMEOUT_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Timer delay for a configured limit; null when the limit is disabled (<= 0, NaN, Infinity). */
function timerDelay(ms: number): number | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(Math.max(1, Math.round(ms)), MAX_TIMER_MS);
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : Number(s.toFixed(2))}s`;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Signal a process group (on Windows: the process); false if it could not be signalled. */
function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Whether a process group still has a member (a process we may not signal counts as alive). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Process groups that descendants of rootPid run in, other than rootPid's own group and ours,
 * from `ps -A -o pid=,ppid=,pgid=` output. Claude Code spawns Bash commands and hooks detached
 * (in groups of their own), so signalling claude's group alone would not reach them.
 */
export function descendantGroups(psOutput: string, rootPid: number, selfPid: number = process.pid): number[] {
  const children = new Map<number, number[]>();
  const groupOf = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    groupOf.set(pid, Number(m[3]));
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  const ownGroup = groupOf.get(selfPid);
  const groups = new Set<number>();
  const seen = new Set<number>([rootPid]);
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    if (seen.has(pid)) continue; // a malformed table must not loop forever
    seen.add(pid);
    const pgid = groupOf.get(pid);
    if (pgid !== undefined && pgid > 1 && pgid !== rootPid && pgid !== ownGroup) groups.add(pgid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...groups];
}

/** The process table as `ps -A -o pid=,ppid=,pgid=` prints it (POSIX). */
function listProcesses(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid='],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } },
      (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
    );
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Append-only run log. Logging problems never fail a run. */
class RunLog {
  private stream: WriteStream | null = null;
  private broken = false;

  constructor(path: string, onError: (message: string) => void) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.stream = createWriteStream(path, { flags: 'a' });
      this.stream.on('error', (err) => {
        if (!this.broken) onError(`run log unavailable: ${err.message}`);
        this.broken = true;
      });
    } catch (err) {
      this.broken = true;
      onError(`run log unavailable: ${errorMessage(err)}`);
    }
  }

  write(text: string): void {
    if (this.stream && !this.broken) this.stream.write(text);
  }

  /** Flush and close; resolves even if the file could not be written. */
  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return Promise.resolve();
    if (this.broken || stream.destroyed) {
      stream.destroy();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const fallback = setTimeout(resolve, 2_000);
      const done = (): void => {
        clearTimeout(fallback);
        resolve();
      };
      stream.once('close', done);
      stream.once('error', done);
      stream.end();
    });
  }
}

/** One spawned `claude -p` process and everything needed to settle its outcome exactly once. */
class CliRun {
  readonly done: Promise<RunOutcome>;
  readonly pid: number | null;

  private readonly spec: RunSpec;
  private readonly onEvent: (e: RunEvent) => void;
  private readonly settings: RunnerSettings;
  private readonly stream = newStreamState();
  private readonly log: RunLog;
  private resolveDone: (outcome: RunOutcome) => void = () => {};
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private stderrBuf = '';
  private stderrTail = '';
  private spawned = false;
  private spawnError: string | null = null;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  /** Why the runner stopped the process itself (kill or timeout); wins over the classification. */
  private stopReason: { status: 'killed' | 'timeout' | 'failed'; error: string } | null = null;
  /** The stop sequence (see stopTree) once one has started; finish() waits for it. */
  private stopping: Promise<void> | null = null;
  /** Process groups that claude's tool commands run in, traced while claude runs. */
  private readonly toolGroups = new Set<number>();
  /** Settles once every trace started so far has. */
  private tracing: Promise<void> = Promise.resolve();
  /** Private temp dir for files others must not read (the MCP config); removed by finish(). */
  private privateDir: string | null = null;
  private finishing = false;
  private settled = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Refreshed on every chunk of output, so kept outside `timers`. */
  private idleTimer: NodeJS.Timeout | null = null;
  private postResultTimer: NodeJS.Timeout | null = null;

  constructor(spec: RunSpec, onEvent: (e: RunEvent) => void, settings: RunnerSettings) {
    this.spec = spec;
    this.onEvent = onEvent;
    this.settings = settings;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    // Events are never delivered synchronously from start(), so listeners can use the handle.
    this.log = new RunLog(spec.logPath, (message) => queueMicrotask(() => this.emit({ type: 'activity', summary: message })));
    this.child = this.launch();
    this.pid = this.child?.pid ?? null;
  }

  kill(reason: string): void {
    if (this.settled || this.finishing) return;
    // A timeout that is already stopping the process keeps its status. A kill that comes after
    // the result message still wins: the caller wants the run to count as stopped.
    if (!this.stopReason) this.stopReason = { status: 'killed', error: reason || 'killed' };
    this.terminate(this.stopReason.error);
  }

  // ------------------------------------------------------------- lifecycle

  private launch(): ChildProcess | null {
    const { spec, settings } = this;
    this.log.write(`[autopilot] run ${spec.runId} (${spec.role}) start ${new Date(settings.now()).toISOString()} cwd=${spec.cwd}\n`);
    if (!isDirectory(spec.cwd)) {
      this.failToSpawn(`working directory does not exist: ${spec.cwd}`);
      return null;
    }
    let mcpConfigPath: string | null = null;
    if (spec.mcpConfig) {
      try {
        mcpConfigPath = this.writePrivateFile('mcp-config.json', JSON.stringify(spec.mcpConfig));
      } catch (err) {
        this.failToSpawn(`could not write the MCP config: ${errorMessage(err)}`);
        return null;
      }
    }
    const args = buildClaudeArgs(spec, { mcpConfigPath });
    this.log.write(`[autopilot] ${settings.claudeBin} ${describeArgs(args)}\n`);
    let child: ChildProcess;
    try {
      child = spawn(settings.claudeBin, args, {
        cwd: spec.cwd,
        env: buildClaudeEnv(spec, settings.baseEnv, settings.stripApiKeys),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group, so the whole tree can be signalled via process.kill(-pid).
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      this.failToSpawn(errorMessage(err));
      return null;
    }

    child.once('spawn', () => {
      this.spawned = true;
      if (child.pid !== undefined) this.emit({ type: 'started', pid: child.pid });
    });
    child.on('error', (err) => {
      if (!this.spawned && !this.exited) this.failToSpawn(err.message);
      else this.log.write(`[autopilot] child process error: ${err.message}\n`);
    });
    child.on('exit', (code, signal) => {
      this.recordExit(code, signal);
      // stdio normally closes right away; stop waiting if a straggler keeps our pipes open.
      this.addTimer(CLOSE_GRACE_MS, () => void this.finish(true));
    });
    child.on('close', (code, signal) => {
      this.recordExit(code, signal);
      void this.finish(false);
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stdout?.on('error', () => {});
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
    child.stderr?.on('error', () => {});
    // The prompt is delivered on stdin, then stdin is closed (EPIPE is fine if claude died).
    child.stdin?.on('error', () => {});
    child.stdin?.end(spec.prompt);

    const total = timerDelay(spec.timeoutMs);
    if (total !== null) this.addTimer(total, () => this.timeout(`timeout: exceeded ${formatSeconds(spec.timeoutMs)}`));
    const idle = timerDelay(spec.idleTimeoutMs);
    if (idle !== null) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.timeout(`timeout: no output for ${formatSeconds(spec.idleTimeoutMs)}`);
      }, idle);
    }
    return child;
  }

  /** Write a file only this user can read, inside a private temp dir that finish() removes. */
  private writePrivateFile(name: string, content: string): string {
    this.privateDir ??= mkdtempSync(join(tmpdir(), 'autopilot-run-'));
    const file = join(this.privateDir, name);
    writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    return file;
  }

  private removePrivateDir(): void {
    if (this.privateDir === null) return;
    try {
      rmSync(this.privateDir, { recursive: true, force: true });
    } catch {
      // Best effort: it only holds this run's token, which stops working when the run ends.
    }
    this.privateDir = null;
  }

  private failToSpawn(message: string): void {
    if (this.spawnError === null) this.spawnError = message;
    void this.finish(false);
  }

  private recordExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
  }

  private timeout(error: string): void {
    if (this.settled || this.finishing || this.stopReason) return;
    if (this.stream.result !== null) {
      // The result message is in, so the outcome is already decided and only the process is
      // late to exit: stop it without letting the timeout replace the result.
      this.log.write(`[autopilot] ${error} after the result message; keeping the result\n`);
      this.terminate(`${error} after the result message`);
      return;
    }
    this.stopReason = { status: 'timeout', error };
    this.terminate(error);
  }

  /**
   * The result is in, so the outcome is decided; if claude then stays silent without exiting
   * (e.g. a lingering MCP server or background shell), stop it instead of waiting for the idle
   * timeout. No stopReason is set, so the outcome is still classified from the result.
   */
  private armPostResultTimer(): void {
    if (this.finishing) return;
    if (this.postResultTimer) {
      this.postResultTimer.refresh();
      return;
    }
    const wait = timerDelay(this.settings.postResultExitMs);
    if (wait === null) return;
    this.postResultTimer = setTimeout(() => {
      this.postResultTimer = null;
      if (this.finishing || this.stopReason) return;
      this.terminate(`still running ${formatSeconds(this.settings.postResultExitMs)} after its result message`);
    }, wait);
  }

  /** Start stopping the run's process tree (once); finish() waits for it to be gone. */
  private terminate(why: string): void {
    if (this.stopping !== null) return;
    const pid = this.child?.pid;
    if (pid === undefined) return; // never started; finish() is driven by the spawn error
    this.stopping = this.stopTree(pid, why);
    // Last resort if the process never reports exit (e.g. stuck in uninterruptible I/O).
    const bound = Math.max(0, this.settings.killGraceMs) + KILL_WAIT_MS + CLOSE_GRACE_MS + 2 * PS_TIMEOUT_MS;
    this.addTimer(bound, () => void this.finish(true));
  }

  /**
   * SIGTERM the run's process tree (claude's group plus the groups its tool commands run in),
   * SIGKILL whatever survives killGraceMs, and resolve once the tree is gone (or KILL_WAIT_MS
   * after SIGKILL). Never rejects.
   */
  private async stopTree(pid: number, why: string): Promise<void> {
    try {
      this.log.write(`[autopilot] stopping process group ${pid}: ${why}\n`);
      // Trace before signalling: once claude has exited, its tool processes can no longer be
      // traced back to it.
      await this.traceToolGroups();
      if (this.toolGroups.size > 0) this.log.write(`[autopilot] also stopping tool process groups ${[...this.toolGroups].join(', ')}\n`);
      this.signalTree(pid, 'SIGTERM');
      if (await this.waitForTreeExit(pid, Math.max(0, this.settings.killGraceMs))) return;
      await this.traceToolGroups(); // claude may still be running (ignoring SIGTERM)
      this.log.write(`[autopilot] process group ${pid} survived SIGTERM, sending SIGKILL\n`);
      this.signalTree(pid, 'SIGKILL');
      await this.waitForTreeExit(pid, KILL_WAIT_MS);
    } catch (err) {
      this.log.write(`[autopilot] could not stop process group ${pid}: ${errorMessage(err)}\n`);
    }
  }

  /**
   * Record the process groups of claude's descendants (see descendantGroups). Only possible
   * while claude runs: when it exits, its children are re-parented and lose the link to it.
   */
  private traceToolGroups(): Promise<void> {
    const pid = this.child?.pid;
    if (pid === undefined || this.exited || process.platform === 'win32') return this.tracing;
    const trace = listProcesses().then(
      (table) => {
        for (const group of descendantGroups(table, pid)) this.toolGroups.add(group);
      },
      (err: unknown) => this.log.write(`[autopilot] could not list processes: ${errorMessage(err)}\n`),
    );
    this.tracing = Promise.all([this.tracing, trace]).then(() => undefined);
    return this.tracing;
  }

  private signalTree(pid: number, signal: NodeJS.Signals): void {
    if (!signalGroup(pid, signal)) {
      try {
        process.kill(pid, signal); // not a group leader after all
      } catch {
        // Already gone.
      }
    }
    for (const group of this.toolGroups) signalGroup(group, signal);
  }

  /** Whether anything of the run's process tree is left. Forgets tool groups that are gone. */
  private treeAlive(pid: number): boolean {
    for (const group of this.toolGroups) if (!groupAlive(group)) this.toolGroups.delete(group);
    return groupAlive(pid) || this.toolGroups.size > 0;
  }

  /** Poll until the run's process tree is gone; false if something is still there after ms. */
  private async waitForTreeExit(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.treeAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await delay(20);
    }
    return true;
  }

  /**
   * Make sure no process of the run outlives it. When claude exited on its own, whatever it
   * left behind (background commands, a stuck helper, an MCP server) is stopped now; process
   * group ids cannot be reused while the group exists, so this never hits a stranger.
   */
  private async reapTree(): Promise<void> {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    await this.tracing; // e.g. the trace taken when the result message arrived
    if (this.stopping === null && this.treeAlive(pid)) this.stopping = this.stopTree(pid, 'leftover processes after claude exited');
    await this.stopping;
  }

  private async finish(force: boolean): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.postResultTimer) clearTimeout(this.postResultTimer);
    this.idleTimer = null;
    this.postResultTimer = null;

    let outcome: RunOutcome;
    try {
      if (force) {
        this.child?.stdout?.destroy();
        this.child?.stderr?.destroy();
      }
      if (this.stdoutBuf) {
        const rest = this.stdoutBuf;
        this.stdoutBuf = '';
        this.handleLine(rest);
      }
      if (this.stderrBuf) {
        this.log.write(`[stderr] ${this.stderrBuf}\n`);
        this.stderrBuf = '';
      }
      outcome = this.buildOutcome();
    } catch (err) {
      outcome = failedOutcome(`runner: ${errorMessage(err)}`, this.exitCode);
    }

    try {
      // Resolve only once the whole tree is gone, whether we stopped it or claude exited.
      await this.reapTree();
      const signal = this.exitSignal ? ` signal=${this.exitSignal}` : '';
      this.log.write(
        `[autopilot] run ${this.spec.runId} end status=${outcome.status} exit=${outcome.exitCode ?? '-'}${signal}` +
          `${outcome.error ? ` error=${outcome.error}` : ''}\n`,
      );
      await this.log.close();
    } finally {
      this.removePrivateDir();
      this.settled = true;
      this.resolveDone(outcome);
    }
  }

  private buildOutcome(): RunOutcome {
    const stop = this.stopReason;
    if (this.spawnError !== null && !this.spawned) {
      const outcome = failedOutcome(`spawn: ${this.spawnError}`, null);
      return stop ? { ...outcome, status: stop.status, error: stop.error } : outcome;
    }
    const result = this.stream.result;
    const classified = classifyResult(result, this.exitCode, this.stderrTail, this.settings.now(), {
      ...this.stream,
      signal: this.exitSignal,
    });
    const resultSession = typeof result?.session_id === 'string' && result.session_id ? result.session_id : null;
    const outcome: RunOutcome = { ...classified, exitCode: this.exitCode, sessionId: resultSession ?? this.stream.sessionId };
    if (!stop) return outcome;
    return { ...outcome, status: stop.status, error: stop.error, isError: true, usageResetAt: null };
  }

  // ---------------------------------------------------------------- output

  private onStdout(chunk: string): void {
    this.idleTimer?.refresh();
    this.postResultTimer?.refresh();
    this.stdoutBuf += chunk;
    if (!chunk.includes('\n')) {
      if (this.stdoutBuf.length > MAX_LINE_CHARS) {
        this.log.write(`${this.stdoutBuf}\n`);
        this.stdoutBuf = '';
      }
      return;
    }
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    this.log.write(`${line}\n`);
    try {
      const msg = parseStreamLine(line);
      if (msg === null) return;
      observeMessage(this.stream, msg);
      for (const event of toRunEvents(msg)) this.emit(event);
      if (msg.type === 'system' && msg.subtype === 'init' && !this.stopReason) {
        const problem = initGuardProblem(msg as Record<string, unknown>, this.spec);
        if (problem) {
          // Stop before any model work: wrong billing or no tool bridge means the run cannot be trusted.
          this.log.write(`[autopilot] stopping: ${problem}\n`);
          this.stopReason = { status: 'failed', error: problem };
          this.terminate(problem);
        }
      }
      if (msg.type === 'result') {
        // While claude is still up, note what it has running in other process groups, so
        // anything it leaves behind can be stopped after it exits.
        void this.traceToolGroups();
        this.armPostResultTimer();
      }
    } catch (err) {
      this.log.write(`[autopilot] could not process stream line: ${errorMessage(err)}\n`);
    }
  }

  private onStderr(chunk: string): void {
    this.idleTimer?.refresh();
    this.postResultTimer?.refresh();
    this.stderrTail = tail(this.stderrTail + chunk, STDERR_TAIL_MAX);
    const lines = (this.stderrBuf + chunk).split('\n');
    this.stderrBuf = lines.pop() ?? '';
    for (const line of lines) this.log.write(`[stderr] ${line}\n`);
  }

  private emit(event: RunEvent): void {
    if (this.settled) return;
    try {
      this.onEvent(event);
    } catch (err) {
      this.log.write(`[autopilot] event listener threw: ${errorMessage(err)}\n`);
    }
  }

  /** One-shot timer that finish() clears; ignored once the run is finishing. */
  private addTimer(ms: number, fn: () => void): void {
    if (this.finishing) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
}

function failedOutcome(error: string, exitCode: number | null): RunOutcome {
  return {
    status: 'failed',
    sessionId: null,
    structuredOutput: null,
    resultText: null,
    isError: true,
    terminalReason: null,
    usageResetAt: null,
    costUsd: null,
    numTurns: null,
    exitCode,
    error,
  };
}
