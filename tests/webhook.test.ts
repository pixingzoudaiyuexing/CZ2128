import { describe, it, expect } from 'vitest';
import { verifyChatwootWebhook } from '../src/adapters/chatwoot/webhook';
import { verifyTelegramWebhook } from '../src/adapters/telegram/webhook';
import crypto from 'crypto';

if (!globalThis.crypto) {
  globalThis.crypto = crypto as any;
}

describe('Chatwoot Webhook Auth', () => {
  const secret = 'super-secret';
  
  async function generateSignature(payload: string, timestamp: number, signSecret: string = secret) {
    const enc = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      enc.encode(signSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await globalThis.crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(`${timestamp}.${payload}`)
    );
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    return 'sha256=' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function createRequest(body: string, signature: string | null, timestamp: string | null) {
    const headers = new Headers();
    if (signature) headers.set('X-Chatwoot-Signature', signature);
    if (timestamp) headers.set('X-Chatwoot-Timestamp', timestamp);
    return new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers,
      body
    });
  }

  it('valid real Chatwoot signature -> PASS', async () => {
    const body = JSON.stringify({ event: 'message_created' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = await generateSignature(body, ts);
    
    const req = createRequest(body, sig, String(ts));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(true);
  });

  it('wrong body -> FAIL', async () => {
    const body = JSON.stringify({ event: 'message_created' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = await generateSignature(body, ts);
    
    const req = createRequest('{"tampered":true}', sig, String(ts));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });

  it('wrong secret -> FAIL', async () => {
    const body = JSON.stringify({ event: 'message_created' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = await generateSignature(body, ts, 'wrong-secret');
    
    const req = createRequest(body, sig, String(ts));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });

  it('stale timestamp -> FAIL', async () => {
    const body = JSON.stringify({ event: 'message_created' });
    const ts = Math.floor(Date.now() / 1000) - 301;
    const sig = await generateSignature(body, ts);
    
    const req = createRequest(body, sig, String(ts));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });

  it('future timestamp outside replay window -> FAIL', async () => {
    const body = JSON.stringify({ event: 'message_created' });
    const ts = Math.floor(Date.now() / 1000) + 301;
    const sig = await generateSignature(body, ts);

    const req = createRequest(body, sig, String(ts));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });

  it('missing timestamp -> FAIL', async () => {
    const req = createRequest('{}', 'sha256=abc', null);
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });

  it('malformed signature -> FAIL', async () => {
    const req = createRequest('{}', 'sha256=xxx', String(Math.floor(Date.now() / 1000)));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });

  it('wrong-length hexadecimal signature -> FAIL', async () => {
    const req = createRequest('{}', 'sha256=aabb', String(Math.floor(Date.now() / 1000)));
    const res = await verifyChatwootWebhook(req, secret);
    expect(res.valid).toBe(false);
  });
});

describe('Telegram Webhook Auth', () => {
  const secret = 'tg-secret';
  const expectedPath = '12345';

  function createRequest(headers: Record<string, string>, pathSegment: string = '12345') {
    return new Request(`http://localhost/webhooks/telegram/${pathSegment}`, {
      method: 'POST',
      headers: new Headers(headers),
      body: JSON.stringify({ update_id: 1 })
    });
  }

  it('valid -> PASS', async () => {
    const req = createRequest({ 'X-Telegram-Bot-Api-Secret-Token': secret });
    const res = await verifyTelegramWebhook(req, expectedPath, expectedPath, secret, "-100");
    expect(res.valid).toBe(true);
  });

  it('wrong secret -> FAIL', async () => {
    const req = createRequest({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' });
    const res = await verifyTelegramWebhook(req, expectedPath, expectedPath, secret, "-100");
    expect(res.valid).toBe(false);
  });

  it('wrong path -> FAIL', async () => {
    const req = createRequest({ 'X-Telegram-Bot-Api-Secret-Token': secret }, 'wrong-path');
    const res = await verifyTelegramWebhook(req, 'wrong-path', expectedPath, secret, "-100");
    expect(res.valid).toBe(false);
  });

  it('empty Telegram secrets fail closed', async () => {
    const req = createRequest({ 'X-Telegram-Bot-Api-Secret-Token': '' }, '');
    const res = await verifyTelegramWebhook(req, '', '', '', '-100');
    expect(res.valid).toBe(false);
  });

  it('wrong group -> FAIL', async () => {
    const req = new Request('http://localhost/webhooks/telegram/12345', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: 2, message: { chat: { id: -200 } } })
    });
    const res = await verifyTelegramWebhook(req, expectedPath, expectedPath, secret, '-100');
    expect(res.valid).toBe(false);
  });

  it('message without chat -> FAIL', async () => {
    const req = new Request('http://localhost/webhooks/telegram/12345', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: 3, message: { message_id: 4 } })
    });
    const res = await verifyTelegramWebhook(req, expectedPath, expectedPath, secret, '-100');
    expect(res.valid).toBe(false);
  });

  it('non-integer update_id is not accepted as stable identity', async () => {
    const req = new Request('http://localhost/webhooks/telegram/12345', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: '3' })
    });
    const res = await verifyTelegramWebhook(req, expectedPath, expectedPath, secret, '-100');
    expect(res.valid).toBe(true);
    expect(res.updateId).toBeUndefined();
  });
});
