// SPDX-License-Identifier: MIT
// Inbox authentication.
//
// The founder's phone pairs once: `autopilot pair` prints a link carrying a
// single-use code; the inbox exchanges it for a 30-day HttpOnly session cookie
// plus a per-session CSRF token. Only SHA-256 hashes of codes and session
// tokens are stored. The agent bridge uses per-run bearer tokens instead and is
// reachable from loopback only.

import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Store } from '../store.ts';
import { randomToken, sha256Hex } from '../util.ts';

export const SESSION_COOKIE = 'ap_session';
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A valid inbox session, as found from the request cookie. */
export interface InboxSession {
  tokenHash: string;
  csrf: string;
}

/** Secrets handed to a newly paired device (token goes into the cookie only). */
export interface PairedSession {
  token: string;
  csrf: string;
}

/** Create a single-use pairing code; only its hash is stored. */
export function createPairingCode(store: Store, ttlMs: number = PAIRING_TTL_MS): string {
  const code = randomToken(24);
  store.addPairingCode(sha256Hex(code), store.now() + ttlMs);
  return code;
}

/**
 * Exchange a pairing code for a new inbox session. Returns null when the code
 * is unknown, already used or expired (consumption is atomic in the store).
 */
export function exchangePairingCode(store: Store, code: string, userAgent: string | null | undefined): PairedSession | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (trimmed.length < 8 || trimmed.length > 256) return null;
  if (!store.consumePairingCode(sha256Hex(trimmed))) return null;
  const token = randomToken(32);
  const csrf = randomToken(16);
  store.createInboxSession(sha256Hex(token), csrf, userAgent ?? null, SESSION_TTL_MS);
  return { token, csrf };
}

/** Parse a Cookie header; the first occurrence of a name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value; our own tokens are base64url and never encoded
    }
    out.set(name, value);
  }
  return out;
}

/** The inbox session carried by the request's ap_session cookie, if valid and unexpired. */
export function sessionFromRequest(store: Store, req: IncomingMessage): InboxSession | null {
  const token = parseCookies(headerValue(req.headers.cookie)).get(SESSION_COOKIE);
  if (!token || token.length > 256) return null;
  const tokenHash = sha256Hex(token);
  const session = store.getInboxSession(tokenHash);
  return session ? { tokenHash, csrf: session.csrf } : null;
}

/** True when the browser reached us over https (directly or via a proxy such as Tailscale Serve). */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = headerValue(req.headers['x-forwarded-proto']);
  if (proto && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Constant-time comparison of the X-CSRF-Token header with the session's token. */
export function csrfMatches(session: InboxSession, provided: string | string[] | undefined): boolean {
  const value = headerValue(provided);
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(session.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cross-site request check for state-changing requests: when an Origin header
 * is present, its host must equal the Host header. Behind a reverse proxy that
 * rewrites Host, X-Forwarded-Host is accepted too (a cross-site page cannot set
 * that header without a CORS preflight, which this server never approves).
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === undefined) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (!originHost) return false;
  const host = headerValue(req.headers.host)?.trim().toLowerCase();
  if (host && originHost === host) return true;
  const forwardedHost = headerValue(req.headers['x-forwarded-host'])?.split(',')[0].trim().toLowerCase();
  return !!forwardedHost && originHost === forwardedHost;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'tailscale-user-login'];

/**
 * Whether a request came through a reverse proxy. A proxy on this machine
 * (e.g. Tailscale Serve) connects from loopback too, so the agent bridge also
 * refuses proxied requests: agents always call it directly.
 */
export function hasProxyHeaders(req: Pick<IncomingMessage, 'headers'>): boolean {
  return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

/** Whether a request may use the agent bridge: a direct loopback connection, not one relayed by a proxy. */
export function agentRequestAllowed(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress) && !hasProxyHeaders(req);
}

/** Token from "Authorization: Bearer <token>", or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S{8,1024})[ \t]*$/i.exec(header);
  return m ? m[1] : null;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
