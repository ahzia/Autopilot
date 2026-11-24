// SPDX-License-Identifier: MIT
// Web Push for the inbox PWA, with no dependencies: VAPID (RFC 8292) and
// aes128gcm message encryption (RFC 8291) using node:crypto.
// iOS delivers these to a Home Screen web app (iOS 16.4+, HTTPS origin).

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import type { Store } from './store.ts';
import type { DecisionPriority, Notifier } from './types.ts';

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** Raw 32-byte private scalar, base64url. */
  privateKey: string;
}

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** VAPID keys persist in the store so existing phone subscriptions stay valid across restarts. */
export function loadOrCreateVapidKeys(store: Store): VapidKeys {
  const raw = store.getKv('vapid_keys');
  if (raw) {
    try {
      const k = JSON.parse(raw) as VapidKeys;
      if (k.publicKey && k.privateKey) return k;
    } catch {
      /* regenerate below */
    }
  }
  const keys = generateVapidKeys();
  store.setKv('vapid_keys', JSON.stringify(keys));
  return keys;
}

function privateKeyObject(keys: VapidKeys) {
  const pub = unb64u(keys.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(signature)}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/**
 * Encrypt one push message (single record, RFC 8291 §3-4). `salt` and
 * `serverKeys` are injectable for the RFC test vector; normally random.
 */
export function encryptPushPayload(
  sub: PushSubscriptionJSON,
  plaintext: Buffer,
  opts: { salt?: Buffer; serverPrivateKey?: Buffer; recordSize?: number } = {},
): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('invalid push subscription keys');
  const ecdh = createECDH('prime256v1');
  if (opts.serverPrivateKey) ecdh.setPrivateKey(opts.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 17 > rs) throw new Error('push payload too large for one record');

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Send one push. Returns 'gone' when the subscription expired (404/410) and should be removed. */
export async function sendWebPush(
  sub: PushSubscriptionJSON,
  msg: PushMessage,
  keys: VapidKeys,
  opts: { subject?: string; urgency?: 'very-low' | 'low' | 'normal' | 'high'; ttlSeconds?: number; fetchImpl?: typeof fetch } = {},
): Promise<'ok' | 'gone' | 'failed'> {
  const url = new URL(sub.endpoint);
  if (url.protocol !== 'https:') return 'failed';
  const body = encryptPushPayload(sub, Buffer.from(JSON.stringify(msg)));
  const res = await (opts.fetchImpl ?? fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(sub.endpoint, keys, opts.subject ?? 'mailto:autopilot@localhost'),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlSeconds ?? 24 * 3600),
      Urgency: opts.urgency ?? 'normal',
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return 'failed';
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'failed';
}

/** Notifies every subscribed phone/browser; prunes expired subscriptions. */
export class WebPushNotifier implements Notifier {
  private readonly store: Store;
  private readonly fetchImpl?: typeof fetch;
  constructor(store: Store, opts: { fetchImpl?: typeof fetch } = {}) {
    this.store = store;
    this.fetchImpl = opts.fetchImpl;
  }

  async notify(n: { title: string; body: string; url?: string; priority?: DecisionPriority }): Promise<void> {
    const subs = this.store.listPushSubscriptions();
    if (!subs.length) return;
    const keys = loadOrCreateVapidKeys(this.store);
    const urgency = n.priority === 'urgent' || n.priority === 'high' ? 'high' : 'normal';
    await Promise.all(
      subs.map(async (s) => {
        const out = await sendWebPush(s, { title: n.title, body: n.body, url: n.url ?? '/', tag: 'autopilot-decisions' }, keys, { urgency, fetchImpl: this.fetchImpl });
        if (out === 'gone') this.store.removePushSubscription(s.endpoint);
        else this.store.markPushResult(s.endpoint, out === 'ok');
      }),
    );
  }
}

/** Fan out to several notifiers; one failing never blocks the others. */
export class MultiNotifier implements Notifier {
  private readonly targets: Notifier[];
  constructor(targets: Notifier[]) {
    this.targets = targets;
  }
  async notify(n: { title: string; body: string; url?: string; priority?: DecisionPriority }): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.notify(n)));
  }
}
