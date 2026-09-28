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

  it('formats a plain Telegram visitor card without exposing precise coordinates', () => {
    expect(formatCrispVisitorContext({
      ip: '203.0.113.9',
      country: 'US',
      region: 'CA',
      city: 'Los Angeles'
    })).toBe([
      '🌍 Crisp 访客位置',
      'IP：203.0.113.9',
      '地区（IP 解析）：US · CA · Los Angeles'
    ].join('\n'));
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
