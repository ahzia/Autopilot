// SPDX-License-Identifier: MIT
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CommandCheckRunner, isDependencyFile, portBaseFor, SETUP_MARKER } from '../src/checks.ts';
import { defaultConfig, validateConfig, type CheckCommand } from '../src/config.ts';
import { makeNotifier, MemoryNotifier, NtfyNotifier, NullNotifier } from '../src/notify.ts';

const execFileAsync = promisify(execFile);

const NODE = process.execPath;
const nodeCheck = (name: string, script: string, timeoutSeconds = 30): CheckCommand => ({ name, run: [NODE, '-e', script], timeoutSeconds });
const runOne = async (cmd: CheckCommand, cwd: string, opts?: ConstructorParameters<typeof CommandCheckRunner>[1]) =>
  (await new CommandCheckRunner({ setup: [], commands: [cmd] }, opts).run(cwd))[0];

function tmpDir(t: TestContext, prefix = 'ap-checks-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** git isolated from the user's global/system config (hooks, signing). */
function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return execFileSync('git', ['-c', 'user.name=Autopilot Test', '-c', 'user.email=test@example.com', ...args], { cwd, env, encoding: 'utf8' });
}

function makeRepo(dir: string): string {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/** Waits until `file` exists and is not empty (written by a child process). */
async function readWhenWritten(file: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text) return text;
    if (Date.now() > deadline) assert.fail(`${file} was never written`);
    await sleep(20);
  }
}

async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<void> {
  assert.ok(Number.isInteger(pid) && pid > 0, `invalid pid ${pid}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EPERM') return;
      throw err;
    }
    if (Date.now() > deadline) {
      process.kill(pid, 'SIGKILL');
      assert.fail(`process ${pid} survived its check`);
    }
    await sleep(50);
  }
}

// ------------------------------------------------------------ check runner

test('passing and failing commands', async (t) => {
  const cwd = tmpDir(t);
  const runner = new CommandCheckRunner({
    setup: [],
    commands: [nodeCheck('ok', 'console.log("all good"); console.error("warn line")'), nodeCheck('bad', 'console.log("before"); console.error("boom"); process.exit(2)')],
  });
  const results = await runner.run(cwd);
  assert.equal(results.length, 2, 'every check runs, even after a failure');
  const [ok, bad] = results;
  assert.equal(ok.name, 'ok');
  assert.equal(ok.status, 'passed');
  assert.deepEqual(ok.command, [NODE, '-e', 'console.log("all good"); console.error("warn line")']);
  assert.match(ok.outputTail, /all good/);
  assert.match(ok.outputTail, /warn line/);
  assert.ok(ok.durationMs >= 0);
  assert.equal(bad.status, 'failed');
  assert.match(bad.outputTail, /before/);
  assert.match(bad.outputTail, /boom/); // stdout and stderr are separate pipes: no ordering between them
  assert.match(bad.outputTail, /\[autopilot\] exited with code 2$/);
});

test('nothing configured, missing binaries and missing directories', async (t) => {
  const cwd = tmpDir(t);
  assert.deepEqual(await new CommandCheckRunner({ setup: [], commands: [] }).run(cwd), []);
  const ghost = await runOne({ name: 'ghost', run: [path.join(cwd, 'no-such-binary')], timeoutSeconds: 30 }, cwd);
  assert.equal(ghost.status, 'error');
  assert.match(ghost.outputTail, /could not start/);
  const gone = await runOne(nodeCheck('x', ''), path.join(cwd, 'missing'));
  assert.equal(gone.status, 'error');
  assert.match(gone.outputTail, /working directory does not exist/);
  const empty = await runOne({ name: 'empty', run: [], timeoutSeconds: 30 }, cwd);
  assert.equal(empty.status, 'error');
});

test('credentials are stripped; CI and a per-worktree port base are set', async (t) => {
  const cwd = tmpDir(t);
  // This suite may itself run as an autopilot check, with AUTOPILOT_PORT_BASE already set.
  const parentPortBase = process.env.AUTOPILOT_PORT_BASE;
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: 'sk-ant-api03-test-value-123456',
    ANTHROPIC_AUTH_TOKEN: 'auth-token-value-123456',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value-123456',
    GH_TOKEN: 'gh-token-value-123456',
    GITHUB_TOKEN: 'github-token-value-123456',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value-123456',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token-value-123456',
    GOOGLE_APPLICATION_CREDENTIALS: '/home/founder/vertex-key.json',
    GIT_DIR: '/elsewhere/.git',
    KEEP_ME: 'kept',
    AWS_REGION: 'eu-west-1',
  };
  const script =
    'const e = process.env; console.log(JSON.stringify({ a: e.ANTHROPIC_API_KEY ?? null, b: e.ANTHROPIC_AUTH_TOKEN ?? null, o: e.CLAUDE_CODE_OAUTH_TOKEN ?? null, ' +
    'g: e.GH_TOKEN ?? null, h: e.GITHUB_TOKEN ?? null, s: e.AWS_SECRET_ACCESS_KEY ?? null, br: e.AWS_BEARER_TOKEN_BEDROCK ?? null, ' +
    'gc: e.GOOGLE_APPLICATION_CREDENTIALS ?? null, d: e.GIT_DIR ?? null, keep: e.KEEP_ME, region: e.AWS_REGION, ci: e.CI, port: e.AUTOPILOT_PORT_BASE }))';
  const r = await runOne(nodeCheck('env', script), cwd, { env });
  assert.equal(r.status, 'passed', r.outputTail);
  const seen = JSON.parse(r.outputTail.trim().split('\n').pop()!);
  const base = portBaseFor(cwd);
  assert.deepEqual(seen, {
    a: null,
    b: null,
    o: null,
    g: null,
    h: null,
    s: null,
    br: null,
    gc: null,
    d: null,
    keep: 'kept',
    region: 'eu-west-1',
    ci: '1',
    port: String(base),
  });
  assert.ok(base >= 40000 && base <= 48990 && base % 10 === 0, `port base ${base}`);
  assert.equal(portBaseFor(cwd), base, 'stable for a worktree');
  assert.equal(process.env.AUTOPILOT_PORT_BASE, parentPortBase, 'the supervisor environment is untouched');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api03-test-value-123456', 'the env passed in is not mutated');
});

test('output keeps the tail, strips terminal codes and redacts secrets', async (t) => {
  const cwd = tmpDir(t);
  const ghp = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
  const envSecret = 'svc-secret-value-0123456789';
  // The 1100-char tail starts 15 characters inside the token: cutting first and
  // redacting afterwards would leak those characters.
  const straddle = nodeCheck('straddle', `console.log('filler\\n'.repeat(3000) + 'token: ' + '${ghp}' + 'z'.repeat(1080) + '\\nEND')`);
  const styled = nodeCheck(
    'styled',
    String.raw`
      console.log('\x1b[31mred text\x1b[0m');
      process.stdout.write('progress 10%\rprogress 55%\rprogress 100%\n');
      console.log('api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
      console.log('service ' + process.env.MY_SERVICE_TOKEN);
      console.log('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----');
      console.log('done');`,
  );
  const flood = nodeCheck('flood', `process.stdout.write('y'.repeat(150000) + '\\n' + 'w'.repeat(50000) + '\\n'); console.log('TAIL-END')`);
  const runner = new CommandCheckRunner({ setup: [], commands: [straddle, styled, flood] }, { env: { ...process.env, MY_SERVICE_TOKEN: envSecret }, maxOutput: 1100 });
  const [s, st, f] = await runner.run(cwd);

  assert.equal(s.status, 'passed');
  assert.ok(s.outputTail.length <= 1100, `tail length ${s.outputTail.length}`);
  assert.match(s.outputTail, /\nEND\n?$/);
  assert.ok(!s.outputTail.includes(ghp.slice(-15)), 'no fragment of the token survives the cut');
  assert.match(s.outputTail, /\[redacted\]/);

  assert.equal(st.status, 'passed');
  assert.match(st.outputTail, /red text/);
  assert.ok(!st.outputTail.includes('\x1b'), 'ANSI codes are stripped');
  assert.match(st.outputTail, /progress 100%/);
  assert.ok(!st.outputTail.includes('progress 10%'), 'carriage-return progress collapses to the final state');
  assert.ok(!st.outputTail.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!st.outputTail.includes(envSecret), 'values of secret-looking env vars are redacted');
  assert.ok(!st.outputTail.includes('MIIEvQIBADANBgkq'));
  assert.match(st.outputTail, /done/);

  assert.equal(f.status, 'passed');
  assert.ok(f.outputTail.length <= 1100);
  assert.match(f.outputTail, /TAIL-END\n?$/);
});

test('timeouts terminate the whole process group (SIGTERM, then SIGKILL)', async (t) => {
  const cwd = tmpDir(t);
  const sleeper = nodeCheck('sleeper', 'setTimeout(() => {}, 30000)', 5);
  const stubborn = nodeCheck(
    'stubborn',
    String.raw`
      process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      console.log('grandchild ' + g.pid);
      setTimeout(() => {}, 30000);`,
    5,
  );
  const timed = async (cmd: CheckCommand) => {
    const t0 = Date.now();
    const r = await runOne(cmd, cwd);
    return { r, ms: Date.now() - t0 };
  };
  const [a, b] = await Promise.all([timed(sleeper), timed(stubborn)]);

  assert.equal(a.r.status, 'timeout');
  assert.ok(a.ms >= 4900 && a.ms < 7000, `sleeper ended after ${a.ms}ms`);
  assert.match(a.r.outputTail, /timed out after 5s/);

  assert.equal(b.r.status, 'timeout');
  assert.ok(b.ms >= 7900 && b.ms < 9500, `stubborn ended after ${b.ms}ms`);
  assert.match(b.r.outputTail, /ignoring SIGTERM/);
  const pid = Number(/grandchild (\d+)/.exec(b.r.outputTail)?.[1]);
  assert.ok(pid > 0, b.r.outputTail);
  await waitUntilDead(pid);
});

test('a command that exits before its deadline keeps its own status while leftovers hold the pipes', async (t) => {
  const dir = tmpDir(t);
  // The main process exits in time, but a helper in its group inherits stdout and needs
  // 2.5s after SIGTERM to exit, so the output drain wait runs past the 1.5s deadline.
  const lingering = (exitCode: number): CheckCommand => ({
    name: `exit-${exitCode}`,
    run: [
      NODE,
      '-e',
      String.raw`
        const fs = require('node:fs');
        const ready = process.argv[1];
        const helper = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2500)); console.log('helper ' + process.pid); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 30000)";
        require('node:child_process').spawn(process.execPath, ['-e', helper, ready], { stdio: 'inherit' }).unref();
        const wait = () => (fs.existsSync(ready) ? (console.log('main done'), process.exit(Number(process.argv[2]))) : setTimeout(wait, 20));
        wait();`,
      path.join(dir, `ready-${exitCode}`),
      String(exitCode),
    ],
    timeoutSeconds: 1.5,
  });
  const [ok, bad] = await Promise.all([runOne(lingering(0), dir), runOne(lingering(1), dir)]);
  for (const r of [ok, bad]) {
    assert.ok(r.durationMs > 1500, `the drain wait outlasted the deadline (${r.durationMs}ms): ${r.outputTail}`);
    assert.doesNotMatch(r.outputTail, /timed out/);
    assert.match(r.outputTail, /main done/);
  }
  assert.equal(ok.status, 'passed', ok.outputTail);
  assert.equal(bad.status, 'failed', bad.outputTail);
  assert.match(bad.outputTail, /\[autopilot\] exited with code 1$/);
  for (const r of [ok, bad]) await waitUntilDead(Number(/helper (\d+)/.exec(r.outputTail)?.[1]), 5000);
});

test('leftover background processes are cleaned up after a check exits', async (t) => {
  const cwd = tmpDir(t);
  const leaky = nodeCheck(
    'leaky',
    String.raw`
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      g.unref();
      console.log('server ' + g.pid);`,
  );
  const t0 = Date.now();
  const r = await runOne(leaky, cwd);
  assert.equal(r.status, 'passed', r.outputTail);
  assert.ok(Date.now() - t0 < 2500, 'a leftover holding stdout open does not stall the check');
  await waitUntilDead(Number(/server (\d+)/.exec(r.outputTail)?.[1]));
});

test('killAll stops the running command and starts no further checks', async (t) => {
  const cwd = tmpDir(t);
  const marker = path.join(cwd, 'second-ran.txt');
  const runner = new CommandCheckRunner({
    setup: [],
    commands: [nodeCheck('long', 'setTimeout(() => {}, 30000)'), { name: 'second', run: [NODE, '-e', 'require("node:fs").writeFileSync(process.argv[1], "x")', marker], timeoutSeconds: 30 }],
  });
  const pending = runner.run(cwd);
  await sleep(300);
  runner.killAll();
  const results = await pending;
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'error');
  assert.match(results[0].outputTail, /killed by the supervisor/);
  assert.equal(fs.existsSync(marker), false, 'the next check never started');

  const quick = new CommandCheckRunner({ setup: [], commands: [nodeCheck('a', ''), nodeCheck('b', '')] });
  quick.killAll();
  assert.deepEqual((await quick.run(cwd)).map((r) => r.status), ['passed', 'passed'], 'runs started after killAll are unaffected');
});

test('check processes do not outlive the supervisor process', async (t) => {
  const dir = tmpDir(t, 'ap-exit-');
  const longPidFile = path.join(dir, 'long.pid');
  const helperPidFile = path.join(dir, 'helper.pid');
  // A stand-in supervisor: one check still running, and one that exited but left a helper
  // that ignores SIGTERM (only the post-exit SIGKILL, 3s later, would stop it). Then it
  // exits at once, as bin/autopilot.ts does after Supervisor.stop().
  const supervisor = String.raw`
    const [checksUrl, cwd, longPidFile, helperPidFile] = process.argv.slice(1);
    const fs = await import('node:fs');
    const { CommandCheckRunner } = await import(checksUrl);
    const node = process.execPath;
    const long = { name: 'long', run: [node, '-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)', longPidFile], timeoutSeconds: 900 };
    const helper = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
    const leaver = { name: 'leaver', timeoutSeconds: 900, run: [node, '-e',
      'const fs = require("node:fs"); require("node:child_process").spawn(process.execPath, ["-e", process.argv[2], process.argv[1]], { stdio: "ignore" }).unref();' +
      'const wait = () => (fs.existsSync(process.argv[1]) && fs.readFileSync(process.argv[1], "utf8") ? process.exit(0) : setTimeout(wait, 20)); wait();',
      helperPidFile, helper] };
    void new CommandCheckRunner({ setup: [], commands: [long] }).run(cwd);
    const [left] = await new CommandCheckRunner({ setup: [], commands: [leaver] }).run(cwd);
    while (!(fs.existsSync(longPidFile) && fs.readFileSync(longPidFile, 'utf8'))) await new Promise((r) => setTimeout(r, 20));
    console.log(left.status);
    process.exit(0);`;
  const checksUrl = new URL('../src/checks.ts', import.meta.url).href;
  const { stdout } = await execFileAsync(
    NODE,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', supervisor, checksUrl, dir, longPidFile, helperPidFile],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(stdout.trim(), 'passed');
  const pids = [Number(await readWhenWritten(longPidFile)), Number(await readWhenWritten(helperPidFile))];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
  // Both would otherwise live for 60s or forever; the exit hook kills them at once.
  for (const pid of pids) await waitUntilDead(pid, 1500);
});

// ------------------------------------------------------------------ setup

test('setup runs once per worktree, in the main checkout and in linked worktrees', async (t) => {
  const dir = tmpDir(t, 'ap-setup-');
  const repo = makeRepo(dir);
  const counter = path.join(dir, 'setup-count.txt');
  const runner = new CommandCheckRunner({ setup: [[NODE, '-e', 'require("node:fs").appendFileSync(process.argv[1], "x")', counter]], commands: [] });

  const first = await runner.setup(repo);
  assert.equal(first.length, 1);
  assert.equal(first[0].name, `setup:${NODE}`);
  assert.equal(first[0].status, 'passed');
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x');
  assert.ok(fs.existsSync(path.join(repo, '.git', SETUP_MARKER)));
  assert.deepEqual(await runner.setup(repo), [], 'second call is a no-op');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the marker never shows up in the working tree');

  const wt = path.join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  await Promise.all([runner.setup(wt), runner.setup(wt)]); // concurrent calls share one run
  assert.equal(fs.readFileSync(counter, 'utf8'), 'xx', 'the linked worktree gets its own setup, once');
  const wtMarker = git(wt, 'rev-parse', '--git-path', SETUP_MARKER).trim();
  assert.ok(path.isAbsolute(wtMarker) && fs.existsSync(wtMarker), `per-worktree marker at ${wtMarker}`);
  assert.deepEqual(await runner.setup(wt), []);
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(counter, 'utf8'), 'xx');
});

test('a failing setup leaves no marker; setup outside git is an error', async (t) => {
  const dir = tmpDir(t, 'ap-setup-');
  const repo = makeRepo(dir);
  const after = path.join(dir, 'after.txt');
  const runner = new CommandCheckRunner({
    setup: [
      [NODE, '-e', 'console.error("npm ERR! network"); process.exit(3)'],
      [NODE, '-e', 'require("node:fs").appendFileSync(process.argv[1], "x")', after],
    ],
    commands: [],
  });
  const r1 = await runner.setup(repo);
  assert.equal(r1.length, 1, 'stops at the first failing setup command');
  assert.equal(r1[0].status, 'failed');
  assert.match(r1[0].outputTail, /npm ERR! network/);
  assert.equal(fs.existsSync(after), false);
  assert.equal(fs.existsSync(path.join(repo, '.git', SETUP_MARKER)), false);
  assert.equal((await runner.setup(repo)).length, 1, 'retried on the next call');

  const plain = tmpDir(t, 'ap-norepo-');
  const [err] = await runner.setup(plain);
  assert.equal(err.name, 'setup:git');
  assert.equal(err.status, 'error');
  assert.deepEqual(await new CommandCheckRunner({ setup: [], commands: [] }).setup(plain), [], 'no setup configured');
});

test('setup runs again in a reused worktree when dependency files or setup commands change', async (t) => {
  const dir = tmpDir(t, 'ap-setup-');
  const repo = makeRepo(dir);
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"v":1}\n');
  fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps', 'web', 'package.json'), '{"name":"web"}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'dependencies');
  // One persistent detached worktree, reset to each new target like the forge's integration worktree.
  const wt = path.join(dir, '_integration');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
  const checkoutTarget = () => git(wt, 'checkout', '-q', '--detach', '--force', 'main');
  const commitOnTarget = (file: string, content: string, message: string) => {
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'commit', '-q', '-am', message);
    checkoutTarget();
  };
  const counter = path.join(dir, 'setup-count.txt');
  const setupCommand = (mark: string) => [NODE, '-e', 'require("node:fs").appendFileSync(process.argv[1], process.argv[2])', counter, mark];
  const runner = new CommandCheckRunner({ setup: [setupCommand('x')], commands: [] });
  const runs = () => fs.readFileSync(counter, 'utf8');

  assert.equal((await runner.setup(wt)).length, 1);
  assert.deepEqual(await runner.setup(wt), [], 'nothing changed');

  commitOnTarget('package-lock.json', '{"v":2,"dependencies":["left-pad"]}\n', 'add a dependency');
  const again = await runner.setup(wt);
  assert.equal(again.length, 1, 'a changed lockfile runs setup again');
  assert.equal(again[0].status, 'passed');
  assert.equal(runs(), 'xx');
  assert.deepEqual(await runner.setup(wt), []);

  commitOnTarget('README.md', '# changed\n', 'docs');
  assert.deepEqual(await runner.setup(wt), [], 'other files do not matter');
  fs.mkdirSync(path.join(wt, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', 'left-pad', 'package.json'), '{"name":"left-pad"}\n');
  assert.deepEqual(await runner.setup(wt), [], 'installed packages are not project manifests');

  commitOnTarget('apps/web/package.json', '{"name":"web","dependencies":{"x":"1.0.0"}}\n', 'web dependency');
  assert.equal((await runner.setup(wt)).length, 1, 'a nested workspace manifest counts');
  assert.equal(runs(), 'xxx');

  const reconfigured = new CommandCheckRunner({ setup: [setupCommand('y')], commands: [] });
  assert.equal((await reconfigured.setup(wt)).length, 1, 'changed setup commands run in an existing worktree');
  assert.deepEqual(await reconfigured.setup(wt), []);
  assert.equal(runs(), 'xxxy');
  assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=no'), '', 'the marker never shows up in the worktree');
});

test('a setup that rewrites a lockfile (like npm install) is not repeated on every call', async (t) => {
  const dir = tmpDir(t, 'ap-setup-');
  const repo = makeRepo(dir);
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":1}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'lockfile');
  const counter = path.join(dir, 'setup-count.txt');
  const rewrite = [NODE, '-e', 'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "x"); fs.writeFileSync("package-lock.json", "{\\"lockfileVersion\\":3}\\n")', counter];
  const runner = new CommandCheckRunner({ setup: [rewrite], commands: [] });
  assert.equal((await runner.setup(repo)).length, 1);
  assert.match(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'), /"lockfileVersion":3/);
  assert.deepEqual(await runner.setup(repo), [], 'the marker records the state setup left behind');
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x');
});

test("setup's own git never runs an fsmonitor program from the worktree's git config", async (t) => {
  const dir = tmpDir(t, 'ap-setup-');
  const repo = makeRepo(dir);
  const ran = path.join(dir, 'fsmonitor-ran.txt');
  const program = path.join(dir, 'fsmonitor.sh');
  fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${ran}'\nexit 1\n`);
  fs.chmodSync(program, 0o755);
  // What a worker could write into the shared repository config from its worktree.
  git(repo, 'config', 'core.fsmonitor', program);
  git(repo, 'ls-files', '--cached', '--others', '--exclude-standard');
  assert.ok(fs.existsSync(ran), 'sanity check: plain git runs it');
  fs.rmSync(ran);

  const runner = new CommandCheckRunner({ setup: [[NODE, '-e', '']], commands: [] });
  assert.equal((await runner.setup(repo))[0]?.status, 'passed');
  assert.deepEqual(await runner.setup(repo), [], 'the marker was found');
  assert.equal(fs.existsSync(ran), false, 'no fsmonitor program ran');
});

test('setups in one worktree never overlap, even from different runner instances', async (t) => {
  const dir = tmpDir(t, 'ap-setup-');
  const repo = makeRepo(dir);
  const log = path.join(dir, 'setup-log.txt');
  const step = (tag: string) => [
    NODE,
    '-e',
    'const fs = require("node:fs"); const [log, tag] = process.argv.slice(1); fs.appendFileSync(log, "start " + tag + "\\n"); setTimeout(() => fs.appendFileSync(log, "end " + tag + "\\n"), 300)',
    log,
    tag,
  ];
  // E.g. a config change replaced the runner while the old one was still setting up.
  const a = new CommandCheckRunner({ setup: [step('a')], commands: [] });
  const b = new CommandCheckRunner({ setup: [step('b')], commands: [] });
  const [ra, rb] = await Promise.all([a.setup(repo), b.setup(repo)]);
  assert.deepEqual([ra.length, rb.length], [1, 1]);
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
  assert.deepEqual(events.map(([kind]) => kind), ['start', 'end', 'start', 'end'], `setups overlapped: ${JSON.stringify(events)}`);
  assert.equal(events[0][1], events[1][1]);
  assert.equal(events[2][1], events[3][1]);
  assert.notEqual(events[0][1], events[2][1]);
});

test('dependency files that decide what setup installs', () => {
  const yes = [
    'package.json',
    'apps/web/package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    '.npmrc',
    'requirements.txt',
    'requirements-dev.txt',
    'poetry.lock',
    'uv.lock',
    'Gemfile.lock',
    'go.sum',
    'Cargo.lock',
    '.nvmrc',
    '.tool-versions',
    'api/Api.csproj',
  ];
  for (const p of yes) assert.equal(isDependencyFile(p), true, p);
  const no = ['README.md', 'src/package.ts', 'mypackage.json', 'package.json.bak', 'node_modules/left-pad/package.json', 'apps/web/node_modules/x/package.json'];
  for (const p of no) assert.equal(isDependencyFile(p), false, p);
});

// ------------------------------------------------------------ notifications

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function stubServer(t: TestContext, respond: (res: http.ServerResponse) => void = (res) => res.end('{"id":"1"}')) {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  t.after(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close };
}

test('ntfy notifier posts title, priority, click link and tags', async (t) => {
  const stub = await stubServer(t);
  const ntfy = new NtfyNotifier({ url: `${stub.url}/`, topic: 'autopilot-test-topic', publicUrl: 'https://inbox.example.test' });
  await ntfy.notify({ title: 'Decision needed', body: 'T-3 is waiting for you', priority: 'high' });
  await ntfy.notify({ title: 'Merged', body: 'T-4 merged', url: '/#decision=D-7', priority: 'urgent' });
  await ntfy.notify({ title: 'Digest', body: 'x', url: 'https://other.example.test/d', priority: 'low' });
  await ntfy.notify({ title: 'Café — ready ✅\nsecond line', body: `token ghp_${'a'.repeat(36)}` });

  assert.equal(stub.requests.length, 4);
  const [a, b, c, d] = stub.requests;
  assert.equal(a.method, 'POST');
  assert.equal(a.url, '/autopilot-test-topic');
  assert.equal(a.headers.title, 'Decision needed');
  assert.equal(a.headers.priority, '4');
  assert.equal(a.headers.click, 'https://inbox.example.test/');
  assert.equal(a.headers.tags, 'robot');
  assert.match(String(a.headers['content-type']), /^text\/plain/);
  assert.equal(a.body, 'T-3 is waiting for you');
  assert.equal(b.headers.priority, '5');
  assert.equal(b.headers.click, 'https://inbox.example.test/#decision=D-7', 'relative urls resolve against publicUrl');
  assert.equal(c.headers.priority, '2');
  assert.equal(c.headers.click, 'https://other.example.test/d');
  assert.equal(d.headers.priority, '3', 'normal is the default');
  const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(d.headers.title));
  assert.ok(encoded, `non-ASCII titles are RFC 2047 encoded: ${d.headers.title}`);
  assert.equal(Buffer.from(encoded[1], 'base64').toString('utf8'), 'Café — ready ✅ second line');
  assert.ok(!d.body.includes('a'.repeat(36)), 'secrets are redacted from the body');
});

test('ntfy failures are logged and never thrown', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const failing = await stubServer(t, (res) => {
    res.statusCode = 500;
    res.end('nope');
  });
  await new NtfyNotifier({ url: failing.url, topic: 'autopilot-test-topic' }).notify({ title: 't', body: 'b' });
  assert.equal(failing.requests[0].headers.click, undefined, 'no click link without any url');

  const silent = await stubServer(t, () => {}); // accepts the request, never answers
  const t0 = Date.now();
  await new NtfyNotifier({ url: silent.url, topic: 'autopilot-test-topic', timeoutMs: 200 }).notify({ title: 't', body: 'b' });
  assert.ok(Date.now() - t0 < 3000, 'request timeout applies');

  const closed = await stubServer(t);
  await closed.close();
  await new NtfyNotifier({ url: closed.url, topic: 'autopilot-test-topic' }).notify({ title: 't', body: 'b' });

  const throwing = (() => {
    throw new Error('boom');
  }) as unknown as typeof fetch;
  await new NtfyNotifier({ url: 'http://127.0.0.1:1', topic: 'autopilot-test-topic', fetchImpl: throwing }).notify({ title: 't', body: 'b' });

  // Errors that quote the request URL (as undici's "Failed to parse URL from ..." does).
  const quoting = ((input: unknown) => {
    throw new TypeError(`Failed to parse URL from ${String(input)}`);
  }) as unknown as typeof fetch;
  await new NtfyNotifier({ url: 'http://127.0.0.1:1', topic: 'autopilot-test-topic', fetchImpl: quoting }).notify({ title: 't', body: 'b' });
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /Failed to parse URL from <ntfy endpoint>$/);

  // Passes config validation (^https?://\S+$) but is not a usable URL (port out of range).
  await new NtfyNotifier({ url: 'https://ntfy.example.com:99999', topic: 'autopilot-test-topic' }).notify({ title: 't', body: 'b' });

  assert.equal(errors.mock.callCount(), 6);
  for (const call of errors.mock.calls) {
    assert.ok(!String(call.arguments[0]).includes('autopilot-test-topic'), `the topic is never logged: ${call.arguments[0]}`);
  }
});

test('an unusable ntfy URL disables the notifier with one message that names neither URL nor topic', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const sent: string[] = [];
  const spy = (async (input: unknown) => {
    sent.push(String(input));
    return new Response('{}');
  }) as typeof fetch;
  for (const url of ['https://ntfy.example.com:99999', 'http://[bad', 'https://founder:hunter2-secret@ntfy.example.com', 'ftp://ntfy.example.com']) {
    const ntfy = new NtfyNotifier({ url, topic: 'my-secret-topic-123', fetchImpl: spy });
    await ntfy.notify({ title: 't', body: 'b' });
    await ntfy.notify({ title: 't', body: 'b' });
  }
  assert.deepEqual(sent, [], 'nothing is sent');
  assert.equal(errors.mock.callCount(), 4, 'one message per notifier, not one per notification');
  for (const call of errors.mock.calls) {
    const message = String(call.arguments[0]);
    assert.match(message, /ntfy notifications are disabled/);
    for (const leak of ['my-secret-topic-123', 'ntfy.example.com', 'hunter2-secret', '[bad']) assert.ok(!message.includes(leak), message);
  }

  // The same through the config path: validateConfig accepts the URL, makeNotifier disables it.
  const cfg = validateConfig({ version: 1, id: 'demo', repo: { source: '/tmp/demo' }, inbox: { ntfyUrl: 'https://ntfy.example.com:99999', ntfyTopic: 'my-secret-topic-123' } });
  await makeNotifier(cfg.inbox).notify({ title: 't', body: 'b' });
  assert.equal(errors.mock.callCount(), 5);
  assert.ok(!String(errors.mock.calls.at(-1)?.arguments[0]).includes('my-secret-topic-123'));
});

test('memory, null and configured notifiers', async () => {
  const mem = new MemoryNotifier();
  await mem.notify({ title: 'a', body: 'b', priority: 'low' });
  assert.deepEqual(mem.sent, [{ title: 'a', body: 'b', priority: 'low' }]);
  assert.equal(mem.notifications, mem.sent);
  await new NullNotifier().notify({ title: 'a', body: 'b' });
  const cfg = defaultConfig('demo', 'Demo', '/tmp/demo');
  assert.ok(makeNotifier(cfg.inbox) instanceof NullNotifier);
  assert.ok(makeNotifier({ ...cfg.inbox, ntfyUrl: 'https://ntfy.example.test', ntfyTopic: 'autopilot-topic-1' }) instanceof NtfyNotifier);
});
