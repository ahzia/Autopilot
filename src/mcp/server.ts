// SPDX-License-Identifier: MIT
// Stdio MCP server that gives one Claude Code worker the autopilot's agent
// tools. Claude Code launches it through --mcp-config:
//
//   node --disable-warning=ExperimentalWarning <abs>/src/mcp/server.ts
//   env AUTOPILOT_API_URL    supervisor HTTP API, e.g. http://127.0.0.1:4777
//       AUTOPILOT_RUN_TOKEN  bearer token of this run
//       AUTOPILOT_ROLE       builder | reviewer | planner (selects the listed tools)
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. tools/call is
// forwarded to POST {AUTOPILOT_API_URL}/agent/tools/{name}; the supervisor
// authenticates, fences and executes it (src/agent-api.ts). Only JSON-RPC is
// ever written to stdout; diagnostics go to stderr.

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS, toolsForRole, type ToolDefinition } from '../agent-api.ts';
import type { RunRole } from '../types.ts';

export const SERVER_INFO = { name: 'stayon-autopilot', version: '0.1.0' };
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
/** Versions whose initialize / tools/list / tools/call shapes this bridge implements. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_TIMEOUT_MS = 10_000;

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface CallToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

export interface BridgeConfig {
  apiUrl: string | null;
  token: string | null;
  /** null when AUTOPILOT_ROLE is missing or unknown: every tool is listed and the supervisor enforces roles. */
  role: RunRole | null;
  timeoutMs: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRequestId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

const log = (message: string): void => {
  process.stderr.write(`[autopilot-mcp] ${message}\n`);
};

export function configFromEnv(env: Record<string, string | undefined>): BridgeConfig {
  const role = env.AUTOPILOT_ROLE?.trim();
  // AUTOPILOT_TOOL_TIMEOUT_MS may only shorten the 10s call timeout (used by tests).
  const timeout = Number(env.AUTOPILOT_TOOL_TIMEOUT_MS);
  return {
    apiUrl: env.AUTOPILOT_API_URL?.trim() || null,
    token: env.AUTOPILOT_RUN_TOKEN?.trim() || null,
    role: role === 'builder' || role === 'reviewer' || role === 'planner' ? role : null,
    timeoutMs: Number.isInteger(timeout) && timeout > 0 && timeout < DEFAULT_TIMEOUT_MS ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

export function listedTools(role: RunRole | null): ToolDefinition[] {
  return role ? toolsForRole(role) : [...TOOL_DEFINITIONS];
}

const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

const textResult = (text: string, isError = false): CallToolResult => (isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] });

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'no response in time';
    // fetch wraps the real reason (ECONNREFUSED, bad port, ...) in err.cause.
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    if (typeof cause?.code === 'string') return `${err.message} (${cause.code})`;
    if (typeof cause?.message === 'string' && cause.message) return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}

const unreachable = (detail: string): CallToolResult =>
  textResult(
    `The autopilot supervisor is unreachable (${detail}). Finish your current step, commit your work, and end your run; do not keep retrying autopilot tools.`,
    true,
  );

/** POST one tool call to the supervisor and turn its answer into an MCP tool result. Never throws. */
export async function forwardToolCall(name: string, args: Obj, cfg: BridgeConfig, fetchImpl: typeof fetch = fetch): Promise<CallToolResult> {
  if (!cfg.apiUrl || !cfg.token) return unreachable('the tool bridge has no AUTOPILOT_API_URL or AUTOPILOT_RUN_TOKEN');
  const url = `${cfg.apiUrl.replace(/\/+$/, '')}/agent/tools/${encodeURIComponent(name)}`;
  let status: number;
  let raw: string;
  try {
    // The timeout covers the whole exchange, body included.
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    status = res.status;
    raw = await res.text();
  } catch (err) {
    log(`${name}: ${errorDetail(err)}`);
    return unreachable(errorDetail(err));
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  if (status === 200) return textResult(body === undefined ? raw : JSON.stringify(body, null, 2));
  const message = isObj(body) ? [body.message, body.error].find((v) => typeof v === 'string' && v.trim()) : undefined;
  return textResult(typeof message === 'string' ? message : `HTTP ${status}`, true);
}

async function toolsCall(id: string | number, params: unknown, cfg: BridgeConfig, fetchImpl: typeof fetch): Promise<JsonRpcResponse> {
  if (!isObj(params) || typeof params.name !== 'string') return rpcError(id, INVALID_PARAMS, 'Invalid params: tools/call needs a tool name');
  const name = params.name;
  // Only tools offered to this role are forwarded (this also keeps the URL path to known names).
  const tool = listedTools(cfg.role).find((t) => t.name === name);
  if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name.slice(0, 100)}`);
  const args = params.arguments ?? {};
  if (!isObj(args)) return rpcError(id, INVALID_PARAMS, 'Invalid params: arguments must be an object');
  return rpcResult(id, await forwardToolCall(tool.name, args, cfg, fetchImpl));
}

/** Handle one parsed JSON-RPC message; null means "send nothing" (notifications, stray responses). */
export async function handleMessage(msg: unknown, cfg: BridgeConfig, fetchImpl: typeof fetch = fetch): Promise<JsonRpcResponse | null> {
  if (Array.isArray(msg)) return rpcError(null, INVALID_REQUEST, 'Invalid Request: batches are not supported');
  if (!isObj(msg)) return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  const hasId = 'id' in msg;
  if (typeof msg.method !== 'string') {
    // Replies to server-initiated requests (this server sends none) are ignored.
    if ('result' in msg || 'error' in msg) return null;
    return hasId ? rpcError(isRequestId(msg.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request') : null;
  }
  // Notifications (notifications/initialized, notifications/cancelled, ...) get no reply.
  if (!hasId) return null;
  if (!isRequestId(msg.id)) return rpcError(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
  const id = msg.id;
  switch (msg.method) {
    case 'initialize': {
      const p = msg.params;
      const requested = isObj(p) && typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      // MCP version negotiation: echo a version we implement, otherwise offer our latest.
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: listedTools(cfg.role).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call':
      return toolsCall(id, msg.params, cfg, fetchImpl);
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method.slice(0, 100)}`);
  }
}

/** Handle one stdin line and send the reply, if any. Never rejects. */
export async function processLine(line: string, cfg: BridgeConfig, send: (msg: JsonRpcResponse) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    send(rpcError(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  try {
    const reply = await handleMessage(msg, cfg, fetchImpl);
    if (reply) send(reply);
  } catch (err) {
    log(`failed to handle a message: ${errorDetail(err)}`);
    if (isObj(msg) && 'id' in msg) send(rpcError(isRequestId(msg.id) ? msg.id : null, INTERNAL_ERROR, 'Internal error'));
  }
}

function main(): void {
  const cfg = configFromEnv(process.env);
  if (!cfg.role) log(`AUTOPILOT_ROLE is missing or unknown (${JSON.stringify(process.env.AUTOPILOT_ROLE ?? null)}); listing every tool`);
  if (!cfg.apiUrl || !cfg.token) log('AUTOPILOT_API_URL or AUTOPILOT_RUN_TOKEN is missing; tool calls will report the supervisor as unreachable');

  // The client closed its end of a pipe (EPIPE and friends): nobody is left to answer.
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));

  let lastWrite: Promise<void> = Promise.resolve();
  const send = (msg: JsonRpcResponse): void => {
    // JSON.stringify escapes line breaks inside strings, so every message is exactly one line.
    lastWrite = new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify(msg)}\n`, () => resolve());
    });
  };

  // Read stdin eagerly but handle lines strictly in order.
  let queue: Promise<void> = Promise.resolve();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    queue = queue.then(() => processLine(line, cfg, send));
  });
  // stdin ended: finish what was already received, flush stdout, exit cleanly.
  lines.on('close', () => {
    void queue.then(() => lastWrite).then(() => process.exit(0));
  });
}

/**
 * True when `entry` (process.argv[1]) is the file at `moduleUrl`, i.e. this
 * module was launched as the program rather than imported. Node's own flag for
 * this only exists from Node 24.2, while package.json accepts any Node 24; on
 * 24.0/24.1 the bridge would exit without a word and leave the worker with no
 * autopilot tools. Both sides go through realpath because the entry path may
 * be a symlink (macOS temp dirs live under /var -> /private/var).
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) main();
