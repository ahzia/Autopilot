// SPDX-License-Identifier: MIT
// Phone notifications. Callers send short, generic text (never secrets or diffs);
// the details live behind the authenticated inbox link.

import type { ProjectConfig } from './config.ts';
import type { DecisionPriority, Notifier } from './types.ts';
import { redactSecrets } from './util.ts';

export type Notification = Parameters<Notifier['notify']>[0];

const NTFY_PRIORITY: Record<DecisionPriority, string> = { urgent: '5', high: '4', normal: '3', low: '2' };
/** ntfy turns larger messages into attachments; stay below its 4096-byte limit. */
const MAX_BODY_BYTES = 3800;
const MAX_TITLE_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 5000;

export interface NtfyOptions {
  /** Server base URL, e.g. "https://ntfy.sh". */
  url: string;
  topic: string;
  /** Inbox base URL used for the Click link (and to resolve relative notification urls). */
  publicUrl?: string | null;
  fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 5000). */
  timeoutMs?: number;
}

/**
 * Publishes to an ntfy topic. Never throws: failures are logged to stderr.
 * The topic acts as a password, so neither it nor the endpoint is ever logged.
 */
export class NtfyNotifier implements Notifier {
  /** Null when the configured URL is unusable: the notifier is disabled. */
  private readonly endpoint: string | null;
  /** Strings that reveal the topic (endpoint forms, raw and encoded topic), longest first. */
  private readonly secrets: string[];
  private readonly publicUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: NtfyOptions) {
    const raw = `${opts.url.replace(/\/+$/, '')}/${encodeURIComponent(opts.topic)}`;
    const parsed = parseEndpoint(raw);
    this.endpoint = parsed.ok ? parsed.href : null;
    const secrets = [raw, parsed.ok ? parsed.href : '', opts.topic, encodeURIComponent(opts.topic)];
    // Very short strings would mangle every message and are no secret worth hiding.
    this.secrets = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
    this.publicUrl = opts.publicUrl ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!parsed.ok) console.error(`[autopilot] ntfy notifications are disabled: the ntfy URL ${parsed.problem}`);
  }

  async notify(n: Notification): Promise<void> {
    if (!this.endpoint) return; // disabled; reported once at construction
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: headerText(redactSecrets(String(n.title ?? '')), MAX_TITLE_CHARS),
        Priority: NTFY_PRIORITY[n.priority ?? 'normal'] ?? NTFY_PRIORITY.normal,
        Tags: 'robot',
      };
      const click = clickUrl(n.url, this.publicUrl);
      if (click) headers.Click = click;
      const doFetch = this.fetchImpl; // call unbound: some fetch implementations reject a foreign `this`
      const res = await doFetch(this.endpoint, {
        method: 'POST',
        headers,
        body: clipBytes(redactSecrets(String(n.body ?? '')), MAX_BODY_BYTES),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) console.error(`[autopilot] ntfy notification failed: HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      console.error(`[autopilot] ntfy notification failed: ${this.scrub(describeError(err))}`);
    }
  }

  /** Error texts may quote the request URL (e.g. "Failed to parse URL from ..."). */
  private scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(s.includes('/') ? '<ntfy endpoint>' : '<ntfy topic>');
    return out;
  }
}

export class NullNotifier implements Notifier {
  async notify(_n: Notification): Promise<void> {}
}

/** Records notifications in memory (tests, dry runs). */
export class MemoryNotifier implements Notifier {
  readonly sent: Notification[] = [];

  /** Alias of `sent`. */
  get notifications(): Notification[] {
    return this.sent;
  }

  async notify(n: Notification): Promise<void> {
    this.sent.push({ ...n });
  }
}

export function makeNotifier(config: ProjectConfig['inbox']): Notifier {
  if (config.ntfyUrl && config.ntfyTopic) {
    return new NtfyNotifier({ url: config.ntfyUrl, topic: config.ntfyTopic, publicUrl: config.publicUrl });
  }
  return new NullNotifier();
}

// ------------------------------------------------------------------ helpers

/** Validate the publish URL up front; problems are described without quoting the URL. */
function parseEndpoint(raw: string): { ok: true; href: string } | { ok: false; problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'is not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, problem: 'must use http or https' };
  // fetch() refuses URLs with credentials, and they would end up in error messages.
  if (url.username || url.password) return { ok: false, problem: 'must not contain a user name or password' };
  return { ok: true, href: url.href };
}

/** One-line header value; HTTP headers must be Latin-1, so other text is RFC 2047 encoded (ntfy decodes it). */
function headerText(s: string, max: number): string {
  const flat = Array.from(s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim())
    .slice(0, max)
    .join('');
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

/** The notification's own url (absolute, or relative to publicUrl), else publicUrl; http(s) only. */
function clickUrl(url: string | undefined, publicUrl: string | null): string | null {
  const parse = (u: string, base?: string): string | null => {
    try {
      const parsed = new URL(u, base);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch {
      return null;
    }
  };
  return (url ? parse(url, publicUrl ?? undefined) : null) ?? (publicUrl ? parse(publicUrl) : null);
}

function clipBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  return `${buf.subarray(0, max - 3).toString('utf8').replace(/�+$/, '')}…`;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: { code?: unknown } }).cause;
  const code = cause && typeof cause === 'object' && typeof cause.code === 'string' ? ` (${cause.code})` : '';
  return `${err.name}: ${err.message}${code}`;
}
