import { describe, it, expect, vi } from 'vitest';
import { verifyChatwootWebhook } from '../src/adapters/chatwoot/webhook';
import { verifyTelegramWebhook } from '../src/adapters/telegram/webhook';

describe('Webhook Verification', () => {
  it('should verify Chatwoot webhook successfully', async () => {
    const secret = 'test_secret';
    const payload = JSON.stringify({ event: 'message_created', id: 123 });
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Create HMAC signature manually
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const signatureHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'X-Chatwoot-Signature': signatureHex,
        'X-Chatwoot-Timestamp': timestamp,
        'X-Chatwoot-Delivery': 'delivery-123'
      },
      body: payload
    });

    const result = await verifyChatwootWebhook(req, secret);
    expect(result.valid).toBe(true);
    expect(result.deliveryId).toBe('delivery-123');
    expect(result.payload.id).toBe(123);
  });

  it('should reject Chatwoot webhook with invalid signature', async () => {
    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'X-Chatwoot-Signature': 'invalid',
        'X-Chatwoot-Timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      body: JSON.stringify({ event: 'message_created', id: 123 })
    });

    const result = await verifyChatwootWebhook(req, 'test_secret');
    expect(result.valid).toBe(false);
  });

  it('should verify Telegram webhook successfully', async () => {
    const payload = JSON.stringify({
      update_id: 12345,
      message: {
        message_id: 1,
        chat: { id: -100123456789 },
        from: { is_bot: false },
        text: 'hello'
      }
    });

    const req = new Request('http://localhost/webhooks/telegram/secret-path', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': 'test_token',
      },
      body: payload
    });

    const result = await verifyTelegramWebhook(req, 'test_token', 'secret-path', '-100123456789');
    expect(result.valid).toBe(true);
    expect(result.updateId).toBe('12345');
  });

  it('should reject Telegram webhook with invalid path', async () => {
    const req = new Request('http://localhost/webhooks/telegram/wrong-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test_token' },
      body: JSON.stringify({})
    });

    const result = await verifyTelegramWebhook(req, 'test_token', 'secret-path', '-100123456789');
    expect(result.valid).toBe(false);
  });
});
