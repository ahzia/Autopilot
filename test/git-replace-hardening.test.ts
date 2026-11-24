// SPDX-License-Identifier: MIT
// Replace refs and grafts a worker writes in the shared repository must not change what git shows
// the supervisor or any run it starts: a builder could otherwise show stand-in objects or history
// to the merge gate and the reviewer while the real commits merge.

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARDENING_CONFIG, git, gitEnv, runCommand } from '../src/git/git.ts';
import { buildClaudeEnv } from '../src/runner/claude-cli.ts';
import type { RunSpec } from '../src/types.ts';
import { SAFE_GIT_FLAGS, scrubbedEnv } from '../src/util.ts';
import { approve, builderResult, commitFile, harness } from './drills/harness.ts';

// Keep the developer's own git configuration (signing, hooks, replace settings) out of these tests,
// and the repository of a git command that runs them: git rebase --exec and hooks can hand on
// GIT_DIR and the like (gitEnv() in src/git/git.ts drops the same), and these tests write config,
// refs, grafts and commits.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// A worker run's own git ignores replace refs (GIT_NO_REPLACE_OBJECTS, GIT_GRAFT_FILE, and
// core.useReplaceRefs=false in GIT_CONFIG_PARAMETERS): keep that out of the plain git these tests
// compare with, or they fail when a builder runs them.
for (const key of ['GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete process.env[key];
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX']) {
  delete process.env[key];
}

const T = { timeout: 60_000 };
const NO_PLAN = { summary: 'nothing new', newTasks: [], acceptTaskIds: [], cancelTaskIds: [], questions: [] };

/** The environment a parent process would hand on, without the variables under test. */
function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_GRAFT_FILE;
  return env;
}

/** Plain git as an agent's Bash tool runs it: no flags, in the environment it was given. */
function agentGit(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Sets environment variables; the returned function puts the old values back. */
function setEnv(vars: Record<string, string>): () => void {
  const old = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, vars);
  return () => {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A fresh repository; `plain` runs git in it as a worker would, `write` writes a file. */
function workerRepo(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plain = (...args: string[]) => agentGit(dir, launchEnv(), '-c', 'user.name=Worker', '-c', 'user.email=worker@example.com', ...args);
  plain('init', '-q', '-b', 'main');
  return { dir, plain, write: (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text) };
}

/** The settings a list of git flags passes with -c. */
const configOf = (flags: readonly string[]) => flags.filter((_, i) => flags[i - 1] === '-c');

const lines = (text: string) => text.trim().split('\n');

test("every run's git ignores replace refs, whatever the shared config says, so a reviewer's own git diff shows what merges", T, async () => {
  const specs: RunSpec[] = [];
  let reviewerSees = '';
  let oldGitSees = '';
  let plainSees = '';
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
      c.planner.cooldownMinutes = 60;
    },
    behavior: (spec) => async (ctl) => {
      specs.push(spec);
      if (spec.role === 'planner') return { status: 'succeeded', structuredOutput: NO_PLAN };
      if (spec.role === 'reviewer') {
        const base = /^Base commit: (\S+)$/m.exec(spec.prompt)![1];
        const head = /^Head commit under review: (\S+)$/m.exec(spec.prompt)![1];
        // What `git diff <base> <head>` shows in the reviewer's Bash tool: the runner builds
        // claude's environment from its own and the run's, and claude's tools inherit it.
        const runEnv = buildClaudeEnv(spec, launchEnv(), true);
        reviewerSees = agentGit(spec.cwd, runEnv, 'diff', '--name-only', base, head);
        // Git before 2.42 let the repository's core.useReplaceRefs=true outrank the variable, so
        // there only the run's own core.useReplaceRefs=false keeps the stand-in out.
        delete runEnv.GIT_NO_REPLACE_OBJECTS;
        oldGitSees = agentGit(spec.cwd, runEnv, 'diff', '--name-only', base, head);
        plainSees = agentGit(spec.cwd, launchEnv(), 'diff', '--name-only', base, head);
        return { status: 'succeeded', structuredOutput: approve };
      }
      // The builder commits a backdoor, points a replace ref from its head at a clean stand-in and
      // switches replace refs on in the shared repository's config.
      const asWorker = (...args: string[]) => ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', ...args]);
      const base = (await ctl.git(['rev-parse', 'HEAD'])).trim();
      ctl.writeFile('feature.txt', 'f\n');
      await ctl.git(['add', 'feature.txt']);
      const clean = (await asWorker('commit-tree', (await ctl.git(['write-tree'])).trim(), '-p', base, '-m', 'feature')).trim();
      ctl.writeFile('z/backdoor.js', 'module.exports = "backdoor";\n');
      await ctl.git(['add', 'z/backdoor.js']);
      await asWorker('commit', '-q', '-m', 'feature');
      await ctl.git(['replace', (await ctl.git(['rev-parse', 'HEAD'])).trim(), clean]);
      await ctl.git(['config', 'core.useReplaceRefs', 'true']);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  // Settings the founder's environment gives git (git -c, GIT_CONFIG_COUNT) must stay in effect in the
  // runs, except core.useReplaceRefs: the run's own setting comes after them, so it wins.
  const restoreEnv = setEnv({ GIT_CONFIG_PARAMETERS: "'autopilot.fromparameters=kept' 'core.useReplaceRefs=true'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'autopilot.fromcount', GIT_CONFIG_VALUE_0: 'kept' });
  try {
    const t = h.addTask('Hidden');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    await h.waitFor(() => specs.some((s) => s.role === 'planner'), 'a planner run');
    assert.equal(plainSees, 'feature.txt', 'sanity check: plain git shows the stand-in');
    assert.equal(reviewerSees, 'feature.txt\nz/backdoor.js', "the reviewer's own git diff shows the real head");
    assert.equal(oldGitSees, 'feature.txt\nz/backdoor.js', 'also where the repository config outranks GIT_NO_REPLACE_OBJECTS (git before 2.42)');
    assert.equal(h.readTarget('z/backdoor.js'), 'module.exports = "backdoor";\n', 'and that is what merged');

    // Every role gets the variable, and the runner keeps it whatever claude's parent environment
    // holds. Every role's git reads core.useReplaceRefs=false over the shared config's true, and
    // the founder's own settings as well.
    assert.deepEqual([...new Set(specs.map((s) => s.role))].sort(), ['builder', 'planner', 'reviewer']);
    for (const spec of specs) {
      assert.equal(spec.env.GIT_NO_REPLACE_OBJECTS, '1', `${spec.role} run`);
      const env = buildClaudeEnv(spec, { ...launchEnv(), GIT_NO_REPLACE_OBJECTS: 'inherited' }, true);
      assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1', `${spec.role} run, inherited value`);
      const config = (key: string) => agentGit(h.bare, buildClaudeEnv(spec, launchEnv(), true), 'config', key);
      const settings = { useReplaceRefs: config('core.useReplaceRefs'), parameters: config('autopilot.fromparameters'), count: config('autopilot.fromcount') };
      assert.deepEqual(settings, { useReplaceRefs: 'false', parameters: 'kept', count: 'kept' }, `${spec.role} run`);
    }
  } finally {
    restoreEnv();
    await h.cleanup();
  }
});

test('core.useReplaceRefs=true in the repository config cannot switch replace refs back on', async (t) => {
  const { dir, plain, write } = workerRepo(t);
  write('README.md', 'hi\n');
  plain('add', 'README.md');
  plain('commit', '-q', '-m', 'initial');
  const target = plain('rev-parse', 'HEAD');
  // A stand-in for the commit that also has evil.txt, and the repository config switches replace refs on.
  write('evil.txt', 'evil\n');
  plain('add', 'evil.txt');
  plain('replace', target, plain('commit-tree', plain('write-tree'), '-m', 'initial'));
  plain('config', 'core.useReplaceRefs', 'true');
  assert.deepEqual(lines(plain('ls-tree', '--name-only', target)), ['README.md', 'evil.txt'], 'sanity check: plain git sees the stand-in');

  // Both flag lists turn replace refs off on the command line, which outranks every config file.
  for (const flags of [HARDENING_CONFIG, SAFE_GIT_FLAGS]) assert.ok(configOf(flags).includes('core.useReplaceRefs=false'), flags.join(' '));
  // git(), and the supervisor's safeGit (SAFE_GIT_FLAGS and scrubbedEnv through git()), see the real commit.
  assert.deepEqual(lines((await git(['ls-tree', '--name-only', target], { cwd: dir })).stdout), ['README.md']);
  assert.deepEqual(lines((await git([...SAFE_GIT_FLAGS, 'ls-tree', '--name-only', target], { cwd: dir, env: scrubbedEnv() })).stdout), ['README.md']);
  // So do the flags without GIT_NO_REPLACE_OBJECTS: git before 2.42 read core.useReplaceRefs after
  // that variable, so the config above switched replace refs back on despite it.
  for (const flags of [HARDENING_CONFIG, SAFE_GIT_FLAGS]) {
    const r = await runCommand('git', [...flags, 'ls-tree', '--name-only', target], { cwd: dir, env: launchEnv() });
    assert.deepEqual(lines(r.stdout), ['README.md'], flags.join(' '));
  }
});

test("every run's git ignores grafts, so a reviewer's own git log shows every commit", T, async () => {
  const specs: RunSpec[] = [];
  let reviewerLog = { stdout: '', stderr: '' };
  let plainLog = '';
  const h = await harness({
    config: (c) => {
      c.planner.enabled = true;
      c.planner.cooldownMinutes = 60;
    },
    behavior: (spec) => async (ctl) => {
      specs.push(spec);
      if (spec.role === 'planner') return { status: 'succeeded', structuredOutput: NO_PLAN };
      if (spec.role === 'reviewer') {
        const range = `${/^Base commit: (\S+)$/m.exec(spec.prompt)![1]}..${/^Head commit under review: (\S+)$/m.exec(spec.prompt)![1]}`;
        const r = spawnSync('git', ['log', '--format=%s', range], { cwd: spec.cwd, env: buildClaudeEnv(spec, launchEnv(), true), encoding: 'utf8' });
        reviewerLog = { stdout: r.stdout.trim(), stderr: r.stderr };
        plainLog = agentGit(spec.cwd, launchEnv(), 'log', '--format=%s', range);
        return { status: 'succeeded', structuredOutput: approve };
      }
      // The builder commits twice, then grafts its head straight onto the base, so that plain git
      // no longer walks the first commit.
      const base = (await ctl.git(['rev-parse', 'HEAD'])).trim();
      await commitFile(ctl, 'hidden.txt', 'hidden\n', 'hidden work');
      const head = await commitFile(ctl, 'feature.txt', 'f\n', 'feature');
      const common = path.resolve(spec.cwd, (await ctl.git(['rev-parse', '--git-common-dir'])).trim());
      fs.mkdirSync(path.join(common, 'info'), { recursive: true });
      fs.writeFileSync(path.join(common, 'info', 'grafts'), `${head} ${base}\n`);
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Grafted');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    await h.waitFor(() => specs.some((s) => s.role === 'planner'), 'a planner run');
    assert.equal(plainLog, 'feature', 'sanity check: plain git skips the grafted-away commit');
    assert.deepEqual(reviewerLog, { stdout: 'feature\nhidden work', stderr: '' }, "the reviewer's own git log shows every commit, without a grafts hint");

    // Every role gets a graft file that cannot exist, and the runner keeps it whatever claude's
    // parent environment names.
    assert.deepEqual([...new Set(specs.map((s) => s.role))].sort(), ['builder', 'planner', 'reviewer']);
    const grafts = path.join(h.bare, 'info', 'grafts');
    assert.ok(fs.existsSync(grafts));
    for (const spec of specs) {
      const file = spec.env.GIT_GRAFT_FILE;
      assert.ok(file && !fs.existsSync(file), `${spec.role} run: ${file}`);
      assert.equal(buildClaudeEnv(spec, { ...launchEnv(), GIT_GRAFT_FILE: grafts }, true).GIT_GRAFT_FILE, file, `${spec.role} run, inherited value`);
    }
  } finally {
    await h.cleanup();
  }
});

test('grafts a worker writes never change the history git shows the supervisor', async (t) => {
  const { dir, plain, write } = workerRepo(t);
  const commit = (file: string, subject: string) => {
    write(file, `${file}\n`);
    plain('add', file);
    plain('commit', '-q', '-m', subject);
    return plain('rev-parse', 'HEAD');
  };
  const base = commit('README.md', 'initial');
  commit('a.txt', 'S: adds a');
  const head = commit('b.txt', 'H: adds b');
  // The head's parent becomes the base, which hides S from every history walk.
  fs.writeFileSync(path.join(dir, '.git', 'info', 'grafts'), `${head} ${base}\n`);
  const range = `${base}..${head}`;
  assert.deepEqual(lines(plain('log', '--format=%s', range)), ['H: adds b'], 'sanity check: plain git skips S');

  // git(), the supervisor's safeGit, git started directly with SAFE_GIT_FLAGS and scrubbedEnv
  // (as checks.ts does), and programs started with gitEnv() (gh) all walk the real history,
  // without git's grafts deprecation hint on stderr.
  const runs = {
    git: await git(['log', '--format=%s', range], { cwd: dir }),
    safeGit: await git([...SAFE_GIT_FLAGS, 'log', '--format=%s', range], { cwd: dir, env: scrubbedEnv() }),
    scrubbedEnv: await runCommand('git', [...SAFE_GIT_FLAGS, 'log', '--format=%s', range], { cwd: dir, env: scrubbedEnv() }),
    gitEnv: await runCommand('git', ['log', '--format=%s', range], { cwd: dir, env: gitEnv() }),
  };
  for (const [name, r] of Object.entries(runs)) {
    assert.deepEqual({ log: lines(r.stdout), stderr: r.stderr }, { log: ['H: adds b', 'S: adds a'], stderr: '' }, name);
  }
});

/** Every path under `dir`, files with a hash of their content. */
function snapshot(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((rel) => {
      const file = path.join(dir, rel);
      return fs.lstatSync(file).isFile() ? `${rel} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` : rel;
    });
}

test('these tests leave alone the repository of a git command that runs them', { timeout: 150_000, skip: process.env.AP_DECOY_REPO ? 'this is that run' : false }, (t) => {
  // Commands git starts, such as git rebase --exec 'npm run check' and hooks, can inherit GIT_DIR,
  // GIT_WORK_TREE and GIT_INDEX_FILE naming the repository git works on. Run this file like that.
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-decoy-'));
  t.after(() => fs.rmSync(decoy, { recursive: true, force: true }));
  agentGit(decoy, launchEnv(), 'init', '-q', '-b', 'main');
  agentGit(decoy, launchEnv(), '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '--allow-empty', '-m', 'work in progress');
  const before = snapshot(decoy);
  const gitDir = path.join(decoy, '.git');
  const env: NodeJS.ProcessEnv = { ...process.env, AP_DECOY_REPO: decoy, GIT_DIR: gitDir, GIT_WORK_TREE: decoy, GIT_INDEX_FILE: path.join(gitDir, 'index'), GIT_PREFIX: '' };
  delete env.NODE_TEST_CONTEXT; // report as a run of its own, not into this run's results
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', import.meta.filename], { env, encoding: 'utf8', timeout: 140_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(snapshot(decoy), before, 'nothing in the repository changed');
});
