// SPDX-License-Identifier: MIT
// HTTP server: the founder's phone inbox (static PWA shell + JSON API) and the
// loopback-only bridge that worker agents use to call supervisor tools.
//
// node:http only. Every API response is JSON with Cache-Control: no-store.
// Unexpected errors are logged to stderr and answered with a generic 500;
// stack traces never reach a client.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StateError, TASK_TRANSITIONS } from '../store.ts';
import type { Store } from '../store.ts';
import type { AgentToolHandler, AuditEvent, Decision, DecisionStatus, ReviewRecord, Run, SupervisorActions, Task, TaskState } from '../types.ts';
import { redactSecrets } from '../util.ts';
import { loadOrCreateVapidKeys, WebPushNotifier } from '../push.ts';
import {
  agentRequestAllowed,
  bearerToken,
  clearSessionCookie,
  csrfMatches,
  exchangePairingCode,
  headerValue,
  isSecureRequest,
  originAllowed,
  sessionCookie,
  sessionFromRequest,
} from './auth.ts';
import type { InboxSession } from './auth.ts';

export interface HttpServerOptions {
  store: Store;
  agentTools: AgentToolHandler;
  actions: SupervisorActions;
  /** Directory holding the inbox shell (src/inbox). */
  staticDir: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Clock for API timestamps, deferrals and rate limits; defaults to the store's clock. */
  now?: () => number;
  /** Receives unexpected errors; defaults to a line on stderr. */
  onError?: (context: string, err: unknown) => void;
}

export interface HttpServerHandle {
  server: Server;
  url: string;
  port: number;
  /**
   * Base URL worker agents use for the bridge: always http://127.0.0.1:<port>,
   * because the bridge accepts loopback connections only.
   */
  agentUrl: string;
  /** Stops every listener (including the extra loopback one, when there is one). */
  close(): Promise<void>;
}

export const BODY_LIMIT_BYTES = 64 * 1024;
/** Bodies past this are not drained politely: we answer 413 and drop the connection. */
const BODY_HARD_CAP_BYTES = 1024 * 1024;
export const PAIR_ATTEMPTS_PER_MINUTE = 10;

export const STATIC_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** The only files ever served from staticDir, with their content types. */
const STATIC_FILES: Readonly<Record<string, string>> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  'sw.js': 'text/javascript; charset=utf-8',
  'icon.svg': 'image/svg+xml',
};

const ALL_TASK_STATES = Object.keys(TASK_TRANSITIONS) as TaskState[];
const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 0, high: 1, normal: 2, low: 3 };
const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'lost', 'killed', 'timeout']);
const ID = '([A-Za-z0-9_-]{1,64})';

/** Most events the digest reads per category; past it the digest says `truncated` rather than undercounting quietly. */
export const DIGEST_EVENT_CAP = 5000;
/** Account-wide usage events: limit pauses and resumes (store) and the supervisor's early warning. */
export const USAGE_EVENT_TYPES: readonly string[] = ['usage.paused', 'usage.resumed', 'usage.warning'];

// ------------------------------------------------------------------ server

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const deps: Deps = {
    store: opts.store,
    actions: opts.actions,
    agentTools: opts.agentTools,
    staticDir: opts.staticDir,
    now: opts.now ?? (() => opts.store.now()),
    pairLimiter: new SlidingWindowLimiter(PAIR_ATTEMPTS_PER_MINUTE, 60_000),
    logError: opts.onError ?? logToStderr,
  };
  const routes = apiRoutes(deps);
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, deps, routes);
  };

  const server = await listen(newServer(handler), opts.port, opts.host, deps);
  const { port, address } = server.address() as AddressInfo;
  const servers = [server];
  // Agents call the bridge at 127.0.0.1, and it serves loopback callers only. When the server
  // is bound to one specific address (a LAN or Tailscale IP, or ::1), 127.0.0.1 would not
  // reach it, so the same handler also listens on 127.0.0.1 at the same port.
  if (!acceptsLoopbackV4(address)) {
    try {
      servers.push(await listen(newServer(handler), port, '127.0.0.1', deps));
    } catch (err) {
      await closeServer(server);
      throw new Error(`could not also listen on 127.0.0.1:${port} for the agent bridge: ${(err as Error).message}`);
    }
  }
  return {
    server,
    port,
    url: `http://${urlHost(opts.host)}:${port}`,
    agentUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await Promise.all(servers.map(closeServer));
    },
  };
}

function newServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const server = createServer(handler);
  // Bound the time a client may take to send a request (not our response time).
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  return server;
}

function listen(server: Server, port: number, host: string, deps: Pick<Deps, 'logError'>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.off('error', onListenError);
      server.on('error', (err) => deps.logError('http server', err));
      resolve(server);
    });
  });
}

/** Whether a socket bound to `address` accepts connections made to 127.0.0.1 ("::" is dual-stack in Node). */
export function acceptsLoopbackV4(address: string): boolean {
  return address === '127.0.0.1' || address === '0.0.0.0' || address === '::' || address === '::ffff:127.0.0.1';
}

interface Deps {
  store: Store;
  actions: SupervisorActions;
  agentTools: AgentToolHandler;
  staticDir: string;
  now: () => number;
  pairLimiter: SlidingWindowLimiter;
  logError: (context: string, err: unknown) => void;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: Deps, routes: Route[]): Promise<void> {
  const { pathname, query } = splitUrl(req.url);
  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname, query, deps, routes);
    else if (pathname === '/agent' || pathname.startsWith('/agent/')) await handleAgentTool(req, res, pathname, deps);
    else await serveStatic(req, res, pathname, deps.staticDir);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, err.body, err.headers);
    } else {
      deps.logError(`${req.method ?? '?'} ${pathname}`, err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    // Keep-alive sockets (fetch keeps them open) would otherwise delay close.
    server.closeAllConnections();
  });
}

function urlHost(host: string): string {
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}

function logToStderr(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[autopilot http] ${context}: ${detail}\n`);
}

// --------------------------------------------------------------- plumbing

/** An expected failure with a client-safe JSON body. */
class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  constructor(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(error);
    this.status = status;
    this.body = { error, ...extra };
    this.headers = headers;
  }
}

/** Fixed-size sliding window of attempt timestamps (one global bucket). */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Records an attempt at `at`; false (and nothing recorded) when the window is full. */
  tryHit(at: number): boolean {
    this.hits = this.hits.filter((t) => t > at - this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(at);
    return true;
  }

  retryAfterMs(at: number): number {
    return this.hits.length ? Math.max(0, this.hits[0] + this.windowMs - at) : 0;
  }
}

function splitUrl(raw: string | undefined): { pathname: string; query: URLSearchParams } {
  // Parse by hand: new URL() would read "//host/x" as a host, not a path.
  const url = raw ?? '/';
  const q = url.indexOf('?');
  return {
    pathname: q === -1 ? url : url.slice(0, q),
    query: new URLSearchParams(q === -1 ? '' : url.slice(q + 1)),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  let payload: string;
  try {
    payload = JSON.stringify(body ?? null);
  } catch {
    status = 500;
    payload = '{"error":"internal error"}';
  }
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': API_CSP,
    ...headers,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': API_CSP,
    ...headers,
  });
  res.end(text);
}

function isJsonContentType(value: string): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(value.trim());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read a JSON object body. No body at all yields {}. Oversized bodies are
 * drained (up to a hard cap) before answering 413, so the client reliably
 * receives the response instead of a connection reset.
 */
async function readJsonBody(req: IncomingMessage, opts: { requireJsonType: boolean }): Promise<Record<string, unknown>> {
  const lengthHeader = req.headers['content-length'];
  const declared = lengthHeader === undefined ? null : Number(lengthHeader);
  if (declared === null && req.headers['transfer-encoding'] === undefined) return {};
  if (declared === 0) return {};
  if (declared !== null && declared > BODY_HARD_CAP_BYTES) {
    throw new HttpError(413, 'body too large', { limit: BODY_LIMIT_BYTES }, { Connection: 'close' });
  }
  const type = headerValue(req.headers['content-type']);
  if (type ? !isJsonContentType(type) : opts.requireJsonType) throw new HttpError(415, 'content-type must be application/json');
  const raw = await collectBody(req, BODY_LIMIT_BYTES);
  if (raw === null) throw new HttpError(413, 'body too large', { limit: BODY_LIMIT_BYTES });
  const text = raw.toString('utf8').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'malformed JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed;
}

/** Resolves with the body, or null when it exceeded `limit` (the rest is drained and discarded). */
function collectBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_HARD_CAP_BYTES) {
        settle(() => reject(new HttpError(413, 'body too large', { limit }, { Connection: 'close' })));
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(tooLarge ? null : Buffer.concat(chunks))));
    req.on('error', () => settle(() => reject(new HttpError(400, 'request aborted'))));
    req.on('close', () => settle(() => reject(new HttpError(400, 'request aborted'))));
  });
}

/** Run a supervisor action; StateError-like failures become 400 with their message. */
function callAction<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (isClientError(err)) throw new HttpError(400, (err as Error).message.slice(0, 500) || 'request rejected');
    throw err;
  }
}

function isClientError(err: unknown): boolean {
  if (err instanceof StateError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'StateError' || err.constructor?.name === 'StateError') return true;
  const e = err as { status?: unknown; statusCode?: unknown };
  const status = e.status ?? e.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (typeof text !== 'string') return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Text written by agents or tools (summaries, errors, notes, log lines) on its
 * way to the phone: obvious secrets masked first, so clipping can never cut a
 * key in half and leave its start visible.
 */
function redactedClip(text: string | null | undefined, max: number): string | null {
  return typeof text === 'string' ? clip(redactSecrets(text), max) : null;
}

/** An audit event with its message passed through redactSecrets (messages are already capped by the store). */
function eventView(e: AuditEvent): AuditEvent {
  return { ...e, message: redactSecrets(e.message) };
}

/** Returns null for absent values, the string itself, or false when the value has the wrong type. */
function optionalString(v: unknown): string | null | false {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : false;
}

// ----------------------------------------------------------------- static

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, staticDir: string): Promise<void> {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const type = Object.hasOwn(STATIC_FILES, name) ? STATIC_FILES[name] : undefined;
  if (!type) return sendText(res, 404, 'Not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let data: Buffer;
  try {
    data = await readFile(join(staticDir, name));
  } catch {
    return sendText(res, 404, 'Not found');
  }
  const etag = `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}"`;
  const headers: Record<string, string> = {
    ...COMMON_HEADERS,
    'Content-Type': type,
    'Content-Security-Policy': STATIC_CSP,
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  const inm = headerValue(req.headers['if-none-match']);
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(data.length) });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// -------------------------------------------------------------------- api

interface ApiRequest {
  req: IncomingMessage;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  session: InboxSession | null;
}

interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** "session" routes need a valid cookie, plus the CSRF header when not GET. */
  auth: 'public' | 'session';
  /** Counts against the global pairing rate limit (checked before the body is read). */
  pairLimited?: boolean;
  handle(r: ApiRequest): ApiResponse | Promise<ApiResponse>;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, d: Deps, routes: Route[]): Promise<void> {
  const candidates = routes.filter((r) => r.pattern.test(pathname));
  if (!candidates.length) throw new HttpError(404, 'not found');
  const route = candidates.find((r) => r.method === req.method);
  if (!route) {
    throw new HttpError(405, 'method not allowed', {}, { Allow: [...new Set(candidates.map((r) => r.method))].join(', ') });
  }
  const params = (route.pattern.exec(pathname) ?? []).slice(1);
  const session = sessionFromRequest(d.store, req);
  if (route.auth === 'session' && !session) throw new HttpError(401, 'not signed in');

  let body: Record<string, unknown> = {};
  if (route.method !== 'GET') {
    if (!originAllowed(req)) throw new HttpError(403, 'origin not allowed');
    if (route.auth === 'session' && (!session || !csrfMatches(session, req.headers['x-csrf-token']))) {
      throw new HttpError(403, 'csrf', { message: 'missing or invalid X-CSRF-Token header' });
    }
    if (route.pairLimited && !d.pairLimiter.tryHit(d.now())) {
      const retryAfter = Math.max(1, Math.ceil(d.pairLimiter.retryAfterMs(d.now()) / 1000));
      throw new HttpError(429, 'too many pairing attempts; wait a minute', {}, { 'Retry-After': String(retryAfter) });
    }
    body = await readJsonBody(req, { requireJsonType: true });
  }
  const out = await route.handle({ req, params, query, body, session });
  sendJson(res, out.status, out.body, out.headers);
}

function apiRoutes(d: Deps): Route[] {
  const ok = (body: unknown): ApiResponse => ({ status: 200, body });
  return [
    { method: 'POST', pattern: /^\/api\/pair$/, auth: 'public', pairLimited: true, handle: (r) => pairRoute(d, r) },
    {
      method: 'GET',
      pattern: /^\/api\/me$/,
      auth: 'public',
      handle: (r) => ok(r.session ? { authenticated: true, csrf: r.session.csrf } : { authenticated: false }),
    },
    { method: 'POST', pattern: /^\/api\/logout$/, auth: 'public', handle: (r) => logoutRoute(d, r) },
    { method: 'GET', pattern: /^\/api\/overview$/, auth: 'session', handle: () => ok(buildOverview(d.store, d.now())) },
    { method: 'GET', pattern: /^\/api\/decisions$/, auth: 'session', handle: (r) => listDecisionsRoute(d, r) },
    { method: 'POST', pattern: new RegExp(`^/api/decisions/${ID}/respond$`), auth: 'session', handle: (r) => respondRoute(d, r) },
    { method: 'POST', pattern: new RegExp(`^/api/decisions/${ID}/defer$`), auth: 'session', handle: (r) => deferRoute(d, r) },
    {
      method: 'GET',
      pattern: /^\/api\/tasks$/,
      auth: 'session',
      handle: (r) => ok({ tasks: d.store.listTasks({ projectId: r.query.get('project') || undefined }).map(compactTask) }),
    },
    { method: 'POST', pattern: /^\/api\/tasks$/, auth: 'session', handle: (r) => addTaskRoute(d, r) },
    { method: 'GET', pattern: new RegExp(`^/api/tasks/${ID}$`), auth: 'session', handle: (r) => taskDetailRoute(d, r) },
    { method: 'POST', pattern: new RegExp(`^/api/tasks/${ID}/(retry|cancel)$`), auth: 'session', handle: (r) => taskActionRoute(d, r) },
    { method: 'GET', pattern: /^\/api\/digest$/, auth: 'session', handle: (r) => ok(buildDigest(d.store, d.now(), r.query)) },
    { method: 'POST', pattern: /^\/api\/pause$/, auth: 'session', handle: (r) => pauseRoute(d, r) },
    { method: 'GET', pattern: new RegExp(`^/api/tasks/${ID}/diff$`), auth: 'session', handle: (r) => taskDiffRoute(d, r) },
    {
      method: 'GET',
      pattern: /^\/api\/push\/key$/,
      auth: 'session',
      handle: () => ok({ publicKey: loadOrCreateVapidKeys(d.store).publicKey, subscriptions: d.store.listPushSubscriptions().length }),
    },
    { method: 'POST', pattern: /^\/api\/push\/subscribe$/, auth: 'session', handle: (r) => pushSubscribeRoute(d, r) },
    { method: 'POST', pattern: /^\/api\/push\/unsubscribe$/, auth: 'session', handle: (r) => pushUnsubscribeRoute(d, r) },
    { method: 'POST', pattern: /^\/api\/push\/test$/, auth: 'session', handle: () => pushTestRoute(d) },
  ];
}

// ------------------------------------------------------------- diff + push

/** The task's own changes (where its branch meets the target) for reading on the phone. */
async function taskDiffRoute(d: Deps, r: ApiRequest): Promise<ApiResponse> {
  const [id] = r.params;
  if (!d.store.getTask(id)) throw new HttpError(404, 'task not found');
  const diff = d.actions.taskDiff ? await d.actions.taskDiff(id) : null;
  if (!diff) return { status: 404, body: { error: 'no changes to show yet' } };
  return {
    status: 200,
    body: {
      baseCommit: diff.baseCommit,
      headCommit: diff.headCommit,
      files: diff.files.map((f) => ({ path: f.path, status: f.status, added: f.added, deleted: f.deleted })),
      patch: redactSecrets(diff.patch),
      truncated: diff.truncated,
    },
  };
}

/** Push services browsers use; the server only ever POSTs notifications to these hosts. */
const PUSH_HOST_SUFFIXES = ['push.apple.com', 'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

function pushSubscribeRoute(d: Deps, r: ApiRequest): ApiResponse {
  const body = r.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'invalid push endpoint');
  }
  if (url.protocol !== 'https:' || !PUSH_HOST_SUFFIXES.some((s) => url.hostname === s || url.hostname.endsWith(`.${s}`))) {
    throw new HttpError(400, 'unsupported push service');
  }
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw new HttpError(400, 'invalid subscription keys');
  d.store.addPushSubscription({ endpoint, keys: { p256dh, auth } }, headerValue(r.req.headers['user-agent']) ?? null);
  d.store.event({ type: 'inbox.push_subscribed', message: `Notifications enabled on a device (${url.hostname})` });
  return { status: 200, body: { subscribed: true, subscriptions: d.store.listPushSubscriptions().length } };
}

function pushUnsubscribeRoute(d: Deps, r: ApiRequest): ApiResponse {
  const endpoint = typeof (r.body as { endpoint?: unknown }).endpoint === 'string' ? String((r.body as { endpoint: string }).endpoint) : '';
  if (endpoint) d.store.removePushSubscription(endpoint);
  return { status: 200, body: { subscribed: false } };
}

async function pushTestRoute(d: Deps): Promise<ApiResponse> {
  const count = d.store.listPushSubscriptions().length;
  if (!count) return { status: 409, body: { error: 'no device has enabled notifications yet' } };
  await new WebPushNotifier(d.store).notify({ title: 'Autopilot', body: 'Notifications are working.', url: '/', priority: 'normal' });
  return { status: 200, body: { sent: count } };
}

// ------------------------------------------------------------- auth routes

function pairRoute(d: Deps, r: ApiRequest): ApiResponse {
  const code = typeof r.body.code === 'string' ? r.body.code : '';
  const paired = exchangePairingCode(d.store, code, headerValue(r.req.headers['user-agent']) ?? null);
  if (!paired) return { status: 401, body: { error: 'invalid, used or expired pairing code' } };
  // Re-pairing a device replaces its previous session.
  if (r.session) d.store.deleteInboxSession(r.session.tokenHash);
  d.store.event({ type: 'inbox.paired', message: 'A device paired with the inbox' });
  return {
    status: 200,
    body: { authenticated: true, csrf: paired.csrf },
    headers: { 'Set-Cookie': sessionCookie(paired.token, isSecureRequest(r.req)) },
  };
}

function logoutRoute(d: Deps, r: ApiRequest): ApiResponse {
  if (r.session) {
    if (!csrfMatches(r.session, r.req.headers['x-csrf-token'])) {
      throw new HttpError(403, 'csrf', { message: 'missing or invalid X-CSRF-Token header' });
    }
    d.store.deleteInboxSession(r.session.tokenHash);
  }
  return { status: 200, body: { authenticated: false }, headers: { 'Set-Cookie': clearSessionCookie(isSecureRequest(r.req)) } };
}

// ---------------------------------------------------------------- overview

function buildOverview(store: Store, at: number) {
  const projects = store.listProjects().map((p) => {
    const counts = Object.fromEntries(ALL_TASK_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
    for (const t of store.listTasks({ projectId: p.id })) counts[t.state] = (counts[t.state] ?? 0) + 1;
    return {
      id: p.id,
      name: p.name,
      profile: p.config?.profile ?? null,
      paused: p.paused,
      pauseReason: p.pauseReason,
      counts,
      pendingDecisions: store.pendingDecisionCount(p.id),
    };
  });
  const titles = new Map<string, string | null>();
  const titleOf = (taskId: string) => {
    if (!titles.has(taskId)) titles.set(taskId, store.getTask(taskId)?.title ?? null);
    return titles.get(taskId) ?? null;
  };
  const activeRuns = store.listRuns({ status: ['running'] }).map((run) => ({
    id: run.id,
    role: run.role,
    projectId: run.projectId,
    taskId: run.taskId,
    taskTitle: run.taskId ? titleOf(run.taskId) : null,
    startedAt: run.startedAt,
    heartbeatAt: run.heartbeatAt,
    sessionId: run.sessionId,
  }));
  return {
    now: at,
    pausedAll: store.isPausedAll(),
    usagePausedUntil: store.usagePausedUntil(),
    pendingDecisions: store.pendingDecisionCount(),
    projects,
    activeRuns,
  };
}

// --------------------------------------------------------------- decisions

/** A decision as the inbox shows it: the stored card plus task and project context. */
export interface DecisionView extends Decision {
  taskTitle: string | null;
  taskState: TaskState | null;
  projectName: string | null;
  /** Deferred ("Later") and not yet due again. */
  deferred: boolean;
}

export function isDeferred(d: Pick<Decision, 'deferredUntil'>, at: number): boolean {
  return d.deferredUntil !== null && d.deferredUntil > at;
}

/** Inbox order: cards not deferred first, then urgent > high > normal > low, then oldest first. */
export function sortPendingDecisions<T extends Pick<Decision, 'id' | 'priority' | 'createdAt' | 'deferredUntil'>>(list: readonly T[], at: number): T[] {
  return [...list].sort(
    (a, b) =>
      Number(isDeferred(a, at)) - Number(isDeferred(b, at)) ||
      (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) ||
      a.createdAt - b.createdAt ||
      idNumber(a.id) - idNumber(b.id),
  );
}

function idNumber(id: string): number {
  const n = Number(id.slice(id.lastIndexOf('-') + 1));
  return Number.isFinite(n) ? n : 0;
}

/** Closed cards, most recently answered/closed first. */
function newestClosedFirst(list: readonly Decision[]): Decision[] {
  const closedAt = (x: Decision) => x.answer?.at ?? x.updatedAt;
  return [...list].sort((a, b) => closedAt(b) - closedAt(a) || b.createdAt - a.createdAt || idNumber(b.id) - idNumber(a.id));
}

function decisionViews(store: Store, list: readonly Decision[], at: number): DecisionView[] {
  const projects = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const tasks = new Map<string, Task | null>();
  return list.map((dec) => {
    let task: Task | null = null;
    if (dec.taskId) {
      if (!tasks.has(dec.taskId)) tasks.set(dec.taskId, store.getTask(dec.taskId));
      task = tasks.get(dec.taskId) ?? null;
    }
    return {
      ...dec,
      taskTitle: task?.title ?? null,
      taskState: task?.state ?? null,
      projectName: projects.get(dec.projectId) ?? null,
      deferred: isDeferred(dec, at),
    };
  });
}

function decisionView(store: Store, dec: Decision | null, at: number): DecisionView | null {
  return dec ? decisionViews(store, [dec], at)[0] : null;
}

function listDecisionsRoute(d: Deps, r: ApiRequest): ApiResponse {
  const status = r.query.get('status') || 'pending';
  if (status !== 'pending' && status !== 'answered' && status !== 'all') {
    throw new HttpError(400, 'status must be pending, answered or all');
  }
  const projectId = r.query.get('project') || undefined;
  const at = d.now();
  const pending = status === 'answered' ? [] : sortPendingDecisions(d.store.listDecisions({ projectId, status: ['pending'], limit: 1000 }), at);
  const closedStatuses: DecisionStatus[] = status === 'answered' ? ['answered'] : ['answered', 'superseded', 'cancelled'];
  // listDecisions orders by priority/age, so fetch every closed card and pick the newest here.
  const closed = status === 'pending' ? [] : newestClosedFirst(d.store.listDecisions({ projectId, status: closedStatuses, limit: 1_000_000 })).slice(0, 50);
  return { status: 200, body: { decisions: decisionViews(d.store, [...pending, ...closed], at) } };
}

function respondRoute(d: Deps, r: ApiRequest): ApiResponse {
  const [id] = r.params;
  const b = r.body;
  const invalid = (reason: string): ApiResponse => ({ status: 400, body: { status: 'invalid', reason } });
  if (typeof b.revision !== 'number' || !Number.isInteger(b.revision)) return invalid('revision must be an integer');
  const optionId = optionalString(b.optionId);
  if (optionId === false) return invalid('optionId must be a string');
  const comment = optionalString(b.comment);
  if (comment === false) return invalid('comment must be a string');
  if (typeof b.idempotencyKey !== 'string') return invalid('idempotency key missing');

  const out = d.store.respond({ decisionId: id, revision: b.revision, optionId, comment, actor: 'founder', idempotencyKey: b.idempotencyKey });
  const at = d.now();
  switch (out.status) {
    case 'saved':
      try {
        d.actions.wake();
      } catch (err) {
        // The answer is durably saved (and in the outbox); a failed wake only delays pickup.
        d.logError('actions.wake after decision answer', err);
      }
      return { status: 200, body: { status: out.status, decision: decisionView(d.store, out.decision, at) } };
    case 'duplicate':
      return { status: 200, body: { status: out.status, decision: decisionView(d.store, out.decision, at) } };
    case 'stale_revision':
      return {
        status: 409,
        body: { status: out.status, currentRevision: out.currentRevision, decision: decisionView(d.store, d.store.getDecision(id), at) },
      };
    case 'not_pending':
      return {
        status: 409,
        body: { status: out.status, decisionStatus: out.decisionStatus, decision: decisionView(d.store, d.store.getDecision(id), at) },
      };
    case 'invalid':
      return { status: 400, body: { status: out.status, reason: out.reason } };
    case 'not_found':
      return { status: 404, body: { status: out.status, error: 'decision not found' } };
  }
}

function deferRoute(d: Deps, r: ApiRequest): ApiResponse {
  const [id] = r.params;
  const hours = r.body.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 1 || hours > 168) {
    throw new HttpError(400, 'hours must be a number between 1 and 168');
  }
  const at = d.now();
  const current = d.store.getDecision(id);
  if (!current) throw new HttpError(404, 'decision not found');
  if (current.status !== 'pending') {
    return { status: 409, body: { status: 'not_pending', decisionStatus: current.status, decision: decisionView(d.store, current, at) } };
  }
  const updated = d.store.deferDecision(id, at + hours * 3_600_000);
  d.store.event({
    projectId: current.projectId,
    taskId: current.taskId,
    decisionId: id,
    type: 'decision.deferred',
    message: `${id} deferred ${hours}h from the inbox`,
  });
  return { status: 200, body: { decision: decisionView(d.store, updated, at) } };
}

// ------------------------------------------------------------------- tasks

function compactTask(t: Task) {
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    state: t.state,
    // Reasons can quote run errors or check output.
    stateReason: redactedClip(t.stateReason, 1000),
    role: t.role,
    kind: t.kind,
    priority: t.priority,
    risk: t.risk,
    attempts: t.attempts,
    repairCycles: t.repairCycles,
    prUrl: t.prUrl,
    prNumber: t.prNumber,
    branch: t.branch,
    updatedAt: t.updatedAt,
    hypothesis: t.hypothesis,
  };
}

/**
 * A run as the phone shows it: no raw structured output and no final result
 * text (the inbox shows the summary; the full session is one
 * `claude --resume` away), and agent-written text redacted.
 */
function runView(run: Run) {
  const result = isPlainObject(run.result) ? run.result : {};
  const resultStatus = typeof result.status === 'string' ? result.status : typeof result.verdict === 'string' ? result.verdict : null;
  return {
    id: run.id,
    projectId: run.projectId,
    taskId: run.taskId,
    role: run.role,
    status: run.status,
    generation: run.generation,
    sessionId: run.sessionId,
    resumedSessionId: run.resumedSessionId,
    cwd: run.cwd,
    startedAt: run.startedAt,
    heartbeatAt: run.heartbeatAt,
    endedAt: run.endedAt,
    costUsd: run.costUsd,
    numTurns: run.numTurns,
    error: redactedClip(run.error, 2000),
    resultStatus,
    resultSummary: redactedClip(typeof result.summary === 'string' ? result.summary : null, 2000),
  };
}

/** The reviewer's verdict with its (agent-written) summary and findings redacted. */
function reviewView(review: ReviewRecord | null) {
  if (!review) return null;
  return {
    ...review,
    summary: redactedClip(review.summary, 8000) ?? '',
    findings: review.findings.map((f) => ({
      ...f,
      issue: redactedClip(f.issue, 2000) ?? '',
      ...(f.suggestion === undefined ? {} : { suggestion: redactedClip(f.suggestion, 2000) ?? '' }),
    })),
  };
}

function taskDetailRoute(d: Deps, r: ApiRequest): ApiResponse {
  const [id] = r.params;
  const task = d.store.getTask(id);
  if (!task) throw new HttpError(404, 'task not found');
  const head = task.headCommit;
  return {
    status: 200,
    body: {
      task: {
        ...task,
        stateReason: redactedClip(task.stateReason, 1000),
        // Notes carry builder/reviewer summaries and check output into the next run.
        notes: task.notes.slice(-20).map((n) => ({ ...n, text: redactedClip(n.text, 2000) ?? '' })),
      },
      runs: d.store.listRuns({ taskId: id, limit: 10 }).map(runView),
      checks: head
        ? { branch: d.store.latestChecks(id, head, 'branch'), integration: d.store.latestChecks(id, head, 'integration') }
        : { branch: [], integration: [] },
      review: reviewView(d.store.latestReview(id)),
      decisions: decisionViews(d.store, d.store.listDecisions({ taskId: id, limit: 50 }), d.now()),
      events: d.store.listEvents({ taskId: id, limit: 50 }).map(eventView),
    },
  };
}

function addTaskRoute(d: Deps, r: ApiRequest): ApiResponse {
  const b = r.body;
  const projectId = typeof b.projectId === 'string' ? b.projectId.trim() : '';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const objective = typeof b.objective === 'string' ? b.objective.trim() : '';
  if (!projectId || !d.store.getProject(projectId)) throw new HttpError(400, 'unknown project');
  if (!title || title.length > 200) throw new HttpError(400, 'title is required (at most 200 characters)');
  if (!objective || objective.length > 8000) throw new HttpError(400, 'objective is required (at most 8000 characters)');
  let acceptanceCriteria: string[] | undefined;
  if (b.acceptanceCriteria !== undefined && b.acceptanceCriteria !== null) {
    const raw = b.acceptanceCriteria;
    if (!Array.isArray(raw) || raw.some((c) => typeof c !== 'string')) throw new HttpError(400, 'acceptanceCriteria must be a list of strings');
    acceptanceCriteria = (raw as string[]).map((c) => c.trim()).filter(Boolean);
    if (acceptanceCriteria.length > 30 || acceptanceCriteria.some((c) => c.length > 1000)) {
      throw new HttpError(400, 'at most 30 acceptance criteria of at most 1000 characters each');
    }
  }
  const input = acceptanceCriteria ? { projectId, title, objective, acceptanceCriteria } : { projectId, title, objective };
  const task = callAction(() => d.actions.addTask(input));
  return { status: 200, body: { task } };
}

function taskActionRoute(d: Deps, r: ApiRequest): ApiResponse {
  const [id, action] = r.params;
  if (!d.store.getTask(id)) throw new HttpError(404, 'task not found');
  const task = callAction(() => (action === 'retry' ? d.actions.retryTask(id) : d.actions.cancelTask(id)));
  return { status: 200, body: { task } };
}

// ------------------------------------------------------------------ digest

function eventData(e: AuditEvent): Record<string, unknown> {
  return isPlainObject(e.data) ? e.data : {};
}

function buildDigest(store: Store, at: number, query: URLSearchParams) {
  const requested = Number(query.get('hours') ?? 24);
  const hours = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 24 * 30) : 24;
  const projectId = query.get('project') || undefined;
  const since = at - hours * 3_600_000;

  const tasks = new Map<string, Task | null>();
  const taskOf = (taskId: string | null) => {
    if (!taskId) return null;
    if (!tasks.has(taskId)) tasks.set(taskId, store.getTask(taskId));
    return tasks.get(taskId) ?? null;
  };

  // One query per category, newest first, each with its own cap: busy event types
  // never push rarer ones out of the window, and a cut is reported, not hidden.
  let truncated = false;
  const scan = (types: readonly string[], forProject: string | undefined): AuditEvent[] => {
    const rows = store.listEvents({ projectId: forProject, since, types: [...types], limit: DIGEST_EVENT_CAP + 1 });
    if (rows.length > DIGEST_EVENT_CAP) {
      truncated = true;
      rows.length = DIGEST_EVENT_CAP; // keeps the newest
    }
    return rows;
  };

  const integrated: { taskId: string; title: string; at: number; prUrl: string | null; projectId: string | null }[] = [];
  const failures: (AuditEvent & { taskTitle: string | null })[] = [];
  const failure = (e: AuditEvent) => {
    failures.push({ ...eventView(e), taskTitle: taskOf(e.taskId)?.title ?? null });
  };
  for (const e of scan(['task.state'], projectId)) {
    const to = eventData(e).to;
    if (to === 'integrated' && e.taskId) {
      const task = taskOf(e.taskId);
      integrated.push({ taskId: e.taskId, title: task?.title ?? e.taskId, at: e.at, prUrl: task?.prUrl ?? null, projectId: e.projectId });
    } else if (to === 'exhausted') {
      failure(e);
    }
  }
  for (const e of scan(['run.ended'], projectId)) {
    const status = eventData(e).status;
    if (typeof status === 'string' && FAILED_RUN_STATUSES.has(status)) failure(e);
  }
  failures.sort((a, b) => b.at - a.at || b.id - a.id);
  const answered = scan(['decision.answered'], projectId).map(eventView);
  // Usage pauses are account-wide (no project), so they are listed for every project filter.
  const usage = scan(USAGE_EVENT_TYPES, undefined)
    .filter((e) => !projectId || !e.projectId || e.projectId === projectId)
    .map(eventView);

  return {
    since,
    hours,
    /** True when a category hit DIGEST_EVENT_CAP: lists and counts cover only the newest events. */
    truncated,
    integrated,
    failures,
    answered,
    usage,
    counts: {
      integrated: integrated.length,
      failures: failures.length,
      answered: answered.length,
      usage: usage.length,
      pendingDecisions: store.pendingDecisionCount(projectId),
    },
  };
}

// ------------------------------------------------------------------- pause

function pauseRoute(d: Deps, r: ApiRequest): ApiResponse {
  const { scope, paused } = r.body;
  if (typeof paused !== 'boolean') throw new HttpError(400, 'paused must be true or false');
  if (typeof scope !== 'string' || !scope) throw new HttpError(400, "scope must be 'all' or a project id");
  const given = typeof r.body.reason === 'string' ? r.body.reason.trim().slice(0, 200) : '';
  const reason = given || 'from the phone inbox';
  if (scope === 'all') {
    callAction(() => (paused ? d.actions.pauseAll(reason) : d.actions.resumeAll(reason)));
  } else {
    if (!d.store.getProject(scope)) throw new HttpError(404, 'unknown project');
    callAction(() => (paused ? d.actions.pauseProject(scope, reason) : d.actions.resumeProject(scope, reason)));
  }
  return { status: 200, body: { ok: true, scope, paused } };
}

// ------------------------------------------------------------ agent bridge

async function handleAgentTool(req: IncomingMessage, res: ServerResponse, pathname: string, d: Deps): Promise<void> {
  // Caller first: anything under /agent from elsewhere gets 403, whatever its path or method.
  if (!agentRequestAllowed(req)) throw new HttpError(403, 'agent tools are only reachable from this machine');
  const m = /^\/agent\/tools\/([A-Za-z0-9_.:-]{1,80})$/.exec(pathname);
  if (!m) throw new HttpError(404, 'not found');
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed', {}, { Allow: 'POST' });
  const token = bearerToken(headerValue(req.headers.authorization));
  if (!token) throw new HttpError(401, 'missing bearer token', {}, { 'WWW-Authenticate': 'Bearer' });
  const args = await readJsonBody(req, { requireJsonType: false });
  const out = await d.agentTools.callTool(token, m[1], args);
  const status = Number.isInteger(out?.status) && out.status >= 200 && out.status <= 599 ? out.status : 500;
  sendJson(res, status, out?.body ?? null);
}
