#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Fake `claude` CLI for test/runner.test.ts. It imitates the parts of
// `claude -p --output-format stream-json --verbose` that the runner relies on and never
// touches the network. The prompt is read from stdin first, like the real CLI.
//
// FAKE_CLAUDE_SCENARIO selects the behavior:
//   success      init, text, tool_use (split across writes), garbage line, stderr, result
//                with structured_output {echo, apiKeyPresent, argv, mcpConfig, ...}
//   usage_limit  result is_error:true "Claude usage limit reached. Your limit will resets at 3pm"
//   auth         the real auth-failure result observed from Claude Code 2.1.304
//   hang         init, then nothing (a grandchild process keeps running too)
//   stubborn     like hang, but ignores SIGTERM
//   crash        init, then exit 3 without a result
//   slow         a line every 100 ms for 1 s, then success
//   linger       a successful result, then the process never exits (like a stuck MCP server)
//   leftover     starts a background grandchild, prints a successful result and exits 0,
//                leaving the grandchild behind (like `npm run dev &` in a Bash tool call)
// Options (environment):
//   FAKE_CLAUDE_PIDFILE         hang/stubborn/leftover write their grandchild's pid there
//   FAKE_CLAUDE_DETACHED=1      the grandchild gets a process group of its own, as Claude Code
//                               does for Bash tool commands and hooks
//   FAKE_CLAUDE_EXIT_DELAY_MS   leftover: wait this long after the result before exiting
//   FAKE_CLAUDE_RESULT_SESSION  session_id printed in the result (init keeps the CLI's id)
//   FAKE_CLAUDE_STDERR_LINES    crash: print this many warning lines before the fatal one

import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';
const valueAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const sessionId = valueAfter('--resume') ?? valueAfter('--session-id') ?? 'missing-session-id';

// Variables of a parent Claude Code session that the runner must not pass on.
const NESTED_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_PID'];

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** MCP servers named in --mcp-config (a file path or inline JSON), reported as connected like the real CLI. */
function mcpServers() {
  const raw = valueAfter('--mcp-config');
  if (!raw) return [];
  try {
    const cfg = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8'));
    const status = process.env.FAKE_CLAUDE_MCP_STATUS ?? 'connected';
    return Object.keys(cfg.mcpServers ?? {}).map((name) => ({ name, status, source: 'dynamic' }));
  } catch {
    return [];
  }
}

function init() {
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    model: 'fake-model',
    tools: ['Bash', 'Edit', 'Read'],
    mcp_servers: mcpServers(),
    permissionMode: valueAfter('--permission-mode'),
    apiKeySource: process.env.FAKE_CLAUDE_API_KEY_SOURCE ?? 'none',
    uuid: uuid(),
  });
}

function assistant(content) {
  emit({
    type: 'assistant',
    message: { id: `msg_${counter}`, type: 'message', role: 'assistant', model: 'fake-model', content },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
  });
}

function result(fields) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 12,
    duration_api_ms: 8,
    num_turns: 2,
    result: 'done',
    stop_reason: 'end_turn',
    session_id: process.env.FAKE_CLAUDE_RESULT_SESSION || sessionId,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: uuid(),
    ...fields,
  });
}

/** The MCP config as the CLI received it: inline JSON, or a file (Claude Code accepts both). */
function mcpConfigSeen() {
  const value = valueAfter('--mcp-config');
  if (value === null) return null;
  if (value.trimStart().startsWith('{')) return { inline: true, path: null, mode: null, config: JSON.parse(value) };
  return { inline: false, path: value, mode: statSync(value).mode & 0o777, config: JSON.parse(readFileSync(value, 'utf8')) };
}

/** A background grandchild that outlives a normal exit unless the runner stops it. */
function spawnGrandchild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
    detached: process.env.FAKE_CLAUDE_DETACHED === '1',
  });
  if (process.env.FAKE_CLAUDE_PIDFILE) writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(child.pid));
  return child;
}

/** Keep the process alive like a stuck CLI, with a grandchild that keeps running too. */
function hang() {
  spawnGrandchild();
  init();
  // Safety net so a failing test never leaves this process behind for long.
  setTimeout(() => process.exit(9), 30_000);
}

async function main(input) {
  switch (scenario) {
    case 'success': {
      init();
      process.stderr.write('fake: warming up\n');
      process.stdout.write('this line is not json\n');
      assistant([{ type: 'text', text: 'Working on it' }]);
      // One JSON line split across two writes: the runner must buffer partial lines.
      const toolLine = `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: { command: 'npm test' } }] },
        parent_tool_use_id: null,
        session_id: sessionId,
      })}\n`;
      process.stdout.write(toolLine.slice(0, 30));
      await sleep(30);
      process.stdout.write(toolLine.slice(30));
      emit({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake', content: 'ok', is_error: false }] },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      result({
        structured_output: {
          echo: input.slice(0, 20),
          apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
          authTokenPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
          oauthTokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
          nestedVarsPresent: NESTED_VARS.filter((k) => process.env[k] !== undefined),
          extra: process.env.FAKE_EXTRA ?? null,
          cwd: process.cwd(),
          argv,
          mcpConfig: mcpConfigSeen(),
        },
      });
      return;
    }
    case 'usage_limit':
      init();
      result({
        is_error: true,
        result: 'Claude usage limit reached. Your limit will resets at 3pm',
        num_turns: 1,
        total_cost_usd: 0,
        terminal_reason: 'api_error',
        api_error_status: null,
      });
      process.exitCode = 1;
      return;
    case 'auth':
      init();
      emit({
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: null,
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        session_id: sessionId,
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        permission_denials: [],
      });
      process.exitCode = 1;
      return;
    case 'hang':
      hang();
      return;
    case 'stubborn':
      process.on('SIGTERM', () => process.stderr.write('fake: ignoring SIGTERM\n'));
      hang();
      return;
    case 'crash': {
      init();
      const warnings = Number(process.env.FAKE_CLAUDE_STDERR_LINES ?? 0);
      for (let i = 1; i <= warnings; i++) process.stderr.write(`[warn] MCP server "docs" slow to start, retry ${i}\n`);
      process.stderr.write('fake: fatal error: something broke\n');
      process.exitCode = 3;
      return;
    }
    case 'slow':
      init();
      for (let i = 1; i <= 10; i++) {
        await sleep(100);
        assistant([{ type: 'text', text: `tick ${i}` }]);
      }
      result({ result: 'slow done' });
      return;
    case 'linger':
      init();
      result({ result: 'finished, but not exiting', structured_output: { ok: true } });
      setTimeout(() => process.exit(9), 30_000);
      return;
    case 'leftover': {
      spawnGrandchild().unref();
      init();
      result({ result: 'done, with a server still running', structured_output: { ok: true } });
      // Exit 0 naturally (stdout flushed) once this timer has run; the grandchild is unref'd.
      setTimeout(() => {}, Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS ?? 0));
      return;
    }
    default:
      process.stderr.write(`fake-claude: unknown scenario ${scenario}\n`);
      process.exitCode = 64;
  }
}

// Like the real CLI, read the whole prompt from stdin before doing anything.
let input = '';
const stdinGuard = setTimeout(() => {
  process.stderr.write('fake-claude: stdin was never closed\n');
  process.exit(65);
}, 10_000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  clearTimeout(stdinGuard);
  main(input).catch((err) => {
    process.stderr.write(`fake-claude: ${err?.stack ?? err}\n`);
    process.exitCode = 70;
  });
});
