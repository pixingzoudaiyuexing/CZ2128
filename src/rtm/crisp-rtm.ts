import type { Env } from '../config/env';
import type { CrispMessageEvent } from '../core/events';
import { logger } from '../observability/logger';

const CRISP_CONNECT_ENDPOINTS = 'https://api.crisp.chat/v1/plugin/connect/endpoints';
const RTM_INSTANCE_NAME = 'crisp-primary';
const HEALTHY_ALARM_MS = 5 * 60 * 1000;
const CONNECTING_ALARM_MS = 10 * 1000;
const RECONNECT_ALARM_MS = 5 * 1000;
const CONNECTING_STALE_MS = 20 * 1000;

type CrispRtmFrame =
  | { type: 'ENGINE_OPEN' }
  | { type: 'PING' }
  | { type: 'SOCKET_OPEN' }
  | { type: 'EVENT'; name: string; payload?: unknown }
  | { type: 'UNKNOWN' };

type CrispConnectEndpointsResponse = {
  data?: { socket?: { app?: unknown } };
};

export function buildCrispRtmSocketUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || (url.hostname !== 'crisp.chat' && !url.hostname.endsWith('.crisp.chat'))) {
    throw new Error('CRISP_RTM_ENDPOINT_INVALID');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.searchParams.set('EIO', '4');
  url.searchParams.set('transport', 'websocket');
  return url.toString();
}

export function parseCrispRtmFrame(frame: string): CrispRtmFrame {
  if (frame === '2') return { type: 'PING' };
  if (frame.startsWith('0')) return { type: 'ENGINE_OPEN' };
  if (frame.startsWith('40')) return { type: 'SOCKET_OPEN' };
  if (!frame.startsWith('42')) return { type: 'UNKNOWN' };
  try {
    const parsed = JSON.parse(frame.slice(2));
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return { type: 'UNKNOWN' };
    return { type: 'EVENT', name: parsed[0], payload: parsed[1] };
  } catch {
    return { type: 'UNKNOWN' };
  }
}

export function normalizeCrispRtmMessage(
  data: unknown,
  expectedWebsiteId?: string
): CrispMessageEvent | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, any>;
  if (message.type !== 'text' || message.from !== 'user') return null;
  if (typeof message.website_id !== 'string' || typeof message.session_id !== 'string') return null;
  if (expectedWebsiteId && message.website_id !== expectedWebsiteId) return null;
  if (message.fingerprint === undefined || message.fingerprint === null) return null;
  if (typeof message.content !== 'string' || !message.content) return null;

  const fingerprint = String(message.fingerprint);
  const customerRef = typeof message.user?.user_id === 'string' && message.user.user_id
    ? message.user.user_id
    : `session:${message.session_id}`;
  const customerName = typeof message.user?.nickname === 'string' && message.user.nickname.trim()
    ? message.user.nickname.trim()
    : undefined;

  return {
    version: 1,
    source: 'crisp',
    type: 'message_created',
    eventId: `crisp:${message.website_id}:${message.session_id}:message:send:${fingerprint}`,
    payload: {
      websiteRef: message.website_id,
      sessionRef: message.session_id,
      customerRef,
      ...(customerName ? { customerName } : {}),
      messageRef: fingerprint,
      actorRole: 'CUSTOMER',
      content: message.content
    }
  };
}

function hasRtmConfig(env: Env): env is Env & {
  CRISP_RTM: DurableObjectNamespace;
  CRISP_API_IDENTIFIER: string;
  CRISP_API_KEY: string;
  CRISP_WEBSITE_ID: string;
} {
  return Boolean(env.CRISP_RTM && env.CRISP_API_IDENTIFIER && env.CRISP_API_KEY && env.CRISP_WEBSITE_ID);
}

export async function kickCrispRtm(env: Env): Promise<void> {
  if (!hasRtmConfig(env)) return;
  const id = env.CRISP_RTM.idFromName(RTM_INSTANCE_NAME);
  const response = await env.CRISP_RTM.get(id).fetch('https://crisp-rtm.internal/start', { method: 'POST' });
  if (!response.ok) throw new Error('CRISP_RTM_WAKE_FAILED');
}

export class CrispRtmBridge {
  private socket?: WebSocket;
  private authenticated = false;
  private connectingSince = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    await this.ensureConnected();
    return Response.json({
      ok: true,
      state: this.authenticated ? 'authenticated' : this.socket ? 'connecting' : 'idle'
    });
  }

  async alarm(): Promise<void> {
    await this.ensureConnected();
  }

  private async setAlarm(delayMs: number): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + delayMs);
  }

  private async fetchSocketEndpoint(): Promise<string> {
    if (!this.env.CRISP_API_IDENTIFIER || !this.env.CRISP_API_KEY) {
      throw new Error('CRISP_RTM_AUTH_MISSING');
    }
    const authorization = `Basic ${btoa(`${this.env.CRISP_API_IDENTIFIER}:${this.env.CRISP_API_KEY}`)}`;
    const response = await fetch(CRISP_CONNECT_ENDPOINTS, {
      headers: {
        Authorization: authorization,
        'X-Crisp-Tier': 'plugin',
        Accept: 'application/json'
      }
    });
    if (!response.ok) throw new Error('CRISP_RTM_ENDPOINT_HTTP');
    const payload = await response.json() as CrispConnectEndpointsResponse;
    const endpoint = payload.data?.socket?.app;
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('CRISP_RTM_ENDPOINT_MISSING');
    return buildCrispRtmSocketUrl(endpoint);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.env.CRISP_WEBSITE_ID || !this.env.CRISP_API_IDENTIFIER || !this.env.CRISP_API_KEY) return;

    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      await this.setAlarm(HEALTHY_ALARM_MS);
      return;
    }
    if (
      this.socket?.readyState === WebSocket.CONNECTING &&
      this.connectingSince > 0 &&
      Date.now() - this.connectingSince < CONNECTING_STALE_MS
    ) {
      await this.setAlarm(CONNECTING_ALARM_MS);
      return;
    }

    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      try {
        this.socket.close(4000, 'reconnect');
      } catch {
        // Best-effort close before reconnecting.
      }
    }
    this.socket = undefined;
    this.authenticated = false;

    try {
      const socketUrl = await this.fetchSocketEndpoint();
      const socket = new WebSocket(socketUrl);
      this.socket = socket;
      this.connectingSince = Date.now();

      socket.addEventListener('message', event => {
        if (this.socket !== socket || typeof event.data !== 'string') return;
        this.state.waitUntil(this.handleSocketMessage(socket, event.data));
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.authenticated = false;
        }
        logger.warn('Crisp RTM disconnected', { source: 'crisp', stage: 'RTM' });
        this.state.waitUntil(this.setAlarm(RECONNECT_ALARM_MS));
      });
      socket.addEventListener('error', () => {
        logger.warn('Crisp RTM socket error', { source: 'crisp', stage: 'RTM' });
      });

      await this.setAlarm(CONNECTING_ALARM_MS);
    } catch {
      this.socket = undefined;
      this.authenticated = false;
      logger.warn('Crisp RTM connection setup failed', { source: 'crisp', stage: 'RTM' });
      await this.setAlarm(RECONNECT_ALARM_MS);
    }
  }

  private async handleSocketMessage(socket: WebSocket, raw: string): Promise<void> {
    const frame = parseCrispRtmFrame(raw);
    if (frame.type === 'PING') {
      socket.send('3');
      return;
    }
    if (frame.type === 'ENGINE_OPEN') {
      socket.send('40');
      return;
    }
    if (frame.type === 'SOCKET_OPEN') {
      if (!this.env.CRISP_API_IDENTIFIER || !this.env.CRISP_API_KEY || !this.env.CRISP_WEBSITE_ID) return;
      socket.send(`42${JSON.stringify([
        'authentication',
        {
          tier: 'plugin',
          username: this.env.CRISP_API_IDENTIFIER,
          password: this.env.CRISP_API_KEY,
          events: ['message:send'],
          rooms: [this.env.CRISP_WEBSITE_ID]
        }
      ])}`);
      return;
    }
    if (frame.type !== 'EVENT') return;

    if (frame.name === 'authenticated') {
      this.authenticated = true;
      this.connectingSince = 0;
      logger.info('Crisp RTM authenticated', { source: 'crisp', stage: 'RTM', result: 'SUCCESS' });
      await this.setAlarm(HEALTHY_ALARM_MS);
      return;
    }
    if (frame.name === 'unauthorized') {
      this.authenticated = false;
      logger.warn('Crisp RTM authentication rejected', { source: 'crisp', stage: 'RTM' });
      try {
        socket.close(4003, 'unauthorized');
      } catch {
        // Close best effort; webhook remains the fallback.
      }
      await this.setAlarm(HEALTHY_ALARM_MS);
      return;
    }
    if (frame.name !== 'message:send') return;

    const event = normalizeCrispRtmMessage(frame.payload, this.env.CRISP_WEBSITE_ID);
    if (!event) return;
    await this.env.QUEUE.send(event);
    logger.info('Crisp RTM customer event enqueued', {
      source: 'crisp',
      stage: 'RTM',
      result: 'SUCCESS'
    });
  }
}
