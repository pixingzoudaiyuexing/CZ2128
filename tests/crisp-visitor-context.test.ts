import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CrispVisitorContextError,
  fetchCrispVisitorContext,
  formatCrispVisitorContext
} from '../src/adapters/crisp/visitor-context';

const env = {
  CRISP_API_IDENTIFIER: 'identifier',
  CRISP_API_KEY: 'api-key'
} as any;

function metaResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ error: false, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init
  });
}

describe('Crisp visitor context adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('GETs the Crisp conversation meta endpoint with plugin auth and manual redirect handling', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaResponse({
      ip: '203.0.113.9',
      geolocation: { country: 'US', region: 'CA', city: 'Los Angeles' }
    }));

    await expect(fetchCrispVisitorContext(env, 'site id', 'session/id')).resolves.toEqual({
      ip: '203.0.113.9',
      country: 'US',
      region: 'CA',
      city: 'Los Angeles'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.crisp.chat/v1/website/site%20id/conversation/session%2Fid/meta'
    );
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    expect(new Headers(init?.headers).get('X-Crisp-Tier')).toBe('plugin');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Basic ${btoa('identifier:api-key')}`
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('only returns bounded IP and coarse location fields, not coordinates or connection metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaResponse({
      ip: '2001:db8::1',
      connection: { isp: 'Example ISP', asn: 'AS64500' },
      geolocation: {
        country: 'US',
        region: 'CA',
        city: 'San Francisco',
        coordinates: { latitude: 37.7, longitude: -122.4 }
      }
    }));

    const result = await fetchCrispVisitorContext(env, 'site', 'session');
    expect(result).toEqual({
      ip: '2001:db8::1',
      country: 'US',
      region: 'CA',
      city: 'San Francisco'
    });
    expect(result).not.toHaveProperty('coordinates');
    expect(result).not.toHaveProperty('connection');
  });

  it('filters malformed IP and control-character location fields independently', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaResponse({
      ip: 'not-an-ip',
      geolocation: {
        country: 'US',
        region: 'CA\nInjected',
        city: 'Los Angeles'
      }
    }));

    await expect(fetchCrispVisitorContext(env, 'site', 'session')).resolves.toEqual({
      country: 'US',
      city: 'Los Angeles'
    });
  });

  it('formats the unified Telegram profile card without exposing precise coordinates', () => {
    expect(formatCrispVisitorContext({
      nickname: 'John',
      email: 'john@example.com',
      customData: [{ key: 'plan', value: 'VIP' }],
      ip: '203.0.113.9',
      country: 'US',
      region: 'CA',
      city: 'Los Angeles'
    })).toBe([
      '👤 客户资料',
      '昵称：John',
      '邮箱：john@example.com',
      '',
      '📋 访客资料',
      'plan：VIP',
      '',
      '🌍 访客位置',
      'IP：203.0.113.9',
      '地区：US · CA · Los Angeles'
    ].join('\n'));
  });

  it('extracts bounded customer fields and deterministic custom data while excluding sensitive metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaResponse({
      nickname: 'John',
      email: 'john@example.com',
      phone: '+1 555 0100',
      address: { street: 'Main St', city: 'Los Angeles', secret: 'never-address-secret' },
      subject: 'Billing',
      segments: ['vip', 'english'],
      ip: '203.0.113.9',
      connection: { isp: 'Secret ISP', asn: 'AS64500' },
      geolocation: {
        country: 'US',
        region: 'CA',
        city: 'Los Angeles',
        coordinates: { latitude: 34, longitude: -118 }
      },
      data: {
        source: 'website',
        order_id: 123456,
        plan: 'VIP',
        nested: { product: 'Pro' },
        coordinates: 'never',
        api_key: 'never',
        bad: 'line\nbreak'
      }
    }));

    const result = await fetchCrispVisitorContext(env, 'site', 'session');
    expect(result).toMatchObject({
      nickname: 'John',
      email: 'john@example.com',
      phone: '+1 555 0100',
      address: 'Los Angeles · Main St',
      subject: 'Billing',
      segments: ['vip', 'english'],
      ip: '203.0.113.9',
      country: 'US',
      region: 'CA',
      city: 'Los Angeles',
      customData: [
        { key: 'nested.product', value: 'Pro' },
        { key: 'order_id', value: '123456' },
        { key: 'plan', value: 'VIP' },
        { key: 'source', value: 'website' }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('Secret ISP');
    expect(JSON.stringify(result)).not.toContain('AS64500');
    expect(JSON.stringify(result)).not.toContain('coordinates');
    expect(JSON.stringify(result)).not.toContain('api_key');
    expect(JSON.stringify(result)).not.toContain('line\\nbreak');
    expect(JSON.stringify(result)).not.toContain('never-address-secret');
  });

  it('bounds custom data field count, values, nesting and final Telegram card length', async () => {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      data[`field_${String(index).padStart(2, '0')}`] = 'x'.repeat(500);
    }
    data.deep = { one: { two: 'not-rendered' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaResponse({ data }));

    const result = await fetchCrispVisitorContext(env, 'site', 'session');
    expect(result.customData).toHaveLength(20);
    expect(result.customDataTruncated).toBe(true);
    expect(result.customData?.every(item => item.value.length <= 256)).toBe(true);
    expect(JSON.stringify(result.customData)).not.toContain('not-rendered');
    const card = formatCrispVisitorContext(result);
    expect(card).not.toBeNull();
    expect(Array.from(card!).length).toBeLessThanOrEqual(3500);
    expect(card).toContain('…还有更多资料未显示');
  });

  it('returns null when Crisp has no usable IP or location fields', () => {
    expect(formatCrispVisitorContext({})).toBeNull();
  });

  it('rejects redirects so Crisp Basic auth cannot be forwarded to another origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/steal' }
      })
    );

    await expect(fetchCrispVisitorContext(env, 'site', 'session'))
      .rejects.toMatchObject({ name: 'CrispVisitorContextError', reason: 'REDIRECT' });
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('classifies provider HTTP failure without including its private body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private customer metadata', { status: 503 })
    );
    const error = await fetchCrispVisitorContext(env, 'site', 'session').catch(value => value);
    expect(error).toBeInstanceOf(CrispVisitorContextError);
    expect(error).toMatchObject({ reason: 'HTTP', httpStatus: 503 });
    expect(String(error)).not.toContain('private customer metadata');
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response('{broken', { status: 200 }));
    await expect(fetchCrispVisitorContext(env, 'site', 'session'))
      .rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });

    fetchMock.mockResolvedValueOnce(new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String(64 * 1024 + 1) }
    }));
    await expect(fetchCrispVisitorContext(env, 'site', 'session'))
      .rejects.toMatchObject({ reason: 'TOO_LARGE' });
  });

  it('does not make a request when Crisp credentials are missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(fetchCrispVisitorContext({
      CRISP_API_IDENTIFIER: '',
      CRISP_API_KEY: ''
    } as any, 'site', 'session')).rejects.toMatchObject({ reason: 'AUTH_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a hung meta request after five seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const promise = fetchCrispVisitorContext(env, 'site', 'session');
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});