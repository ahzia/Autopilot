// SPDX-License-Identifier: MIT
// Pure helpers for Claude Code's `--output-format stream-json` output: line parsing,
// event extraction and classification of the final result. No I/O happens here.
//
// Shapes observed in Claude Code 2.1.x (only the fields we rely on):
//   {type:'system', subtype:'init', session_id, model, tools}
//   {type:'system', subtype:'api_retry', attempt, max_retries, error_status}
//   {type:'assistant', message:{content:[{type:'text',text}|{type:'tool_use',name,input}]},
//    parent_tool_use_id, is_api_error_message?, api_error?, api_error_status?,
//    api_error_params?:{rate_limit_info?:{resetsAt}}}
//   {type:'user', message:{content:[{type:'tool_result', is_error}]}}
//   {type:'rate_limit_event', rate_limit_info:{status:'allowed'|'allowed_warning'|'rejected', resetsAt?}}
//   {type:'result', subtype:'success'|'error_during_execution'|'error_max_turns'|..., is_error,
//    result?, errors?, terminal_reason?, api_error?, api_error_status?, structured_output?,
//    startup_failure_reason? (a run that could not start; errors repeats stderr),
//    total_cost_usd, num_turns, session_id}
// `subtype` can be "success" while `is_error` is true (e.g. an auth failure), so the two are
// always read together.

import type { RunEvent, RunOutcome } from '../types.ts';
import { redactSecrets } from '../util.ts';

type Json = Record<string, unknown>;

/** Max characters of assistant text forwarded in a 'text' event. */
export const TEXT_EVENT_MAX = 500;
const SUMMARY_MAX = 160;
const ERROR_SNIPPET_MAX = 300;
/** A reset time this far in the past still counts (clock skew, message written just before reset). */
const PAST_GRACE_MS = 5 * 60_000;
/** Usage windows are at most weekly/monthly; anything further out is a parse mistake. */
const MAX_FUTURE_MS = 35 * 24 * 60 * 60_000;
/** Largest epoch ms a Date can hold. */
const MAX_DATE_MS = 8.64e15;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * redactSecrets, plus private-key fragments whose BEGIN or END line was cut off when the text
 * was clipped (redactSecrets only recognizes complete key blocks).
 */
function redactClipped(text: string): string {
  return redactSecrets(text)
    .replace(/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, '[redacted private key]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/, '[redacted private key]');
}

/** Redact, flatten and shorten untrusted text before it reaches events or error messages. */
function safeSnippet(text: string, max: number): string {
  return clip(oneLine(redactClipped(text.slice(0, max * 8))), max);
}

/** Like safeSnippet, but keeps the end of the text: the last stderr lines usually hold the cause. */
function tailSnippet(text: string, max: number): string {
  const s = oneLine(redactClipped(text.slice(-max * 8)));
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`;
}

// ------------------------------------------------------------------ parsing

/** Parse one stdout line. Blank lines, plain text and broken JSON yield null. */
export function parseStreamLine(line: string): Json | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(s);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function contentBlocks(msg: Json): Json[] {
  const message = msg.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

/** Events for one stream message: session/tool_use/text as applicable, plus one 'activity'. */
export function toRunEvents(msg: unknown): RunEvent[] {
  if (!isRecord(msg)) return [];
  const events: RunEvent[] = [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    const sessionId = str(msg.session_id);
    if (sessionId) events.push({ type: 'session', sessionId });
  } else if (msg.type === 'assistant') {
    for (const block of contentBlocks(msg)) {
      if (block.type === 'tool_use') {
        const tool = str(block.name);
        if (tool) events.push({ type: 'tool_use', tool });
      } else if (block.type === 'text') {
        const text = str(block.text);
        if (text && text.trim() !== '') {
          events.push({ type: 'text', text: clip(redactClipped(text.slice(0, TEXT_EVENT_MAX * 4)), TEXT_EVENT_MAX) });
        }
      }
    }
  }
  events.push({ type: 'activity', summary: summarize(msg) });
  return events;
}

const TOOL_HINT_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description'];

/** Short, redacted hint of what a tool call touches, e.g. the Bash command or the edited file. */
function toolHint(input: unknown): string {
  if (!isRecord(input)) return '';
  for (const key of TOOL_HINT_KEYS) {
    const value = str(input[key]);
    if (value) return safeSnippet(value, 60);
  }
  return '';
}

function describeBlock(block: Json): string {
  switch (block.type) {
    case 'tool_use': {
      const name = str(block.name) ?? 'tool';
      const hint = toolHint(block.input);
      return hint ? `${name}: ${hint}` : name;
    }
    case 'text': {
      const text = str(block.text);
      return text ? `"${safeSnippet(text, 60)}"` : '';
    }
    case 'thinking':
    case 'redacted_thinking':
      return 'thinking';
    default:
      return '';
  }
}

function summarize(msg: Json): string {
  const type = str(msg.type) ?? 'unknown';
  const subtype = str(msg.subtype);
  let summary: string;
  switch (type) {
    case 'system':
      summary = summarizeSystem(msg, subtype);
      break;
    case 'assistant': {
      const parts = contentBlocks(msg).map(describeBlock).filter((p) => p !== '');
      if (msg.is_api_error_message === true) parts.unshift('API error');
      const who = str(msg.parent_tool_use_id) ? 'subagent' : 'assistant';
      summary = `${who}: ${parts.length > 0 ? parts.join('; ') : 'message'}`;
      break;
    }
    case 'user': {
      const results = contentBlocks(msg).filter((b) => b.type === 'tool_result');
      const failed = results.filter((b) => b.is_error === true).length;
      if (results.length === 0) summary = 'user message';
      else if (failed > 0) summary = `tool result (${failed} of ${results.length} failed)`;
      else summary = results.length === 1 ? 'tool result' : `${results.length} tool results`;
      break;
    }
    case 'result':
      summary = `result: ${subtype ?? 'unknown'}${msg.is_error === true ? ' (error)' : ''}`;
      break;
    case 'rate_limit_event': {
      const info = isRecord(msg.rate_limit_info) ? msg.rate_limit_info : {};
      const resetAt = resetFromRateLimitInfo(info);
      summary = `rate limit ${str(info.status) ?? 'update'}${resetAt !== null ? `, resets ${new Date(resetAt).toISOString()}` : ''}`;
      break;
    }
    default:
      summary = subtype ? `${type}: ${subtype}` : type;
  }
  return clip(summary, SUMMARY_MAX);
}

function summarizeSystem(msg: Json, subtype: string | null): string {
  if (subtype === 'init') {
    const model = str(msg.model);
    const tools = Array.isArray(msg.tools) ? msg.tools.length : null;
    return `session started${model ? ` on ${model}` : ''}${tools !== null ? `, ${tools} tools` : ''}`;
  }
  if (subtype === 'api_retry') {
    const attempt = num(msg.attempt);
    const max = num(msg.max_retries);
    const status = num(msg.error_status);
    const count = attempt !== null ? ` ${attempt}${max !== null ? `/${max}` : ''}` : '';
    return `API retry${count}${status !== null ? ` (HTTP ${status})` : ''}`;
  }
  return `system: ${subtype ?? 'event'}`;
}

// ------------------------------------------------------------ stream state

/** What a runner remembers while reading the stream; feeds classifyResult at the end. */
export interface StreamState {
  /** Session id announced by the init message. */
  sessionId: string | null;
  /** The last result message. */
  result: Json | null;
  /** Epoch ms when a rejected rate limit resets, from rate_limit_event or an API-error message. */
  rateLimitResetAt: number | null;
  /** Typed kind of the last API error message (e.g. "usage_limit_reached"). */
  apiError: string | null;
  apiErrorStatus: number | null;
  /** Text of the last API error message. */
  apiErrorText: string | null;
  messageCount: number;
}

export function newStreamState(): StreamState {
  return {
    sessionId: null,
    result: null,
    rateLimitResetAt: null,
    apiError: null,
    apiErrorStatus: null,
    apiErrorText: null,
    messageCount: 0,
  };
}

/** Reset time of a rate_limit_info object (unix seconds in the stream) as epoch ms; null if absent or not a valid date. */
function resetFromRateLimitInfo(info: Json): number | null {
  const values = [num(info.resetsAt), num(info.overageResetsAt)].filter((v): v is number => v !== null && v > 0);
  if (values.length === 0) return null;
  const earliest = Math.min(...values);
  const ms = earliest < 1e12 ? earliest * 1000 : earliest;
  return ms <= MAX_DATE_MS ? ms : null;
}

export function observeMessage(state: StreamState, msg: unknown): void {
  if (!isRecord(msg)) return;
  state.messageCount += 1;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') state.sessionId = str(msg.session_id) ?? state.sessionId;
      break;
    case 'result':
      state.result = msg;
      break;
    case 'rate_limit_event': {
      const info = msg.rate_limit_info;
      if (isRecord(info) && info.status === 'rejected') {
        state.rateLimitResetAt = resetFromRateLimitInfo(info) ?? state.rateLimitResetAt;
      }
      break;
    }
    case 'assistant':
      if (msg.is_api_error_message === true || str(msg.api_error)) {
        state.apiError = str(msg.api_error);
        state.apiErrorStatus = num(msg.api_error_status);
        const text = contentBlocks(msg)
          .map((b) => (b.type === 'text' ? str(b.text) : null))
          .filter((t): t is string => t !== null)
          .join(' ');
        state.apiErrorText = text || null;
        const params = msg.api_error_params;
        if (isRecord(params) && isRecord(params.rate_limit_info)) {
          state.rateLimitResetAt = resetFromRateLimitInfo(params.rate_limit_info) ?? state.rateLimitResetAt;
        }
      }
      break;
  }
}

// ---------------------------------------------------------- classification

export type ResultClassification = Omit<RunOutcome, 'exitCode' | 'sessionId'>;

/** Extra evidence for classifyResult; a StreamState can be passed directly. */
export interface ClassifyContext {
  /** Signal that ended the process, if any. */
  signal?: string | null;
  rateLimitResetAt?: number | null;
  apiError?: string | null;
  apiErrorStatus?: number | null;
  apiErrorText?: string | null;
}

type Cause = 'usage' | 'auth' | 'transient' | 'other';

/** Phrases for one kind of failure text, tried in this order: overload, usage, auth, network. */
interface CauseRules {
  overload: RegExp;
  usage: RegExp;
  auth: RegExp;
  network: RegExp;
}

/**
 * Broad phrases, for text that reports an API or startup failure: the result text of a run that
 * ended on an API error, the API error message itself, or stderr when no result message arrived.
 * Overloads go first: their messages often say "try again in ...", which is not a usage limit.
 */
const API_FAILURE_RULES: CauseRules = {
  overload: /overloaded|\b529\b/i,
  usage:
    /usage limit|\brate[ _-]?limit|limit reached|limit exceeded|reached your .*limit|hit your .*limit|\bresets? (?:at|in)\b|\btry again (?:at|in)\b|out of (?:extra )?usage|\bquotas?\b/i,
  auth: /authenticat|oauth|not logged in|log(?:ged)? ?in (?:again|required|expired)|\/login\b|invalid (?:x-)?api[ -]?key|api key (?:is )?(?:invalid|missing|revoked|disabled)|unauthori[sz]ed|credit balance|(?:token|credentials?) (?:has |have )?(?:expired|been revoked|revoked|is invalid)|\blogin\b(?!\.\w|[/-])/i,
  network:
    /internal server error|service unavailable|bad gateway|gateway time-?out|connection (?:error|reset|refused)|econnreset|etimedout|econnrefused|socket hang up|network error|request timed out|fetch failed/i,
};

/**
 * Strict phrases, for any other failure text (errors[] of error_* results, stderr next to a
 * result message). Ordinary tool, hook and build failures mention "login", "oauth", "quota" or
 * "rate limit" too ("Cannot find module './login'", "gh: API rate limit exceeded"), so only
 * Claude Code's and the Anthropic API's own wording counts here.
 */
const RUN_FAILURE_RULES: CauseRules = {
  overload: /overloaded_error|\b529 overloaded\b|\bAPI Error: (?:529\b|overloaded)/i,
  usage:
    /\busage limit reached|\b(?:hit|reached) your (?:[\w-]+ )?limit\b|\blimit reached\b[^\n]{0,40}\bresets?\b|rate_limit_error|\bAPI Error: 429\b|\bout of (?:extra )?usage\b/i,
  auth: /failed to authenticate|authentication_error|invalid (?:x-)?api[ -]?key|oauth (?:token|session) (?:has )?(?:expired|been revoked|revoked|is invalid)|please run \/login|credit balance is too low|\bAPI Error: 40[13]\b/i,
  network: /\bAPI Error: (?:5\d\d\b|connection error|request timed out)/i,
};

/** Context-window exhaustion mentions "limit" too, but waiting for a reset will not fix it. */
const CONTEXT_RE = /context (?:window|length|limit)|prompt is too long|too many tokens|max_tokens/i;

/** Result subtypes whose cause is already known, so their text is not searched for clues. */
const SELF_EXPLAINED_SUBTYPES = new Set(['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);
/** Typed api_error kinds (Claude Code 2.1.x) that need the founder to fix credentials. */
const AUTH_API_ERRORS = new Set([
  'gateway_signin_required',
  'gateway_session_expired',
  'api_key_auth_disabled',
  'org_disabled_credential',
  'invalid_credential_header',
  'provider_credentials',
]);
/**
 * startup_failure_reason values (Claude Code 2.1.x, set on the error_during_execution result
 * written when a run cannot start) that need the founder to fix sign-in or org credentials.
 * Every other reason (cwd_unavailable, worktree_unverified, cli_version_too_old, ...) is an
 * ordinary failure whatever its text says.
 */
const AUTH_STARTUP_FAILURES = new Set([
  'gateway_signin_required',
  'gateway_access_denied',
  'org_pin_api_key_conflict',
  'org_pin_mismatch',
  'org_verify_failed',
  'provider_not_allowed',
]);
/** Older Claude Code printed usage limits as "Claude AI usage limit reached|<unix seconds>". */
const LEGACY_USAGE_RESULT_RE = /^Claude AI usage limit reached\|\d{9,13}\s*$/;

function isCleanSuccess(result: Json): boolean {
  if (result.is_error !== false) return false;
  if (str(result.subtype)?.startsWith('error')) return false;
  if (str(result.api_error)) return false;
  const text = str(result.result);
  return !(text && LEGACY_USAGE_RESULT_RE.test(text.trim()));
}

/** Error text carried by a result message: `result` for success-subtype, `errors` for error subtypes. */
function resultMessage(result: Json): string {
  const parts: string[] = [];
  const text = str(result.result);
  if (text) parts.push(text);
  if (Array.isArray(result.errors)) {
    for (const e of result.errors) {
      const s = typeof e === 'string' ? e : isRecord(e) ? str(e.message) : null;
      if (s) parts.push(s);
    }
  }
  return parts.join(' | ');
}

/**
 * Whether a failed result message reports an API (or startup) failure rather than a problem
 * during the run. Its text is then Claude Code's own error message.
 */
function endedOnApiError(r: Json): boolean {
  if (str(r.api_error) || num(r.api_error_status) !== null) return true;
  const reason = str(r.terminal_reason);
  if (reason) return reason === 'api_error';
  // Builds without terminal_reason: a run that ends on an API error gets a success-subtype
  // result flagged is_error (as in the real auth sample); error_* subtypes are run failures.
  const subtype = str(r.subtype);
  return subtype === null || subtype === 'success';
}

/** The text a failure is judged and reported by. */
interface Evidence {
  text: string;
  /** stderr is clipped from its end in error messages, other text from its start. */
  fromStderr: boolean;
  /** Whether the broad API_FAILURE_RULES may read the text (otherwise RUN_FAILURE_RULES). */
  apiFailure: boolean;
}

function failureEvidence(r: Json | null, stderrTail: string, ctx: ClassifyContext): Evidence {
  const stderr = stderrTail.trim();
  if (!r) {
    // No result message: claude could not start, crashed or was stopped. The last API error
    // message or stderr is all there is, and describes a startup/API problem as often as not.
    const apiText = ctx.apiErrorText ?? '';
    return apiText ? { text: apiText, fromStderr: false, apiFailure: true } : { text: stderr, fromStderr: true, apiFailure: true };
  }
  const apiFailure = endedOnApiError(r);
  const text = resultMessage(r) || (apiFailure ? (ctx.apiErrorText ?? '') : '');
  if (text) return { text, fromStderr: false, apiFailure };
  // The result says nothing: stderr may still explain the failure, but next to a result message
  // it is mostly noise from hooks and MCP servers, so only strict phrases count.
  return { text: stderr, fromStderr: true, apiFailure: false };
}

function detectCause(result: Json | null, ctx: ClassifyContext, evidence: Evidence): Cause {
  const subtype = str(result?.subtype);
  if (subtype && SELF_EXPLAINED_SUBTYPES.has(subtype)) return 'other';
  const startupReason = str(result?.startup_failure_reason);
  if (startupReason) return AUTH_STARTUP_FAILURES.has(startupReason) ? 'auth' : 'other';
  // Prefer the result's own API error fields. Fall back to the last API error seen in the
  // stream only when the run ended on an API error (or never produced a result).
  const apiEnded = !result || endedOnApiError(result);
  const apiError = str(result?.api_error) ?? (apiEnded ? (ctx.apiError ?? null) : null);
  const status = num(result?.api_error_status) ?? (apiEnded ? (ctx.apiErrorStatus ?? null) : null);

  if (apiError === 'usage_limit_reached' || status === 429) return 'usage';
  if ((apiError !== null && AUTH_API_ERRORS.has(apiError)) || status === 401 || status === 403) return 'auth';
  if (status === 529 || (status !== null && status >= 500 && status <= 504)) return 'transient';
  const text = evidence.text;
  if (result?.terminal_reason === 'prompt_too_long' || CONTEXT_RE.test(text)) return 'other';
  const rules = evidence.apiFailure ? API_FAILURE_RULES : RUN_FAILURE_RULES;
  if (rules.overload.test(text)) return 'transient';
  if (rules.usage.test(text)) return 'usage';
  if (rules.auth.test(text)) return 'auth';
  if (rules.network.test(text)) return 'transient';
  return 'other';
}

/**
 * Decide the outcome of a finished `claude -p` process from its last result message (or null
 * when none arrived), exit code and stderr tail. Error prefixes the supervisor acts on:
 *   "auth: ..."      credentials need the founder (pause everything, ask to log in)
 *   "transient: ..." API overloaded/unreachable (retry later)
 * Usage limits get status 'usage_limited' with usageResetAt when it can be parsed.
 * Typed API error fields decide first. Text phrases count broadly only for API and startup
 * failures (see failureEvidence), so an ordinary run failure that happens to mention "login",
 * "quota" or "rate limit" stays a plain failure instead of pausing every project.
 */
export function classifyResult(
  result: unknown,
  exitCode: number | null,
  stderrTail: string,
  now: number,
  ctx: ClassifyContext = {},
): ResultClassification {
  const r = isRecord(result) ? result : null;
  const base = {
    structuredOutput: r?.structured_output ?? null,
    resultText: typeof r?.result === 'string' ? r.result : null,
    terminalReason: str(r?.terminal_reason),
    costUsd: num(r?.total_cost_usd),
    numTurns: num(r?.num_turns),
    usageResetAt: null,
  };
  if (r && isCleanSuccess(r)) return { ...base, status: 'succeeded', isError: false, error: null };

  // The result's own text is the evidence; stderr is only consulted when there is nothing else,
  // and next to a result only for unmistakable API wording (see failureEvidence).
  const evidence = failureEvidence(r, stderrTail, ctx);
  const text = evidence.text;
  const snippet = !text ? '' : evidence.fromStderr ? tailSnippet(text, ERROR_SNIPPET_MAX) : safeSnippet(text, ERROR_SNIPPET_MAX);
  const cause = detectCause(r, ctx, evidence);

  // Context for failures without a result message, e.g. "claude exited with code 3 ...".
  const exitDesc = ctx.signal ? `was killed by ${ctx.signal}` : exitCode === null ? 'exited' : `exited with code ${exitCode}`;
  const noResult = `claude ${exitDesc} without a result message`;
  const withContext = (prefix: string, fallback: string): string =>
    r ? `${prefix}${snippet || fallback}` : `${prefix}${snippet || fallback} (${noResult})`;

  switch (cause) {
    case 'usage': {
      const hinted = plausible(ctx.rateLimitResetAt ?? Number.NaN, now);
      return {
        ...base,
        status: 'usage_limited',
        isError: true,
        usageResetAt: hinted ?? parseUsageResetAt(text, now),
        error: withContext('usage limit: ', 'usage limit reached'),
      };
    }
    case 'auth':
      return { ...base, status: 'failed', isError: true, error: withContext('auth: ', 'authentication failed') };
    case 'transient':
      return { ...base, status: 'failed', isError: true, error: withContext('transient: ', 'API temporarily unavailable') };
    default: {
      if (!r) return { ...base, status: 'failed', isError: true, error: snippet ? `${noResult}: ${snippet}` : noResult };
      const details = [
        str(r.subtype) && `subtype=${str(r.subtype)}`,
        str(r.startup_failure_reason) && `startup_failure_reason=${str(r.startup_failure_reason)}`,
        base.terminalReason && `terminal_reason=${base.terminalReason}`,
        num(r.api_error_status) !== null && `api_error_status=${num(r.api_error_status)}`,
        str(r.api_error) && `api_error=${str(r.api_error)}`,
      ].filter(Boolean);
      const head = `claude run failed (${details.length > 0 ? details.join(', ') : 'is_error'})`;
      return { ...base, status: 'failed', isError: true, error: snippet ? `${head}: ${snippet}` : head };
    }
  }
}

// --------------------------------------------------------- usage reset time

/** Keep a parsed reset time only if it is plausible relative to now. */
function plausible(t: number, now: number): number | null {
  if (!Number.isFinite(t)) return null;
  if (t < now - PAST_GRACE_MS || t > now + MAX_FUTURE_MS) return null;
  return t;
}

/**
 * Parse when a usage limit resets from Claude Code's message text, as epoch ms. Understands
 * "...limit reached|1732480000" (unix seconds), ISO timestamps, clock times such as
 * "resets 3pm", "resets at 5:00 PM", "resets Nov 28, 3pm (Europe/Berlin)", "resets Mon 9am"
 * (local time unless a zone is named; today, or the next matching day once it has passed),
 * and delays such as "try again in 2 hours" or "resets in 2h 30m". Returns null when unknown.
 */
export function parseUsageResetAt(text: string, now: number): number | null {
  if (!text) return null;
  return fromEpochSuffix(text, now) ?? fromIsoTimestamp(text, now) ?? fromClockTime(text, now) ?? fromRelativeDelay(text, now);
}

function fromEpochSuffix(text: string, now: number): number | null {
  const m = /\|\s*(\d{10}|\d{13})(?!\d)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return plausible(m[1].length === 13 ? n : n * 1000, now);
}

function validDate(y: number, mo: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, mo, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d;
}

const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:\s?(Z|UTC|GMT|[+-]\d{2}:?\d{2})\b)?/i;

function fromIsoTimestamp(text: string, now: number): number | null {
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  const zone = (m[7] as string | undefined)?.toUpperCase();
  let t: number;
  if (!zone) {
    t = new Date(y, mo, d, h, mi, s).getTime();
  } else if (zone === 'Z' || zone === 'UTC' || zone === 'GMT') {
    t = Date.UTC(y, mo, d, h, mi, s);
  } else {
    const digits = zone.slice(1).replace(':', '');
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    t = Date.UTC(y, mo, d, h, mi, s) - (zone.startsWith('-') ? -1 : 1) * offsetMin * 60_000;
  }
  return plausible(t, now);
}

type Zone = { kind: 'local' } | { kind: 'utc' } | { kind: 'iana'; name: string };
const LOCAL: Zone = { kind: 'local' };
const UTC: Zone = { kind: 'utc' };
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(name: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(name);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormatters.set(name, f);
  }
  return f;
}

/** "(Europe/Berlin)" -> IANA zone; UTC/GMT -> UTC; anything unknown -> local time. */
function resolveZone(label: string | undefined): Zone {
  const s = label?.trim();
  if (!s) return LOCAL;
  if (/^(?:utc|gmt|z)$/i.test(s)) return UTC;
  try {
    zoneFormatter(s);
    return { kind: 'iana', name: s };
  } catch {
    return LOCAL;
  }
}

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(epoch: number, zone: Zone): WallClock {
  const dt = new Date(epoch);
  if (zone.kind === 'local') {
    return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds() };
  }
  if (zone.kind === 'utc') {
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds() };
  }
  const parts = zoneFormatter(zone.name).formatToParts(dt);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return { y: get('year'), mo: get('month') - 1, d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** Epoch ms of a wall-clock time in a zone (day overflow allowed, e.g. d = 32). */
function epochOf(zone: Zone, y: number, mo: number, d: number, h: number, mi: number): number {
  if (zone.kind === 'local') return new Date(y, mo, d, h, mi, 0, 0).getTime();
  const wall = Date.UTC(y, mo, d, h, mi);
  if (zone.kind === 'utc') return wall;
  // Two passes settle the zone offset even when a DST change sits between guess and answer.
  const offsetAt = (epoch: number): number => {
    const w = wallClock(epoch, zone);
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(epoch / 1000) * 1000;
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

const WEEKDAY_WORDS = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat';
const MONTH_WORDS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// keyword, [today|tomorrow], [weekday], [month day], [at] hour[:min] [am|pm], [(zone) | UTC]
const CLOCK_RE = new RegExp(
  String.raw`\b(?:resets?|again|until|after)\b(?:\s+(?:at|on|by|after|around))?\s+` +
    String.raw`(?:(today|tomorrow)\s+)?` +
    String.raw`(?:(${WEEKDAY_WORDS})\b\.?,?\s+)?` +
    String.raw`(?:(${MONTH_WORDS})\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?\s+)?` +
    String.raw`(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\b\.?)?` +
    String.raw`(?:\s*\(([^()]{1,48})\)|\s+(UTC|GMT)\b)?`,
  'gi',
);

function fromClockTime(text: string, now: number): number | null {
  for (const m of text.matchAll(CLOCK_RE)) {
    const g = (i: number): string | undefined => m[i] as string | undefined;
    const minuteText = g(6);
    const meridiem = g(7)?.toLowerCase();
    // "resets 5" alone is too ambiguous: require am/pm or minutes.
    if (!meridiem && !minuteText) continue;
    let hour = Number(g(5));
    const minute = minuteText ? Number(minuteText) : 0;
    if (minute > 59) continue;
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
    } else if (hour > 23) {
      continue;
    }
    const zone = resolveZone(g(8) ?? g(9));
    const today = wallClock(now, zone);
    const monthWord = g(3);
    let t: number | null = null;
    if (monthWord && g(4)) {
      const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase());
      const day = Number(g(4));
      for (const year of [today.y, today.y + 1]) {
        if (!validDate(year, month, day)) continue;
        const candidate = epochOf(zone, year, month, day, hour, minute);
        if (candidate >= now - PAST_GRACE_MS) {
          t = candidate;
          break;
        }
      }
    } else {
      const weekdayWord = g(2);
      const weekday = weekdayWord ? WEEKDAYS.indexOf(weekdayWord.slice(0, 3).toLowerCase()) : -1;
      const first = g(1)?.toLowerCase() === 'tomorrow' ? 1 : 0;
      for (let k = first; k < first + 8 && t === null; k++) {
        const date = new Date(Date.UTC(today.y, today.mo, today.d + k));
        if (weekday >= 0 && date.getUTCDay() !== weekday) continue;
        const candidate = epochOf(zone, date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
        if (candidate >= now - PAST_GRACE_MS) t = candidate;
      }
    }
    if (t !== null) return plausible(t, now);
  }
  return null;
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const DURATION = String.raw`(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;
const RELATIVE_RE = new RegExp(String.raw`\bin\s+(?:about\s+|approximately\s+|~\s*)?((?:${DURATION}[\s,]*(?:and\s+)?)+)`, 'i');
const DURATION_RE = new RegExp(DURATION, 'gi');

function fromRelativeDelay(text: string, now: number): number | null {
  const m = RELATIVE_RE.exec(text);
  if (!m) return null;
  let total = 0;
  for (const part of m[1].matchAll(DURATION_RE)) {
    total += Number(part[1]) * (UNIT_MS[part[2][0].toLowerCase()] ?? 0);
  }
  return total > 0 ? plausible(now + total, now) : null;
}
