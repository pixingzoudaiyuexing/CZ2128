import { describe, expect, it, vi } from 'vitest';
import { normalizeCrispEvent } from '../src/index';
import {
  buildCrispRtmSocketUrl,
  fetchCrispRtmSocketEndpoint,
  kickCrispRtm,
  normalizeCrispRtmMessage,
  parseCrispRtmFrame
} from '../src/rtm/crisp-rtm';

describe('Crisp RTM fast path', () => {
  it('builds the Engine.IO v4 websocket URL from the dynamic Crisp endpoint', () => {
    expect(buildCrispRtmSocketUrl('wss://app.relay.crisp.chat/w/f43/'))
      .toBe('wss://app.relay.crisp.chat/w/f43/?EIO=4&transport=websocket');
    expect(() => buildCrispRtmSocketUrl('wss://example.com/w/f43/'))
      .toThrow('CRISP_RTM_ENDPOINT_INVALID');
  });

  it('fetches the dynamic endpoint with bounded fixed-origin plugin auth and no redirect following', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { socket: { app: 'wss://app.relay.crisp.chat/w/f43/' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const env = {
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as any;

    await expect(fetchCrispRtmSocketEndpoint(env))
      .resolves.toBe('wss://app.relay.crisp.chat/w/f43/?EIO=4&transport=websocket');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.crisp.chat/v1/plugin/connect/endpoints',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          'X-Crisp-Tier': 'plugin',
          Accept: 'application/json'
        })
      })
    );
  });

  it('rejects endpoint redirects and oversized responses without following them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/redirect' }
    }));
    await expect(fetchCrispRtmSocketEndpoint({
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as any)).rejects.toThrow('CRISP_RTM_ENDPOINT_REDIRECT');

    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));
    await expect(fetchCrispRtmSocketEndpoint({
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as any)).rejects.toThrow('CRISP_RTM_ENDPOINT_TOO_LARGE');
  });

  it('parses the minimum Engine.IO and Socket.IO frames used by Crisp', () => {
    expect(parseCrispRtmFrame('0{"sid":"abc"}')).toEqual({ type: 'ENGINE_OPEN' });
    expect(parseCrispRtmFrame('2')).toEqual({ type: 'PING' });
    expect(parseCrispRtmFrame('40{"sid":"socket"}')).toEqual({ type: 'SOCKET_OPEN' });
    expect(parseCrispRtmFrame('42["authenticated"]')).toEqual({
      type: 'EVENT',
      name: 'authenticated',
      payload: undefined
    });
    expect(parseCrispRtmFrame('42["message:send",{"type":"text"}]')).toEqual({
      type: 'EVENT',
      name: 'message:send',
      payload: { type: 'text' }
    });
  });

  it('normalizes visitor text to the exact same event identity as the webhook path', () => {
    const data = {
      website_id: 'website-1',
      session_id: 'session-1',
      type: 'text',
      content: 'Fast hello',
      fingerprint: 179069107573139,
      from: 'user',
      user: { nickname: 'Visitor', user_id: 'visitor-1' }
    };
    const eventId = 'crisp:website-1:session-1:message:send:179069107573139';
    const rtm = normalizeCrispRtmMessage(data, 'website-1');
    const webhook = normalizeCrispEvent(
      { event: 'message:send', data } as any,
      eventId,
      'website-1'
    );

    expect(rtm).toEqual(webhook);
    expect(rtm?.eventId).toBe(eventId);
  });

  it('fails closed to the webhook fallback for unsupported or ambiguous RTM messages', () => {
    expect(normalizeCrispRtmMessage({
      website_id: 'website-1',
      session_id: 'session-1',
      type: 'file',
      fingerprint: 1,
      from: 'user',
      content: 'https://example.com/file'
    }, 'website-1')).toBeNull();
    expect(normalizeCrispRtmMessage({
      website_id: 'website-2',
      session_id: 'session-1',
      type: 'text',
      fingerprint: 1,
      from: 'user',
      content: 'wrong room'
    }, 'website-1')).toBeNull();
    expect(normalizeCrispRtmMessage({
      website_id: 'website-1',
      session_id: 'session-1',
      type: 'text',
      from: 'user',
      content: 'missing fingerprint'
    }, 'website-1')).toBeNull();
  });

  it('wakes exactly one named Durable Object instance when the Staging binding exists', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok'));
    const get = vi.fn().mockReturnValue({ fetch });
    const idFromName = vi.fn().mockReturnValue('rtm-id');
    const env = {
      CRISP_RTM: { idFromName, get },
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key',
      CRISP_WEBSITE_ID: 'website-1'
    } as any;

    await kickCrispRtm(env);

    expect(idFromName).toHaveBeenCalledWith('crisp-primary');
    expect(get).toHaveBeenCalledWith('rtm-id');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
