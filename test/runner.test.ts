// SPDX-License-Identifier: MIT
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner, RunEvent, RunHandle, RunOutcome, RunSpec } from '../src/types.ts';
import {
  TEXT_EVENT_MAX,
  classifyResult,
  newStreamState,
  observeMessage,
  parseStreamLine,
  parseUsageResetAt,
  toRunEvents,
} from '../src/runner/stream.ts';
import { ClaudeCliRunner, buildClaudeArgs, buildClaudeEnv, descendantGroups, describeArgs } from '../src/runner/claude-cli.ts';
import { FAKE_PID, FakeRunner, commitFile, type FakeBehavior, type FakeBehaviorFactory } from '../src/runner/fake.ts';
import { sleep, uuid } from '../src/util.ts';

// ------------------------------------------------------------------ helpers

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

/** Real result message observed from Claude Code 2.1.304 when the OAuth login had expired. */
const AUTH_SAMPLE = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  terminal_reason: 'api_error',
  api_error_status: null,
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  session_id: '00000000-0000-4000-8000-000000000001',
  total_cost_usd: 0,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
  permission_denials: [],
};

const local = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo, d, h, mi).getTime();
/** Tuesday 24 Nov 2026, 10:00 local time. */
const NOW = local(2026, 10, 24, 10);
const HOUR = 3_600_000;

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Executable wrapper so the runner spawns the .mjs fixture like a real `claude` binary. */
function fakeClaudeBin(dir: string): string {
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FIXTURE)} "$@"\n`, { mode: 0o755 });
  return bin;
}

function makeSpec(dir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'R-1',
    role: 'builder',
    cwd: dir,
    prompt: 'Implement the onboarding flow, then run the tests.',
    appendSystemPrompt: 'You are a careful builder working on one task.',
    sessionId: uuid(),
    resumeSessionId: null,
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Bash(npm test:*)', 'mcp__autopilot__ask_decision'],
    disallowedTools: ['Bash(git push:*)', 'WebFetch'],
    mcpConfig: { mcpServers: { autopilot: { command: 'node', args: ['bridge.js'], env: { AUTOPILOT_TOKEN: 'secret-token-value' } } } },
    jsonSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    settings: { sandbox: { enabled: true } },
    settingSources: ['project', 'local'],
    addDirs: ['/founder/docs', 'notes'],
    maxTurns: 7,
    timeoutMs: 20_000,
    idleTimeoutMs: 10_000,
    env: { FAKE_CLAUDE_SCENARIO: 'success' },
    logPath: path.join(dir, 'logs', 'R-1.log'),
    ...overrides,
  };
}

function startCollecting(runner: Runner, spec: RunSpec): { handle: RunHandle; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const handle = runner.start(spec, (e) => events.push(e));
  return { handle, events };
}

async function runToEnd(runner: Runner, spec: RunSpec): Promise<{ handle: RunHandle; events: RunEvent[]; outcome: RunOutcome }> {
  const { handle, events } = startCollecting(runner, spec);
  return { handle, events, outcome: await handle.done };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

/** Whether a process (or, with group=true, any process of the group) still exists. */
function alive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Process group of a running process, from ps. */
const pgidOf = (pid: number): number => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());

/** Pid a fixture wrote to a pid file, once it is there. */
async function pidFrom(file: string): Promise<number> {
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '');
  return Number(fs.readFileSync(file, 'utf8'));
}

const readLog = (spec: RunSpec): string => (fs.existsSync(spec.logPath) ? fs.readFileSync(spec.logPath, 'utf8') : '');

const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
/** Values that follow each occurrence of flag. */
const valuesOf = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

/** structured_output printed by the fixture's success scenario. */
interface FakeClaudeEcho {
  echo: string;
  apiKeyPresent: boolean;
  authTokenPresent: boolean;
  oauthTokenPresent: boolean;
  nestedVarsPresent: string[];
  extra: string | null;
  cwd: string;
  argv: string[];
  /** How the MCP config reached the CLI (read by the fixture while it ran). */
  mcpConfig: { inline: boolean; path: string | null; mode: number | null; config: unknown } | null;
}

// ------------------------------------------------------------ stream.ts

test('parseStreamLine ignores blank and garbage lines', () => {
  assert.equal(parseStreamLine(''), null);
  assert.equal(parseStreamLine('   \r'), null);
  assert.equal(parseStreamLine('Loading MCP servers...'), null);
  assert.equal(parseStreamLine('{"type":"assistant", broken'), null);
  assert.equal(parseStreamLine('[1,2]'), null);
  assert.equal(parseStreamLine('42'), null);
  assert.deepEqual(parseStreamLine(' {"type":"system","subtype":"init"}\r'), { type: 'system', subtype: 'init' });
});

test('toRunEvents maps init, text and tool_use blocks and always adds activity', () => {
  const init = toRunEvents({ type: 'system', subtype: 'init', session_id: 'S-1', model: 'claude-x', tools: ['Bash', 'Read'] });
  assert.deepEqual(init[0], { type: 'session', sessionId: 'S-1' });
  assert.equal(init.at(-1)?.type, 'activity');

  const longText = 'x'.repeat(2_000);
  const assistant = toRunEvents({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the code' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/app.ts' } },
        { type: 'text', text: longText },
      ],
    },
  });
  assert.deepEqual(
    assistant.map((e) => e.type),
    ['text', 'tool_use', 'tool_use', 'text', 'activity'],
  );
  assert.deepEqual(assistant[1], { type: 'tool_use', tool: 'Bash' });
  assert.deepEqual(assistant[2], { type: 'tool_use', tool: 'Edit' });
  const long = assistant[3];
  assert.ok(long.type === 'text' && long.text.length <= TEXT_EVENT_MAX, 'text is truncated');
  const activity = assistant[4];
  assert.ok(activity.type === 'activity' && activity.summary.includes('Bash: npm test'), 'summary names the command');
  assert.ok(activity.summary.length <= 160);

  const secret = toRunEvents({ type: 'assistant', message: { content: [{ type: 'text', text: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }] } });
  assert.ok(secret[0].type === 'text' && !secret[0].text.includes('mnopqrstuvwxyz'), 'secrets are redacted');

  assert.deepEqual(toRunEvents({ type: 'result', subtype: 'success', is_error: false }), [
    { type: 'activity', summary: 'result: success' },
  ]);
  assert.deepEqual(toRunEvents({ type: 'assistant', message: { content: 'not-an-array' } }), [
    { type: 'activity', summary: 'assistant: message' },
  ]);
  assert.deepEqual(toRunEvents(null), []);
  assert.deepEqual(toRunEvents('text'), []);
});

test('toRunEvents: rate limit events keep the summary the supervisor matches, and never throw', () => {
  const resetsAt = Math.floor(Date.UTC(2026, 10, 24, 18) / 1000);
  // The supervisor's quota governor matches /^rate limit allowed_warning/ on this summary.
  assert.deepEqual(toRunEvents({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt } }), [
    { type: 'activity', summary: 'rate limit allowed_warning, resets 2026-11-24T18:00:00.000Z' },
  ]);
  for (const bad of [1e17, 9e15, Number.MAX_VALUE]) {
    assert.deepEqual(toRunEvents({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: bad } }), [
      { type: 'activity', summary: 'rate limit rejected' },
    ]);
    const state = newStreamState();
    observeMessage(state, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: bad } });
    assert.equal(state.rateLimitResetAt, null, 'an impossible reset time is ignored');
  }
});

test('classifyResult: the real auth failure sample is failed with an auth: error', () => {
  const c = classifyResult(AUTH_SAMPLE, 1, '', NOW);
  assert.equal(c.status, 'failed');
  assert.equal(c.isError, true);
  assert.equal(c.error, 'auth: Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.equal(c.terminalReason, 'api_error');
  assert.equal(c.resultText, AUTH_SAMPLE.result);
  assert.equal(c.costUsd, 0);
  assert.equal(c.numTurns, 1);
  assert.equal(c.usageResetAt, null);
});

test('classifyResult: success surfaces structured output and accounting', () => {
  const c = classifyResult(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done',
      structured_output: { status: 'completed', summary: 'Added onboarding' },
      total_cost_usd: 0.42,
      num_turns: 9,
      terminal_reason: 'completed',
      session_id: 'S-1',
    },
    0,
    'some stderr noise',
    NOW,
  );
  assert.deepEqual(c, {
    status: 'succeeded',
    isError: false,
    error: null,
    structuredOutput: { status: 'completed', summary: 'Added onboarding' },
    resultText: 'All done',
    terminalReason: 'completed',
    costUsd: 0.42,
    numTurns: 9,
    usageResetAt: null,
  });
});

test('classifyResult: error subtypes and missing is_error never count as success', () => {
  const maxTurns = classifyResult({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 7, errors: [], terminal_reason: 'max_turns' }, 0, '', NOW);
  assert.equal(maxTurns.status, 'failed');
  assert.equal(maxTurns.error, 'claude run failed (subtype=error_max_turns, terminal_reason=max_turns)');

  const during = classifyResult({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Tool crashed badly'] }, 1, '', NOW);
  assert.equal(during.status, 'failed');
  assert.match(during.error ?? '', /^claude run failed \(subtype=error_during_execution\): Tool crashed badly$/);

  const noFlag = classifyResult({ type: 'result', subtype: 'success', result: 'hm' }, 0, '', NOW);
  assert.equal(noFlag.status, 'failed');

  // stderr noise must not turn a result-bearing failure into an auth problem
  const noisy = classifyResult({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Tool crashed'] }, 1, '[hook] updated src/login.tsx', NOW);
  assert.doesNotMatch(noisy.error ?? '', /^auth:/);

  const long = classifyResult({ type: 'result', subtype: 'success', is_error: true, result: `Weird failure ${'y'.repeat(1_000)} api_key=sk-ant-api03-abcdefghijklmnop` }, 1, '', NOW);
  assert.ok((long.error ?? '').length < 400, 'error text is bounded');
});

test('classifyResult: ordinary run failures that mention login, oauth, quota or rate limits stay plain failures', () => {
  const during = (errors: string[], stderr = '') =>
    classifyResult({ type: 'result', subtype: 'error_during_execution', is_error: true, errors }, 1, stderr, NOW);
  for (const text of [
    "Cannot find module './login' imported from src/app.ts",
    'Hook PostToolUse failed: npm test exited 1 (tests/oauth-callback.test.ts)',
    'Bash tool failed: gh: API rate limit exceeded for user',
    'ENOSPC / EDQUOT: Disk quota exceeded',
    'Request to https://example.test failed, try again in 5 minutes',
    'connect ECONNREFUSED 127.0.0.1:5432',
  ]) {
    const c = during([text]);
    assert.equal(c.status, 'failed', text);
    assert.equal(c.error, `claude run failed (subtype=error_during_execution): ${text}`);
  }
  // A result without text: stderr is shown, but its words do not decide the cause.
  const noisy = during([], '[hook] prettier rewrote the login page\n');
  assert.equal(noisy.status, 'failed');
  assert.equal(noisy.error, 'claude run failed (subtype=error_during_execution): [hook] prettier rewrote the login page');
  // The same words from a run that never produced a result are taken at face value (startup).
  assert.match(classifyResult(null, 1, 'Error: OAuth token has expired\n', NOW).error ?? '', /^auth: /);

  // Unmistakable API wording still counts wherever it appears.
  assert.match(during(['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}']).error ?? '', /^auth: /);
  assert.match(during([], 'Invalid API key · Please run /login\n').error ?? '', /^auth: /);
  assert.equal(during(['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}']).status, 'usage_limited');
  assert.equal(during(["You've hit your session limit · resets 3pm"]).usageResetAt, local(2026, 10, 24, 15));
  assert.match(during(['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']).error ?? '', /^transient: /);
  assert.match(during(['API Error: Connection error.']).error ?? '', /^transient: /);

  // Startup failures (CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1) carry a typed reason, which decides.
  const startup = (reason: string, text: string) =>
    classifyResult(
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text], startup_failure_reason: reason, num_turns: 0, total_cost_usd: 0 },
      1,
      `${text}\n`,
      NOW,
    );
  assert.equal(startup('gateway_signin_required', 'Sign in to your gateway to continue').error, 'auth: Sign in to your gateway to continue');
  assert.match(startup('org_verify_failed', 'Could not verify your organization').error ?? '', /^auth: /);
  const cwd = startup('cwd_unavailable', 'Working directory /w is not available (login shell profile failed)');
  assert.equal(cwd.status, 'failed');
  assert.equal(
    cwd.error,
    'claude run failed (subtype=error_during_execution, startup_failure_reason=cwd_unavailable): Working directory /w is not available (login shell profile failed)',
  );

  // An overload that suggests trying again later is not a usage limit.
  const overloaded = classifyResult(
    { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'API Error: Overloaded. Please try again in a few seconds.' },
    1,
    '',
    NOW,
  );
  assert.equal(overloaded.status, 'failed');
  assert.match(overloaded.error ?? '', /^transient: /);
});

test('classifyResult: a long stderr is shown by its end, where the cause is', () => {
  const warnings = '[warn] MCP server "docs" slow to start, retrying\n'.repeat(200);
  const crash = classifyResult(null, 1, `${warnings}Error: ENOSPC: no space left on device, write\n`, NOW);
  assert.equal(crash.status, 'failed');
  assert.match(crash.error ?? '', /^claude exited with code 1 without a result message: …/);
  assert.match(crash.error ?? '', /Error: ENOSPC: no space left on device, write$/);
  assert.ok((crash.error ?? '').length < 400, 'still bounded');

  // Clipping must not expose half a private key whose BEGIN line was cut off.
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${'QUJD'.repeat(800)}\n-----END RSA PRIVATE KEY-----\n`;
  const leaky = classifyResult(null, 1, `${warnings}${key}fatal: bad key\n`, NOW);
  assert.ok(!(leaky.error ?? '').includes('QUJDQUJD'), leaky.error ?? '');
  assert.match(leaky.error ?? '', /\[redacted private key\] fatal: bad key$/);
  // Result text is still clipped from the start, with the same protection.
  const front = classifyResult({ type: 'result', subtype: 'success', is_error: true, result: `failed: ${key}` }, 1, '', NOW);
  assert.ok(!(front.error ?? '').includes('QUJDQUJD'), front.error ?? '');
});

test('classifyResult: usage limits, with reset times when they can be parsed', () => {
  const usage = (fields: Record<string, unknown>, now = NOW, ctx = {}) =>
    classifyResult({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', ...fields }, 1, '', now, ctx);

  const secs = Math.floor(NOW / 1000) + 3 * 3600;
  const legacy = usage({ result: `Claude AI usage limit reached|${secs}` });
  assert.equal(legacy.status, 'usage_limited');
  assert.equal(legacy.usageResetAt, secs * 1000);
  assert.equal(legacy.isError, true);
  assert.match(legacy.error ?? '', /^usage limit: /);
  // Legacy builds printed this as a normal result; it is still a usage limit.
  assert.equal(classifyResult({ type: 'result', subtype: 'success', is_error: false, result: `Claude AI usage limit reached|${secs}` }, 0, '', NOW).status, 'usage_limited');

  assert.equal(usage({ result: 'Claude usage limit reached. Your limit will resets at 3pm' }).usageResetAt, local(2026, 10, 24, 15));
  assert.equal(usage({ result: 'Claude usage limit reached. Your limit will resets at 3pm' }, local(2026, 10, 24, 16)).usageResetAt, local(2026, 10, 25, 15), 'already past: tomorrow');
  assert.equal(usage({ result: 'Usage limit reached. Your limit will reset at 5:00 PM.' }).usageResetAt, local(2026, 10, 24, 17));
  assert.equal(usage({ result: 'Rate limit exceeded. Please try again in 2 hours.' }).usageResetAt, NOW + 2 * HOUR);
  assert.equal(usage({ result: 'Rate limited, try again in 45 minutes' }).usageResetAt, NOW + 45 * 60_000);

  const unknown = usage({ result: 'Usage limit reached.' });
  assert.equal(unknown.status, 'usage_limited');
  assert.equal(unknown.usageResetAt, null, 'unknown reset -> null (supervisor backs off)');

  const typed = usage({ result: "You've hit your limit", api_error: 'usage_limit_reached' });
  assert.equal(typed.status, 'usage_limited');
  const status429 = usage({ result: '', api_error_status: 429 });
  assert.equal(status429.status, 'usage_limited');
  assert.equal(status429.usageResetAt, null);

  // A reset time seen in the stream (rate_limit_event) wins; stale hints are ignored.
  assert.equal(usage({ result: "You've hit your limit" }, NOW, { rateLimitResetAt: NOW + HOUR }).usageResetAt, NOW + HOUR);
  assert.equal(usage({ result: 'Limit reached, resets in 10 minutes' }, NOW, { rateLimitResetAt: NOW - 2 * HOUR }).usageResetAt, NOW + 10 * 60_000);

  // Context exhaustion mentions "limit" but is not a usage limit.
  assert.equal(usage({ result: 'Context limit reached · /compact or /clear to continue' }).status, 'failed');
  assert.equal(usage({ result: 'Prompt is too long', terminal_reason: 'prompt_too_long' }).status, 'failed');
  // Words that merely contain usage vocabulary do not count.
  for (const text of ['Loaded presets at startup failed', 'Unterminated quotation in config', 'Could not compute an accurate limit']) {
    assert.equal(usage({ result: text }).status, 'failed', text);
  }
});

test('parseUsageResetAt understands the common reset formats', () => {
  const nowUtc = Date.UTC(2026, 10, 24, 9, 0); // 10:00 in Berlin
  assert.equal(parseUsageResetAt("You've hit your session limit · resets 3pm (Europe/Berlin)", nowUtc), Date.UTC(2026, 10, 24, 14, 0));
  assert.equal(parseUsageResetAt('Weekly limit reached ∙ resets Nov 28, 3pm (America/New_York)', nowUtc), Date.UTC(2026, 10, 28, 20, 0));
  assert.equal(parseUsageResetAt('resets Jul 4 at 9am (America/New_York)', Date.UTC(2026, 5, 30)), Date.UTC(2026, 6, 4, 13, 0), 'daylight saving time');
  assert.equal(parseUsageResetAt('resets Jan 2, 9am UTC', Date.UTC(2026, 11, 30)), Date.UTC(2027, 0, 2, 9, 0), 'rolls into next year');
  assert.equal(parseUsageResetAt('limit reached, resets 2026-11-25T03:00:00Z', nowUtc), Date.UTC(2026, 10, 25, 3, 0));
  assert.equal(parseUsageResetAt('spend limit reached (daily; resets 2026-11-25 00:00 UTC)', nowUtc), Date.UTC(2026, 10, 25, 0, 0));
  assert.equal(parseUsageResetAt('Claude AI usage limit reached|1795600000000', 1795590000000), 1795600000000, 'millisecond suffix');

  assert.equal(parseUsageResetAt('resets Mon 9am', NOW), local(2026, 10, 30, 9), 'next Monday');
  assert.equal(parseUsageResetAt('resets tomorrow at 3pm', NOW), local(2026, 10, 25, 15));
  assert.equal(parseUsageResetAt('resets 12am', NOW), local(2026, 10, 25, 0));
  assert.equal(parseUsageResetAt('resets in 2h 30m', NOW), NOW + 2.5 * HOUR);
  assert.equal(parseUsageResetAt('try again in 1 hour and 15 minutes', NOW), NOW + 1.25 * HOUR);
  assert.equal(parseUsageResetAt('resets 3pm', local(2026, 10, 24, 15, 2)), local(2026, 10, 24, 15), 'just passed: reset is now');

  assert.equal(parseUsageResetAt('Claude AI usage limit reached|1732480000', NOW), null, 'stale timestamp');
  assert.equal(parseUsageResetAt('Usage limit reached.', NOW), null);
  assert.equal(parseUsageResetAt('failed after 2 retries', NOW), null);
  assert.equal(parseUsageResetAt('resets 5', NOW), null, 'ambiguous clock time');
  assert.equal(parseUsageResetAt('', NOW), null);
});

test('classifyResult: overloads and network errors are transient', () => {
  const overloaded = classifyResult(
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 529,
      result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    },
    1,
    '',
    NOW,
  );
  assert.equal(overloaded.status, 'failed');
  assert.match(overloaded.error ?? '', /^transient: API Error: 529/);

  const textOnly = classifyResult({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Overloaded' }, 1, '', NOW);
  assert.match(textOnly.error ?? '', /^transient: /);
  const network = classifyResult({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.' }, 1, '', NOW);
  assert.match(network.error ?? '', /^transient: /);
});

test('classifyResult: without a result message reports exit code, signal and stderr', () => {
  assert.deepEqual(classifyResult(null, 3, 'fatal: something broke\n', NOW), {
    status: 'failed',
    isError: true,
    error: 'claude exited with code 3 without a result message: fatal: something broke',
    structuredOutput: null,
    resultText: null,
    terminalReason: null,
    costUsd: null,
    numTurns: null,
    usageResetAt: null,
  });
  assert.equal(classifyResult(null, null, '', NOW, { signal: 'SIGSEGV' }).error, 'claude was killed by SIGSEGV without a result message');
  const auth = classifyResult(null, 1, 'Invalid API key · Please run /login\n', NOW);
  assert.match(auth.error ?? '', /^auth: Invalid API key · Please run \/login \(claude exited with code 1/);
});

test('observeMessage collects session, result and rate-limit hints for classification', () => {
  const resetSecs = Math.floor(NOW / 1000) + 2 * 3600;
  const state = newStreamState();
  observeMessage(state, { type: 'system', subtype: 'init', session_id: 'S-9' });
  observeMessage(state, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: resetSecs + 999 } });
  observeMessage(state, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetSecs, rateLimitType: 'five_hour' } });
  observeMessage(state, {
    type: 'assistant',
    is_api_error_message: true,
    api_error: 'usage_limit_reached',
    api_error_status: 429,
    message: { content: [{ type: 'text', text: "You've hit your session limit" }] },
  });
  observeMessage(state, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", session_id: 'S-9' });
  observeMessage(state, 'garbage');

  assert.equal(state.sessionId, 'S-9');
  assert.equal(state.rateLimitResetAt, resetSecs * 1000);
  assert.equal(state.apiError, 'usage_limit_reached');
  assert.equal(state.apiErrorStatus, 429);
  assert.equal(state.messageCount, 5);
  const c = classifyResult(state.result, 1, '', NOW, state);
  assert.equal(c.status, 'usage_limited');
  assert.equal(c.usageResetAt, resetSecs * 1000);
});

// ---------------------------------------------------------- claude-cli.ts

test('buildClaudeArgs, buildClaudeEnv and describeArgs', () => {
  const minimal = makeSpec('/tmp/x', {
    appendSystemPrompt: '',
    resumeSessionId: 'old-session',
    model: undefined,
    effort: undefined,
    allowedTools: [],
    disallowedTools: [],
    mcpConfig: null,
    jsonSchema: null,
    settings: null,
    settingSources: null,
    addDirs: undefined,
    permissionMode: 'dontAsk',
  });
  assert.deepEqual(buildClaudeArgs(minimal), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--max-turns',
    '7',
    '--resume',
    'old-session',
  ]);
  const bypass = buildClaudeArgs({ ...minimal, permissionMode: 'bypassPermissions', settingSources: [] });
  assert.ok(bypass.includes('--allow-dangerously-skip-permissions'));
  assert.equal(valueAfter(bypass, '--setting-sources'), '');

  // --add-dir is variadic: every directory follows its own flag; relative ones are made
  // absolute against the run cwd, so "-odd" cannot be read as a flag; empty entries are skipped.
  const dirs = buildClaudeArgs({ ...minimal, cwd: '/work/tree', addDirs: ['/founder/docs', '', 'notes', '-odd'] });
  assert.deepEqual(valuesOf(dirs, '--add-dir'), ['/founder/docs', '/work/tree/notes', '/work/tree/-odd']);
  assert.deepEqual(dirs.slice(-6), ['--add-dir', '/founder/docs', '--add-dir', '/work/tree/notes', '--add-dir', '/work/tree/-odd']);
  assert.deepEqual(buildClaudeArgs({ ...minimal, addDirs: [] }), buildClaudeArgs(minimal));

  // The MCP config can be passed as a file, which keeps the run token out of the process list.
  const withFile = buildClaudeArgs(makeSpec('/tmp/x'), { mcpConfigPath: '/private/run/mcp-config.json' });
  assert.equal(valueAfter(withFile, '--mcp-config'), '/private/run/mcp-config.json');
  assert.ok(!withFile.some((a) => a.includes('secret-token-value')));
  assert.deepEqual(JSON.parse(valueAfter(buildClaudeArgs(makeSpec('/tmp/x')), '--mcp-config') ?? ''), makeSpec('/tmp/x').mcpConfig);

  const env = buildClaudeEnv(
    makeSpec('/tmp/x', { env: { EXTRA: '1', CLAUDE_EFFORT: 'low' } }),
    { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_EFFORT: 'max', UNSET: undefined },
    true,
  );
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o', EXTRA: '1', CLAUDE_EFFORT: 'low' });
  assert.equal(buildClaudeEnv(makeSpec('/tmp/x', { env: {} }), { ANTHROPIC_API_KEY: 'k' }, false).ANTHROPIC_API_KEY, 'k');

  const described = describeArgs(buildClaudeArgs(makeSpec('/tmp/x')));
  assert.ok(!described.includes('secret-token-value'), 'MCP config is not printed');
  assert.ok(!described.includes('careful builder'), 'system prompt is not printed');
  assert.match(described, /--allowedTools "Bash\(npm test:\*\)"/);
  assert.match(described, /--add-dir "\/founder\/docs" --add-dir "\/tmp\/x\/notes"/);
  assert.match(described, /--mcp-config <\d+ chars> --strict-mcp-config/);
});

test('descendantGroups finds the process groups of tool commands started in groups of their own', () => {
  const table = [
    '    1     0     1',
    '  100     1   100', // the supervisor (selfPid)
    '  200   100   200', // claude, leader of its own group
    '  201   200   200', // an MCP server in claude's group
    '  202   200   202', // a detached Bash command
    '  203   202   202', //   and its child
    '  204   201   204', // a detached grandchild of the MCP server
    '  205   200   100', // somehow in our group: never signalled
    '  300     1   300', // unrelated
    '  301   300   301', // unrelated
    'garbage',
    '',
  ].join('\n');
  assert.deepEqual(descendantGroups(table, 200, 100).sort(), [202, 204]);
  assert.deepEqual(descendantGroups(table, 300, 100), [301]);
  assert.deepEqual(descendantGroups(table, 999, 100), []);
  assert.deepEqual(descendantGroups('  5 6 7\n  6 5 8\n', 5, 1), [8], 'a cyclic table terminates');
});

test('ClaudeCliRunner: success path (stdin prompt, args, events, log, env)', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({
    claudeBin: fakeClaudeBin(dir),
    baseEnv: {
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
      ANTHROPIC_AUTH_TOKEN: 'not-real',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-kept',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_SIMPLE: '1',
    },
  });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'success', FAKE_EXTRA: 'from-spec' } });
  const { handle, events, outcome } = await runToEnd(runner, spec);

  assert.equal(outcome.status, 'succeeded', outcome.error ?? undefined);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.error, null);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, spec.sessionId);
  assert.equal(outcome.resultText, 'done');
  assert.equal(outcome.costUsd, 0.0123);
  assert.equal(outcome.numTurns, 2);
  assert.equal(outcome.terminalReason, 'completed');
  assert.equal(outcome.usageResetAt, null);

  const echo = outcome.structuredOutput as FakeClaudeEcho;
  assert.equal(echo.echo, spec.prompt.slice(0, 20), 'prompt delivered on stdin');
  assert.equal(echo.apiKeyPresent, false, 'ANTHROPIC_API_KEY stripped');
  assert.equal(echo.authTokenPresent, false, 'ANTHROPIC_AUTH_TOKEN stripped');
  assert.equal(echo.oauthTokenPresent, true, 'CLAUDE_CODE_OAUTH_TOKEN kept');
  assert.deepEqual(echo.nestedVarsPresent, [], 'parent session variables stripped');
  assert.equal(echo.extra, 'from-spec', 'spec.env merged');
  assert.equal(fs.realpathSync(echo.cwd), fs.realpathSync(spec.cwd));

  // The MCP config (with the run token) arrived as a private file, not on the command line.
  const mcp = echo.mcpConfig;
  assert.ok(mcp && !mcp.inline && mcp.path, 'MCP config passed as a file');
  assert.ok(path.isAbsolute(mcp.path ?? ''));
  assert.equal(mcp.mode, 0o600, 'only the owner can read it');
  assert.deepEqual(mcp.config, spec.mcpConfig);
  assert.equal(fs.existsSync(mcp.path ?? ''), false, 'removed when the run ended');
  assert.equal(fs.existsSync(path.dirname(mcp.path ?? '')), false, 'its private directory too');

  const argv = echo.argv;
  assert.deepEqual(argv, buildClaudeArgs(spec, { mcpConfigPath: mcp.path }), 'arguments arrive intact');
  assert.ok(!argv.some((a) => a.includes('secret-token-value')), 'no token on the command line');
  assert.deepEqual(argv.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(valuesOf(argv, '--add-dir'), ['/founder/docs', path.join(dir, 'notes')], 'each extra directory after its own --add-dir');
  assert.equal(valueAfter(argv, '--session-id'), spec.sessionId);
  assert.ok(!argv.includes('--resume'));
  assert.deepEqual(valuesOf(argv, '--allowedTools'), spec.allowedTools, 'each allowed tool after its own flag');
  assert.deepEqual(valuesOf(argv, '--disallowedTools'), spec.disallowedTools);
  assert.equal(valueAfter(argv, '--permission-mode'), 'acceptEdits');
  assert.equal(valueAfter(argv, '--max-turns'), '7');
  assert.equal(valueAfter(argv, '--model'), 'sonnet');
  assert.equal(valueAfter(argv, '--effort'), 'high');
  assert.equal(valueAfter(argv, '--append-system-prompt'), spec.appendSystemPrompt);
  assert.equal(valueAfter(argv, '--mcp-config'), mcp.path);
  assert.equal(argv[argv.indexOf('--mcp-config') + 2], '--strict-mcp-config');
  assert.deepEqual(JSON.parse(valueAfter(argv, '--json-schema') ?? ''), spec.jsonSchema);
  assert.deepEqual(JSON.parse(valueAfter(argv, '--settings') ?? ''), spec.settings);
  assert.equal(valueAfter(argv, '--setting-sources'), 'project,local');
  assert.ok(!argv.includes(spec.prompt), 'no positional prompt');

  assert.ok(handle.pid && handle.pid > 0);
  assert.deepEqual(events[0], { type: 'started', pid: handle.pid });
  assert.ok(events.some((e) => e.type === 'session' && e.sessionId === spec.sessionId));
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'Working on it'));
  assert.ok(events.some((e) => e.type === 'tool_use' && e.tool === 'Bash'), 'line split across writes is reassembled');
  assert.ok(events.filter((e) => e.type === 'activity').length >= 5);

  const log = fs.readFileSync(spec.logPath, 'utf8');
  assert.match(log, /^\[autopilot\] run R-1 \(builder\) start /m);
  assert.match(log, /"subtype":"init"/);
  assert.match(log, /^this line is not json$/m);
  assert.match(log, /^\[stderr\] fake: warming up$/m);
  assert.match(log, /"type":"result"/);
  assert.match(log, /^\[autopilot\] run R-1 end status=succeeded exit=0$/m);
  // (The fixture echoes its argv in the result line; the runner's own lines must not leak.)
  const runnerLines = log.split('\n').filter((line) => line.startsWith('[autopilot]'));
  assert.match(runnerLines.join('\n'), /--mcp-config <\d+ chars>/);
  assert.ok(!runnerLines.some((line) => line.includes('secret-token-value')), 'MCP token is not logged by the runner');
});

test('ClaudeCliRunner: stripApiKeys=false keeps the API key', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), baseEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test-not-real' }, stripApiKeys: false });
  const { outcome } = await runToEnd(runner, makeSpec(dir));
  assert.equal(outcome.status, 'succeeded');
  assert.equal((outcome.structuredOutput as FakeClaudeEcho).apiKeyPresent, true);
});

test('ClaudeCliRunner: resume uses --resume and reports the resumed session', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const resumeId = uuid();
  const { events, outcome } = await runToEnd(runner, makeSpec(dir, { resumeSessionId: resumeId }));
  assert.equal(outcome.status, 'succeeded');
  const argv = (outcome.structuredOutput as FakeClaudeEcho).argv;
  assert.equal(valueAfter(argv, '--resume'), resumeId);
  assert.ok(!argv.includes('--session-id'));
  assert.equal(outcome.sessionId, resumeId);
  assert.ok(events.some((e) => e.type === 'session' && e.sessionId === resumeId));
});

test('ClaudeCliRunner: the result message session id wins over the init one', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const resultSession = uuid();
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'success', FAKE_CLAUDE_RESULT_SESSION: resultSession } });
  const { events, outcome } = await runToEnd(runner, spec);
  assert.equal(outcome.status, 'succeeded', outcome.error ?? undefined);
  assert.ok(events.some((e) => e.type === 'session' && e.sessionId === spec.sessionId), 'init announced the requested id');
  assert.equal(outcome.sessionId, resultSession);
});

test('ClaudeCliRunner: idle timeout kills a hanging process group', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 1_000 });
  const spec = makeSpec(dir, { idleTimeoutMs: 300, env: { FAKE_CLAUDE_SCENARIO: 'hang' } });
  const { handle, outcome } = await runToEnd(runner, spec);
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.error, 'timeout: no output for 0.3s');
  assert.equal(outcome.isError, true);
  assert.equal(alive(handle.pid ?? 0, true), false, 'process group is gone');
  assert.match(fs.readFileSync(spec.logPath, 'utf8'), /end status=timeout/);
});

test('ClaudeCliRunner: overall timeout even while output keeps flowing', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 1_000 });
  const { handle, outcome } = await runToEnd(runner, makeSpec(dir, { timeoutMs: 300, env: { FAKE_CLAUDE_SCENARIO: 'slow' } }));
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.error, 'timeout: exceeded 0.3s');
  assert.equal(alive(handle.pid ?? 0, true), false);
});

test('ClaudeCliRunner: steady output keeps resetting the idle timer', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const startedAt = Date.now();
  const { events, outcome } = await runToEnd(runner, makeSpec(dir, { idleTimeoutMs: 600, env: { FAKE_CLAUDE_SCENARIO: 'slow' } }));
  assert.equal(outcome.status, 'succeeded', outcome.error ?? undefined);
  assert.equal(outcome.resultText, 'slow done');
  assert.ok(Date.now() - startedAt > 900, 'the run outlived the idle timeout');
  assert.equal(events.filter((e) => e.type === 'text').length, 10);
});

test('ClaudeCliRunner: a process that lingers after its result is stopped, keeping the result', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), postResultExitMs: 300, killGraceMs: 1_000 });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'linger' } });
  const startedAt = Date.now();
  const { handle, outcome } = await runToEnd(runner, spec);
  assert.ok(Date.now() - startedAt < 5_000, 'did not wait for the idle timeout');
  assert.equal(outcome.status, 'succeeded', outcome.error ?? undefined);
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.structuredOutput, { ok: true });
  assert.equal(outcome.exitCode, null, 'ended by our signal');
  assert.equal(alive(handle.pid ?? 0, true), false);
  assert.match(fs.readFileSync(spec.logPath, 'utf8'), /still running 0\.3s after its result message/);
});

test('ClaudeCliRunner: a timeout that fires after the result message keeps the result', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const cases = [
    // idleTimeoutMinutes may equal the default post-result wait (1 minute), scaled down here.
    { label: 'idle', limits: { idleTimeoutMs: 800 }, postResultExitMs: 800, log: /timeout: no output for 0\.8s after the result message; keeping the result|still running 0\.8s after its result message/ },
    // The overall deadline can land inside the post-result window too.
    { label: 'overall', limits: { timeoutMs: 1_500 }, postResultExitMs: 10_000, log: /timeout: exceeded 1\.5s after the result message; keeping the result/ },
  ];
  for (const c of cases) {
    const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), postResultExitMs: c.postResultExitMs, killGraceMs: 1_000 });
    const spec = makeSpec(dir, { runId: `R-${c.label}`, logPath: path.join(dir, 'logs', `${c.label}.log`), ...c.limits, env: { FAKE_CLAUDE_SCENARIO: 'linger' } });
    const { handle, outcome } = await runToEnd(runner, spec);
    assert.equal(outcome.status, 'succeeded', `${c.label}: ${outcome.error}`);
    assert.equal(outcome.error, null);
    assert.equal(outcome.isError, false);
    assert.deepEqual(outcome.structuredOutput, { ok: true });
    assert.equal(alive(handle.pid ?? 0, true), false);
    assert.match(readLog(spec), c.log);
  }
});

test('ClaudeCliRunner: kill() after a timeout keeps the timeout status', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 800 });
  // The stubborn fake ignores SIGTERM, so the run is still stopping when the late kill comes.
  const spec = makeSpec(dir, { idleTimeoutMs: 300, env: { FAKE_CLAUDE_SCENARIO: 'stubborn' } });
  const { handle } = startCollecting(runner, spec);
  await waitFor(() => /stopping process group \d+: timeout/.test(readLog(spec)));
  let settled = false;
  void handle.done.then(() => (settled = true));
  await sleep(0);
  assert.equal(settled, false, 'the run is still stopping when the late kill comes');
  handle.kill('late kill');
  const outcome = await handle.done;
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.error, 'timeout: no output for 0.3s');
  assert.equal(alive(handle.pid ?? 0, true), false);
});

test('ClaudeCliRunner: processes left behind after a normal exit are stopped', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 1_000 });
  const cases: { label: string; env: Record<string, string> }[] = [
    // A background process in claude's own process group.
    { label: 'same-group', env: {} },
    // One in a process group of its own (Claude Code runs Bash commands detached): traced while
    // claude was still up after its result.
    { label: 'own-group', env: { FAKE_CLAUDE_DETACHED: '1', FAKE_CLAUDE_EXIT_DELAY_MS: '1000' } },
  ];
  for (const c of cases) {
    const pidFile = path.join(dir, `${c.label}.pid`);
    const spec = makeSpec(dir, {
      runId: `R-${c.label}`,
      logPath: path.join(dir, 'logs', `${c.label}.log`),
      env: { FAKE_CLAUDE_SCENARIO: 'leftover', FAKE_CLAUDE_PIDFILE: pidFile, ...c.env },
    });
    const { handle, outcome } = await runToEnd(runner, spec);
    assert.equal(outcome.status, 'succeeded', `${c.label}: ${outcome.error}`);
    assert.equal(outcome.exitCode, 0, 'claude exited on its own');
    assert.deepEqual(outcome.structuredOutput, { ok: true });
    assert.equal(alive(handle.pid ?? 0, true), false, `${c.label}: process group gone when done resolves`);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitFor(() => !alive(grandchild), 2_000);
    assert.match(readLog(spec), /stopping process group \d+: leftover processes after claude exited/);
    if (c.label === 'own-group') assert.match(readLog(spec), new RegExp(`also stopping tool process groups .*\\b${grandchild}\\b`));
  }
});

test('ClaudeCliRunner: kill() also stops tool processes running in process groups of their own', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const pidFile = path.join(dir, 'tool.pid');
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 1_000 });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'hang', FAKE_CLAUDE_PIDFILE: pidFile, FAKE_CLAUDE_DETACHED: '1' } });
  const { handle, events } = startCollecting(runner, spec);
  await waitFor(() => events.some((e) => e.type === 'session'));
  const tool = await pidFrom(pidFile);
  assert.ok(alive(tool));
  assert.notEqual(pgidOf(tool), handle.pid, 'the tool process is outside claude’s process group');

  handle.kill('cancelled');
  const outcome = await handle.done;
  assert.equal(outcome.status, 'killed');
  assert.equal(alive(handle.pid ?? 0, true), false);
  await waitFor(() => !alive(tool), 2_000);
  assert.match(readLog(spec), new RegExp(`also stopping tool process groups .*\\b${tool}\\b`));
});

test('ClaudeCliRunner: kill() resolves killed and the whole process group is gone', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const pidFile = path.join(dir, 'grandchild.pid');
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 2_000 });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'hang', FAKE_CLAUDE_PIDFILE: pidFile } });
  const { handle, events } = startCollecting(runner, spec);
  assert.ok(handle.pid && handle.pid > 0);
  await waitFor(() => events.some((e) => e.type === 'session') && fs.existsSync(pidFile));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(grandchild), 'grandchild runs before the kill');

  handle.kill('cancelled by test');
  handle.kill('a second kill is ignored');
  const outcome = await handle.done;
  assert.equal(outcome.status, 'killed');
  assert.equal(outcome.error, 'cancelled by test');
  assert.equal(outcome.isError, true);
  assert.equal(outcome.sessionId, spec.sessionId);
  assert.equal(alive(handle.pid, true), false, 'process group is gone');
  await waitFor(() => !alive(grandchild), 2_000);
  handle.kill('after the end'); // no-op
});

test('ClaudeCliRunner: SIGKILL follows when SIGTERM is ignored', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), killGraceMs: 300 });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'stubborn' } });
  const { handle, events } = startCollecting(runner, spec);
  await waitFor(() => events.some((e) => e.type === 'session'));
  const killedAt = Date.now();
  handle.kill('stop');
  const outcome = await handle.done;
  assert.equal(outcome.status, 'killed');
  assert.ok(Date.now() - killedAt >= 250, 'waited for the grace period');
  assert.equal(alive(handle.pid ?? 0, true), false);
  const log = fs.readFileSync(spec.logPath, 'utf8');
  assert.match(log, /\[stderr\] fake: ignoring SIGTERM/);
  assert.match(log, /sending SIGKILL/);
});

test('ClaudeCliRunner: a crash without a result is failed with the exit code', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'crash' } });
  const { handle } = startCollecting(runner, spec);
  // A throwing listener must not break the run.
  const throwing = runner.start({ ...spec, runId: 'R-2', logPath: path.join(dir, 'logs', 'R-2.log') }, () => {
    throw new Error('listener bug');
  });
  for (const outcome of [await handle.done, await throwing.done]) {
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.error, 'claude exited with code 3 without a result message: fake: fatal error: something broke');
    assert.equal(outcome.sessionId, spec.sessionId, 'session id from init');
  }
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'R-2.log'), 'utf8'), /event listener threw: listener bug/);

  // Plenty of warnings first: the error still ends with the fatal line.
  const noisy = makeSpec(dir, { runId: 'R-3', logPath: path.join(dir, 'logs', 'R-3.log'), env: { FAKE_CLAUDE_SCENARIO: 'crash', FAKE_CLAUDE_STDERR_LINES: '300' } });
  const { outcome } = await runToEnd(runner, noisy);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /^claude exited with code 3 without a result message: ….*fake: fatal error: something broke$/);
});

test('ClaudeCliRunner: usage limit is usage_limited with a parsed reset time', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir), now: () => NOW });
  const { outcome } = await runToEnd(runner, makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'usage_limit' } }));
  assert.equal(outcome.status, 'usage_limited');
  assert.equal(outcome.usageResetAt, local(2026, 10, 24, 15));
  assert.equal(outcome.isError, true);
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.error ?? '', /^usage limit: Claude usage limit reached/);
});

test('ClaudeCliRunner: auth failure is failed with an auth: error', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const spec = makeSpec(dir, { env: { FAKE_CLAUDE_SCENARIO: 'auth' } });
  const { outcome } = await runToEnd(runner, spec);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'auth: Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.equal(outcome.terminalReason, 'api_error');
  assert.equal(outcome.sessionId, spec.sessionId);
});

test('ClaudeCliRunner: missing binary or cwd fails with a spawn error', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const missingBin = new ClaudeCliRunner({ claudeBin: path.join(dir, 'no-such-claude') });
  const first = await runToEnd(missingBin, makeSpec(dir));
  assert.equal(first.outcome.status, 'failed');
  assert.match(first.outcome.error ?? '', /^spawn: .*ENOENT/);
  assert.equal(first.handle.pid, null);
  assert.ok(!first.events.some((e) => e.type === 'started'));

  const missingCwd = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const second = await runToEnd(missingCwd, makeSpec(dir, { cwd: path.join(dir, 'gone') }));
  assert.equal(second.outcome.status, 'failed');
  assert.match(second.outcome.error ?? '', /^spawn: working directory does not exist/);
});

// ----------------------------------------------------------------- fake.ts

function gitInit(dir: string): void {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'init');
}

test('FakeRunner: commitFile writes, stages and commits in a temp git repo', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  gitInit(dir);
  const runner = new FakeRunner(async (ctl) => {
    ctl.emit({ type: 'tool_use', tool: 'Edit' });
    const sha = await commitFile(ctl, 'src/hello.txt', 'hello\n', 'Add hello');
    return { structuredOutput: { sha }, resultText: 'committed', costUsd: 0.01 };
  });
  const spec = makeSpec(dir);
  const { handle, events } = startCollecting(runner, spec);
  assert.equal(events.length, 0, 'no events before start() returns');
  const outcome = await handle.done;

  assert.equal(outcome.status, 'succeeded', outcome.error ?? undefined);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, spec.sessionId);
  assert.equal(outcome.resultText, 'committed');
  assert.equal(outcome.costUsd, 0.01);
  const { sha } = outcome.structuredOutput as { sha: string };
  assert.equal(execFileSync('git', ['log', '-1', '--format=%H %s %an'], { cwd: dir, encoding: 'utf8' }).trim(), `${sha} Add hello Fake`);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');

  assert.deepEqual(events, [
    { type: 'started', pid: FAKE_PID },
    { type: 'session', sessionId: spec.sessionId },
    { type: 'tool_use', tool: 'Edit' },
  ]);
  assert.equal(handle.pid, null);
  assert.deepEqual(runner.started, [spec]);
});

test('FakeRunner: kill() aborts sleep and resolves killed', async (t) => {
  const dir = tempDir(t);
  let sleepError: unknown = null;
  let finishedSleeping = false;
  const runner = new FakeRunner(async (ctl) => {
    try {
      await ctl.sleep(10_000);
      finishedSleeping = true;
    } catch (err) {
      sleepError = err;
      throw err;
    }
    return {};
  });
  const { handle, events } = startCollecting(runner, makeSpec(dir, { resumeSessionId: 'resumed-session' }));
  await waitFor(() => events.length >= 2);
  const killedAt = Date.now();
  handle.kill('stop now');
  const outcome = await handle.done;
  assert.ok(Date.now() - killedAt < 1_000);
  assert.equal(outcome.status, 'killed');
  assert.equal(outcome.error, 'stop now');
  assert.equal(outcome.isError, true);
  assert.equal(outcome.sessionId, 'resumed-session');
  await waitFor(() => sleepError !== null);
  assert.equal((sleepError as Error).name, 'AbortError');
  assert.equal(finishedSleeping, false);
});

test('FakeRunner: per-spec factories, failing behaviors and outcome defaults', async (t) => {
  const dir = tempDir(t);
  const runner = new FakeRunner((spec) =>
    spec.role === 'reviewer'
      ? async () => ({ structuredOutput: { verdict: 'approve' } })
      : async () => {
          throw new Error('builder exploded');
        },
  );
  const reviewer = await runner.start(makeSpec(dir, { runId: 'R-2', role: 'reviewer' }), () => {}).done;
  assert.equal(reviewer.status, 'succeeded');
  assert.deepEqual(reviewer.structuredOutput, { verdict: 'approve' });
  assert.equal(reviewer.usageResetAt, null);
  assert.equal(reviewer.error, null);

  const builder = await runner.start(makeSpec(dir, { runId: 'R-3' }), () => {}).done;
  assert.equal(builder.status, 'failed');
  assert.equal(builder.error, 'builder exploded');
  assert.equal(builder.isError, true);

  const limited = await new FakeRunner(async () => ({ status: 'usage_limited', usageResetAt: NOW })).start(makeSpec(dir), () => {}).done;
  assert.equal(limited.status, 'usage_limited');
  assert.equal(limited.usageResetAt, NOW);
  assert.equal(limited.isError, true);

  // Pre-declared behaviors and factories are accepted as well (checked by tsc).
  const behavior: FakeBehavior = async (ctl) => ({ resultText: ctl.spec.runId });
  const factory: FakeBehaviorFactory = (spec) => (spec.role === 'builder' ? behavior : async () => ({}));
  assert.equal((await new FakeRunner(behavior).start(makeSpec(dir, { runId: 'R-4' }), () => {}).done).resultText, 'R-4');
  assert.equal((await new FakeRunner(factory).start(makeSpec(dir, { runId: 'R-5' }), () => {}).done).resultText, 'R-5');
});

test('FakeRunner: writeFile stays inside the run cwd', async (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  fs.symlinkSync(outside, path.join(dir, 'link'));
  // Dangling links: their targets do not exist yet, so a naive existence check walks past them.
  fs.symlinkSync(path.join(outside, 'created-outside.txt'), path.join(dir, 'dangling'));
  fs.symlinkSync(path.join(outside, 'newdir'), path.join(dir, 'dlink'));
  // A link inside the tree is not written through either (git would store the link, not the text).
  fs.writeFileSync(path.join(dir, 'real.txt'), 'real');
  fs.symlinkSync('real.txt', path.join(dir, 'alias.txt'));
  const bad = ['../escape.txt', path.join(outside, 'abs.txt'), 'nested/../../escape.txt', 'link/evil.txt', 'link/sub/evil.txt', '', '.', 'dangling', 'dlink/x.txt', 'alias.txt'];
  const results: string[] = [];
  const runner = new FakeRunner(async (ctl) => {
    ctl.writeFile('nested/deeper/ok.txt', 'ok');
    ctl.writeFile('nested/deeper/ok.txt', 'ok again'); // overwriting a plain file is fine
    for (const p of bad) {
      try {
        ctl.writeFile(p, 'x');
        results.push(`accepted ${p}`);
      } catch {
        results.push('rejected');
      }
    }
    return {};
  });
  const outcome = await runner.start(makeSpec(dir), () => {}).done;
  assert.equal(outcome.status, 'succeeded', outcome.error ?? undefined);
  assert.deepEqual(results, Array(bad.length).fill('rejected'));
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'deeper', 'ok.txt'), 'utf8'), 'ok again');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(path.join(dir, 'real.txt'), 'utf8'), 'real');
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.txt')));
});

test('FakeRunner: a killed behavior cannot touch the worktree, and done waits for it to stop', async (t) => {
  const dir = tempDir(t);
  gitInit(dir);
  const steps: string[] = [];
  const runner = new FakeRunner(async (ctl) => {
    await ctl.sleep(10_000).catch((err: Error) => steps.push(`sleep: ${err.name}`));
    const attempts: [string, () => unknown][] = [
      ['writeFile', () => ctl.writeFile('late.txt', 'too late')],
      ['git', () => ctl.git(['commit', '--allow-empty', '-m', 'too late'])],
    ];
    for (const [name, attempt] of attempts) {
      try {
        await attempt();
        steps.push(`${name}: allowed`);
      } catch (err) {
        steps.push(`${name}: ${(err as Error).name}`);
      }
    }
    await new Promise((r) => setTimeout(r, 50)); // some cleanup work
    steps.push('wound down');
    return { status: 'succeeded' }; // a kill decides the status anyway
  });
  const { handle, events } = startCollecting(runner, makeSpec(dir));
  await waitFor(() => events.length >= 2);
  handle.kill('stop');
  const outcome = await handle.done;
  assert.equal(outcome.status, 'killed');
  assert.equal(outcome.error, 'stop');
  assert.deepEqual(steps, ['sleep: AbortError', 'writeFile: AbortError', 'git: AbortError', 'wound down'], 'done resolved after the behavior stopped');
  assert.equal(fs.existsSync(path.join(dir, 'late.txt')), false);
  assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), '1');

  // A behavior that ignores the signal is given up on after killGraceMs.
  const stuck = new FakeRunner(() => new Promise<Partial<RunOutcome>>(() => {}), { killGraceMs: 200 });
  const stuckEvents: RunEvent[] = [];
  const stuckHandle = stuck.start(makeSpec(dir, { runId: 'R-2' }), (e) => stuckEvents.push(e));
  await waitFor(() => stuckEvents.length >= 2);
  const killedAt = Date.now();
  stuckHandle.kill('give up');
  const stuckOutcome = await stuckHandle.done;
  assert.equal(stuckOutcome.status, 'killed');
  assert.ok(Date.now() - killedAt >= 150, 'waited for the grace period');

  // Killed before it started: resolves at once, without events.
  const earlyEvents: RunEvent[] = [];
  const early = runner.start(makeSpec(dir, { runId: 'R-3' }), (e) => earlyEvents.push(e));
  early.kill('too early');
  assert.equal((await early.done).status, 'killed');
  assert.deepEqual(earlyEvents, []);
});


test('init guard: refuses API-key billing and a missing tool bridge before any model work', async () => {
  const { initGuardProblem } = await import('../src/runner/claude-cli.ts');
  const withBridge = { mcpConfig: { mcpServers: { autopilot: { command: 'node' } } } };
  assert.equal(initGuardProblem({ apiKeySource: 'none', mcp_servers: [{ name: 'autopilot', status: 'connected' }] }, withBridge), null);
  assert.match(initGuardProblem({ apiKeySource: 'ANTHROPIC_API_KEY', mcp_servers: [{ name: 'autopilot', status: 'connected' }] }, withBridge) ?? '', /^auth: .*ANTHROPIC_API_KEY/);
  assert.match(initGuardProblem({ apiKeySource: 'apiKeyHelper' }, { mcpConfig: null }) ?? '', /^auth: /);
  assert.match(initGuardProblem({ apiKeySource: 'none', mcp_servers: [{ name: 'autopilot', status: 'failed' }] }, withBridge) ?? '', /^mcp: .*did not connect \(failed\)/);
  assert.match(initGuardProblem({ apiKeySource: 'none', mcp_servers: [] }, withBridge) ?? '', /^mcp: .*not loaded/);
  assert.equal(initGuardProblem({ apiKeySource: 'none' }, { mcpConfig: null }), null, 'runs without the bridge are not checked for it');
});

test('ClaudeCliRunner: a run that would bill an API key, or has no tool bridge, stops right after init', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t);
  const runner = new ClaudeCliRunner({ claudeBin: fakeClaudeBin(dir) });
  const apiKey = await runToEnd(runner, makeSpec(dir, { runId: 'R-key', logPath: path.join(dir, 'logs', 'R-key.log'), env: { FAKE_CLAUDE_SCENARIO: 'hang', FAKE_CLAUDE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY' } }));
  assert.equal(apiKey.outcome.status, 'failed');
  assert.match(apiKey.outcome.error ?? '', /^auth: this run would bill ANTHROPIC_API_KEY/);
  const noBridge = await runToEnd(runner, makeSpec(dir, { runId: 'R-mcp', logPath: path.join(dir, 'logs', 'R-mcp.log'), env: { FAKE_CLAUDE_SCENARIO: 'hang', FAKE_CLAUDE_MCP_STATUS: 'failed' } }));
  assert.equal(noBridge.outcome.status, 'failed');
  assert.match(noBridge.outcome.error ?? '', /^mcp: the autopilot tool bridge did not connect \(failed\)/);
});
