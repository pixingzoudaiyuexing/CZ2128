import { describe, expect, it, vi } from 'vitest';
import { normalizeCrispEvent } from '../src/index';
import {
  buildCrispRtmAuthentication,
  buildCrispRtmSocketTarget,
  fetchCrispRtmSocketEndpoint,
  kickCrispRtm,
  normalizeCrispRtmMessage
} from '../src/rtm/crisp-rtm';
import { io } from 'socket.io-client';

vi.mock('socket.io-client', () => ({
  io: vi.fn()
}));

describe('Crisp RTM fast path', () => {
  it('matches the current official plugin authentication payload exactly', () => {
    expect(buildCrispRtmAuthentication({
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as any)).toEqual({
      tier: 'plugin',
      username: 'identifier',
      password: 'key',
      events: ['message:send']
    });
    expect(buildCrispRtmAuthentication({
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as any)).not.toHaveProperty('rooms');
  });

  it('builds the official Socket.IO origin and path from the dynamic Crisp endpoint', () => {
    expect(buildCrispRtmSocketTarget('wss://app.relay.crisp.chat/w/f43/')).toEqual({
      origin: 'wss://app.relay.crisp.chat',
      path: '/w/f43/'
    });
    expect(() => buildCrispRtmSocketTarget('wss://example.com/w/f43/'))
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
      .resolves.toBe('wss://app.relay.crisp.chat/w/f43/');

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

  it('lets an active Socket.IO client own reconnects instead of creating a second client on alarm', async () => {
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const activeSocket = {
      connected: false,
      active: true,
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn()
    };
    vi.mocked(io).mockReturnValue(activeSocket as any);
    const state = {
      storage: { setAlarm },
      waitUntil: vi.fn()
    } as any;
    const env = {
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key',
      CRISP_WEBSITE_ID: 'website-1',
      QUEUE: { send: vi.fn() }
    } as any;
    const { CrispRtmBridge } = await import('../src/rtm/crisp-rtm');
    const bridge = new CrispRtmBridge(state, env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { socket: { app: 'wss://app.relay.crisp.chat/w/f43/' } }
    }), { status: 200 }));

    await bridge.fetch(new Request('https://crisp-rtm.internal/start', { method: 'POST' }));
    expect(io).toHaveBeenCalledTimes(1);
    activeSocket.active = true;

    await bridge.alarm();
    await bridge.alarm();

    expect(io).toHaveBeenCalledTimes(1);
    expect(activeSocket.removeAllListeners).not.toHaveBeenCalled();
    expect(activeSocket.disconnect).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalled();
  });
});
