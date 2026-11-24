// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { Store } from '../src/store.ts';
import { defaultConfig } from '../src/config.ts';
import { sha256Hex } from '../src/util.ts';
import { BODY_LIMIT_BYTES, DIGEST_EVENT_CAP, STATIC_CSP, acceptsLoopbackV4, sortPendingDecisions, startHttpServer } from '../src/http/server.ts';
import type { HttpServerOptions } from '../src/http/server.ts';
import {
  agentRequestAllowed,
  bearerToken,
  clearSessionCookie,
  createPairingCode,
  exchangePairingCode,
  isLoopbackAddress,
  parseCookies,
  sessionCookie,
} from '../src/http/auth.ts';
import type { AgentToolHandler, DecisionPriority, SupervisorActions } from '../src/types.ts';

const STATIC_DIR = join(import.meta.dirname, '..', 'src', 'inbox');
const HOUR = 3_600_000;
const execFileP = promisify(execFile);
/** Lets pending promises, fetch bodies and timers-free callbacks run to completion. */
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

type Json = any; // response bodies are checked field by field

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Json;
}

interface RequestOptions {
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  /** Send the paired CSRF token on non-GET requests (default true). */
  csrf?: boolean;
}

/** fetch wrapper that keeps the ap_session cookie by hand, like a browser would. */
class Client {
  readonly base: string;
  cookie = '';
  csrf = '';

  constructor(base: string) {
    this.base = base;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && opts.csrf !== false && this.csrf) headers['x-csrf-token'] ??= this.csrf;
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetch(this.base + path, { method, headers, body });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (pair.slice(0, eq) === 'ap_session') this.cookie = pair.slice(eq + 1) ? pair : '';
    }
    const text = await res.text();
    let json: Json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  get(path: string, opts: RequestOptions = {}): Promise<Reply> {
    return this.request('GET', path, opts);
  }

  post(path: string, json: unknown = {}, opts: RequestOptions = {}): Promise<Reply> {
    return this.request('POST', path, { ...opts, json });
  }

  async pair(store: Store): Promise<void> {
    const r = await this.post('/api/pair', { code: createPairingCode(store) });
    assert.equal(r.status, 200);
    this.csrf = r.json.csrf;
  }
}

/** GET with a literal, unnormalised path (fetch would resolve "..") on a fresh connection. */
function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

async function setup(t: TestContext) {
  let now = 1_700_000_000_000;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const store = Store.open(':memory:', clock.now);
  store.upsertProject(defaultConfig('demo', 'Demo', '/tmp/demo'));
  store.upsertProject(defaultConfig('side', 'Side Project', '/tmp/side'));

  const calls: { name: string; args: unknown[] }[] = [];
  const failNext: { error: Error | null } = { error: null };
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
    if (failNext.error) {
      const err = failNext.error;
      failNext.error = null;
      throw err;
    }
  };
  const actions: SupervisorActions = {
    wake: () => record('wake'),
    pauseAll: (reason) => {
      record('pauseAll', reason);
      store.setPausedAll(true, reason);
    },
    resumeAll: (reason) => {
      record('resumeAll', reason);
      store.setPausedAll(false, reason);
    },
    pauseProject: (id, reason) => {
      record('pauseProject', id, reason);
      store.setProjectPaused(id, true, reason);
    },
    resumeProject: (id, reason) => {
      record('resumeProject', id, reason);
      store.setProjectPaused(id, false, reason);
    },
    addTask: (input) => {
      record('addTask', input);
      return store.createTask({ ...input, origin: 'human' });
    },
    retryTask: (id) => {
      record('retryTask', id);
      return store.transition(id, 'exhausted', 'ready', 'retried from the inbox');
    },
    cancelTask: (id) => {
      record('cancelTask', id);
      return store.transition(id, ['proposed', 'ready', 'exhausted', 'waiting_decision', 'checking'], 'cancelled', 'cancelled from the inbox');
    },
  };

  const toolCalls: { token: string; name: string; args: unknown }[] = [];
  const agentTools: AgentToolHandler = {
    async callTool(token, name, args) {
      toolCalls.push({ token, name, args });
      if (name === 'explode') throw new Error('secret internal detail');
      return { status: 202, body: { ok: true, tool: name } };
    },
  };

  const errors: string[] = [];
  const srv = await startHttpServer({
    store,
    agentTools,
    actions,
    staticDir: STATIC_DIR,
    host: '127.0.0.1',
    port: 0,
    now: clock.now,
    onError: (context, err) => errors.push(`${context}: ${err instanceof Error ? err.message : String(err)}`),
  });
  t.after(async () => {
    await srv.close();
    store.close();
  });
  return { store, clock, calls, failNext, toolCalls, errors, srv, client: new Client(srv.url) };
}

// ------------------------------------------------------------------ static

test('serves the inbox shell with strict security headers', async (t) => {
  const { client } = await setup(t);
  const r = await client.get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
  assert.equal(
    r.headers.get('content-security-policy'),
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.match(r.text, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(r.text, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(r.text, /<link rel="stylesheet" href="\/styles\.css">/);

  const types: Record<string, RegExp> = {
    '/index.html': /^text\/html/,
    '/app.js': /^text\/javascript/,
    '/sw.js': /^text\/javascript/,
    '/styles.css': /^text\/css/,
    '/manifest.webmanifest': /^application\/manifest\+json/,
    '/icon.svg': /^image\/svg\+xml/,
  };
  for (const [path, type] of Object.entries(types)) {
    const res = await client.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', type, path);
    assert.equal(res.headers.get('content-security-policy'), STATIC_CSP, path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', path);
  }

  const etag = r.headers.get('etag');
  assert.ok(etag);
  const again = await client.get('/', { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304, 'unchanged files revalidate cheaply');
});

test('only whitelisted static files are served', async (t) => {
  const { client, srv } = await setup(t);
  for (const path of ['/nope.html', '/src/inbox/app.js', '/index.html/', '/APP.JS', '/.env', '/app.js.map', '/package.json']) {
    assert.equal((await client.get(path)).status, 404, path);
  }
  for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '//etc/passwd', '/inbox/../../package.json']) {
    assert.equal(await rawGet(srv.port, path), 404, path);
  }
  assert.equal((await client.request('POST', '/', { body: 'x' })).status, 405);
  const api404 = await client.get('/api/nope');
  assert.equal(api404.status, 404);
  assert.equal(api404.headers.get('cache-control'), 'no-store');
  assert.deepEqual(api404.json, { error: 'not found' });
});

// -------------------------------------------------------------------- auth

test('pairing codes work once, expire, and set an HttpOnly session cookie', async (t) => {
  const { store, clock, client, srv } = await setup(t);
  assert.deepEqual((await client.get('/api/me')).json, { authenticated: false });

  const code = createPairingCode(store);
  const r = await client.post('/api/pair', { code });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.csrf, 'string');
  const [cookie] = r.headers.getSetCookie();
  assert.match(cookie, /^ap_session=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  assert.deepEqual((await client.get('/api/me')).json, { authenticated: true, csrf: r.json.csrf });

  // Only the token's hash is stored.
  const token = client.cookie.slice('ap_session='.length);
  const hashes = (store.db.prepare('SELECT token_hash FROM inbox_sessions').all() as { token_hash: string }[]).map((x) => x.token_hash);
  assert.deepEqual(hashes, [sha256Hex(token)]);

  const other = new Client(srv.url);
  const reused = await other.post('/api/pair', { code });
  assert.equal(reused.status, 401, 'a code works once');
  assert.deepEqual(reused.headers.getSetCookie(), []);

  const shortLived = createPairingCode(store, 60_000);
  clock.advance(60_001);
  assert.equal((await other.post('/api/pair', { code: shortLived })).status, 401, 'expired');
  assert.equal((await other.post('/api/pair', { code: 'definitely-not-a-code' })).status, 401);
  assert.equal((await other.post('/api/pair', {})).status, 401);
  assert.equal((await other.get('/api/overview')).status, 401);

  // Behind Tailscale Serve (https) the cookie is also Secure.
  const secure = await other.post('/api/pair', { code: createPairingCode(store) }, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.getSetCookie()[0], /; Secure$/);
  assert.equal((await other.get('/api/overview')).status, 200);
});

test('pairing attempts are rate limited to 10 per minute', async (t) => {
  const { store, clock, client } = await setup(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await client.post('/api/pair', { code: `wrong-code-number-${i}` })).status, 401);
  }
  const code = createPairingCode(store);
  const limited = await client.post('/api/pair', { code });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  clock.advance(61_000);
  assert.equal((await client.post('/api/pair', { code })).status, 200, 'the code was not burnt by the limited attempt');
});

test('API requires a session, the CSRF token and a same-origin Origin', async (t) => {
  const { store, client, calls } = await setup(t);
  for (const path of ['/api/overview', '/api/decisions', '/api/tasks', '/api/tasks/T-1', '/api/digest']) {
    const r = await client.get(path);
    assert.equal(r.status, 401, path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/, path);
  }
  assert.equal((await client.post('/api/pause', { scope: 'all', paused: true })).status, 401);

  await client.pair(store);
  const noCsrf = await client.post('/api/pause', { scope: 'all', paused: true }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error, 'csrf');
  assert.equal((await client.post('/api/pause', { scope: 'all', paused: true }, { headers: { 'x-csrf-token': 'not-the-token' } })).status, 403);
  assert.equal((await client.post('/api/pause', { scope: 'all', paused: true }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await client.post('/api/pause', { scope: 'all', paused: true }, { headers: { origin: 'null' } })).status, 403);
  assert.equal(calls.length, 0, 'rejected requests never reach the supervisor');

  const ok = await client.post('/api/pause', { scope: 'all', paused: true }, { headers: { origin: client.base } });
  assert.equal(ok.status, 200);
  // Behind a proxy that rewrites Host, the forwarded host is the browser's origin.
  const proxied = await client.post(
    '/api/pause',
    { scope: 'all', paused: false },
    { headers: { origin: 'https://box.tailnet.ts.net', 'x-forwarded-host': 'box.tailnet.ts.net', 'x-forwarded-proto': 'https' } },
  );
  assert.equal(proxied.status, 200);
  assert.deepEqual(calls.map((c) => c.name), ['pauseAll', 'resumeAll']);

  const stolen = client.cookie;
  const out = await client.post('/api/logout', {});
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /^ap_session=; .*Max-Age=0/);
  assert.equal(client.cookie, '');
  assert.equal((await client.get('/api/overview')).status, 401);
  client.cookie = stolen;
  assert.equal((await client.get('/api/overview')).status, 401, 'logout revokes the session server-side');
  assert.deepEqual((await client.get('/api/me')).json, { authenticated: false });
});

test('request bodies: 64 KB limit, JSON only, well-formed objects', async (t) => {
  const { store, client, calls } = await setup(t);
  await client.pair(store);

  const big = await client.post('/api/tasks', { projectId: 'demo', title: 'x', objective: 'y'.repeat(BODY_LIMIT_BYTES) });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, 'body too large');

  // Same limit for a streamed (chunked) body.
  const payload = new TextEncoder().encode(JSON.stringify({ projectId: 'demo', title: 'x', objective: 'z'.repeat(BODY_LIMIT_BYTES) }));
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < payload.length; i += 16_384) controller.enqueue(payload.slice(i, i + 16_384));
      controller.close();
    },
  });
  const chunked = await fetch(`${client.base}/api/tasks`, {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { cookie: client.cookie, 'x-csrf-token': client.csrf, 'content-type': 'application/json' },
  } as RequestInit);
  assert.equal(chunked.status, 413);
  await chunked.arrayBuffer();

  assert.equal((await client.request('POST', '/api/tasks', { body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await client.request('POST', '/api/tasks', { body: '{"title":"x"}' })).status, 415, 'text/plain is not JSON');
  const malformed = await client.request('POST', '/api/tasks', { body: '{"projectId":', headers: { 'content-type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error, 'malformed JSON');
  assert.equal((await client.request('POST', '/api/tasks', { body: '[1,2]', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await client.get('/api/overview')).status, 200, 'the connection is still usable');
});

// --------------------------------------------------------------- decisions

test('responding to a decision: stale, invalid, saved, duplicate, not pending, not found', async (t) => {
  const { store, client, calls } = await setup(t);
  await client.pair(store);
  const task = store.createTask({ projectId: 'demo', title: 'Onboarding', objective: 'x', origin: 'human' });
  const { decision } = store.createDecision({
    projectId: 'demo',
    taskId: task.id,
    kind: 'choice',
    question: 'Which empty state?',
    options: [
      { id: 'example', label: 'Show one sample' },
      { id: 'blank', label: 'Start empty' },
    ],
    recommendation: 'example',
    createdBy: 'agent',
  });
  store.reviseDecision(decision.id, { question: 'Which empty state for Today?' });
  const url = `/api/decisions/${decision.id}/respond`;
  const wakes = () => calls.filter((c) => c.name === 'wake').length;

  const stale = await client.post(url, { revision: 1, optionId: 'blank', idempotencyKey: 'key-stale-00001' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.status, 'stale_revision');
  assert.equal(stale.json.currentRevision, 2);
  assert.equal(stale.json.decision.revision, 2, 'the fresh card comes back');
  assert.equal(stale.json.decision.question, 'Which empty state for Today?');
  assert.equal(stale.json.decision.taskTitle, 'Onboarding');
  assert.equal(stale.json.decision.projectName, 'Demo');

  const invalid = await client.post(url, { revision: 2, optionId: 'nope', idempotencyKey: 'key-invalid-0001' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.status, 'invalid');
  assert.match(invalid.json.reason, /unknown option/);
  assert.equal((await client.post(url, { revision: '2', optionId: 'blank', idempotencyKey: 'key-badtype-001' })).status, 400);
  assert.equal((await client.post(url, { revision: 2, optionId: 7, idempotencyKey: 'key-badtype-002' })).status, 400);
  assert.equal((await client.post(url, { revision: 2, optionId: 'blank' })).json.reason, 'idempotency key missing');
  assert.equal(wakes(), 0);

  const saved = await client.post(url, { revision: 2, optionId: 'blank', comment: ' keep it calm ', idempotencyKey: 'key-saved-00001' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.status, 'saved');
  assert.equal(saved.json.decision.status, 'answered');
  assert.equal(saved.json.decision.answer.optionId, 'blank');
  assert.equal(saved.json.decision.answer.comment, 'keep it calm');
  assert.equal(saved.json.decision.answer.actor, 'founder');
  assert.equal(wakes(), 1, 'the supervisor is woken after a saved answer');

  const retried = await client.post(url, { revision: 2, optionId: 'blank', comment: ' keep it calm ', idempotencyKey: 'key-saved-00001' });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.status, 'duplicate');
  assert.equal(retried.json.decision.answer.optionId, 'blank');
  assert.equal(wakes(), 1);

  const late = await client.post(url, { revision: 2, optionId: 'example', idempotencyKey: 'key-late-000001' });
  assert.equal(late.status, 409);
  assert.equal(late.json.status, 'not_pending');
  assert.equal(late.json.decision.answer.optionId, 'blank');

  const missing = await client.post('/api/decisions/D-999/respond', { revision: 1, optionId: 'x', idempotencyKey: 'key-missing-001' });
  assert.equal(missing.status, 404);
  assert.equal(store.pendingOutbox().filter((o) => o.kind === 'decision_answered').length, 1, 'exactly one delivery');
});

test('a failing wake does not lose a saved answer', async (t) => {
  const { store, client, failNext, errors } = await setup(t);
  await client.pair(store);
  const { decision } = store.createDecision({ projectId: 'demo', kind: 'info', question: 'FYI', options: [{ id: 'ok', label: 'OK' }], createdBy: 'supervisor' });
  failNext.error = new Error('supervisor busy');
  const r = await client.post(`/api/decisions/${decision.id}/respond`, { revision: 1, optionId: 'ok', idempotencyKey: 'key-wake-fail-1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'saved');
  assert.equal(errors.length, 1);
});

test('decision lists: inbox order, deferral, project filter and answered history', async (t) => {
  const { store, clock, client } = await setup(t);
  await client.pair(store);
  const make = (question: string, priority: DecisionPriority, projectId = 'demo') => {
    const { decision } = store.createDecision({ projectId, kind: 'choice', question, priority, options: [{ id: 'a', label: 'A' }], createdBy: 'agent' });
    clock.advance(1000);
    return decision.id;
  };
  const low = make('low', 'low');
  const normal = make('normal', 'normal');
  const high = make('high', 'high');
  const urgent = make('urgent', 'urgent');
  const normalLater = make('normal later', 'normal');
  const side = make('side project', 'normal', 'side');
  const ids = async (query = '') => (await client.get(`/api/decisions${query}`)).json.decisions.map((d: Json) => d.id);

  assert.deepEqual(await ids(), [urgent, high, normal, normalLater, side, low]);
  assert.deepEqual(await ids('?status=pending&project=demo'), [urgent, high, normal, normalLater, low]);

  const deferred = await client.post(`/api/decisions/${high}/defer`, { hours: 4 });
  assert.equal(deferred.status, 200);
  assert.equal(deferred.json.decision.deferredUntil, clock.now() + 4 * HOUR);
  assert.equal(deferred.json.decision.deferred, true);
  assert.deepEqual(await ids(), [urgent, normal, normalLater, side, low, high], 'deferred cards go last');
  clock.advance(4 * HOUR + 1);
  assert.deepEqual(await ids(), [urgent, high, normal, normalLater, side, low], 'and come back when due');

  for (const hours of [0, 169, 'four', null]) {
    assert.equal((await client.post(`/api/decisions/${high}/defer`, { hours })).status, 400, String(hours));
  }
  assert.equal((await client.post('/api/decisions/D-999/defer', { hours: 2 })).status, 404);

  store.respond({ decisionId: low, revision: 1, optionId: 'a', actor: 'founder', idempotencyKey: 'answer-low-0001' });
  clock.advance(1000);
  store.respond({ decisionId: urgent, revision: 1, optionId: 'a', actor: 'founder', idempotencyKey: 'answer-urgent-01' });
  assert.equal((await client.post(`/api/decisions/${low}/defer`, { hours: 2 })).status, 409);
  assert.deepEqual(await ids('?status=answered'), [urgent, low], 'newest answer first');
  const all = await ids('?status=all');
  assert.deepEqual(all, [high, normal, normalLater, side, urgent, low]);
  assert.equal((await client.get('/api/decisions?status=bogus')).status, 400);

  const view = (await client.get('/api/decisions')).json.decisions[0];
  for (const key of ['taskTitle', 'taskState', 'projectName', 'deferred', 'options', 'revision', 'why', 'links']) assert.ok(key in view, key);
});

// ------------------------------------------------------------ overview etc.

test('overview reports projects, task counts, pauses and active runs', async (t) => {
  const { store, clock, client } = await setup(t);
  await client.pair(store);
  const building = store.createTask({ projectId: 'demo', title: 'Build A', objective: 'a', origin: 'human' });
  store.createTask({ projectId: 'demo', title: 'Build B', objective: 'b', origin: 'human' });
  store.createTask({ projectId: 'demo', title: 'An idea', objective: 'c', origin: 'agent' });
  const claim = store.claim(building.id, ['ready'], 'building', 'R-1', 60_000);
  assert.ok(claim);
  store.createRun({ id: 'R-1', projectId: 'demo', taskId: building.id, role: 'builder', generation: claim.generation, tokenHash: 'hash-1', cwd: '/tmp/wt', sessionId: 'sess-1', logPath: null });
  const startedAt = clock.now();
  clock.advance(5000);
  store.touchRun('R-1');
  store.createDecision({ projectId: 'demo', taskId: building.id, kind: 'choice', question: 'Which?', createdBy: 'agent' });
  store.setProjectPaused('side', true, 'holiday');
  store.setUsagePause(clock.now() + HOUR, 'five-hour limit');

  const r = await client.get('/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.now, clock.now());
  assert.equal(r.json.pausedAll, false);
  assert.equal(r.json.usagePausedUntil, clock.now() + HOUR);
  const demo = r.json.projects.find((p: Json) => p.id === 'demo');
  assert.equal(demo.name, 'Demo');
  assert.equal(demo.profile, 'balanced_autopilot');
  assert.equal(demo.paused, false);
  assert.equal(demo.pauseReason, null);
  assert.equal(demo.pendingDecisions, 1);
  assert.equal(Object.keys(demo.counts).length, 12, 'every state is listed');
  assert.deepEqual([demo.counts.building, demo.counts.ready, demo.counts.proposed, demo.counts.integrated], [1, 1, 1, 0]);
  const side = r.json.projects.find((p: Json) => p.id === 'side');
  assert.deepEqual([side.paused, side.pauseReason], [true, 'holiday']);
  assert.deepEqual(r.json.activeRuns, [
    { id: 'R-1', role: 'builder', projectId: 'demo', taskId: building.id, taskTitle: 'Build A', startedAt, heartbeatAt: clock.now(), sessionId: 'sess-1' },
  ]);
});

test('task list, task detail, and task actions', async (t) => {
  const { store, client, calls, failNext, errors } = await setup(t);
  await client.pair(store);
  const task = store.createTask({ projectId: 'demo', title: 'Checkout', objective: 'Build checkout', acceptanceCriteria: ['card payments work'], origin: 'human' });
  store.createTask({ projectId: 'side', title: 'Other', objective: 'x', origin: 'human' });

  const list = await client.get('/api/tasks?project=demo');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tasks.map((x: Json) => x.id), [task.id]);
  assert.deepEqual(
    Object.keys(list.json.tasks[0]).sort(),
    ['attempts', 'branch', 'hypothesis', 'id', 'kind', 'prNumber', 'prUrl', 'priority', 'projectId', 'repairCycles', 'risk', 'role', 'state', 'stateReason', 'title', 'updatedAt'].sort(),
  );
  assert.equal((await client.get('/api/tasks')).json.tasks.length, 2);

  const bare = await client.get(`/api/tasks/${task.id}`);
  assert.equal(bare.status, 200);
  assert.deepEqual(bare.json.checks, { branch: [], integration: [] }, 'no head commit yet');
  assert.equal(bare.json.review, null);

  const claim = store.claim(task.id, ['ready'], 'building', 'R-7', 60_000);
  assert.ok(claim);
  store.createRun({ id: 'R-7', projectId: 'demo', taskId: task.id, role: 'builder', generation: claim.generation, tokenHash: 'h7', cwd: '/tmp/wt/checkout', sessionId: 'sess-7', logPath: null });
  store.finishRun('R-7', { status: 'succeeded', result: { status: 'completed', summary: 'Built checkout', changes: ['x'.repeat(50_000)] }, resultText: 'done' });
  store.release(task.id, 'R-7', claim.generation, 'checking', 'built', { headCommit: 'abc123' });
  store.recordChecks(task.id, 'abc123', 'branch', [{ name: 'test', command: ['npm', 'test'], status: 'passed', durationMs: 1200, outputTail: 'ok' }]);
  store.recordChecks(task.id, 'abc123', 'integration', [{ name: 'test', command: ['npm', 'test'], status: 'failed', durationMs: 900, outputTail: 'boom' }]);
  store.recordChecks(task.id, 'old000', 'branch', [{ name: 'lint', command: ['npm', 'run', 'lint'], status: 'failed', durationMs: 5, outputTail: '' }]);
  store.recordReview({ taskId: task.id, runId: null, headCommit: 'abc123', verdict: 'approve', risk: 'low', summary: 'Looks right', findings: [{ severity: 'nit', issue: 'naming' }] });
  store.createDecision({ projectId: 'demo', taskId: task.id, kind: 'review', question: 'Ship it?', createdBy: 'reviewer' });

  const detail = await client.get(`/api/tasks/${task.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.task.objective, 'Build checkout');
  assert.deepEqual(detail.json.task.acceptanceCriteria, ['card payments work']);
  assert.equal(detail.json.runs.length, 1);
  const run = detail.json.runs[0];
  assert.deepEqual([run.id, run.sessionId, run.cwd, run.status], ['R-7', 'sess-7', '/tmp/wt/checkout', 'succeeded']);
  assert.deepEqual([run.resultStatus, run.resultSummary], ['completed', 'Built checkout']);
  assert.equal('result' in run, false, 'raw result blobs stay on the server');
  assert.ok(detail.text.length < 20_000);
  assert.deepEqual(detail.json.checks.branch.map((c: Json) => [c.name, c.status]), [['test', 'passed']], 'only checks for the current head');
  assert.deepEqual(detail.json.checks.integration.map((c: Json) => [c.name, c.status]), [['test', 'failed']]);
  assert.equal(detail.json.review.summary, 'Looks right');
  assert.deepEqual(detail.json.decisions.map((d: Json) => [d.question, d.taskTitle]), [['Ship it?', 'Checkout']]);
  assert.ok(detail.json.events.some((e: Json) => e.type === 'task.created'));
  assert.equal((await client.get('/api/tasks/T-999')).status, 404);

  const added = await client.post('/api/tasks', { projectId: 'demo', title: '  Pricing page ', objective: 'Explain plans', acceptanceCriteria: ['shows 3 plans', ' '] });
  assert.equal(added.status, 200);
  assert.equal(added.json.task.title, 'Pricing page');
  assert.deepEqual(calls.at(-1), {
    name: 'addTask',
    args: [{ projectId: 'demo', title: 'Pricing page', objective: 'Explain plans', acceptanceCriteria: ['shows 3 plans'] }],
  });
  assert.equal((await client.post('/api/tasks', { projectId: 'demo', title: '', objective: 'x' })).status, 400);
  assert.equal((await client.post('/api/tasks', { projectId: 'nope', title: 't', objective: 'x' })).status, 400);
  assert.equal((await client.post('/api/tasks', { projectId: 'demo', title: 't', objective: 'x', acceptanceCriteria: 'one' })).status, 400);

  const retryEarly = await client.post(`/api/tasks/${task.id}/retry`, {});
  assert.equal(retryEarly.status, 400, 'a StateError from the supervisor is a 400');
  assert.match(retryEarly.json.error, /expected exhausted/);
  store.transition(task.id, 'checking', 'exhausted', 'out of repair cycles');
  const retried = await client.post(`/api/tasks/${task.id}/retry`, {});
  assert.equal(retried.status, 200);
  assert.equal(retried.json.task.state, 'ready');
  const cancelled = await client.post(`/api/tasks/${added.json.task.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.task.state, 'cancelled');
  assert.equal((await client.post('/api/tasks/T-999/cancel', {})).status, 404);

  failNext.error = new Error('disk failure at /Users/secret/path');
  const crash = await client.post(`/api/tasks/${task.id}/cancel`, {});
  assert.equal(crash.status, 500);
  assert.deepEqual(crash.json, { error: 'internal error' });
  assert.doesNotMatch(crash.text, /secret|disk failure/);
  assert.equal(errors.length, 1);
});

test('digest summarizes the last 24 hours', async (t) => {
  const { store, clock, client } = await setup(t);
  await client.pair(store);
  const integrate = (projectId: string, title: string, patch = {}) => {
    const task = store.createTask({ projectId, title, objective: 'x', origin: 'human' });
    const claim = store.claim(task.id, ['ready'], 'building', `owner-${task.id}`, 60_000);
    assert.ok(claim);
    store.release(task.id, `owner-${task.id}`, claim.generation, 'integrated', 'merged', patch);
    return task.id;
  };
  integrate('demo', 'Shipped long ago');
  clock.advance(25 * HOUR);

  const shipped = integrate('demo', 'Ship pricing', { prUrl: 'https://github.com/acme/app/pull/7', prNumber: 7 });
  const flaky = store.createTask({ projectId: 'demo', title: 'Flaky import', objective: 'x', origin: 'human' });
  const claim = store.claim(flaky.id, ['ready'], 'building', 'R-2', 60_000);
  assert.ok(claim);
  store.createRun({ id: 'R-2', projectId: 'demo', taskId: flaky.id, role: 'builder', generation: claim.generation, tokenHash: 'h2', cwd: '/tmp', sessionId: null, logPath: null });
  store.finishRun('R-2', { status: 'failed', error: 'tests failed' });
  store.createRun({ id: 'R-3', projectId: 'demo', taskId: flaky.id, role: 'reviewer', generation: claim.generation, tokenHash: 'h3', cwd: '/tmp', sessionId: null, logPath: null });
  store.finishRun('R-3', { status: 'succeeded' });
  store.release(flaky.id, 'R-2', claim.generation, 'exhausted', 'out of attempts');
  const { decision } = store.createDecision({ projectId: 'demo', kind: 'choice', question: 'Color?', options: [{ id: 'blue', label: 'Blue' }], createdBy: 'agent' });
  store.respond({ decisionId: decision.id, revision: 1, optionId: 'blue', actor: 'founder', idempotencyKey: 'digest-key-0001' });
  store.setUsagePause(clock.now() + HOUR, 'weekly limit');
  store.event({ type: 'usage.warning', message: 'Approaching the plan usage limit' });
  integrate('side', 'Side ship');

  const r = await client.get('/api/digest?project=demo&hours=24');
  assert.equal(r.status, 200);
  assert.equal(r.json.since, clock.now() - 24 * HOUR);
  assert.equal(r.json.truncated, false);
  assert.deepEqual(r.json.integrated.map((i: Json) => [i.taskId, i.title, i.prUrl]), [[shipped, 'Ship pricing', 'https://github.com/acme/app/pull/7']]);
  assert.deepEqual(r.json.failures.map((e: Json) => `${e.type}:${e.taskId}`), [`task.state:${flaky.id}`, `run.ended:${flaky.id}`], 'newest first');
  assert.equal(r.json.failures[0].taskTitle, 'Flaky import');
  assert.deepEqual(r.json.answered.map((e: Json) => e.decisionId), [decision.id]);
  assert.deepEqual(r.json.usage.map((e: Json) => e.type), ['usage.warning', 'usage.paused'], 'account-wide usage events show under every project');
  assert.deepEqual(r.json.counts, { integrated: 1, failures: 2, answered: 1, usage: 2, pendingDecisions: 0 });

  const everything = await client.get('/api/digest');
  assert.equal(everything.json.integrated.length, 2);
  const week = await client.get('/api/digest?hours=48');
  assert.equal(week.json.integrated.length, 3);
});

test('digest: chatty event types never hide usage pauses, and a cut is reported', async (t) => {
  const { store, clock, client } = await setup(t);
  await client.pair(store);
  store.setUsagePause(clock.now() + HOUR, 'five-hour limit');
  clock.advance(60_000);
  // A busy day: agents report progress on every step (one run.progress event each).
  store.tx(() => {
    for (let i = 0; i <= DIGEST_EVENT_CAP; i++) store.event({ projectId: 'demo', runId: 'R-1', type: 'run.progress', message: `R-1: step ${i}` });
  });
  const busy = await client.get('/api/digest?hours=24');
  assert.deepEqual(busy.json.usage.map((e: Json) => e.type), ['usage.paused']);
  assert.equal(busy.json.counts.usage, 1);
  assert.equal(busy.json.truncated, false, 'progress notes are not part of any digest category');

  // More failures in the window than the digest reads: the newest are kept and the cut is flagged.
  store.tx(() => {
    for (let i = 0; i <= DIGEST_EVENT_CAP; i++) {
      store.event({ projectId: 'demo', runId: `R-${i}`, type: 'run.ended', message: `R-${i} builder failed`, data: { status: 'failed' } });
    }
  });
  const month = await client.get('/api/digest?hours=720');
  assert.equal(month.json.truncated, true);
  assert.equal(month.json.counts.failures, DIGEST_EVENT_CAP);
  assert.equal(month.json.failures[0].message, `R-${DIGEST_EVENT_CAP} builder failed`, 'newest first');
  assert.deepEqual(month.json.usage.map((e: Json) => e.type), ['usage.paused'], 'other categories are unaffected');
});

test('task views mask secrets in agent-written text and keep result text on the server', async (t) => {
  const { store, client } = await setup(t);
  await client.pair(store);
  const secret = `sk-ant-api03-${'Q'.repeat(40)}`;
  const task = store.createTask({ projectId: 'demo', title: 'Payments', objective: 'Wire up billing', origin: 'human' });
  const claim = store.claim(task.id, ['ready'], 'building', 'R-1', 60_000);
  assert.ok(claim);
  store.createRun({ id: 'R-1', projectId: 'demo', taskId: task.id, role: 'builder', generation: claim.generation, tokenHash: 'h1', cwd: '/tmp/wt', sessionId: 's1', logPath: null });
  store.finishRun('R-1', {
    status: 'failed',
    result: { status: 'failed', summary: `Configured the client with api_key=${secret}` },
    resultText: `Done. I used ${secret} from .env`,
    error: `request failed: Authorization: Bearer ${secret}`,
  });
  store.release(task.id, 'R-1', claim.generation, 'ready', `run failed: token=${secret}`, { headCommit: 'abc123' });
  store.addNote(task.id, 'builder', `Set STRIPE token=${secret}`);
  store.recordReview({
    taskId: task.id,
    runId: null,
    headCommit: 'abc123',
    verdict: 'request_changes',
    risk: 'high',
    summary: `Leaked ${secret} in config.ts`,
    findings: [{ severity: 'blocker', file: 'config.ts', line: 3, issue: `hard-coded ${secret}`, suggestion: `read it from the environment, not ${secret}` }, { severity: 'nit', issue: 'naming' }],
  });

  const detail = await client.get(`/api/tasks/${task.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.text.includes(secret), false, 'the key never reaches the phone');
  const run = detail.json.runs[0];
  assert.equal('resultText' in run, false, 'the final result text stays on the server');
  assert.equal(run.resultSummary, 'Configured the client with api_key=[redacted]');
  assert.match(run.error, /^request failed: Authorization: Bearer sk-ant-api03-QQ…\[redacted\]$/);
  assert.equal(detail.json.task.stateReason, 'run failed: token=[redacted]');
  assert.equal(detail.json.task.notes.at(-1).text, 'Set STRIPE token=[redacted]');
  assert.match(detail.json.review.summary, /^Leaked sk-ant-api03-QQ…\[redacted\] in config\.ts$/);
  assert.match(detail.json.review.findings[0].issue, /…\[redacted\]$/);
  assert.match(detail.json.review.findings[0].suggestion, /…\[redacted\]$/);
  assert.deepEqual([detail.json.review.findings[0].file, detail.json.review.findings[0].line], ['config.ts', 3]);
  assert.equal('suggestion' in detail.json.review.findings[1], false);
  assert.ok(detail.json.events.some((e: Json) => e.type === 'run.ended' && e.message.includes('…[redacted]')), 'event lines quote the error');

  for (const path of ['/api/tasks', '/api/digest']) {
    const r = await client.get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.text.includes(secret), false, path);
  }
  assert.equal((await client.get('/api/tasks')).json.tasks[0].stateReason, 'run failed: token=[redacted]');
});

test('pause routes call the supervisor actions', async (t) => {
  const { store, client, calls } = await setup(t);
  await client.pair(store);
  assert.equal((await client.post('/api/pause', { scope: 'all', paused: true, reason: 'travelling' })).status, 200);
  assert.equal((await client.post('/api/pause', { scope: 'all', paused: false })).status, 200);
  assert.equal((await client.post('/api/pause', { scope: 'side', paused: true })).status, 200);
  assert.equal((await client.post('/api/pause', { scope: 'side', paused: false, reason: 'back' })).status, 200);
  assert.deepEqual(calls, [
    { name: 'pauseAll', args: ['travelling'] },
    { name: 'resumeAll', args: ['from the phone inbox'] },
    { name: 'pauseProject', args: ['side', 'from the phone inbox'] },
    { name: 'resumeProject', args: ['side', 'back'] },
  ]);
  assert.equal((await client.post('/api/pause', { scope: 'nope', paused: true })).status, 404);
  assert.equal((await client.post('/api/pause', { scope: 'all' })).status, 400);
  assert.equal((await client.post('/api/pause', { paused: true })).status, 400);
  assert.equal(calls.length, 4);
});

// ------------------------------------------------------------ agent bridge

test('agent tool bridge: loopback only, bearer token, no cookie or CSRF', async (t) => {
  const { client, toolCalls, errors } = await setup(t);
  const auth = { authorization: 'Bearer run-token-123456' };
  const url = '/agent/tools/report_progress';

  assert.equal((await client.post(url, { note: 'hi' })).status, 401);
  assert.equal((await client.post(url, {}, { headers: { authorization: 'Basic abcdefgh' } })).status, 401);
  assert.equal(toolCalls.length, 0);

  const ok = await client.post(url, { note: 'half way' }, { headers: auth });
  assert.equal(ok.status, 202, 'the handler status is passed through');
  assert.deepEqual(ok.json, { ok: true, tool: 'report_progress' });
  assert.deepEqual(toolCalls, [{ token: 'run-token-123456', name: 'report_progress', args: { note: 'half way' } }]);

  const bare = await client.request('POST', '/agent/tools/heartbeat', { headers: auth });
  assert.equal(bare.status, 202, 'no body and no content-type is fine for agents');
  assert.deepEqual(toolCalls.at(-1)?.args, {});

  const proxied = await client.post(url, {}, { headers: { ...auth, 'x-forwarded-for': '100.64.0.7' } });
  assert.equal(proxied.status, 403, 'requests relayed by a local proxy (e.g. Tailscale Serve) are refused');
  assert.equal((await client.get(url, { headers: auth })).status, 405);
  assert.equal((await client.post('/agent/other', {}, { headers: auth })).status, 404);
  assert.equal((await client.request('POST', url, { body: 'x=1', headers: { ...auth, 'content-type': 'text/plain' } })).status, 415);

  const boom = await client.post('/agent/tools/explode', {}, { headers: auth });
  assert.equal(boom.status, 500);
  assert.deepEqual(boom.json, { error: 'internal error' });
  assert.doesNotMatch(boom.text, /secret internal detail/);
  assert.deepEqual(errors, ['POST /agent/tools/explode: secret internal detail']);
});

interface InjectedReply {
  status: number;
  headers: Record<string, string>;
  json: Json;
}

/**
 * Hand one request to the server's handler as if it came from `remoteAddress`
 * (a real socket from another host cannot be opened in an offline test).
 * Body-less requests only: the bridge never reads a body it will refuse.
 */
function injectRequest(server: Server, opts: { method: string; url: string; remoteAddress: string; headers?: Record<string, string> }): Promise<InjectedReply> {
  return new Promise((resolve) => {
    const req = { method: opts.method, url: opts.url, headers: { host: 'box.local', ...opts.headers }, socket: { remoteAddress: opts.remoteAddress } };
    let status = 0;
    let headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      writeHead(code: number, h: Record<string, string>) {
        status = code;
        headers = h;
        this.headersSent = true;
      },
      end(payload?: string) {
        this.writableEnded = true;
        resolve({ status, headers, json: payload ? JSON.parse(payload) : null });
      },
    };
    server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}

test('agent tool bridge: a caller not on loopback gets 403 for anything under /agent', async (t) => {
  const { srv, toolCalls } = await setup(t);
  const auth = { authorization: 'Bearer run-token-123456' };
  for (const remoteAddress of ['192.168.1.5', '100.64.0.7', '::ffff:192.168.1.5', 'fe80::1']) {
    for (const [method, url] of [['POST', '/agent/tools/report_progress'], ['GET', '/agent/tools/report_progress'], ['POST', '/agent/other'], ['DELETE', '/agent']]) {
      const r = await injectRequest(srv.server, { method, url, remoteAddress, headers: auth });
      assert.equal(r.status, 403, `${remoteAddress} ${method} ${url}`);
      assert.equal(r.json.error, 'agent tools are only reachable from this machine');
      assert.equal(r.headers['Cache-Control'], 'no-store');
    }
  }
  assert.equal(toolCalls.length, 0);

  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const r = await injectRequest(srv.server, { method: 'POST', url: '/agent/tools/heartbeat', remoteAddress, headers: auth });
    assert.equal(r.status, 202, remoteAddress);
  }
  assert.deepEqual(toolCalls.map((c) => [c.token, c.name]), [['run-token-123456', 'heartbeat'], ['run-token-123456', 'heartbeat'], ['run-token-123456', 'heartbeat']]);
  // Path and method problems are reported to loopback callers only.
  assert.equal((await injectRequest(srv.server, { method: 'GET', url: '/agent/tools/heartbeat', remoteAddress: '::1', headers: auth })).status, 405);
  assert.equal((await injectRequest(srv.server, { method: 'POST', url: '/agent/other', remoteAddress: '::1', headers: auth })).status, 404);
  assert.equal(srv.agentUrl, srv.url, 'bound to 127.0.0.1, agents use the same address');
});

test('bound to one specific address, the server also listens on 127.0.0.1 for agents', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const toolCalls: string[] = [];
  const noop = () => {};
  const options: HttpServerOptions = {
    store,
    agentTools: {
      async callTool(_token, name) {
        toolCalls.push(name);
        return { status: 200, body: { ok: true } };
      },
    },
    actions: { wake: noop, pauseAll: noop, resumeAll: noop, pauseProject: noop, resumeProject: noop, addTask: () => assert.fail(), retryTask: () => assert.fail(), cancelTask: () => assert.fail() },
    staticDir: STATIC_DIR,
    // ::1 stands in for a LAN or Tailscale address: always present locally, and 127.0.0.1 does not reach it.
    host: '::1',
    port: 0,
    onError: noop,
  };
  let srv: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  // Close even when an assertion fails: a listener left open keeps the test process alive.
  t.after(() => srv?.close());
  for (let attempt = 0; attempt < 5 && !srv; attempt++) {
    try {
      srv = await startHttpServer(options);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return t.skip('this machine has no IPv6 loopback');
      // The random port was free on ::1 but taken on 127.0.0.1: try another one.
      if (!/could not also listen on 127\.0\.0\.1/.test((err as Error).message)) throw err;
    }
  }
  assert.ok(srv);
  assert.equal(srv.url, `http://[::1]:${srv.port}`);
  assert.equal(srv.agentUrl, `http://127.0.0.1:${srv.port}`);

  const call = await fetch(`${srv.agentUrl}/agent/tools/report_progress`, {
    method: 'POST',
    headers: { authorization: 'Bearer run-token-123456', 'content-type': 'application/json' },
    body: '{"note":"half way"}',
  });
  assert.equal(call.status, 200);
  assert.deepEqual(toolCalls, ['report_progress']);
  assert.equal((await fetch(`${srv.url}/api/me`)).status, 200, 'the inbox still answers on the configured address');

  await srv.close();
  await assert.rejects(fetch(`${srv.agentUrl}/api/me`), 'close() stops the loopback listener too');
  await assert.rejects(fetch(`${srv.url}/api/me`));
});

// ------------------------------------------------------------ pure helpers

test('auth helpers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.5'), false);
  assert.equal(isLoopbackAddress('100.64.0.1'), false);
  assert.equal(isLoopbackAddress(undefined), false);

  const agentReq = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
    agentRequestAllowed({ headers, socket: { remoteAddress } } as unknown as IncomingMessage);
  assert.equal(agentReq('127.0.0.1'), true);
  assert.equal(agentReq('::1'), true);
  assert.equal(agentReq('192.168.1.5'), false);
  assert.equal(agentReq(undefined), false, 'a destroyed socket has no address');
  assert.equal(agentReq('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' }), false, 'relayed by a local proxy');
  assert.equal(agentReq('127.0.0.1', { 'tailscale-user-login': 'me@example.com' }), false);

  for (const address of ['127.0.0.1', '0.0.0.0', '::']) assert.equal(acceptsLoopbackV4(address), true, address);
  for (const address of ['::1', '192.168.1.5', '100.64.0.7', 'fe80::1']) assert.equal(acceptsLoopbackV4(address), false, address);

  assert.equal(bearerToken('Bearer abcdefgh123'), 'abcdefgh123');
  assert.equal(bearerToken('bearer abcdefgh123'), 'abcdefgh123');
  assert.equal(bearerToken('Bearer short'), null);
  assert.equal(bearerToken('Basic abcdefgh123'), null);
  assert.equal(bearerToken(undefined), null);

  assert.deepEqual([...parseCookies('a=1; ap_session=tok; ap_session=second; b="q"; junk')], [['a', '1'], ['ap_session', 'tok'], ['b', 'q']]);
  assert.equal(sessionCookie('tok', false), 'ap_session=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');
  assert.equal(sessionCookie('tok', true), 'ap_session=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure');
  assert.equal(clearSessionCookie(false), 'ap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
});

test('pairing codes are single use, expire, and are stored only as hashes', () => {
  let now = 1000;
  const store = Store.open(':memory:', () => now);
  try {
    const code = createPairingCode(store, 5000);
    const rows = store.db.prepare('SELECT code_hash FROM pairing_codes').all() as { code_hash: string }[];
    assert.deepEqual(rows.map((r) => r.code_hash), [sha256Hex(code)]);
    const session = exchangePairingCode(store, code, 'test-agent');
    assert.ok(session);
    assert.ok(store.getInboxSession(sha256Hex(session.token)));
    assert.equal(store.getInboxSession(session.token), null);
    assert.equal(exchangePairingCode(store, code, null), null);
    const late = createPairingCode(store, 5000);
    now += 5001;
    assert.equal(exchangePairingCode(store, late, null), null);
  } finally {
    store.close();
  }
});

test('pending decisions sort: due cards first, then priority, then age', () => {
  const at = 10_000;
  const d = (id: string, priority: DecisionPriority, createdAt: number, deferredUntil: number | null = null) => ({ id, priority, createdAt, deferredUntil });
  const sorted = sortPendingDecisions(
    [d('D-1', 'low', 1), d('D-2', 'urgent', 5), d('D-3', 'high', 2, at + 1), d('D-4', 'normal', 3, at - 1), d('D-5', 'normal', 3), d('D-6', 'urgent', 9, at + 50)],
    at,
  );
  assert.deepEqual(sorted.map((x) => x.id), ['D-2', 'D-4', 'D-5', 'D-1', 'D-6', 'D-3']);
});

// ------------------------------------------------------------- inbox files

test('inbox files: safe DOM rendering, no external resources, CSP-compatible markup', async () => {
  const read = (file: string) => readFileSync(join(STATIC_DIR, file), 'utf8');
  const app = read('app.js');
  const html = read('index.html');
  const css = read('styles.css');
  const sw = read('sw.js');

  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, 'server data is never parsed as HTML');
  for (const [name, text] of [['index.html', html], ['app.js', app], ['styles.css', css], ['sw.js', sw]]) {
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org\/)/, `${name} loads nothing from other hosts`);
    assert.doesNotMatch(text, /@import|url\(\s*["']?https?:/, `${name} has no remote imports`);
  }
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=|<script(?![^>]*\ssrc=)/i, 'no inline styles, handlers or scripts (blocked by the CSP)');
  for (const [, id] of app.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
  assert.match(app, /X-CSRF-Token/);
  assert.match(app, /noopener noreferrer/);

  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Autopilot Inbox');
  assert.equal(manifest.short_name, 'Autopilot');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.deepEqual(manifest.icons.map((i: Json) => i.src), ['/icon.svg']);

  const shell = /const SHELL = \[([^\]]*)\]/.exec(sw);
  assert.ok(shell);
  assert.doesNotMatch(shell[1], /api/, 'the service worker caches only the static shell');
  assert.match(sw, /if \(url\.pathname\.startsWith\('\/api\/'\)[^\n]*\) return;/, 'API requests bypass the service worker');
  assert.match(read('icon.svg'), /^<svg[\s\S]*<\/svg>\s*$/);

  await execFileP(process.execPath, ['--check', join(STATIC_DIR, 'app.js')]);
  await execFileP(process.execPath, ['--check', join(STATIC_DIR, 'sw.js')]);
});

// ---------------------------------------------------------- service worker

const SW_ORIGIN = 'https://box.tailnet.example';

/** A same-origin answer as a service worker sees it (type "basic"). */
function basicResponse(body: string, contentType: string, status = 200): Response {
  const res = new Response(body, { status, headers: { 'content-type': contentType } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

type NetworkAnswer = Response | 'offline';

/** Run sw.js in a sandbox with in-memory CacheStorage and a scripted network. */
function startServiceWorker(network: (url: string) => NetworkAnswer, existingCaches: string[] = []) {
  const listeners = new Map<string, (event: Json) => void>();
  const caches = new Map<string, Map<string, Response>>(existingCaches.map((name) => [name, new Map()]));
  const send = async (url: string): Promise<Response> => {
    const answer = network(url);
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    return answer;
  };
  const cacheStorage = {
    async open(name: string) {
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name)!;
      return {
        async addAll(paths: string[]) {
          for (const path of paths) {
            const res = await send(SW_ORIGIN + path);
            if (!res.ok) throw new TypeError(`addAll: ${path} answered ${res.status}`);
            entries.set(path, res);
          }
        },
        async put(key: string, res: Response) {
          entries.set(key, res);
        },
        async match(key: string) {
          return entries.get(key)?.clone();
        },
      };
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const self = {
    location: new URL(`${SW_ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (event: Json) => void) => listeners.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const sandbox = vm.createContext({ self, caches: cacheStorage, fetch: (req: { url: string }) => send(req.url), URL, Response });
  vm.runInContext(readFileSync(join(STATIC_DIR, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });

  const lifecycle = async (type: string) => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  /** Dispatch a fetch event: the worker's answer, or null when it leaves the request to the browser. */
  const request = async (path: string, init: { mode?: string; method?: string; origin?: string } = {}): Promise<Response | null> => {
    const answer: { promise?: Promise<Response> } = {};
    listeners.get('fetch')!({
      request: { url: (init.origin ?? SW_ORIGIN) + path, mode: init.mode ?? 'no-cors', method: init.method ?? 'GET' },
      respondWith: (p: Promise<Response>) => {
        answer.promise = p;
      },
    });
    return answer.promise ? await answer.promise : null;
  };
  return { caches, install: () => lifecycle('install'), activate: () => lifecycle('activate'), request };
}

test('service worker: caches the shell only, keeps HTML as the page, and serves it when Autopilot is down', async () => {
  const PAGE = '<!doctype html><title>Autopilot</title>';
  const files: Record<string, [string, string]> = {
    '/': [PAGE, 'text/html; charset=utf-8'],
    '/index.html': [PAGE, 'text/html; charset=utf-8'],
    '/app.js': ['// app', 'text/javascript; charset=utf-8'],
    '/styles.css': ['body{}', 'text/css; charset=utf-8'],
    '/manifest.webmanifest': ['{}', 'application/manifest+json; charset=utf-8'],
    '/icon.svg': ['<svg/>', 'image/svg+xml'],
  };
  let network: 'up' | 'gateway' | 'offline' = 'up';
  const sw = startServiceWorker((url) => {
    if (network === 'offline') return 'offline';
    if (network === 'gateway') return basicResponse('Bad Gateway', 'text/plain', 502); // Tailscale Serve, Autopilot stopped
    const file = files[new URL(url).pathname];
    return file ? basicResponse(file[0], file[1]) : basicResponse('Not found', 'text/plain', 404);
  }, ['autopilot-shell-v1']);
  await sw.install();
  await sw.activate();
  assert.deepEqual([...sw.caches.keys()], ['autopilot-shell-v4'], 'older caches (which could hold a wrong page) are dropped');
  const shell = sw.caches.get('autopilot-shell-v4')!;
  assert.deepEqual([...shell.keys()].sort(), Object.keys(files).sort());
  const cachedPage = () => shell.get('/')!.clone().text();

  // Opening a shell file directly is not opening the app: the page entry keeps the page.
  for (const path of ['/app.js', '/icon.svg', '/manifest.webmanifest']) {
    const res = await sw.request(path, { mode: 'navigate' });
    assert.equal(await res!.text(), files[path][0], path);
  }
  assert.equal(await cachedPage(), PAGE);
  // An answer for the page that is not HTML is passed on but never stored as the page.
  files['/'] = ['Sign in to the hotel Wi-Fi', 'text/plain'];
  assert.equal(await (await sw.request('/?source=homescreen', { mode: 'navigate' }))!.text(), 'Sign in to the hotel Wi-Fi');
  assert.equal(await cachedPage(), PAGE);
  files['/'] = [`${PAGE}<!-- v2 -->`, 'text/html; charset=utf-8'];
  await sw.request('/', { mode: 'navigate' });
  assert.equal(await cachedPage(), `${PAGE}<!-- v2 -->`, 'a fresh page replaces the cached one');

  // Proxy up, Autopilot down (502): the cached shell, not "Bad Gateway".
  network = 'gateway';
  const page = await sw.request('/', { mode: 'navigate' });
  assert.equal(page!.status, 200);
  assert.equal(await page!.text(), `${PAGE}<!-- v2 -->`);
  assert.equal(await (await sw.request('/app.js'))!.text(), '// app');
  network = 'offline';
  assert.equal(await (await sw.request('/index.html', { mode: 'navigate' }))!.text(), `${PAGE}<!-- v2 -->`);
  assert.equal(await (await sw.request('/styles.css'))!.text(), 'body{}');

  // Left to the browser: the API, the agent bridge, writes, other origins, unknown paths.
  network = 'up';
  assert.equal(await sw.request('/api/decisions?status=pending'), null);
  assert.equal(await sw.request('/api/me', { mode: 'navigate' }), null);
  assert.equal(await sw.request('/agent/tools/heartbeat'), null);
  assert.equal(await sw.request('/', { method: 'POST' }), null);
  assert.equal(await sw.request('/app.js', { origin: 'https://cdn.example' }), null);
  assert.equal(await sw.request('/nope.html', { mode: 'navigate' }), null);

  // With nothing cached yet, a gateway error is shown as it is.
  const fresh = startServiceWorker(() => basicResponse('Bad Gateway', 'text/plain', 502));
  assert.equal((await fresh.request('/', { mode: 'navigate' }))!.status, 502);
});

// ------------------------------------------------------------- inbox client
//
// app.js runs in a vm sandbox against a small fake DOM (just the APIs it uses),
// scripted fetch answers and manual timers, so its behaviour is tested without
// a browser.

/** app.js appends `child instanceof Node ? child : String(child)`. */
class FakeNode {}

type Listener = (event: Json) => void;

class FakeEventTarget extends FakeNode {
  readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener, options?: boolean | { once?: boolean }): void {
    const once = typeof options === 'object' && options.once === true;
    const listener: Listener = once
      ? (event) => {
          this.removeEventListener(type, listener);
          fn(event);
        }
      : fn;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }

  /** Calls this target's own listeners (no bubbling: the tests dispatch where app.js listens). */
  dispatch(type: string, init: Record<string, unknown> = {}): Json {
    const event: Json = { type, target: this, currentTarget: this, defaultPrevented: false, stopPropagation() {}, ...init };
    event.preventDefault = () => {
      event.defaultPrevented = true;
    };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
}

class FakeElement extends FakeEventTarget {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  parentNode: FakeElement | null = null;
  childNodes: (FakeElement | string)[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  id = '';
  className = '';
  hidden = false;
  value = '';
  disabled = false;
  readOnly = false;

  constructor(tag: string, doc: FakeDocument) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
  }

  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]) => {
      this.className = [...new Set(list)].join(' ');
    };
    return {
      add: (...names: string[]) => write([...tokens(), ...names]),
      remove: (...names: string[]) => write(tokens().filter((c) => !names.includes(c))),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !tokens().includes(name);
        write(on ? [...tokens(), name] : tokens().filter((c) => c !== name));
        return on;
      },
      contains: (name: string) => tokens().includes(name),
    };
  }

  get open(): boolean {
    return this.attrs.has('open');
  }
  set open(value: boolean) {
    if (value) this.attrs.set('open', '');
    else this.attrs.delete('open');
  }

  get textContent(): string {
    return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(value: string) {
    this.replaceChildren(...(value === '' || value === null || value === undefined ? [] : [String(value)]));
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.remove();
        node.parentNode = this;
      }
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(other: unknown): boolean {
    for (let node = other instanceof FakeElement ? other : null; node; node = node.parentNode) if (node === this) return true;
    return false;
  }

  /** Selectors app.js uses: `tag`, `[attr]`, `[attr="value"]`, `tag[attr="value"]`, comma lists. */
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const m = /^([a-z][a-z0-9]*)?(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/i.exec(part.trim());
      if (!m || (!m[1] && !m[2])) throw new Error(`fake DOM: unsupported selector "${part}"`);
      const [, tag, attr, value] = m;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (!attr) return true;
      const key = attr.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const actual = attr.startsWith('data-') ? this.dataset[key] : this.attrs.get(attr);
      return actual !== undefined && (value === undefined || actual === value);
    });
  }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((el) => el.matches(selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  click(): Json {
    return this.dispatch('click');
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.dispatch('close');
  }
  select(): void {}
  reset(): void {}
  setPointerCapture(): void {}
}

/** The elements of the real index.html that carry an id or a data-tab, with their initial `hidden`. */
class FakeDocument extends FakeEventTarget {
  activeElement: FakeElement | null = null;
  visibilityState: 'visible' | 'hidden' = 'visible';
  title = '';
  readonly body: FakeElement;
  readonly byId = new Map<string, FakeElement>();
  readonly tabs: FakeElement[] = [];

  constructor(html: string) {
    super();
    this.body = new FakeElement('body', this);
    for (const [, tag, attrs] of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
      const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      const tab = /\sdata-tab="([^"]+)"/.exec(attrs)?.[1];
      if (!id && !tab) continue;
      const el = new FakeElement(tag, this);
      el.hidden = /\shidden(?=[\s/]|$)/.test(attrs);
      if (id) {
        el.id = id;
        this.byId.set(id, el);
      }
      if (tab) {
        el.dataset.tab = tab;
        this.tabs.push(el);
      }
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '#tabbar [data-tab]') return this.tabs;
    return [...this.byId.values()].flatMap((root) => root.querySelectorAll(selector));
  }
  execCommand(): boolean {
    return false;
  }
}

class FakeWindow extends FakeEventTarget {
  innerWidth = 360;
  isSecureContext = false;
  /** Every media query matches, so prefers-reduced-motion is on and swipes finish without animation. */
  matchMedia() {
    return { matches: true };
  }
  scrollTo(): void {}
}

/** setTimeout/setInterval that only run when a test fires them. */
class FakeTimers {
  private nextId = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number; repeat: boolean }>();
  setTimeout = (fn: () => void, ms = 0): number => this.add(fn, ms, false);
  setInterval = (fn: () => void, ms = 0): number => this.add(fn, ms, true);
  clear = (id?: number): void => {
    if (id) this.pending.delete(id);
  };

  private add(fn: () => void, ms: number, repeat: boolean): number {
    const id = this.nextId++;
    this.pending.set(id, { fn, ms, repeat });
    return id;
  }

  count(ms: number): number {
    return [...this.pending.values()].filter((t) => t.ms === ms).length;
  }

  /** Runs each timer of this delay that is pending right now, once. */
  fire(ms: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.ms !== ms || !this.pending.has(id)) continue;
      if (!timer.repeat) this.pending.delete(id);
      timer.fn();
    }
  }
}

interface FakeRequest {
  method: string;
  path: string;
  body: Json;
  headers: Record<string, string>;
}
type FakeAnswer = { status: number; body?: unknown } | 'offline';
type FakeRouter = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

const APP_JS = readFileSync(join(STATIC_DIR, 'app.js'), 'utf8');
const INDEX_HTML = readFileSync(join(STATIC_DIR, 'index.html'), 'utf8');
const SCREENS = ['loading', 'pair', 'inbox', 'digest', 'board', 'status'];

/** Boot app.js as a browser would, with every request answered by `router`. */
function startInbox(router: FakeRouter, opts: { hash?: string } = {}) {
  const doc = new FakeDocument(INDEX_HTML);
  const win = new FakeWindow();
  const timers = new FakeTimers();
  const fetches: FakeRequest[] = [];
  const location = { hash: opts.hash ?? '', pathname: '/', search: '', origin: 'https://box.tailnet.example' };
  const replacedUrls: string[] = [];
  const storage = new Map<string, string>();
  const sandbox = vm.createContext({
    document: doc,
    window: win,
    navigator: {},
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        replacedUrls.push(url);
        location.hash = '';
      },
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)) },
    Node: FakeNode,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    confirm: () => true,
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clear,
    setInterval: timers.setInterval,
    clearInterval: timers.clear,
    async fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
      const req: FakeRequest = { method: init.method ?? 'GET', path, body: init.body ? JSON.parse(init.body) : undefined, headers: { ...init.headers } };
      fetches.push(req);
      const answer = await router(req);
      if (answer === 'offline') throw new TypeError('Failed to fetch');
      return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? null), { status: answer.status });
    },
  });
  vm.runInContext(APP_JS, sandbox, { filename: 'app.js' });
  const el = (id: string): FakeElement => {
    const found = doc.getElementById(id);
    assert.ok(found, `#${id} exists`);
    return found;
  };
  return {
    doc,
    win,
    timers,
    fetches,
    location,
    replacedUrls,
    el,
    evalIn: (code: string): Json => vm.runInContext(code, sandbox),
    visibleScreens: () => SCREENS.filter((name) => !el(`screen-${name}`).hidden),
    tab: (name: string): FakeElement => doc.tabs.find((t) => t.dataset.tab === name)!,
    selectProject(id: string) {
      el('project-filter').value = id;
      el('project-filter').dispatch('change');
    },
  };
}

type Inbox = ReturnType<typeof startInbox>;

function findButton(root: FakeElement, label: string | RegExp): FakeElement {
  const found = root.descendants().find((n) => n.tagName === 'BUTTON' && (typeof label === 'string' ? n.textContent === label : label.test(n.textContent)));
  assert.ok(found, `a "${label}" button`);
  return found;
}

function optionButton(root: FakeElement, optionId: string): FakeElement {
  const found = root.descendants().find((n) => n.dataset.option === optionId);
  assert.ok(found, `option ${optionId}`);
  return found;
}

/** Drag the shown card horizontally by dx and let go; returns the overlay label shown while dragging. */
function swipeCard(app: Inbox, dx: number): string {
  const card = app.el('inbox-body').querySelector('article');
  assert.ok(card, 'a card is shown');
  const at = (x: number) => ({ isPrimary: true, pointerType: 'touch', button: 0, pointerId: 7, clientX: x, clientY: 400 });
  card.dispatch('pointerdown', at(100));
  card.dispatch('pointermove', at(100 + Math.sign(dx) * 30));
  card.dispatch('pointermove', at(100 + dx));
  const overlay = card.descendants().find((n) => n.classList.contains('swipe-overlay'));
  const label = overlay?.textContent ?? '';
  card.dispatch('pointerup', at(100 + dx));
  return label;
}

function overviewFixture(): Json {
  const project = (id: string, name: string) => ({ id, name, profile: 'balanced_autopilot', paused: false, pauseReason: null, counts: {}, pendingDecisions: 0 });
  return { now: Date.now(), pausedAll: false, usagePausedUntil: null, pendingDecisions: 0, projects: [project('app', 'App'), project('blog', 'Blog')], activeRuns: [] };
}

function cardFixture(overrides: Record<string, unknown> = {}): Json {
  const created = Date.now() - 2 * HOUR;
  return {
    id: 'D-1',
    projectId: 'app',
    projectName: 'App',
    taskId: 'T-1',
    taskTitle: 'Onboarding',
    taskState: 'waiting_decision',
    blockedTaskIds: ['T-1'],
    kind: 'choice',
    revision: 1,
    status: 'pending',
    question: 'Which empty state?',
    why: 'It is the first screen people see.',
    options: [
      { id: 'sample', label: 'Show a sample', tradeoff: 'More to build' },
      { id: 'blank', label: 'Start empty' },
    ],
    recommendation: 'sample',
    recommendationReason: 'It teaches the layout',
    allowComment: true,
    blocking: true,
    priority: 'normal',
    blockedSummary: 'T-1 waits for this',
    continuesSummary: 'Other tasks keep going',
    links: [],
    artifactRef: null,
    createdBy: 'agent',
    createdByRun: null,
    dedupeKey: null,
    deferredUntil: null,
    deferred: false,
    answer: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

/** An Autopilot this phone is paired with, showing `cards()`; `extra` may answer any request first. */
function pairedAutopilot(cards: () => Json[], extra: (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer> | undefined = () => undefined): FakeRouter {
  return (req) => {
    const answer = extra(req);
    if (answer !== undefined) return answer;
    if (req.path === '/api/me') return { status: 200, body: { authenticated: true, csrf: 'csrf-token' } };
    if (req.path === '/api/overview') return { status: 200, body: overviewFixture() };
    if (req.path.startsWith('/api/decisions?')) return { status: 200, body: { decisions: cards() } };
    return { status: 404, body: { error: 'not found' } };
  };
}

test('inbox client: swipe-accept and Send follow the card rules', async () => {
  const app = startInbox(() => 'offline');
  await settle();
  const swipeAccepts = (overrides: Record<string, unknown>) => app.evalIn('swipeAcceptOption')(cardFixture(overrides))?.id ?? null;
  assert.equal(swipeAccepts({}), 'sample');
  assert.equal(swipeAccepts({ recommendation: null }), null, 'no recommendation');
  assert.equal(swipeAccepts({ recommendation: 'gone' }), null, 'recommendation is not an option');
  assert.equal(swipeAccepts({ options: [{ id: 'sample', label: 'Ship', consequential: true }] }), null, 'consequential');
  assert.equal(swipeAccepts({ options: [{ id: 'sample', label: 'Request changes', requiresComment: true }] }), null, 'needs a comment');
  assert.equal(swipeAccepts({ kind: 'authorization' }), null, 'authorizations always need a tap');

  const canSend = (overrides: Record<string, unknown>, draft: Record<string, unknown>) =>
    app.evalIn('canSend')(cardFixture(overrides), { optionId: null, comment: '', ...draft });
  assert.equal(canSend({}, {}), false, 'nothing chosen');
  assert.equal(canSend({}, { optionId: 'blank' }), true);
  assert.equal(canSend({}, { optionId: 'missing' }), false);
  const needsComment = { options: [{ id: 'changes', label: 'Request changes', requiresComment: true }] };
  assert.equal(canSend(needsComment, { optionId: 'changes', comment: '   ' }), false);
  assert.equal(canSend(needsComment, { optionId: 'changes', comment: 'Use the new copy' }), true);
  assert.equal(canSend({}, { comment: 'Ask me tomorrow' }), true, 'a comment alone answers a choice');
  assert.equal(canSend({ allowComment: false }, { comment: 'hi' }), false);
  assert.equal(canSend({ kind: 'authorization' }, { comment: 'fine' }), false, 'authorizations need an explicit option');
  assert.equal(canSend({ options: [], recommendation: null }, { comment: 'Use Postgres' }), true, 'open questions take a comment');
});

test('inbox client: only an explicit "not paired" answer shows the Pair screen', async () => {
  let me: FakeAnswer = { status: 502, body: 'Bad Gateway' };
  const app = startInbox(pairedAutopilot(() => [], (req) => (req.path === '/api/me' ? me : undefined)));
  await settle();
  // Tailscale Serve answering for a stopped Autopilot: a paired phone must not be told to pair again.
  assert.deepEqual(app.visibleScreens(), ['loading']);
  assert.match(app.el('screen-loading').textContent, /Can’t reach Autopilot/);
  assert.match(app.el('screen-loading').textContent, /HTTP 502/);
  assert.equal(app.el('offline-banner').hidden, false, 'a gateway error counts as offline');
  assert.equal(app.timers.count(10_000), 1);

  // "Try again" replaces the pending retry instead of starting another retry loop.
  for (let i = 0; i < 3; i++) {
    findButton(app.el('screen-loading'), 'Try again').click();
    await settle();
  }
  assert.equal(app.fetches.filter((f) => f.path === '/api/me').length, 4);
  assert.equal(app.timers.count(10_000), 1);

  // A server error (say, a busy database) says nothing about the session either.
  me = { status: 500, body: { error: 'internal error' } };
  app.timers.fire(10_000);
  await settle();
  assert.deepEqual(app.visibleScreens(), ['loading']);
  assert.match(app.el('screen-loading').textContent, /HTTP 500/);
  assert.equal(app.el('offline-banner').hidden, true, 'a 500 comes from Autopilot itself');
  assert.equal(app.timers.count(10_000), 1);

  // Autopilot is back and the phone is paired: straight into the app, and retrying stops.
  me = { status: 200, body: { authenticated: true, csrf: 'csrf-token' } };
  app.timers.fire(10_000);
  await settle();
  assert.deepEqual(app.visibleScreens(), ['inbox']);
  assert.equal(app.timers.count(10_000), 0);
  assert.equal(app.fetches.filter((f) => f.path === '/api/overview').length, 1, 'one refresh, not one per retry');

  const unpaired = startInbox(() => ({ status: 200, body: { authenticated: false } }));
  await settle();
  assert.deepEqual(unpaired.visibleScreens(), ['pair']);
  assert.equal(unpaired.el('pair-error').hidden, true);
  assert.equal(unpaired.timers.count(10_000), 0);

  const unreachable = startInbox(() => 'offline');
  await settle();
  assert.deepEqual(unreachable.visibleScreens(), ['loading']);
  assert.match(unreachable.el('screen-loading').textContent, /Can’t reach Autopilot/);
  assert.doesNotMatch(unreachable.el('screen-loading').textContent, /HTTP/);
  // A pairing link opened meanwhile cancels the retry, so it cannot flash the Pair screen mid-pairing.
  unreachable.location.hash = '#code=pair-code-1234';
  unreachable.win.dispatch('hashchange');
  assert.equal(unreachable.timers.count(10_000), 0);
});

test('inbox client: a pairing link pairs, clears the hash, and explains failures', async () => {
  const paired = startInbox(
    pairedAutopilot(() => [], (req) => (req.path === '/api/pair' ? { status: 200, body: { authenticated: true, csrf: 'fresh-csrf' } } : undefined)),
    { hash: '#code=pair-code-1234' },
  );
  await settle();
  assert.deepEqual(paired.fetches.filter((f) => f.path === '/api/pair').map((f) => [f.method, f.body]), [['POST', { code: 'pair-code-1234' }]]);
  assert.equal(paired.location.hash, '');
  assert.deepEqual(paired.replacedUrls, ['/'], 'the code leaves the address bar and history');
  assert.deepEqual(paired.visibleScreens(), ['inbox']);
  assert.equal(paired.el('toast').textContent, 'This phone is connected');
  assert.equal(paired.evalIn('state.csrf'), 'fresh-csrf');
  assert.equal(paired.fetches.some((f) => f.path === '/api/me'), false, 'no session check races the pairing');

  // Autopilot down behind the proxy: the link was not used up, so opening it again is the fix.
  const down = startInbox(() => ({ status: 502, body: 'Bad Gateway' }), { hash: '#code=pair-code-1234' });
  await settle();
  assert.deepEqual(down.visibleScreens(), ['pair']);
  assert.equal(down.el('pair-error').hidden, false);
  assert.match(down.el('pair-error').textContent, /open the link again/);

  const used = startInbox(
    (req) => (req.path === '/api/pair' ? { status: 401, body: { error: 'invalid, used or expired pairing code' } } : { status: 200, body: { authenticated: false } }),
    { hash: '#code=old-code-1234' },
  );
  await settle();
  assert.deepEqual(used.visibleScreens(), ['pair']);
  assert.match(used.el('pair-error').textContent, /expired or was already used/);

  // An old link opened on a phone that is already paired keeps the session.
  const again = startInbox(
    pairedAutopilot(() => [], (req) => (req.path === '/api/pair' ? { status: 401, body: { error: 'invalid, used or expired pairing code' } } : undefined)),
    { hash: '#code=old-code-1234' },
  );
  await settle();
  assert.deepEqual(again.visibleScreens(), ['inbox']);
  assert.equal(again.el('toast').textContent, 'This phone is already connected');
});

test('inbox client: Send reuses its idempotency key on Retry and shows a changed card', async () => {
  let cards = [cardFixture()];
  const changed = cardFixture({ revision: 2, question: 'Which empty state for Today?' });
  const answers: FakeAnswer[] = [
    'offline',
    { status: 409, body: { status: 'stale_revision', currentRevision: 2, decision: changed } },
    { status: 200, body: { status: 'saved', decision: { ...changed, status: 'answered' } } },
  ];
  const app = startInbox(pairedAutopilot(() => cards, (req) => (req.method === 'POST' ? answers.shift() : undefined)));
  await settle();
  const inbox = app.el('inbox-body');
  assert.match(inbox.textContent, /Which empty state\?/);
  assert.match(inbox.textContent, /1 of 1/);
  assert.match(inbox.textContent, /Recommended: Show a sample/);
  assert.equal(app.doc.title, '(1) Autopilot');
  const send = () => findButton(inbox, /^(Send|Retry)$/);
  assert.equal(send().disabled, true, 'nothing chosen yet');

  optionButton(inbox, 'blank').click();
  assert.equal(optionButton(inbox, 'blank').getAttribute('aria-pressed'), 'true');
  assert.equal(send().disabled, false);
  send().click();
  await settle();
  assert.equal(send().textContent, 'Retry', 'the answer stays on the card');
  assert.match(inbox.textContent, /Your answer is not saved yet/);

  send().click();
  await settle();
  assert.match(inbox.textContent, /Which empty state for Today\?/, 'the fresh version is shown');
  assert.match(inbox.textContent, /This card changed/);
  assert.equal(app.el('toast').textContent, 'This card changed');
  assert.equal(optionButton(inbox, 'blank').getAttribute('aria-pressed'), 'false', 'the new version needs a new choice');

  optionButton(inbox, 'sample').click();
  cards = [];
  send().click();
  await settle();
  assert.equal(app.el('toast').textContent, 'Saved — Onboarding will resume');
  assert.match(inbox.textContent, /All clear/);

  const posts = app.fetches.filter((f) => f.method === 'POST');
  assert.deepEqual(posts.map((p) => [p.path, p.body.revision, p.body.optionId]), [
    ['/api/decisions/D-1/respond', 1, 'blank'],
    ['/api/decisions/D-1/respond', 1, 'blank'],
    ['/api/decisions/D-1/respond', 2, 'sample'],
  ]);
  assert.equal(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey, 'Retry repeats the same submission');
  assert.notEqual(posts[2].body.idempotencyKey, posts[1].body.idempotencyKey, 'a new answer is a new submission');
  assert.ok(posts.every((p) => p.headers['X-CSRF-Token'] === 'csrf-token'));
});

test('inbox client: swiping right accepts only a safe recommendation; left means Later', async () => {
  let cards = [cardFixture()];
  const app = startInbox(
    pairedAutopilot(() => cards, (req) => {
      if (req.method !== 'POST') return undefined;
      const [, id, action] = /^\/api\/decisions\/([^/]+)\/(respond|defer)$/.exec(req.path) ?? [];
      const card = cards.find((c) => c.id === id);
      if (!card) return { status: 404, body: { status: 'not_found' } };
      if (action === 'defer') return { status: 200, body: { decision: { ...card, deferredUntil: Date.now() + 4 * HOUR, deferred: true } } };
      cards = cards.filter((c) => c.id !== id);
      return { status: 200, body: { status: 'saved', decision: { ...card, status: 'answered' } } };
    }),
  );
  await settle();
  assert.equal(swipeCard(app, 160), 'Accept: Show a sample');
  await settle();

  // The next card recommends a consequential option: a swipe never chooses it.
  cards = [cardFixture({ id: 'D-2', options: [{ id: 'ship', label: 'Ship it', consequential: true }, { id: 'wait', label: 'Wait' }], recommendation: 'ship' })];
  app.timers.fire(15_000); // the next poll brings it in
  await settle();
  assert.match(app.el('inbox-body').textContent, /Ship it/);
  assert.equal(swipeCard(app, 160), 'Tap to choose');
  await settle();
  assert.equal(app.el('toast').textContent, 'Tap to choose');
  assert.equal(app.el('inbox-body').querySelector('article')!.style.transform, '', 'the card snaps back');

  assert.equal(swipeCard(app, -160), 'Later (4h)');
  await settle();
  assert.equal(app.el('toast').textContent, 'Snoozed for 4 hours');

  const posts = app.fetches.filter((f) => f.method === 'POST');
  assert.deepEqual(posts.map((p) => [p.path, p.body]), [
    ['/api/decisions/D-1/respond', { revision: 1, optionId: 'sample', comment: null, idempotencyKey: posts[0].body.idempotencyKey }],
    ['/api/decisions/D-2/defer', { hours: 4 }],
  ]);
});

test('inbox client: answers for the previous project filter are dropped (digest and board)', async () => {
  const held: { path: string; resolve: (answer: FakeAnswer) => void }[] = [];
  const app = startInbox(
    pairedAutopilot(
      () => [],
      (req) =>
        req.path.startsWith('/api/digest') || req.path.startsWith('/api/tasks')
          ? new Promise<FakeAnswer>((resolve) => held.push({ path: req.path, resolve }))
          : undefined,
    ),
  );
  await settle();
  const answer = async (path: string, reply: FakeAnswer) => {
    const index = held.findIndex((h) => h.path === path);
    assert.ok(index >= 0, `${path} is in flight (have ${held.map((h) => h.path).join(', ')})`);
    held.splice(index, 1)[0].resolve(reply);
    await settle();
  };
  const digest = (title: string): FakeAnswer => ({
    status: 200,
    body: { since: 0, hours: 24, truncated: false, integrated: [{ taskId: 'T-9', title, at: Date.now(), prUrl: null, projectId: null }], failures: [], answered: [], usage: [], counts: { integrated: 1 } },
  });
  const tasks = (title: string, projectId: string): FakeAnswer => ({
    status: 200,
    body: { tasks: [{ id: 'T-3', projectId, title, state: 'ready', stateReason: null, role: 'full-stack', kind: 'build', priority: 3, risk: 'low', attempts: 0, repairCycles: 0, prUrl: null, prNumber: null, branch: null, updatedAt: Date.now(), hypothesis: null }] },
  });

  app.tab('digest').click();
  await settle();
  app.selectProject('blog');
  await settle();
  await answer('/api/digest?hours=24&project=blog', digest('Blog launch post'));
  await answer('/api/digest?hours=24', digest('Every project')); // slower, and for the old filter
  assert.equal(app.evalIn('state.project'), 'blog');
  assert.match(app.el('digest-body').textContent, /Blog launch post/);
  assert.doesNotMatch(app.el('digest-body').textContent, /Every project/);

  app.tab('board').click();
  await settle();
  app.selectProject('app');
  await settle();
  await answer('/api/tasks?project=app', tasks('App onboarding', 'app'));
  await answer('/api/tasks?project=blog', tasks('Blog redesign', 'blog'));
  assert.match(app.el('board-body').textContent, /App onboarding/);
  assert.doesNotMatch(app.el('board-body').textContent, /Blog redesign/);
});

test('inbox client: polls every 15 seconds, only while visible', async () => {
  const app = startInbox(pairedAutopilot(() => [cardFixture()]));
  await settle();
  assert.equal(app.timers.count(15_000), 1);
  const polls = () => app.fetches.filter((f) => f.path === '/api/overview' || f.path.startsWith('/api/decisions?')).length;
  const before = polls();

  app.doc.visibilityState = 'hidden';
  app.timers.fire(15_000);
  await settle();
  assert.equal(polls(), before, 'nothing is fetched in the background');

  app.doc.visibilityState = 'visible';
  app.timers.fire(15_000);
  await settle();
  assert.equal(polls(), before + 2, 'overview and cards');

  app.doc.dispatch('visibilitychange'); // back in the foreground: refresh at once
  await settle();
  assert.equal(polls(), before + 4);
  assert.equal(app.doc.title, '(1) Autopilot');
});
