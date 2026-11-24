// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { plainHttpWarning } from '../bin/autopilot.ts';

const CLI = resolve(import.meta.dirname, '..', 'bin', 'autopilot.ts');

interface RunOutput {
  child: ChildProcess;
  /** Resolves when it serves (it printed its inbox address) or when it exits first. */
  ready: Promise<{ started: boolean; port: number }>;
  exited: Promise<number | null>;
  stdout: () => string;
  stderr: () => string;
}

/**
 * Start `autopilot run` with its output collected: through `cli` (the CLI by default, or a link to
 * it), in `cwd`; `stopAtBanner` sends SIGTERM the moment it says it runs.
 */
function spawnRun(args: string[], env: NodeJS.ProcessEnv = {}, { stopAtBanner = false, cli = CLI, cwd }: { stopAtBanner?: boolean; cli?: string; cwd?: string } = {}): RunOutput {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'run', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const ready = new Promise<{ started: boolean; port: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`run neither started nor exited:\n${out}${err}`));
    }, 20_000);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      out += d;
      const port = /Inbox: +http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1];
      if (port && out.includes('Press Ctrl-C')) {
        if (stopAtBanner) child.kill('SIGTERM');
        clearTimeout(timer);
        resolve({ started: true, port: Number(port) });
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      resolve({ started: false, port: 0 });
    });
  });
  return { child, ready, exited, stdout: () => out, stderr: () => err };
}

/** SIGTERM, as a terminal or the LaunchAgent sends it; resolves with the exit code. */
function stop(run: RunOutput): Promise<number | null> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
  return run.exited;
}

const lockOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { pid: number; startedAt: string; startedAfterInit?: number | null; bootId?: string | null };

test('a second autopilot run on the same home stops at once and leaves the first one running', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-run-'));
  const home = join(tmp, 'home');
  const lock = join(home, 'supervisor.lock');
  const runs: RunOutput[] = [];
  try {
    const first = spawnRun(['--home', home, '--port', '0']);
    runs.push(first);
    const { started, port } = await first.ready;
    assert.ok(started, first.stderr());

    // Another port, same home: it must not start a second supervisor.
    const second = spawnRun(['--home', home, '--port', '0']);
    runs.push(second);
    assert.equal((await second.ready).started, false, 'a second supervisor started on the same home');
    assert.equal(await second.exited, 1, second.stderr());
    assert.equal(second.stderr(), `autopilot: another autopilot run is using ${home} (pid ${first.child.pid}); stop it first, or delete ${lock} if it is stale\n`);
    assert.equal(second.stdout(), '');

    // The first one still serves and holds the lock, with its pid and start time.
    const res = await fetch(`http://127.0.0.1:${port}/api/me`);
    assert.ok(res.ok || res.status === 401, `inbox answered ${res.status}`);
    assert.equal(first.child.exitCode, null);
    assert.equal(lockOf(lock).pid, first.child.pid);
    assert.ok(Date.parse(lockOf(lock).startedAt) > 0);

    // A normal stop removes the lock.
    assert.equal(await stop(first), 0, first.stderr());
    assert.equal(existsSync(lock), false);
    // Served on 127.0.0.1 only: no plain-HTTP warning.
    assert.doesNotMatch(first.stderr(), /plain HTTP/);
  } finally {
    await Promise.all(runs.map(stop));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a run started through a link with another name keeps the home to itself', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-run-'));
  const home = join(tmp, 'home');
  const lock = join(home, 'supervisor.lock');
  // As after `ln -s .../bin/autopilot.ts ~/bin/ap` and `ap run`: its command line does not say autopilot.
  const ap = join(tmp, 'ap');
  symlinkSync(CLI, ap);
  const runs: RunOutput[] = [];
  try {
    const first = spawnRun(['--home', home, '--port', '0'], {}, { cli: ap });
    runs.push(first);
    assert.ok((await first.ready).started, first.stderr());

    const second = spawnRun(['--home', home, '--port', '0']);
    runs.push(second);
    assert.equal((await second.ready).started, false, 'a second supervisor started on the same home');
    assert.equal(await second.exited, 1, second.stderr());
    assert.equal(second.stderr(), `autopilot: another autopilot run is using ${home} (pid ${first.child.pid}); stop it first, or delete ${lock} if it is stale\n`);
    assert.equal(first.child.exitCode, null);
    assert.equal(lockOf(lock).pid, first.child.pid);

    // A lock without a start time (ps could not tell when the run started): the launch path still names the run.
    writeFileSync(lock, `${JSON.stringify({ ...lockOf(lock), startedAfterInit: null })}\n`);
    const third = spawnRun(['--home', home, '--port', '0']);
    runs.push(third);
    assert.equal((await third.ready).started, false, 'a second supervisor started on the same home');
    assert.equal(await third.exited, 1, third.stderr());
    assert.equal(lockOf(lock).pid, first.child.pid);
  } finally {
    await Promise.all(runs.map(stop));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a run is known by its start time, whatever its command line shows', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-run-'));
  const home = join(tmp, 'home');
  const lock = join(home, 'supervisor.lock');
  symlinkSync(CLI, join(tmp, 'ap'));
  const runs: RunOutput[] = [];
  try {
    // `./ap run`: its command line shows neither autopilot nor the full path of the link.
    const first = spawnRun(['--home', home, '--port', '0'], {}, { cli: './ap', cwd: tmp });
    runs.push(first);
    assert.ok((await first.ready).started, first.stderr());

    const second = spawnRun(['--home', home, '--port', '0']);
    runs.push(second);
    assert.equal((await second.ready).started, false, 'a second supervisor started on the same home');
    assert.equal(await second.exited, 1, second.stderr());
    assert.equal(second.stderr(), `autopilot: another autopilot run is using ${home} (pid ${first.child.pid}); stop it first, or delete ${lock} if it is stale\n`);
    assert.equal(lockOf(lock).pid, first.child.pid);
  } finally {
    await Promise.all(runs.map(stop));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a lock whose pid now belongs to a process that started later is replaced', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-run-'));
  const home = join(tmp, '.stayon-autopilot');
  const lock = join(home, 'supervisor.lock');
  const log = join(home, 'logs', 'supervisor.log');
  const runs: RunOutput[] = [];
  let tail: ChildProcess | undefined;
  try {
    // A run that is killed, so that its lock stays behind.
    const killed = spawnRun(['--home', home, '--port', '0']);
    runs.push(killed);
    assert.ok((await killed.ready).started, killed.stderr());
    killed.child.kill('SIGKILL');
    await killed.exited;
    const left = lockOf(lock);
    if (left.startedAfterInit === null) return t.skip('ps cannot tell when processes started here');
    // An hour later, its pid belongs to a process whose command line says autopilot as well.
    mkdirSync(join(home, 'logs'));
    writeFileSync(log, '');
    tail = spawn('tail', ['-f', log], { stdio: 'ignore' });
    const anHourEarlier = { startedAt: new Date(Date.parse(left.startedAt) - 3_600_000).toISOString(), startedAfterInit: (left.startedAfterInit ?? NaN) - 3600 };
    writeFileSync(lock, `${JSON.stringify({ ...left, ...anHourEarlier, pid: tail.pid })}\n`);

    // Without ps to tell when it started, the live pid still counts as another run.
    const noPs = spawnRun(['--home', home, '--port', '0'], { PATH: join(tmp, 'no-such-dir') });
    runs.push(noPs);
    assert.equal((await noPs.ready).started, false, 'it started although the lock holder may be a run');
    assert.equal(await noPs.exited, 1, noPs.stderr());
    assert.equal(lockOf(lock).pid, tail.pid);

    const next = spawnRun(['--home', home, '--port', '0']);
    runs.push(next);
    assert.ok((await next.ready).started, next.stderr());
    assert.equal(lockOf(lock).pid, next.child.pid);
    assert.equal(tail.exitCode, null);
    assert.equal(await stop(next), 0, next.stderr());
    assert.equal(existsSync(lock), false);
  } finally {
    tail?.kill();
    await Promise.all(runs.map(stop));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a lock from an earlier boot is replaced, whatever process has its pid now', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-run-'));
  const home = join(tmp, '.stayon-autopilot');
  const lock = join(home, 'supervisor.lock');
  const log = join(home, 'logs', 'supervisor.log');
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(log, '');
  // After a restart, the pid in a lock that a run left behind (power loss) can belong to a process that
  // started as long after boot as the run had, such as `tail -f ~/.stayon-autopilot/logs/supervisor.log`.
  const tail = spawn('tail', ['-f', log], { stdio: 'ignore' });
  const runs: RunOutput[] = [];
  try {
    // A run started together with tail, then killed: its lock holds tail's time after boot as well.
    const killed = spawnRun(['--home', home, '--port', '0']);
    runs.push(killed);
    assert.ok((await killed.ready).started, killed.stderr());
    killed.child.kill('SIGKILL');
    await killed.exited;
    const left = { ...lockOf(lock), pid: tail.pid };
    assert.equal(typeof left.bootId, 'string', 'the lock names the boot it was written in (macOS and Linux have boot ids)');

    // Written in this boot, the lock still counts: its pid runs and started when the run did.
    writeFileSync(lock, `${JSON.stringify(left)}\n`);
    const sameBoot = spawnRun(['--home', home, '--port', '0']);
    runs.push(sameBoot);
    assert.equal((await sameBoot.ready).started, false, 'it started although the lock holder may be the run');
    assert.equal(await sameBoot.exited, 1, sameBoot.stderr());
    assert.equal(lockOf(lock).pid, tail.pid);

    // Written in another boot, it is stale: no process outlives a boot.
    writeFileSync(lock, `${JSON.stringify({ ...left, bootId: '5f0c3a3e-0d1b-4c1e-9a77-2b8e6f1d4c90' })}\n`);
    const next = spawnRun(['--home', home, '--port', '0']);
    runs.push(next);
    assert.ok((await next.ready).started, next.stderr());
    assert.equal(lockOf(lock).pid, next.child.pid);
    assert.equal(tail.exitCode, null);
    assert.equal(await stop(next), 0, next.stderr());
    assert.equal(existsSync(lock), false);
  } finally {
    tail.kill();
    await Promise.all(runs.map(stop));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a lock whose process is gone or is not an autopilot run is replaced', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-run-'));
  const home = join(tmp, 'home');
  const lock = join(home, 'supervisor.lock');
  mkdirSync(home, { recursive: true });
  // A live process that is not an autopilot run, as after pid reuse.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const runs: RunOutput[] = [];
  try {
    const dead = spawnSync(process.execPath, ['-e', '']).pid; // exited and reaped
    writeFileSync(lock, `${JSON.stringify({ pid: dead, startedAt: new Date(0).toISOString() })}\n`);
    const replaced = spawnRun(['--home', home, '--port', '0']);
    runs.push(replaced);
    assert.ok((await replaced.ready).started, replaced.stderr());
    assert.equal(lockOf(lock).pid, replaced.child.pid);
    assert.equal(await stop(replaced), 0, replaced.stderr());
    assert.equal(existsSync(lock), false);

    // Stopped the moment it says it runs, it still stops its workers and removes its lock.
    writeFileSync(lock, `${JSON.stringify({ pid: other.pid, startedAt: new Date(0).toISOString() })}\n`);
    const quick = spawnRun(['--home', home, '--port', '0'], {}, { stopAtBanner: true });
    runs.push(quick);
    assert.ok((await quick.ready).started, quick.stderr());
    assert.equal(await quick.exited, 0, `${quick.stderr()} (signal ${quick.child.signalCode})`);
    assert.match(quick.stderr(), /SIGTERM: stopping workers/);
    assert.equal(existsSync(lock), false);

    // Without ps to tell what the process is, a live pid counts as another run.
    writeFileSync(lock, `${JSON.stringify({ pid: other.pid, startedAt: new Date(0).toISOString() })}\n`);
    const noPs = spawnRun(['--home', home, '--port', '0'], { PATH: join(tmp, 'no-such-dir') });
    runs.push(noPs);
    assert.equal((await noPs.ready).started, false, 'it started although the lock holder may be a run');
    assert.equal(await noPs.exited, 1, noPs.stderr());
    assert.match(noPs.stderr(), new RegExp(`another autopilot run is using .*home \\(pid ${other.pid}\\)`));
    assert.equal(lockOf(lock).pid, other.pid);
  } finally {
    other.kill();
    await Promise.all(runs.map(stop));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('run warns about plain HTTP only on a network address without an https publicUrl', () => {
  for (const address of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) assert.equal(plainHttpWarning(address, 4777, null), null, address);
  for (const url of ['https://box.example.ts.net', 'HTTPS://box.example.ts.net']) assert.equal(plainHttpWarning('0.0.0.0', 4777, url), null, url);
  const exposed: [string, string][] = [
    ['0.0.0.0', '0.0.0.0:4777'],
    ['::', '[::]:4777'],
    ['192.168.1.20', '192.168.1.20:4777'],
    ['fe80::1', '[fe80::1]:4777'],
  ];
  for (const [address, where] of exposed) {
    for (const url of [null, 'http://192.168.1.20:4777']) {
      const warning = plainHttpWarning(address, 4777, url) ?? '';
      assert.ok(warning.startsWith(`the inbox is served over plain HTTP on ${where}.`), `${address} ${url}: ${warning}`);
      assert.match(warning, /can read the sign-in traffic \(the pairing code and the 30-day session cookie\) and use the inbox as you/);
      assert.match(warning, /use Tailscale Serve with an https publicUrl instead: see \/.*docs\/setup\.md, section 6\.$/);
    }
  }
});
