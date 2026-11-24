// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { AgentApi } from '../src/agent-api.ts';
import { defaultConfig } from '../src/config.ts';
import { isEntryPoint } from '../src/mcp/server.ts';
import { Store } from '../src/store.ts';
import { randomToken, sha256Hex } from '../src/util.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ENTRY = 'src/mcp/server.ts';
const BRIDGE_ENV_KEYS = ['AUTOPILOT_API_URL', 'AUTOPILOT_RUN_TOKEN', 'AUTOPILOT_ROLE', 'AUTOPILOT_TOOL_TIMEOUT_MS'];
const LEASE_LOST = 'Your lease on this task was lost (the supervisor reassigned it). Stop working, do not commit further, and end your run.';

type Json = Record<string, any>;

interface Reply {
  status: number;
  /** Objects are sent as JSON, strings as plain text. */
  body: unknown;
  delayMs?: number;
}

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/** Stand-in for the supervisor's HTTP API: records every request to /agent/tools/:name. */
async function startStub(route: (name: string, body: unknown) => Reply) {
  const requests: Recorded[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, contentType: req.headers['content-type'], body });
      const m = /^\/agent\/tools\/([a-z_]+)$/.exec(req.url ?? '');
      const reply: Reply = m ? route(m[1], body) : { status: 404, body: { error: 'not_found' } };
      const send = () => {
        const isText = typeof reply.body === 'string';
        res.writeHead(reply.status, { 'content-type': isText ? 'text/plain' : 'application/json' });
        res.end(isText ? (reply.body as string) : JSON.stringify(reply.body));
      };
      if (!reply.delayMs) return send();
      const timer = setTimeout(() => {
        timers.delete(timer);
        send();
      }, reply.delayMs);
      timers.add(timer);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Waiter {
  pred: (msg: Json) => boolean;
  label: string;
  resolve: (msg: Json) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Drives the real server process over stdio, the way Claude Code does. */
class McpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: Json[] = [];
  readonly invalidLines: string[] = [];
  stderr = '';
  private waiters: Waiter[] = [];
  /** Set once the process is gone: why later waits fail at once. */
  private exited: string | null = null;

  /** entry: script path to launch (default src/mcp/server.ts); nodeArgs: extra node flags before it. */
  constructor(bridgeEnv: Record<string, string>, opts: { entry?: string; nodeArgs?: string[] } = {}) {
    const env: Record<string, string | undefined> = { ...process.env };
    // Only the variables a test sets reach the bridge, and the child is not part of this test run.
    for (const key of [...BRIDGE_ENV_KEYS, 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[key];
    Object.assign(env, bridgeEnv);
    const args = ['--disable-warning=ExperimentalWarning', ...(opts.nodeArgs ?? []), opts.entry ?? SERVER_ENTRY];
    this.child = spawn(process.execPath, args, { cwd: ROOT, env });
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        this.invalidLines.push(line);
        return;
      }
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        clearTimeout(w.timer);
        w.resolve(msg);
        return false;
      });
    });
    // A server that died fails the waiting test below, not the whole test process (EPIPE).
    this.child.stdin.on('error', () => undefined);
    // 'close' comes after stdout is drained: whoever still waits will get no reply.
    this.child.on('close', (code, signal) => {
      this.exited = `server exited (${code ?? signal})`;
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`${this.exited} before ${w.label}; server stderr: ${this.stderr}`));
      }
    });
  }

  send(line: unknown): void {
    this.child.stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  }

  waitFor(pred: (msg: Json) => boolean, label: string, timeoutMs = 8_000): Promise<Json> {
    const seen = this.messages.find(pred);
    if (seen) return Promise.resolve(seen);
    if (this.exited) return Promise.reject(new Error(`${this.exited} before ${label}; server stderr: ${this.stderr}`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        pred,
        label,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`timed out waiting for ${label}; server stderr: ${this.stderr}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  request(id: number, method: string, params?: unknown): Promise<Json> {
    const reply = this.waitFor((m) => m.id === id, `${method} #${id}`);
    this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return reply;
  }

  callTool(id: number, name: string, args?: unknown): Promise<Json> {
    return this.request(id, 'tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
  }

  /** End stdin and wait for the process to exit; resolves to the exit code. */
  async close(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    const exited = once(this.child, 'exit');
    this.child.stdin.end();
    const [code] = await exited;
    return code as number | null;
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}

const bridgeEnv = (apiUrl: string, role: string, extra: Record<string, string> = {}) => ({
  AUTOPILOT_API_URL: apiUrl,
  AUTOPILOT_RUN_TOKEN: 'run-token-123',
  AUTOPILOT_ROLE: role,
  ...extra,
});

test('handshake, role-filtered tools/list, ping, notifications and unknown methods', async (t) => {
  const client = new McpClient(bridgeEnv('http://127.0.0.1:4777', 'reviewer'));
  t.after(() => client.kill());

  const init = await client.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.304' } });
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.result.protocolVersion, '2025-03-26', 'echoes the version the client asked for');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(typeof init.result.serverInfo.name, 'string');
  assert.equal(typeof init.result.serverInfo.version, 'string');
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await client.request(2, 'tools/list', {});
  const tools = list.result.tools as Json[];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_task_context', 'propose_task', 'report_progress']);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
    assert.ok(tool.description.length > 80, `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, 'object');
  }

  client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  assert.deepEqual((await client.request(3, 'ping')).result, {});
  const unknown = await client.request(4, 'resources/list', {});
  assert.equal(unknown.error.code, -32601);
  client.send('this is not json');
  const parseError = await client.waitFor((m) => m.id === null, 'parse error');
  assert.equal(parseError.error.code, -32700);
  assert.equal((await client.request(5, 'initialize', {})).result.protocolVersion, '2025-06-18', 'default protocol version');

  assert.equal(await client.close(), 0, 'exits cleanly when stdin ends');
  // Notifications got no reply, replies came in order, and stdout carried only JSON-RPC.
  assert.deepEqual(client.messages.map((m) => m.id), [1, 2, 3, 4, null, 5]);
  assert.deepEqual(client.invalidLines, []);
  assert.ok(client.messages.every((m) => m.jsonrpc === '2.0'));
});

test('tools/call forwards the arguments with the run token and returns the JSON body', async (t) => {
  const stub = await startStub((name) =>
    name === 'report_progress' ? { status: 200, body: { ok: true }, delayMs: 150 } : { status: 200, body: { task: { id: 'T-9' } } },
  );
  t.after(() => stub.close());
  const client = new McpClient(bridgeEnv(`${stub.url}/`, 'builder'));
  t.after(() => client.kill());

  await client.request(1, 'initialize', { protocolVersion: '2025-06-18' });
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await client.request(2, 'tools/list')).result.tools.length, 5, 'builders get every tool');

  // A slow call followed at once by a ping: lines are handled strictly in order.
  const call = client.callTool(3, 'report_progress', { note: 'Form done; running tests' });
  const ping = client.request(4, 'ping');
  const [res] = await Promise.all([call, ping]);
  assert.equal(res.result.isError, undefined);
  assert.deepEqual(res.result.content.map((c: Json) => c.type), ['text']);
  assert.deepEqual(JSON.parse(res.result.content[0].text), { ok: true });
  assert.deepEqual(client.messages.slice(-2).map((m) => m.id), [3, 4]);

  // Omitted arguments are sent as {}.
  const ctx = await client.callTool(5, 'get_task_context');
  assert.deepEqual(JSON.parse(ctx.result.content[0].text), { task: { id: 'T-9' } });

  assert.equal(stub.requests.length, 2);
  const [first, second] = stub.requests;
  assert.equal(first.method, 'POST');
  assert.equal(first.url, '/agent/tools/report_progress', 'trailing slash of the API URL is ignored');
  assert.equal(first.authorization, 'Bearer run-token-123');
  assert.match(first.contentType ?? '', /^application\/json/);
  assert.deepEqual(first.body, { note: 'Form done; running tests' });
  assert.equal(second.url, '/agent/tools/get_task_context');
  assert.deepEqual(second.body, {});
  assert.equal(await client.close(), 0);
});

test('supervisor errors become isError tool results', async (t) => {
  const stub = await startStub((name) => {
    if (name === 'request_decision') return { status: 409, body: { error: 'lease_lost', message: LEASE_LOST } };
    if (name === 'check_decision') return { status: 502, body: 'Bad gateway' };
    if (name === 'propose_task') return { status: 403, body: { error: 'forbidden' } };
    return { status: 200, body: { ok: true } };
  });
  t.after(() => stub.close());
  const client = new McpClient(bridgeEnv(stub.url, 'builder'));
  t.after(() => client.kill());

  const lost = await client.callTool(1, 'request_decision', { question: 'Which colour?' });
  assert.equal(lost.result.isError, true);
  assert.deepEqual(lost.result.content, [{ type: 'text', text: LEASE_LOST }]);
  const gateway = await client.callTool(2, 'check_decision', { decisionId: 'D-1' });
  assert.equal(gateway.result.isError, true);
  assert.equal(gateway.result.content[0].text, 'HTTP 502');
  const forbidden = await client.callTool(3, 'propose_task', { title: 'x' });
  assert.equal(forbidden.result.isError, true);
  assert.equal(forbidden.result.content[0].text, 'forbidden');
  assert.equal(await client.close(), 0);
});

test('tools outside the role and malformed calls are rejected without contacting the supervisor', async (t) => {
  const stub = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(() => stub.close());
  const client = new McpClient(bridgeEnv(stub.url, 'planner'));
  t.after(() => client.kill());

  // Planners get only what the supervisor allows them; their questions go in the plan result.
  const list = await client.request(1, 'tools/list');
  assert.deepEqual(list.result.tools.map((tool: Json) => tool.name), ['report_progress']);
  const calls: [number, unknown][] = [
    [2, { name: 'get_task_context', arguments: {} }],
    [3, { name: 'propose_task', arguments: { title: 'x' } }],
    [4, { name: 'request_decision', arguments: { question: 'Which audience first?' } }],
    [5, { name: 'check_decision', arguments: { decisionId: 'D-1' } }],
    [6, { name: '../../inbox/respond', arguments: {} }],
    [7, { arguments: {} }],
    [8, { name: 'report_progress', arguments: ['note'] }],
  ];
  for (const [id, params] of calls) {
    const res = await client.request(id, 'tools/call', params);
    assert.equal(res.error?.code, -32602, JSON.stringify(params));
  }
  assert.equal(stub.requests.length, 0);
  assert.equal(await client.close(), 0);
});

test('an unreachable or silent supervisor tells the agent to wrap up', async (t) => {
  const port = await closedPort();
  const down = new McpClient(bridgeEnv(`http://127.0.0.1:${port}`, 'builder'));
  t.after(() => down.kill());
  const refused = await down.callTool(1, 'report_progress', { note: 'x' });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /supervisor is unreachable/);
  assert.match(refused.result.content[0].text, /end your run/);
  assert.equal(await down.close(), 0);

  const stub = await startStub(() => ({ status: 200, body: { ok: true }, delayMs: 5_000 }));
  t.after(() => stub.close());
  const silent = new McpClient(bridgeEnv(stub.url, 'builder', { AUTOPILOT_TOOL_TIMEOUT_MS: '200' }));
  t.after(() => silent.kill());
  const started = Date.now();
  const timedOut = await silent.callTool(1, 'report_progress', { note: 'x' });
  assert.equal(timedOut.result.isError, true);
  assert.match(timedOut.result.content[0].text, /supervisor is unreachable \(no response in time\)/);
  assert.ok(Date.now() - started < 4_000, 'the call gives up instead of waiting for the slow reply');
  assert.equal(await silent.close(), 0);
});

test('end to end: a builder files a card through the bridge and is fenced after losing its lease', async (t) => {
  // Real AgentApi + Store behind a minimal HTTP adapter (the production route lives in src/http/server.ts).
  const store = Store.open(':memory:');
  t.after(() => store.close());
  store.upsertProject(defaultConfig('demo', 'Demo', '/tmp/demo'));
  const task = store.createTask({ projectId: 'demo', title: 'Onboarding', objective: 'Build onboarding', origin: 'human' });
  const runId = store.nextId('R');
  const claim = store.claim(task.id, ['ready'], 'building', runId, 60_000)!;
  const token = randomToken();
  store.createRun({ id: runId, projectId: 'demo', taskId: task.id, role: 'builder', generation: claim.generation, tokenHash: sha256Hex(token), cwd: '/tmp/wt', sessionId: null, logPath: null });
  const api = new AgentApi(store);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const name = /^\/agent\/tools\/([a-z_]+)$/.exec(req.url ?? '')?.[1] ?? '';
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const out = await api.callTool(bearer, name, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new McpClient(bridgeEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'builder', { AUTOPILOT_RUN_TOKEN: token }));
  t.after(() => client.kill());

  const asked = await client.callTool(1, 'request_decision', {
    question: 'What should a new user see first?',
    options: [
      { id: 'sample', label: 'One sample habit' },
      { id: 'blank', label: 'Start empty' },
    ],
    recommendation: 'sample',
  });
  assert.equal(asked.result.isError, undefined);
  const out = JSON.parse(asked.result.content[0].text);
  assert.equal(out.status, 'pending');
  assert.match(out.instructions, /needs_decision/);
  assert.deepEqual(store.pendingBlockingFor(task.id).map((d) => d.id), [out.decisionId]);

  const invalid = await client.callTool(2, 'request_decision', { question: 'Q?', options: [{ id: 'a', label: 'A' }] });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /2 to 6 entries/);

  store.breakLease(task.id, runId, 'ready', 'supervisor restarted');
  const fenced = await client.callTool(3, 'report_progress', { note: 'still going' });
  assert.equal(fenced.result.isError, true);
  assert.equal(fenced.result.content[0].text, LEASE_LOST);
  assert.equal(await client.close(), 0);
});

/** A temp dir removed after the test. */
function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ap-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the bridge recognises itself as the entry point by real path', (t) => {
  const tmp = tempDir(t);
  const real = path.join(ROOT, SERVER_ENTRY);
  const url = pathToFileURL(real).href;
  const link = path.join(tmp, 'bridge.ts');
  symlinkSync(real, link);
  assert.equal(isEntryPoint(real, url), true);
  assert.equal(isEntryPoint(link, url), true, 'a symlinked launch path counts');
  assert.equal(isEntryPoint(undefined, url), false, 'node -e / REPL');
  assert.equal(isEntryPoint('', url), false);
  assert.equal(isEntryPoint(path.join(tmp, 'missing.ts'), url), false, 'a path that does not exist');
  assert.equal(isEntryPoint(path.join(ROOT, 'src/agent-api.ts'), url), false, 'imported by another program');
});

test('the bridge starts when launched through a symlink', async (t) => {
  const link = path.join(tempDir(t), 'bridge.ts');
  symlinkSync(path.join(ROOT, SERVER_ENTRY), link);
  const client = new McpClient(bridgeEnv('http://127.0.0.1:4777', 'reviewer'), { entry: link });
  t.after(() => client.kill());
  assert.equal((await client.request(1, 'initialize', {})).result.serverInfo.name, 'stayon-autopilot');
  assert.equal((await client.request(2, 'tools/list')).result.tools.length, 3);
  assert.equal(await client.close(), 0);
});

// Node 24.0 and 24.1 have no import.meta.main (it arrived in 24.2) and package.json accepts any
// Node 24. This load hook hides it from the bridge the way those versions would.
const HIDE_IMPORT_META_MAIN = `
export async function load(url, context, nextLoad) {
  const out = await nextLoad(url, context);
  if (!url.endsWith('/src/mcp/server.ts')) return out;
  process.stderr.write('[hide-main] loading server.ts as Node 24.0 would\\n');
  return { ...out, source: String(out.source).replaceAll('import.meta.main', 'undefined') };
}
`;

test('the bridge starts on Node versions without import.meta.main', async (t) => {
  const tmp = tempDir(t);
  writeFileSync(path.join(tmp, 'hide-main.mjs'), HIDE_IMPORT_META_MAIN);
  writeFileSync(path.join(tmp, 'register.mjs'), "import { register } from 'node:module';\nregister(new URL('./hide-main.mjs', import.meta.url));\n");
  const client = new McpClient(bridgeEnv('http://127.0.0.1:4777', 'builder'), { nodeArgs: ['--import', pathToFileURL(path.join(tmp, 'register.mjs')).href] });
  t.after(() => client.kill());
  const init = await client.request(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'stayon-autopilot');
  assert.equal(await client.close(), 0);
  assert.match(client.stderr, /\[hide-main\] loading server\.ts/, 'the hook really rewrote the bridge');
});

test('loading the bridge and the tool definitions does not open the database', async () => {
  // agent-api.ts must import Store as a type only; otherwise every worker's bridge would load node:sqlite.
  const script = [
    "await import('./src/agent-api.ts');",
    "await import('./src/mcp/server.ts');",
    'process.stdout.write(JSON.stringify(process.moduleLoadList.filter((m) => /sqlite/i.test(m))));',
  ].join('\n');
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { cwd: ROOT, env });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), []);
});

test('without role or API settings the bridge lists every tool and reports itself unconfigured', async (t) => {
  const client = new McpClient({});
  t.after(() => client.kill());
  assert.equal((await client.request(1, 'tools/list')).result.tools.length, 5);
  const res = await client.callTool(2, 'report_progress', { note: 'x' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /AUTOPILOT_API_URL/);
  assert.equal(await client.close(), 0);
  assert.match(client.stderr, /AUTOPILOT_ROLE is missing/);
  assert.deepEqual(client.invalidLines, []);
});
