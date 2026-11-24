// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckFlag, parseCommandFlag, parseShellWords } from '../bin/autopilot.ts';

test('parseShellWords splits words and removes quotes the way a shell does', () => {
  const cases: [string, string[]][] = [
    ['npm test', ['npm', 'test']],
    ['  npm \t run   test  ', ['npm', 'run', 'test']],
    ['node -e "process.exit(1)"', ['node', '-e', 'process.exit(1)']],
    ["npx eslint 'src/**/*.ts'", ['npx', 'eslint', 'src/**/*.ts']],
    ["sh -c 'echo hi'", ['sh', '-c', 'echo hi']],
    // Operators inside quotes belong to the argument: this is how to hand them to sh -c.
    ["sh -c 'npm test && npm run lint | tee log; echo `date` $(pwd) > x'", ['sh', '-c', 'npm test && npm run lint | tee log; echo `date` $(pwd) > x']],
    ['sh -c "a && b $(c) `d`"', ['sh', '-c', 'a && b $(c) `d`']],
    // Single quotes keep backslashes and double quotes as written.
    [`echo 'a\\b "c"'`, ['echo', 'a\\b "c"']],
    // Double quotes honour \\ \" \$ \` and keep any other backslash.
    ['echo "a \\"b\\" \\\\ \\$HOME \\` \\n"', ['echo', 'a "b" \\ $HOME ` \\n']],
    // A backslash outside quotes keeps the next character.
    ["echo it\\'s a\\ b \\$x \\|", ['echo', "it's", 'a b', '$x', '|']],
    // Adjacent quoted and plain parts make one word; empty quotes are an empty argument.
    [`echo a"b c"'d e'f '' ""`, ['echo', 'ab cd ef', '', '']],
    // Nothing is expanded, and parentheses alone are fine (node -e process.exit(0)).
    ['node -e process.exit(0) $HOME ~/x *.ts', ['node', '-e', 'process.exit(0)', '$HOME', '~/x', '*.ts']],
    // A backslash before a line break joins the lines, inside double quotes too.
    ['node -e \\\n  "a\\\nb"', ['node', '-e', 'ab']],
    ['node -e "line one\nline two"', ['node', '-e', 'line one\nline two']],
    ['', []],
    ['   ', []],
  ];
  for (const [line, words] of cases) assert.deepEqual(parseShellWords(line), words, line);
});

test('parseShellWords refuses unclosed quotes and shell syntax outside quotes', () => {
  assert.throws(() => parseShellWords('node -e "process.exit(1)'), /a double quote is not closed/);
  assert.throws(() => parseShellWords('node -e "a\\"'), /a double quote is not closed/);
  assert.throws(() => parseShellWords("echo 'it"), /a single quote is not closed/);
  assert.throws(() => parseShellWords("echo it's"), /a single quote is not closed/);
  assert.throws(() => parseShellWords('echo x\\'), /ends with a backslash/);
  const operators: [string, string][] = [
    ['npm test && npm run lint', '&&'],
    ['npm test || true', '||'],
    ['npm test | tee log', '|'],
    ['npm test &', '&'],
    ['npm test; npm run lint', ';'],
    ['npm test > log', '>'],
    ['npm test 2>&1', '>&'],
    ['node x.js < in', '<'],
    ['echo `date`', 'a backtick'],
    ['echo $(date)', '$('],
    ['npm ci\nnpm test', 'a line break'],
  ];
  for (const [line, op] of operators) {
    assert.throws(
      () => parseShellWords(line),
      (err: unknown) => err instanceof Error && err.message.startsWith(`${op} is shell syntax`) && err.message.includes("sh -c '...'") && err.message.includes('config.json'),
      line,
    );
  }
});

test('parseCheckFlag keeps the name=command split and parses the command', () => {
  assert.deepEqual(parseCheckFlag('test=node -e "process.exit(1)"'), { name: 'test', run: ['node', '-e', 'process.exit(1)'], timeoutSeconds: 900 });
  assert.deepEqual(parseCheckFlag("lint=npx eslint 'src/**/*.ts'"), { name: 'lint', run: ['npx', 'eslint', 'src/**/*.ts'], timeoutSeconds: 900 });
  // Only a plain word right before the first '=' is a name.
  assert.deepEqual(parseCheckFlag('node -e x=1'), { name: 'node', run: ['node', '-e', 'x=1'], timeoutSeconds: 900 });
  assert.deepEqual(parseCheckFlag('npm test'), { name: 'npm', run: ['npm', 'test'], timeoutSeconds: 900 });
  assert.deepEqual(parseCheckFlag(' unit:fast=npm run test:fast -- --grep=x '), { name: 'unit:fast', run: ['npm', 'run', 'test:fast', '--', '--grep=x'], timeoutSeconds: 900 });
  assert.deepEqual(parseCheckFlag('test=node -e "a\nb"'), { name: 'test', run: ['node', '-e', 'a\nb'], timeoutSeconds: 900 });
  assert.throws(() => parseCheckFlag('test=npm test && npm run lint'), /&& is shell syntax/);
  assert.throws(() => parseCheckFlag("test=''"), /there is no command/);
  assert.throws(() => parseCommandFlag(''), /there is no command/);
  assert.deepEqual(parseCommandFlag("sh -c 'echo hi'"), ['sh', '-c', 'echo hi']);
});
