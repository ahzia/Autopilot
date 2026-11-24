// SPDX-License-Identifier: MIT
// In-process stand-in for ClaudeCliRunner, for tests and drills. A behavior is a plain async
// function that can emit events, sleep (abortably), run git and write files in spec.cwd, and
// returns the parts of the RunOutcome it cares about; everything else gets sensible defaults.
//
// Like the real runner, kill() resolves `done` only once the run has stopped: the signal
// aborts sleep, git and writeFile (so a killed fake cannot touch the worktree any more), and a
// behavior that ignores it is given up on after killGraceMs.

import { execFile } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunEvent, RunHandle, RunOutcome, Runner, RunSpec } from '../types.ts';

/**
 * Pid reported in the 'started' event. Deliberately above every OS pid limit so that
 * process.kill(pid) or process.kill(-pid) fails with ESRCH; 0 would signal our own group.
 */
export const FAKE_PID = 2_147_483_647;

export interface FakeControl {
  spec: RunSpec;
  emit(e: RunEvent): void;
  /** Resolves after ms; rejects (AbortError) when the run is killed. */
  sleep(ms: number): Promise<void>;
  /** Aborted when the run is killed. */
  signal: AbortSignal;
  /** Runs git in spec.cwd and returns stdout; throws on a non-zero exit, and (AbortError) once killed. */
  git(args: string[]): Promise<string>;
  /**
   * Writes a file inside spec.cwd (parent directories are created). Paths escaping cwd, also
   * through symlinks, throw; so does any call once the run is killed (AbortError).
   */
  writeFile(relPath: string, content: string): void;
}

export interface FakeRunnerOptions {
  /** After kill(), how long to wait for the behavior to wind down before resolving anyway (default 2000 ms). */
  killGraceMs?: number;
}

export type FakeBehavior = (ctl: FakeControl) => Promise<Partial<RunOutcome>>;
export type FakeBehaviorFactory = (spec: RunSpec) => FakeBehavior;

/**
 * What FakeRunner accepts: a FakeBehavior, or a FakeBehaviorFactory that picks the behavior
 * per spec (both types are assignable to this). It is spelled as one signature so inline
 * lambdas get typed parameters; the argument really is both a FakeControl and a RunSpec.
 */
export type FakeBehaviorSource = (ctlOrSpec: FakeControl & RunSpec) => Promise<Partial<RunOutcome>> | FakeBehavior;

export class FakeRunner implements Runner {
  /** Every spec passed to start(), in order (handy for assertions in drills). */
  readonly started: RunSpec[] = [];
  private readonly behavior: FakeBehaviorSource;
  private readonly killGraceMs: number;

  /** Accepts a FakeBehavior or a FakeBehaviorFactory (see FakeBehaviorSource). */
  constructor(behavior: FakeBehaviorSource, opts: FakeRunnerOptions = {}) {
    this.behavior = behavior;
    this.killGraceMs = Math.max(0, opts.killGraceMs ?? 2000);
  }

  start(spec: RunSpec, onEvent: (e: RunEvent) => void): RunHandle {
    this.started.push(spec);
    const controller = new AbortController();
    const { signal } = controller;
    const sessionId = spec.resumeSessionId || spec.sessionId;
    let running = false;
    let settled = false;
    let killReason: string | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let resolveDone: (outcome: RunOutcome) => void = () => {};
    const done = new Promise<RunOutcome>((resolveFn) => {
      resolveDone = resolveFn;
    });
    /** Resolve done once; after a kill the status is 'killed' whatever the behavior returned. */
    const settle = (partial: Partial<RunOutcome>): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolveDone(fakeOutcome(killReason !== null ? { status: 'killed', error: killReason } : partial, sessionId));
    };
    const emit = (event: RunEvent): void => {
      if (settled) return;
      try {
        onEvent(event);
      } catch {
        // A throwing listener must not break the run (same as the real runner).
      }
    };
    const ctl: FakeControl = {
      spec,
      emit,
      sleep: (ms) => delay(ms, undefined, { signal }),
      signal,
      git: (args) => (signal.aborted ? Promise.reject(abortError(signal)) : runGit(spec.cwd, args, signal)),
      writeFile: (relPath, content) => {
        if (signal.aborted) throw abortError(signal);
        writeInside(spec.cwd, relPath, content);
      },
    };

    // Start asynchronously, like a real process: the caller has the handle before any event.
    setImmediate(() => {
      if (settled || killReason !== null) return;
      running = true;
      emit({ type: 'started', pid: FAKE_PID });
      emit({ type: 'session', sessionId });
      runBehavior(this.behavior, ctl).then(
        (partial) => settle(partial),
        (err: unknown) => settle({ status: 'failed', error: err instanceof Error ? err.message : String(err) }),
      );
    });

    return {
      runId: spec.runId,
      pid: null,
      done,
      kill: (reason: string) => {
        if (settled || killReason !== null) return;
        killReason = reason;
        controller.abort(new Error(reason));
        if (!running) {
          settle({}); // killed before it started
          return;
        }
        // Resolve when the behavior has wound down (it settles the run), or give up on one
        // that ignores the signal, as the real runner gives up after SIGKILL.
        graceTimer = setTimeout(() => settle({}), this.killGraceMs);
      },
    };
  }
}

/**
 * Write, stage and commit one file in the run's worktree; returns the new commit sha.
 * Identity, signing and hooks are pinned so commits work on any machine.
 */
export async function commitFile(ctl: FakeControl, path: string, content: string, message: string): Promise<string> {
  ctl.writeFile(path, content);
  await ctl.git(['add', '--', path]);
  await ctl.git([
    '-c',
    'user.name=Fake',
    '-c',
    'user.email=fake@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    message,
    '--',
    path,
  ]);
  return (await ctl.git(['rev-parse', 'HEAD'])).trim();
}

/**
 * The constructor accepts a behavior or a per-spec factory. Both are one-argument functions
 * and cannot be told apart up front, so the function is called with an object that is both a
 * FakeControl and a RunSpec: a behavior returns a promise of its outcome, a factory returns
 * the behavior to run.
 */
async function runBehavior(fn: FakeBehaviorSource, ctl: FakeControl): Promise<Partial<RunOutcome>> {
  const probe: FakeControl & RunSpec = { ...ctl.spec, ...ctl };
  const call = (f: unknown): unknown => (f as (arg: FakeControl & RunSpec) => unknown)(probe);
  let value: unknown = call(fn);
  if (typeof value === 'function') value = call(value);
  value = await value;
  if (typeof value === 'function') value = await call(value); // tolerate async factories
  return (value ?? {}) as Partial<RunOutcome>;
}

function fakeOutcome(partial: Partial<RunOutcome>, sessionId: string): RunOutcome {
  const status = partial.status ?? 'succeeded';
  const defaultExit = status === 'succeeded' ? 0 : status === 'killed' || status === 'timeout' ? null : 1;
  return {
    status,
    sessionId: partial.sessionId !== undefined ? partial.sessionId : sessionId,
    structuredOutput: partial.structuredOutput ?? null,
    resultText: partial.resultText ?? null,
    isError: partial.isError ?? status !== 'succeeded',
    terminalReason: partial.terminalReason ?? null,
    usageResetAt: partial.usageResetAt ?? null,
    costUsd: partial.costUsd ?? null,
    numTurns: partial.numTurns ?? null,
    exitCode: partial.exitCode !== undefined ? partial.exitCode : defaultExit,
    error: partial.error ?? null,
  };
}

/** What sleep, git and writeFile throw once the run is killed (like timers/promises' AbortError). */
function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error('The run was killed', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' });
}

function runGit(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Never let an outer git context (e.g. running inside a hook) redirect these commands.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[key];
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, env, signal, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && signal.aborted) reject(abortError(signal));
      else if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      else resolvePromise(stdout);
    });
  });
}

/** Absolute path for relPath inside root; throws when it is absolute or climbs out of root. */
export function resolveInside(root: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath)) throw new Error(`writeFile: path must be relative to the run cwd: ${relPath}`);
  const abs = resolve(root, relPath);
  const rel = relative(resolve(root), abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`writeFile: path escapes the run cwd: ${relPath}`);
  }
  return abs;
}

/** Whether a directory entry exists at path; unlike existsSync, a dangling symlink counts. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeInside(root: string, relPath: string, content: string): void {
  const abs = resolveInside(root, relPath);
  // Symlinks inside the worktree could still lead outside it: check the real location of the
  // deepest existing entry on the way (the file itself or an ancestor) before creating anything.
  // A dangling symlink is an existing entry whose real location cannot be resolved: refused.
  let probe = abs;
  while (!entryExists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const realRoot = realpathSync(root);
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    throw new Error(`writeFile: cannot resolve where ${relPath} leads (dangling symlink?)`);
  }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
    throw new Error(`writeFile: path escapes the run cwd: ${relPath}`);
  }
  if (probe === abs && lstatSync(abs).isSymbolicLink()) {
    throw new Error(`writeFile: refusing to write through a symlink: ${relPath}`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  // O_NOFOLLOW: never follow a symlink at the target, even one that appeared after the checks.
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o666);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
