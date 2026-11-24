// SPDX-License-Identifier: MIT
// Reviewers and the planner run with dontAsk and no edit tools, so their Bash rules must not let
// them write files: a prefix rule such as Bash(<command>:*) lets the agent append any option to
// the command (git diff --output=<file>, eslint -o <file> --fix, ...).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewerCheckCommands, reviewerPrompt } from '../src/prompts.ts';
import type { CheckRunner, DiffSummary, RunSpec, Task } from '../src/types.ts';
import { approve, builderResult, commitFile, harness } from './drills/harness.ts';

const T = { timeout: 60_000 };
const NO_PLAN = { summary: 'nothing new', newTasks: [], acceptTaskIds: [], cancelTaskIds: [], questions: [] };

/** The only prefix rules a read-only role keeps: these commands have no option that writes a file. */
const READ_ONLY_PREFIX_RULES = ['Bash(git status:*)', 'Bash(git ls-files:*)', 'Bash(ls:*)'];

/** Check commands the founder configured; a shell runs the first three exactly as configured. */
const CHECKS = [
  { name: 'test', run: ['npm', 'test'] },
  { name: 'whitespace', run: ['git', 'diff', '--check'] },
  { name: 'types', run: ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json'] },
  { name: 'lint', run: ['npx', 'eslint', 'src/**/*.ts'] },
  { name: 'inline', run: ['node', '-e', 'process.exit(0)'] },
  { name: 'spaced', run: ['sh', '-c', 'npm run lint'] },
  { name: 'suffix', run: ['make', 'check:*'] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether Claude Code pre-approves `command` with these rules: a Bash rule ending in ":*" matches
 * its prefix alone or followed by a space and anything, any other "*" matches any text, and other
 * Bash rules match the exact command.
 */
function allows(rules: string[], command: string): boolean {
  return rules.some((rule) => {
    const content = /^Bash\((.*)\)$/s.exec(rule)?.[1];
    if (content === undefined) return false;
    if (content.endsWith(':*')) {
      const prefix = content.slice(0, -2);
      return command === prefix || command.startsWith(`${prefix} `);
    }
    if (content.includes('*')) return new RegExp(`^${content.split('*').map(escapeRe).join('.*')}$`, 's').test(command);
    return command === content;
  });
}

const bashRules = (spec: RunSpec) => spec.allowedTools.filter((rule) => rule.startsWith('Bash('));

test('reviewers run configured checks only exactly as configured, and no read-only role keeps another prefix rule', T, async () => {
  const specs: RunSpec[] = [];
  const h = await harness({
    config: (c) => {
      c.checks.commands = CHECKS.map((check) => ({ ...check, timeoutSeconds: 60 }));
      c.planner.enabled = true;
      c.planner.cooldownMinutes = 60;
    },
    // The commands above are only configured, never run: every check passes.
    checks: (c): CheckRunner => ({
      setup: async () => [],
      run: async () => c.checks.commands.map((check) => ({ name: check.name, command: check.run, status: 'passed', durationMs: 1, outputTail: '' })),
    }),
    behavior: (spec) => async (ctl) => {
      specs.push(spec);
      if (spec.role === 'planner') return { status: 'succeeded', structuredOutput: NO_PLAN };
      if (spec.role === 'reviewer') return { status: 'succeeded', structuredOutput: approve };
      await commitFile(ctl, 'r.txt', 'r\n', 'r');
      return { status: 'succeeded', structuredOutput: builderResult('completed') };
    },
  });
  try {
    const t = h.addTask('Reviewed');
    await h.sup.start();
    await h.waitState(t.id, 'integrated');
    await h.waitFor(() => specs.some((s) => s.role === 'planner'), 'a planner run');
    const reviewer = specs.find((s) => s.role === 'reviewer')!;
    const planner = specs.find((s) => s.role === 'planner')!;
    const { baseCommit: base, headCommit: head } = h.store.getTask(t.id)!;

    // Exact rules for the git commands and for the checks a shell runs exactly as configured.
    const gitCommands = [`git diff ${base} ${head}`, `git diff --stat ${base} ${head}`, `git log --oneline ${base}..${head}`];
    const checkCommands = ['npm test', 'git diff --check', 'npx tsc --noEmit -p tsconfig.json'];
    assert.deepEqual(bashRules(reviewer).sort(), [...READ_ONLY_PREFIX_RULES, ...gitCommands.map((c) => `Bash(${c})`), ...checkCommands.map((c) => `Bash(${c})`)].sort());
    assert.deepEqual(bashRules(planner).sort(), [...READ_ONLY_PREFIX_RULES].sort());
    for (const spec of [reviewer, planner]) {
      for (const rule of bashRules(spec)) assert.ok(!rule.includes('*') || READ_ONLY_PREFIX_RULES.includes(rule), `${spec.role}: ${rule} is a prefix or wildcard rule`);
    }

    // What the rules let the reviewer run: the listed commands, and nothing added to them.
    const rules = reviewer.allowedTools;
    for (const c of [...gitCommands, ...checkCommands]) assert.ok(allows(rules, c), c);
    const extended = [
      'git diff --check --output=/tmp/pwned',
      'npm test -- --outputFile=/tmp/pwned',
      'npx tsc --noEmit -p tsconfig.json --outDir /tmp/pwned',
      'npx eslint src/ --fix -o /tmp/pwned/x.ts',
      'make check:* --file=/tmp/Makefile',
      `git diff ${base} ${head} --output=/tmp/pwned`,
    ];
    for (const spec of [reviewer, planner]) {
      for (const c of extended) assert.equal(allows(spec.allowedTools, c), false, `${spec.role} may run: ${c}`);
    }

    // The prompt names exactly the commands the reviewer may run, and says to run them as written.
    for (const c of [...gitCommands, ...checkCommands]) assert.ok(reviewer.prompt.includes(`- ${c}\n`), `the prompt names: ${c}`);
    for (const check of CHECKS.slice(3)) assert.ok(!reviewer.prompt.includes(`- ${check.run.join(' ')}\n`), `the prompt does not offer: ${check.run.join(' ')}`);
    assert.match(reviewer.prompt, /^Run the project's checks only with these commands:$/m);
    assert.match(reviewer.prompt, /^Use these commands exactly as written: /m);
    assert.doesNotMatch(reviewer.appendSystemPrompt, /project's tests/, 'the system prompt sends the reviewer to the listed commands');
  } finally {
    await h.cleanup();
  }
});

test('reviewers are offered only check commands that a shell and a permission rule both read literally', () => {
  const offered = reviewerCheckCommands([
    { run: ['npm', 'test'] },
    { run: ['npm', 'test'] },
    { run: ['go', 'test', './...'] },
    { run: ['/usr/local/bin/pytest', '-q', '--maxfail=1'] },
    { run: ['npx', 'eslint', '.', '--ext', '.ts,.tsx'] },
    { run: [] },
    { run: ['npm', 'run', 'lint:*'] },
    { run: ['jest', 'src/[a-z]*.test.js'] },
    { run: ['sh', '-c', 'npm test'] },
    { run: ['npm', 'test', ''] },
    { run: ['npm', 'test', '--', '$HOME'] },
    { run: ['npm', 'test', '--', '~/x'] },
    { run: ['node', '-e', 'process.exit(0)'] },
    { run: ['echo', 'a\\b'] },
  ]);
  assert.deepEqual(offered, ['npm test', 'go test ./...', '/usr/local/bin/pytest -q --maxfail=1', 'npx eslint . --ext .ts,.tsx']);

  // With nothing to offer, the prompt says so instead of inviting other commands.
  const task = { id: 'T-1', title: 'Title', objective: 'Objective', acceptanceCriteria: [], ownedPaths: [], risk: 'low' } as unknown as Task;
  const diff = { baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), files: [], patch: '', truncated: false } as unknown as DiffSummary;
  const prompt = reviewerPrompt(task, diff, [], '', []);
  assert.match(prompt, /^The project's checks cannot be run in this review; their results are below\.$/m);
  assert.doesNotMatch(prompt, /checks only with these commands/);
});
