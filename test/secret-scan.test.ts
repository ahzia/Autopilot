// SPDX-License-Identifier: MIT
// The secret scan over a branch's history: how findSecrets reads git's patches (file
// headers, hunks, the combined diffs of merge commits) and what the supervisor's
// scanCommits finds in real repositories.

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor } from '../src/supervisor.ts';
import type { Task } from '../src/types.ts';
import { findSecrets } from '../src/util.ts';
import { approve, builderResult, commitFile, git, harness, type Harness } from './drills/harness.ts';

// Keep the developer's own git configuration (signing, hooks, default branch) out of these tests.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// Key-shaped values, built at run time so that this file holds none.
const AWS_KEY = `AKIA${'Z'.repeat(16)}`;
const GITHUB_TOKEN = `ghp_${'A'.repeat(36)}`;
const ANTHROPIC_KEY = `sk-ant-${'c'.repeat(40)}`;
const SLACK_TOKEN = `xoxb-${'1'.repeat(24)}`;
const GOOGLE_KEY = `AIza${'B'.repeat(35)}`;
/** The example access key from the AWS documentation, which real repositories quote. */
const AWS_DOCS_EXAMPLE_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

type Scan = { secrets: { file: string; kind: string }[]; incomplete: string | null };

/** A fresh repository with one commit on main; `g` runs git in it and returns trimmed stdout. */
function repo(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-secret-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=W', '-c', 'user.email=w@example.com', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file: string, content: string) => fs.writeFileSync(path.join(dir, file), content);
  g('init', '-q', '-b', 'main');
  write('README.md', 'hi\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return { dir, g, write };
}

/** The supervisor's scan of base..head (a private method; it only needs the repository path). */
function scanCommits(dir: string, base: string, head: string): Promise<Scan> {
  const sup = new Supervisor({ log: () => undefined } as any) as any;
  return sup.scanCommits({ barePath: dir }, base, head);
}

test('"+++ " names a file only in its header: inside a hunk it is an added line starting with "++"', () => {
  const patch = [
    'diff --git a/notes.md b/notes.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/notes.md',
    '@@ -0,0 +1,4 @@',
    `+++ ${AWS_KEY}`, // the line "++ AKIA..."
    `+++${GITHUB_TOKEN}`, // "++ghp_..."
    '+++ b/.env', // "++ b/.env": content, not the header of an environment file
    `+--- ${ANTHROPIC_KEY}`, // "--- sk-ant-...": content as well
    'diff --cc merged.md',
    'index 1111111,2222222..3333333',
    '--- a/merged.md',
    '+++ b/merged.md',
    '@@@ -1,1 -1,1 +1,2 @@@',
    '  same',
    `+++ also ${AWS_KEY}`, // a merge's own line "+ also AKIA..." ("++" columns: no parent has it)
    'diff --git a/.env b/.env',
    'new file mode 100644',
    'index 0000000..4444444',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    '+X=1',
  ].join('\n');
  assert.deepEqual(findSecrets(patch), [
    { file: 'notes.md', kind: 'AWS access key' },
    { file: 'notes.md', kind: 'GitHub token' },
    { file: 'notes.md', kind: 'Anthropic API key' },
    { file: 'merged.md', kind: 'AWS access key' },
    { file: '.env', kind: 'environment file' },
  ]);
});

test('scanCommits finds a key on an added line that starts with "++", in a commit and in a merge commit', async (t) => {
  const { dir, g, write } = repo(t);
  const base = g('rev-parse', 'HEAD');
  write('notes.md', `++ ${AWS_KEY}\n`);
  g('add', '.');
  g('commit', '-q', '-m', 'notes');
  g('checkout', '-q', '-b', 'side', base);
  write('side.txt', 'side\n');
  g('add', '.');
  g('commit', '-q', '-m', 'side');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--no-ff', '--no-commit', 'side');
  write('merged.md', `+ ${GITHUB_TOKEN}\n`); // only the merge commit adds this file
  g('add', '.');
  g('commit', '-q', '--no-edit');
  const found = await scanCommits(dir, base, g('rev-parse', 'HEAD'));
  assert.equal(found.incomplete, null);
  assert.deepEqual(
    found.secrets.sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: 'merged.md', kind: 'GitHub token' },
      { file: 'notes.md', kind: 'AWS access key' },
    ],
  );
});

test("in a merge commit's combined diff, a line is added only when no parent has it", () => {
  const patch = [
    'diff --cc docs.md',
    'index eeb8e3d,d1d0bf5..7485355',
    '--- a/docs.md',
    '+++ b/docs.md',
    '@@@ -1,3 -1,3 +1,5 @@@',
    '  intro',
    ` +example: ${ANTHROPIC_KEY}`, // the first parent has this line
    `+ example: ${AWS_KEY}`, // the second parent (say, main) has this line
    `++token: ${GITHUB_TOKEN}`, // neither has it: the merge itself adds it
    '  end',
    'diff --cc three.md',
    'index 1111111,2222222,3333333..4444444',
    '--- a/three.md',
    '+++ b/three.md',
    '@@@@ -1,1 -1,1 -1,1 +1,3 @@@@',
    '   same',
    `+ +slack: ${SLACK_TOKEN}`, // the second of three parents has it
    `+++google: ${GOOGLE_KEY}`, // no parent has it
    'diff --git a/one.md b/one.md',
    'index 5555555..6666666 100644',
    '--- a/one.md',
    '+++ b/one.md',
    '@@ -1 +1,2 @@',
    ' x',
    `+${AWS_KEY}`, // an ordinary single-parent diff again
  ].join('\n');
  assert.deepEqual(findSecrets(patch), [
    { file: 'docs.md', kind: 'GitHub token' },
    { file: 'three.md', kind: 'Google API key' },
    { file: 'one.md', kind: 'AWS access key' },
  ]);
});

test('scanCommits reports what a merge adds itself, not what it keeps from a parent when resolving a conflict', async (t) => {
  const { dir, g, write } = repo(t);
  write('docs.md', 'intro\nexample: TODO\nend\n');
  g('add', '.');
  g('commit', '-q', '-m', 'docs');
  const fork = g('rev-parse', 'HEAD');
  write('docs.md', `intro\nexample: ${AWS_DOCS_EXAMPLE_KEY} (from the AWS docs)\nend\n`);
  g('commit', '-q', '-am', 'main quotes the documented example key');
  g('checkout', '-q', '-b', 'task', fork);
  write('docs.md', 'intro\nexample: use your own key\nend\n');
  g('commit', '-q', '-am', 'the task edits the same line');
  assert.throws(() => g('merge', '-q', 'main'), 'the merge conflicts');
  // The builder resolves the conflict by keeping both lines.
  write('docs.md', `intro\nexample: use your own key\nexample: ${AWS_DOCS_EXAMPLE_KEY} (from the AWS docs)\nend\n`);
  g('add', 'docs.md');
  g('commit', '-q', '--no-edit');
  const base = g('merge-base', 'main', 'HEAD'); // where the supervisor's scan starts: main's tip
  assert.equal(base, g('rev-parse', 'main'));
  assert.deepEqual(await scanCommits(dir, base, g('rev-parse', 'HEAD')), { secrets: [], incomplete: null });

  // A key that the resolution itself adds is still found.
  write('docs.md', `intro\nexample: use your own key\nexample: ${AWS_DOCS_EXAMPLE_KEY} (from the AWS docs)\ntoken: ${GITHUB_TOKEN}\nend\n`);
  g('commit', '-q', '-a', '--amend', '--no-edit');
  assert.equal(g('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'still a merge commit');
  assert.deepEqual(await scanCommits(dir, base, g('rev-parse', 'HEAD')), { secrets: [{ file: 'docs.md', kind: 'GitHub token' }], incomplete: null });
});

test('a builder that merges main and keeps both sides of a conflict is not sent back for what main already holds', { timeout: 60_000 }, async () => {
  const docs = (keyLine: boolean, last: string) => `intro\nexample: use your own key\n${keyLine ? `example: ${AWS_DOCS_EXAMPLE_KEY} (from the AWS docs)\n` : ''}${last}\n`;
  let ending: Task | undefined;
  let docsBuilds = 0;
  let h!: Harness;
  h = await harness({
    config: (c) => {
      c.execution.maxRepairCycles = 0; // a finding ends the task at once
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      if (spec.env.AUTOPILOT_TASK_ID === ending?.id) {
        await commitFile(ctl, 'docs.md', `intro\nexample: ${AWS_DOCS_EXAMPLE_KEY} (from the AWS docs)\nend of docs\n`, 'end of docs');
      } else {
        docsBuilds++;
        await commitFile(ctl, 'docs.md', docs(false, 'end'), 'use your own key');
        // Once the other task is on main, bring main in: the last line conflicts.
        while (!h.readTarget('docs.md')?.includes('end of docs')) await ctl.sleep(50);
        const asWorker = (...args: string[]) => ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', ...args]);
        await asWorker('merge', '--no-commit', 'main').catch(() => undefined);
        ctl.writeFile('docs.md', docs(true, 'end of docs')); // keep both sides
        await ctl.git(['add', 'docs.md']);
        await asWorker('commit', '-q', '--no-edit');
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    // main already quotes the documented example key (it was there before the autopilot).
    fs.writeFileSync(path.join(h.src, 'docs.md'), `intro\nexample: ${AWS_DOCS_EXAMPLE_KEY} (from the AWS docs)\nend\n`);
    git(h.src, 'add', 'docs.md');
    git(h.src, 'commit', '-q', '-m', 'docs');
    ending = h.addTask('Ending');
    const t = h.addTask('Docs');
    await h.sup.start();
    await h.waitState(ending.id, 'integrated');
    const done = await h.waitState(t.id, ['integrated', 'exhausted']);
    assert.equal(done.state, 'integrated', done.notes.map((n) => n.text).join('\n'));
    assert.equal(docsBuilds, 1);
    assert.equal(h.readTarget('docs.md'), docs(true, 'end of docs'));
  } finally {
    await h.cleanup();
  }
});

test('scanCommits reads the full message of every commit, whatever output encoding the repository config asks for', async (t) => {
  const { dir, g, write } = repo(t);
  const base = g('rev-parse', 'HEAD');
  write('a.txt', 'a\n');
  g('add', '.');
  g('commit', '-q', '-m', 'Add a', '-m', `Tested with ${AWS_KEY} for now.`);
  const withKey = g('rev-parse', 'HEAD');
  g('commit', '-q', '--allow-empty', '-m', 'Nothing to see');
  const head = g('rev-parse', 'HEAD');
  const expected = { secrets: [{ file: `the message of commit ${withKey.slice(0, 12)}`, kind: 'AWS access key' }], incomplete: null };
  assert.deepEqual(await scanCommits(dir, base, head), expected);
  // Workers can write the shared repository's config: messages printed as UTF-16 would hide the key.
  g('config', 'i18n.logOutputEncoding', 'UTF-16');
  assert.deepEqual(await scanCommits(dir, base, head), expected);
});

test('scanCommits fails closed when the commit messages are too large to scan', async (t) => {
  const { dir, g, write } = repo(t);
  const base = g('rev-parse', 'HEAD');
  write('message.txt', `${'x'.repeat(99)}\n`.repeat(340_000)); // 34 MB: more than the scan reads (32 MiB)
  const head = g('commit-tree', '-p', base, '-F', 'message.txt', `${base}^{tree}`);
  const found = await scanCommits(dir, base, head);
  assert.deepEqual(found.secrets, []);
  assert.match(found.incomplete ?? '', /^its commit messages hold more than 32 MiB of text/);
});

test('a key in a commit message is never published or merged', { timeout: 60_000 }, async () => {
  let builds = 0;
  const h = await harness({
    config: (c) => {
      c.integration.strategy = 'merge'; // the target keeps the branch's commits, messages included
    },
    behavior: (spec) => async (ctl) => {
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      builds++;
      if (builds === 1) {
        await commitFile(ctl, 'client.ts', 'export const key = process.env.API_KEY;\n', `Read the key from the environment\n\nIt was ${AWS_KEY} before.`);
      } else {
        const base = /git reset --soft ([0-9a-f]{12})/.exec(spec.prompt)![1];
        await ctl.git(['reset', '--soft', base]);
        await ctl.git(['-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'Read the key from the environment']);
      }
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Client');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    assert.equal(builds, 2, 'the branch with the key in a message was sent back');
    assert.ok(h.store.getTask(t.id)!.notes.some((n) => /Secret-looking content was committed \(AWS access key in the message of commit [0-9a-f]{12}\)/.test(n.text)));
    assert.equal(h.readTarget('client.ts'), 'export const key = process.env.API_KEY;\n');
    assert.equal(git(h.bare, 'log', 'main').includes(AWS_KEY), false, 'no message on main holds the key');
  } finally {
    await h.cleanup();
  }
});

test('scanCommits flags a .env file that a branch reaches by a pure rename, and not the content a rename only moves', async (t) => {
  const { dir, g, write } = repo(t);
  write('fixture.txt', `aws=${AWS_DOCS_EXAMPLE_KEY}\n`);
  g('add', '.');
  g('commit', '-q', '-m', 'a fixture that main already holds');
  const base = g('rev-parse', 'HEAD');
  write('settings.txt', 'DB_PASSWORD=not-a-known-key-shape\n');
  g('add', '.');
  g('commit', '-q', '-m', 'settings');
  g('mv', 'settings.txt', '.env'); // 100% similar: `git log -M` prints "rename to .env" and no "+++ b/.env"
  g('mv', 'fixture.txt', 'fixture-moved.txt');
  g('commit', '-q', '-m', 'rename');
  const found = await scanCommits(dir, base, g('rev-parse', 'HEAD'));
  assert.equal(found.incomplete, null);
  assert.deepEqual(found.secrets, [{ file: '.env', kind: 'environment file' }]);
});

test('scanCommits flags a .env file that a merge commit only renames from a file every parent has', async (t) => {
  const { dir, g, write } = repo(t);
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'task');
  write('settings.txt', 'DB_PASSWORD=not-a-known-key-shape\n');
  g('add', '.');
  g('commit', '-q', '-m', 'settings');
  g('checkout', '-q', '-b', 'side');
  write('y.md', 'y\n');
  g('add', '.');
  g('commit', '-q', '-m', 'side work');
  g('checkout', '-q', 'task');
  write('x.md', 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'more work');
  g('merge', '-q', '--no-ff', '--no-commit', 'side');
  g('mv', 'settings.txt', '.env'); // both parents hold settings.txt: `git log --cc -M` prints nothing for this merge
  g('commit', '-q', '-m', 'merge side');
  const found = await scanCommits(dir, base, g('rev-parse', 'HEAD'));
  assert.equal(found.incomplete, null);
  assert.deepEqual(found.secrets, [{ file: '.env', kind: 'environment file' }]);
});

test('scanCommits reports nothing for a merge of main whose new secret-looking line lands in a file the branch renamed', async (t) => {
  const { dir, g, write } = repo(t);
  write('fixture.txt', 'a\nb\nc\n');
  g('add', '.');
  g('commit', '-q', '-m', 'fixture on main');
  g('checkout', '-q', '-b', 'task');
  g('mv', 'fixture.txt', 'fixture-moved.txt');
  g('commit', '-q', '-m', 'task moves the fixture');
  g('checkout', '-q', 'main');
  fs.appendFileSync(path.join(dir, 'fixture.txt'), `aws=${AWS_DOCS_EXAMPLE_KEY}\n`);
  g('commit', '-q', '-am', 'main quotes the AWS docs key');
  const base = g('rev-parse', 'HEAD'); // the recorded target head: the line is on main already
  g('checkout', '-q', 'task');
  g('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const found = await scanCommits(dir, base, g('rev-parse', 'HEAD'));
  assert.equal(found.incomplete, null);
  assert.deepEqual(found.secrets, []);
});

test('scanCommits reports nothing for an ordinary merge of main that renamed a fixture', async (t) => {
  const { dir, g, write } = repo(t);
  write('fixture.txt', `aws=${AWS_DOCS_EXAMPLE_KEY}\n`);
  g('add', '.');
  g('commit', '-q', '-m', 'fixture on main');
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'task');
  write('feature.md', 'f\n');
  g('add', '.');
  g('commit', '-q', '-m', 'feature');
  g('checkout', '-q', 'main');
  g('mv', 'fixture.txt', 'fixture-moved.txt');
  g('commit', '-q', '-m', 'main moves the fixture');
  g('checkout', '-q', 'task');
  g('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const found = await scanCommits(dir, base, g('rev-parse', 'HEAD'));
  assert.equal(found.incomplete, null);
  assert.deepEqual(found.secrets, []);
});

test('findSecrets reads the file names git C-quotes, in "+++" and "rename to" lines', () => {
  const added = 'diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\nnew file mode 100644\n--- /dev/null\n+++ "b/caf\\303\\251/.env"\n@@ -0,0 +1 @@\n+DB_PASSWORD=hunter2\n';
  assert.deepEqual(findSecrets(added), [{ file: 'café/.env', kind: 'environment file' }]);
  const renamed = 'diff --git "a/caf\\303\\251/s.txt" "b/caf\\303\\251/.env"\nsimilarity index 100%\nrename from "caf\\303\\251/s.txt"\nrename to "caf\\303\\251/.env"\n';
  assert.deepEqual(findSecrets(renamed), [{ file: 'café/.env', kind: 'environment file' }]);
  assert.deepEqual(findSecrets('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+ok\n'), []);
});

test('scanCommits flags a .env file under a folder whose name git quotes', async (t) => {
  const { dir, g, write } = repo(t);
  const base = g('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dir, 'café'));
  write('café/.env', 'DB_PASSWORD=not-a-known-key-shape\n');
  g('add', '.');
  g('commit', '-q', '-m', 'settings');
  const found = await scanCommits(dir, base, g('rev-parse', 'HEAD'));
  assert.equal(found.incomplete, null);
  assert.deepEqual(found.secrets, [{ file: 'café/.env', kind: 'environment file' }]);
});

test('findSecrets flags an environment file in any case, and still skips the example files', () => {
  const added = (name: string) => `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+DB_PASSWORD=x\n`;
  assert.deepEqual(findSecrets(added('.ENV')), [{ file: '.ENV', kind: 'environment file' }]);
  assert.deepEqual(findSecrets(added('config/.Env.local')), [{ file: 'config/.Env.local', kind: 'environment file' }]);
  assert.deepEqual(findSecrets(added('.ENV.EXAMPLE')), []);
});
