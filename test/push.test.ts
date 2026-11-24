// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import http from 'node:http';
import { encryptPushPayload, generateVapidKeys, sendWebPush, vapidAuthorization, WebPushNotifier } from '../src/push.ts';
import { Store } from '../src/store.ts';

const u = (s: string) => Buffer.from(s, 'base64url');

test('aes128gcm encryption matches the RFC 8291 test vector', () => {
  const body = encryptPushPayload(
    {
      endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
      keys: {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
    },
    Buffer.from('When I grow up, I want to be a watermelon'),
    { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), serverPrivateKey: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('a browser holding the subscription keys can decrypt the message', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const msg = JSON.stringify({ title: 'My App: a decision needs you', body: 'Open the inbox', url: '/' });
  const body = encryptPushPayload({ endpoint: 'https://x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, Buffer.from(msg));
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const ct = body.subarray(21 + body[20]);
  const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const ikm = h(h(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
  assert.equal(pt.subarray(0, -1).toString(), msg);
});

test('VAPID JWT is ES256-signed for the push service origin', () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization('https://web.push.apple.com/abc', keys, 'mailto:me@example.com', 1_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(m);
  const payload = JSON.parse(u(m[2]).toString());
  assert.equal(payload.aud, 'https://web.push.apple.com');
  assert.equal(payload.exp, 1_000_000 + 12 * 3600);
  const pub = u(m[4]);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, u(m[3])));
});

test('the notifier posts to subscriptions and prunes expired ones', async () => {
  const hits: { url: string; headers: http.IncomingHttpHeaders; len: number }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url!, headers: req.headers, len: Buffer.concat(chunks).length });
      res.writeHead(req.url === '/gone' ? 410 : 201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  // Push services are https-only; route the test's https URLs to the local http stub.
  const fetchImpl: typeof fetch = (input, init) => fetch(String(input).replace(/^https:\/\/push\.test/, `http://127.0.0.1:${port}`), init);
  const store = Store.open(':memory:');
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
  store.addPushSubscription({ endpoint: 'https://push.test/ok', keys }, 'iPhone');
  store.addPushSubscription({ endpoint: 'https://push.test/gone', keys }, 'old');
  await new WebPushNotifier(store, { fetchImpl }).notify({ title: 'Demo: a decision needs you', body: 'Open the inbox', priority: 'high' });
  server.close();
  assert.equal(hits.length, 2);
  const ok = hits.find((h) => h.url === '/ok')!;
  assert.equal(ok.headers['content-encoding'], 'aes128gcm');
  assert.equal(ok.headers.urgency, 'high');
  assert.match(String(ok.headers.authorization), /^vapid t=.+, k=.+/);
  assert.deepEqual(store.listPushSubscriptions().map((s) => s.endpoint), ['https://push.test/ok']);
  assert.equal(await sendWebPush({ endpoint: 'http://insecure.example', keys }, { title: 't', body: 'b' }, generateVapidKeys()), 'failed');
});
