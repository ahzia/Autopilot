// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '..', 'bin', 'autopilot.ts');
const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('init --create makes a repo and a valid config; task and decision commands honour --home', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  try {
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    const init = run(['init', 'demo', '--home', home, '--source', repo, '--create', '--runner', 'fake', '--check', 'test=node -e process.exit(0)']);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(repo, '.git')));
    const cfg = JSON.parse(readFileSync(join(home, 'projects', 'demo', 'config.json'), 'utf8'));
    assert.equal(cfg.execution.runner, 'fake');
    assert.deepEqual(cfg.checks.commands[0].run, ['node', '-e', 'process.exit(0)']);
    assert.equal(cfg.execution.permissionMode, 'auto');

    // A second init without --force refuses to overwrite.
    assert.notEqual(run(['init', 'demo', '--home', home, '--source', repo]).status, 0);

    // Projects are registered when a supervisor loads configs; emulate that through the store.
    const reg = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `import { Store } from ${JSON.stringify(resolve(import.meta.dirname, '..', 'src', 'store.ts'))};
         import { loadConfigFile } from ${JSON.stringify(resolve(import.meta.dirname, '..', 'src', 'config.ts'))};
         const s = Store.open(${JSON.stringify(join(home, 'autopilot.db'))});
         s.upsertProject(loadConfigFile(${JSON.stringify(join(home, 'projects', 'demo', 'config.json'))}));
         const t = s.createTask({ projectId: 'demo', title: 'Hello', objective: 'x', origin: 'human' });
         s.createDecision({ projectId: 'demo', taskId: t.id, kind: 'choice', question: 'Pick one?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommendation: 'a', createdBy: 'agent' });
         s.close();`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(reg.status, 0, reg.stderr);

    // --home before or after the subcommand, and --home=…, all work (regression: it leaked into positionals).
    assert.match(run(['task', 'list', '--home', home]).stdout, /T-1 +ready/);
    assert.match(run(['--home', home, 'task', 'list']).stdout, /T-1 +ready/);
    assert.match(run(['decisions', `--home=${home}`]).stdout, /D-1 r1 \[choice, blocking/);

    const bad = run(['answer', 'D-1', 'zzz', '--home', home]);
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /invalid/);
    const ok = run(['answer', 'D-1', 'b', '--comment', 'go', '--home', home]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /saved/);

    const status = run(['status', '--home', home]);
    assert.match(status.stdout, /Demo|demo/);
    assert.match(status.stdout, /pending decisions: 0/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('init --create refuses a folder that is not empty and writes nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  try {
    const home = join(tmp, 'home');
    const existing = join(tmp, 'existing');
    mkdirSync(join(existing, 'notes'), { recursive: true });
    writeFileSync(join(existing, 'README.md'), 'my readme\n');
    writeFileSync(join(existing, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(existing, 'secret.txt'), 'not a real secret\n');
    writeFileSync(join(existing, 'notes', 'a.md'), 'notes\n');
    const refused = run(['init', 'ex1', '--home', home, '--source', existing, '--create', '--runner', 'fake']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /existing is not an empty folder: drop --create to use an existing repository, or choose an empty or new folder/);
    assert.equal(refused.stdout, '');
    assert.equal(existsSync(join(existing, '.git')), false);
    assert.equal(readFileSync(join(existing, 'README.md'), 'utf8'), 'my readme\n');
    assert.equal(readFileSync(join(existing, '.gitignore'), 'utf8'), 'secret.txt\n');
    assert.equal(existsSync(join(home, 'projects', 'ex1')), false);

    // A file is not a folder either.
    const file = join(tmp, 'file.txt');
    writeFileSync(file, 'x');
    const notDir = run(['init', 'ex2', '--home', home, '--source', file, '--create']);
    assert.equal(notDir.status, 1);
    assert.match(notDir.stderr, /file\.txt is not an empty folder/);
    assert.equal(readFileSync(file, 'utf8'), 'x');
    assert.equal(existsSync(join(home, 'projects', 'ex2')), false);

    // An empty folder, or a missing one with missing parents, gets a repository holding only init's two files.
    const empty = join(tmp, 'empty');
    mkdirSync(empty);
    const missing = join(tmp, 'new', 'deeper', 'app');
    for (const [id, dir] of [['empty-app', empty], ['new-app', missing]]) {
      const ok = run(['init', id, '--home', home, '--source', dir, '--create', '--runner', 'fake']);
      assert.equal(ok.status, 0, ok.stderr);
      const committed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.deepEqual(committed.split('\n').filter(Boolean).sort(), ['.gitignore', 'README.md']);
      assert.ok(existsSync(join(home, 'projects', id, 'config.json')));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an invalid config is reported, never silently used', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  try {
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    assert.equal(run(['init', 'demo', '--home', home, '--source', repo]).status, 0);
    const path = join(home, 'projects', 'demo', 'config.json');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    cfg.execution.maxBuilderz = 9; // typo: unknown keys are errors
    writeFileSync(path, JSON.stringify(cfg));
    const doctor = run(['doctor', '--home', home]);
    assert.match(doctor.stdout, /✗ project demo — invalid config: .*maxBuilderz is not a known setting/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('help and unknown commands', () => {
  assert.match(run(['help']).stdout, /Usage: autopilot <command>/);
  const bad = run(['frobnicate']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command/);
});

test('the CLI runs when it is started through symlinks, as npm link installs it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  // npm link makes <prefix>/lib/node_modules/<package> point at the repository and
  // <prefix>/bin/autopilot point at bin/autopilot.ts inside that link.
  const pkgLink = join(tmp, 'lib', 'node_modules', 'stayon-autopilot');
  try {
    mkdirSync(dirname(pkgLink), { recursive: true });
    symlinkSync(resolve(import.meta.dirname, '..'), pkgLink, 'dir');
    mkdirSync(join(tmp, 'bin'));
    symlinkSync(join('..', 'lib', 'node_modules', 'stayon-autopilot', 'bin', 'autopilot.ts'), join(tmp, 'bin', 'autopilot'));
    const env = {
      ...process.env,
      PATH: [join(tmp, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      AUTOPILOT_HOME: join(tmp, 'home'),
    };
    // Found on the PATH and started through its #! line, like a user typing `autopilot`.
    const help = spawnSync('autopilot', ['--help'], { encoding: 'utf8', env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: autopilot <command>/);
    const status = spawnSync('autopilot', ['status'], { encoding: 'utf8', env });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /No projects yet/);
    assert.ok(existsSync(join(tmp, 'home', 'autopilot.db')));
    // node <symlink> as well.
    const viaNode = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(tmp, 'bin', 'autopilot'), 'help'], { encoding: 'utf8', env });
    assert.match(viaNode.stdout, /Usage: autopilot <command>/);
  } finally {
    // Remove the link to the repository first: unlink never follows it.
    try {
      unlinkSync(pkgLink);
    } catch {
      /* not created */
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
