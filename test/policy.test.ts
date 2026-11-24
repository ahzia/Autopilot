// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, type ProjectConfig } from '../src/config.ts';
import { expandBraces, filesMatching, GlobError, globProblems, globToRegExp, matchesAny, ownershipOverlaps } from '../src/policy/glob.ts';
import { binaryFiles, classifyMerge, MAX_AUTO_MERGE_DELETIONS, reviewCardText, touchedPaths, type MergeInputs } from '../src/policy/merge-policy.ts';
import type { CheckRecord, DiffFile, ReviewRecord, Task } from '../src/types.ts';

// ------------------------------------------------------------------- globs

const GLOB_TABLE: Array<[glob: string, path: string, matches: boolean]> = [
  ['**/package.json', 'package.json', true],
  ['**/package.json', 'apps/web/package.json', true],
  ['**/package.json', 'apps/web/package.json.bak', false],
  ['**/package.json', 'mypackage.json', false],
  ['package.json', 'package.json', true],
  ['package.json', 'apps/web/package.json', false],
  ['.github/**', '.github/workflows/ci.yml', true],
  ['.github/**', '.github', true],
  ['.github/**', 'docs/.github/ci.yml', false],
  ['.github/**', '.githubx/ci.yml', false],
  ['*.md', 'README.md', true],
  ['*.md', 'docs/guide.md', false],
  ['*.md', '.hidden.md', true],
  ['**/*.md', 'docs/guide.md', true],
  ['**/*.md', 'README.md', true],
  ['CLAUDE.md', 'CLAUDE.md', true],
  ['CLAUDE.md', 'docs/CLAUDE.md', false],
  ['CLAUDE.md', 'claude.md', false],
  ['{a,b}/x.ts', 'a/x.ts', true],
  ['{a,b}/x.ts', 'b/x.ts', true],
  ['{a,b}/x.ts', 'c/x.ts', false],
  ['src/{api,web}/**/*.ts', 'src/web/pages/home.ts', true],
  ['src/{api,web}/**/*.ts', 'src/lib/util.ts', false],
  ['{a,{b,c}}.ts', 'c.ts', true],
  ['{a}.ts', '{a}.ts', true],
  ['{a}.ts', 'a.ts', false],
  ['a/**/b', 'a/b', true],
  ['a/**/b', 'a/x/y/b', true],
  ['a/**/b', 'a/xb', false],
  ['**', 'deep/nested/.env', true],
  ['**/.env*', '.env', true],
  ['**/.env*', 'apps/api/.env.production', true],
  ['**/.env*', 'apps/api/config.env', false],
  ['**/*.pem', 'certs/dev/server.pem', true],
  ['**/migrations/**', 'db/migrations/001_init.sql', true],
  ['**/migrations/**', 'db/migrations_old/001.sql', false],
  ['**/docker-compose*.yml', 'ops/docker-compose.prod.yml', true],
  ['src/*.ts', 'src/index.ts', true],
  ['src/*.ts', 'src/lib/index.ts', false],
  // "**" that is not a whole segment means "*" (bash, .gitignore, minimatch).
  ['src/**.test.ts', 'src/b.test.ts', true],
  ['src/**.test.ts', 'src/a/b.test.ts', false],
  ['**.md', 'README.md', true],
  ['**.md', 'docs/guide.md', false],
  ['a**b', 'axyb', true],
  ['a**b', 'a/b', false],
  ['src/**/*.test.ts', 'src/a/b.test.ts', true],
  // ".." is not resolved: such a pattern matches no repo path.
  ['src/../lib/**', 'lib/a.ts', false],
  ['?.txt', 'a.txt', true],
  ['?.txt', 'ab.txt', false],
  ['[abc].js', 'b.js', true],
  ['[abc].js', 'd.js', false],
  ['[!abc].js', 'd.js', true],
  ['[!abc].js', 'a.js', false],
  ['v[0-9].json', 'v7.json', true],
  ['app/(auth)/page.tsx', 'app/(auth)/page.tsx', true],
  ['a+b.ts', 'aab.ts', false],
  ['\\*.md', '*.md', true],
  ['\\*.md', 'notes.md', false],
  ['[abc', '[abc', true],
  ['./src/**', 'src/main.ts', true],
  ['docs/', 'docs/a/b.md', true],
  ['docs/', 'docsx/a.md', false],
];

test('glob table', () => {
  for (const [glob, path, expected] of GLOB_TABLE) {
    assert.equal(globToRegExp(glob).test(path), expected, `${JSON.stringify(glob)} vs ${JSON.stringify(path)}`);
  }
});

test('glob helpers: nocase, matchesAny, filesMatching, brace cap', () => {
  assert.equal(globToRegExp('CLAUDE.md', { nocase: true }).test('claude.md'), true);
  assert.equal(matchesAny('./package.json', ['package.json']), true, 'a leading ./ on the path is ignored');
  assert.equal(matchesAny('src/a.ts', []), false);
  assert.deepEqual(filesMatching(['b.md', 'src/x.ts', 'a.md', 'docs/c.md'], ['*.md']), ['b.md', 'a.md'], 'input order kept');
  assert.deepEqual(expandBraces('x/{a,b{c,d}}'), ['x/a', 'x/bc', 'x/bd']);
  const explosive = '{a,b}'.repeat(9); // 512 alternatives
  assert.throws(() => globToRegExp(explosive), GlobError);
  assert.equal(ownershipOverlaps([explosive], ['docs/**']), true, 'unanalyzable globs are assumed to overlap');
  assert.deepEqual(globProblems(['src/**', '**/*.{ts,tsx}', '[abc']), [], 'usable globs (an unterminated class is literal)');
  const problems = globProblems(['docs/**', explosive]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /more than 256 alternatives/);
});

test('ownership overlap is conservative', () => {
  const cases: Array<[string[], string[], boolean]> = [
    [[], ['src/**'], true],
    [['src/**'], [], true],
    [['**'], ['docs/readme.md'], true],
    [['src/app/**'], ['src/lib/**'], false],
    [['src/app/**'], ['src/app/page.tsx'], true],
    [['src/**'], ['src/app/**'], true],
    [['src/app'], ['src/application/**'], false],
    [['*.md'], ['src/x.ts'], true],
    [['{src,lib}/**'], ['lib/util/**'], true],
    [['{src,lib}/**'], ['docs/**'], false],
    [['src/components/*.tsx'], ['src/components/Button.tsx'], true],
    [['src/a/**', 'docs/**'], ['README.md', 'docs/guide.md'], true],
    [['apps/web/**'], ['apps/api/**'], false],
    [['package.json'], ['apps/web/**'], false],
    [['**/package.json'], ['apps/web/**'], true],
    [['src/Auth/**'], ['src/auth/session.ts'], true],
    [['a/**'], ['b/**'], false],
    [['src/**.ts'], ['src/a/b.ts'], true],
    // Globs that cannot be placed in the repo tree are unknown: they overlap everything.
    [['src/../lib/**'], ['lib/util.ts'], true],
    [['../lib/**'], ['lib/util.ts'], true],
    [['/Users/founder/app/src/**'], ['src/feed.ts'], true],
    [['~/app/src/**'], ['docs/**'], true],
    [['C:/app/src/**'], ['docs/**'], true],
    [['C:\\app\\src\\**'], ['docs/**'], true],
    [['src\\..\\lib\\**'], ['docs/**'], true],
    [['{src,..}/x/**'], ['docs/**'], true],
    [['docs/**', '/abs/**'], ['src/a.ts'], true],
    [['./src/a/**'], ['src/b/**'], false],
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(ownershipOverlaps(a, b), expected, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    assert.equal(ownershipOverlaps(b, a), expected, `symmetric: ${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
  }
});

// ------------------------------------------------------------ merge policy

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T-12',
    projectId: 'demo',
    title: 'Add Today feed',
    objective: 'Show the items due today',
    nonGoals: [],
    acceptanceCriteria: [],
    role: 'full-stack',
    kind: 'build',
    priority: 3,
    risk: 'low',
    ownedPaths: ['src/today/**'],
    dependsOn: [],
    state: 'merging',
    stateReason: null,
    origin: 'planner',
    hypothesis: null,
    branch: 'autopilot/t-12-add-today-feed',
    worktree: '/tmp/ap-wt',
    baseCommit: BASE,
    headCommit: HEAD,
    prNumber: null,
    prUrl: null,
    attempts: 1,
    repairCycles: 0,
    lastSessionId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 3,
    notes: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function configWith(mutate?: (c: ProjectConfig) => void): ProjectConfig {
  const c = defaultConfig('demo', 'Demo', '/tmp/demo');
  c.checks.commands = [
    { name: 'lint', run: ['npm', 'run', 'lint'], timeoutSeconds: 300 },
    { name: 'test', run: ['npm', 'test'], timeoutSeconds: 600 },
  ];
  mutate?.(c);
  return c;
}

let nextId = 1;
function check(name: string, status: CheckRecord['status'], over: Partial<CheckRecord> = {}): CheckRecord {
  const id = nextId++;
  return { id, taskId: 'T-12', headCommit: HEAD, scope: 'branch', name, command: ['npm', name], status, durationMs: 900, outputTail: '', at: 1000 + id, ...over };
}

function review(over: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id: 1, taskId: 'T-12', runId: 'R-3', headCommit: HEAD, verdict: 'approve', risk: 'low', summary: 'Adds the Today feed with tests.', findings: [], at: 2000, ...over };
}

const DEFAULT_FILES: DiffFile[] = [
  { path: 'src/today/feed.ts', added: 120, deleted: 4, status: 'M' },
  { path: 'src/today/feed.test.ts', added: 60, deleted: 0, status: 'A' },
];

function inputs(over: Partial<MergeInputs> = {}, files: DiffFile[] = DEFAULT_FILES, patch = ''): MergeInputs {
  const config = over.config ?? configWith();
  return {
    task: makeTask(),
    config,
    diff: { baseCommit: BASE, headCommit: HEAD, files, patch, truncated: false },
    checks: config.checks.commands.map((c) => check(c.name, 'passed')),
    review: review(),
    pendingBlocking: 0,
    openChangeRequests: 0,
    ...over,
  };
}

const withFile = (path: string, extra: Partial<DiffFile> = {}): DiffFile[] => [...DEFAULT_FILES, { path, added: 5, deleted: 1, status: 'M', ...extra }];

interface MatrixCase {
  name: string;
  input: MergeInputs;
  action: 'auto_merge' | 'human_review' | 'repair' | 'reject';
  reason?: RegExp;
}

const MATRIX: MatrixCase[] = [
  { name: 'eligible', input: inputs(), action: 'auto_merge' },
  { name: 'sensitive file', input: inputs({}, withFile('src/auth/session.ts')), action: 'human_review', reason: /sensitive files: src\/auth\/session\.ts/ },
  { name: 'sensitive dependency manifest', input: inputs({}, withFile('apps/web/package.json')), action: 'human_review', reason: /sensitive files/ },
  { name: 'sensitive file, other case', input: inputs({}, withFile('claude.md')), action: 'human_review', reason: /sensitive files: claude\.md/ },
  { name: 'protected file', input: inputs({}, withFile('.autopilot/policy.json')), action: 'reject', reason: /protected policy files: \.autopilot\/policy\.json/ },
  {
    name: 'protected wins over failing checks and missing review',
    input: inputs({ checks: [check('lint', 'failed')], review: null }, withFile('.claude/settings.json')),
    action: 'reject',
  },
  { name: 'missing check record', input: inputs({ checks: [check('lint', 'passed')] }), action: 'repair', reason: /check "test" has no result for this revision/ },
  { name: 'failed check', input: inputs({ checks: [check('lint', 'failed'), check('test', 'passed')] }), action: 'repair', reason: /check "lint" failed/ },
  { name: 'timed-out check', input: inputs({ checks: [check('lint', 'passed'), check('test', 'timeout')] }), action: 'repair', reason: /check "test" timed out/ },
  { name: 'check that could not run', input: inputs({ checks: [check('lint', 'error'), check('test', 'passed')] }), action: 'repair', reason: /check "lint" could not run/ },
  {
    name: 'checks passed only on an older head',
    input: inputs({ checks: [check('lint', 'passed', { headCommit: OLD_HEAD }), check('test', 'passed', { headCommit: OLD_HEAD })] }),
    action: 'repair',
    reason: /no result for this revision/,
  },
  {
    name: 'integration-scope records are not branch evidence',
    input: inputs({ checks: [check('lint', 'passed', { scope: 'integration' }), check('test', 'passed')] }),
    action: 'repair',
    reason: /check "lint" has no result/,
  },
  {
    name: 'latest record per check wins',
    input: inputs({ checks: [check('lint', 'failed', { at: 10 }), check('lint', 'passed', { at: 20 }), check('test', 'passed')] }),
    action: 'auto_merge',
  },
  { name: 'review of an older head', input: inputs({ review: review({ headCommit: OLD_HEAD }) }), action: 'human_review', reason: /^no independent review of this exact revision$/ },
  { name: 'no review at all', input: inputs({ review: null }), action: 'human_review', reason: /^no independent review of this exact revision$/ },
  { name: 'reviewer requested changes', input: inputs({ review: review({ verdict: 'request_changes' }) }), action: 'repair', reason: /reviewer requested changes/ },
  { name: 'founder requested changes', input: inputs({ review: review({ verdict: 'human_request_changes' }) }), action: 'repair', reason: /founder requested changes/ },
  { name: 'reviewer needs a human', input: inputs({ review: review({ verdict: 'needs_human' }) }), action: 'human_review', reason: /asked for a human decision/ },
  {
    name: 'approve with a blocker finding',
    input: inputs({ review: review({ findings: [{ severity: 'blocker', issue: 'drops user data' }] }) }),
    action: 'human_review',
    reason: /approved but reported 1 blocker\/major finding$/,
  },
  { name: 'approve with a major finding', input: inputs({ review: review({ findings: [{ severity: 'major', issue: 'n+1 query' }] }) }), action: 'human_review' },
  {
    name: 'approve with minor findings only',
    input: inputs({ review: review({ findings: [{ severity: 'minor', issue: 'naming' }, { severity: 'nit', issue: 'typo' }] }) }),
    action: 'auto_merge',
  },
  {
    name: 'founder approval of this revision is the merge decision',
    input: inputs({ review: review({ verdict: 'human_approve' }), task: makeTask({ risk: 'high' }) }, withFile('src/auth/session.ts')),
    action: 'auto_merge',
    reason: /founder approved this exact revision/,
  },
  {
    name: 'founder approval of an older revision does not count',
    input: inputs({ review: review({ verdict: 'human_approve', headCommit: OLD_HEAD }) }),
    action: 'human_review',
    reason: /no independent review/,
  },
  {
    name: 'founder approval under the pause profile',
    input: inputs({ review: review({ verdict: 'human_approve' }), config: configWith((c) => (c.profile = 'pause')) }),
    action: 'human_review',
    reason: /paused/,
  },
  { name: 'pending blocking decision', input: inputs({ pendingBlocking: 2 }), action: 'human_review', reason: /^2 blocking decisions still pending$/ },
  { name: 'open change request', input: inputs({ openChangeRequests: 1 }), action: 'human_review', reason: /^1 open change request$/ },
  {
    name: 'supervised profile',
    input: inputs({ config: configWith((c) => (c.profile = 'supervised')) }),
    action: 'human_review',
    reason: /^profile supervised requires a human merge decision$/,
  },
  {
    name: 'auto-merge turned off',
    input: inputs({ config: configWith((c) => (c.integration.autoMerge = false)) }),
    action: 'human_review',
    reason: /auto-merge is turned off/,
  },
  {
    name: 'oversized change',
    input: inputs({}, [{ path: 'src/today/feed.ts', added: 1400, deleted: 200, status: 'M' }]),
    action: 'human_review',
    reason: /changes 1600 lines \(auto-merge limit 1500\)/,
  },
  {
    name: 'allowedPaths violation',
    input: inputs({ config: configWith((c) => (c.integration.allowedPaths = ['src/**'])) }, withFile('docs/notes.md')),
    action: 'human_review',
    reason: /outside the auto-merge allowed paths: docs\/notes\.md$/,
  },
  { name: 'allowedPaths satisfied', input: inputs({ config: configWith((c) => (c.integration.allowedPaths = ['src/**'])) }), action: 'auto_merge' },
  { name: 'high-risk task', input: inputs({ task: makeTask({ risk: 'high' }) }), action: 'human_review', reason: /task is rated high risk/ },
  { name: 'reviewer rates high risk', input: inputs({ review: review({ risk: 'high' }) }), action: 'human_review', reason: /reviewer rated the change high risk/ },
  { name: 'unknown risk alone does not block', input: inputs({ task: makeTask({ risk: 'unknown' }) }), action: 'auto_merge' },
  {
    name: 'mass deletion',
    input: inputs({}, Array.from({ length: MAX_AUTO_MERGE_DELETIONS + 1 }, (_, n) => ({ path: `src/old/f${n}.ts`, added: 0, deleted: 3, status: 'D' }))),
    action: 'human_review',
    reason: /deletes 26 files/,
  },
  { name: 'integration task', input: inputs({ task: makeTask({ kind: 'integration' }) }), action: 'human_review', reason: /integration tasks always need/ },
  { name: 'empty branch', input: inputs({}, []), action: 'human_review', reason: /no changes to merge/ },
  { name: 'review optional and absent', input: inputs({ review: null, config: configWith((c) => (c.integration.requireAgentReview = false)) }), action: 'auto_merge' },
  {
    name: 'review optional but negative still counts',
    input: inputs({ review: review({ verdict: 'request_changes' }), config: configWith((c) => (c.integration.requireAgentReview = false)) }),
    action: 'repair',
  },
  {
    name: 'rename out of a protected path (patch header)',
    input: inputs(
      {},
      withFile('src/policy-copy.json', { status: 'A' }),
      'diff --git a/.autopilot/policy.json b/src/policy-copy.json\nsimilarity index 100%\nrename from .autopilot/policy.json\nrename to src/policy-copy.json\n',
    ),
    action: 'reject',
    reason: /\.autopilot\/policy\.json/,
  },
  { name: 'rename notation in a file path', input: inputs({}, withFile('{.autopilot => src}/policy.json', { status: 'R' })), action: 'reject' },
  {
    name: 'binary file added (patch header)',
    input: inputs({}, withFile('public/app.wasm', { added: 0, deleted: 0, status: 'A' }), binaryPatch('Binary files /dev/null and b/public/app.wasm differ')),
    action: 'human_review',
    reason: /binary files, which are not line-counted or reviewable as text: public\/app\.wasm$/,
  },
  {
    name: 'binary file modified (patch header)',
    input: inputs({}, withFile('assets/logo.png', { added: 0, deleted: 0 }), binaryPatch('Binary files a/assets/logo.png and b/assets/logo.png differ')),
    action: 'human_review',
    reason: /binary files.*assets\/logo\.png/,
  },
  {
    name: 'binary file flagged by the forge',
    input: inputs({}, withFile('dist/bundle.bin', { added: 0, deleted: 0, status: 'A', binary: true } as Partial<DiffFile>)),
    action: 'human_review',
    reason: /binary files.*dist\/bundle\.bin/,
  },
  {
    name: 'binary file deleted',
    input: inputs({}, withFile('old/blob.bin', { added: 0, deleted: 0, status: 'D' }), binaryPatch('Binary files a/old/blob.bin and /dev/null differ')),
    action: 'auto_merge',
  },
];

/** A patch with one binary-file section (git prints no hunks for binary files). */
function binaryPatch(binaryLine: string): string {
  return `diff --git a/x b/x\nindex 1111111..2222222 100644\n${binaryLine}\n`;
}

test('merge classification matrix', () => {
  for (const c of MATRIX) {
    const v = classifyMerge(c.input);
    assert.equal(v.action, c.action, `${c.name}: got ${v.action} (${v.reasons.join('; ')})`);
    if (c.reason) assert.ok(v.reasons.some((r) => c.reason!.test(r)), `${c.name}: no reason matches ${c.reason} in ${JSON.stringify(v.reasons)}`);
  }
});

test('verdict details: risk, files, line count, every failed condition listed', () => {
  const eligible = classifyMerge(inputs());
  assert.equal(eligible.changedLines, 184);
  assert.equal(eligible.risk, 'low');
  assert.deepEqual(eligible.sensitiveFiles, []);
  assert.deepEqual(eligible.protectedFiles, []);

  const sensitive = classifyMerge(inputs({}, withFile('src/auth/session.ts')));
  assert.equal(sensitive.risk, 'medium', 'sensitive files raise risk to at least medium');
  assert.deepEqual(sensitive.sensitiveFiles, ['src/auth/session.ts']);

  assert.equal(classifyMerge(inputs({ task: makeTask({ risk: 'unknown' }) })).risk, 'medium', 'unknown displays as medium');
  assert.equal(classifyMerge(inputs({ review: review({ risk: 'high' }) })).risk, 'high', 'max of task and review risk');

  const many = classifyMerge(
    inputs(
      { task: makeTask({ risk: 'high', kind: 'integration' }), config: configWith((c) => ((c.profile = 'supervised'), (c.integration.maxAutoMergeLines = 10))) },
      withFile('.github/workflows/ci.yml'),
    ),
  );
  assert.equal(many.action, 'human_review');
  for (const re of [/profile supervised/, /sensitive files: \.github\/workflows\/ci\.yml/, /auto-merge limit 10/, /high risk/, /integration tasks/]) {
    assert.ok(many.reasons.some((r) => re.test(r)), `missing ${re} in ${JSON.stringify(many.reasons)}`);
  }
});

test('binary files are found from patch headers and forge flags', () => {
  const patch = [
    'diff --git a/salt and pepper.png b/salt and pepper.png',
    'index 1111111..2222222 100644',
    'Binary files a/salt and pepper.png and b/salt and pepper.png differ',
    'diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"',
    'new file mode 100644',
    'index 0000000..2222222',
    'Binary files /dev/null and "b/caf\\303\\251.png" differ',
    'diff --git a/gone.bin b/gone.bin',
    'deleted file mode 100644',
    'Binary files a/gone.bin and /dev/null differ',
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-Binary files a/fake.png and b/fake.png differ',
    '+text',
    'Binary files a/cut.png and b/cut',
  ].join('\n');
  const files: DiffFile[] = [
    { path: 'src/a.ts', added: 1, deleted: 1, status: 'M' },
    { path: 'img/{old => new}.webp', added: 0, deleted: 0, status: 'R', binary: true } as DiffFile,
    { path: 'gone2.bin', added: 0, deleted: 0, status: 'D', binary: true } as DiffFile,
  ];
  const found = binaryFiles({ baseCommit: BASE, headCommit: HEAD, files, patch, truncated: true });
  assert.deepEqual(found.sort(), ['café.png', 'img/new.webp', 'salt and pepper.png']);
  assert.deepEqual(binaryFiles({ baseCommit: BASE, headCommit: HEAD, files: DEFAULT_FILES, patch: '', truncated: false }), []);
});

test('an unusable policy glob fails loudly, naming the setting', () => {
  const explosive = '{a,b}'.repeat(9);
  const broken = inputs({ config: configWith((c) => c.integration.sensitivePaths.push(explosive)) });
  assert.throws(
    () => classifyMerge(broken),
    (err: unknown) => err instanceof GlobError && /integration\.sensitivePaths: .*more than 256 alternatives/.test(err.message),
  );
  const brokenAllowed = inputs({ config: configWith((c) => (c.integration.allowedPaths = [explosive])) });
  assert.throws(() => classifyMerge(brokenAllowed), /integration\.allowedPaths/);
});

test('touched paths include rename sources and unquoted patch paths', () => {
  const patch = [
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 90%',
    'rename from old name.txt',
    'rename to new name.txt',
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
    'index 1111111..2222222 100644',
    '--- "a/caf\\303\\251.md"',
    '+++ "b/caf\\303\\251.md"',
    '@@ -1 +1 @@',
    '--- a/not-a-header-line-inside-a-hunk',
    '+new',
    '',
  ].join('\n');
  const paths = touchedPaths({ baseCommit: BASE, headCommit: HEAD, files: [{ path: 'new name.txt', added: 1, deleted: 1, status: 'R' }], patch, truncated: false });
  assert.deepEqual(paths.sort(), ['café.md', 'new name.txt', 'old name.txt']);
});

test('review card text is short and phone-friendly', () => {
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const longSummary = `Adds the feed. Token ${secret} was in a fixture. ` + 'Detail. '.repeat(80);
  const i = inputs({ review: review({ summary: longSummary, risk: 'medium' }) }, withFile('src/auth/session.ts'));
  const v = classifyMerge(i);
  const card = reviewCardText(v, i);
  assert.equal(card.question, 'Merge T-12 "Add Today feed" (changes auth files)?');
  assert.match(card.why, /^Needs your decision: changes sensitive files: src\/auth\/session\.ts\./);
  assert.match(card.why, /190 changed lines/);
  assert.match(card.why, /Checks: 2\/2 passed \(lint, test\)/);
  assert.match(card.why, /Review \(approved, medium risk\): Adds the feed\./);
  assert.ok(!card.why.includes(secret), 'reviewer summary is redacted');
  const reviewText = card.why.split('\n').find((l) => l.startsWith('Review'))!;
  assert.ok(reviewText.length < 300 + 60, `review line is clipped (${reviewText.length} chars)`);
  assert.ok(reviewText.endsWith('…'));

  const plain = inputs({
    config: configWith((c) => (c.profile = 'supervised')),
    task: makeTask({ id: 'T-7', title: 'Tidy\nthe   footer' }),
    checks: [check('lint', 'passed', { taskId: 'T-7' }), check('test', 'passed', { taskId: 'T-7' })],
    review: review({ taskId: 'T-7' }),
  });
  const plainCard = reviewCardText(classifyMerge(plain), plain);
  assert.equal(plainCard.question, 'Merge T-7 "Tidy the footer"?');
  assert.match(plainCard.why, /^Needs your decision: profile supervised requires a human merge decision\./);

  const failing = inputs({ checks: [check('lint', 'failed'), check('test', 'passed')] });
  const failingCard = reviewCardText(classifyMerge(failing), failing);
  assert.match(failingCard.question, /^Repair T-12 .*check "lint" failed/);
  assert.match(failingCard.why, /Checks: 1\/2 passed \(test\); lint failed\./);

  const binary = inputs({}, withFile('public/app.wasm', { added: 0, deleted: 0, status: 'A' }), binaryPatch('Binary files /dev/null and b/public/app.wasm differ'));
  assert.equal(reviewCardText(classifyMerge(binary), binary).question, 'Merge T-12 "Add Today feed" (changes binary files)?');

  const hooks = inputs({ config: configWith((c) => c.integration.sensitivePaths.push('.husky/**', '**/Dockerfile.*')) }, withFile('.husky/pre-commit'));
  assert.equal(reviewCardText(classifyMerge(hooks), hooks).question, 'Merge T-12 "Add Today feed" (changes dev tooling files)?');
  const docker = inputs({ config: configWith((c) => c.integration.sensitivePaths.push('**/Dockerfile.*')) }, withFile('ops/Dockerfile.prod'));
  assert.equal(reviewCardText(classifyMerge(docker), docker).question, 'Merge T-12 "Add Today feed" (changes deploy config files)?');
});
